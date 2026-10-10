// 主切面：触发底座和定时触发（76 号票，ADR 0025）。真的守护进程，秘书、维护者接 faux 剧本，调度器的时钟换成手动拨的
// （ManualClock），测试扮演前端：
// - 发起对话框里选"定时"建普通任务：建出就是运营中（不排队），触发底座登记它的触发；到点一次运行，交给任务自己的 agent；
//   各次运行接着同一段会话——第二次运行时 agent 的上下文里有第一次的通知和它的结果；用量记在任务名下；
// - 上一次还没跑完又被触发：排队合并——新起一次排着，再来的并进它，正在跑的结束后只多跑这一次，这一批触发一起交给它；
// - 定时的流程：计划卡上授权一次，之后每次运行都按步骤核对（顺序错的引回；每次运行的比对历史分开，第二次运行照样能做第一步）；
// - 长程任务选不了定时、计划里不能再写定时作业；
// - 以前的定时作业迁移成定时触发的普通任务：新事件建出任务，原来的事件一条不动，迁移后照常由原来的维护者运行、接着原来的会话；
// - 任务详情里暂停、恢复、取消落到它的触发上；"只提醒我"建简单提醒。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  nowIso,
  type PlanCardPayload,
  type ReminderEventPayload,
  type ResponseFrame,
  type ScheduledJob,
  type ScheduledJobEventPayload,
  BOARD_GROUP_OF_TASK_STATE,
  type Task,
  type TaskEventPayload,
  TIMED_WORKFLOW_GRANT_TEXT,
  type WorkflowPlanCardPayload,
  type WorkflowPlanDraft,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { boardToolText } from "../../src/board/kinds.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { TOOL } from "../../src/guard/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { TASK_EVENTS, TASKS_CHANNEL } from "../../src/tasks/events.ts";
import { realPathOf } from "../../src/util/real-path.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type StartTestDaemonOptions } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { samplePlan } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { settled } from "../helpers/settled.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX, secretary: SECRETARY } = CHANNELS;
const TM1 = maintainerChannel("tm-1");
const JM1 = maintainerChannel("jm-1");
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-08 是周四） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const START = at(10, 8, 8, 0);
const DAILY_9 = { kind: "schedule" as const, schedule: { kind: "daily" as const, time: "09:00" } };

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const ECHO: FauxStep = { kind: "echo_context" };

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const jobsOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).map((f) => f.payload as ScheduledJobEventPayload);
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const toolPartsOf = (frontend: TestFrontend, channel: string): ToolCallPart[] =>
  messagesOf(frontend, channel).flatMap((m) => m.message.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));
/** 交给 agent 的通知（运行时发的、排进它的输入队列的系统消息） */
const noticesIn = (frontend: TestFrontend, channel: string) => messagesOf(frontend, channel).filter((m) => m.agentInput === true).map(textOf);
/** agent 最后一次模型调用看到的上下文（剧本里 echo_context 的回显） */
const lastEcho = (frontend: TestFrontend, channel: string) => textOf(messagesOf(frontend, channel).filter((m) => m.message.speaker === "agent").at(-1)!);
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}
const jobWhere = (frontend: TestFrontend, match: (e: ScheduledJobEventPayload) => boolean, what: string) => eventually(() => jobsOf(frontend), match, what);
/** 某一次运行结束了（运行记录的最后状态） */
const runEnded = (frontend: TestFrontend, runId: string) => jobWhere(frontend, (e) => e.change === "run_finished" && e.run?.runId === runId, `${runId} 结束`);

async function connect(url: string, channels: string[] = [BOARD, CARDS, INBOX, SECRETARY, TM1]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

async function setup(options: StartTestDaemonOptions, channels?: string[]) {
  const clock = new ManualClock(START);
  const td = await startTestDaemon({ clock, secretary: [say("好"), say("好"), say("好")], ...options });
  return { td, clock, frontend: await connect(td.url, channels) };
}

describe("定时的普通任务", () => {
  it("从对话框建：建出就是运营中、登记触发；到点一次运行交给任务自己的 agent；第二次运行接着同一段会话，上下文里有第一次的通知和结果；用量记在任务名下", async () => {
    const { td, clock, frontend } = await setup({
      // 每次运行按这一次拉起（会话照样接着）：第一次运行是第 1 次唤起，第二次运行是第 2 次
      maintainer: (_id, spawn) => (spawn === 1 ? [say("第一次：简报写好了，在 brief-1.md")] : [ECHO]),
    });
    expect(ok(await frontend.startTask("每天早上出一份简报\n汇总昨天的新闻", "k-daily", [], "plain", DAILY_9))).toEqual({ taskId: "t-1" });

    const created = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "建出的任务");
    expect(created).toMatchObject({ by: "user", task: { id: "t-1", kind: "plain", state: "operating", trigger: DAILY_9, maintainerId: "tm-1" } });
    const registered = await jobWhere(frontend, (e) => e.change === "registered", "登记的触发");
    expect(registered.job).toMatchObject({ id: "j-1", ownerTaskId: "t-1", taskId: "t-1", maintainerId: "tm-1", state: "active", schedule: DAILY_9.schedule, nextAt: expect.stringMatching(/^2026-10-08T09:00:00/) });
    expect(registered.job.projectId).toBeUndefined();
    // 不排队、不占名额：没有 started
    expect(tasksOf(frontend).map((e) => e.change)).toEqual(["created"]);
    // 看板上它在"运营中"一组，秘书的查看板写成这个任务（定时触发、下一次）
    expect(boardToolText(td.daemon.store)).toMatch(/## 运营中（1）\n- 任务 t-1「每天早上出一份简报」：运营中；定时触发：每天 09:00；下一次 /);

    clock.advanceTo(at(10, 8, 9, 0));
    await runEnded(frontend, "j-1-r1");
    // 会话里先一条这次运行的分段线，再一条交给 agent 的通知（带着任务和触发登记的身份）
    const dividers = messagesOf(frontend, TM1).filter((m) => m.message.parts.some((p) => p.type === "run_divider"));
    expect(dividers.map((m) => m.message.parts[0])).toEqual([{ type: "run_divider", jobId: "j-1", runId: "j-1-r1", title: "第 1 次运行 · 10 月 8 日（周四）09:00 到点" }]);
    const first = messagesOf(frontend, TM1).find((m) => m.agentInput === true)!;
    expect(first).toMatchObject({ taskId: "t-1", scheduledJobId: "j-1" });
    expect(textOf(first)).toContain("定时触发的普通任务 t-1「每天早上出一份简报」的第 1 次运行（j-1-r1；时间表：每天 09:00）。触发：10 月 8 日（周四）09:00 到点");
    expect(textOf(first)).toContain("要做的事——\n每天早上出一份简报\n汇总昨天的新闻");
    expect(textOf(first)).toContain("这是第一次运行。");
    expect(td.daemon.scheduledJobs.get("j-1")).toMatchObject({ runCount: 1, lastRun: { runId: "j-1-r1", state: "done" }, nextAt: expect.stringMatching(/^2026-10-09T09:00:00/) });
    // 任务一直是运营中（一次运行做完不算任务完成）
    expect(td.daemon.tasks.get("t-1")!.state).toBe("operating");

    await settled(td, "tm-1");
    clock.advanceTo(at(10, 9, 9, 0));
    await runEnded(frontend, "j-1-r2");
    const second = noticesIn(frontend, TM1)[1]!;
    expect(second).toContain("第 2 次运行");
    expect(second).toContain("前几次运行的结果（做了什么在这一段会话的前面）：\n- 第 1 次运行（10 月 8 日（周四）09:00）：成功");
    // 第二次运行的 agent 的上下文里有第一次：交给它的通知和它说的结果（接着同一段会话）
    const seen = lastEcho(frontend, TM1);
    expect(seen).toContain("第 1 次运行（j-1-r1");
    expect(seen).toContain("第一次：简报写好了，在 brief-1.md");
    expect(seen).toContain("第 2 次运行（j-1-r2");
    // 定时触发的那一段系统提示、"报告这次运行失败"的工具
    expect(seen).toContain("这个任务是定时触发的");
    expect(seen).toMatch(/\[tool\] fail_job_run/);

    // 用量记在任务名下（"消耗页按任务记账"），不在触发登记名下
    expect(td.daemon.ledger.entries({ kind: "task", id: "t-1" }).length).toBeGreaterThanOrEqual(2);
    expect(td.daemon.ledger.entries({ kind: "scheduled_job", id: "j-1" })).toEqual([]);
  });
});

describe("排队合并", () => {
  it("上一次还没跑完又被触发：新起一次排着，再来的并进它；正在跑的结束后只多跑这一次，这一批两次触发一起交给它", async () => {
    const outside = realPathOf(makeTempDir("ergou-outside-"))!;
    const notes = path.join(outside, "notes.txt");
    fs.writeFileSync(notes, "外面的笔记");
    const { td, clock, frontend } = await setup({
      maintainer: (_id, spawn) => (spawn === 1 ? [call(TOOL.read, { path: notes }), say("第一次读到了")] : [ECHO]),
      // 读工作目录外的文件要先问（对话审批开着）：第一次运行卡在审批上，一直在跑
      config: { guard: { conversationApprovals: "on" }, approvals: { waitMinutes: 100_000 } },
    });
    ok(await frontend.startTask("每天读一遍那份笔记", "k-merge", [], "plain", DAILY_9));
    await jobWhere(frontend, (e) => e.change === "registered", "登记的触发");

    clock.advanceTo(at(10, 8, 9, 0));
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "approval" && c.status === "pending", "审批卡");
    expect(td.daemon.scheduledJobs.get("j-1")!.lastRun).toMatchObject({ runId: "j-1-r1", state: "running" });

    // 第二天到点：上一次还在跑，这一次排着（不并行）
    clock.advanceTo(at(10, 9, 9, 0));
    const queued = await jobWhere(frontend, (e) => e.change === "triggered" && e.run?.runId === "j-1-r2", "第二次排着");
    expect(queued.run).toMatchObject({ state: "queued", events: [{ source: "time", summary: "10 月 9 日（周五）09:00 到点" }] });
    // 第三天又到点：并进还排着的那一次，不再多起
    clock.advanceTo(at(10, 10, 9, 0));
    const merged = await jobWhere(frontend, (e) => e.change === "merged", "并进排着的那一次");
    expect(merged.run).toMatchObject({ runId: "j-1-r2", state: "queued", events: [{ summary: "10 月 9 日（周五）09:00 到点" }, { summary: "10 月 10 日（周六）09:00 到点" }] });
    // 触发底座的口子（77 号票的事件来源接这里）：再来一次同样并进去
    expect(td.daemon.scheduledJobs.fire("t-1", { source: "time", at: nowIso(at(10, 10, 9, 30)), summary: "手动再触发一次" }, "k-fire-1")).toEqual({ outcome: "merged", runId: "j-1-r2" });
    expect(td.daemon.scheduledJobs.fire("t-1", { source: "time", at: nowIso(at(10, 10, 9, 30)), summary: "手动再触发一次" }, "k-fire-1")).toMatchObject({ outcome: "ignored" });
    // 没给幂等键的，每次都是一个新事件：同样的两次在排队合并期间不会撞成一次
    const pushed = { source: "time", at: nowIso(at(10, 10, 9, 40)), summary: "外面推来的一次（没给幂等键）" };
    expect(td.daemon.scheduledJobs.fire("t-1", pushed)).toEqual({ outcome: "merged", runId: "j-1-r2" });
    expect(td.daemon.scheduledJobs.fire("t-1", pushed)).toEqual({ outcome: "merged", runId: "j-1-r2" });

    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version }));
    await runEnded(frontend, "j-1-r1");
    await runEnded(frontend, "j-1-r2");
    await settled(td, "tm-1");
    const runs = jobsOf(frontend).filter((e) => e.change === "run_finished").map((e) => [e.run!.runId, e.run!.state]);
    expect(runs).toEqual([
      ["j-1-r1", "done"],
      ["j-1-r2", "done"],
    ]);
    // 只多跑了这一次：没有第三次运行；这一批触发列在交给它的通知里
    expect(td.daemon.scheduledJobs.get("j-1")!.runCount).toBe(2);
    const batch = noticesIn(frontend, TM1).find((t) => t.includes("j-1-r2"))!;
    expect(batch).toContain(
      "这一批触发（上一次还没跑完时又来的，合成一批交给这一次运行，先后照来的顺序）：\n- 10 月 9 日（周五）09:00 到点\n- 10 月 10 日（周六）09:00 到点\n- 手动再触发一次\n- 外面推来的一次（没给幂等键）\n- 外面推来的一次（没给幂等键）",
    );
    expect(messagesOf(frontend, TM1).flatMap((m) => m.message.parts).filter((p) => p.type === "run_divider").map((p) => (p as { title: string }).title)).toEqual([
      "第 1 次运行 · 10 月 8 日（周四）09:00 到点",
      "第 2 次运行 · 合并了 5 次触发",
    ]);
  }, 120_000);
});

/** 看看工作目录里有什么，再读一遍里面的周报（读在看之后）：每次运行都能照着重复做 */
const notesDraft: WorkflowPlanDraft = {
  goal: "看一遍工作目录、读一遍周报",
  steps: [
    { id: "s1", title: "看看工作目录", tool: TOOL.ls, args: { path: "." } },
    { id: "s2", title: "读一遍周报", tool: TOOL.read, args: { path: "notes.md" }, after: ["s1"] },
  ],
  rules: [],
};
const LS = call(TOOL.ls, { path: "." });
const FIND = call(TOOL.read, { path: "notes.md" });
const stepParts = (frontend: TestFrontend) => toolPartsOf(frontend, TM1).filter((p) => p.tool === TOOL.ls || p.tool === TOOL.read);

describe("定时的流程", () => {
  it("计划卡上只授权一次，之后每次运行都按步骤核对：顺序错的引回前置步骤；每次运行的比对历史分开，第二次运行照样从第一步做起；不再出计划卡", async () => {
    const { td, clock, frontend } = await setup({
      maintainer: (_id, spawn) => {
        if (spawn === 1) return [call("propose_plan", notesDraft as unknown as Record<string, unknown>), say("计划交上去了")];
        // 第一次运行：先读（没看就读，被引回），再照计划看、读
        if (spawn === 2) return [FIND, call("report_step", { stepId: "s1", status: "in_progress" }), LS, FIND, say("第一次运行做完了")];
        // 第二次运行：照样从第一步做起（上一次运行做过了，这次不算重复、也不算已经做完）
        return [FIND, LS, FIND, say("第二次运行做完了")];
      },
    });
    ok(await frontend.startTask("每天整理一份周报", "k-flow", [], "workflow", DAILY_9));
    const work = path.join(dataDirLayout(td.dataDir).outputs, "t-1");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "notes.md"), "# 周报\n- 第一条\n");
    const created = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "建出的流程");
    expect(created.task).toMatchObject({ kind: "workflow", state: "planning", trigger: DAILY_9 });
    td.daemon.tasks.writeBrief("t-1", { goal: "整理周报", acceptanceCriteria: ["周报写好、读过一遍"], constraints: [], projects: [], memoryScope: "" });
    // 交给维护者的任务书里写明它是定时做的
    await waitUntil(() => noticesIn(frontend, TM1).some((t) => t.includes("什么时候做：定时，每天 09:00")), { timeoutMs: 30_000, describe: () => "等任务书" });
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "workflow_plan" && c.status === "pending", "流程计划卡");
    // 卡上写明授权管多久（ADR 0017：授权随计划卡确认）：按时间表反复运行，一直有效，直到暂停或取消
    expect((card.payload as WorkflowPlanCardPayload).schedule).toEqual(DAILY_9.schedule);
    expect(card.text).toContain(`定时：每天 09:00，${TIMED_WORKFLOW_GRANT_TEXT}`);
    await settled(td, "tm-1");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: { confirmations: [] } }));
    // 授权之后是运营中（不排队），登记触发
    await eventually(() => tasksOf(frontend), (e) => e.change === "plan_confirmed" && e.task.state === "operating", "授权后运营中");
    await jobWhere(frontend, (e) => e.change === "registered" && e.job.ownerTaskId === "t-1", "登记的触发");

    clock.advanceTo(at(10, 8, 9, 0));
    const r1 = await runEnded(frontend, "j-1-r1");
    expect(r1.run).toMatchObject({ state: "done" });
    // 没看就读：守卫和授权的计划比对，引回前置步骤（不打扰用户）；之后照计划做的都执行了
    expect(stepParts(frontend).map((p) => [p.tool, p.outcome, p.blockedBy ?? null])).toEqual([
      ["read", "blocked", "plan_redirect"],
      ["ls", "done", null],
      ["read", "done", null],
    ]);
    // 这次运行里各步的状态：汇报的、执行过却没报的推断成做完
    expect(r1.run!.steps!.map((s) => [s.stepId, s.state])).toEqual([
      ["s1", "done"],
      ["s2", "done"],
    ]);
    const firstNotice = noticesIn(frontend, TM1).find((t) => t.includes("j-1-r1"))!;
    expect(firstNotice).toContain("定时触发的流程 t-1「每天整理一份周报」的第 1 次运行");
    expect(firstNotice).toContain("用户授权过计划 v1（授权一次，之后每次运行都照它）");
    expect(firstNotice).toContain("s1. 看看工作目录（ls");

    await settled(td, "tm-1");
    clock.advanceTo(at(10, 9, 9, 0));
    await runEnded(frontend, "j-1-r2");
    // 第二次运行的比对历史是它自己的：没看就读照样被引回（上一次运行看过不算），看了之后读得了
    expect(stepParts(frontend).slice(3).map((p) => [p.tool, p.outcome, p.blockedBy ?? null])).toEqual([
      ["read", "blocked", "plan_redirect"],
      ["ls", "done", null],
      ["read", "done", null],
    ]);
    expect(jobsOf(frontend).filter((e) => e.change === "run_finished").at(-1)!.run!.steps!.map((s) => [s.stepId, s.state])).toEqual([
      ["s1", "done"],
      ["s2", "done"],
    ]);
    // 只授权了一次：只有一张流程计划卡、没有审批卡
    expect(new Set(cardsOf(frontend).filter((c) => c.type === "workflow_plan").map((c) => c.id)).size).toBe(1);
    expect(cardsOf(frontend).filter((c) => c.type === "approval")).toEqual([]);
    expect(td.daemon.tasks.get("t-1")!.state).toBe("operating");
  }, 120_000);
});

describe("定时的流程没干完的活", () => {
  it("一次运行收工时还有步骤既没做完也没说明跳过：提醒过一次之后、或者一步都没做，都记失败（还有 N 步没做），算进连续失败", async () => {
    const { td, clock, frontend } = await setup({
      maintainer: (_id, spawn) => {
        if (spawn === 1) return [call("propose_plan", notesDraft as unknown as Record<string, unknown>), say("计划交上去了")];
        // 第一次运行：只看了目录就收工，被提醒一次之后还是不做
        if (spawn === 2) return [LS, say("看过了"), say("今天就做到这里")];
        // 第二次运行：一步都没做
        return [say("今天没什么要做的")];
      },
    });
    ok(await frontend.startTask("每天整理一份周报", "k-flow-left", [], "workflow", DAILY_9));
    td.daemon.tasks.writeBrief("t-1", { goal: "整理周报", acceptanceCriteria: ["周报读过一遍"], constraints: [], projects: [], memoryScope: "" });
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "workflow_plan" && c.status === "pending", "流程计划卡");
    await settled(td, "tm-1");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: { confirmations: [] } }));
    await jobWhere(frontend, (e) => e.change === "registered", "登记的触发");

    clock.advanceTo(at(10, 8, 9, 0));
    const r1 = await runEnded(frontend, "j-1-r1");
    // 提醒过一次（照 59 号票，用 report_step 说明跳过），之后还有一步没做：记失败
    expect(noticesIn(frontend, TM1).filter((t) => t.startsWith("【计划检查】"))).toHaveLength(1);
    expect(noticesIn(frontend, TM1).find((t) => t.startsWith("【计划检查】"))).toContain("用 report_step 标记 skipped");
    expect(r1.run).toMatchObject({ state: "failed", reason: "还有 1 步没做：s2「读一遍周报」", summary: "今天就做到这里" });
    expect(r1.run!.steps!.map((s) => [s.stepId, s.state])).toEqual([
      ["s1", "done"],
      ["s2", "pending"],
    ]);
    expect(r1.job).toMatchObject({ lastFailed: true, consecutiveFailures: 1 });

    await settled(td, "tm-1");
    clock.advanceTo(at(10, 9, 9, 0));
    const r2 = await runEnded(frontend, "j-1-r2");
    // 一步都没做：没有可提醒的（这一轮没做事），直接记失败
    expect(r2.run).toMatchObject({ state: "failed", reason: "还有 2 步没做：s1「看看工作目录」、s2「读一遍周报」" });
    expect(r2.job).toMatchObject({ consecutiveFailures: 2 });
    expect(noticesIn(frontend, TM1).filter((t) => t.startsWith("【计划检查】"))).toHaveLength(1);
    // 第二次运行的通知里带着第一次的结局和最后说的话
    expect(noticesIn(frontend, TM1).find((t) => t.includes("j-1-r2"))).toContain("- 第 1 次运行（10 月 8 日（周四）09:00）：失败——还有 1 步没做：s2「读一遍周报」；最后说的：今天就做到这里");
  }, 120_000);
});

describe("长程任务选不了定时", () => {
  it("发起对话框里长程任务选定时（反复做、某个时间做一次）都被拒；某个时间做一次的时间已经过了被拒；计划里写了定时作业被拒，说清改去哪里建；提交计划的工具的参数里没有这一项", async () => {
    const { td, frontend } = await setup({});
    const refused = await frontend.startTask("每天写日报", "k-long", [], "long_running", DAILY_9);
    expect(refused).toMatchObject({ ok: false, error: { code: "not_allowed", message: expect.stringContaining("长程任务只能现在做一次") } });
    // 某个时间做一次的长程任务也不行；某个时间做一次的时间要在将来
    const longOnce = await frontend.startTask("明天写日报", "k-long-once", [], "long_running", { kind: "schedule", schedule: { kind: "once", at: nowIso(at(10, 9, 9)) } });
    expect(longOnce).toMatchObject({ ok: false, error: { code: "not_allowed", message: expect.stringContaining("长程任务只能现在做一次") } });
    const passed = await frontend.startTask("昨天写日报", "k-once-passed", [], "plain", { kind: "schedule", schedule: { kind: "once", at: nowIso(at(10, 7, 9)) } });
    expect(passed).toMatchObject({ ok: false, error: { code: "bad_params", message: expect.stringContaining("已经过了") } });
    expect(tasksOf(frontend)).toEqual([]);

    const task = td.daemon.tasks.createByRequest({ title: "写调研报告", summary: "写调研报告" });
    td.daemon.tasks.writeBrief(task.id, { goal: "写调研报告", acceptanceCriteria: ["报告写好"], constraints: [], projects: [], memoryScope: "" });
    const plan = { ...samplePlan(), scheduledJobs: [{ title: "每周一更新", schedule: { kind: "weekly", time: "09:00", weekdays: [1] }, each: "看有没有新资料" }] };
    expect(() => td.daemon.tasks.submitPlan(task.id, task.maintainerId, plan as never)).toThrow(/计划里不再写定时作业/);
    const { Plan } = await import("@ergou/protocol");
    expect(Object.keys(Plan.properties)).not.toContain("scheduledJobs");
  });
});

describe("暂停、恢复、取消，只提醒我", () => {
  it("任务详情里的暂停、恢复、取消落到它的触发上：暂停时到点不运行，恢复后下一次从现在往后算；取消时任务和触发一起取消；只提醒我建简单提醒", async () => {
    const { td, clock, frontend } = await setup({ maintainer: [say("做完了")] });
    ok(await frontend.startTask("每天早上出简报", "k-ctl", [], "plain", DAILY_9));
    await jobWhere(frontend, (e) => e.change === "registered", "登记的触发");

    expect(ok(await frontend.taskAction({ taskId: "t-1", action: "pause" }))).toEqual({ taskId: "t-1", state: "operating" });
    expect(td.daemon.scheduledJobs.ofTask("t-1")).toMatchObject({ state: "paused", pausedBy: "user" });
    clock.advanceTo(at(10, 8, 9, 30));
    expect(td.daemon.scheduledJobs.ofTask("t-1")!.runCount).toBe(0);
    ok(await frontend.taskAction({ taskId: "t-1", action: "resume" }));
    expect(td.daemon.scheduledJobs.ofTask("t-1")).toMatchObject({ state: "active", nextAt: expect.stringMatching(/^2026-10-09T09:00:00/) });

    expect(ok(await frontend.taskAction({ taskId: "t-1", action: "cancel" }))).toEqual({ taskId: "t-1", state: "cancelled" });
    expect(td.daemon.scheduledJobs.ofTask("t-1")!.state).toBe("cancelled");
    expect(tasksOf(frontend).at(-1)).toMatchObject({ change: "cancelled", by: "user", from: "operating", task: { state: "cancelled" } });
    clock.advanceTo(at(10, 9, 9, 30));
    expect(td.daemon.scheduledJobs.ofTask("t-1")!.runCount).toBe(0);

    // 只提醒我：不用 agent，建一条简单提醒（同一幂等键重发拿到同一条）
    const schedule = { kind: "workdays" as const, time: "18:00" };
    expect(ok(await frontend.createReminder("下班前写日报", schedule, "k-remind"))).toEqual({ reminderId: "r-1" });
    expect(ok(await frontend.createReminder("下班前写日报", schedule, "k-remind"))).toEqual({ reminderId: "r-1" });
    const reminder = await eventually(() => frontend.events({ channel: BOARD, type: EVENT_TYPES.reminder }).map((f) => f.payload as ReminderEventPayload), (e) => e.change === "created", "建出的提醒");
    expect(reminder).toMatchObject({ by: "user", reminder: { id: "r-1", text: "下班前写日报", schedule, status: "pending" } });
  });
});

/** 迁移前那次运行写简报（作业自己的维护者 jm-1） */
const legacyMaintainer = (id: string): FauxStep[] => (id !== "jm-1" ? [say("好")] : [say("今天的简报写好了：brief-1008.md")]);
/** 迁移后（重启后的守护进程里）的运行回显上下文 */
const echoingMaintainer = (id: string): FauxStep[] => (id !== "jm-1" ? [say("好")] : [ECHO]);

describe("以前的定时作业迁移", () => {
  it("76 号票之前登记的定时作业：重启时迁移成定时触发的普通任务（新事件，原来的事件一条不动）；之后照常由原来的维护者运行、接着原来的会话，授权照旧，用量记在任务名下", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const clock = new ManualClock(START);
    const maintainer = legacyMaintainer;
    const echoing = echoingMaintainer;
    const first = await startTestDaemon({ clock, reuse: { dataDir, homeDir }, maintainer });
    const frontend = await connect(first.url, [BOARD, CARDS, INBOX, JM1]);
    // 76 号票之前的数据：一个长程任务（计划里定了作业）和它登记的定时作业（作业自己的维护者 jm-1，每次运行的授权随计划卡确认）
    const time = nowIso(START);
    const creator: Task = { id: "t-1", title: "准备每天的简报", summary: "准备每天的简报", state: "done", origin: "request", kind: "long_running", maintainerId: "tm-1", projects: [], projectScope: "none", createdAt: time, updatedAt: time };
    const legacy: ScheduledJob = {
      id: "j-1",
      title: "每天早上出简报",
      schedule: { kind: "daily", time: "09:00" },
      each: "汇总昨天的新闻，写一份简报",
      maintainerId: "jm-1",
      taskId: "t-1",
      taskTitle: "准备每天的简报",
      grants: [{ id: "news", tool: TOOL.web_fetch, title: "读新闻网站", scope: {} }],
      temporalRules: [],
      grantInfo: {},
      state: "active",
      nextAt: nowIso(at(10, 8, 9, 0)),
      lastFailed: false,
      consecutiveFailures: 0,
      runCount: 0,
      createdAt: time,
      updatedAt: time,
    };
    first.daemon.store.appendBatch([
      { channel: BOARD, type: EVENT_TYPES.task, payload: { task: creator, change: "created", from: null, by: "secretary" } satisfies TaskEventPayload },
      { channel: BOARD, type: EVENT_TYPES.scheduledJob, payload: { job: legacy, change: "registered", by: "user" } satisfies ScheduledJobEventPayload, idempotencyKey: "job-register:t-1-p1:0" },
    ]);
    // 迁移之前它照旧按 19 号票运行一次（作业自己的维护者）
    clock.advanceTo(at(10, 8, 9, 0));
    await runEnded(frontend, "j-1-r1");
    await settled(first, "jm-1");
    const before = first.daemon.store.read(BOARD, 0).map((e) => JSON.stringify(e));
    const beforeJm = first.daemon.store.read(JM1, 0).map((e) => JSON.stringify(e));
    await frontend.close();
    await first.daemon.stop();

    const second = await startTestDaemon({ clock, reuse: { dataDir, homeDir }, maintainer: echoing });
    const again = await connect(second.url, [BOARD, CARDS, INBOX, JM1]);
    // 新事件：建出定时触发的普通任务（执行的照旧是 jm-1），触发登记补上它属于的任务
    const migratedTask = await eventually(() => tasksOf(again), (e) => e.task.origin === "migrated", "迁移出的任务");
    expect(migratedTask).toMatchObject({ change: "created", by: "system", task: { id: "t-2", kind: "plain", state: "operating", trigger: { kind: "schedule", schedule: legacy.schedule }, maintainerId: "jm-1", title: "每天早上出简报" } });
    const linked = await jobWhere(again, (e) => e.change === "migrated", "迁移的触发登记");
    expect(linked.job).toMatchObject({ id: "j-1", ownerTaskId: "t-2", taskId: "t-1", maintainerId: "jm-1", grants: legacy.grants, runCount: 1 });
    // 原来的事件一条不动（只追加）
    expect(second.daemon.store.read(BOARD, 0).slice(0, before.length).map((e) => JSON.stringify(e))).toEqual(before);
    expect(second.daemon.store.read(JM1, 0).slice(0, beforeJm.length).map((e) => JSON.stringify(e))).toEqual(beforeJm);
    // 运行记录留着（第一次运行属于它）
    expect(second.daemon.scheduledJobs.ofTask("t-2")!.lastRun).toMatchObject({ runId: "j-1-r1", state: "done" });

    // 迁移后照常运行：同一个维护者、接着原来的会话（上下文里有迁移前那次的结果），授权照旧，用量记在任务名下
    clock.advanceTo(at(10, 9, 9, 0));
    await runEnded(again, "j-1-r2");
    const seen = lastEcho(again, JM1);
    expect(seen).toContain("今天的简报写好了：brief-1008.md");
    expect(seen).toContain("定时触发的普通任务 t-2「每天早上出简报」的第 2 次运行");
    expect(seen).toContain("每次要做的事：汇总昨天的新闻，写一份简报");
    expect(seen).toContain("这次运行预先授权的操作");
    expect(second.daemon.ledger.entries({ kind: "task", id: "t-2" }).length).toBeGreaterThanOrEqual(1);
    // 再重启不会再迁移一次
    await again.close();
    await second.daemon.stop();
    const third = await startTestDaemon({ clock, reuse: { dataDir, homeDir }, maintainer: echoing });
    expect(third.daemon.tasks.list().filter((t) => t.origin === "migrated").map((t) => t.id)).toEqual(["t-2"]);
  }, 120_000);
});

describe("升级前交、升级后才确认的计划里的定时作业", () => {
  it("确认这张计划卡时不悄悄丢掉：照迁移的办法建成定时触发的普通任务（作业自己的维护者、计划卡上的授权），卡上写明改成了哪个定时任务；确认的计划里不再有这一栏；之后照常到点运行", async () => {
    const { td, clock, frontend } = await setup({ maintainer: (id) => (id === "jm-1" ? [say("看过了，这周没有新资料")] : [say("好")]) }, [BOARD, CARDS, INBOX, SECRETARY, TM1, JM1]);
    // 76 号票之前的数据：长程任务的维护者交了一版带着定时作业的计划，计划卡还没确认（负载里的计划带着 scheduledJobs）
    const task = td.daemon.tasks.createByRequest({ title: "跟进资料更新", summary: "跟进资料更新" });
    td.daemon.tasks.writeBrief(task.id, { goal: "跟进资料更新", acceptanceCriteria: ["每周看一次"], constraints: [], projects: [], memoryScope: "" });
    await settled(td, "tm-1");
    const legacyJob = {
      title: "每周一看看有没有新资料",
      schedule: { kind: "weekly" as const, time: "09:00", weekdays: [1] },
      each: "看看资料站有没有新资料，有就记下来",
      policy: { grants: [{ id: "legacy-fetch", tool: TOOL.web_fetch, title: "读资料站", scope: {} }], temporalRules: [] },
    };
    const plan = samplePlan();
    const legacyPlan = { ...plan, scheduledJobs: [legacyJob] };
    const planId = `${task.id}-p1`;
    const payload: PlanCardPayload = { taskId: task.id, taskTitle: task.title, revision: 1, planId, goal: "跟进资料更新", plan, globalCategories: [], grantInfo: {} };
    const built = td.daemon.cards.buildCreate({ type: "plan", urgency: "blocking", payload });
    const legacyCard = { ...built.card, typeVersion: 4, payload: { ...payload, plan: legacyPlan } };
    const now = td.daemon.tasks.get(task.id)!;
    td.daemon.store.appendBatch([
      { channel: TASKS_CHANNEL, type: TASK_EVENTS.planSubmitted, payload: { taskId: task.id, planId, revision: 1, plan: legacyPlan, cardId: legacyCard.id, maintainerId: "tm-1", time: nowIso(START) } },
      { ...built.event, payload: { card: legacyCard } satisfies CardEventPayload },
      td.daemon.tasks.buildChange(now, { ...now, state: "awaiting_confirm", planCardId: legacyCard.id, stages: { total: plan.stages.length } }, { by: "maintainer", change: "plan_submitted" }).event,
    ]);

    // 确认
    const result = ok(await frontend.cardAction({ cardId: legacyCard.id, action: "confirm", expectedVersion: legacyCard.version, input: {} })) as { card?: Card };
    const confirmed = await eventually(() => cardsOf(frontend), (c) => c.id === legacyCard.id && c.status !== "pending", "确认后的卡");
    expect(result).toBeDefined();
    expect(confirmed.outcome?.note).toContain("计划里的定时作业已改成定时任务「每周一看看有没有新资料」");
    // 确认的计划里不再有这一栏（卡的负载合现在的 schema）
    expect((confirmed.payload as PlanCardPayload).plan).not.toHaveProperty("scheduledJobs");
    expect(td.daemon.tasks.confirmedPlan(task.id)!.plan).not.toHaveProperty("scheduledJobs");
    // 建出的定时触发的普通任务：照迁移的办法（来源"迁移"、运营中、由作业自己的维护者 jm-1 运行）
    const migrated = await eventually(() => tasksOf(frontend), (e) => e.change === "created" && e.task.origin === "migrated", "建出的定时任务");
    expect(migrated.task).toMatchObject({ id: "t-2", kind: "plain", state: "operating", maintainerId: "jm-1", title: "每周一看看有没有新资料", trigger: { kind: "schedule", schedule: legacyJob.schedule } });
    // 登记的触发：以前那样的定时作业（属于建它的长程任务，每次运行的授权照计划卡上的），指向这个任务；算用户做的
    const registered = await jobWhere(frontend, (e) => e.change === "registered", "登记");
    expect(registered.by).toBe("user");
    expect(registered.job).toMatchObject({ id: "j-1", taskId: task.id, ownerTaskId: "t-2", maintainerId: "jm-1", each: legacyJob.each, grants: legacyJob.policy.grants, state: "active" });
    // 长程任务照常往下走（确认后排队、执行）
    expect(["queued", "running"]).toContain(td.daemon.tasks.get(task.id)!.state);

    // 之后照常到点运行（2026-10-12 是周一）
    clock.advanceTo(at(10, 12, 9, 0));
    const run = await runEnded(frontend, "j-1-r1");
    expect(run.run).toMatchObject({ state: "done", summary: "看过了，这周没有新资料" });
    // 只建了这一个
    expect(td.daemon.tasks.list().filter((t) => t.origin === "migrated").map((t) => t.id)).toEqual(["t-2"]);
  }, 120_000);
});

/** 定时、时间表是一次性的：10 月 8 日 09:00 做一次 */
const AT_9 = { kind: "schedule" as const, schedule: { kind: "once" as const, at: nowIso(at(10, 8, 9, 0)) } };
const changesOf = (frontend: TestFrontend, taskId: string) => tasksOf(frontend).filter((e) => e.task.id === taskId).map((e) => e.change);
/** 某个任务第 nth 次到了某个状态 */
const stateIs = (frontend: TestFrontend, taskId: string, state: Task["state"], nth = 1) =>
  waitUntil(() => tasksOf(frontend).filter((e) => e.task.id === taskId && e.task.state === state).length >= nth, { timeoutMs: 60_000, describe: () => `等 ${taskId} ${state}` });

describe("某个时间做一次", () => {

  it("从对话框建：建出是等时间（在进行中一组，不登记触发，agent 还没收到）；到点进排队、交给它的 agent 做，做完即完成；之后在详情里接着说它接着做", async () => {
    const { td, clock, frontend } = await setup({ maintainer: [say("查好了：三班直飞，最早 08:05"), say("后天的也查好了")] });
    ok(await frontend.startTask("查一下明早的航班\n查 10 月 8 日上午从上海飞新加坡的航班", "k-at", [], "plain", AT_9));
    const created = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "建出的任务");
    expect(created.task).toMatchObject({ id: "t-1", kind: "plain", state: "scheduled", trigger: AT_9 });
    expect(BOARD_GROUP_OF_TASK_STATE.scheduled).toBe("active");
    expect(boardToolText(td.daemon.store)).toMatch(/## 进行中（1）\n- 任务 t-1「查一下明早的航班」：等时间；普通任务（交给后台的）；定在 10 月 8 日（周四）09:00 做一次（还没到点）/);
    await settled(td, "secretary");
    // 不是反复运行的：不登记触发；没到点之前 agent 没收到任务书
    expect(jobsOf(frontend)).toEqual([]);
    expect(noticesIn(frontend, TM1)).toEqual([]);
    clock.advanceTo(at(10, 8, 8, 59));
    expect(td.daemon.tasks.get("t-1")!.state).toBe("scheduled");

    // 到点：进排队（系统），之后和现在做一次的一样
    clock.advanceTo(at(10, 8, 9, 0));
    await stateIs(frontend, "t-1", "done");
    expect(tasksOf(frontend).find((e) => e.change === "time_due")).toMatchObject({ by: "system", from: "scheduled", task: { state: "queued" } });
    expect(noticesIn(frontend, TM1)[0]).toContain("普通任务 t-1「查一下明早的航班」（定在 10 月 8 日（周四）09:00 做的，现在到点了）：要做的事——");
    // 做完即完成，接着说接着做
    await frontend.sendText("再查一下后天的", { conversation: TM1 });
    await stateIs(frontend, "t-1", "done", 2);
    expect(changesOf(frontend, "t-1")).toEqual(["created", "time_due", "started", "completed", "continued", "completed"]);
    expect(jobsOf(frontend)).toEqual([]);
  }, 120_000);

  it("守护进程停着时过了那个时间：开机后补做一次（会话里记一句原定什么时候），再重启不再做", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const clock = new ManualClock(START);
    const first = await startTestDaemon({ clock, reuse: { dataDir, homeDir }, secretary: [say("好")], maintainer: [say("查好了")] });
    const frontend = await connect(first.url);
    ok(await frontend.startTask("查一下明早的航班\n查上午飞新加坡的航班", "k-at-missed", [], "plain", AT_9));
    await stateIs(frontend, "t-1", "scheduled");
    await frontend.close();
    await first.daemon.stop();

    // 停机期间过了 09:00
    clock.advanceTo(at(10, 8, 11, 0));
    const second = await startTestDaemon({ clock, reuse: { dataDir, homeDir }, secretary: [say("好")], maintainer: [say("查好了，补做的")] });
    const again = await connect(second.url);
    await stateIs(again, "t-1", "done");
    expect(tasksOf(again).filter((e) => e.change === "time_due")).toHaveLength(1);
    const notes = messagesOf(again, TM1).filter((m) => m.message.speaker === "system" && m.agentInput !== true).map(textOf);
    expect(notes).toContain("原定 10 月 8 日（周四）09:00 做：那时守护进程没在运行，开机后补做一次");
    await again.close();
    await second.daemon.stop();

    const third = await startTestDaemon({ clock, reuse: { dataDir, homeDir }, secretary: [say("好")], maintainer: [say("不该再做")] });
    const later = await connect(third.url);
    await settled(third, "tm-1");
    expect(third.daemon.tasks.get("t-1")!.state).toBe("done");
    expect(tasksOf(later).filter((e) => e.change === "time_due")).toHaveLength(1);
    expect(messagesOf(later, TM1).filter((m) => m.message.speaker === "agent").map(textOf)).not.toContain("不该再做");
  }, 120_000);

  it("助理建：用户说\"明天早上 9 点帮我……\"，助理用 delegate_task 带上时间建一个某个时间做一次的普通任务；到点做、做完转告；过去的时间被拒", async () => {
    const delegate = call("delegate_task", { title: "查航班", instructions: "查 10 月 9 日上午从上海飞新加坡的直飞航班，列出时间和价格", at: "2026-10-09 09:00" });
    const past = call("delegate_task", { title: "查昨天的", instructions: "查一下", at: "2026-10-07 09:00" });
    const { td, clock, frontend } = await setup({ secretary: [delegate, past, ECHO, ECHO], maintainer: [say("查好了：两班直飞")] });
    await frontend.sendText("明天早上 9 点帮我查一下飞新加坡的航班");
    const created = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "助理建的任务");
    expect(created).toMatchObject({ by: "secretary", task: { kind: "plain", origin: "delegated", state: "scheduled", trigger: { kind: "schedule", schedule: { kind: "once", at: nowIso(at(10, 9, 9, 0)) } } } });
    await waitUntil(() => lastEcho(frontend, SECRETARY).includes("[toolResult] delegate_task"), { timeoutMs: 30_000, describe: () => "等助理这一轮做完" });
    const seen = lastEcho(frontend, SECRETARY);
    expect(seen).toContain("[toolResult] delegate_task: 已交给后台：普通任务 t-1「查航班」，有自己的 agent，在任务看板上（等时间）；到 10 月 9 日（周五）09:00 才开始做");
    // 过去的时间被拒，不建任务
    expect(seen).toContain("定的时间 10 月 7 日（周三）09:00 已经过了");
    expect(td.daemon.tasks.list().map((t) => t.id)).toEqual(["t-1"]);

    clock.advanceTo(at(10, 9, 9, 0));
    await stateIs(frontend, "t-1", "done");
    await waitUntil(() => noticesIn(frontend, SECRETARY).some((t) => t.includes("查好了：两班直飞")), { timeoutMs: 60_000, describe: () => "等转告" });
  }, 120_000);

  it("流程也能某个时间做一次：授权之后等时间（不是运营中、不登记触发），到点进排队照步骤做，做完即完成；长程任务照旧选不了", async () => {
    const { td, clock, frontend } = await setup({
      maintainer: (_id, spawn) => (spawn === 1 ? [call("propose_plan", notesDraft as unknown as Record<string, unknown>), say("计划交上去了")] : [LS, FIND, say("做完了")]),
    });
    ok(await frontend.startTask("整理一次周报", "k-at-flow", [], "workflow", AT_9));
    const work = path.join(dataDirLayout(td.dataDir).outputs, "t-1");
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "notes.md"), "# 周报\n");
    td.daemon.tasks.writeBrief("t-1", { goal: "整理周报", acceptanceCriteria: ["读过一遍"], constraints: [], projects: [], memoryScope: "" });
    await waitUntil(() => noticesIn(frontend, TM1).some((t) => t.includes("什么时候做：10 月 8 日（周四）09:00 做一次")), { timeoutMs: 30_000, describe: () => "等任务书" });
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "workflow_plan" && c.status === "pending", "流程计划卡");
    // 不是反复运行的：卡上不写"授权一直有效"
    expect((card.payload as WorkflowPlanCardPayload).schedule).toBeUndefined();
    await settled(td, "tm-1");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: { confirmations: [] } }));
    await stateIs(frontend, "t-1", "scheduled");
    expect(jobsOf(frontend)).toEqual([]);
    clock.advanceTo(at(10, 8, 9, 0));
    await stateIs(frontend, "t-1", "done");
    expect(changesOf(frontend, "t-1")).toContain("time_due");
    expect(td.daemon.tasks.get("t-1")!.steps).toMatchObject({ done: 2, total: 2 });

    const refused = await frontend.startTask("整理一次", "k-at-long", [], "long_running", AT_9);
    expect(refused.ok).toBe(false);
  }, 120_000);
});
