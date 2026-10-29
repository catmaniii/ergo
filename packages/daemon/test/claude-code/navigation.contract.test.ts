// Claude Code 适配子进程的撤回和切分支（293 号票，宿主协议 navigate_session，child/navigation.ts）的契约测试。SDK 换成手动挡的假的
// （helpers/fake-claude-sdk.ts：测试扮演 claude 一条条吐消息；会话记录、forkSession、getSessionMessages、文件检查点在 FakeClaudeStore 里），
// 不启动真的 claude、不花额度；适配子进程本身是真的（runClaudeChild，stdin / stdout 换成内存里的流）。真机在 294 号票。
// - 撤回到某条输入之前：从它前一条分叉出新会话（截到那一条），活着的 query 按检查点把那条及之后改的文件恢复，关掉手头的 query，
//   下一条按新会话 id 恢复；守护进程写好的分支摘要随新会话的下一条输入的 UserPromptSubmit 交给模型、只交一次；记录写进会话记录；
// - 撤回到会话开头之前：新开一个空会话（新 id、新开不恢复）；撤回点在更早的会话里：一路往上恢复文件（现在的会话恢复到它自己的第一条，
//   更早的那个会话临时起一个 query 恢复，只做这一件、不加载用户设置）；
// - 切到废弃分支：接着那个会话 id，不分叉、不动文件；撤回到这条分支开始前：照它当初分叉的地方再分叉；
// - 撤回到一次工具调用前后（阶段、步骤开始前）：before 回到那次回复之前、after 回到那几条工具结果之后，文件不恢复；
// - 撤回不了的（没记下的输入、没接会话函数、守护进程要它自己写摘要）：回原因，会话不动。
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
import { runClaudeChild } from "../../src/claude-code/child/child.ts";
import { RECORD_EXT } from "../../src/claude-code/child/records.ts";
import { type AgentReport, HOST_PROTOCOL_VERSION, type HostCommand, type NavigateTarget, type SessionAssembly } from "../../src/runtime/index.ts";
import { encodeLine, readJsonLines } from "../../src/runtime/line-channel.ts";
import { fauxModel } from "../helpers/daemon.ts";
import { createFakeClaudeSdk, type FakeClaudeQuery, sdk, sdkReply } from "../helpers/fake-claude-sdk.ts";
import { ReportLog } from "../helpers/report-log.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function assemblyOf(): SessionAssembly {
  return {
    agentId: "claude-nav",
    cwd: makeTempDir("ergo-claude-nav-cwd-"),
    sessionDir: makeTempDir("ergo-claude-nav-sessions-"),
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
  };
}

/** 在本进程里跑一个适配子进程，SDK 是手动挡的假的；withSessions 是 false 时不接撤回用的会话函数 */
function startChild(withSessions = true) {
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
  const child = runClaudeChild(
    { stdin, stdout, env: { PATH: "C:\\Windows" }, log: (line) => logs.push(line), exit: () => {} },
    { queryFor: () => fake.query, executable: null, ...(withSessions ? { sessionsFor: () => fake.sessions } : {}) },
  );
  const assembly = assemblyOf();
  const send = (command: HostCommand) => stdin.write(encodeLine(command));
  send({ type: "start", protocolVersion: HOST_PROTOCOL_VERSION, session: assembly });
  onTestFinished(() => child.shutdown(0));
  return { fake, send, log, logs, assembly };
}

type Child = ReturnType<typeof startChild>;

/**
 * 一轮：送一条输入，等假 SDK 收到（第 nth 个 query），扮演 claude 回一句（writes 里的文件这一轮写上、记进检查点），收到 turn_end 才回。
 * 交回这一轮的 query 和那条用户消息的 uuid
 */
async function turn(child: Child, nth: number, inputId: string, text: string, opts: { reply?: string; writes?: Record<string, string> } = {}): Promise<{ query: FakeClaudeQuery; uuid: string; context: string }> {
  const ends = child.log.ofType("turn_end").length;
  child.send({ type: "user_input", inputId, text });
  const query = await child.fake.nth(nth);
  const input = await query.nextInput();
  // 扮演 Claude Code 处理这条输入之前叫钩子（SessionStart、UserPromptSubmit）
  const context = await query.promptHooks(input);
  for (const [file, content] of Object.entries(opts.writes ?? {})) query.store.writeFile(query.sessionId, input.uuid!, file, content);
  query.emit(sdk.init(query.sessionId), ...sdkReply(`msg_${inputId}`, { text: opts.reply ?? `收到：${text}` }), sdk.result({ userMessageUuids: [input.uuid!], queuedTurnCount: 0 }));
  await waitFor(() => child.log.ofType("turn_end").length > ends, `等 ${inputId} 这一轮结束`);
  return { query, uuid: input.uuid!, context };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what}超时`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let seq = 0;
/** 送一条 navigate_session，等它的结果 */
async function navigate(child: Child, target: NavigateTarget, change: "rollback" | "switch", written?: string) {
  const requestId = `nav-${++seq}`;
  child.send({ type: "navigate_session", requestId, target, marker: { branchId: `b${seq}`, change }, ...(written === undefined ? {} : { summary: { written } }) });
  for (;;) {
    const report = await child.log.next("session_navigated");
    if (report.requestId === requestId) return report;
  }
}

/** 会话记录（会话目录里唯一的那份） */
function recordOf(child: Child): { claudeSessionId: string; started: boolean; lineage?: { inputs: Record<string, unknown>; notes: Record<string, string> } } {
  const [file] = fs.readdirSync(child.assembly.sessionDir).filter((f) => f.endsWith(RECORD_EXT));
  return JSON.parse(fs.readFileSync(path.join(child.assembly.sessionDir, file!), "utf8"));
}

describe("Claude Code 适配子进程的撤回和切分支（假 SDK）", () => {
  it("撤回到某条输入之前：从它前一条分叉出新会话、按检查点恢复文件、下一条按新会话恢复，写好的分支摘要随下一条输入交一次", async () => {
    const child = startChild();
    const ready = await child.log.next("ready");
    const notes = path.join(child.assembly.cwd, "notes.md");
    const first = await turn(child, 1, "in-1", "看看网盘", { reply: "网盘 2 TB" });
    // 开了文件检查点
    expect(first.query.options.enableFileCheckpointing).toBe(true);
    const second = await turn(child, 1, "in-2", "记个笔记", { writes: { [notes]: "# 笔记\n" } });
    expect(fs.existsSync(notes)).toBe(true);
    const chain = child.fake.store.messages(ready.sessionId);
    const anchor = chain[chain.findIndex((m) => m.uuid === second.uuid) - 1]!;

    const done = await navigate(child, { beforeInput: "in-2" }, "rollback", "SUMMARY-CONTEXT：记了笔记");
    const [fork] = child.fake.store.forks;
    expect(fork).toMatchObject({ from: ready.sessionId, upTo: anchor.uuid });
    // 截到第一条回复（in-2 之前的那一条）
    expect(anchor).toMatchObject({ type: "assistant" });
    expect(done).toEqual({ type: "session_navigated", requestId: expect.any(String), ok: true, from: ready.sessionId, at: fork!.to, files: { restored: [notes] } });
    // 活着的 query 按检查点恢复：恢复到 in-2 那条时
    expect(child.fake.store.rewinds).toEqual([{ session: ready.sessionId, uuid: second.uuid, files: [notes] }]);
    expect(fs.existsSync(notes)).toBe(false);
    expect(first.query.closed).toBe(true);
    expect(recordOf(child)).toMatchObject({ claudeSessionId: fork!.to, started: true, lineage: { notes: { [fork!.to]: "SUMMARY-CONTEXT：记了笔记" } } });

    // 下一条：按新会话 id 恢复（新的 query），分支摘要随它的 UserPromptSubmit 交给模型
    const third = await turn(child, 2, "in-3", "照片多大");
    expect(third.query.options.resume).toBe(fork!.to);
    expect(third.query.options.sessionId).toBeUndefined();
    expect(third.context).toContain("SUMMARY-CONTEXT：记了笔记");
    // 新会话的主线：复制来的那段（到第一条回复为止）加上这条
    expect(child.fake.store.messages(fork!.to).map((m) => m.type)).toEqual(["user", "assistant", "user", "assistant"]);
    // 只交一次
    const fourth = await turn(child, 2, "in-4", "再说说");
    expect(fourth.context).not.toContain("SUMMARY-CONTEXT");
    expect(recordOf(child).lineage?.notes).toEqual({});
  });

  it("撤回到会话开头之前新开空会话；撤回点在更早的会话里时一路往上恢复文件（更早的会话临时起 query）；切到废弃分支接着那个会话", async () => {
    const child = startChild();
    const ready = await child.log.next("ready");
    const [a, b, c] = ["a.md", "b.md", "c.md"].map((f) => path.join(child.assembly.cwd, f)) as [string, string, string];
    const first = await turn(child, 1, "in-1", "写 a", { writes: { [a]: "a" } });
    await turn(child, 1, "in-2", "写 b", { writes: { [b]: "b" } });
    const s0 = ready.sessionId;
    const toS1 = await navigate(child, { beforeInput: "in-2" }, "rollback");
    expect(toS1).toMatchObject({ ok: true, from: s0, files: { restored: [b] } });
    const s1 = toS1.ok ? toS1.at : "";
    const third = await turn(child, 2, "in-3", "写 c", { writes: { [c]: "c" } });
    expect([a, b, c].map((f) => fs.existsSync(f))).toEqual([true, false, true]);

    // 撤回到 in-1 之前（在更早的会话 s0 里、是它的第一条）：新开空会话，不分叉；文件：s1 恢复到它的第一条（c 没了），s0 恢复到 in-1（a 没了）
    const toS2 = await navigate(child, { beforeInput: "in-1" }, "rollback");
    expect(toS2).toMatchObject({ ok: true, from: s1, files: { restored: [c, a] } });
    const s2 = toS2.ok ? toS2.at : "";
    expect(child.fake.store.forks).toHaveLength(1);
    expect(child.fake.store.has(s2)).toBe(false);
    expect([a, b, c].map((f) => fs.existsSync(f))).toEqual([false, false, false]);
    expect(child.fake.store.rewinds.slice(1)).toEqual([
      { session: s1, uuid: third.uuid, files: [c] },
      { session: s0, uuid: first.uuid, files: [a] },
    ]);
    // 更早的会话临时起的 query：接着 s0、开检查点、不加载用户设置、不推输入，做完就关
    const temp = child.fake.queries.find((q) => q.options.resume === s0 && q !== first.query)!;
    expect(temp.options).toMatchObject({ enableFileCheckpointing: true, settingSources: [] });
    expect(temp.inputs).toEqual([]);
    expect(temp.closed).toBe(true);
    // 新开的空会话：下一条新开（sessionId，不是 resume）
    const fourth = await turn(child, child.fake.queries.length + 1, "in-4", "从头来");
    expect(fourth.query.options).toMatchObject({ sessionId: s2 });
    expect(fourth.query.options.resume).toBeUndefined();

    // 切到废弃分支 s1：接着它，不分叉、不动文件
    const back = await navigate(child, { entry: s1 }, "switch");
    expect(back).toEqual({ type: "session_navigated", requestId: expect.any(String), ok: true, from: s2, at: s1 });
    expect(child.fake.store.forks).toHaveLength(1);
    expect(child.fake.store.rewinds).toHaveLength(3);
    const fifth = await turn(child, child.fake.queries.length + 1, "in-5", "接着");
    expect(fifth.query.options.resume).toBe(s1);

    // 撤回到 s1 这条分支开始前：照它当初分叉的地方（s0 截到第一条之后那一条）再分叉，文件恢复到 s1 的第一条输入
    const restart = await navigate(child, { entry: s1 }, "rollback");
    const [, again] = child.fake.store.forks;
    expect(again).toMatchObject({ from: s0, upTo: child.fake.store.forks[0]!.upTo });
    expect(restart).toMatchObject({ ok: true, from: s1, at: again!.to, files: { restored: [] } });
  });

  it("撤回到一次工具调用前后：before 回到那次回复之前、after 回到那几条工具结果之后；文件不恢复", async () => {
    const child = startChild();
    const ready = await child.log.next("ready");
    child.send({ type: "user_input", inputId: "in-1", text: "开始第二阶段" });
    const query = await child.fake.nth(1);
    const input = await query.nextInput();
    query.emit(
      sdk.init(query.sessionId),
      ...sdkReply("msg_a", { text: "我来开始这个阶段。", toolCalls: [{ id: "toolu_stage", name: "mcp__ergo__start_stage", input: { stageId: "s2" } }] }),
      sdk.toolResult("toolu_stage", "阶段 s2 开始了"),
      ...sdkReply("msg_b", { text: "开始了。" }),
      sdk.result({ userMessageUuids: [input.uuid!], queuedTurnCount: 0 }),
    );
    await child.log.next("turn_end");
    const chain = child.fake.store.messages(ready.sessionId);
    const types = chain.map((m) => m.type);
    expect(types).toEqual(["user", "assistant", "assistant", "user", "assistant"]);

    // after：回到工具结果之后（第 4 条）
    const after = await navigate(child, { afterCall: "toolu_stage" }, "rollback");
    expect(child.fake.store.forks[0]).toMatchObject({ from: ready.sessionId, upTo: chain[3]!.uuid });
    expect(after).toMatchObject({ ok: true, files: { restored: [], skipped: "call_point" } });
    expect(child.fake.store.rewinds).toEqual([]);

    // before（在分叉出来的会话里：复制来的条目换了新 uuid，工具调用 id 照旧）：回到那次回复（两条）之前，也就是那条用户消息
    const s1 = after.ok ? after.at : "";
    const copied = child.fake.store.messages(s1);
    await navigate(child, { beforeCall: "toolu_stage" }, "rollback");
    expect(child.fake.store.forks[1]).toMatchObject({ from: s1, upTo: copied[0]!.uuid });
  });

  it("撤回不了的：没记下的输入、没接会话函数、要它自己写分支摘要——回原因，会话不动", async () => {
    const child = startChild();
    const ready = await child.log.next("ready");
    await turn(child, 1, "in-1", "第一条");
    const unknown = await navigate(child, { beforeInput: "in-x" }, "rollback");
    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("没有交给 Claude Code 的记录") });
    child.send({ type: "navigate_session", requestId: "own", target: { beforeInput: "in-1" }, summary: { instructions: "写摘要" }, marker: { branchId: "b9", change: "rollback" } });
    const own = await child.log.next("session_navigated");
    expect(own).toMatchObject({ requestId: "own", ok: false, error: expect.stringContaining("不自己写分支摘要") });
    expect(child.fake.store.forks).toEqual([]);
    expect(recordOf(child).claudeSessionId).toBe(ready.sessionId);

    const bare = startChild(false);
    await bare.log.next("ready");
    await turn(bare, 1, "in-1", "第一条");
    expect(await navigate(bare, { beforeInput: "in-1" }, "rollback")).toMatchObject({ ok: false, error: expect.stringContaining("没接上分叉会话的函数") });
  });
});
