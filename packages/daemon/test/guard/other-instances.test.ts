// 守卫切面：一台电脑上可以配置多份二狗，各份互相隔开（468）。
// 这一份（数据目录 D:\ergo-data，端口 48810 / 48811）看得到另外两份：
//   - ergo-b：文件夹 E:\ergo-b，端口 48820 / 48821，服务管家日志目录里有 ergo-b.out.log 和它名下服务的 ergo-b--web.out.log；
//   - 默认那份 ergo-daemon：文件夹 C:\Users\tester\.ergo（用户主目录下），端口 48830 / 48831。
// 读写它们的文件、访问它们的端口一律硬拒绝（other_instance），批准了也不行；服务管家的端口连查询也拒（supervisor）；
// 自己那份、别的本机服务照旧。各种写法都试：正斜杠、反斜杠、Git Bash、~、$HOME、%USERPROFILE%、$env:、相对路径、通配符、短名、链接、
// curl / wget / Invoke-WebRequest / httpie / nc / ssh -L、浏览器工具、WebFetch、MCP 的浏览器工具、写成脚本再跑。
// 只做判定：路径、端口都是编的，不碰文件、不连端口。挡不住的写法（下面"挡不住"那一组）照实写在这里和票的 Comments 里。
import { describe, expect, it } from "vitest";
import { type GuardAgent, type GuardInput, type GuardJudgement, judgementExecutes, judgeToolCall, type OtherInstance, type ScriptFact, type ToolCall } from "../../src/guard/index.ts";
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
    for (const command of ["ergo init --name x", "ergo unregister", "ergo --dir E:/work/x init", "ergo --dir=E:/ergo-b unregister"]) {
      for (const others of [OTHERS, []]) expect({ command, verdict: verdict(judge(MAINTAINER, bash(command), {}, others)) }).toEqual({ command, verdict: "supervisor" });
    }
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
