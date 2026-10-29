// 主切面：新建任务选运行时、⚙ 按运行时、斜杠命令转交、中途换运行时（289 号票，Claude Code 接入一期之四）。真的守护进程走组合根和插件清单；
// 清单里的 Claude Code 插件经 extraPlugins 换成同名的、子进程接假 SDK 的那个（helpers/fake-claude-code.ts：运行时、适配子进程都是真的，
// 只有 SDK 是按 faux 剧本吐事件的假的，不启动真的 claude、不花额度）：
// - 点"发起任务"选 Claude Code（start_task 的 runtime）：任务记着运行时，维护者经 Claude Code 的子进程跑；输入框里打的 /compact
//   原样交给 Claude Code（不加时间标记、不带消息 id 那一行）；输入框的候选里有 Claude Code 报的命令；没选的 pi 任务照旧（/compact 照常加时间标记）；
// - 秘书交给后台时带上运行时（delegate_task 的 runtime）：建出的任务用它；写了没启用的运行时，工具回错、不建任务；
// - ⚙：Claude Code 的维护者按能力清单多"权限模式""思考档位"，模型列表是 Claude Code 报的；选的值交给子进程（下一轮的 query 选项里有）；
//   不认得的值回 400；
// - 中途换运行时（pi → Claude Code）：原来的 pi 写交接摘要，Claude Code 新开会话，摘要跟着下一条输入交过去；会话里记一条"已换成"；
//   任务记着新的运行时。
import { CHANNELS, EVENT_TYPES, HTTP_PATHS, maintainerChannel, type MessageEventPayload, METHODS, type SlashCommandList, type Task } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_RUNTIME_ID } from "../../src/claude-code/api.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { fakeSdkClaudeCodePlugin } from "../helpers/fake-claude-code.ts";
import type { FakeClaudeEcho } from "../helpers/fake-claude-sdk.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { agentSettingsApi, requestJson, runtimesApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { cardWhere, messagesOf, ok, textOf as taskTextOf } from "../helpers/task-flow.ts";

const echo: FauxStep = { kind: "echo_context" };
const taskNow = (td: TestDaemon, taskId: string): Task => td.daemon.tasks.get(taskId)!;
const waitState = (td: TestDaemon, taskId: string, state: Task["state"]) =>
  waitUntil(() => taskNow(td, taskId).state === state, { timeoutMs: 30_000, describe: () => `等 ${taskId} ${state}，现在：${JSON.stringify(taskNow(td, taskId))}` });

/** 从现在起拉起了哪些 agent、各用哪个运行时（测试接缝，同 agent-runtimes.test.ts） */
function runtimeSpawns(td: TestDaemon): () => Array<{ agentId: string; runtime: string }> {
  const seen: Array<{ agentId: string; runtime: string }> = [];
  const spawn = td.daemon.agents.spawn.bind(td.daemon.agents);
  td.daemon.agents.spawn = (request) => {
    seen.push({ agentId: request.agentId, runtime: request.runtime ?? "pi" });
    return spawn(request);
  };
  return () => [...seen];
}

const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
/** 会话里某一方说的话 */
const said = (td: TestDaemon, channel: string, speaker: "agent" | "system") =>
  td.daemon.store
    .read(channel, 0, EVENT_TYPES.message)
    .map((e) => e.payload as MessageEventPayload)
    .filter((p) => p.message.speaker === speaker)
    .map(textOf);
async function nthAgentReply(td: TestDaemon, channel: string, n: number): Promise<string> {
  await waitUntil(() => said(td, channel, "agent").length >= n, { timeoutMs: 30_000, describe: () => `等 ${channel} 的第 ${n} 条回复：${JSON.stringify(said(td, channel, "agent"))}` });
  return said(td, channel, "agent")[n - 1]!;
}

const slashCommands = (url: string, conversation: string) => requestJson<SlashCommandList & { message?: string }>(url, HTTP_PATHS.slashCommands(conversation));

describe("新建任务选运行时、斜杠命令转交（289 号票）", () => {
  it("点发起任务选 Claude Code：维护者用它；输入框里的 /compact 原样交给 Claude Code，候选里有它报的命令；没选的 pi 任务照旧", async () => {
    // 每个维护者第一次拉起回一句做完，之后（任务做完接着说）把看到的回显出来
    const td = await startTestDaemon({ extraPlugins: [fakeSdkClaudeCodePlugin], maintainer: (_id, spawn) => (spawn === 1 ? [{ kind: "reply", text: "整理好了。" }, echo] : [echo]) });
    const spawns = runtimeSpawns(td);
    const frontend = await TestFrontend.connect(td.url);

    const started = await frontend.startTask("整理下载目录", undefined, undefined, "plain", undefined, { runtime: CLAUDE_CODE_RUNTIME_ID });
    expect(started.ok).toBe(true);
    const task = taskNow(td, (started as { result: { taskId: string } }).result.taskId);
    expect(task.runtime).toBe(CLAUDE_CODE_RUNTIME_ID);
    await waitState(td, task.id, "done");
    expect(spawns()).toEqual([{ agentId: task.maintainerId, runtime: CLAUDE_CODE_RUNTIME_ID }]);
    const channel = maintainerChannel(task.maintainerId);

    // 输入框的候选：Claude Code 报的命令（任务的会话没有二狗自己的命令）
    const list = (await slashCommands(td.url, channel)).body;
    expect(list.commands.filter((c) => c.kind === "runtime").map((c) => c.text)).toEqual(["/compact", "/context", "/review", "/deploy-notes"]);
    // 310 号票：内置命令的说明换成中文，原文留着
    expect(list.commands.find((c) => c.text === "/review")).toMatchObject({ name: "review", description: "评审一个拉取请求（PR）", originalDescription: "Review a pull request", collection: "Claude Code" });

    // 原样交过去：没有时间标记、没有消息 id 那一行——/compact 在 Claude Code 那边真的压缩了（309 号票起假 SDK 扮演手动压缩，时间线上记一笔），
    // 别的命令原样到了 Claude 手里
    await frontend.sendText("/compact", { conversation: channel });
    await waitUntil(() => td.daemon.store.read(channel, 0, EVENT_TYPES.timelineRecord).some((e) => (e.payload as { record: { kind: string } }).record.kind === "compaction"), {
      timeoutMs: 30_000,
      describe: () => "等 Claude Code 压缩完",
    });
    await frontend.sendText("/context", { conversation: channel });
    await waitUntil(() => said(td, channel, "agent").some((text) => text.includes('"hookContext"')), { timeoutMs: 30_000, describe: () => JSON.stringify(said(td, channel, "agent")) });
    const seen = JSON.parse(said(td, channel, "agent").find((text) => text.includes('"hookContext"'))!) as FakeClaudeEcho;
    expect(seen.input).toBe("/context");

    // pi 的任务照旧：/compact 跟着时间标记交给 pi（二狗自己的规矩，没有转交）
    const pi = await frontend.startTask("整理桌面", undefined, undefined, "plain");
    const piTask = taskNow(td, (pi as { result: { taskId: string } }).result.taskId);
    expect(piTask.runtime).toBeUndefined();
    await waitState(td, piTask.id, "done");
    const piChannel = maintainerChannel(piTask.maintainerId);
    await frontend.sendText("/compact", { conversation: piChannel });
    const piSeen = await nthAgentReply(td, piChannel, 2);
    expect(piSeen).toMatch(/^\[user\] \[\d{4}-\d{2}-\d{2} .*\]\n\/compact\n/m);
    expect((await slashCommands(td.url, piChannel)).body.commands.some((c) => c.kind === "runtime")).toBe(false);
    expect(spawns().at(-1)).toEqual({ agentId: piTask.maintainerId, runtime: "pi" });
  }, 90_000);

  it("秘书交给后台时带上运行时：建出的任务用它；写了不认得的运行时，工具回错、不建任务", async () => {
    const td = await startTestDaemon({
      extraPlugins: [fakeSdkClaudeCodePlugin],
      secretary: [
        { kind: "reply", toolCalls: [{ name: "delegate_task", arguments: { title: "整理下载目录", instructions: "把下载目录按月份分好", runtime: "codex" } }] },
        { kind: "reply", toolCalls: [{ name: "delegate_task", arguments: { title: "整理下载目录", instructions: "把下载目录按月份分好", runtime: CLAUDE_CODE_RUNTIME_ID } }] },
        { kind: "reply", text: "交给后台了。" },
      ],
      maintainer: [{ kind: "reply", text: "整理好了。" }],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.sendText("用 Claude Code 帮我把下载目录按月份整理一下");
    await waitUntil(() => td.daemon.tasks.list().length === 1, { describe: () => JSON.stringify(td.daemon.tasks.list()) });
    const [task] = td.daemon.tasks.list();
    expect(task!.runtime).toBe(CLAUDE_CODE_RUNTIME_ID);
    await waitState(td, task!.id, "done");
  }, 60_000);
});

describe("新建项目选运行时（289 号票）", () => {
  it("点新建项目选 Claude Code：通知里写明，秘书照写在建议立项卡上；点立项后项目的维护者用它；选了不认得的被拒", async () => {
    const td = await startTestDaemon({
      extraPlugins: [fakeSdkClaudeCodePlugin],
      secretary: [{ kind: "reply", toolCalls: [{ name: "suggest_project", arguments: { name: "家电档案", goal: "记下家电的保修", runtime: CLAUDE_CODE_RUNTIME_ID } }] }, { kind: "reply", text: "给你一张建议立项卡" }],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [CHANNELS.secretary]: 0, [CHANNELS.cards]: 0 });
    const refused = await frontend.request(METHODS.newProject, { request: "做一个家电档案", runtime: "codex" }, "k-codex");
    expect(refused.ok).toBe(false);
    expect(ok(await frontend.request(METHODS.newProject, { request: "做一个家电档案", runtime: CLAUDE_CODE_RUNTIME_ID }, "k-new"))).toBeDefined();
    const notice = messagesOf(frontend, CHANNELS.secretary).find((m) => m.agentInput);
    expect(notice && taskTextOf(notice)).toContain(`出卡时 runtime 写 ${CLAUDE_CODE_RUNTIME_ID}`);
    const card = await cardWhere(frontend, (c) => c.type === "suggest_project", "建议立项卡");
    expect(card.payload).toEqual({ name: "家电档案", goal: "记下家电的保修", runtime: CLAUDE_CODE_RUNTIME_ID });
    ok(await frontend.cardAction({ cardId: card.id, action: "kickoff", expectedVersion: 1 }));
    await waitUntil(() => td.daemon.projects.list().length === 1, { describe: () => JSON.stringify(td.daemon.projects.list()) });
    expect(td.daemon.projects.list()[0]).toMatchObject({ name: "家电档案", runtime: CLAUDE_CODE_RUNTIME_ID });
  }, 60_000);
});

describe("⚙ 按运行时、中途换运行时（289 号票）", () => {
  it("Claude Code 的维护者：⚙ 里多权限模式、思考档位，模型列表是它报的；选的值交给子进程；不认得的值回 400", async () => {
    const td = await startTestDaemon({ extraPlugins: [fakeSdkClaudeCodePlugin], maintainer: (_id, spawn) => (spawn === 1 ? [{ kind: "reply", text: "整理好了。" }, echo] : [echo]) });
    const task = td.daemon.tasks.delegate({ title: "整理下载目录", instructions: "把下载目录按月份分好", runtime: CLAUDE_CODE_RUNTIME_ID });
    await waitState(td, task.id, "done");

    // 运行时登记表里：设置项是权限模式、思考档位；模型列表是子进程报回的（假 SDK 的 supportedModels）
    const runtime = (await runtimesApi.view(td.url)).body.runtimes.find((r) => r.id === CLAUDE_CODE_RUNTIME_ID)!;
    expect(runtime.settings.map((s) => s.id)).toEqual(["permission_mode", "effort"]);
    expect(runtime.models).toEqual([
      { id: "sonnet", title: "Sonnet" },
      { id: "opus", title: "Opus" },
    ]);

    const view = (await agentSettingsApi.view(td.url, task.maintainerId)).body;
    expect(view.runtime).toMatchObject({ id: CLAUDE_CODE_RUNTIME_ID, settings: {} });
    // 不认得的值、没有的模型：400，没改
    expect((await agentSettingsApi.runtime(td.url, task.maintainerId, { runtime: CLAUDE_CODE_RUNTIME_ID, settings: { permission_mode: "yolo" } })).status).toBe(400);
    expect((await agentSettingsApi.runtime(td.url, task.maintainerId, { runtime: CLAUDE_CODE_RUNTIME_ID, model: "gpt-5" })).status).toBe(400);
    const saved = await agentSettingsApi.runtime(td.url, task.maintainerId, { runtime: CLAUDE_CODE_RUNTIME_ID, model: "opus", settings: { permission_mode: "plan", effort: "high" } });
    expect(saved.status).toBe(200);
    expect(saved.body.runtime).toMatchObject({ id: CLAUDE_CODE_RUNTIME_ID, model: "opus", settings: { permission_mode: "plan", effort: "high" } });
    expect(taskNow(td, task.id).runtimeOptions).toEqual({ model: "opus", settings: { permission_mode: "plan", effort: "high" } });

    // 下一轮的 query 选项里带上选的值
    const frontend = await TestFrontend.connect(td.url);
    await frontend.sendText("再按年份分一遍", { conversation: maintainerChannel(task.maintainerId) });
    const seen = JSON.parse(await nthAgentReply(td, maintainerChannel(task.maintainerId), 2)) as FakeClaudeEcho;
    expect(seen.options).toMatchObject({ model: "opus", permissionMode: "plan", effort: "high" });
  }, 60_000);

  it("中途换运行时（pi → Claude Code）：pi 写交接摘要，Claude Code 新开会话、摘要跟着下一条输入交过去；会话里记一条已换成，任务记着新的", async () => {
    const SUMMARY = "交接摘要：下载目录已按月份分好，用户还想按年份再分一遍。";
    let td: TestDaemon | undefined;
    // pi 的维护者：第一次拉起先做完任务，之后被叫去写交接摘要；换成 Claude Code 之后回显看到的
    const runtimeNow = (maintainerId: string) => td?.daemon.tasks.ofMaintainer(maintainerId)?.runtime;
    td = await startTestDaemon({
      extraPlugins: [fakeSdkClaudeCodePlugin],
      maintainer: (id, spawn) => (runtimeNow(id) === CLAUDE_CODE_RUNTIME_ID ? [echo] : spawn === 1 ? [{ kind: "reply", text: "整理好了。" }, { kind: "reply", text: SUMMARY }] : [{ kind: "reply", text: SUMMARY }]),
    });
    const spawns = runtimeSpawns(td);
    const task = td.daemon.tasks.delegate({ title: "整理下载目录", instructions: "把下载目录按月份分好" });
    await waitState(td, task.id, "done");
    const channel = maintainerChannel(task.maintainerId);

    // 没启用、不认得的运行时：400
    expect((await agentSettingsApi.runtime(td.url, task.maintainerId, { runtime: "codex" })).status).toBe(400);
    const switched = await agentSettingsApi.runtime(td.url, task.maintainerId, { runtime: CLAUDE_CODE_RUNTIME_ID });
    expect(switched.status).toBe(200);
    // 换完（写好交接摘要）任务才记着新的运行时，会话里记一条
    await waitUntil(() => taskNow(td!, task.id).runtime === CLAUDE_CODE_RUNTIME_ID, { describe: () => JSON.stringify(taskNow(td!, task.id)) });
    expect(said(td, channel, "system").some((text) => text.includes("已换成 Claude Code"))).toBe(true);
    expect((await agentSettingsApi.view(td.url, task.maintainerId)).body.runtime).toMatchObject({ id: CLAUDE_CODE_RUNTIME_ID });

    const frontend = await TestFrontend.connect(td.url);
    await frontend.sendText("再按年份分一遍", { conversation: channel });
    const seen = JSON.parse(await nthAgentReply(td, channel, 2)) as FakeClaudeEcho;
    expect(seen.input).toContain("再按年份分一遍");
    // 交接摘要跟着这条输入交过去：291 号票起经 UserPromptSubmit 钩子的 additionalContext（不在用户消息里）
    expect(seen.hookContext).toContain(SUMMARY);
    expect(seen.input).not.toContain(SUMMARY);
    // Claude Code 这边是新开的会话（不是接着谁）
    expect(seen.options.sessionId).toBeDefined();
    expect(seen.options.resume).toBeUndefined();
    expect(spawns().at(-1)).toEqual({ agentId: task.maintainerId, runtime: CLAUDE_CODE_RUNTIME_ID });
  }, 90_000);
});
