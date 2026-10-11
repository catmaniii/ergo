// 前端状态层：任务看板（12 号票）。看板频道上的 task 事件是任务的最新状态，按规格的五组显示：
// 等我（等我、待确认）、进行中（规划中、排队中、执行中、已暂停）、运营中（简单提醒、定时触发的任务）、
// 最近结束（已完成、失败、已取消，以及已触发的一次性简单提醒）、已归档。全部任务状态到分组的对应用构造的事件流逐一验证。
import { describe, expect, test } from "vitest";
import {
  type BoardGroup,
  type BoardItem,
  boardGroups,
  describeTime,
  taskStatusText,
  isPlainTask,
  taskAcceptsMessages,
  taskControls,
  jobAuthorizationLines,
  lastRunText,
  type JobRun,
  type Reminder,
  taskRunViews,
  replay,
  type ScheduledJob,
  type ScheduledJobState,
  type Task,
  TASK_STATES,
  type TaskState,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

function task(id: string, state: TaskState, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    summary: "",
    state,
    origin: "button",
    maintainerId: `tm-${id}`,
    projects: [],
    createdAt: "2026-10-08T09:00:00.000+08:00",
    updatedAt: "2026-10-08T09:00:00.000+08:00",
    ...overrides,
  };
}

function reminder(id: string, status: Reminder["status"], nextAt?: string): Reminder {
  return {
    id,
    text: id,
    schedule: { kind: "once", at: "2026-10-09T09:00:00.000+08:00" },
    status,
    ...(nextAt === undefined ? {} : { nextAt }),
    cardId: `c-${id}`,
    createdAt: "2026-10-08T09:00:00.000+08:00",
    updatedAt: "2026-10-08T09:00:00.000+08:00",
  };
}

/** 看板上一项的名字：任务是 id，提醒是 r:id，定时作业是 j:id */
const itemName = (i: BoardItem) => (i.kind === "task" ? i.task.id : i.kind === "reminder" ? `r:${i.reminder.id}` : `j:${i.view.job.id}`);

/** 每组里的条目 */
function groupsOf(state: ReturnType<typeof replay>): Record<BoardGroup, string[]> {
  return Object.fromEntries(boardGroups(state).map((g) => [g.group, g.items.map(itemName)])) as Record<BoardGroup, string[]>;
}

describe("任务状态到看板分组", () => {
  test.each([
    ["planning", "active"],
    ["awaiting_confirm", "waiting"],
    ["queued", "active"],
    ["running", "active"],
    ["waiting_for_user", "waiting"],
    ["paused", "active"],
    ["operating", "ops"],
    ["done", "ended"],
    ["failed", "ended"],
    ["cancelled", "ended"],
    ["archived", "archived"],
  ] as const)("%s → %s", (state, group) => {
    const ui = replay([frame("board", 1, "task", { task: task("t-1", state), change: "created", from: null, by: "user" })]);
    expect(groupsOf(ui)[group]).toEqual(["t-1"]);
  });

  test("十二种状态都有归属（76 号票多了运营中：定时触发的任务登记好了按时间表运行；等时间：某个时间做一次、还没到点的在进行中）；五组按规格的顺序", () => {
    expect(TASK_STATES).toHaveLength(12);
    const ui = replay(TASK_STATES.map((s, i) => frame("board", i + 1, "task", { task: task(`t-${i + 1}`, s), change: "created", from: null, by: "user" })));
    expect(boardGroups(ui).map((g) => [g.group, g.title, g.items.length])).toEqual([
      ["waiting", "等我", 2],
      ["active", "进行中", 5],
      ["ops", "运营中", 1],
      ["ended", "最近结束", 3],
      ["archived", "已归档", 1],
    ]);
  });

  test("某个时间做一次、还没到点的（等时间）：在进行中一组，状态写那个时间", () => {
    const at = "2026-10-09T09:00:00.000+08:00";
    const ui = replay([frame("board", 1, "task", { task: task("t-1", "scheduled", { kind: "plain", trigger: { kind: "schedule", schedule: { kind: "once", at } } }), change: "created", from: null, by: "user" })]);
    expect(groupsOf(ui).active).toEqual(["t-1"]);
    expect(taskStatusText(ui.tasks["t-1"]!)).toBe(`等时间 · ${describeTime(new Date(at))} 做`);
  });

  test("同一个任务的新事件替换旧状态：规划中 → 待确认 → 排队中，从进行中挪到等我再回到进行中", () => {
    const events = [
      frame("board", 1, "task", { task: task("t-1", "planning"), change: "created", from: null, by: "secretary" }),
      frame("board", 2, "task", { task: task("t-1", "awaiting_confirm", { stages: { total: 3 }, planCardId: "c-plan" }), change: "plan_submitted", from: "planning", by: "maintainer" }),
    ];
    expect(groupsOf(replay(events)).waiting).toEqual(["t-1"]);
    const queued = replay([...events, frame("board", 3, "task", { task: task("t-1", "queued", { stages: { total: 3 } }), change: "plan_confirmed", from: "awaiting_confirm", by: "user" })]);
    expect(groupsOf(queued)).toMatchObject({ waiting: [], active: ["t-1"] });
    expect(boardGroups(queued)[1]!.items[0]).toMatchObject({ kind: "task", task: { state: "queued", stages: { total: 3 } } });
  });

  test("同一组里新近有变化的任务在前", () => {
    const ui = replay([
      frame("board", 1, "task", { task: task("t-old", "planning", { updatedAt: "2026-10-08T08:00:00.000+08:00" }), change: "created", from: null, by: "user" }),
      frame("board", 2, "task", { task: task("t-new", "queued", { updatedAt: "2026-10-08T10:00:00.000+08:00" }), change: "created", from: null, by: "user" }),
    ]);
    expect(groupsOf(ui).active).toEqual(["t-new", "t-old"]);
  });
});

describe("普通任务（75 号票）", () => {
  test("和别的任务一样按状态分组：排队中、执行中在进行中，做完了在最近结束；做完了的还收消息（接着说），控制里没有返工", () => {
    const plain = (state: TaskState) => task("t-p", state, { kind: "plain", origin: "delegated" });
    expect(groupsOf(replay([frame("board", 1, "task", { task: plain("queued"), change: "created", from: null, by: "secretary" })])).active).toEqual(["t-p"]);
    const done = replay([
      frame("board", 1, "task", { task: plain("queued"), change: "created", from: null, by: "secretary" }),
      frame("board", 2, "task", { task: plain("running"), change: "started", from: "queued", by: "system" }),
      frame("board", 3, "task", { task: plain("done"), change: "completed", from: "running", by: "system" }),
    ]);
    expect(groupsOf(done).ended).toEqual(["t-p"]);
    const t = done.tasks["t-p"]!;
    expect(isPlainTask(t)).toBe(true);
    expect(taskAcceptsMessages(t)).toBe(true);
    expect(taskControls(t).map((c) => c.action)).not.toContain("rework");
    // 有计划的任务做完了不再收消息
    expect(taskAcceptsMessages(task("t-l", "done", { kind: "long_running" }))).toBe(false);
  });
});

describe("简单提醒和活动状态", () => {
  test("待触发的提醒在运营中，已触发的一次性提醒在最近结束，已取消的不上看板", () => {
    const ui = replay([
      frame("board", 1, "reminder", { reminder: reminder("r-1", "pending", "2026-10-09T09:00:00.000+08:00"), change: "created", by: "agent" }),
      frame("board", 2, "reminder", { reminder: reminder("r-2", "fired"), change: "fired", by: "system" }),
      frame("board", 3, "reminder", { reminder: reminder("r-3", "cancelled"), change: "cancelled", by: "user" }),
    ]);
    expect(groupsOf(ui)).toMatchObject({ ops: ["r:r-1"], ended: ["r:r-2"] });
  });

  test("任务卡带上它的维护者的活动状态（排队）；重新同步看板频道清掉任务和提醒", () => {
    const ui = replay([
      frame("board", 1, "task", { task: task("t-1", "planning"), change: "created", from: null, by: "user" }),
      frame("activity", 1, "activity", { agentId: "tm-t-1", state: "queued", since: "2026-10-08T09:00:01.000+08:00" }),
    ]);
    expect(boardGroups(ui)[1]!.items[0]).toMatchObject({ kind: "task", activity: { state: "queued" } });
    const cleared = replay([{ kind: "resync", channel: "board" }], ui);
    expect(boardGroups(cleared).flatMap((g) => g.items)).toEqual([]);
    expect(cleared.activity["tm-t-1"]?.state).toBe("queued");
  });
});

function job(id: string, state: ScheduledJobState, createdAt: string): ScheduledJob {
  return {
    id,
    title: id,
    schedule: { kind: "daily", time: "09:00" },
    each: "出一份简报",
    maintainerId: `jm-${id}`,
    taskId: "t-1",
    taskTitle: "每天早上出简报",
    state,
    lastFailed: false,
    consecutiveFailures: 0,
    runCount: 0,
    grants: [],
    temporalRules: [],
    grantInfo: {},
    createdAt,
    updatedAt: createdAt,
  };
}

describe("定时作业（19 号票）", () => {
  test("作业卡上每次运行的授权：授权项的主文由代码生成（次数按每次运行算、作业在就一直有效），维护者写的标题在前；时序规则一行一条", () => {
    const lines = jobAuthorizationLines({
      grants: [{ id: "send", tool: "http_request", title: "把日报发到 hook", scope: { url: "http://127.0.0.1/daily" }, maxUses: 1 }],
      grantInfo: {},
      temporalRules: [{ id: "no-secret", title: "不往 secret 发", trigger: { tool: "http_request" }, on_violation: "block" }],
    });
    expect(lines.grants).toEqual(["把日报发到 hook：http_request：url 是 http://127.0.0.1/daily；每次运行最多 1 次；任务在运营就一直有效，暂停、取消即收回"]);
    expect(lines.rules).toHaveLength(1);
    expect(lines.rules[0]).toContain("http_request");
  });

  test("运营中、已暂停的作业都在运营中分组，排在任务和提醒之后，先登记的在前；已取消的不上看板；重新同步看板频道清掉作业", () => {
    const ui = replay([
      frame("board", 1, "scheduled_job", { job: job("j-2", "active", "2026-10-08T10:00:00.000+08:00"), change: "registered", by: "user" }),
      frame("board", 2, "scheduled_job", { job: job("j-1", "paused", "2026-10-08T09:00:00.000+08:00"), change: "paused", by: "user" }),
      frame("board", 3, "scheduled_job", { job: job("j-3", "cancelled", "2026-10-08T08:00:00.000+08:00"), change: "cancelled", by: "user" }),
      frame("board", 4, "reminder", { reminder: reminder("r-1", "pending", "2026-10-09T09:00:00.000+08:00"), change: "created", by: "agent" }),
    ]);
    expect(groupsOf(ui).ops).toEqual(["r:r-1", "j:j-1", "j:j-2"]);
    expect(Object.values(groupsOf(ui)).flat()).not.toContain("j:j-3");
    const cleared = replay([{ kind: "resync", channel: "board" }], ui);
    expect(cleared.scheduledJobs).toEqual({});
    expect(cleared.jobRuns).toEqual({});
  });
});

/** 定时触发的任务 t-1 的触发登记 j-1（76 号票：ownerTaskId 指向任务） */
const owned = (state: ScheduledJobState, extra: Partial<ScheduledJob> = {}): ScheduledJob => ({ ...job("j-1", state, "2026-10-08T08:00:00.000+08:00"), maintainerId: "tm-t-1", ownerTaskId: "t-1", ...extra });
/** 每天 09:00 定时触发的普通任务 t-1 */
const timed = (state: TaskState) => task("t-1", state, { kind: "plain", trigger: { kind: "schedule", schedule: { kind: "daily", time: "09:00" } } });
/** j-1 的第 n 次运行（10 月 7+n 日 09:00 到点） */
const run = (n: number, state: JobRun["state"], extra: Partial<JobRun> = {}): JobRun => ({
  runId: `j-1-r${n}`,
  jobId: "j-1",
  trigger: "scheduled",
  dueAt: `2026-10-0${7 + n}T09:00:00.000+08:00`,
  events: [{ source: "time", at: `2026-10-0${7 + n}T09:00:00.000+08:00`, summary: `10 月 ${7 + n} 日 09:00 到点` }],
  state,
  queuedAt: `2026-10-0${7 + n}T09:00:00.000+08:00`,
  startedAt: `2026-10-0${7 + n}T09:00:00.000+08:00`,
  endedAt: `2026-10-0${7 + n}T09:05:00.000+08:00`,
  ...extra,
});

describe("定时触发的任务（76 号票）", () => {

  test("运营中的任务在运营中一组，卡上带着它的触发登记（时间表、下一次、能做的动作）；触发登记不单独占卡；取消了任务到最近结束", () => {
    const ui = replay([
      frame("board", 1, "task", { task: timed("operating"), change: "created", from: null, by: "user" }),
      frame("board", 2, "scheduled_job", { job: owned("active", { nextAt: "2026-10-09T09:00:00.000+08:00" }), change: "registered", by: "user" }),
    ]);
    expect(groupsOf(ui).ops).toEqual(["t-1"]);
    const [item] = boardGroups(ui).find((g) => g.group === "ops")!.items;
    expect(item).toMatchObject({ kind: "task", trigger: { statusText: "运营中", scheduleText: "每天 09:00", actions: ["pause", "cancel"], job: { id: "j-1", nextAt: "2026-10-09T09:00:00.000+08:00" } } });
    // 触发登记暂停着：任务还在运营中一组，卡上写已暂停、能恢复
    const paused = replay([frame("board", 3, "scheduled_job", { job: owned("paused", { pausedBy: "failures", consecutiveFailures: 3 }), change: "paused", by: "system" })], ui);
    expect(boardGroups(paused).find((g) => g.group === "ops")!.items[0]).toMatchObject({ trigger: { statusText: "已暂停（连续失败 3 次，自动暂停）", actions: ["resume", "cancel"] } });
    // 取消：触发登记和任务一起取消，任务到最近结束（不再有作业卡）
    const cancelled = replay(
      [
        frame("board", 3, "scheduled_job", { job: owned("cancelled"), change: "cancelled", by: "user" }),
        frame("board", 4, "task", { task: timed("cancelled"), change: "cancelled", from: "operating", by: "user" }),
      ],
      ui,
    );
    expect(groupsOf(cancelled)).toMatchObject({ ops: [], ended: ["t-1"] });
  });

  test("任务详情的运行一栏：新的在前，合并成一批的逐条列出，失败的带原因，流程这次做完几步；卡上最近一次的写法", () => {
    const merged = run(2, "done", { events: [{ source: "time", at: "2026-10-09T09:00:00.000+08:00", summary: "10 月 9 日 09:00 到点" }, { source: "time", at: "2026-10-10T09:00:00.000+08:00", summary: "10 月 10 日 09:00 到点" }], steps: [{ stepId: "s1", title: "看", state: "done" }, { stepId: "s2", title: "写", state: "skipped" }, { stepId: "s3", title: "发", state: "pending" }] });
    const ui = replay([
      frame("board", 1, "task", { task: timed("operating"), change: "created", from: null, by: "user" }),
      frame("board", 2, "scheduled_job", { job: owned("active"), change: "run_finished", by: "system", run: run(1, "failed", { reason: "新闻源打不开" }) }),
      frame("board", 3, "scheduled_job", { job: owned("active"), change: "run_finished", by: "system", run: merged }),
    ]);
    expect(taskRunViews(ui, "t-1").map((r) => [r.no, r.trigger, r.stateText, r.reason ?? null, r.steps ?? null])).toEqual([
      // 做完几步只算"做完"的，跳过的不算（60 号票，照 AgentSense）
      [2, "合并了 2 次触发", "成功", null, { done: 1, total: 3 }],
      [1, "10 月 8 日 09:00 到点", "失败", "新闻源打不开", null],
    ]);
    expect(taskRunViews(ui, "t-1")[0]!.triggers).toEqual(["10 月 9 日 09:00 到点", "10 月 10 日 09:00 到点"]);
    expect(lastRunText(run(1, "failed"))).toEqual({ text: "最近一次：失败 · 10 月 8 日（周四）09:05", ok: false });
    expect(lastRunText(undefined)).toBeUndefined();
  });
});
