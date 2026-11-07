// 守卫切面：堵住用 bash 停二狗、杀服务管家的路（419；调研 .scratch/ergo-v2/research/2026-11-07-secretary-lsm.md 第一节"bash 绕路"表、第三节 C 层）。
// - 服务管家的数据目录进受保护区域：注册表、运行状态写入永不，.secrets/ 是密钥区（连读都拒绝）；
// - 发往管理器端口的不是查询的请求、跑服务管家的命令行（lsm、packages/supervisor/bin 里的脚本）、ergo 的停止、重启、升级、回退、卸载和 svc：
//   一律硬拒绝，说明里叫秘书用服务管家工具；查询（GET）照旧；
// - 杀进程（taskkill、tskill、kill、pkill、killall、Stop-Process、wmic process）拆成"杀进程"：杀到二狗自己、服务管家、命脉服务的永不，
//   看不准的（受保护的进程没取全、变量、管道传来的、不带 /T 杀它们的上级进程）接近底线先问，别的先问；
// - 拆不开的命令里写着杀进程、管理器端口、服务管家的命令行、ergo 的停止重启升级、它的计划任务的：接近底线先问（对话审批关着也问）。
// 只做判定：不真杀进程、不连端口、不跑命令。路径、端口、进程号都是编的。
import { describe, expect, it } from "vitest";
import {
  type GuardAgent,
  type GuardInput,
  type GuardJudgement,
  judgementExecutes,
  judgeToolCall,
  type ProcessFacts,
  type ToolCall,
} from "../../src/guard/index.ts";
import { bash, call, dispositionFinding, inChat, inTask, maintainer, P, secretary, v1Satisfied } from "./helpers/guard-input.ts";

/** 编的服务管家：数据目录、管理器端口（不是真的 7420） */
const PORT = 47420;
const SVC = { dataDir: "C:\\Users\\tester\\AppData\\Local\\ergo\\supervisor", ports: [PORT] };
const sh = (p: string) => p.replaceAll("\\", "/");
const LSM = `${sh(P.programDir)}/packages/supervisor/bin/lsm.mjs`;

/** 受保护的进程：守护进程 4242、服务管家 4343（父进程是 conhost 4000）、公网隧道 4444 */
const PROCS: ProcessFacts = {
  protected: [
    { pid: 4242, exe: "node.exe", role: "daemon" },
    { pid: 4343, exe: "node.exe", role: "manager" },
    { pid: 4444, exe: "ssh.exe", role: "service", service: "ergo-tunnel" },
  ],
  complete: true,
  ancestors: [{ pid: 4000, exe: "conhost.exe", of: 4343 }],
};

const online = (agent: GuardAgent): GuardAgent => ({ ...agent, toolkit: { ...agent.toolkit, bash: true, network: true } });
const SECRETARY = online(secretary());
const MAINTAINER = maintainer();
const AGENTS = [SECRETARY, MAINTAINER];

/** 对话审批关着（默认）、给了服务管家和受保护的进程的一次判定（负责人在任务里，v1 模板的前提都满足） */
function judge(agent: GuardAgent, toolCall: ToolCall, extra: Partial<GuardInput> = {}, approvals: "on" | "off" = "off"): GuardJudgement {
  const base = agent.kind === "secretary" ? inChat(agent, toolCall) : inTask(agent, toolCall, v1Satisfied());
  return judgeToolCall({
    ...base,
    places: { ...base.places, supervisor: SVC },
    facts: { ...base.facts, processes: PROCS },
    conversationApprovals: approvals,
    ...extra,
  });
}

/**
 * 判出来是什么：refused（硬拒绝，碰服务管家）、secrets_area（读密钥区）、never（永不）、keeps_asking（接近底线先问，对话审批关着也问）、
 * ask（先问）、runs（放行）
 */
function verdict(j: GuardJudgement): string {
  if (j.hardRefusal?.includes("supervisor")) return "refused";
  if (j.hardRefusal) return j.hardRefusal.join(",");
  if (j.disposition === "never") return "never";
  if (j.disposition === "ask_first") {
    const near = j.findings.some((f) => f.kind !== "hard_refusal" && f.kind !== "pull_back" && f.nearBottomLine === true && f.disposition === "ask_first");
    return near ? "keeps_asking" : "ask";
  }
  return judgementExecutes(j) ? "runs" : j.disposition;
}

/** 每个 agent 判一遍 */
const verdicts = (toolCall: ToolCall, extra: Partial<GuardInput> = {}, approvals: "on" | "off" = "off") => AGENTS.map((agent) => verdict(judge(agent, toolCall, extra, approvals)));

describe("调研表里的每种绕法：改完被拒或先问（秘书、项目负责人，对话审批关着）", () => {
  // [写法, 命令, 改前（调研表）, 改后]
  const TABLE: [string, ToolCall, string, string][] = [
    ["跑服务管家的命令行", bash(`node ${LSM} stop ergo-daemon`), "放行", "refused"],
    ["往服务管家端口发 POST", bash(`curl -X POST 127.0.0.1:${PORT}/api/action -d '{"action":"stop","id":"ergo-daemon"}'`), "放行", "refused"],
    ["kill 服务管家的进程号", bash("kill 4343"), "放行", "never"],
    ["powershell -Command 按名字杀 node", bash('powershell -Command "Stop-Process -Name node"'), "放行", "keeps_asking"],
    ["cmd /c taskkill", bash("cmd /c taskkill /PID 4343 /F"), "放行", "keeps_asking"],
    ["taskkill /PID 守护进程 /F", bash("taskkill /PID 4242 /F"), "碰巧会问", "never"],
    ["改服务管家注册表的 yaml", bash(`echo "x" > ${sh(SVC.dataDir)}/registry/services/ergo-daemon.yaml`), "先问", "never"],
    ["读服务管家的网页口令文件", bash(`cat ${sh(SVC.dataDir)}/.secrets/webui-password.txt`), "能读", "secrets_area"],
    ["schtasks /Delete 服务管家的计划任务", bash("schtasks /Delete /TN LocalServiceManager /F"), "先问", "keeps_asking"],
  ];
  for (const [name, toolCall, before, after] of TABLE) {
    it(`${name}（改前：${before}，改后：${after}）`, () => {
      expect(verdicts(toolCall)).toEqual([after, after]);
    });
  }

  it("拒绝的说明叫秘书改用服务管家工具", () => {
    for (const command of [`node ${LSM} stop ergo-daemon`, `curl -X POST http://127.0.0.1:${PORT}/api/action`, "kill 4343", "cmd /c taskkill /PID 4343 /F"]) {
      expect(judge(SECRETARY, bash(command)).explanation).toContain("服务管家工具");
    }
  });
});

describe("服务管家的命令行和 ergo 的运维命令：一律硬拒绝", () => {
  const CASES = [
    `"C:/Program Files/nodejs/node.exe" ${LSM} restart ergo-daemon`,
    `NODE '${P.programDir.toUpperCase()}\\PACKAGES\\SUPERVISOR\\BIN\\LSM.MJS' stop ergo-daemon`,
    `NODE.EXE ${sh(P.programDir).toUpperCase()}/PACKAGES/SUPERVISOR/BIN/LSM.MJS stop ergo-daemon`,
    `cd ${sh(P.programDir)} && node packages/supervisor/bin/lsm.mjs stop ergo-daemon`,
    "node /d/ergo-app/packages/supervisor/bin/lsm.mjs status",
    `${LSM} stop ergo-daemon`,
    `node ${sh(P.programDir)}/packages/supervisor/bin/tailnet-gateway.mjs`,
    `node ${sh(P.programDir)}/packages/supervisor/bin/other-tool.mjs`,
    "node E:/old-lsm/bin/lsm.mjs stop ergo-daemon --data-dir E:/old-lsm",
    "lsm stop ergo-daemon",
    "lsm.cmd status",
    "npx lsm stop ergo-daemon",
    "ergo stop",
    "ergo.cmd restart",
    "C:/Users/tester/AppData/Local/ergo/bin/ergo.exe update",
    "ergo svc stop ergo-daemon",
    "ergo rollback",
    "ergo uninstall --yes",
    'ergo "$CMD"',
    "npm run ergo -- stop",
    `cd ${sh(P.programDir)} && node packages/daemon/src/cli/main.ts restart`,
    `node ${sh(P.programDir)}/packages/daemon/src/stop.ts`,
    `timeout 30 node ${LSM} stop ergo-daemon`,
  ];
  for (const command of CASES) {
    it(`${command}`, () => {
      expect(verdicts(bash(command))).toEqual(["refused", "refused"]);
    });
  }

  it("ergo 的别的子命令照旧（看状态、看日志、开网页）", () => {
    for (const command of ["ergo status", "ergo logs -n 50", "ergo open --print", "npm run ergo -- status"]) {
      expect({ command, verdict: verdict(judge(SECRETARY, bash(command))) }).toEqual({ command, verdict: "runs" });
    }
  });
});

describe("服务管家的端口：不是查询的请求硬拒绝，查询照旧", () => {
  const port = PORT;
  const NON_QUERY = [
    `curl -X POST http://localhost:${port}/api/action`,
    `curl -XPOST http://127.0.0.1:${port}/api/action`,
    `curl --data '{"action":"profile-stop","id":"ergo"}' http://127.0.0.1:${port}/api/action`,
    `curl -X DELETE http://[::1]:${port}/api/services/x`,
    `curl -X POST http://example.com/ok http://127.0.0.1:${port}/api/action`,
    `wget --post-data='{"action":"stop"}' http://127.0.0.1:${port}/api/action`,
    `Invoke-WebRequest -Uri http://127.0.0.1:${port}/api/action -Method Post -Body x`,
    `irm http://127.0.0.1:${port}/api/action -Method POST`,
    `http POST :${port}/api/action action=stop`,
    `nc 127.0.0.1 ${port}`,
  ];
  for (const command of NON_QUERY) {
    it(`${command}`, () => {
      expect(verdicts(bash(command))).toEqual(["refused", "refused"]);
    });
  }

  it("查询（GET、HEAD）照旧放行", () => {
    for (const command of [`curl http://127.0.0.1:${port}/api/state`, `curl -I http://localhost:${port}/`, `Invoke-RestMethod http://127.0.0.1:${port}/api/state`]) {
      expect({ command, verdicts: verdicts(bash(command)) }).toEqual({ command, verdicts: ["runs", "runs"] });
    }
  });

  it("端口按现取的：manager.yaml 改了端口，按新的拒，旧的不再算", () => {
    const facts = { processes: PROCS, supervisorPorts: [47421] };
    expect(verdict(judge(SECRETARY, bash("curl -X POST http://127.0.0.1:47421/api/action"), { facts }))).toBe("refused");
    expect(judge(SECRETARY, bash(`curl -X POST http://127.0.0.1:${port}/api/action`), { facts }).hardRefusal).toBeNull();
  });

  it("几个端口都认（manager.yaml 的、拉起守护进程的那个管理器的）", () => {
    const places = { ...inChat(SECRETARY, bash("true")).places, supervisor: { dataDir: SVC.dataDir, ports: [port, 47555] } };
    expect(verdict(judge(SECRETARY, bash("curl -X POST http://127.0.0.1:47555/api/action"), { places }))).toBe("refused");
    expect(verdict(judge(SECRETARY, bash(`curl -X POST http://127.0.0.1:${port}/api/action`), { places }))).toBe("refused");
  });

  it("用浏览器打开服务管家的页面：接近底线先问", () => {
    expect(verdict(judge(MAINTAINER, bash(`agent-browser open http://127.0.0.1:${port}/`)))).toBe("keeps_asking");
  });

  it("别的本机端口、没给服务管家时照原来的规矩", () => {
    expect(judge(SECRETARY, bash("curl -X POST http://127.0.0.1:18090/v1/tts -d x")).hardRefusal).toBeNull();
    const base = inChat(SECRETARY, bash(`curl -X POST http://127.0.0.1:${port}/api/action`));
    expect(judgeToolCall({ ...base, conversationApprovals: "off" }).hardRefusal).toBeNull();
  });
});

describe("杀进程：杀到二狗自己、服务管家、命脉服务的永不", () => {
  const NEVER = [
    "kill -9 4242",
    "kill -s KILL 4343",
    "kill -- -1",
    "taskkill /F /IM node.exe",
    "taskkill //IM NODE.EXE //F",
    "TASKKILL -f -im node*",
    "C:/Windows/System32/taskkill.exe /F /PID 4343",
    'taskkill /F /FI "IMAGENAME eq node.exe"',
    'taskkill /F /FI "PID eq 4242"',
    "taskkill /F /T /PID 4000",
    "taskkill /IM ssh.exe",
    "tskill node",
    "pskill -t 4343",
    "Stop-Process -Name node -Force",
    "Stop-Process -Id 1234,4343",
    "Stop-Process 4242",
    "spps -n no*",
    "kill -Name node",
    "pkill node",
    "pkill -9 -x node",
    "killall node",
    "wmic process where \"name='node.exe'\" delete",
    "wmic process where processid=4343 call terminate",
    "wmic process delete",
    "echo 4343 | xargs kill -9 4242",
  ];
  for (const command of NEVER) {
    it(`${command}`, () => {
      expect(verdicts(bash(command))).toEqual(["never", "never"]);
      expect(dispositionFinding(judge(MAINTAINER, bash(command)), "protected_process")).toMatchObject({ kind: "process", disposition: "never" });
    });
  }

  it("说明写明杀到的是谁", () => {
    expect(judge(SECRETARY, bash("kill 4343")).explanation).toContain("服务管家（PID 4343）");
    expect(judge(SECRETARY, bash("taskkill /IM ssh.exe")).explanation).toContain("命脉服务 ergo-tunnel");
  });
});

describe("杀进程：看不准的接近底线先问（对话审批关着也问）", () => {
  const UNSURE = [
    'kill "$PID"',
    "Get-Process node | Stop-Process",
    "pgrep node | xargs kill",
    'pkill -f "lsm.mjs serve"',
    'taskkill /F /FI "USERNAME eq tester"',
    "taskkill /F /PID 4000",
    "wmic process where \"commandline like '%lsm%'\" delete",
    "kill -- -4343",
  ];
  for (const command of UNSURE) {
    it(`${command}`, () => {
      expect(verdicts(bash(command))).toEqual(["keeps_asking", "keeps_asking"]);
    });
  }

  it("受保护的进程没取到、没取全：写明的进程号、名字也判不准；已知的照样永不", () => {
    expect(verdicts(bash("kill 9999"), { facts: {} })).toEqual(["keeps_asking", "keeps_asking"]);
    expect(verdicts(bash("taskkill /IM python.exe"), { facts: {} })).toEqual(["keeps_asking", "keeps_asking"]);
    const partial = { facts: { processes: { ...PROCS, complete: false } } };
    expect(verdicts(bash("kill 9999"), partial)).toEqual(["keeps_asking", "keeps_asking"]);
    expect(verdicts(bash("kill 4242"), partial)).toEqual(["never", "never"]);
  });
});

describe("杀进程：别的先问，跟着对话审批的开关", () => {
  const OTHER = ["kill 9999", "kill %1", "kill $!", "taskkill /F /IM python.exe", "taskkill /F /T /PID 9999", "Stop-Process -Name chrome", "pkill python", "tskill notepad"];
  for (const command of OTHER) {
    it(`${command}`, () => {
      // 开着：先问（不是接近底线）；关着：和别的"先问我"一样直接做、照常标出（不是永不）
      expect(verdicts(bash(command), {}, "on")).toEqual(["ask", "ask"]);
      expect(dispositionFinding(judge(MAINTAINER, bash(command), {}, "on"), "kill_process")).toMatchObject({ kind: "process", disposition: "ask_first" });
      expect(verdicts(bash(command))).toEqual(["runs", "runs"]);
    });
  }

  it("不杀进程的：kill -0 只看在不在、kill -l 列信号", () => {
    for (const command of ["kill -0 4242", "kill -l", "kill -s 0 4343"]) {
      const j = judge(SECRETARY, bash(command), {}, "on");
      expect({ command, kills: j.calls.some((c) => c.tool === "kill_process"), verdict: verdict(j) }).toEqual({ command, kills: false, verdict: "runs" });
    }
  });

  it("模型直接调用 kill_process、supervisor_command 按没登记的工具处理", () => {
    expect(judge(SECRETARY, call("kill_process", { pids: [1] }), {}, "on").categories).toEqual(["unknown_write"]);
    expect(judge(SECRETARY, call("supervisor_command", { program: "lsm" }), {}, "on").hardRefusal).toBeNull();
  });
});

describe("服务管家的数据目录：注册表、运行状态写入永不，密钥区连读都拒绝", () => {
  const dir = SVC.dataDir;
  it("写、删注册表和 state.json：永不（bash 和文件工具；负责人的文件工具写项目外另有围栏的硬拒绝）", () => {
    for (const toolCall of [
      bash(`echo "port: 1" > ${sh(dir)}/registry/manager.yaml`),
      bash(`rm ${sh(dir)}/registry/services/ergo-tunnel.yaml`),
      bash(`cp /tmp/x.json ${sh(dir)}/state.json`),
      bash(`mv ${sh(dir)}/state.json.tmp ${sh(dir)}/state.json`),
      bash(`echo '{}' > ${sh(dir)}/tailnet-routes.json`),
      call("write", { path: `${dir}\\registry\\autostart.yaml`, content: "x" }),
      call("edit", { path: `${dir}\\state.json`, edits: [] }),
    ]) {
      const results = AGENTS.map((agent) => {
        const j = judge(agent, toolCall);
        return { executes: judgementExecutes(j), protectedArea: dispositionFinding(j, "protected_area")?.disposition };
      });
      expect({ call: toolCall.args, results }).toEqual({ call: toolCall.args, results: [{ executes: false, protectedArea: "never" }, { executes: false, protectedArea: "never" }] });
    }
    expect(verdicts(bash(`rm ${sh(dir)}/registry/services/ergo-tunnel.yaml`))).toEqual(["never", "never"]);
  });

  it("读密钥区：硬拒绝（连读都拒绝），通配符能匹配到的也拒绝", () => {
    for (const toolCall of [bash(`cat ${sh(dir)}/.secrets/webui-password.txt`), call("read", { path: `${dir}\\.secrets\\webui-password.txt` }), bash(`cat ${sh(dir)}/.sec*/web*`)]) {
      const j = judge(SECRETARY, toolCall);
      expect(j.hardRefusal).toEqual(["secrets_area"]);
      expect(j.explanation).toContain("服务管家的密钥区");
    }
  });

  it("读注册表、日志，写日志目录照常（不是受保护区域）", () => {
    for (const toolCall of [bash(`cat ${sh(dir)}/registry/manager.yaml`), bash(`tail -n 50 ${sh(dir)}/logs/manager.log`), bash(`echo x > ${sh(dir)}/logs/note.txt`)]) {
      const j = judge(MAINTAINER, toolCall);
      expect({ call: toolCall.args, hardRefusal: j.hardRefusal, protectedArea: dispositionFinding(j, "protected_area") }).toEqual({ call: toolCall.args, hardRefusal: null, protectedArea: undefined });
    }
  });

  it("拆不开的命令里写着注册表：接近底线先问；写着它的密钥区：永不", () => {
    expect(verdict(judge(MAINTAINER, bash(`python -c "open(r'${dir}\\registry\\manager.yaml','w').write('x')"`)))).toBe("keeps_asking");
    expect(verdict(judge(MAINTAINER, bash(`python -c "print(open(r'${dir}\\.secrets\\webui-password.txt').read())"`)))).toBe("never");
  });
});

describe("拆不开的命令：写着杀进程、管理器端口、服务管家的命令行、ergo 的停止重启升级、它的计划任务的接近底线先问", () => {
  const CASES = [
    'powershell -Command "Get-Process node | Stop-Process -Force"',
    "cmd /c tskill node",
    'bash -c "kill -9 $(cat daemon.pid)"',
    `python -c "import os, signal; os.kill(4242, signal.SIGTERM)"`,
    `python -c "import requests; requests.post('http://127.0.0.1:${PORT}/api/action', json={'action':'stop'})"`,
    `node -e "fetch('http://localhost:${PORT}/api/action',{method:'POST'})"`,
    `node -e "require('child_process').execSync('lsm stop ergo-daemon')"`,
    'cmd /c "ergo stop"',
    'powershell -Command "Stop-ScheduledTask -TaskName LocalServiceManager"',
    'eval "$(echo taskkill /IM node.exe)"',
  ];
  for (const command of CASES) {
    it(`${command}`, () => {
      expect(verdicts(bash(command))).toEqual(["keeps_asking", "keeps_asking"]);
      expect(judge(MAINTAINER, bash(command)).explanation).toContain("服务管家工具");
    });
  }

  it("没写这些的照旧（对话审批关着直接做）", () => {
    for (const command of ['python -c "print(1)"', 'node -e "console.log(process.version)"', 'bash -c "npm test"']) {
      expect({ command, verdict: verdict(judge(SECRETARY, bash(command))) }).toEqual({ command, verdict: "runs" });
    }
  });
});

describe("服务管家的计划任务：停、删、改接近底线先问，查的照旧", () => {
  it("schtasks /End、/Change、Stop-ScheduledTask、Unregister-ScheduledTask：先问", () => {
    for (const command of [
      "schtasks /End /TN LocalServiceManager",
      'schtasks /Change /TN "LocalServiceManager" /Disable',
      "Stop-ScheduledTask -TaskName LocalServiceManager",
      "Unregister-ScheduledTask -TaskName LocalServiceManager -Confirm:$false",
    ]) {
      expect({ command, verdict: verdict(judge(MAINTAINER, bash(command))) }).toEqual({ command, verdict: "keeps_asking" });
    }
  });

  it("查的照旧", () => {
    for (const command of ["schtasks /Query /TN LocalServiceManager", "Get-ScheduledTask -TaskName LocalServiceManager", "grep -n LocalServiceManager notes.md", "echo LocalServiceManager"]) {
      expect({ command, verdict: verdict(judge(MAINTAINER, bash(command))) }).toEqual({ command, verdict: "runs" });
    }
  });
});

describe("正常用法没被误伤", () => {
  it("跑测试、写草稿区、项目里读写、跑别的脚本、GET 本机服务：照旧放行", () => {
    const CASES: [GuardAgent, ToolCall][] = [
      [MAINTAINER, bash("npm test")],
      [MAINTAINER, bash("npx vitest run test/a.test.ts")],
      [MAINTAINER, bash("node scripts/build.mjs --out dist")],
      [MAINTAINER, bash("echo hi > notes.md && cat notes.md")],
      [SECRETARY, bash("echo draft > draft.md")],
      [SECRETARY, call("write", { path: `${P.scratch}\\draft.md`, content: "x" })],
      [SECRETARY, bash(`curl http://127.0.0.1:${PORT}/api/state`)],
      [SECRETARY, bash("curl http://127.0.0.1:18090/health")],
      [MAINTAINER, bash("node server.js & sleep 2; curl http://127.0.0.1:3000/health")],
    ];
    for (const [agent, toolCall] of CASES) {
      expect({ call: toolCall.args, verdict: verdict(judge(agent, toolCall)) }).toEqual({ call: toolCall.args, verdict: "runs" });
    }
  });

  it("杀自己在草稿区起的进程：先问（关着时直接做），不是永不", () => {
    for (const command of ["node server.js & PID=$!; sleep 1; kill $!", "python -m http.server 8000 & kill %1"]) {
      const j = judge(SECRETARY, bash(command), {}, "on");
      expect({ command, disposition: j.disposition, kill: dispositionFinding(j, "kill_process")?.disposition }).toEqual({ command, disposition: "ask_first", kill: "ask_first" });
      expect(verdict(judge(SECRETARY, bash("node server.js & PID=$!; sleep 1; kill $!")))).toBe("runs");
    }
  });
});
