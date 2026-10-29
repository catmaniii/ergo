// 98 号票：定时触发的任务改时间（不用取消重建）。任务操作菜单里运营中的定时任务多一项"改时间"，预填它的触发登记现在的时间表；
// 改时间的对话框和发起任务对话框同一套时间表编辑（按时间表反复做 / 某个时间做一次）：从现在的时间表起草、时间已过的不能存、
// 保存后的提示（"已改成每天 08:00，下次 10 月 13 日（周二）08:00"）；守护进程推来 rescheduled 之后卡上、详情里是新的时间表。
import { describe, expect, test } from "vitest";
import {
  draftSchedule,
  type ReminderSchedule,
  replay,
  rescheduleBlocked,
  rescheduleDraft,
  rescheduledToast,
  type ScheduledJob,
  type ScheduledJobState,
  type Task,
  taskMenu,
  taskTriggerView,
} from "../../src/state/index.ts";
import { nowIso } from "../../src/util/time.ts";
import { frame } from "./events.ts";

/** 本地时间 2026 年 10 月 d 日 hh:mm（10 月 12 日是周一） */
const oct = (d: number, hh: number, mm = 0) => new Date(2026, 9, d, hh, mm);
const DAILY_9: ReminderSchedule = { kind: "daily", time: "09:00" };
const DAILY_8: ReminderSchedule = { kind: "daily", time: "08:00" };

const task: Task = {
  id: "t-5",
  title: "调研最新的 AI 新闻",
  summary: "调研最新的 AI 新闻，总结成文本发给我",
  state: "operating",
  origin: "button",
  kind: "plain",
  trigger: { kind: "schedule", schedule: DAILY_9 },
  maintainerId: "tm-5",
  projects: [],
  projectIds: [],
  projectScope: "none",
  createdAt: nowIso(oct(11, 21, 30)),
  updatedAt: nowIso(oct(11, 21, 30)),
};

const job = (state: ScheduledJobState, extra: Partial<ScheduledJob> = {}): ScheduledJob => ({
  id: "j-1",
  title: task.title,
  schedule: DAILY_9,
  each: task.summary,
  maintainerId: "tm-5",
  taskId: "t-5",
  taskTitle: task.title,
  ownerTaskId: "t-5",
  grants: [],
  temporalRules: [],
  grantInfo: {},
  state,
  lastFailed: false,
  consecutiveFailures: 0,
  runCount: 1,
  createdAt: task.createdAt,
  updatedAt: task.createdAt,
  ...extra,
});

describe("菜单里的“改时间”：运营中的定时任务才有，预填现在的时间表", () => {
  const ui = replay([
    frame("board", 1, "task", { task, change: "created", from: null, by: "user" }),
    frame("board", 2, "scheduled_job", { job: job("active", { nextAt: nowIso(oct(12, 9)) }), change: "registered", by: "user" }),
  ]);

  test("触发登记带着能改的时间表；看板卡、任务详情的菜单：暂停、改时间、取消任务（改时间带着现在的时间表）", () => {
    const view = taskTriggerView(ui, "t-5")!;
    expect(view.reschedule).toEqual(DAILY_9);
    const subject = { ...task, triggerActions: view.actions, reschedule: view.reschedule };
    expect(taskMenu(subject, "board").map((i) => i.label)).toEqual(["打开", "暂停", "改时间", "取消任务", "归档", "删除任务", "多选"]);
    expect(taskMenu(subject, "detail").find((i) => i.kind === "reschedule")).toEqual({ kind: "reschedule", label: "改时间", schedule: DAILY_9, paused: false });
  });

  test("暂停着的也能改（标着暂停着）；已取消的、事件触发的（没有时间表）没有“改时间”", () => {
    const paused = replay([frame("board", 3, "scheduled_job", { job: job("paused", { pausedBy: "user" }), change: "paused", by: "user" })], ui);
    const view = taskTriggerView(paused, "t-5")!;
    expect(taskMenu({ ...task, triggerActions: view.actions, reschedule: view.reschedule }, "detail").map((i) => i.label)).toEqual(["恢复", "改时间", "取消任务", "归档", "删除任务"]);
    expect(taskMenu({ ...task, triggerActions: view.actions, reschedule: view.reschedule }, "detail").find((i) => i.kind === "reschedule")).toMatchObject({ paused: true });

    const cancelled = replay([frame("board", 3, "scheduled_job", { job: job("cancelled"), change: "cancelled", by: "user" })], ui);
    expect(taskTriggerView(cancelled, "t-5")!.reschedule).toBeUndefined();

    const { schedule: _s, ...rest } = job("active");
    const evented = replay([frame("board", 3, "scheduled_job", { job: { ...rest, event: { kind: "event", source: "ergo", events: ["task_done"] } }, change: "registered", by: "user" })], ui);
    const ev = taskTriggerView(evented, "t-5")!;
    expect(ev.reschedule).toBeUndefined();
    expect(taskMenu({ ...task, triggerActions: ev.actions, reschedule: ev.reschedule }, "detail").map((i) => i.label)).toEqual(["暂停", "取消任务", "归档", "删除任务"]);
  });

  test("守护进程推来 rescheduled（用户改的）：卡上、详情里是新的时间表和下一次，菜单预填新的", () => {
    const moved = replay([frame("board", 3, "scheduled_job", { job: job("active", { schedule: DAILY_8, nextAt: nowIso(oct(13, 8)) }), change: "rescheduled", by: "user" })], ui);
    const view = taskTriggerView(moved, "t-5")!;
    expect(view.scheduleText).toBe("每天 08:00");
    expect(view.job.nextAt).toBe(nowIso(oct(13, 8)));
    expect(view.reschedule).toEqual(DAILY_8);
  });
});

describe("改时间的对话框：从现在的时间表起草，和发起任务对话框同一套（按时间表反复做 / 某个时间做一次）", () => {
  test("现在是反复的：选中“按时间表反复做”、预填它；切到“某个时间做一次”时是这个钟点的下一次", () => {
    const draft = rescheduleDraft(DAILY_9, oct(12, 10));
    expect(draft).toEqual({ mode: "repeat", repeat: DAILY_9, at: { kind: "once", at: nowIso(oct(13, 9)) } });
    expect(draftSchedule(draft)).toEqual(DAILY_9);
    expect(draftSchedule({ ...draft, mode: "at" })).toEqual({ kind: "once", at: nowIso(oct(13, 9)) });
    // 按我的工作日、每周几的照原样预填
    expect(rescheduleDraft({ kind: "workdays", time: "08:00" }, oct(12, 7)).repeat).toEqual({ kind: "workdays", time: "08:00" });
    expect(rescheduleDraft({ kind: "workdays", time: "08:00" }, oct(12, 7)).at).toEqual({ kind: "once", at: nowIso(oct(12, 8)) });
  });

  test("现在是某个时间做一次：选中“某个时间做一次”、预填那个时间；切到反复的是每天这个钟点", () => {
    const once: ReminderSchedule = { kind: "once", at: nowIso(oct(13, 8, 30)) };
    expect(rescheduleDraft(once, oct(12, 10))).toEqual({ mode: "at", repeat: { kind: "daily", time: "08:30" }, at: once });
  });

  test("不能存的：某个时间做一次的时间已经过了；和现在的一样（没改）", () => {
    const draft = rescheduleDraft(DAILY_9, oct(12, 10));
    expect(rescheduleBlocked(draft, DAILY_9, oct(12, 10).getTime())).toBe("还是现在的时间表");
    expect(rescheduleBlocked({ ...draft, repeat: DAILY_8 }, DAILY_9, oct(12, 10).getTime())).toBeUndefined();
    const passed = { ...draft, mode: "at" as const, at: { kind: "once" as const, at: nowIso(oct(12, 8)) } };
    expect(rescheduleBlocked(passed, DAILY_9, oct(12, 10).getTime())).toBe("这个时间已经过了：定一个将来的时间");
    expect(rescheduleBlocked({ ...passed, at: { kind: "once", at: nowIso(oct(13, 8)) } }, DAILY_9, oct(12, 10).getTime())).toBeUndefined();
  });

  test("保存后的提示：改成了什么、下一次什么时候（守护进程回的）；暂停着的说恢复后按新的；某个时间做一次的说运行一次", () => {
    expect(rescheduledToast({ state: "active", schedule: DAILY_8, nextAt: nowIso(oct(13, 8)) })).toBe("已改成每天 08:00，下次 10 月 13 日（周二）08:00");
    expect(rescheduledToast({ state: "paused", schedule: DAILY_8 })).toBe("已改成每天 08:00：现在暂停着，恢复后按新的时间运行");
    expect(rescheduledToast({ state: "active", schedule: { kind: "once", at: nowIso(oct(13, 8)) }, nextAt: nowIso(oct(13, 8)) })).toBe("已改成 10 月 13 日（周二）08:00 运行一次");
  });
});
