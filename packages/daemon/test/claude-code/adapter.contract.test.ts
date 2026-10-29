// Claude Code 适配子进程的契约测试（287 号票，照 pi 的契约测试 test/contract/）：宿主协议 ⇄ Agent SDK 的对照。
// SDK 换成假的（helpers/fake-claude-sdk.ts），不启动真的 claude、不花额度——测试扮演 claude，按 SDK 的消息格式一条条吐；
// 适配子进程本身是真的（runClaudeChild，stdin / stdout 换成内存里的流）。最后一组真的拉起一个子进程（fixtures/fake-claude-child.ts），
// 核对交给 claude 的环境里没有 ANTHROPIC_API_KEY。
// 真机验证（真的 claude、订阅额度）在 294 号票。
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
import { CLAUDE_USAGE_PROVIDER } from "../../src/claude-code/child/translator.ts";
import { findClaudeExecutable } from "../../src/claude-code/child/env.ts";
import { runClaudeChild } from "../../src/claude-code/child/child.ts";
import { RECORD_EXT } from "../../src/claude-code/child/records.ts";
import type { ClaudeQueryFunction } from "../../src/claude-code/child/session.ts";
import { buildChildEnv } from "../../src/process/child-env.ts";
import { type AgentReport, HOST_PROTOCOL_VERSION, type HostCommand, type SessionAssembly, spawnAgentProcess } from "../../src/runtime/index.ts";
import { encodeLine, readJsonLines } from "../../src/runtime/line-channel.ts";
import { fauxModel } from "../helpers/daemon.ts";
import { createFakeClaudeSdk, type FakeClaudeEcho, inputImages, inputText, sdk, sdkReply } from "../helpers/fake-claude-sdk.ts";
import { FAKE_CLAUDE_CHILD } from "../helpers/fake-claude-code.ts";
import { ReportLog } from "../helpers/report-log.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assemblyOf(overrides: Partial<SessionAssembly> = {}): SessionAssembly {
  return {
    agentId: "claude-test",
    cwd: overrides.cwd ?? makeTempDir("ergo-claude-cwd-"),
    sessionDir: overrides.sessionDir ?? makeTempDir("ergo-claude-sessions-"),
    piAgentDir: "",
    model: fauxModel([]),
    credentials: {},
    tools: [],
    contributions: { tools: [], contextBlocks: [], hooks: [] },
    skillPaths: [],
    systemPrompt: "你是二狗的维护者。MARKER_ERGO_APPEND",
    continueSession: true,
    forwardToolCalls: false,
    shellEnv: {},
    heartbeatIntervalMs: 60_000,
    ...overrides,
  };
}

/** 在本进程里跑一个适配子进程（stdin / stdout 是内存里的流），SDK 是手动挡的假的 */
function startChild(options: { session?: Partial<SessionAssembly>; env?: Record<string, string>; wrap?: (query: ClaudeQueryFunction) => ClaudeQueryFunction } = {}) {
  const fake = createFakeClaudeSdk();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const listeners = new Set<(report: AgentReport) => void>();
  readJsonLines<AgentReport>(stdout, (report) => listeners.forEach((l) => l(report)), { onInvalid: () => {} });
  const log = new ReportLog({
    onReport: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const logs: string[] = [];
  let exitCode: number | undefined;
  const child = runClaudeChild(
    {
      stdin,
      stdout,
      env: options.env ?? { PATH: "C:\\Windows" },
      log: (line) => logs.push(line),
      exit: (code) => {
        exitCode = code;
      },
    },
    { queryFor: () => (options.wrap ? options.wrap(fake.query) : fake.query), executable: null },
  );
  const assembly = assemblyOf(options.session);
  const send = (command: HostCommand) => stdin.write(encodeLine(command));
  send({ type: "start", protocolVersion: HOST_PROTOCOL_VERSION, session: assembly });
  onTestFinished(() => child.shutdown(0));
  return { fake, send, log, logs, assembly, exitCode: () => exitCode };
}

type Child = ReturnType<typeof startChild>;

/** 开始过的会话记录（312 号票那一条用：记着开始时的工作目录） */
const startedRecord = (cwd: string) => ({ claudeSessionId: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b", cwd, createdAt: "2026-10-20T10:00:00.000+08:00", started: true });

/** 送一条输入，等假 SDK 收到（交回 query 和那条用户消息） */
async function prompt(child: Child, inputId: string, text: string, extra: Partial<Extract<HostCommand, { type: "user_input" }>> = {}) {
  child.send({ type: "user_input", inputId, text, ...extra });
  const query = await child.fake.nth(1);
  const input = await query.nextInput();
  return { query, input };
}

/** 等一会儿，确认这段时间里没有某种上报 */
async function noneFor(log: ReportLog, type: AgentReport["type"], ms = 150): Promise<void> {
  const before = log.ofType(type).length;
  await new Promise((resolve) => setTimeout(resolve, ms));
  expect(log.ofType(type).length).toBe(before);
}

describe("Claude Code 适配子进程（假 SDK）", () => {
  it("新建会话一轮：自己定会话 id、记下会话记录；用户消息推进流式输入；逐字输出 → 定稿 → 用量 → 轮次结束；query 的选项照用户的决定", async () => {
    const child = startChild();
    const ready = await child.log.next("ready");
    expect(ready.sessionId).toMatch(UUID);
    expect(ready.session).toBe(ready.sessionId);
    expect(ready).toMatchObject({ vision: true, model: { provider: "claude-code", modelId: "default", pinned: false }, context: { window: 200_000 } });
    expect(fs.existsSync(path.join(child.assembly.sessionDir, `${ready.session}${RECORD_EXT}`))).toBe(true);

    const { query, input } = await prompt(child, "in-1", "把下载目录整理一下");
    expect(input.message.content).toBe("把下载目录整理一下");
    expect(input.uuid).toMatch(UUID);
    expect(input.priority).toBeUndefined();
    expect((input as { client_composed?: boolean }).client_composed).toBeUndefined();
    // 用 Claude Code 自己的配置（三层设置）、它自己的系统提示，二狗的追加在末尾、不录下（恢复的会话里当场生效）；新开的会话用二狗定的 id
    expect(query.options).toMatchObject({
      cwd: child.assembly.cwd,
      settingSources: ["user", "project", "local"],
      // 291 号票：后面补一句二狗的工具在 Claude Code 里叫什么
      systemPrompt: { type: "preset", preset: "claude_code", append: expect.stringMatching(/^你是二狗的维护者。MARKER_ERGO_APPEND\n\n（二狗补充：/), snapshot: false },
      includePartialMessages: true,
      permissionPrompts: "none",
      sessionId: ready.sessionId,
    });
    expect(query.options.resume).toBeUndefined();
    expect(query.options.pathToClaudeCodeExecutable).toBeUndefined();

    query.emit(sdk.init(ready.sessionId), ...sdkReply("msg_1", { thinking: "先看看目录里有什么。", text: "整理好了。", usage: { input: 120, cacheRead: 30, output: 40 } }));
    await noneFor(child.log, "turn_end");
    query.emit(sdk.result({ userMessageUuids: [input.uuid!], queuedTurnCount: 0 }));

    const final = await child.log.next("message_final");
    expect(final.message).toEqual({
      role: "assistant",
      parts: [
        { type: "thinking", text: "先看看目录里有什么。" },
        { type: "text", text: "整理好了。" },
      ],
      stopReason: "done",
    });
    const deltas = child.log.ofType("stream_delta").filter((d) => d.messageId === final.messageId);
    expect(deltas.map((d) => [d.part, d.delta])).toEqual([
      ["thinking", "先看看目录里有什么。"],
      ["text", "整理好了。"],
    ]);
    expect(child.log.ofType("usage")).toEqual([
      { type: "usage", messageId: final.messageId, provider: CLAUDE_USAGE_PROVIDER, modelId: "claude-test-model", input: 120, output: 40, cacheRead: 30, cacheWrite: 0, totalTokens: 190 },
    ]);
    expect(await child.log.next("turn_end")).toEqual({ type: "turn_end", outcome: "completed" });
    expect(child.log.reports.map((r) => r.type).filter((t) => t !== "heartbeat" && t !== "runtime_catalog")).toEqual(["ready", "stream_delta", "stream_delta", "message_final", "usage", "turn_end"]);
  });

  it("工具调用：定稿在前、工具调用开始在后，结果回来是工具调用结束（图片换成占位，media 写明是什么、多大）；一轮里两次模型调用各报一次用量", async () => {
    const child = startChild();
    await child.log.next("ready");
    const { query, input } = await prompt(child, "in-1", "看看截图");
    query.emit(sdk.init("s"), ...sdkReply("msg_1", { text: "我先读一下。", toolCalls: [{ id: "toolu_1", name: "Read", input: { file_path: "a.png" } }], usage: { input: 50, output: 10 } }));
    const png = Buffer.from("fake-png-bytes").toString("base64");
    query.emit(sdk.toolResult("toolu_1", [{ type: "text", text: "读到一张图" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }]));
    query.emit(...sdkReply("msg_2", { text: "是一张登录页的截图。", usage: { input: 80, output: 12 } }), sdk.result({ userMessageUuids: [input.uuid!], queuedTurnCount: 0 }));
    await child.log.next("turn_end");

    const flow = child.log.reports.filter((r) => ["message_final", "tool_call_start", "tool_call_end", "usage"].includes(r.type));
    expect(flow.map((r) => r.type)).toEqual(["message_final", "tool_call_start", "usage", "tool_call_end", "message_final", "usage"]);
    const [first, start, firstUsage, end, second, secondUsage] = flow as [
      Extract<AgentReport, { type: "message_final" }>,
      Extract<AgentReport, { type: "tool_call_start" }>,
      Extract<AgentReport, { type: "usage" }>,
      Extract<AgentReport, { type: "tool_call_end" }>,
      Extract<AgentReport, { type: "message_final" }>,
      Extract<AgentReport, { type: "usage" }>,
    ];
    expect(first.message).toEqual({
      role: "assistant",
      parts: [
        { type: "text", text: "我先读一下。" },
        { type: "tool_call", toolCallId: "toolu_1", toolName: "Read", args: { file_path: "a.png" } },
      ],
      stopReason: "tool_calls",
    });
    expect(start).toEqual({ type: "tool_call_start", toolCallId: "toolu_1", toolName: "Read", args: { file_path: "a.png" } });
    expect(end).toEqual({
      type: "tool_call_end",
      toolCallId: "toolu_1",
      toolName: "Read",
      isError: false,
      resultText: "读到一张图\n[image]",
      media: [{ type: "image", mimeType: "image/png", bytes: Buffer.byteLength("fake-png-bytes") }],
    });
    expect(second.message.parts).toEqual([{ type: "text", text: "是一张登录页的截图。" }]);
    expect([firstUsage.messageId, firstUsage.input, firstUsage.output]).toEqual([first.messageId, 50, 10]);
    expect([secondUsage.messageId, secondUsage.input, secondUsage.output]).toEqual([second.messageId, 80, 12]);
  });

  it("子代理：它里面的工具调用带 parentToolCallId 挂在调用它的 Agent 工具下面；它的正文不转", async () => {
    const child = startChild();
    await child.log.next("ready");
    const { query, input } = await prompt(child, "in-1", "让子代理查一下");
    query.emit(sdk.init("s"), ...sdkReply("msg_1", { toolCalls: [{ id: "toolu_agent", name: "Agent", input: { description: "查资料", prompt: "查一下" } }] }));
    query.emit(
      sdk.assistant("msg_sub_1", sdk.text("子代理自己说的话"), { parent: "toolu_agent" }),
      sdk.assistant("msg_sub_1", sdk.toolUse("toolu_sub", "Grep", { pattern: "TODO" }), { parent: "toolu_agent" }),
      sdk.toolResult("toolu_sub", "src/a.ts:1: TODO", { parent: "toolu_agent" }),
      sdk.toolResult("toolu_agent", "查到了一处 TODO"),
      ...sdkReply("msg_2", { text: "子代理查到一处。" }),
      sdk.result({ userMessageUuids: [input.uuid!], queuedTurnCount: 0 }),
    );
    await child.log.next("turn_end");
    const calls = child.log.reports.filter((r) => r.type === "tool_call_start" || r.type === "tool_call_end");
    expect(calls).toEqual([
      { type: "tool_call_start", toolCallId: "toolu_agent", toolName: "Agent", args: { description: "查资料", prompt: "查一下" } },
      { type: "tool_call_start", toolCallId: "toolu_sub", toolName: "Grep", args: { pattern: "TODO" }, parentToolCallId: "toolu_agent" },
      { type: "tool_call_end", toolCallId: "toolu_sub", toolName: "Grep", isError: false, resultText: "src/a.ts:1: TODO", parentToolCallId: "toolu_agent" },
      { type: "tool_call_end", toolCallId: "toolu_agent", toolName: "Agent", isError: false, resultText: "查到了一处 TODO" },
    ]);
    const said = child.log.ofType("message_final").flatMap((m) => m.message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));
    expect(said).toEqual(["子代理查到一处。"]);
  });

  it("插话：priority next 推进去、并进同一轮，turn_end 列出收下的；来晚了的（Claude Code 另起一轮）并进同一轮，等后面那条 result 才结束；没有进行中的回合时不收", async () => {
    const child = startChild();
    await child.log.next("ready");
    child.send({ type: "interject", inputId: "early", text: "还没开始就插话" });
    const refused = await child.log.next("error");
    expect(refused).toMatchObject({ code: "bad_command", inputId: "early" });

    const { query, input } = await prompt(child, "in-1", "整理下载目录");
    child.send({ type: "interject", inputId: "in-2", text: "顺便把截图挪走" });
    const interjection = await query.nextInput();
    expect(interjection.priority).toBe("next");
    expect(inputText(interjection)).toBe("顺便把截图挪走");
    query.emit(sdk.init("s"), ...sdkReply("msg_1", { text: "好，连截图一起。" }), sdk.result({ userMessageUuids: [input.uuid!, interjection.uuid!], queuedTurnCount: 0 }));
    expect(await child.log.next("turn_end")).toEqual({ type: "turn_end", outcome: "completed", interjected: ["in-2"] });

    // 来晚了：这一轮的 result 里还没有它、说后面还有一轮
    child.send({ type: "user_input", inputId: "in-3", text: "再按月份分" });
    const third = await query.nextInput();
    child.send({ type: "interject", inputId: "in-4", text: "按年份也行" });
    const late = await query.nextInput();
    query.emit(sdk.init("s"), ...sdkReply("msg_2", { text: "按月份分好了。" }), sdk.result({ userMessageUuids: [third.uuid!], queuedTurnCount: 1 }));
    await noneFor(child.log, "turn_end");
    expect(child.log.ofType("turn_end")).toHaveLength(1);
    query.emit(sdk.init("s"), ...sdkReply("msg_3", { text: "年份也分好了。" }), sdk.result({ userMessageUuids: [late.uuid!], queuedTurnCount: 0 }));
    expect(await child.log.next("turn_end")).toEqual({ type: "turn_end", outcome: "completed", interjected: ["in-4"] });
    expect(child.log.ofType("turn_end")).toHaveLength(2);
    expect(child.log.ofType("message_final").map((m) => m.message.parts)).toEqual([
      [{ type: "text", text: "好，连截图一起。" }],
      [{ type: "text", text: "按月份分好了。" }],
      [{ type: "text", text: "年份也分好了。" }],
    ]);
  });

  it("打断：interrupt()，说到一半的回复定稿时标 aborted，这一轮按被打断收尾；之后照常能说下一句", async () => {
    const child = startChild();
    await child.log.next("ready");
    const { query } = await prompt(child, "in-1", "写一篇长文");
    query.onInterrupt = () => {
      query.emit(sdk.assistant("msg_1", sdk.text("写到一半"), { aborted: true }), sdk.result({ subtype: "error_during_execution", isError: true, errors: ["interrupted"] }));
    };
    query.emit(sdk.init("s"), sdk.messageStart("msg_1"), sdk.textDelta("写到一半"));
    child.send({ type: "abort" });
    expect(await child.log.next("turn_end")).toEqual({ type: "turn_end", outcome: "aborted" });
    expect(query.interrupts).toBe(1);
    const final = child.log.ofType("message_final").at(-1)!;
    expect(final.message).toMatchObject({ parts: [{ type: "text", text: "写到一半" }], stopReason: "aborted" });

    query.onInterrupt = undefined;
    child.send({ type: "user_input", inputId: "in-2", text: "算了，说个短的" });
    const next = await query.nextInput();
    query.emit(sdk.init("s"), ...sdkReply("msg_2", { text: "好的。" }), sdk.result({ userMessageUuids: [next.uuid!], queuedTurnCount: 0 }));
    expect(await child.log.next("turn_end")).toEqual({ type: "turn_end", outcome: "completed" });
  });

  it("图片：image 块（base64、media_type）跟在文字后面；跟在这条输入后面的上下文不在用户消息里，经 UserPromptSubmit 钩子交（291 号票）", async () => {
    const child = startChild();
    await child.log.next("ready");
    const data = Buffer.from("png").toString("base64");
    const { query, input } = await prompt(child, "in-1", "这张图里是什么", { images: [{ mime: "image/png", data }], context: "（看板：刚加了一条待办）" });
    expect(input.message.content).toEqual([
      { type: "text", text: "这张图里是什么" },
      { type: "image", source: { type: "base64", media_type: "image/png", data } },
    ]);
    expect(inputImages(input)).toHaveLength(1);
    expect(await query.promptHooks(input)).toBe("（看板：刚加了一条待办）");
  });

  it("压缩：推 /compact，compact_boundary → compacted 压好了（压缩前的 token 数），压缩那一轮的输出不当成回复；没什么可压、没压成、自动压缩各报对", async () => {
    const child = startChild();
    await child.log.next("ready");
    child.send({ type: "compact" });
    const query = await child.fake.nth(1);
    expect(inputText(await query.nextInput())).toBe("/compact");
    query.emit(sdk.init("s"), sdk.compactBoundary("manual", 12_345), sdk.localOutput("Compacted. ctrl+o to see full summary"), sdk.result({ result: "" }));
    expect(await child.log.next("compacted")).toEqual({ type: "compacted", reason: "manual", outcome: "done", tokensBefore: 12_345 });

    child.send({ type: "compact" });
    await query.nextInput();
    query.emit(sdk.localOutput("Not enough messages to compact."), sdk.result({ result: "" }));
    expect(await child.log.next("compacted")).toEqual({ type: "compacted", reason: "manual", outcome: "nothing" });

    child.send({ type: "compact" });
    await query.nextInput();
    query.emit(sdk.compactFailed("API Error: overloaded"), sdk.result({ result: "" }));
    expect(await child.log.next("compacted")).toEqual({ type: "compacted", reason: "manual", outcome: "failed", error: "API Error: overloaded" });
    expect(child.log.ofType("message_final")).toEqual([]);
    expect(child.log.ofType("turn_end")).toEqual([]);

    // 一轮里到了阈值自动压缩
    child.send({ type: "user_input", inputId: "in-1", text: "接着干" });
    const input = await query.nextInput();
    query.emit(sdk.init("s"), sdk.compactBoundary("auto", 150_000), ...sdkReply("msg_1", { text: "接着干了。" }), sdk.result({ userMessageUuids: [input.uuid!], queuedTurnCount: 0 }));
    expect(await child.log.next("compacted")).toEqual({ type: "compacted", reason: "threshold", outcome: "done", tokensBefore: 150_000 });
    await child.log.next("turn_end");
  });

  it("压缩之前（309 号票）：装配了范围审视的交给 SDK 一个 PreCompact 钩子，压缩之前报 compacting（手动的 manual、自动的 threshold），不拦压缩；没装配的不交这个钩子", async () => {
    const child = startChild({ session: { scopeReview: { model: fauxModel([]), instructions: "审视", reference: "立项书" } } });
    await child.log.next("ready");
    child.send({ type: "compact" });
    const query = await child.fake.nth(1);
    expect(Object.keys(query.options.hooks ?? {})).toContain("PreCompact");
    expect(inputText(await query.nextInput())).toBe("/compact");
    await query.preCompactHooks("manual");
    expect(await child.log.next("compacting")).toEqual({ type: "compacting", reason: "manual" });
    query.emit(sdk.init("s"), sdk.compactBoundary("manual", 12_345), sdk.result({ result: "" }));
    expect(await child.log.next("compacted")).toMatchObject({ reason: "manual", outcome: "done" });

    // 一轮里到了阈值自动压缩
    child.send({ type: "user_input", inputId: "in-1", text: "接着干" });
    const input = await query.nextInput();
    await query.preCompactHooks("auto");
    expect(await child.log.next("compacting")).toEqual({ type: "compacting", reason: "threshold" });
    query.emit(sdk.init("s"), sdk.compactBoundary("auto", 150_000), ...sdkReply("msg_1", { text: "接着干了。" }), sdk.result({ userMessageUuids: [input.uuid!], queuedTurnCount: 0 }));
    await child.log.next("turn_end");

    const plain = startChild();
    await plain.log.next("ready");
    const { query: plainQuery } = await prompt(plain, "in-1", "你好");
    expect(Object.keys(plainQuery.options.hooks ?? {})).not.toContain("PreCompact");
  });

  it("用量：流里没有逐次调用的用量时按这一轮 result 的四段报一条", async () => {
    const child = startChild();
    await child.log.next("ready");
    const { query, input } = await prompt(child, "in-1", "你好");
    query.emit(
      sdk.init("s"),
      sdk.assistant("msg_1", sdk.text("你好。")),
      sdk.result({ usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }, userMessageUuids: [input.uuid!], queuedTurnCount: 0 }),
    );
    await child.log.next("turn_end");
    const final = child.log.ofType("message_final")[0]!;
    expect(child.log.ofType("usage")).toEqual([{ type: "usage", messageId: final.messageId, provider: "claude-code", modelId: "claude-test-model", input: 7, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 13 }]);
  });

  it("轮次结束：出错的 result 按出错收尾（带说明）；query 中途 throw 了这一轮按出错收尾，下一条输入按会话 id 恢复一个新的 query", async () => {
    const child = startChild();
    const ready = await child.log.next("ready");
    const { query, input } = await prompt(child, "in-1", "你好");
    query.emit(sdk.init(ready.sessionId), sdk.assistant("msg_1", sdk.text("API Error: overloaded"), { error: "overloaded" }), sdk.result({ isError: true, result: "API Error: overloaded", userMessageUuids: [input.uuid!] }));
    expect(await child.log.next("turn_end")).toEqual({ type: "turn_end", outcome: "error", errorMessage: "API Error: overloaded" });
    expect(child.log.ofType("message_final")[0]!.message).toEqual({ role: "assistant", parts: [], stopReason: "error", errorMessage: "API Error: overloaded" });

    child.send({ type: "user_input", inputId: "in-2", text: "再试一次" });
    await query.nextInput();
    query.fail(new Error("Claude Code returned an error result: 进程退出了"));
    expect(await child.log.next("turn_end")).toEqual({ type: "turn_end", outcome: "error", errorMessage: "Claude Code returned an error result: 进程退出了" });

    child.send({ type: "user_input", inputId: "in-3", text: "第三次" });
    const second = await child.fake.nth(2);
    expect(second.options.resume).toBe(ready.sessionId);
    expect(second.options.sessionId).toBeUndefined();
    const third = await second.nextInput();
    expect(inputText(third)).toBe("第三次");
    second.emit(sdk.init(ready.sessionId), ...sdkReply("msg_2", { text: "好了。" }), sdk.result({ userMessageUuids: [third.uuid!], queuedTurnCount: 0 }));
    expect(await child.log.next("turn_end")).toEqual({ type: "turn_end", outcome: "completed" });
  });

  it("query 当场起不来（SDK 报错，比如找不到 claude）：这一轮按出错收尾，下一条输入再起一个", async () => {
    // 拉起时先起一次（起不来只记日志），第一条输入时再起一次：两次都报错
    let failures = 2;
    const child = startChild({
      wrap: (query) => (params) => {
        if (failures-- > 0) throw new Error("Claude Code executable not found");
        return query(params);
      },
    });
    await child.log.next("ready");
    child.send({ type: "user_input", inputId: "in-1", text: "你好" });
    expect(await child.log.next("turn_end")).toEqual({ type: "turn_end", outcome: "error", errorMessage: "Claude Code executable not found" });
    const { query, input } = await prompt(child, "in-2", "再试一次");
    query.emit(sdk.init("s"), ...sdkReply("msg_1", { text: "好了。" }), sdk.result({ userMessageUuids: [input.uuid!], queuedTurnCount: 0 }));
    expect(await child.log.next("turn_end")).toEqual({ type: "turn_end", outcome: "completed" });
  });

  it("未知事件不崩：不认得的消息种类、不认得的 system 子类、会话状态、订阅额度都不影响这一轮（额度记进日志）", async () => {
    const child = startChild();
    await child.log.next("ready");
    const { query, input } = await prompt(child, "in-1", "你好");
    query.emit(
      sdk.unknown("brand_new_message_type"),
      sdk.init("s"),
      sdk.unknown("system", "brand_new_subtype"),
      sdk.sessionState("running"),
      sdk.rateLimit("allowed_warning", 0.82),
      ...sdkReply("msg_1", { text: "你好。" }),
      sdk.unknown("prompt_suggestion"),
      sdk.sessionState("idle"),
      sdk.result({ userMessageUuids: [input.uuid!], queuedTurnCount: 0 }),
      sdk.unknown("task_notification"),
    );
    expect(await child.log.next("turn_end")).toEqual({ type: "turn_end", outcome: "completed" });
    expect(child.log.ofType("message_final")).toHaveLength(1);
    expect(child.log.ofType("error")).toEqual([]);
    expect(child.logs.some((l) => l.includes("订阅额度：five_hour allowed_warning 82%"))).toBe(true);
  });

  it("斜杠命令原样交给 Claude Code（不加 client_composed）；本地执行的输出当成一条回复", async () => {
    const child = startChild();
    await child.log.next("ready");
    const { query, input } = await prompt(child, "in-1", "/context");
    expect(input.message.content).toBe("/context");
    query.emit(sdk.init("s"), sdk.localOutput("上下文用了 12%"), sdk.result({ userMessageUuids: [input.uuid!], queuedTurnCount: 0 }));
    expect(await child.log.next("turn_end")).toEqual({ type: "turn_end", outcome: "completed" });
    expect(child.log.ofType("message_final").map((m) => m.message)).toEqual([{ role: "assistant", parts: [{ type: "text", text: "上下文用了 12%" }], stopReason: "done" }]);
  });

  it("接着会话：会话记录里开始过的按 resume 恢复；模型、上下文窗口记下来下次 ready 报回；/clear 让 Claude Code 换了会话 id 的跟着改；指定名字的分段、清空后的新会话各用各的", async () => {
    const sessionDir = makeTempDir("ergo-claude-sessions-");
    const first = startChild({ session: { sessionDir } });
    const ready = await first.log.next("ready");
    const { query, input } = await prompt(first, "in-1", "记住暗号是青蛙");
    query.emit(sdk.init(ready.sessionId, "claude-sonnet-test"), ...sdkReply("msg_1", { text: "记住了。", model: "claude-sonnet-test" }));
    query.emit(sdk.result({ userMessageUuids: [input.uuid!], queuedTurnCount: 0, modelUsage: { "claude-sonnet-test": { contextWindow: 1_000_000 } } }));
    await first.log.next("turn_end");
    first.send({ type: "exit" });
    await expect.poll(() => first.exitCode()).toBe(0);
    expect(query.closed).toBe(true);

    const second = startChild({ session: { sessionDir } });
    const again = await second.log.next("ready");
    expect(again).toMatchObject({ sessionId: ready.sessionId, session: ready.session, model: { modelId: "claude-sonnet-test", pinned: true }, context: { window: 1_000_000 } });
    const resumed = await prompt(second, "in-2", "/clear");
    expect(resumed.query.options.resume).toBe(ready.sessionId);
    expect(resumed.query.options.sessionId).toBeUndefined();
    resumed.query.emit(sdk.result({ userMessageUuids: [resumed.input.uuid!], queuedTurnCount: 0 }));
    await second.log.next("turn_end");
    second.send({ type: "user_input", inputId: "in-3", text: "暗号是什么" });
    const after = await resumed.query.nextInput();
    resumed.query.emit(sdk.init("cleared-session-id", "claude-sonnet-test"), ...sdkReply("msg_2", { text: "不知道。" }), sdk.result({ userMessageUuids: [after.uuid!], queuedTurnCount: 0 }));
    await second.log.next("turn_end");
    second.send({ type: "exit" });
    await expect.poll(() => second.exitCode()).toBe(0);
    expect((await (async () => startChild({ session: { sessionDir } }).log.next("ready"))()).sessionId).toBe("cleared-session-id");

    // 指定名字（项目维护者的分段）：没有就新开、用这个名字；清空后的新会话（freshSession）马上新开
    const segment = startChild({ session: { sessionDir, session: "seg-2", continueSession: false } });
    const segReady = await segment.log.next("ready");
    expect(segReady.session).toBe("seg-2");
    expect(segReady.sessionId).not.toBe("cleared-session-id");
    const fresh = startChild({ session: { sessionDir, freshSession: "fresh-1" } });
    expect((await fresh.log.next("ready")).session).toBe("fresh-1");
  });

  it("312 号票：数据目录改了名（旧路径是指到新目录的目录联接），接着早先开的会话时工作目录照记录里的旧写法（Claude Code 按它找会话记录）；不是同一个目录的、新开的照这次的", async () => {
    const base = makeTempDir("ergo-claude-rename-");
    const workdir = path.join(base, ".ergo", "projects", "p-1", "workdir");
    fs.mkdirSync(workdir, { recursive: true });
    fs.symlinkSync(path.join(base, ".ergo"), path.join(base, ".ergou"), "junction");
    const oldWorkdir = path.join(base, ".ergou", "projects", "p-1", "workdir");

    const sessionDir = makeTempDir("ergo-claude-sessions-");
    fs.writeFileSync(path.join(sessionDir, `s-1${RECORD_EXT}`), JSON.stringify(startedRecord(oldWorkdir)));
    const child = startChild({ session: { sessionDir, cwd: workdir } });
    await child.log.next("ready");
    const { query } = await prompt(child, "in-1", "接着做");
    expect(query.options).toMatchObject({ cwd: oldWorkdir, resume: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b" });

    const elsewhere = makeTempDir("ergo-claude-elsewhere-");
    const otherDir = makeTempDir("ergo-claude-sessions-");
    fs.writeFileSync(path.join(otherDir, `s-1${RECORD_EXT}`), JSON.stringify(startedRecord(elsewhere)));
    const other = startChild({ session: { sessionDir: otherDir, cwd: workdir } });
    await other.log.next("ready");
    expect((await prompt(other, "in-1", "接着做")).query.options.cwd).toBe(workdir);

    const fresh = startChild({ session: { cwd: workdir } });
    await fresh.log.next("ready");
    expect((await prompt(fresh, "in-1", "新开")).query.options.cwd).toBe(workdir);
  });

  it("交给 claude 的环境：去掉 ANTHROPIC_API_KEY 和从别的 Claude Code 会话继承来的会话变量，带上客户端标识，别的照拷", async () => {
    const child = startChild({
      env: { PATH: "C:\\Windows", ANTHROPIC_API_KEY: "sk-ant-should-not-pass", anthropic_api_key: "sk-ant-lowercase", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "parent", ERGO_LANGUAGE: "zh-CN" },
    });
    await child.log.next("ready");
    const { query } = await prompt(child, "in-1", "你好");
    expect(query.options.env).toEqual({ PATH: "C:\\Windows", ERGO_LANGUAGE: "zh-CN", CLAUDE_AGENT_SDK_CLIENT_APP: "ergo" });
  });

  it("这一张没做的命令：范围审视回没做成、会话回退（没接撤回用的会话函数，293 号票）回没挪成、守卫判定和工具结果回没有在等的、贡献清单和 yield 收下不管、工单回 unsupported；exit 时手头有一轮先打断再关掉", async () => {
    const child = startChild();
    await child.log.next("ready");
    child.send({ type: "scope_review", requestId: "r-1", reference: "立项书" });
    expect(await child.log.next("scope_review_result")).toMatchObject({ requestId: "r-1", findings: [], error: expect.any(String) });
    child.send({ type: "navigate_session", requestId: "n-1", target: { beforeInput: "in-0" }, marker: { branchId: "b", change: "rollback" } });
    expect(await child.log.next("session_navigated")).toMatchObject({ requestId: "n-1", ok: false });
    child.send({ type: "guard_reply", requestId: "g-1", verdict: { allow: true } });
    expect(await child.log.next("error")).toMatchObject({ code: "bad_command" });
    child.send({ type: "contribution", id: "reinjection", text: "阶段二" });
    child.send({ type: "yield" });
    child.send({ type: "work_order", workOrderId: "w", text: "x" });
    expect(await child.log.next("error")).toMatchObject({ code: "unsupported" });

    const { query } = await prompt(child, "in-1", "干活");
    child.send({ type: "exit" });
    await expect.poll(() => child.exitCode()).toBe(0);
    expect(query.interrupts).toBe(1);
    expect(query.closed).toBe(true);
  });
});

describe("Claude Code 子进程（真的子进程，假 SDK）", () => {
  it("守护进程给的环境里就算有 ANTHROPIC_API_KEY，交给 claude 的也没有；宿主协议走 stdin / stdout", async () => {
    const assembly = assemblyOf({ model: fauxModel([{ kind: "echo_context" }]) });
    const agent = spawnAgentProcess({
      session: assembly,
      entry: FAKE_CLAUDE_CHILD,
      env: buildChildEnv(process.env, { ANTHROPIC_API_KEY: "sk-ant-should-not-pass", CLAUDE_CODE_CHILD_SESSION: "1" }),
    });
    onTestFinished(async () => {
      agent.kill();
      await agent.exited;
    });
    const log = new ReportLog(agent);
    const ready = await log.next("ready");
    agent.send({ type: "user_input", inputId: "in-1", text: "把你拿到的选项念一遍" });
    const final = await log.next("message_final");
    expect((await log.next("turn_end")).outcome).toBe("completed");
    const echo = JSON.parse(final.message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")) as FakeClaudeEcho;
    expect(echo.input).toBe("把你拿到的选项念一遍");
    expect(echo.options.envKeys).not.toContain("ANTHROPIC_API_KEY");
    expect(echo.options.envKeys).not.toContain("CLAUDE_CODE_CHILD_SESSION");
    expect(echo.options.envKeys.some((k) => k.toUpperCase() === "PATH")).toBe(true);
    expect(echo.options).toMatchObject({ clientApp: "ergo", sessionId: ready.sessionId, settingSources: ["user", "project", "local"], hasExecutable: false });
    agent.send({ type: "exit" });
    expect((await agent.exited).code).toBe(0);
  });
});

const exists = (files: string[]) => (file: string) => files.includes(file);

describe("找本机的 claude.exe", () => {
  it("Windows：先按 PATH 找，再找官方安装器的位置；只认 .exe；别的系统用 SDK 自带的", () => {
    const env = { Path: 'C:\\Windows;"C:\\Tools\\Claude";', USERPROFILE: "C:\\Users\\me" };
    expect(findClaudeExecutable(env, "win32", exists(["C:\\Tools\\Claude\\claude.exe", "C:\\Users\\me\\.local\\bin\\claude.exe"]))).toBe("C:\\Tools\\Claude\\claude.exe");
    expect(findClaudeExecutable(env, "win32", exists(["C:\\Users\\me\\.local\\bin\\claude.exe"]))).toBe("C:\\Users\\me\\.local\\bin\\claude.exe");
    expect(findClaudeExecutable(env, "win32", exists(["C:\\Tools\\Claude\\claude.cmd"]))).toBeUndefined();
    expect(findClaudeExecutable(env, "linux", exists(["C:\\Tools\\Claude\\claude.exe"]))).toBeUndefined();
  });
});
