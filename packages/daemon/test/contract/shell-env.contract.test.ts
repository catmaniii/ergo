// pi 契约测试：bash 起的进程的环境和装配给 pi 的工具（规格第 7 节、第 3 节"孙进程环境里剥掉所有密钥"）。
// 联网开关关着时，二狗把 pi 的 bash 工具换成同名的一份，在起进程前往环境里加一组无效的代理地址，
// 让常见的联网方式（curl、Python 的 requests、Node 的 fetch）连不上；子进程自己的环境不受影响。
// 70 号票：找到了浏览器就把它的路径（AGENT_BROWSER_EXECUTABLE_PATH）放进 bash 的环境，agent-browser 靠它找浏览器（测试里是假的路径）；
// grep、find 不再跟着联网开关去掉——pi 第一次用它们时找 rg、fd，找不到也不下载（子进程固定带 PI_OFFLINE=1）。
// 模型 key 经 stdin 交给子进程，不进环境变量，所以 bash 里也看不到。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentReport } from "../../src/runtime/index.ts";
import { OFFLINE_PROXY } from "../../src/process/child-env.ts";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const KEY = "sk-contract-shell-env-0123456789abcdef";
const PRINT_ENV = 'echo "proxy=$HTTPS_PROXY|$HTTP_PROXY|$ALL_PROXY node=$NODE_USE_ENV_PROXY browser=$AGENT_BROWSER_EXECUTABLE_PATH"; env';
/** 假的浏览器路径（不存在也没关系：只看它有没有进环境） */
const FAKE_BROWSER = "D:\\假的浏览器\\chrome-131\\chrome.exe";

async function runEnv(network: boolean | undefined, browserPath?: string) {
  const { daemon } = await startTestDaemon(browserPath === undefined ? {} : { browserPath });
  const { agent, log } = spawnTestAgent(daemon, {
    agentId: `contract-shell-env-${String(network)}`,
    cwd: makeTempDir("ergou-cwd-"),
    model: fauxModel([{ kind: "reply", toolCalls: [{ name: "bash", arguments: { command: PRINT_ENV } }] }, { kind: "reply", text: "看完了" }]),
    tools: ["bash"],
    credentials: { deepseek: KEY },
    ...(network === undefined ? {} : { network }),
  });
  await log.next("ready");
  agent.send({ type: "user_input", inputId: "in-1", text: "看看环境变量" });
  const end = await log.next("tool_call_end");
  expect(end.isError).toBe(false);
  await log.next("turn_end");
  return end.resultText;
}

describe("pi 契约：bash 起的进程的环境", () => {
  it("联网开关关着（默认）：代理地址是无效值，Node 也按环境变量走代理；看不到模型 key", async () => {
    const out = await runEnv(undefined);
    expect(out).toContain(`proxy=${OFFLINE_PROXY}|${OFFLINE_PROXY}|${OFFLINE_PROXY} node=1 browser=`);
    expect(out).not.toContain(KEY);
  });

  it("联网开关开着：不加代理", async () => {
    const out = await runEnv(true);
    expect(out).toContain("proxy=|| node= browser=");
    expect(out).not.toContain(KEY);
  });

  it("找到了浏览器（70 号票）：路径放进 AGENT_BROWSER_EXECUTABLE_PATH，联网开关开着、关着都放", async () => {
    expect(await runEnv(true, FAKE_BROWSER)).toContain(`proxy=|| node= browser=${FAKE_BROWSER}`);
    expect(await runEnv(false, FAKE_BROWSER)).toContain(`node=1 browser=${FAKE_BROWSER}`);
  });
});

/** 按联网开关拉起一个 agent，看它装配出的 pi 工具 */
async function loadedTools(network: boolean | undefined): Promise<string[]> {
  const { daemon } = await startTestDaemon();
  const { log } = spawnTestAgent(daemon, {
    agentId: `contract-offline-tools-${String(network)}`,
    cwd: makeTempDir("ergou-cwd-"),
    model: fauxModel([{ kind: "reply", text: "好" }]),
    tools: ["read", "ls", "grep", "find", "bash"],
    ...(network === undefined ? {} : { network }),
  });
  const ready = (await log.next("ready")) as Extract<AgentReport, { type: "ready" }>;
  return ready.loaded.tools;
}

describe("pi 契约：grep、find 照给（70 号票）", () => {
  it("联网开关关着、开着都照白名单给", async () => {
    expect(await loadedTools(undefined)).toEqual(["read", "ls", "grep", "find", "bash"]);
    expect(await loadedTools(true)).toEqual(["read", "ls", "grep", "find", "bash"]);
  });

  it("没有 rg、fd 时不下载：pi 的 bin 目录（用户主目录下 .pi/agent/bin，测试里是临时目录）里什么都没有", async () => {
    const { daemon, homeDir } = await startTestDaemon();
    const cwd = makeTempDir("ergou-cwd-");
    fs.writeFileSync(path.join(cwd, "a.txt"), "hello\n");
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-no-download",
      cwd,
      model: fauxModel([
        { kind: "reply", toolCalls: [{ name: "grep", arguments: { pattern: "hello" } }] },
        { kind: "reply", toolCalls: [{ name: "find", arguments: { pattern: "*.txt" } }] },
        { kind: "reply", text: "好" },
      ]),
      tools: ["grep", "find"],
      network: true,
    });
    await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "搜一下" });
    for (const tool of ["grep", "find"]) {
      const end = await log.next("tool_call_end");
      // 本机 PATH 上有 rg、fd 时照常用它们；没有时出错，说没有、也没下载
      const fine = !end.isError || /not available and could not be downloaded/.test(end.resultText);
      expect({ tool, fine, text: end.resultText }).toMatchObject({ tool, fine: true });
    }
    await log.next("turn_end");
    expect(fs.existsSync(path.join(homeDir, ".pi", "agent", "bin"))).toBe(false);
  });
});
