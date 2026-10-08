// 主切面：日历（35 号票，规格第 19 节"日历"、第 21 节"工作日历"）。真的守护进程，任务的维护者、作业的维护者接 faux 剧本，
// 调度器的时钟换成手动拨的（ManualClock），测试扮演前端。
// - 守护进程按月给出每一天的日历条目（GET /api/calendar?month=YYYY-MM）：工作日判定和原因；当天的提醒（一次性的、重复的展开到当天，
//   从建的那一刻起）；当天的定时作业（按时间表和"按我的工作日"展开到当天，从登记的那一刻起；跑过的带着这一次的运行记录，
//   没到点的标预计）。已取消的作业不出现，已暂停的标已暂停、不算预计；
// - 提醒、作业、工作日历变了，都是任务看板或工作日历频道上的一条事件，序号比日历里记着的大：开着日历的页面据此重新取；
// - 停机期间错过的：作业只补跑最近一次，前面几次是"跳过"；重复提醒错过几次只按最近一次处理，前面几次是"没响"。
// 录给 Web 回放的两段：calendar-month、calendar-changes
// （重新录：ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/calendar.test.ts）。
import {
  type CalendarDay,
  type CalendarMonthView,
  type Card,
  type CardEventPayload,
  CHANNELS,
  dayReasonLabel,
  EVENT_TYPES,
  maintainerChannel,
  nowIso,
  type Plan,
  type PlanCardPayload,
  type ReminderEventPayload,
  type ScheduledJobEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { pendingInputs, startedInputs } from "../../src/conversation/views.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { calendarApi, workdayApi } from "../helpers/http.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { eventually, ok, tasksOf } from "../helpers/running-task.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX, workdayCalendar: CALENDAR } = CHANNELS;

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-08 是周四；10-10 周六是国内的调休补班；10-11 周日休息） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const START = at(10, 8, 8, 0);

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });

/** 每天早上 09:00 出简报（j-1，作业自己的维护者 jm-1） */
const BRIEFING = { title: "每天早上出简报", schedule: { kind: "daily" as const, time: "09:00" }, each: "汇总昨天的新闻，写一份简报 brief.md" };
/** 按我的工作日 18:00 写日报（j-2，jm-2） */
const DAILY_REPORT = { title: "写日报", schedule: { kind: "workdays" as const, time: "18:00" }, each: "汇总今天做了什么，写进 daily.md" };

/** 一个阶段（由用户验收）的计划，带着两个作业定义 */
function jobPlan(): Plan {
  return {
    ...samplePlan(),
    stages: [
      {
        stageId: "s1",
        title: "准备模板",
        deliverables: ["template.md"],
        acceptance: [{ criterion: "你看过觉得行", method: "user" }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 100_000, toolCalls: 30 },
      },
    ],
    stageGroups: [],
    toolkit: { skills: [], mcp: [], bash: false, network: false },
    scheduledJobs: [BRIEFING, DAILY_REPORT],
    stops: { count: 1, where: ["由你验收"] },
  };
}

/** tm-1 交带着作业的计划、执行时做完准备阶段；作业的维护者照 jobs 的剧本（第 n 次唤起做第 n 次运行） */
function maintainers(jobs: Partial<Record<string, (spawn: number) => FauxStep[]>> = {}) {
  return (id: string, n: number): FauxStep[] => {
    const job = jobs[id];
    if (job) return job(n);
    if (id === "tm-1") return n === 1 ? [submitPlanStep(jobPlan()), say("计划交上去了")] : [call("complete_stage", { stageId: "s1", summary: "模板写好了" }), say("等你验收"), say("好")];
    return [say("好")];
  };
}

const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const jobsOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).map((f) => f.payload as ScheduledJobEventPayload);
const jobWhere = (frontend: TestFrontend, match: (e: ScheduledJobEventPayload) => boolean, what: string, timeoutMs?: number) => eventually(() => jobsOf(frontend), match, what, timeoutMs);
const remindersOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.reminder }).map((f) => f.payload as ReminderEventPayload);

async function connect(td: TestDaemon) {
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [INBOX]: 0, [CALENDAR]: 0 });
  return frontend;
}

/** 等这几个维护者把手上的输入都处理完：录下来的事件流里谁先谁后才确定 */
async function settled(td: TestDaemon, ...maintainerIds: string[]) {
  const busy = () => maintainerIds.filter((id) => pendingInputs(td.daemon.store.reader, maintainerChannel(id)).length + startedInputs(td.daemon.store.reader, maintainerChannel(id)).length > 0);
  await waitUntil(() => busy().length === 0, { timeoutMs: 60_000, describe: () => `${busy().join("、")} 还在处理输入` });
}

/** 建一个任务（不涉及项目）、维护者交带着两个作业的计划、确认；作业登记后做完准备阶段、验收，任务完成（不再占执行名额） */
async function registerJobs(td: TestDaemon, frontend: TestFrontend): Promise<void> {
  const task = td.daemon.tasks.createByRequest({ title: "每天的简报和日报", summary: "每天的简报和日报" });
  td.daemon.tasks.writeBrief(task.id, { goal: "每天的简报和日报", acceptanceCriteria: ["每天都有"], constraints: [], projects: [], memoryScope: "" });
  const card = await eventually(() => cardsOf(frontend), (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id, "计划卡");
  await settled(td, task.maintainerId);
  ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));
  await waitUntil(() => jobsOf(frontend).filter((e) => e.change === "registered").length === 2, { describe: () => "等两个作业登记" });
  await eventually(() => tasksOf(frontend), (e) => e.task.id === task.id && e.task.stages?.list?.[0]?.waitReason === "acceptance", "准备阶段等验收");
  ok(await frontend.taskAction({ taskId: task.id, action: "accept_stage", stageId: "s1" }));
  await eventually(() => tasksOf(frontend), (e) => e.task.id === task.id && e.change === "completed", "任务完成");
  await settled(td, task.maintainerId);
}

/** 三条提醒：10-08 14:00 交报告（一次性）、每天 07:00 吃药、按我的工作日 09:30 站会 */
function createReminders(td: TestDaemon, once = at(10, 8, 14, 0)): void {
  td.daemon.reminders.create({ text: "交报告", schedule: { kind: "once", at: nowIso(once) } }, "agent");
  td.daemon.reminders.create({ text: "吃药", schedule: { kind: "daily", time: "07:00" } }, "agent");
  td.daemon.reminders.create({ text: "站会", schedule: { kind: "workdays", time: "09:30" } }, "agent");
}

const hhmm = (iso: string) => iso.slice(11, 16);

/** 某一天压成几行：上班或休息及原因，每条提醒、每次作业（时刻、名字、状况，晚了的、补跑的写上） */
function brief(view: CalendarMonthView, date: string): string[] {
  const day: CalendarDay = view.days.find((d) => d.date === date)!;
  return [
    `${day.verdict.workday ? "上班" : "休息"} ${day.verdict.reasons.map(dayReasonLabel).join("、")}`,
    ...day.reminders.map((r) => `提醒 ${hhmm(r.at)} ${r.text} ${r.status}${r.lateMinutes === undefined ? "" : ` 晚${r.lateMinutes}`}`),
    ...day.jobs.map((j) => `作业 ${hhmm(j.at)} ${j.title} ${j.status}${j.run ? ` ${j.run.runId}${j.run.missed ? ` 错过${j.run.missed}` : ""}` : ""}`),
  ];
}

/** 前端收到的、序号比这份日历记着的大的提醒、作业事件（开着日历的页面据此重新取） */
function newerBoardChanges(frontend: TestFrontend, view: CalendarMonthView): string[] {
  return frontend
    .events({ channel: BOARD })
    .filter((f) => f.seq > view.asOf.board && (f.type === EVENT_TYPES.reminder || f.type === EVENT_TYPES.scheduledJob))
    .map((f) => `${f.type}:${(f.payload as { change: string }).change}`);
}

describe("按月给出每一天的日历条目", () => {
  it("每天的工作日判定和原因；提醒和定时作业按时间表、按我的工作日展开到当天（从建的那一刻起），没到点的是待触发、预计；到点之后带上这一次的结果；每次变化都是一条序号更大的事件", async () => {
    const clock = new ManualClock(START);
    const td = await startTestDaemon({ clock, maintainer: maintainers({ "jm-1": () => [say("简报写好了")] }) });
    const frontend = await connect(td);
    await registerJobs(td, frontend);
    createReminders(td);

    const before = await frontend.calendarMonth("2026-10");
    expect(before.month).toBe("2026-10");
    expect(before.days.map((d) => d.date)).toHaveLength(31);
    expect(before.days[0]!.date).toBe("2026-10-01");
    expect(before.missing).toEqual([]);
    // 建之前的日子上没有（10-07 国内还在放国庆，新加坡上班）
    expect(brief(before, "2026-10-07")).toEqual(["上班 新加坡工作日"]);
    // 当天：07:00 的吃药在建之前，不算；站会按工作日；作业没到点，是预计
    expect(brief(before, "2026-10-08")).toEqual([
      "上班 新加坡工作日、国内工作日",
      "提醒 09:30 站会 upcoming",
      "提醒 14:00 交报告 upcoming",
      "作业 09:00 每天早上出简报 expected",
      "作业 18:00 写日报 expected",
    ]);
    // 调休补班的周六也是我的工作日：站会、写日报都有
    expect(brief(before, "2026-10-10")).toEqual([
      "上班 调休补班",
      "提醒 07:00 吃药 upcoming",
      "提醒 09:30 站会 upcoming",
      "作业 09:00 每天早上出简报 expected",
      "作业 18:00 写日报 expected",
    ]);
    expect(brief(before, "2026-10-11")).toEqual(["休息 周末", "提醒 07:00 吃药 upcoming", "作业 09:00 每天早上出简报 expected"]);
    expect(brief(before, "2026-10-31")).toEqual(["休息 周末", "提醒 07:00 吃药 upcoming", "作业 09:00 每天早上出简报 expected"]);

    // 09:00 简报到点、跑完；09:30 站会响了
    clock.advanceTo(at(10, 8, 9, 0));
    await jobWhere(frontend, (e) => e.change === "run_finished", "简报跑完");
    await settled(td, "jm-1");
    clock.advanceTo(at(10, 8, 9, 30));
    await eventually(() => remindersOf(frontend), (e) => e.change === "fired", "站会响了");
    // 这些变化都推到了开着的页面上，序号比上一份日历记着的大
    expect(newerBoardChanges(frontend, before)).toEqual(["scheduled_job:triggered", "scheduled_job:run_started", "scheduled_job:run_finished", "reminder:fired"]);

    const after = await frontend.calendarMonth("2026-10");
    expect(after.asOf.board).toBeGreaterThan(before.asOf.board);
    expect(brief(after, "2026-10-08")).toEqual([
      "上班 新加坡工作日、国内工作日",
      "提醒 09:30 站会 fired",
      "提醒 14:00 交报告 upcoming",
      "作业 09:00 每天早上出简报 done j-1-r1",
      "作业 18:00 写日报 expected",
    ]);
    // 下一天照旧是预计
    expect(brief(after, "2026-10-09")).toEqual([
      "上班 新加坡工作日、国内工作日",
      "提醒 07:00 吃药 upcoming",
      "提醒 09:30 站会 upcoming",
      "作业 09:00 每天早上出简报 expected",
      "作业 18:00 写日报 expected",
    ]);
    // 作业条目带着项目归属（这两个不属于项目）、时间表和运行记录
    const ran = after.days.find((d) => d.date === "2026-10-08")!.jobs[0]!;
    expect(ran).toMatchObject({ jobId: "j-1", schedule: BRIEFING.schedule, run: { runId: "j-1-r1", state: "done", trigger: "scheduled", dueAt: nowIso(at(10, 8, 9, 0)) } });
    expect(ran.projectId).toBeUndefined();

    // 录下来给前端回放：日历格子上的数、某一天的详情、收到更新的事件后重新取
    saveOrCheckRecording("calendar-month", frontend.recording, { perChannel: true });
  }, 120_000);

  it("别的月份一次取一个月；月份写法不对被拒", async () => {
    const td = await startTestDaemon({ clock: new ManualClock(START) });
    const { status, body } = await calendarApi.month(td.url, "2027-01");
    expect(status).toBe(200);
    expect(body.days).toHaveLength(31);
    // 国内 2027 的节假日数据还没有：标明缺了
    expect(body.missing).toEqual(["cn"]);
    expect(body.days[0]!.verdict.missing).toEqual(["cn"]);
    expect(await calendarApi.month(td.url, "2026-13")).toMatchObject({ status: 400, body: { code: "bad_request" } });
    expect(await calendarApi.month(td.url, "")).toMatchObject({ status: 400, body: { code: "bad_request" } });
  });
});

describe("提醒、作业、工作日历变了", () => {
  it("一次运行失败标失败；某天标成休息，按我的工作日的提醒和作业那天就没有了；暂停的作业以后标已暂停；取消的作业不再出现（连同跑过的）；每次变化都是一条序号更大的事件", async () => {
    const clock = new ManualClock(START);
    const td = await startTestDaemon({ clock, maintainer: maintainers({ "jm-1": () => [call("fail_job_run", { reason: "新闻源打不开" }), say("这次做不了")] }) });
    const frontend = await connect(td);
    await registerJobs(td, frontend);
    createReminders(td);
    let view = await frontend.calendarMonth("2026-10");

    // 09:00 简报失败
    clock.advanceTo(at(10, 8, 9, 0));
    await jobWhere(frontend, (e) => e.change === "run_finished", "简报跑完");
    await settled(td, "jm-1");
    expect(newerBoardChanges(frontend, view)).toEqual(["scheduled_job:triggered", "scheduled_job:run_started", "scheduled_job:run_finished"]);
    view = await frontend.calendarMonth("2026-10");
    expect(brief(view, "2026-10-08").filter((line) => line.startsWith("作业"))).toEqual(["作业 09:00 每天早上出简报 failed j-1-r1", "作业 18:00 写日报 expected"]);
    expect(view.days.find((d) => d.date === "2026-10-08")!.jobs[0]!.run).toMatchObject({ state: "failed", reason: "新闻源打不开" });

    // 10-09（周五）标成休息：按我的工作日的站会、写日报那天没有了；每天的照旧
    const seenWorkday = view.asOf.workdayCalendar;
    expect((await workdayApi.change(td.url, { kind: "mark", date: "2026-10-09", mark: "rest" })).status).toBe(200);
    await waitUntil(() => frontend.events({ channel: CALENDAR, type: EVENT_TYPES.workdaySettings }).some((f) => f.seq > seenWorkday), { describe: () => "等工作日历的事件" });
    view = await frontend.calendarMonth("2026-10");
    expect(view.asOf.workdayCalendar).toBeGreaterThan(seenWorkday);
    expect(brief(view, "2026-10-09")).toEqual(["休息 手动标记休息", "提醒 07:00 吃药 upcoming", "作业 09:00 每天早上出简报 expected"]);

    // 暂停简报：以后的标已暂停（不算预计），已经失败的那次照旧
    ok(await frontend.scheduledJobAction({ jobId: "j-1", action: "pause" }));
    await jobWhere(frontend, (e) => e.change === "paused", "暂停");
    expect(newerBoardChanges(frontend, view)).toEqual(["scheduled_job:paused"]);
    view = await frontend.calendarMonth("2026-10");
    expect(brief(view, "2026-10-08").filter((line) => line.startsWith("作业"))).toEqual(["作业 09:00 每天早上出简报 failed j-1-r1", "作业 18:00 写日报 expected"]);
    expect(brief(view, "2026-10-12").filter((line) => line.startsWith("作业"))).toEqual(["作业 09:00 每天早上出简报 paused", "作业 18:00 写日报 expected"]);

    // 取消写日报：哪天都不再出现
    ok(await frontend.scheduledJobAction({ jobId: "j-2", action: "cancel" }));
    await jobWhere(frontend, (e) => e.change === "cancelled", "取消");
    expect(newerBoardChanges(frontend, view)).toEqual(["scheduled_job:cancelled"]);
    view = await frontend.calendarMonth("2026-10");
    expect(view.days.flatMap((d) => d.jobs).some((j) => j.jobId === "j-2")).toBe(false);
    expect(brief(view, "2026-10-12").filter((line) => line.startsWith("作业"))).toEqual(["作业 09:00 每天早上出简报 paused"]);

    // 取消一条提醒：同样是一条事件，以后不再出现
    td.daemon.reminders.cancel("r-2", "agent");
    await eventually(() => remindersOf(frontend), (e) => e.change === "cancelled", "取消提醒");
    expect(newerBoardChanges(frontend, view)).toEqual(["reminder:cancelled"]);
    view = await frontend.calendarMonth("2026-10");
    expect(brief(view, "2026-10-12")).toEqual(["上班 新加坡工作日、国内工作日", "提醒 09:30 站会 upcoming", "作业 09:00 每天早上出简报 paused"]);

    saveOrCheckRecording("calendar-changes", frontend.recording, { perChannel: true });

    // 恢复作业、新建提醒、改提醒的时间：同样是序号更大的事件；改了时间的从改的那一刻起按新的时间展开
    ok(await frontend.scheduledJobAction({ jobId: "j-1", action: "resume" }));
    await jobWhere(frontend, (e) => e.change === "resumed", "恢复");
    td.daemon.reminders.create({ text: "取快递", schedule: { kind: "once", at: nowIso(at(10, 12, 18, 0)) } }, "agent");
    td.daemon.reminders.update("r-3", { schedule: { kind: "workdays", time: "10:00" } }, "agent");
    await eventually(() => remindersOf(frontend), (e) => e.change === "updated", "改提醒");
    expect(newerBoardChanges(frontend, view)).toEqual(["scheduled_job:resumed", "reminder:created", "reminder:updated"]);
    view = await frontend.calendarMonth("2026-10");
    expect(brief(view, "2026-10-08").filter((line) => line.startsWith("提醒"))).toEqual(["提醒 10:00 站会 upcoming", "提醒 14:00 交报告 upcoming"]);
    expect(brief(view, "2026-10-12")).toEqual(["上班 新加坡工作日、国内工作日", "提醒 10:00 站会 upcoming", "提醒 18:00 取快递 upcoming", "作业 09:00 每天早上出简报 expected"]);
  }, 120_000);
});

describe("停机期间错过的", () => {
  it("作业只补跑最近一次，前面错过的几次是跳过；重复提醒错过几次只按最近一次处理（晚太久的是错过），前面几次是没响；晚了 60 分钟以内照发的写明晚了多久", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const maintainer = maintainers({ "jm-1": () => [say("补出了今天的简报")], "jm-2": () => [say("补写了日报")] });
    const first = await startTestDaemon({ clock: new ManualClock(START), reuse: { dataDir, homeDir }, maintainer });
    const frontend = await connect(first);
    await registerJobs(first, frontend);
    createReminders(first, at(10, 10, 9, 0));
    await frontend.close();
    await first.daemon.stop();

    // 停到 10-10 09:20 才起来：简报错过 10-08、10-09、10-10 三次，写日报错过 10-08、10-09 两次；交报告晚了 20 分钟；
    // 吃药错过 10-09、10-10 两次，最近一次晚了 2 小时 20 分钟；站会错过 10-08、10-09 两次，最近一次晚了 23 小时 50 分钟
    const second = await startTestDaemon({ clock: new ManualClock(at(10, 10, 9, 20)), reuse: { dataDir, homeDir }, maintainer });
    const again = await connect(second);
    await waitUntil(() => jobsOf(again).filter((e) => e.change === "run_finished").length === 2, { timeoutMs: 60_000, describe: () => "等两次补跑做完" });
    await waitUntil(() => remindersOf(again).filter((e) => e.change === "missed" || e.change === "fired").length === 3, { describe: () => "等三条提醒处理完" });
    const view = await again.calendarMonth("2026-10");

    expect(brief(view, "2026-10-08")).toEqual(["上班 新加坡工作日、国内工作日", "提醒 09:30 站会 skipped", "作业 09:00 每天早上出简报 skipped", "作业 18:00 写日报 skipped"]);
    expect(brief(view, "2026-10-09")).toEqual([
      "上班 新加坡工作日、国内工作日",
      "提醒 07:00 吃药 skipped",
      "提醒 09:30 站会 missed 晚1430",
      "作业 09:00 每天早上出简报 skipped",
      "作业 18:00 写日报 done j-2-r1 错过2",
    ]);
    expect(brief(view, "2026-10-10")).toEqual([
      "上班 调休补班",
      "提醒 07:00 吃药 missed 晚140",
      "提醒 09:00 交报告 fired 晚20",
      "提醒 09:30 站会 upcoming",
      "作业 09:00 每天早上出简报 done j-1-r1 错过3",
      "作业 18:00 写日报 expected",
    ]);
  }, 120_000);
});
