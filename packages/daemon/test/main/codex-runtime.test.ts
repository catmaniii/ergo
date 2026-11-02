// 主切面：Codex 插件。真的守护进程走组合根和插件清单；清单里的 Codex 插件换成同名的、子进程接假 app-server 的那个（helpers/fake-codex.ts：运行时的 id、名字、能力清单、
// 适配子进程、钩子、MCP 中转都是真的，只有 app-server 是按 faux 剧本走的假的，不启动真的 codex、不花额度）：
// - GET /api/runtimes 里有 Codex：插件名、能力清单照实写；
// - 运行时是 Codex 的任务：负责人经 Codex 的子进程跑完一轮、任务自动完成；会话频道里的事件（网页显示的就是它们）和同一个剧本由 pi 跑出来的一样；用量进账本；
// - 工具调用：Codex 自带的（命令）过真的守卫、进会话、判定写在记录上；二狗的工具经中转走守护进程；
// - 额度用完：这一轮出错，任务转等我、写明；
// - 插件在配置里停用着：任务转等我；本机没装（missing）：运行时灰着、写明怎么装，任务转等我，别的不受影响。
import fs from "node:fs";
import path from "node:path";
import { type CardEventPayload, CHANNELS, EVENT_TYPES, maintainerChannel, type MessageEventPayload, runtimeBillingOf, type Task } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CODEX_PLUGIN, CODEX_RUNTIME_ID } from "../../src/codex/api.ts";
import { createCodexPlugin } from "../../src/codex/plugin.ts";
import { CODEX_CAPABILITIES } from "../../src/codex/runtime.ts";
import { codexSettings } from "../../src/codex/settings.ts";
import { LEDGER_CHANNEL, TOKEN_USAGE_EVENT, type TokenUsagePayload } from "../../src/ledger/entry.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { FAKE_CODEX_CHILD, fakeCodexPlugin } from "../helpers/fake-codex.ts";
import { FAKE_CODEX_STORE, FakeCodexStore } from "../helpers/fake-codex-app-server.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { runtimesApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";

const taskNow = (td: TestDaemon, taskId: string): Task => td.daemon.tasks.get(taskId)!;
const waitState = (td: TestDaemon, taskId: string, state: Task["state"]) =>
  waitUntil(() => taskNow(td, taskId).state === state, { timeoutMs: 30_000, describe: () => `等 ${taskId} ${state}，现在：${JSON.stringify(taskNow(td, taskId))}` });

/** 从现在起拉起了哪些 agent、各用哪个运行时 */
function runtimeSpawns(td: TestDaemon): () => Array<{ agentId: string; runtime: string }> {
  const seen: Array<{ agentId: string; runtime: string }> = [];
  const spawn = td.daemon.agents.spawn.bind(td.daemon.agents);
  td.daemon.agents.spawn = (request) => {
    seen.push({ agentId: request.agentId, runtime: request.runtime ?? "pi" });
    return spawn(request);
  };
  return () => [...seen];
}

/** 会话频道里的事件，去掉 id、时间这些每次都不一样的 */
function channelShape(td: TestDaemon, task: Task): string[] {
  return td.daemon.store.read(maintainerChannel(task.maintainerId), 0).map((event) => {
    if (event.type !== EVENT_TYPES.message) return event.type;
    const { message } = event.payload as MessageEventPayload;
    const parts = message.parts.map((part) => `${part.type}=${"text" in part ? part.text : ""}`).join(" | ");
    return message.speaker === "agent" ? `message:agent:${parts}` : `message:${message.speaker}`;
  });
}

const toolCalls = (td: TestDaemon, task: Task) =>
  td.daemon.store
    .read(maintainerChannel(task.maintainerId), 0, EVENT_TYPES.message)
    .flatMap((event) => (event.payload as MessageEventPayload).message.parts)
    .filter((part) => part.type === "tool_call");

const SCRIPT: FauxStep[] = [{ kind: "reply", thinking: "先看看下载目录里都有什么。", text: "下载目录按月份整理好了。", usage: { cacheHit: 0, cacheMiss: 300, output: 40 } }];

/** 这个任务的负责人的会话目录里假 Codex 的记录 */
function storeOf(td: TestDaemon, task: Task): FakeCodexStore {
  const found = fs
    .readdirSync(td.dataDir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name === FAKE_CODEX_STORE)
    .map((d) => path.join(d.parentPath, d.name))
    .find((file) => file.includes(task.maintainerId));
  if (!found) throw new Error(`没找到 ${task.maintainerId} 的假 Codex 记录`);
  return new FakeCodexStore(found);
}

describe("Codex 插件（假 app-server）", () => {
  it("GET /api/runtimes 里有 Codex：插件登记的，能力清单照实写，模型还没报回时是空的", async () => {
    const td = await startTestDaemon({ extraPlugins: [fakeCodexPlugin] });
    const view = (await runtimesApi.view(td.url)).body;
    expect(view.runtimes.map((r) => r.id)).toContain(CODEX_RUNTIME_ID);
    expect(view.runtimes.find((r) => r.id === CODEX_RUNTIME_ID)).toEqual({
      id: CODEX_RUNTIME_ID,
      title: "Codex",
      plugin: CODEX_PLUGIN,
      available: true,
      capabilities: { ...CODEX_CAPABILITIES },
      models: [],
      settings: codexSettings(),
      workFolder: {},
    });
  });

  it("运行时是 Codex 的任务：负责人经 Codex 的子进程跑完一轮、任务自动完成；会话里的事件和 pi 跑同一个剧本时一样；用量进账本", async () => {
    const codex = await startTestDaemon({ extraPlugins: [fakeCodexPlugin], maintainer: SCRIPT });
    const spawns = runtimeSpawns(codex);
    const task = codex.daemon.tasks.delegate({ title: "整理下载目录", instructions: "把下载目录按月份分好", runtime: CODEX_RUNTIME_ID });
    expect(task.runtime).toBe(CODEX_RUNTIME_ID);
    await waitState(codex, task.id, "done");
    expect(spawns()).toEqual([{ agentId: task.maintainerId, runtime: CODEX_RUNTIME_ID }]);

    const pi = await startTestDaemon({ maintainer: SCRIPT });
    const piTask = pi.daemon.tasks.delegate({ title: "整理下载目录", instructions: "把下载目录按月份分好" });
    await waitState(pi, piTask.id, "done");

    const shape = channelShape(codex, task);
    expect(shape).toContain("message:agent:reasoning=先看看下载目录里都有什么。 | text=下载目录按月份整理好了。");
    expect(shape).toEqual(channelShape(pi, piTask));
    const usage = codex.daemon.store.read(LEDGER_CHANNEL, 0, TOKEN_USAGE_EVENT).map((e) => e.payload as TokenUsagePayload);
    const own = usage.filter((u) => u.agentId === task.maintainerId);
    expect(own).toHaveLength(1);
    // 账本的键是"provider/模型"：子进程报的 provider 按登录方式写（契约测试核对），认得出是哪种计费
    expect(runtimeBillingOf("codex-subscription/gpt-5")).toBe("subscription");
    expect(runtimeBillingOf("codex-api-key/gpt-5")).toBe("metered");
    expect(runtimeBillingOf("deepseek/deepseek-chat")).toBeUndefined();
    // 协议对得上
    expect(storeOf(codex, task).violations).toEqual([]);
  }, 90_000);

  it("命令过真的守卫、进会话：放行的执行了；要问用户的先出审批卡，等着时没执行，用户拒绝就不执行、接着往下做", async () => {
    // 不带 -Recurse：删项目外的文件要问用户。带了就和 rm -rf 一样判永不，不出审批卡
    const dangerous = "Remove-Item -Force C:\\Windows\\System32\\x.dll";
    const script: FauxStep[] = [
      { kind: "reply", text: "先看看。", toolCalls: [{ name: "bash", arguments: { command: "git status" } }] },
      { kind: "reply", text: "再试试删。", toolCalls: [{ name: "bash", arguments: { command: dangerous } }] },
      { kind: "reply", text: "好了。" },
    ];
    const codex = await startTestDaemon({ extraPlugins: [fakeCodexPlugin], maintainer: script });
    const frontend = await TestFrontend.connect(codex.url);
    await frontend.subscribe({ [CHANNELS.cards]: 0 });
    const task = codex.daemon.tasks.delegate({ title: "看看状态", instructions: "看看 git 状态", runtime: CODEX_RUNTIME_ID });
    const pending = () => frontend.events({ channel: CHANNELS.cards, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
    await waitUntil(() => pending().length > 0, { timeoutMs: 30_000, describe: () => JSON.stringify(channelShape(codex, task)) });
    expect(toolCalls(codex, task)[0]).toMatchObject({ tool: "bash", argsSummary: "git status", outcome: "done", disposition: "do" });
    const beforeDecision = storeOf(codex, task).executed.map((e) => (e.input as { command: string }).command);
    expect(beforeDecision).toEqual(["git status"]);

    const card = pending()[0]!;
    await frontend.cardAction({ cardId: card.id, action: "deny", expectedVersion: card.version, note: "别删" });
    await waitState(codex, task.id, "done");
    const store = storeOf(codex, task);
    expect(store.violations).toEqual([]);
    expect(store.executed.map((e) => (e.input as { command: string }).command)).toEqual(["git status"]);
    // 摘要是给守卫看的那句：反斜杠换成了正斜杠（child/translator.ts 的 commandForGuard），不换的话守卫认不出路径
    const denied = toolCalls(codex, task).find((c) => c.tool === "bash" && c.argsSummary === dangerous.replaceAll("\\", "/"));
    expect(denied).toMatchObject({ outcome: "denied" });
  }, 90_000);

  it("二狗的工具经中转走守护进程：过守卫、在守护进程里执行，会话里的名字是二狗的", async () => {
    const script: FauxStep[] = [{ kind: "reply", text: "看一眼改动。", toolCalls: [{ name: "git_status_diff", arguments: {} }] }, { kind: "reply", text: "好了。" }];
    const codex = await startTestDaemon({ extraPlugins: [fakeCodexPlugin], maintainer: script });
    const task = codex.daemon.tasks.delegate({ title: "看改动", instructions: "看改动", runtime: CODEX_RUNTIME_ID });
    await waitState(codex, task.id, "done");
    expect(toolCalls(codex, task)[0]).toMatchObject({ tool: "git_status_diff" });
    const store = storeOf(codex, task);
    expect(store.violations).toEqual([]);
    // 不是 Codex 自己"执行"的，是守护进程做的
    expect(store.executed).toEqual([]);
  }, 90_000);

  it("额度用完：这一轮出错，任务转等我、写明额度用完", async () => {
    const td = await startTestDaemon({ extraPlugins: [fakeCodexPlugin], maintainer: [{ kind: "context_overflow" }] });
    const task = td.daemon.tasks.delegate({ title: "整理下载目录", instructions: "把下载目录按月份分好", runtime: CODEX_RUNTIME_ID });
    await waitState(td, task.id, "waiting_for_user");
    expect(taskNow(td, task.id).waitNote).toContain("额度用完");
  }, 60_000);

  it("插件在配置里停用着：运行时是 Codex 的任务转等我，写明 Codex插件没启用", async () => {
    const td = await startTestDaemon({ extraPlugins: [fakeCodexPlugin], config: { plugins: { disabled: [CODEX_PLUGIN] } } });
    const task = td.daemon.tasks.delegate({ title: "整理下载目录", instructions: "把下载目录按月份分好", runtime: CODEX_RUNTIME_ID });
    await waitState(td, task.id, "waiting_for_user");
    expect(taskNow(td, task.id)).toMatchObject({ waitReason: "runtime_off", waitNote: "Codex插件没启用" });
    const view = (await runtimesApi.view(td.url)).body;
    expect(view.runtimes.find((r) => r.id === CODEX_RUNTIME_ID)).toMatchObject({ available: false, unavailable: "Codex插件没启用" });
    expect(view.runtimes.find((r) => r.id === CODEX_RUNTIME_ID)).not.toHaveProperty("missing");
  }, 60_000);

  it("本机没装（missing）：运行时写明缺什么、怎么装、怎么登录，任务转等我；别的功能不受影响（pi 的任务照常）", async () => {
    const how = "没装 Codex，用 npm i -g @openai/codex 安装，再 codex login 登录。";
    const plugin = createCodexPlugin({ entry: FAKE_CODEX_CHILD, missing: () => how });
    const td = await startTestDaemon({ extraPlugins: [plugin], maintainer: SCRIPT });
    const view = (await runtimesApi.view(td.url)).body;
    expect(view.runtimes.find((r) => r.id === CODEX_RUNTIME_ID)).toMatchObject({ available: false, unavailable: how, missing: true });
    const task = td.daemon.tasks.delegate({ title: "整理下载目录", instructions: "把下载目录按月份分好", runtime: CODEX_RUNTIME_ID });
    await waitState(td, task.id, "waiting_for_user");
    expect(taskNow(td, task.id)).toMatchObject({ waitReason: "runtime_off", waitNote: how });
    const piTask = td.daemon.tasks.delegate({ title: "另一件事", instructions: "别的事" });
    await waitState(td, piTask.id, "done");
    // 没装不算出了问题：健康探针不降级，只是列在没装上的里面
    const health = (await (await fetch(`${td.url}/healthz`)).json()) as { status: string; plugins: { skipped: Array<{ plugin: string }> } };
    expect(health.status).toBe("ok");
    expect(health.plugins.skipped.map((s) => s.plugin)).toEqual([CODEX_PLUGIN]);
  }, 90_000);
});
