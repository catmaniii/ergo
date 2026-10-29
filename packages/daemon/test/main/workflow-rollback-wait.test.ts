// 主切面：流程撤回之后停住等你、一分钟没说话提醒一次；定时触发的任务运行中撤回记"已撤回"不算失败（155 号票，用户 2026-10-18 定）。
// 真的守护进程，流程的维护者接 faux 剧本，手动拨的时钟，测试扮演前端：
// - 一次性的流程撤回到步骤开始前：停在那里（不交代、不自己接着做）；一分钟内你没在这个任务里说话，待办里一条"流程在等你"加推送
//   （只提醒一次，再过二十分钟也不再提醒，也不再催维护者）；你在任务里说一句，维护者从撤回到的那一步接着做，这条处理掉；
// - 定时触发的流程运行中撤回：这次运行记"已撤回"（不是失败），不算进连续失败次数、不触发连续失败自动暂停，"最近一次失败"照旧。
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItem,
  type InboxItemEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  METHODS,
  type NotifyEventPayload,
  type ResponseFrame,
  ROLLBACK_WAIT_ACK,
  type RollbackSessionResult,
  type RollbackTarget,
  type RollbackWaitNoticeData,
  type ScheduledJobEventPayload,
  type StageStartEventPayload,
  type Task,
  type TaskEventPayload,
  type WorkflowPlanCardPayload,
  type WorkflowPlanDraft,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { TOOL } from "../../src/guard/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { settled } from "../helpers/settled.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;
const M1 = maintainerChannel("tm-1");
const LONG_TEST_MS = 150_000;
const MINUTE = 60_000;
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const propose = (draft: WorkflowPlanDraft) => call("propose_plan", draft as unknown as Record<string, unknown>);
const report = (stepId: string, status: string) => call("report_step", { stepId, status });
/** 撤回时写分支摘要的那次：要求是 BRANCH_SUMMARY_INSTRUCTIONS 的原话 */
const summaryStep = (text: string): FauxStep => ({ kind: "branch_on_context", contains: ["用中文写 3~5 行"], matched: say(text), otherwise: say("摘要写错了") });

const messagesOf = (frontend: TestFrontend, channel = M1) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const cardsOf = (frontend: TestFrontend): Card[] => [...new Map(frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => [(f.payload as CardEventPayload).card.id, (f.payload as CardEventPayload).card])).values()];
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const jobEventsOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).map((f) => f.payload as ScheduledJobEventPayload);
/** 待我处理里每一项最新的样子 */
const inboxOf = (frontend: TestFrontend): InboxItem[] => [...new Map(frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => [(f.payload as InboxItemEventPayload).item.id, (f.payload as InboxItemEventPayload).item])).values()];
const remindersOf = (frontend: TestFrontend) => inboxOf(frontend).filter((i) => i.kind === "notice" && i.notice === "rollback_wait");
const notifiesOf = (frontend: TestFrontend) => frontend.events({ channel: INBOX, type: EVENT_TYPES.notify }).map((f) => f.payload as NotifyEventPayload);
const stepStarts = (frontend: TestFrontend, channel = M1) =>
  frontend
    .events({ channel, type: EVENT_TYPES.stageStart })
    .map((f) => f.payload as StageStartEventPayload)
    .filter((m) => m.stepId !== undefined);
const stepStates = (task: Pick<Task, "steps">) => Object.fromEntries((task.steps?.list ?? []).map((s) => [s.stepId, s.state]));
const toolParts = (frontend: TestFrontend, channel = M1): ToolCallPart[] =>
  messagesOf(frontend, channel)
    .flatMap((m) => m.message.parts)
    .filter((p): p is ToolCallPart => p.type === "tool_call");
const turnStarts = (frontend: TestFrontend) => frontend.events({ channel: M1, type: EVENT_TYPES.turnStart }).length;
const ok = <T>(r: ResponseFrame): T => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result as T;
};
const rollback = (frontend: TestFrontend, before: RollbackTarget, key: string) => frontend.request(METHODS.rollbackSession, { conversation: M1, before }, key);

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}
const taskWhere = (frontend: TestFrontend, match: (e: TaskEventPayload) => boolean, what = "看板上的任务") => eventually(() => tasksOf(frontend), match, what);
const cardWhere = (frontend: TestFrontend, match: (card: Card) => boolean, what = "卡片") => eventually(() => cardsOf(frontend), match, what);
const turnsOf = (frontend: TestFrontend, n: number) =>
  waitUntil(() => frontend.events({ channel: M1, type: EVENT_TYPES.turnEnd }).length >= n, {
    timeoutMs: 60_000,
    describe: () => `等维护者处理完 ${n} 条输入；工具调用：${toolParts(frontend).map((p) => `${p.tool}:${p.outcome}${p.blockedBy ? `/${p.blockedBy}` : ""}`).join("、")}`,
  });
/** 让守护进程把手头的事件处理完（拨时钟之后到点的计时器在同一轮里追加事件，前端收到要一会儿） */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 300));

/** 本地时间 2026 年 m 月 d 日 hh:mm（手动拨的时钟） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);

/** 写资料、写周报（在写资料之后）、读一遍周报（在写周报之后） */
const threeSteps: WorkflowPlanDraft = {
  goal: "写好周报并读一遍",
  steps: [
    { id: "s1", title: "写资料", tool: TOOL.write, args: { path: "a.md", content: "资料\n" } },
    { id: "s2", title: "写周报", tool: TOOL.write, args: { path: "b.md", content: "# 周报\n" }, after: ["s1"] },
    { id: "s3", title: "读一遍周报", tool: TOOL.read, args: { path: "b.md" }, after: ["s2"] },
  ],
  rules: [],
};

async function connect(url: string) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries([BOARD, CARDS, INBOX, M1].map((c) => [c, 0])));
  return frontend;
}

const authorize = async (frontend: TestFrontend, card: Card) => ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: { confirmations: [] } }));

describe("流程撤回之后等你（155 号票）", { timeout: LONG_TEST_MS }, () => {
  it("撤回到步骤开始前之后停住：一分钟没说话，待办里一条加推送提醒一次（只一次），不再催维护者；你说一句就从那一步接着做，这条处理掉", async () => {
    const clock = new ManualClock(at(10, 8, 9, 0));
    const td: TestDaemon = await startTestDaemon({
      clock,
      secretary: [say("好"), say("好")],
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [propose(threeSteps), say("计划交上去了")]
          : [
              report("s1", "in_progress"),
              call(TOOL.write, { path: "a.md", content: "资料\n" }),
              report("s2", "in_progress"),
              call(TOOL.write, { path: "b.md", content: "# 周报\n" }),
              report("s3", "in_progress"),
              say("资料和周报写好了，s3 等一下再读"),
              // 收尾提醒（s3 没做）
              say("好的，晚点读"),
              // 撤回到 s3 开始前：写分支摘要
              summaryStep("摘要：写了资料和周报，s3 开始了还没读；没有对外效果。"),
              // 你说"接着做"：从 s3 接着做（被催的话这一步会被催促的那一轮用掉，后面对不上）
              report("s3", "in_progress"),
              call(TOOL.read, { path: "b.md" }),
              say("周报读过了，做完了"),
            ],
    });
    const frontend = await connect(td.url);
    const task = td.daemon.tasks.createByRequest({ title: "整理周报", summary: "整理周报", kind: "workflow" });
    td.daemon.tasks.writeBrief(task.id, { goal: "整理一份周报", acceptanceCriteria: ["周报写好、读过一遍"], constraints: [], projects: [], memoryScope: "" });
    const card = await cardWhere(frontend, (c) => c.type === "workflow_plan" && c.status === "pending" && (c.payload as WorkflowPlanCardPayload).taskId === task.id, "流程计划卡");
    await turnsOf(frontend, 1);
    await authorize(frontend, card);
    await turnsOf(frontend, 3);
    await settled(td, "tm-1");
    const s3 = stepStarts(frontend).find((m) => m.stepId === "s3")!;
    expect(s3.title).toBe("读一遍周报");

    ok<RollbackSessionResult>(await rollback(frontend, { stageStart: s3.id }, "k-s3"));
    const rolled = await taskWhere(frontend, (e) => e.change === "rolled_back", "撤回会话");
    expect(rolled.task.state).toBe("running");
    expect(stepStates(rolled.task).s3).toBe("pending");
    await settled(td, "tm-1");
    const turnsAfterRollback = turnStarts(frontend);

    // 不到一分钟：不提醒
    clock.advance(MINUTE - 1_000);
    await quiet();
    expect(remindersOf(frontend)).toEqual([]);

    // 一分钟你没在这个任务里说话：待办里一条"流程在等你"（卡着这个流程），同时推送；点了进任务会话（来源是这个任务）
    clock.advance(2_000);
    const reminder = await eventually(() => remindersOf(frontend), () => true, "撤回之后等你的提醒");
    expect(reminder).toMatchObject({
      kind: "notice",
      urgency: "blocking",
      title: "流程「整理周报」撤回到步骤「读一遍周报」开始前，在等你说一句再接着做",
      actions: [ROLLBACK_WAIT_ACK],
      origin: { taskId: task.id },
    });
    expect((reminder.kind === "notice" ? (reminder.data as RollbackWaitNoticeData) : undefined)?.taskId).toBe(task.id);
    await waitUntil(() => notifiesOf(frontend).some((n) => n.itemId === reminder.id), { describe: () => "等推送" });

    // 只提醒一次；之后二十多分钟也不催维护者（原来维护者活着时 20 分钟没进展会被催一次）
    clock.advance(25 * MINUTE);
    await quiet();
    expect(remindersOf(frontend)).toHaveLength(1);
    expect(notifiesOf(frontend).filter((n) => n.itemId === reminder.id)).toHaveLength(1);
    expect(turnStarts(frontend)).toBe(turnsAfterRollback);
    expect(td.daemon.tasks.get(task.id)!.state).toBe("running");

    // 你在任务里说一句：维护者从 s3 接着做，流程做完；那条提醒处理掉（标成已读）
    await frontend.sendText("接着做", { conversation: M1, taskId: task.id });
    const handled = await eventually(() => remindersOf(frontend), (i) => i.kind === "notice" && i.handled !== undefined, "提醒处理掉");
    expect(handled).toMatchObject({ read: true, urgency: "non_blocking" });
    const done = await taskWhere(frontend, (e) => e.change === "completed", "流程做完");
    expect(stepStates(done.task)).toEqual({ s1: "done", s2: "done", s3: "done" });
    expect(toolParts(frontend).filter((p) => p.tool === TOOL.read).map((p) => p.outcome)).toEqual(["done"]);
    // 说过话之后再拨时钟也不再提醒
    clock.advance(5 * MINUTE);
    await quiet();
    expect(remindersOf(frontend)).toHaveLength(1);
  });

  it("定时触发的流程运行中撤回：这次运行记已撤回、不算失败，连续失败次数不变、不触发连续失败自动暂停", async () => {
    const clock = new ManualClock(at(10, 8, 8, 0));
    const ls = call(TOOL.ls, { path: "." });
    const RUN_SUMMARY = "摘要：第二次运行看过工作目录，正说着被撤回了。";
    // 第二次运行看过目录之后说一段很长的话（慢慢吐），说到一半你撤回到这一步开始前
    const LONG = "这一段话很长，二狗正在慢慢说。".repeat(150);
    const draft: WorkflowPlanDraft = { goal: "看看工作目录", steps: [{ id: "s1", title: "看看工作目录", tool: TOOL.ls, args: { path: "." } }], rules: [] };
    const td = await startTestDaemon({
      clock,
      // 连续失败 2 次自动暂停：第一次运行失败了，第二次要是算失败就会暂停
      config: { scheduledJobs: { jobFailures: 2 } },
      maintainerTokensPerSecond: 40,
      secretary: [say("好"), say("好"), say("好")],
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [propose(draft), say("计划交上去了")]
          : spawn === 2
            ? [say("今天先不看了")]
            : spawn === 3
              ? [report("s1", "in_progress"), ls, say(LONG), summaryStep(RUN_SUMMARY)]
              : [summaryStep(RUN_SUMMARY)],
    });
    const frontend = await connect(td.url);
    ok(await frontend.startTask("每天看看工作目录", "k-flow", [], "workflow", { kind: "schedule", schedule: { kind: "daily", time: "09:00" } }));
    await taskWhere(frontend, (e) => e.change === "created", "建出的流程");
    td.daemon.tasks.writeBrief("t-1", { goal: "看看工作目录", acceptanceCriteria: ["看过"], constraints: [], projects: [], memoryScope: "" });
    const card = await cardWhere(frontend, (c) => c.type === "workflow_plan" && c.status === "pending", "流程计划卡");
    await settled(td, "tm-1");
    await authorize(frontend, card);
    const runEnded = (runId: string) => eventually(() => jobEventsOf(frontend), (e) => e.change === "run_finished" && e.run?.runId === runId, `${runId} 结束`);

    // 第一次运行：一步没做，记失败（连续失败 1 次）
    clock.advanceTo(at(10, 8, 9, 0));
    const first = await runEnded("j-1-r1");
    expect(first.run?.state).toBe("failed");
    expect(first.job).toMatchObject({ consecutiveFailures: 1, lastFailed: true, state: "active" });
    await settled(td, "tm-1");

    // 第二次运行：看过目录、正说着，你撤回到这一步开始前
    clock.advanceTo(at(10, 9, 9, 0));
    await waitUntil(() => toolParts(frontend).filter((p) => p.tool === TOOL.ls && p.outcome === "done").length === 1, { describe: () => "等第二次运行看过目录" });
    const mark = stepStarts(frontend).at(-1)!;
    expect(mark.stepId).toBe("s1");
    ok<RollbackSessionResult>(await rollback(frontend, { stageStart: mark.id }, "k-run"));

    // 这次运行记"已撤回"：不是失败，连续失败次数还是 1，没有自动暂停，"最近一次失败"照旧（算的是上一次）
    const second = await runEnded("j-1-r2");
    expect(second.run?.state).toBe("rolled_back");
    expect(second.run?.reason).toContain("撤回");
    expect(second.job).toMatchObject({ consecutiveFailures: 1, lastFailed: true, state: "active" });
    expect(second.job.pausedBy).toBeUndefined();
    await quiet();
    expect(inboxOf(frontend).filter((i) => i.kind === "notice" && i.notice === "scheduled_job_auto_paused")).toEqual([]);
    expect(td.daemon.tasks.get("t-1")!.state).toBe("operating");
    // 定时触发的不跟着会话推导任务状态，也不出"流程在等你"的提醒
    clock.advance(2 * MINUTE);
    await quiet();
    expect(remindersOf(frontend)).toEqual([]);
  });
});
