// pi 契约测试：联网开关关着时的会话装配（规格第 7 节"不能联网"的尽力而为、第 3 节"孙进程环境里剥掉所有密钥"）。
// 联网开关关着（默认）时，二狗把 pi 的 bash 工具换成同名的一份，在起进程前往环境里加一组无效的代理地址，
// 让常见的联网方式（curl、Python 的 requests、Node 的 fetch）连不上；子进程自己的环境不受影响。
// 也不给首次使用要去网上下载外部程序的 pi 工具（grep 下载 rg、find 下载 fd）。
// 模型 key 经 stdin 交给子进程，不进环境变量，所以 bash 里也看不到。
import { describe, expect, it } from "vitest";
import type { AgentReport } from "../../src/runtime/index.ts";
import { OFFLINE_PROXY } from "../../src/process/child-env.ts";
import { fauxModel, spawnTestAgent, startTestDaemon } from "../helpers/daemon.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const KEY = "sk-contract-shell-env-0123456789abcdef";
const PRINT_ENV = 'echo "proxy=$HTTPS_PROXY|$HTTP_PROXY|$ALL_PROXY node=$NODE_USE_ENV_PROXY"; env';

async function runEnv(network: boolean | undefined) {
  const { daemon } = await startTestDaemon();
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
    expect(out).toContain(`proxy=${OFFLINE_PROXY}|${OFFLINE_PROXY}|${OFFLINE_PROXY} node=1`);
    expect(out).not.toContain(KEY);
  });

  it("联网开关开着：不加代理", async () => {
    const out = await runEnv(true);
    expect(out).toContain("proxy=|| node=");
    expect(out).not.toContain(KEY);
  });
});

describe("pi 契约：联网开关关着时不给首次使用要下载的工具", () => {
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

  it("关着（默认）：装配时去掉 grep、find，其余照给", async () => {
    expect(await loadedTools(undefined)).toEqual(["read", "ls", "bash"]);
  });

  it("开着：照白名单给", async () => {
    expect(await loadedTools(true)).toEqual(["read", "ls", "grep", "find", "bash"]);
  });
});
