// 守卫切面：一台电脑上可以配置多份二狗，各份互相隔开（468）。
// 这一份（数据目录 D:\ergo-data，端口 48810 / 48811）看得到另外两份：
//   - ergo-b：文件夹 E:\ergo-b，端口 48820 / 48821，服务管家日志目录里有 ergo-b.out.log 和它名下服务的 ergo-b--web.out.log；
//   - 默认那份 ergo-daemon：文件夹 C:\Users\tester\.ergo（用户主目录下），端口 48830 / 48831。
// 读写它们的文件、访问它们的端口、停或杀它们的守护进程一律硬拒绝（other_instance），批准了也不行；服务管家的端口连查询也拒（supervisor）；
// 自己那份、别的本机服务照旧。各种写法都试：正斜杠、反斜杠、Git Bash、~、$HOME、%USERPROFILE%、$env:、相对路径、通配符、短名、链接、
// curl / wget / Invoke-WebRequest / httpie / nc / ssh -L、浏览器工具、WebFetch、MCP 的浏览器工具、写成脚本再跑。
// 只做判定：路径、端口都是编的，不碰文件、不连端口。挡不住的写法（下面"挡不住"那一组）照实写在这里和票的 Comments 里。
import { describe, expect, it } from "vitest";
import { type GuardAgent, type GuardInput, type GuardJudgement, judgementExecutes, judgeToolCall, type OtherInstance, type ProcessFacts, type ScriptFact, type ToolCall } from "../../src/guard/index.ts";
import { bash, call, inChat, inTask, maintainer, P, secretary, v1Satisfied } from "./helpers/guard-input.ts";

const SVC = "C:\\Users\\tester\\AppData\\Local\\ergo\\supervisor";
const MANAGER_PORT = 47420;
const B: OtherInstance = {
  id: "ergo-b",
  dataDirs: ["E:\\ergo-b"],
  ports: [48820, 48821],
  logFiles: [`${SVC}\\logs\\ergo-b.out.log`, `${SVC}\\logs\\ergo-b.out.log.1`, `${SVC}\\logs\\ergo-b--web.out.log`],
};
const DEFAULT: OtherInstance = { id: "ergo-daemon", dataDirs: [`${P.home}\\.ergo`], ports: [48830, 48831], logFiles: [`${SVC}\\logs\\ergo-daemon.out.log`] };
const OTHERS = [B, DEFAULT];

const online = (agent: GuardAgent): GuardAgent => ({ ...agent, toolkit: { ...agent.toolkit, bash: true, network: true } });
const SECRETARY = online(secretary());
const MAINTAINER = maintainer();
const AGENTS = [SECRETARY, MAINTAINER];

function judge(agent: GuardAgent, toolCall: ToolCall, extra: Partial<GuardInput> = {}, others: readonly OtherInstance[] = OTHERS): GuardJudgement {
  const base = agent.kind === "secretary" ? inChat(agent, toolCall) : inTask(agent, toolCall, v1Satisfied());
  return judgeToolCall({
    ...base,
    places: { ...base.places, supervisor: { dataDir: SVC, ports: [MANAGER_PORT] }, otherInstances: others },
    conversationApprovals: "off",
    ...extra,
  });
}

/** other（碰另一份，硬拒绝）、supervisor（碰服务管家，硬拒绝）、别的硬拒绝、never、ask、runs */
function verdict(j: GuardJudgement): string {
  if (j.hardRefusal?.includes("other_instance")) return "other";
  if (j.hardRefusal?.includes("supervisor")) return "supervisor";
  if (j.hardRefusal) return j.hardRefusal.join(",");
  if (j.disposition === "never") return "never";
  if (j.disposition === "ask_first") return "ask";
  return judgementExecutes(j) ? "runs" : j.disposition;
}

const both = (toolCall: ToolCall, extra: Partial<GuardInput> = {}) => AGENTS.map((agent) => verdict(judge(agent, toolCall, extra)));

describe("另一份的文件夹：读写都硬拒绝（各种写法）", () => {
  const READS = [
    "cat E:/ergo-b/config/ergo.json",
    "cat 'E:\\ergo-b\\config\\ergo.json'",
    "cat E:\\\\ergo-b\\\\secrets\\\\deepseek-api-key.txt",
    "cat /e/ergo-b/db/ergo.db",
    "cat /mnt/e/ergo-b/db/ergo.db",
    "cd E:/work/notes && cat ../../ergo-b/config/ergo.json",
    "cd E:/ergo-b && cat config/ergo.json",
    "ls E:/ergo-b",
    "grep -r token E:/ergo-b",
    "head -c 100 E:/ERGO-B/DB/ERGO.DB",
    "cp -r E:/ergo-b/sessions ./copy",
    "tar czf out.tgz E:/ergo-b",
    "cat E:/ergo-*/config/ergo.json",
    "cat E:/ergo-b/*",
    "cat ~/.ergo/config/ergo.json",
    "cat $HOME/.ergo/secrets/deepseek-api-key.txt",
    "cat ${HOME}/.ergo/db/ergo.db",
    "cat C:/Users/tester/.ergo/config/ergo.json",
    "cat $USERPROFILE/.ergo/config/ergo.json",
    "cat $LOCALAPPDATA/ergo/supervisor/logs/ergo-b.out.log",
    `cat ${SVC.replaceAll("\\", "/")}/logs/ergo-b.out.log`,
    `tail -n 50 ${SVC.replaceAll("\\", "/")}/logs/ergo-b--web.out.log`,
    `cat ${SVC.replaceAll("\\", "/")}/logs/ergo-b.out.log.1`,
    `cat ${SVC.replaceAll("\\", "/")}/logs/ergo-daemon.out.log`,
  ];
  for (const command of READS) {
    it(`读：${command}`, () => {
      expect(both(bash(command))).toEqual(["other", "other"]);
    });
  }

  const WRITES = ["echo x > E:/ergo-b/config/ergo.json", "rm -rf E:/ergo-b", "mv E:/ergo-b/db E:/tmp/db", "cp notes.md E:/ergo-b/projects/x.md", "mkdir E:/ergo-b/projects/evil", "echo x >> ~/.ergo/config/mcp.json"];
  for (const command of WRITES) {
    it(`写：${command}`, () => {
      expect(both(bash(command))).toEqual(["other", "other"]);
    });
  }

  it("文件工具读、写、列", () => {
    for (const toolCall of [
      call("read", { path: "E:\\ergo-b\\config\\ergo.json" }),
      call("read", { path: "E:/ergo-b/secrets/deepseek-api-key.txt" }),
      call("ls", { path: "E:\\ergo-b" }),
      call("grep", { pattern: "key", path: "E:\\ergo-b" }),
      call("write", { path: "E:\\ergo-b\\config\\x.json", content: "{}" }),
      call("edit", { path: "~/.ergo/config/ergo.json", edits: [{ oldText: "a", newText: "b" }] }),
      call("read", { path: `${SVC}\\logs\\ergo-b.out.log` }),
    ]) {
      expect({ args: toolCall.args, verdicts: both(toolCall) }).toEqual({ args: toolCall.args, verdicts: ["other", "other"] });
    }
  });

  it("短名、符号链接、目录联接：按真实路径认", () => {
    const facts = { files: { "E:\\ERGO-B~1\\config\\ergo.json": { exists: true, realPath: "E:\\ergo-b\\config\\ergo.json" }, "E:\\work\\notes\\link\\ergo.json": { exists: true, realPath: "E:\\ergo-b\\config\\ergo.json" } } };
    expect(verdict(judge(MAINTAINER, call("read", { path: "E:\\ERGO-B~1\\config\\ergo.json" }), { facts: { ...v1Satisfied().facts, ...facts } }))).toBe("other");
    expect(verdict(judge(MAINTAINER, bash("cat link/ergo.json"), { facts: { ...v1Satisfied().facts, ...facts } }))).toBe("other");
  });

  it("通配符展开成的现有路径落在另一份里", () => {
    const facts = { ...v1Satisfied().facts, wildcards: { "E:\\*\\config\\ergo.json": ["E:\\ergo-b\\config\\ergo.json", "E:\\work\\config\\ergo.json"] } };
    expect(verdict(judge(MAINTAINER, bash("cat E:/*/config/ergo.json"), { facts }))).toBe("other");
  });

  it("授权的文件夹、目录授权放不开", () => {
    expect(verdict(judge(SECRETARY, call("read", { path: "E:\\ergo-b\\config\\ergo.json" }), { authorizedFolders: ["E:\\"] }))).toBe("other");
    expect(verdict(judge(SECRETARY, call("read", { path: "E:\\ergo-b\\config\\ergo.json" }), { folderGrants: [{ grantId: "g1", dir: "E:\\", modes: ["read", "write", "delete"] }] }))).toBe("other");
  });

  it("拆不开的命令、写成脚本再跑：写着另一份的路径、文件夹名的硬拒绝", () => {
    for (const command of [
      `python -c "print(open(r'E:\\ergo-b\\secrets\\deepseek-api-key.txt').read())"`,
      `node -e "require('fs').readFileSync('E:/ergo-b/config/ergo.json')"`,
      `powershell -Command "Get-Content $env:USERPROFILE\\.ergo\\config\\ergo.json"`,
      `powershell -Command "Get-Content $env:LOCALAPPDATA\\ergo\\supervisor\\logs\\ergo-b.out.log"`,
      `cmd /c "type %USERPROFILE%\\.ergo\\config\\ergo.json"`,
    ]) {
      expect({ command, verdicts: both(bash(command)) }).toEqual({ command, verdicts: ["other", "other"] });
    }
    const script = "E:\\work\\notes\\peek.py";
    const facts = { ...v1Satisfied().facts, scripts: { [script]: { networkUsage: [], mentionedPaths: ["E:\\ergo-b\\db\\ergo.db"] } } };
    expect(verdict(judge(MAINTAINER, bash("python peek.py"), { facts }))).toBe("other");
  });
});

describe("另一份的端口：http 请求、网络命令、浏览器工具、脚本一律硬拒绝", () => {
  const COMMANDS = [
    "curl http://127.0.0.1:48820/api/state",
    "curl -X POST http://localhost:48820/api/messages -d x",
    "curl 127.0.0.1:48821/",
    "curl http://[::1]:48820/healthz",
    "curl http://0.0.0.0:48820/",
    "wget -qO- http://127.0.0.1:48830/api/events",
    "Invoke-WebRequest -Uri http://127.0.0.1:48820/api/state",
    "irm http://localhost:48831/api/state",
    "http :48820/api/state",
    "curl http://example.com/ok http://127.0.0.1:48820/api/state",
    "nc 127.0.0.1 48820",
    "ssh -L 9000:127.0.0.1:48820 user@example.com",
    "agent-browser open http://127.0.0.1:48820/",
    "ego-browser open 127.0.0.1:48821",
    `ego-browser nodejs -e 'const t = await taskSpace("x"); await t.page("p1").goto("http://localhost:48820/")'`,
    "chrome --app=http://127.0.0.1:48820/",
    `python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:48820/api/state').read())"`,
    `node -e "fetch('http://localhost:48820/api/state').then(r=>r.text()).then(console.log)"`,
    `powershell -Command "Invoke-RestMethod http://127.0.0.1:48820/api/state"`,
    `python -c "import socket; s=socket.create_connection(('127.0.0.1', 48820))"`,
  ];
  for (const command of COMMANDS) {
    it(`${command}`, () => {
      expect(both(bash(command))).toEqual(["other", "other"]);
    });
  }

  it("别的工具的网址参数（读网页、MCP 的浏览器工具、写进文件的脚本）", () => {
    for (const toolCall of [
      call("web_fetch", { url: "http://127.0.0.1:48820/api/state" }),
      call("mcp__chrome__navigate", { url: "http://localhost:48821/" }),
      call("mcp__files__read_file", { path: "E:\\ergo-b\\config\\ergo.json" }),
      call("write", { path: `${P.workDir}\\peek.py`, content: "import requests\nprint(requests.get('http://127.0.0.1:48820/api/state').text)\n" }),
    ]) {
      expect({ tool: toolCall.toolName, verdict: verdict(judge(MAINTAINER, toolCall)) }).toEqual({ tool: toolCall.toolName, verdict: "other" });
    }
  });

  it("跑的脚本里写着另一份的端口、又用到能联网的库：硬拒绝；没用联网的库只是写着这个数的照旧", () => {
    const script = "E:\\work\\notes\\peek.py";
    const facts = (fact: ScriptFact) => ({ ...v1Satisfied().facts, scripts: { [script]: fact } });
    expect(verdict(judge(MAINTAINER, bash("python peek.py"), { facts: facts({ networkUsage: [], localOnly: ["requests"], mentionedPorts: [48820] }) }))).toBe("other");
    expect(verdict(judge(MAINTAINER, bash("python peek.py"), { facts: facts({ networkUsage: ["requests"], mentionedPorts: [48831] }) }))).toBe("other");
    expect(verdict(judge(MAINTAINER, bash("python peek.py"), { facts: facts({ networkUsage: [], mentionedPorts: [48820] }) }))).toBe("runs");
  });
});

describe("服务管家：查询也挡；另一份的日志不许看", () => {
  it("往管理器端口发 GET（列表、日志、日志的原文）：硬拒绝", () => {
    for (const command of [
      `curl http://127.0.0.1:${MANAGER_PORT}/api/state`,
      `curl "http://127.0.0.1:${MANAGER_PORT}/api/logs?id=ergo-b&lines=200"`,
      `curl "http://localhost:${MANAGER_PORT}/api/logs/range?id=ergo-b"`,
      `agent-browser open http://127.0.0.1:${MANAGER_PORT}/logs.html?id=ergo-b`,
    ]) {
      expect({ command, verdicts: both(bash(command)) }).toEqual({ command, verdicts: ["supervisor", "supervisor"] });
    }
  });

  it("配置了多份时：拆不开的命令里写着管理器端口的硬拒绝（只有一份时照 419 先问）", () => {
    const command = `python -c "import urllib.request as u; print(u.urlopen('http://127.0.0.1:${MANAGER_PORT}/api/state').read())"`;
    expect(verdict(judge(MAINTAINER, bash(command)))).toBe("supervisor");
    expect(verdict(judge(MAINTAINER, bash(command), {}, []))).toBe("ask");
  });
});

describe("ergo 命令：配置了多份时作用在某一份上的都拒（认不准是哪一份），只有一份时照旧", () => {
  it("status、logs、open、start、list、backup：多份时硬拒绝，只有一份时照旧", () => {
    for (const command of ["ergo status", "ergo logs -n 100", "ergo open --print", "ergo start", "ergo list", "ergo backup", "npm run ergo -- logs", "ergo.cmd status --json"]) {
      expect({ command, multi: verdict(judge(MAINTAINER, bash(command))), single: verdict(judge(MAINTAINER, bash(command), {}, [])) }).toEqual({ command, multi: "supervisor", single: "runs" });
    }
  });

  it("init、unregister 一律硬拒绝（改服务管家里的登记）", () => {
    for (const command of ["ergo init --name x", "ergo unregister", "ergo --dir E:/work/x init"]) {
      for (const others of [OTHERS, []]) expect({ command, verdict: verdict(judge(MAINTAINER, bash(command), {}, others)) }).toEqual({ command, verdict: "supervisor" });
    }
    // 指着另一份的：停掉、拿掉另一份，按另一份拒（没有别的份时它就只是个文件夹，照服务管家的命令拒）
    expect(verdict(judge(MAINTAINER, bash("ergo --dir=E:/ergo-b unregister")))).toBe("other");
    expect(verdict(judge(MAINTAINER, bash("ergo --dir=E:/ergo-b unregister"), {}, []))).toBe("supervisor");
  });

  it("--dir 写在命令前面也认得出子命令；--dir 指着另一份的文件夹按路径拒", () => {
    expect(verdict(judge(MAINTAINER, bash("ergo --dir E:/work/x stop"), {}, []))).toBe("supervisor");
    expect(verdict(judge(MAINTAINER, bash("ergo --dir E:/ergo-b logs")))).toBe("other");
    expect(verdict(judge(MAINTAINER, bash("ergo logs --dir=~/.ergo"), {}, [DEFAULT]))).toBe("other");
  });

  it("帮助、版本、报事件照旧", () => {
    for (const command of ["ergo help", "ergo --version", "ergo version", "ergo notify built --data '{}'"]) {
      expect({ command, verdict: verdict(judge(MAINTAINER, bash(command))) }).toEqual({ command, verdict: "runs" });
    }
  });

  it("拆不开的命令里写着 ergo 作用在某一份上的命令：多份时硬拒绝", () => {
    expect(verdict(judge(MAINTAINER, bash(`powershell -Command "ergo logs -n 500"`)))).toBe("supervisor");
  });
});

describe("自己那份、别的本机服务照旧", () => {
  it("自己的项目、草稿区、读授权的文件夹、别的本机端口照旧；自己的端口照原来的规矩（不算另一份）", () => {
    expect(verdict(judge(MAINTAINER, bash("cat notes.md && echo x > out.md")))).toBe("runs");
    expect(verdict(judge(SECRETARY, bash("echo draft > draft.md")))).toBe("runs");
    expect(verdict(judge(SECRETARY, call("read", { path: "E:\\docs\\a.md" }), { authorizedFolders: ["E:\\docs"] }))).toBe("runs");
    expect(verdict(judge(MAINTAINER, bash("curl http://127.0.0.1:3000/health")))).toBe("runs");
    expect(verdict(judge(MAINTAINER, bash("curl http://127.0.0.1:8090/health")))).toBe("runs");
    expect(judge(MAINTAINER, bash(`curl http://127.0.0.1:${P.ownPorts[0]}/api/state`)).hardRefusal).toBeNull();
    // 服务管家日志目录里自己的、管理器自己的日志照常读
    expect(verdict(judge(SECRETARY, call("read", { path: `${SVC}\\logs\\manager.log` }), { authorizedFolders: [SVC] }))).toBe("runs");
  });

  it("文件夹名和另一份一样的前缀不算（E:\\ergo-backup 不是 E:\\ergo-b）", () => {
    expect(verdict(judge(SECRETARY, call("read", { path: "E:\\ergo-backup\\a.md" }), { authorizedFolders: ["E:\\ergo-backup"] }))).toBe("runs");
  });

  it("没有别的份时一切照原样", () => {
    expect(verdict(judge(MAINTAINER, bash("curl http://127.0.0.1:48820/api/state"), {}, []))).toBe("runs");
  });
});

describe("另一份在里面的上级目录：会连带碰到它的（搜、找、复制、删、挪、看不出读写的）硬拒绝，只列一层的照旧", () => {
  it("grep -r、rg、find、cp -r、rm -rf、mv、tar 上级目录：硬拒绝", () => {
    for (const command of [
      "grep -r token E:/",
      "rg token E:\\\\",
      "find E:/ -name '*.json'",
      "cp -r E:/ E:/work/notes/all",
      "rm -rf E:/old E:/",
      "mv E:/ E:/x",
      "tar czf out.tgz E:/",
      "rg -i key ~",
      `grep -r error ${SVC.replaceAll("\\", "/")}/logs`,
    ]) {
      expect({ command, verdict: verdict(judge(MAINTAINER, bash(command))) }).toEqual({ command, verdict: "other" });
    }
  });

  it("只列一层（ls）、搜别的子目录照旧", () => {
    expect(verdict(judge(SECRETARY, bash("ls E:/"), { authorizedFolders: ["E:\\"] }))).toBe("runs");
    expect(verdict(judge(MAINTAINER, bash("rg TODO E:/work/notes")))).toBe("runs");
    expect(verdict(judge(SECRETARY, call("read", { path: `${SVC}\\logs\\manager.log` }), { authorizedFolders: [SVC] }))).toBe("runs");
  });
});

describe("挡不住的（照实记下，见票的 Comments）", () => {
  it("端口拼出来的（变量、算出来的）认不出", () => {
    // 前面赋过值的变量守卫会代进去（P=48820; curl …:$P 是挡得住的），从文件读的、算出来的认不出
    expect(verdict(judge(MAINTAINER, bash("P=48820; curl http://127.0.0.1:$P/api/state")))).toBe("other");
    expect(verdict(judge(MAINTAINER, bash("curl http://127.0.0.1:$(cat port.txt)/api/state")))).not.toBe("other");
  });
});

describe("停、杀另一份二狗：一律硬拒绝（批准的是这一份的用户，不能替另一份做主）", () => {
  // 受保护的进程：这一份的守护进程 4242、服务管家 4343；ergo-b 的守护进程（服务管家记的 5100 是包着它的 cmd，它自己的 daemon.pid 记的 5200）；
  // 编一个连同子进程杀会杀到 ergo-b 的上级进程 5050
  const PROCS: ProcessFacts = {
    protected: [
      { pid: 4242, exe: "node.exe", role: "daemon" },
      { pid: 4343, exe: "node.exe", role: "manager" },
      { pid: 5100, exe: "cmd.exe", role: "instance", service: "ergo-b" },
      { pid: 5200, exe: "node.exe", role: "instance", service: "ergo-b" },
    ],
    complete: true,
    ancestors: [
      { pid: 4000, exe: "conhost.exe", of: 4343 },
      { pid: 5050, exe: "pwsh.exe", of: 5200 },
    ],
  };
  function judgeKill(agent: GuardAgent, command: string, approvals: "on" | "off" = "off"): GuardJudgement {
    const base = agent.kind === "secretary" ? inChat(agent, bash(command)) : inTask(agent, bash(command), v1Satisfied());
    return judgeToolCall({
      ...base,
      places: { ...base.places, supervisor: { dataDir: SVC, ports: [MANAGER_PORT] }, otherInstances: OTHERS },
      facts: { ...base.facts, processes: PROCS },
      conversationApprovals: approvals,
    });
  }
  const killBoth = (command: string) => AGENTS.flatMap((agent) => (["off", "on"] as const).map((approvals) => verdict(judgeKill(agent, command, approvals))));

  it("按进程号、按名字、连同子进程杀上级、杀所有进程，杀到它的守护进程：硬拒绝（对话审批开着、关着都一样）", () => {
    for (const command of [
      "taskkill /F /PID 5200",
      "taskkill //PID 5100 //F",
      "kill 5200",
      "kill -9 5100",
      "Stop-Process -Id 5200 -Force",
      "tskill 5200",
      "wmic process 5200 delete",
      "taskkill /T /F /PID 5050",
      "taskkill /IM node.exe /F",
      "kill -9 -- -1",
    ]) {
      expect({ command, verdicts: killBoth(command) }).toEqual({ command, verdicts: ["other", "other", "other", "other"] });
    }
    const j = judgeKill(MAINTAINER, "taskkill /F /PID 5200");
    expect(j.findings.find((f) => f.kind === "hard_refusal")?.message).toContain("另一份二狗 ergo-b 的守护进程（PID 5200）");
  });

  it("写着它的端口、登记 id、文件夹的杀进程和按端口杀：硬拒绝", () => {
    for (const command of [
      "npx kill-port 48820",
      "fuser -k 48821/tcp",
      "netstat -ano | grep 48820 | awk '{print $5}' | xargs kill",
      "lsof -ti:48820 | xargs kill -9",
      "pkill -f ergo-b",
      "pkill -f E:/ergo-b",
      `wmic process where "commandline like '%ergo-b%'" delete`,
      `taskkill /FI "WINDOWTITLE eq ergo-b" /F`,
      "kill $(cat E:/ergo-b/daemon.pid)",
      `powershell -Command "Get-NetTCPConnection -LocalPort 48820 | ForEach-Object { Stop-Process -Id $_.OwningProcess }"`,
      `powershell -Command "Stop-Process -Id 5200 -Force"`,
      `cmd /c "taskkill /PID 5100 /F"`,
      `python -c "import os; os.kill(5200, 9)"`,
    ]) {
      expect({ command, verdict: verdict(judgeKill(MAINTAINER, command)) }).toEqual({ command, verdict: "other" });
    }
  });

  it("ergo 停、重启另一份（--dir、在它的文件夹里、ERGO_DATA_DIR）和服务管家的停止、重启：硬拒绝", () => {
    for (const command of [
      "ergo --dir E:/ergo-b stop",
      "ergo stop --dir='E:\\ergo-b'",
      "ergo restart --dir ~/.ergo",
      "cd E:/ergo-b && ergo stop",
      "ERGO_DATA_DIR=E:/ergo-b ergo restart",
      "lsm stop ergo-b",
      "lsm restart ergo-b",
      "lsm stop ergo-b--web",
      "lsm stop ergo-daemon",
      "ergo svc restart ergo-b",
      `curl -X POST http://127.0.0.1:${MANAGER_PORT}/api/action -H "Content-Type: application/json" -d '{"id":"ergo-b","action":"stop"}'`,
      `powershell -Command "lsm restart ergo-b"`,
    ]) {
      expect({ command, verdict: verdict(judgeKill(MAINTAINER, command)) }).toEqual({ command, verdict: "other" });
    }
    expect(judgeKill(MAINTAINER, "lsm stop ergo-b").findings.find((f) => f.kind === "hard_refusal" && f.id === "other_instance")?.message).toContain("登记 id ergo-b");
  });

  it("认不出是谁的杀进程、停服务照原来的规矩；进程号碰巧和它的端口一样的不算", () => {
    // 对话审批关着：和别的"先问我"一样直接做（开着先问）
    expect(verdict(judgeKill(MAINTAINER, "kill 7777"))).toBe("runs");
    expect(verdict(judgeKill(MAINTAINER, "taskkill /IM python.exe /F"))).toBe("runs");
    expect(verdict(judgeKill(MAINTAINER, "kill 48820"))).toBe("runs");
    expect(verdict(judgeKill(MAINTAINER, "kill 7777", "on"))).toBe("ask");
    // 不带 /T 杀它的上级进程：看不准，照旧接近底线先问
    expect(judgeKill(MAINTAINER, "taskkill /PID 5050").hardRefusal).toBeNull();
    // 这一份自己的守护进程照 419 永不；别的服务管家命令照 419 硬拒绝（不算另一份）
    expect(verdict(judgeKill(MAINTAINER, "kill 4242"))).toBe("never");
    expect(verdict(judgeKill(MAINTAINER, "lsm stop comfyui"))).toBe("supervisor");
    expect(verdict(judgeKill(MAINTAINER, "ergo stop"))).toBe("supervisor");
    expect(verdict(judgeKill(MAINTAINER, "pkill -f ergo-backup"))).toBe("ask");
  });
});

describe("本机来的也要配对（469）：另一份的退路命令、另一份的本机程序令牌", () => {
  it("对另一份跑 ergo local-pairing（--dir、在它的文件夹里、ERGO_DATA_DIR）硬拒绝；对这一份跑也硬拒绝（只能由用户自己跑）", () => {
    for (const command of [
      "ergo local-pairing off --dir E:/ergo-b",
      "ergo --dir=E:/ergo-b local-pairing off",
      "ergo local-pairing --dir='E:\\ergo-b'",
      "ergo local-pairing off --dir ~/.ergo",
      "cd E:/ergo-b && ergo local-pairing off",
      "ERGO_DATA_DIR=E:/ergo-b ergo local-pairing off",
    ]) {
      expect({ command, verdicts: both(bash(command)) }).toEqual({ command, verdicts: ["other", "other"] });
    }
    for (const others of [OTHERS, []]) {
      for (const command of ["ergo local-pairing off", "ergo local-pairing", "npm run ergo -- local-pairing off"]) {
        expect({ command, others: others.length, verdict: verdict(judge(MAINTAINER, bash(command), {}, others)) }).toEqual({ command, others: others.length, verdict: "supervisor" });
      }
    }
  });

  it("读另一份密钥区里的本机程序令牌（拿去冒充那一份的本机程序）硬拒绝；这一份自己的也读不到（密钥区）", () => {
    for (const toolCall of [
      bash("cat E:/ergo-b/secrets/local-token"),
      bash("cat ~/.ergo/secrets/local-token"),
      bash(`curl -H "x-ergo-local-token: $(cat E:/ergo-b/secrets/local-token)" http://127.0.0.1:48820/api/safety-settings`),
      bash("cat 'E:\\ergo-b\\secrets\\local-token'"),
      call("read", { path: "E:\\ergo-b\\secrets\\local-token" }),
      call("read", { path: `${P.home}\\.ergo\\secrets\\local-token` }),
    ]) {
      expect({ args: toolCall.args, verdicts: both(toolCall) }).toEqual({ args: toolCall.args, verdicts: ["other", "other"] });
    }
    for (const toolCall of [bash("cat D:/ergo-data/secrets/local-token"), call("read", { path: `${P.secrets}\\local-token` })]) {
      for (const agent of AGENTS) expect({ args: toolCall.args, refusal: judge(agent, toolCall).hardRefusal }).toEqual({ args: toolCall.args, refusal: ["secrets_area"] });
    }
  });
});
