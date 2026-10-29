// Claude Code 适配子进程的契约测试：选的值、命令和模型清单、写交接摘要（289 号票）。SDK 换成假的（helpers/fake-claude-sdk.ts），
// 不启动真的 claude、不花额度；适配子进程本身是真的（runClaudeChild，stdin / stdout 换成内存里的流）。和 287 号票的 adapter.contract.test.ts
// 同一种拉法，分开放（各票各改各的文件）。
// - ⚙ 里选的值（装配参数 runtimeOptions）→ query 的 model、effort、permissionMode；"跟 Claude Code 自己的设置"、不认得的不传；
// - query 起来后报一次模型列表和斜杠命令（runtime_catalog，supportedModels / supportedCommands）；每轮开头的 system/init 按名字再报命令
//   （只在终端里能用的不报，说明按之前报过的补），中途 commands_changed 整份换掉；
// - write_handoff：推一条请 Claude 写交接摘要的消息（带上守护进程给的写法），这一轮的回复不当成回复（不报 message_final），
//   result 的文字就是摘要（handoff_written），用量记成 handoff；出错的 result 报没写成；到点打断、报没写成。
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
import { runClaudeChild } from "../../src/claude-code/child/child.ts";
import type { ClaudeQueryFunction } from "../../src/claude-code/child/session.ts";
import { type AgentReport, HOST_PROTOCOL_VERSION, type HostCommand, type SessionAssembly } from "../../src/runtime/index.ts";
import { encodeLine, readJsonLines } from "../../src/runtime/line-channel.ts";
import { fauxModel } from "../helpers/daemon.ts";
import { createFakeClaudeSdk, FAKE_COMMANDS, inputText, sdk, sdkReply } from "../helpers/fake-claude-sdk.ts";
import { ReportLog } from "../helpers/report-log.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function assemblyOf(overrides: Partial<SessionAssembly> = {}): SessionAssembly {
  return {
    agentId: "claude-test",
    cwd: makeTempDir("ergo-claude-cwd-"),
    sessionDir: makeTempDir("ergo-claude-sessions-"),
    piAgentDir: "",
    model: fauxModel([]),
    credentials: {},
    tools: [],
    contributions: { tools: [], contextBlocks: [], hooks: [] },
    skillPaths: [],
    systemPrompt: "你是二狗的维护者。",
    continueSession: true,
    forwardToolCalls: false,
    shellEnv: {},
    heartbeatIntervalMs: 60_000,
    ...overrides,
  };
}

/** 在本进程里跑一个适配子进程，SDK 是手动挡的假的；wrap 可以改假 SDK 交出的 query（去掉清单接口这类） */
function startChild(options: { session?: Partial<SessionAssembly>; wrap?: (query: ClaudeQueryFunction) => ClaudeQueryFunction } = {}) {
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
  const child = runClaudeChild(
    { stdin, stdout, env: { PATH: "C:\\Windows" }, log: () => {}, exit: () => {} },
    { queryFor: () => (options.wrap ? options.wrap(fake.query) : fake.query), executable: null },
  );
  const send = (command: HostCommand) => stdin.write(encodeLine(command));
  send({ type: "start", protocolVersion: HOST_PROTOCOL_VERSION, session: assemblyOf(options.session) });
  onTestFinished(() => child.shutdown(0));
  return { fake, send, log };
}

describe("Claude Code 适配子进程：选的值、命令和模型清单、写交接摘要（289 号票）", () => {
  it("⚙ 里选的模型、思考档位、权限模式交给 query；跟 Claude Code 自己的设置、不认得的不传", async () => {
    const chosen = startChild({ session: { runtimeOptions: { model: "opus", settings: { effort: "high", permission_mode: "plan" } } } });
    await chosen.log.next("ready");
    const query = await chosen.fake.nth(1);
    expect(query.options).toMatchObject({ model: "opus", effort: "high", permissionMode: "plan" });

    const inherit = startChild({ session: { runtimeOptions: { settings: { effort: "inherit", permission_mode: "bypassPermissions" } } } });
    await inherit.log.next("ready");
    const plain = await inherit.fake.nth(1);
    expect(plain.options.model).toBeUndefined();
    expect(plain.options.effort).toBeUndefined();
    expect(plain.options.permissionMode).toBeUndefined();
  });

  it("起来后报一次模型和命令；每轮开头按 system/init 再报命令（终端专用的不报、说明照之前的补）；中途 commands_changed 整份换掉", async () => {
    const child = startChild();
    await child.log.next("ready");
    const first = await child.log.next("runtime_catalog");
    expect(first.models).toEqual([
      { id: "sonnet", title: "Sonnet" },
      { id: "opus", title: "Opus" },
    ]);
    expect(first.commands?.map((c) => c.name)).toEqual(FAKE_COMMANDS.map((c) => c.name));
    expect(first.commands?.[0]).toEqual({ name: "compact", description: FAKE_COMMANDS[0]!.description, argumentHint: FAKE_COMMANDS[0]!.argumentHint });

    child.send({ type: "user_input", inputId: "in-1", text: "看看现在的上下文" });
    const query = await child.fake.nth(1);
    const input = await query.nextInput();
    query.emit({ ...sdk.init(query.sessionId), slash_commands: ["compact", "review", "statusline", "my-skill"], terminal_slash_commands: ["statusline"] } as never);
    const perTurn = await child.log.next("runtime_catalog");
    expect(perTurn.models).toBeUndefined();
    expect(perTurn.commands).toEqual([
      { name: "compact", description: FAKE_COMMANDS[0]!.description, argumentHint: FAKE_COMMANDS[0]!.argumentHint },
      { name: "review", description: "Review a pull request" },
      { name: "my-skill", description: "" },
    ]);
    query.emit(...sdkReply("msg_1", { text: "上下文还很空。" }), sdk.result({ userMessageUuids: [input.uuid!] }));
    await child.log.next("turn_end");

    query.emit({ type: "system", subtype: "commands_changed", commands: [{ name: "deploy", description: "Deploy the app", argumentHint: "<env>" }], uuid: "u-1", session_id: "" } as never);
    const changed = await child.log.next("runtime_catalog");
    expect(changed.commands).toEqual([{ name: "deploy", description: "Deploy the app", argumentHint: "<env>" }]);
  });

  it("SDK 没有清单接口（老版本）：起来时不报，命令等 system/init 再报", async () => {
    const child = startChild({
      wrap: (query) => (params) => {
        const q = query(params);
        return { [Symbol.asyncIterator]: () => q[Symbol.asyncIterator](), interrupt: () => q.interrupt(), close: () => q.close() };
      },
    });
    await child.log.next("ready");
    child.send({ type: "user_input", inputId: "in-1", text: "你好" });
    const query = await child.fake.nth(1);
    await query.nextInput();
    expect(child.log.ofType("runtime_catalog")).toEqual([]);
    query.emit(sdk.init(query.sessionId));
    const perTurn = await child.log.next("runtime_catalog");
    expect(perTurn.commands?.map((c) => c.name)).toEqual(FAKE_COMMANDS.map((c) => c.name));
    expect(perTurn.commands?.every((c) => c.description === "")).toBe(true);
  });

  it("write_handoff：请 Claude 照写法写摘要，回复不当成回复；result 的文字就是摘要，用量记成 handoff", async () => {
    const child = startChild();
    await child.log.next("ready");
    child.send({ type: "write_handoff", requestId: "h-1", instructions: "MARKER_HANDOFF_INSTRUCTIONS 写清做到哪了", timeoutMs: 60_000 });
    const query = await child.fake.nth(1);
    const input = await query.nextInput();
    expect(inputText(input)).toContain("交接摘要");
    expect(inputText(input)).toContain("MARKER_HANDOFF_INSTRUCTIONS 写清做到哪了");
    query.emit(sdk.init(query.sessionId), ...sdkReply("msg_h", { text: "做到第二步了。" }), sdk.result({ result: "做到第二步了。", usage: { input_tokens: 500, output_tokens: 30 } }));
    const written = await child.log.next("handoff_written");
    expect(written).toEqual({ type: "handoff_written", requestId: "h-1", text: "做到第二步了。" });
    expect(child.log.ofType("message_final")).toEqual([]);
    expect(child.log.ofType("turn_end")).toEqual([]);
    const usage = child.log.ofType("usage");
    expect(usage.map((u) => u.purpose)).toContain("handoff");

    // 之后照常一轮（回复照常转）
    child.send({ type: "user_input", inputId: "in-2", text: "接着来" });
    const next = await query.nextInput();
    query.emit(...sdkReply("msg_2", { text: "好的。" }), sdk.result({ userMessageUuids: [next.uuid!] }));
    await child.log.next("turn_end");
    expect(child.log.ofType("message_final")).toHaveLength(1);
  });

  it("write_handoff 没写成：出错的 result 报原因；到点没写完打断、报超时", async () => {
    const failed = startChild();
    await failed.log.next("ready");
    failed.send({ type: "write_handoff", requestId: "h-1", instructions: "写", timeoutMs: 60_000 });
    const query = await failed.fake.nth(1);
    await query.nextInput();
    query.emit(sdk.result({ subtype: "error_during_execution", isError: true, errors: ["API Error: overloaded"] }));
    expect(await failed.log.next("handoff_written")).toEqual({ type: "handoff_written", requestId: "h-1", error: "API Error: overloaded" });

    const slow = startChild();
    await slow.log.next("ready");
    slow.send({ type: "write_handoff", requestId: "h-2", instructions: "写", timeoutMs: 200 });
    const stuck = await slow.fake.nth(1);
    await stuck.nextInput();
    stuck.onInterrupt = () => stuck.emit(sdk.result({ subtype: "error_during_execution", isError: true, errors: ["interrupted"] }));
    const timedOut = await slow.log.next("handoff_written");
    expect(timedOut.error).toContain("没有结束");
    expect(stuck.interrupts).toBe(1);
  });
});
