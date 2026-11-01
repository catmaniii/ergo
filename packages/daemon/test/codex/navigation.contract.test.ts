// Codex 适配子进程的撤回和切分支（宿主协议 navigate_session，child/navigation.ts）：thread/fork 的 beforeTurnId 从那一轮之前分叉出新 thread 接着用（0.166 没有 thread/rollback）。
// app-server 是假的，线程在 FakeCodexStore 里，分叉、接着都看得见。
import { describe, expect, it } from "vitest";
import type { NavigateTarget } from "../../src/runtime/index.ts";
import { type CodexChild, startCodexChild } from "../helpers/codex-child.ts";
import { type FakeCodexEcho, FakeCodexServer, type FakeStep } from "../helpers/fake-codex-app-server.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const replies = (n: number): FakeStep[][] => Array.from({ length: n }, (_, i) => [{ kind: "reply", text: `第 ${i + 1} 轮` }]);

/** session_navigated 报回的（成没成的字段都放一起，断言方便） */
interface Navigated {
  ok: boolean;
  from?: string;
  at?: string;
  files?: unknown;
  error?: string;
}

let seq = 0;
async function navigate(child: CodexChild, target: NavigateTarget, change: "rollback" | "switch" = "rollback", written?: string): Promise<Navigated> {
  const requestId = `n-${++seq}`;
  child.send({ type: "navigate_session", requestId, target, marker: { branchId: `b${seq}`, change }, ...(written === undefined ? {} : { summary: { written } }) });
  return child.log.next("session_navigated") as Promise<Navigated>;
}

const lastEcho = (child: CodexChild): FakeCodexEcho => JSON.parse((child.log.ofType("message_final").at(-1)!.message.parts[0] as { text: string }).text) as FakeCodexEcho;

describe("Codex 的撤回和切分支", () => {
  it("撤回到一条输入之前：从那一轮之前分叉出新 thread 接着用，原来的不动；只回对话（不报 files）", async () => {
    const child = startCodexChild({ server: { turns: replies(3) } });
    const ready = await child.log.next("ready");
    await child.turn("in-1", "一");
    await child.turn("in-2", "二");
    const original = child.server.store.threads[ready.sessionId]!;
    const secondTurn = original.turns[1]!.id;

    const done = await navigate(child, { beforeInput: "in-2" });
    expect(done).toMatchObject({ ok: true, from: ready.sessionId });
    expect(done.at).not.toBe(ready.sessionId);
    expect(done.files).toBeUndefined();
    expect(child.server.callsOf("thread/fork")).toMatchObject([{ threadId: ready.sessionId, beforeTurnId: secondTurn, approvalPolicy: "untrusted", approvalsReviewer: "user", excludeTurns: true }]);
    // 新 thread 只剩第一轮；原来的两轮都在（废弃分支）
    expect(child.server.store.threads[done.at!]!.turns).toHaveLength(1);
    expect(original.turns).toHaveLength(2);

    await child.turn("in-3", "三");
    expect(child.server.callsOf("turn/start").at(-1)).toMatchObject({ threadId: done.at });
    expect(child.server.store.threads[done.at!]!.turns).toHaveLength(2);
    expect(original.turns).toHaveLength(2);
  });

  it("撤回到二狗自己开的 thread 的第一条之前：没有历史可留，新开一个空 thread", async () => {
    const child = startCodexChild({ server: { turns: replies(2) } });
    const ready = await child.log.next("ready");
    await child.turn("in-1", "一");
    const done = await navigate(child, { beforeInput: "in-1" });
    expect(done).toMatchObject({ ok: true, from: ready.sessionId });
    expect(child.server.callsOf("thread/fork")).toEqual([]);
    expect(child.server.callsOf("thread/start")).toHaveLength(2);
    await child.turn("in-2", "二");
    expect(child.server.store.threads[done.at!]!.turns).toHaveLength(1);
  });

  it("切到废弃分支：接着那个 thread，不分叉；撤回到这条分支开始前：照它当初分叉的地方再分叉一次", async () => {
    const child = startCodexChild({ server: { turns: replies(5) } });
    const ready = await child.log.next("ready");
    await child.turn("in-1", "一");
    await child.turn("in-2", "二");
    const branch = await navigate(child, { beforeInput: "in-2" });
    await child.turn("in-3", "三");

    const back = await navigate(child, { entry: ready.sessionId }, "switch");
    expect(back).toMatchObject({ ok: true, from: branch.at, at: ready.sessionId });
    expect(child.server.callsOf("thread/fork")).toHaveLength(1);
    await child.turn("in-4", "四");
    expect(child.server.callsOf("thread/resume").at(-1) ?? { threadId: ready.sessionId }).toMatchObject({ threadId: ready.sessionId });
    expect(child.server.callsOf("turn/start").at(-1)).toMatchObject({ threadId: ready.sessionId });
    expect(child.server.store.threads[ready.sessionId]!.turns).toHaveLength(3);

    const entryRollback = await navigate(child, { entry: branch.at! });
    expect(entryRollback.ok).toBe(true);
    const forks = child.server.callsOf("thread/fork");
    expect(forks).toHaveLength(2);
    expect(forks[1]).toMatchObject({ threadId: ready.sessionId, beforeTurnId: forks[0]!.beforeTurnId });
    // 当前就是这个 thread 时不用切
    const same = await navigate(child, { entry: entryRollback.at! }, "switch");
    expect(same.ok).toBe(false);
  });

  it("分支摘要：Codex 不写（要二狗写好交来），下一条输入带给模型；要它自己写的回原因", async () => {
    const child = startCodexChild({ server: { turns: [...replies(2), [{ kind: "echo" }], [{ kind: "echo" }]] } });
    await child.log.next("ready");
    await child.turn("in-1", "一");
    await child.turn("in-2", "二");
    child.send({ type: "navigate_session", requestId: "n-x", target: { beforeInput: "in-2" }, marker: { branchId: "b", change: "rollback" }, summary: { instructions: "你写" } });
    const refused = await child.log.next("session_navigated");
    expect(refused).toMatchObject({ ok: false, error: "Codex 不自己写分支摘要（要二狗先写好交过来）" });

    const done = await navigate(child, { beforeInput: "in-2" }, "rollback", "被放弃的这段改了两个文件");
    expect(done.ok).toBe(true);
    await child.turn("in-3", "三");
    expect(lastEcho(child).additionalContext.join("\n")).toContain("被放弃的这段改了两个文件");
    await child.turn("in-4", "四");
    expect(lastEcho(child).additionalContext.join("\n")).not.toContain("被放弃的这段改了两个文件");
  });

  it("回不到一次工具调用前后（阶段、步骤开始前）；没交给它的输入撤回不到；都回原因，不动会话", async () => {
    const child = startCodexChild({ server: { turns: replies(2) } });
    const ready = await child.log.next("ready");
    await child.turn("in-1", "一");
    const call = await navigate(child, { beforeCall: "c-1" });
    expect(call).toMatchObject({ ok: false, error: expect.stringContaining("回不到一次工具调用前后") });
    const after = await navigate(child, { afterCall: "c-1" });
    expect(after.ok).toBe(false);
    const unknown = await navigate(child, { beforeInput: "in-old" });
    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("撤回不到它之前") });
    const entry = await navigate(child, { entry: ready.sessionId });
    expect(entry.ok).toBe(false);
    expect(child.server.callsOf("thread/fork")).toEqual([]);
    expect((await child.turn("in-2", "二")).outcome).toBe("completed");
    expect(child.server.callsOf("turn/start").at(-1)).toMatchObject({ threadId: ready.sessionId });
  });

  it("手头有一轮：先打断、等它收尾再挪", async () => {
    const child = startCodexChild({ server: { turns: [...replies(1), [{ kind: "hang" }], ...replies(1)] } });
    await child.log.next("ready");
    await child.turn("in-1", "一");
    child.send({ type: "user_input", inputId: "in-2", text: "二" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const done = await navigate(child, { beforeInput: "in-1" });
    expect(done.ok).toBe(true);
    expect(child.log.ofType("turn_end").map((e) => e.outcome)).toEqual(["completed", "aborted"]);
  });

  it("这些都记在会话记录里：子进程重启后接着撤回", async () => {
    const server = new FakeCodexServer({ turns: replies(4) });
    const sessionDir = makeTempDir("ergo-codex-sessions-");
    const first = startCodexChild({ server, session: { sessionDir } });
    const ready = await first.log.next("ready");
    await first.turn("in-1", "一");
    await first.turn("in-2", "二");
    await first.shutdown(0);

    const second = startCodexChild({ server, session: { sessionDir } });
    expect((await second.log.next("ready")).sessionId).toBe(ready.sessionId);
    const done = await navigate(second, { beforeInput: "in-2" });
    expect(done).toMatchObject({ ok: true, from: ready.sessionId });
    await second.shutdown(0);

    const third = startCodexChild({ server, session: { sessionDir } });
    expect((await third.log.next("ready")).sessionId).toBe(done.at);
    const back = await navigate(third, { entry: ready.sessionId }, "switch");
    expect(back).toMatchObject({ ok: true, at: ready.sessionId });
    expect((await third.turn("in-3", "三")).outcome).toBe("completed");
    expect(server.callsOf("thread/resume").at(-1)).toMatchObject({ threadId: ready.sessionId });
  });
});
