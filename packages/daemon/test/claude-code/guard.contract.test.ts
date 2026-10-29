// Claude Code 适配子进程的守卫和提问（288 号票）：交给 SDK 的 PreToolUse 钩子是全量闸口，每次工具调用（子代理里的也算）发 guard_request、
// 等 guard_reply——拦下、按计划改参数后放行、结果前面加话；Claude 自己要问用户的（AskUserQuestion、ExitPlanMode）到 canUseTool 变成 ask_user，
// 等 ask_user_reply。SDK 是假的（helpers/fake-claude-sdk.ts 的 runTool 扮演 claude 执行工具之前的权限流程），测试扮演守护进程回判定、回答；
// 适配子进程是真的（runClaudeChild，stdin / stdout 换成内存里的流）。不启动真的 claude、不花额度。
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
import { runClaudeChild } from "../../src/claude-code/child/child.ts";
import { fromGuardArgs, toGuardCall } from "../../src/claude-code/child/guard.ts";
import { type AgentReport, HOST_PROTOCOL_VERSION, type HostCommand, type SessionAssembly } from "../../src/runtime/index.ts";
import { encodeLine, readJsonLines } from "../../src/runtime/line-channel.ts";
import { fauxModel } from "../helpers/daemon.ts";
import { createFakeClaudeSdk, type FakeClaudeQuery, sdk, sdkReply } from "../helpers/fake-claude-sdk.ts";
import { ReportLog } from "../helpers/report-log.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function startChild(session: Partial<SessionAssembly> = {}) {
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
    { queryFor: () => fake.query, executable: null },
  );
  const assembly: SessionAssembly = {
    agentId: "claude-guard-test",
    cwd: makeTempDir("ergo-claude-cwd-"),
    sessionDir: makeTempDir("ergo-claude-sessions-"),
    piAgentDir: "",
    model: fauxModel([]),
    credentials: {},
    tools: [],
    contributions: { tools: [], contextBlocks: [], hooks: [] },
    skillPaths: [],
    continueSession: true,
    forwardToolCalls: true,
    shellEnv: {},
    heartbeatIntervalMs: 60_000,
    ...session,
  };
  const send = (command: HostCommand) => stdin.write(encodeLine(command));
  send({ type: "start", protocolVersion: HOST_PROTOCOL_VERSION, session: assembly });
  onTestFinished(() => child.shutdown(0));
  return { fake, send, log };
}

type Child = ReturnType<typeof startChild>;

/** 拉起、送一条输入，交回假 SDK 的 query 和那条用户消息 */
async function turn(child: Child, text = "干活") {
  await child.log.next("ready");
  child.send({ type: "user_input", inputId: "in-1", text });
  const query = await child.fake.nth(1);
  const input = await query.nextInput();
  return { query, input };
}

/** 模型调用一个工具：一条回复（逐字输出、定稿），再扮演 claude 走权限流程（等适配子进程的钩子） */
function callTool(query: FakeClaudeQuery, id: string, name: string, input: Record<string, unknown>) {
  query.emit(...sdkReply(`msg_${id}`, { toolCalls: [{ id, name, input }] }));
  return query.runTool(id, name, input);
}

describe("Claude Code 的工具调用都过二狗守卫（假 SDK）", () => {
  it("交给 SDK 的是 PreToolUse 钩子（全量闸口，超时给足）和 canUseTool，不再是 permissionPrompts: none", async () => {
    const child = startChild();
    const { query } = await turn(child);
    expect(query.options.permissionPrompts).toBeUndefined();
    expect(typeof query.options.canUseTool).toBe("function");
    const pre = query.options.hooks?.PreToolUse ?? [];
    expect(pre).toHaveLength(1);
    expect(pre[0]!.matcher).toBeUndefined();
    expect(pre[0]!.timeout).toBeGreaterThanOrEqual(3600);
    expect(query.options.hooks?.PostToolUse).toHaveLength(1);
  });

  it("Bash 被守卫拦下：开始在前、判定请求在后，映射成守卫的 bash（原样的在 native 里）；模型收到守卫的说明，工具调用结束是出错", async () => {
    const child = startChild();
    const { query } = await turn(child);
    const run = callTool(query, "toolu_1", "Bash", { command: "rm -rf ~/.ergo/config", description: "删配置" });
    const request = await child.log.next("guard_request");
    expect(request).toMatchObject({ toolCallId: "toolu_1", toolName: "bash", args: { command: "rm -rf ~/.ergo/config" }, native: { toolName: "Bash", args: { command: "rm -rf ~/.ergo/config", description: "删配置" } } });
    const order = child.log.reports.map((r) => r.type).filter((t) => ["message_final", "tool_call_start", "guard_request"].includes(t));
    expect(order).toEqual(["message_final", "tool_call_start", "guard_request"]);
    child.send({ type: "guard_reply", requestId: request.requestId, verdict: { allow: false, reason: "写受保护区域：永不" } });
    expect(await run).toMatchObject({ allowed: false, decision: "deny", denial: "写受保护区域：永不" });
    query.emit(sdk.toolResult("toolu_1", "写受保护区域：永不", { isError: true }));
    expect(await child.log.next("tool_call_end")).toMatchObject({ toolCallId: "toolu_1", toolName: "Bash", isError: true, resultText: "写受保护区域：永不" });
  });

  it("按计划改了参数：参数映射回 Bash 的（别的字段照留）、allow 带 updatedInput；结果前面的话经 PostToolUse 交给模型，记录里的结果也以它开头", async () => {
    const child = startChild();
    const { query } = await turn(child);
    const run = callTool(query, "toolu_1", "Bash", { command: "echo bye > notes.md", description: "写周报", timeout: 60_000 });
    const request = await child.log.next("guard_request");
    child.send({ type: "guard_reply", requestId: request.requestId, verdict: { allow: true, args: { command: "echo hi > notes.md" }, resultPrefix: "【自动纠偏】已按计划改回。" } });
    expect(await run).toMatchObject({ allowed: true, decision: "allow", input: { command: "echo hi > notes.md", description: "写周报", timeout: 60_000 }, context: "【自动纠偏】已按计划改回。" });
    query.emit(sdk.toolResult("toolu_1", "（写好了）"));
    expect(await child.log.next("tool_call_end")).toMatchObject({ toolCallId: "toolu_1", isError: false, resultText: "【自动纠偏】已按计划改回。\n（写好了）" });
  });

  it("放行时不给决定（Claude Code 自己的规则照常）；它自己的规则要问人时到 canUseTool，守卫放行过的直接放行；守卫没判过的不放行", async () => {
    const child = startChild();
    const { query } = await turn(child);
    query.permissionAsks.add("Write");
    const run = callTool(query, "toolu_1", "Write", { file_path: "a.md", content: "x" });
    const request = await child.log.next("guard_request");
    expect(request).toMatchObject({ toolName: "write", args: { path: "a.md", content: "x" } });
    child.send({ type: "guard_reply", requestId: request.requestId, verdict: { allow: true } });
    expect(await run).toMatchObject({ allowed: true, asked: true, input: { file_path: "a.md", content: "x" } });
    expect((await run).decision).toBeUndefined();
    const canUseTool = query.options.canUseTool!;
    expect(await canUseTool("Write", { file_path: "b.md" }, { signal: new AbortController().signal, toolUseID: "never-guarded", requestId: "r" })).toMatchObject({ behavior: "deny" });
  });

  it("子代理里的调用也过守卫：开始带 parentToolCallId、在判定请求之前；Grep 映射成 grep；结束也挂在 Agent 下面", async () => {
    const child = startChild();
    const { query } = await turn(child);
    const agent = callTool(query, "toolu_agent", "Agent", { description: "查资料", prompt: "查一下 TODO" });
    const first = await child.log.next("guard_request");
    expect(first).toMatchObject({ toolCallId: "toolu_agent", toolName: "Agent", args: { description: "查资料", prompt: "查一下 TODO" } });
    expect(first.native).toEqual({ toolName: "Agent", args: { description: "查资料", prompt: "查一下 TODO" } });
    child.send({ type: "guard_reply", requestId: first.requestId, verdict: { allow: true } });
    expect(await agent).toMatchObject({ allowed: true });

    query.emit(sdk.assistant("msg_sub_1", sdk.toolUse("toolu_sub", "Grep", { pattern: "TODO", path: "src" }), { parent: "toolu_agent" }));
    const sub = query.runTool("toolu_sub", "Grep", { pattern: "TODO", path: "src" }, { agentId: "agent-1" });
    const request = await child.log.next("guard_request");
    expect(request).toMatchObject({ toolCallId: "toolu_sub", toolName: "grep", args: { pattern: "TODO", path: "src" } });
    const starts = child.log.ofType("tool_call_start");
    expect(starts.at(-1)).toEqual({ type: "tool_call_start", toolCallId: "toolu_sub", toolName: "Grep", args: { pattern: "TODO", path: "src" }, parentToolCallId: "toolu_agent" });
    expect(child.log.reports.findIndex((r) => r.type === "tool_call_start" && r.toolCallId === "toolu_sub")).toBeLessThan(child.log.reports.indexOf(request));
    child.send({ type: "guard_reply", requestId: request.requestId, verdict: { allow: false, reason: "子代理不能读这里" } });
    expect(await sub).toMatchObject({ allowed: false, denial: "子代理不能读这里" });
    query.emit(sdk.toolResult("toolu_sub", "子代理不能读这里", { isError: true, parent: "toolu_agent" }));
    expect(await child.log.next("tool_call_end")).toMatchObject({ toolCallId: "toolu_sub", parentToolCallId: "toolu_agent", isError: true });
  });

  it("钩子比回复的 message_stop 先到（Claude Code 一块工具调用写完就开始执行）：钩子先报开始，定稿时不再重复报", async () => {
    const child = startChild();
    const { query } = await turn(child);
    query.emit(sdk.messageStart("msg_1"), sdk.assistant("msg_1", sdk.toolUse("toolu_1", "Read", { file_path: "a.md" })));
    const run = query.runTool("toolu_1", "Read", { file_path: "a.md" });
    const request = await child.log.next("guard_request");
    expect(request).toMatchObject({ toolName: "read", args: { path: "a.md" } });
    expect(child.log.ofType("tool_call_start")).toEqual([{ type: "tool_call_start", toolCallId: "toolu_1", toolName: "Read", args: { file_path: "a.md" } }]);
    child.send({ type: "guard_reply", requestId: request.requestId, verdict: { allow: true } });
    await run;
    query.emit(sdk.messageDelta("tool_use", { output_tokens: 5 }), sdk.messageStop());
    await child.log.next("message_final");
    expect(child.log.ofType("tool_call_start")).toHaveLength(1);
  });

  it("AskUserQuestion：守卫放行后要问人（ask），到 canUseTool 报 ask_user；回答按 SDK 的写法交回（多选的用逗号连起来，自己写的也算）；不答是拒绝", async () => {
    const child = startChild();
    const { query } = await turn(child);
    const questions = [
      { question: "用哪个日期库？", header: "日期库", options: [{ label: "dayjs", description: "小" }, { label: "date-fns", description: "函数式" }], multiSelect: false },
      { question: "要哪些功能？", header: "功能", options: [{ label: "时区", description: "" }, { label: "相对时间", description: "" }], multiSelect: true },
    ];
    const run = callTool(query, "toolu_q", "AskUserQuestion", { questions });
    const request = await child.log.next("guard_request");
    expect(request).toMatchObject({ toolName: "AskUserQuestion" });
    child.send({ type: "guard_reply", requestId: request.requestId, verdict: { allow: true } });
    const ask = await child.log.next("ask_user");
    expect(ask).toMatchObject({ toolCallId: "toolu_q", question: { kind: "choices", questions } });
    expect(ask.subAgent).toBeUndefined();
    child.send({
      type: "ask_user_reply",
      requestId: ask.requestId,
      reply: {
        kind: "choices",
        answers: [
          { question: "用哪个日期库？", selected: ["dayjs"] },
          { question: "要哪些功能？", selected: ["时区", "相对时间"], other: "农历" },
        ],
      },
    });
    expect(await run).toMatchObject({ allowed: true, decision: "ask", asked: true, input: { questions, answers: { "用哪个日期库？": "dayjs", "要哪些功能？": "时区, 相对时间, 农历" } } });

    const second = callTool(query, "toolu_q2", "AskUserQuestion", { questions: [questions[0]] });
    child.send({ type: "guard_reply", requestId: (await child.log.next("guard_request")).requestId, verdict: { allow: true } });
    child.send({ type: "ask_user_reply", requestId: (await child.log.next("ask_user")).requestId, reply: { kind: "declined" } });
    expect(await second).toMatchObject({ allowed: false, denial: expect.stringContaining("用户没有回答这些问题") });
  });

  it("退出计划模式：批准就放行（附的话经 PostToolUse 交给模型），打回就拒绝并转达你的话", async () => {
    const child = startChild();
    const { query } = await turn(child);
    const approve = callTool(query, "toolu_p1", "ExitPlanMode", { plan: "1. 读代码\n2. 改" });
    child.send({ type: "guard_reply", requestId: (await child.log.next("guard_request")).requestId, verdict: { allow: true } });
    const ask = await child.log.next("ask_user");
    expect(ask.question).toEqual({ kind: "plan", plan: "1. 读代码\n2. 改" });
    child.send({ type: "ask_user_reply", requestId: ask.requestId, reply: { kind: "plan", approved: true, note: "先别动测试" } });
    expect(await approve).toMatchObject({ allowed: true, context: expect.stringContaining("先别动测试") });

    const reject = callTool(query, "toolu_p2", "ExitPlanMode", { plan: "直接重写" });
    child.send({ type: "guard_reply", requestId: (await child.log.next("guard_request")).requestId, verdict: { allow: true } });
    child.send({ type: "ask_user_reply", requestId: (await child.log.next("ask_user")).requestId, reply: { kind: "plan", approved: false, note: "范围太大" } });
    expect(await reject).toMatchObject({ allowed: false, denial: expect.stringContaining("范围太大") });
  });

  it("打断：等着的判定按不放行收尾（回合已中止）；之后才到的判定、不认得的回答回 bad_command", async () => {
    const child = startChild();
    const { query } = await turn(child);
    const run = callTool(query, "toolu_1", "Bash", { command: "sleep 100" });
    const request = await child.log.next("guard_request");
    child.send({ type: "abort" });
    expect(await run).toMatchObject({ allowed: false, denial: "回合已中止" });
    child.send({ type: "guard_reply", requestId: request.requestId, verdict: { allow: true } });
    expect(await child.log.next("error")).toMatchObject({ code: "bad_command" });
    child.send({ type: "ask_user_reply", requestId: "ask-404", reply: { kind: "declined" } });
    expect(await child.log.next("error")).toMatchObject({ code: "bad_command" });
  });
});

describe("Claude 的工具名映射到守卫的工具登记表", () => {
  it("能对上二狗工具的换过去，别的照原名原样", () => {
    expect(toGuardCall("Bash", { command: "ls", description: "列", run_in_background: true })).toEqual({ toolName: "bash", args: { command: "ls" } });
    expect(toGuardCall("PowerShell", { command: "Get-ChildItem 'C:\\'" })).toEqual({ toolName: "bash", args: { command: `powershell -Command 'Get-ChildItem '\\''C:\\'\\'''` } });
    expect(toGuardCall("Read", { file_path: "a.md", offset: 3 })).toEqual({ toolName: "read", args: { path: "a.md" } });
    expect(toGuardCall("Write", { file_path: "a.md", content: "x" })).toEqual({ toolName: "write", args: { path: "a.md", content: "x" } });
    expect(toGuardCall("Edit", { file_path: "a.md", old_string: "a", new_string: "b", replace_all: true })).toEqual({ toolName: "edit", args: { path: "a.md", edits: [{ oldText: "a", newText: "b" }] } });
    expect(toGuardCall("MultiEdit", { file_path: "a.md", edits: [{ old_string: "a", new_string: "b" }] })).toEqual({ toolName: "edit", args: { path: "a.md", edits: [{ oldText: "a", newText: "b" }] } });
    expect(toGuardCall("NotebookEdit", { notebook_path: "n.ipynb", new_source: "print(1)" })).toEqual({ toolName: "edit", args: { path: "n.ipynb", edits: [{ oldText: "", newText: "print(1)" }] } });
    expect(toGuardCall("Glob", { pattern: "**/*.ts" })).toEqual({ toolName: "find", args: { pattern: "**/*.ts" } });
    expect(toGuardCall("Grep", { pattern: "TODO", path: "src", output_mode: "content" })).toEqual({ toolName: "grep", args: { pattern: "TODO", path: "src" } });
    expect(toGuardCall("WebFetch", { url: "https://example.com", prompt: "摘要" })).toEqual({ toolName: "web_fetch", args: { url: "https://example.com" } });
    expect(toGuardCall("WebSearch", { query: "ergo", allowed_domains: [] })).toEqual({ toolName: "web_search", args: { query: "ergo" } });
    expect(toGuardCall("TodoWrite", { todos: [] })).toEqual({ toolName: "TodoWrite", args: { todos: [] } });
    expect(toGuardCall("mcp__github__create_issue", { title: "x" })).toEqual({ toolName: "mcp__github__create_issue", args: { title: "x" } });
  });

  it("守卫按计划改过的参数换回 Claude 的；换不回去的（PowerShell、一次改几处的 Edit）是 undefined；没映射的直接用改过的", () => {
    expect(fromGuardArgs("Write", { file_path: "a.md", content: "x" }, { path: "a.md", content: "# 周报" })).toEqual({ file_path: "a.md", content: "# 周报" });
    expect(fromGuardArgs("Edit", { file_path: "a.md", old_string: "a", new_string: "b", replace_all: true }, { path: "a.md", edits: [{ oldText: "a", newText: "c" }] })).toEqual({
      file_path: "a.md",
      old_string: "a",
      new_string: "c",
      replace_all: true,
    });
    expect(fromGuardArgs("Edit", { file_path: "a.md" }, { path: "a.md", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] })).toBeUndefined();
    expect(fromGuardArgs("PowerShell", { command: "dir" }, { command: "ls" })).toBeUndefined();
    expect(fromGuardArgs("TodoWrite", { todos: [1] }, { todos: [2] })).toEqual({ todos: [2] });
  });
});
