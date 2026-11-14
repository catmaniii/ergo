// pi 契约测试：bash 起的进程的环境和装配给 pi 的工具（孙进程环境里剥掉所有密钥）。
// 联网开关关着时，二狗把 pi 的 bash 工具换成同名的一份，在起进程前往环境里加一组无效的代理地址，
// 让常见的联网方式（curl、Python 的 requests、Node 的 fetch）连不上；子进程自己的环境不受影响。
// 466：不再往 bash 的环境里放 AGENT_BROWSER_EXECUTABLE_PATH；找到了 ego 浏览器，给 agent 的那个目录在 agent 子进程 PATH 的最前面，
// bash 里直接敲 ego-browser 就能跑——Windows 上找到的是二狗写在缓存区的薄 ego-browser（web/ego-shim.ts），它再把参数交给真的
// （测试里"真的"由 node.exe 充当，只跑 --version，不碰真的 ego lite）；
// grep、find 不再跟着联网开关去掉——pi 第一次用它们时找 rg、fd，找不到也不下载（子进程固定带 PI_OFFLINE=1）。
// 模型 key 经 stdin 交给子进程，不进环境变量，所以 bash 里也看不到。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentReport } from "../../src/runtime/index.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { OFFLINE_PROXY } from "../../src/process/child-env.ts";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

const KEY = fakeSecret("sk-", "contract-shell-env-0123456789abcdef");
const PRINT_ENV = 'echo "proxy=$HTTPS_PROXY|$HTTP_PROXY|$ALL_PROXY node=$NODE_USE_ENV_PROXY browser=$AGENT_BROWSER_EXECUTABLE_PATH"; env';
/** 假的浏览器路径（不存在也没关系：只看它进不进环境） */
const FAKE_BROWSER = "D:\\假的浏览器\\chrome-131\\chrome.exe";

async function runEnv(network: boolean | undefined, browserPath?: string, egoBrowser?: string, command = PRINT_ENV) {
  return (await runEnvIn(network, browserPath, egoBrowser, command)).out;
}

/** 同 runEnv，也回这次的数据目录 */
async function runEnvIn(network: boolean | undefined, browserPath?: string, egoBrowser?: string, command = PRINT_ENV) {
  const { daemon, dataDir } = await startTestDaemon({ ...(browserPath === undefined ? {} : { browserPath }), ...(egoBrowser === undefined ? {} : { egoBrowser }) });
  const { agent, log } = spawnTestAgent(daemon, {
    agentId: `contract-shell-env-${String(network)}`,
    cwd: makeTempDir("ergo-cwd-"),
    model: fauxModel([{ kind: "reply", toolCalls: [{ name: "bash", arguments: { command } }] }, { kind: "reply", text: "看完了" }]),
    tools: ["bash"],
    credentials: { deepseek: KEY },
    ...(network === undefined ? {} : { network }),
  });
  await log.next("ready");
  agent.send({ type: "user_input", inputId: "in-1", text: "看看环境变量" });
  const end = await log.next("tool_call_end");
  expect(end.isError).toBe(false);
  await log.next("turn_end");
  return { out: end.resultText, dataDir };
}

describe("pi 契约：bash 起的进程的环境", () => {
  it("联网开关关着（默认）：代理地址是无效值，Node 也按环境变量走代理；看不到模型 key", async () => {
    const out = await runEnv(undefined);
    expect(out).toContain(`proxy=${OFFLINE_PROXY}|${OFFLINE_PROXY}|${OFFLINE_PROXY} node=1 browser=`);
    expect(out).not.toContain(KEY);
  });

  it("联网开关关着也连得上本机：NO_PROXY 写着本机；开着关着 Python 都用 UTF-8", async () => {
    const closed = await runEnv(undefined);
    expect(closed).toContain("NO_PROXY=127.0.0.1,localhost,::1");
    expect(closed).toContain("PYTHONUTF8=1");
    expect(await runEnv(true)).toContain("PYTHONUTF8=1");
  });

  it("联网开关开着：不加代理", async () => {
    const out = await runEnv(true);
    expect(out).toContain("proxy=|| node= browser=");
    expect(out).not.toContain(KEY);
  });

  it("466：联网搜索的浏览器找到了也不再放进 AGENT_BROWSER_EXECUTABLE_PATH；找到了 ego 浏览器：bash 里直接能跑 ego-browser（给 agent 的目录在 PATH 最前面），联网开关开着、关着都是", async () => {
    expect(await runEnv(true, FAKE_BROWSER)).toContain("proxy=|| node= browser=\n");
    const command = 'ego-browser --version; echo "where=$(cygpath -w "$(command -v ego-browser)")"; echo "ab=$(env | grep -c "^AGENT_BROWSER_")"';
    for (const network of [true, false]) {
      // "真的 ego-browser"由 node.exe 充当：--version 打出 Node 的版本（只看版本的不用 ego lite 开着，不碰真的 ego lite）
      const { out, dataDir } = await runEnvIn(network, FAKE_BROWSER, process.execPath, command);
      expect(out).toContain(process.version);
      // Git Bash 自己会在 PATH 前面加它的 mingw64、usr/bin；ego-browser 找到的是放进去的那个目录里的：
      // Windows 上是缓存区里二狗写的 shim，别的系统是 ego-browser 自己的目录
      const where = /where=(.+)/.exec(out)![1]!.trim();
      const expected = process.platform === "win32" ? dataDirLayout(dataDir).egoBrowserShim : path.dirname(process.execPath);
      expect(fs.realpathSync.native(path.dirname(where))).toBe(fs.realpathSync.native(expected));
      expect(out).toContain("ab=0");
    }
    // 没找到 ego：bash 里没有这个命令
    expect(await runEnv(true, undefined, undefined, "command -v ego-browser || echo 没有")).toContain("没有");
  });
});

describe("pi 契约：bash 的临时目录", () => {
  it("每条命令前面 export TMPDIR、TEMP、TMP 指到工作目录里的 .ergo-tmp：mktemp、Node 都用它；bash 进程本身的 TEMP 不动，/tmp 不跟着改", async () => {
    const { daemon } = await startTestDaemon();
    const cwd = makeTempDir("ergo-cwd-");
    const tempDir = path.join(cwd, ".ergo-tmp");
    const command = [
      'echo "tmpdir=$TMPDIR|temp=$TEMP|tmp=$TMP"',
      'f=$(mktemp) && echo "mktemp=$f"',
      `node -e "console.log('node=' + require('os').tmpdir())"`,
      'echo "slash-tmp=$(cygpath -w /tmp)"',
    ].join("; ");
    const { agent, log } = spawnTestAgent(daemon, {
      agentId: "contract-shell-temp",
      cwd,
      model: fauxModel([{ kind: "reply", toolCalls: [{ name: "bash", arguments: { command } }] }, { kind: "reply", text: "看完了" }]),
      tools: ["bash"],
      network: true,
      tempDir,
    });
    await log.next("ready");
    // 拉起时建好、写上 .gitignore
    expect(fs.readFileSync(path.join(tempDir, ".gitignore"), "utf8")).toContain("*");
    agent.send({ type: "user_input", inputId: "in-1", text: "看看临时目录" });
    const end = await log.next("tool_call_end");
    expect(end.isError).toBe(false);
    await log.next("turn_end");
    const out = end.resultText;
    expect(out).toContain(`tmpdir=${tempDir}|temp=${tempDir}|tmp=${tempDir}`);
    expect(out).toContain(`node=${tempDir}`);
    const made = /mktemp=(.+)/.exec(out)![1]!.trim();
    expect(fs.realpathSync.native(path.dirname(made))).toBe(fs.realpathSync.native(tempDir));
    // /tmp 照旧是系统的临时目录（Git Bash 的挂载表大家共用，不跟着这条命令的 TEMP 走）
    const slashTmp = /slash-tmp=(.+)/.exec(out)![1]!.trim();
    expect(fs.realpathSync.native(slashTmp)).not.toBe(fs.realpathSync.native(tempDir));
  });
});

/** 按联网开关拉起一个 agent，看它装配出的 pi 工具 */
async function loadedTools(network: boolean | undefined): Promise<string[]> {
  const { daemon } = await startTestDaemon();
  const { log } = spawnTestAgent(daemon, {
    agentId: `contract-offline-tools-${String(network)}`,
    cwd: makeTempDir("ergo-cwd-"),
    model: fauxModel([{ kind: "reply", text: "好" }]),
    tools: ["read", "ls", "grep", "find", "bash"],
    ...(network === undefined ? {} : { network }),
  });
  const ready = (await log.next("ready")) as Extract<AgentReport, { type: "ready" }>;
  return ready.loaded.tools;
}

describe("pi 契约：grep、find 照给", () => {
  it("联网开关关着、开着都照白名单给", async () => {
    expect(await loadedTools(undefined)).toEqual(["read", "ls", "grep", "find", "bash"]);
    expect(await loadedTools(true)).toEqual(["read", "ls", "grep", "find", "bash"]);
  });

  it("没有 rg、fd 时不下载：pi 的 bin 目录（用户主目录下 .pi/agent/bin，测试里是临时目录）里什么都没有", async () => {
    const { daemon, homeDir } = await startTestDaemon();
    const cwd = makeTempDir("ergo-cwd-");
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
