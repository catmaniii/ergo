// 守卫切面：联网开关（工具包的一项）。关着时联网的工具和命令直接拒绝；秘书一律按关着判。
import { describe, expect, it } from "vitest";
import { judgeToolCall, type GuardInput } from "../../src/guard/index.ts";
import { bash, call, inChat, inTask, maintainer, P, secretary } from "./helpers/guard-input.ts";
import { TEST_TOOLS } from "./helpers/test-tools.ts";

const offline = maintainer({ toolkit: { bash: true, network: false } });
const withTools = (input: GuardInput): GuardInput => ({ ...input, tools: TEST_TOOLS });

describe("联网开关关着", () => {
  const NETWORKED = [
    ["联网的 MCP 工具", call("mcp_web_search", { query: "天气" })],
    ["带类型的 git 推送", call("git_push", { remote: "origin", branch: "main" })],
    ["带类型的建远端仓库", call("create_remote_repo", { name: "notes", visibility: "private" })],
    ["带类型的装依赖", call("install_deps", {})],
    ["bash 里的 GET 请求", bash("curl https://example.com")],
    ["bash 里的 POST 请求", bash("curl -X POST https://example.com/api")],
    ["bash 里的 wget", bash("wget https://example.com/a.zip")],
    ["bash 里的 git push", bash("git push")],
    ["bash 里的 npm install", bash("npm install")],
    ["bash 里的 ssh", bash("ssh me@host ls")],
    ["bash 里的 npx 下载包", bash("npx cowsay hi")],
  ] as const;

  for (const [name, c] of NETWORKED) {
    it(`${name}：硬拒绝，提示联网请发起任务`, () => {
      for (const agent of [offline, secretary()]) {
        for (const scene of [inChat, inTask]) {
          const j = judgeToolCall(withTools(scene(agent, c)));
          expect(j.hardRefusal).toContain("network_off");
          expect(j.findings.some((f) => f.kind === "hard_refusal" && f.id === "network_off")).toBe(true);
          expect(j.explanation).toMatch(/联网请发起任务/);
        }
      }
    });
  }

  it("秘书不论传入什么工具包，一律按关着判", () => {
    const j = judgeToolCall(withTools(inChat(secretary({ toolkit: { bash: true, network: true } }), call("mcp_web_search", { query: "x" }))));
    expect(j.hardRefusal).toContain("network_off");
    expect(j.explanation).toMatch(/秘书不能联网/);
  });

  it("要跑的脚本用到联网的库或函数（调用方扫描后作为环境事实传入）：拒绝", () => {
    const facts = { scripts: { [`${P.scratch}\\fetch.py`]: { networkUsage: ["requests.get"] } } };
    const j = judgeToolCall(inChat(secretary(), bash("python fetch.py"), { facts }));
    expect(j.hardRefusal).toContain("network_off");
    expect(j.explanation).toMatch(/requests\.get/);
    expect(j.explanation).toMatch(/联网请发起任务/);

    const clean = { scripts: { [`${P.scratch}\\calc.py`]: { networkUsage: [] } } };
    expect(judgeToolCall(inChat(secretary(), bash("python calc.py"), { facts: clean })).disposition).toBe("log_only");

    const nodeFacts = { scripts: { [`${P.workDir}\\sync.js`]: { networkUsage: ["fetch"] } } };
    expect(judgeToolCall(inTask(offline, bash("node sync.js"), { facts: nodeFacts })).hardRefusal).toEqual(["network_off"]);
  });

  it("不联网的工具和命令照常判定", () => {
    const clean = { scripts: { [`${P.scratch}\\calc.py`]: { networkUsage: [] } } };
    const j = judgeToolCall(inChat(secretary(), bash("python calc.py && cat out.txt"), { facts: clean }));
    expect([j.disposition, j.pullBack, j.hardRefusal]).toEqual(["log_only", null, null]);
    expect(judgeToolCall(inTask(offline, bash("npm test"))).disposition).toBe("log_only");
  });

  // 没扫到不等于没联网（和 rule-steps.ts 的 sends 一样算"判断不了"）：要跑的脚本判定时还不存在（同一条命令里先写再跑）、
  // 读不了或看不出是哪个，按规则退回，让 agent 先用 write 写好脚本再跑
  const UNCHECKED = [
    ["同一条命令里先写再跑", "echo 'print(1)' > quick.py && python quick.py"],
    ["here-doc 写好再跑", "cat > fetch.js <<'EOF'\nfetch('https://example.com')\nEOF\nnode fetch.js"],
    ["要跑的脚本没扫到（不存在或读不了）", "python calc.py"],
    ["直接执行的脚本没扫到", "./build.sh"],
  ] as const;

  for (const [name, command] of UNCHECKED) {
    it(`${name}：按规则退回，说明先用 write 写好脚本再运行`, () => {
      for (const agent of [offline, secretary()]) {
        for (const scene of [inChat, inTask]) {
          const j = judgeToolCall(scene(agent, bash(command)));
          expect({ command, hardRefusal: j.hardRefusal, pullBack: j.pullBack }).toEqual({ command, hardRefusal: null, pullBack: ["script_not_checked"] });
          expect(j.explanation).toContain("先用 write 写好脚本再运行，以便执行前检查");
        }
      }
    });
  }

  it("联网开关开着时没扫到的脚本照常判定（不退回）", () => {
    const j = judgeToolCall(inTask(maintainer(), bash("echo 'print(1)' > quick.py && python quick.py")));
    expect([j.pullBack, j.hardRefusal]).toEqual([null, null]);
  });
});

describe("联网开关开着", () => {
  const online = maintainer();

  it("只读的 GET 不落入任何关注类别", () => {
    for (const command of ["curl https://example.com", "curl -I https://example.com", "wget https://example.com/a.zip", "git fetch", "ping example.com"]) {
      const j = judgeToolCall(inTask(online, bash(command)));
      expect({ command, categories: j.categories }).toEqual({ command, categories: [] });
      expect(j.disposition).toBe("log_only");
    }
    expect(judgeToolCall(withTools(inTask(online, call("mcp_web_search", { query: "x" })))).disposition).toBe("log_only");
  });

  it("非 GET 的请求落入'以我的名义对外发送或发布'", () => {
    for (const command of ["curl -X POST https://example.com", "curl -d 'a=1' https://example.com", "wget --post-data 'a=1' https://example.com", "http PUT example.com a=1"]) {
      const j = judgeToolCall(inChat(online, bash(command)));
      expect({ command, categories: j.categories }).toEqual({ command, categories: ["external_send"] });
      expect(j.disposition).toBe("ask_first");
    }
  });

  it("用到联网库的脚本照常跑", () => {
    const facts = { scripts: { [`${P.workDir}\\sync.js`]: { networkUsage: ["fetch"] } } };
    expect(judgeToolCall(inTask(online, bash("node sync.js"), { facts })).disposition).toBe("log_only");
  });
});
