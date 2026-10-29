// 156 号票：看板上简单提醒的卡也能长按 / 右键管理、能多选。菜单项照提醒现在能做的（改时间、取消提醒），后面"多选"；
// 多选时提醒能一起做的只有取消，和任务混着选时批量动作只给两者都能做的（取消），别的灰掉、写明为什么；
// 改时间的对话框（时间已过、没改的不能存）和保存后的提示。表格驱动，纯函数。
// 185 号票：已经结束的（一次性的已触发、已取消）能归档，任何提醒能删（先确认）；多选里提醒能一起取消、归档、删除，
// 和任务混选只给两者都能做的（取消、归档；186 号票起任务也能删，删除对两边都生效）。
import { describe, expect, test } from "vitest";
import {
  batchCancelConfirm,
  batchCounts,
  batchResult,
  type BoardBatchEntry,
  boardBatchCancelConfirm,
  boardBatchCounts,
  boardBatchDeleteConfirm,
  boardBatchTargets,
  boardBatchWhy,
  type ReminderMenuSubject,
  type ReminderSchedule,
  reminderDeleteConfirm,
  reminderMenu,
  reminderRescheduleBlocked,
  reminderRescheduledToast,
} from "../../src/state/index.ts";
import { nowIso } from "../../src/util/time.ts";

/** 本地时间 2026 年 10 月 d 日 hh:mm（10 月 12 日是周一） */
const oct = (d: number, hh: number, mm = 0) => new Date(2026, 9, d, hh, mm);
const DAILY_9: ReminderSchedule = { kind: "daily", time: "09:00" };
const MONTHLY_8: ReminderSchedule = { kind: "monthly", time: "09:00", days: [8] };

const labels = (r: ReminderMenuSubject) => reminderMenu(r).map((i) => i.label);

describe("提醒卡的长按 / 右键菜单：照提醒现在能做的", () => {
  test("待触发、到点提醒的：改时间（带着现在的时间表）、取消提醒（收不回，标红）、删除提醒（先确认，标红）、多选", () => {
    expect(labels({ status: "pending", schedule: MONTHLY_8 })).toEqual(["改时间", "取消提醒", "删除提醒", "多选"]);
    expect(reminderMenu({ status: "pending", schedule: MONTHLY_8 })).toEqual([
      { kind: "reschedule", label: "改时间", schedule: MONTHLY_8 },
      { kind: "cancel", label: "取消提醒", tone: "danger" },
      { kind: "delete", label: "删除提醒", tone: "danger" },
      { kind: "select", label: "多选" },
    ]);
  });

  test("事件发生时提醒的（没有时间表）不能改时间，能取消、删除", () => {
    expect(labels({ status: "pending" })).toEqual(["取消提醒", "删除提醒", "多选"]);
  });

  test("已经结束的（一次性的已触发、已取消）：归档、删除提醒、多选；归档了的只剩删除、多选（任务没有取消归档，提醒也没有）", () => {
    const visa = { kind: "once", at: nowIso(oct(3, 10)) } as const;
    expect(labels({ status: "fired", schedule: visa })).toEqual(["归档", "删除提醒", "多选"]);
    expect(reminderMenu({ status: "fired", schedule: visa })[0]).toEqual({ kind: "archive", label: "归档" });
    expect(labels({ status: "cancelled", schedule: MONTHLY_8 })).toEqual(["归档", "删除提醒", "多选"]);
    expect(labels({ status: "fired", schedule: visa, archived: true })).toEqual(["删除提醒", "多选"]);
    expect(labels({ status: "cancelled", archived: true })).toEqual(["删除提醒", "多选"]);
  });

  test("删除先确认一次：还没响的写不会再提醒；结束了没归档的提一句可以归档；删了收不回", () => {
    expect(reminderDeleteConfirm("交房租", { status: "pending", schedule: MONTHLY_8 })).toEqual({
      title: "删除提醒「交房租」？",
      body: "删了以后不会再提醒，看板、日历、待办里都不再有它，聊天里那张提醒卡写\"已删除\"。删了收不回；只是不想它再提醒可以\"取消提醒\"。",
    });
    expect(reminderDeleteConfirm("打个电话", { status: "fired" })).toEqual({
      title: "删除提醒「打个电话」？",
      body: "删了以后看板、日历、待办里都不再有它，聊天里那张提醒卡写\"已删除\"。删了收不回；只是不想在\"最近结束\"里看到它可以\"归档\"。",
    });
    expect(reminderDeleteConfirm("打个电话", { status: "fired", archived: true }).body).toBe("删了以后看板、日历、待办里都不再有它，聊天里那张提醒卡写\"已删除\"。删了收不回。");
  });
});

describe("看板多选里的提醒：能一起取消；和任务混选只给两者都能做的", () => {
  const run: BoardBatchEntry = { kind: "task", id: "t-run", title: "跑着的", subject: { state: "running" } };
  const done: BoardBatchEntry = { kind: "task", id: "t-done", title: "做完的", subject: { state: "done", kind: "plain" } };
  const paused: BoardBatchEntry = { kind: "task", id: "t-paused", title: "停着的", subject: { state: "paused" } };
  const rent: BoardBatchEntry = { kind: "reminder", id: "r-rent", title: "交房租", reminder: { status: "pending", schedule: MONTHLY_8 } };
  const visa: BoardBatchEntry = { kind: "reminder", id: "r-visa", title: "续签证材料", reminder: { status: "fired", schedule: { kind: "once", at: nowIso(oct(3, 10)) } } };
  const bell: BoardBatchEntry = { kind: "reminder", id: "r-bell", title: "有新文件时提醒我", reminder: { status: "pending" } };
  const call: BoardBatchEntry = { kind: "reminder", id: "r-call", title: "打个电话", reminder: { status: "cancelled", schedule: { kind: "once", at: nowIso(oct(13, 20)) } } };
  const old: BoardBatchEntry = { kind: "reminder", id: "r-old", title: "交水费", reminder: { status: "fired", schedule: { kind: "once", at: nowIso(oct(1, 9)) }, archived: true } };

  test("只选了任务：和原来一样（每个按钮只算能做的），不用另外说明", () => {
    const tasks = [run, done, paused];
    expect(boardBatchCounts(tasks)).toEqual(batchCounts(tasks));
    // 186 号票：任务能删（没结束的先停下），没结束的归档先取消
    expect(boardBatchCounts(tasks)).toEqual({ pause: 1, resume: 1, cancel: 2, archive: 3, delete: 3 });
    expect(boardBatchTargets(tasks, "delete")).toEqual({ ids: ["t-run", "t-done", "t-paused"], skipped: 0 });
    expect(boardBatchTargets(tasks, "archive")).toEqual({ ids: ["t-run", "t-done", "t-paused"], skipped: 0 });
    expect(boardBatchWhy(tasks)).toBeUndefined();
    expect(boardBatchWhy([])).toBeUndefined();
  });

  test("只选了提醒：取消（待触发的）、归档（已经结束、没归档的）、删除（都能删）；暂停、继续灰掉，写明提醒能一起做的", () => {
    const reminders = [rent, visa, bell, call, old];
    expect(boardBatchCounts(reminders)).toEqual({ pause: 0, resume: 0, cancel: 2, archive: 2, delete: 5 });
    expect(boardBatchTargets(reminders, "cancel")).toEqual({ ids: ["r-rent", "r-bell"], skipped: 3 });
    expect(boardBatchTargets(reminders, "archive")).toEqual({ ids: ["r-visa", "r-call"], skipped: 3 });
    expect(boardBatchTargets(reminders, "delete")).toEqual({ ids: ["r-rent", "r-visa", "r-bell", "r-call", "r-old"], skipped: 0 });
    expect(boardBatchTargets(reminders, "pause")).toEqual({ ids: [], skipped: 5 });
    expect(boardBatchWhy(reminders)).toBe("简单提醒能一起取消、归档、删除；改时间在卡片的菜单里一张张改");
  });

  test("任务和提醒混选：只给两者都能做的——取消、归档、删除（任务、提醒各自能做的都算）；暂停、继续灰掉，写明为什么", () => {
    const mixed = [run, done, paused, rent, visa];
    expect(boardBatchCounts(mixed)).toEqual({ pause: 0, resume: 0, cancel: 3, archive: 4, delete: 5 });
    expect(boardBatchTargets(mixed, "cancel")).toEqual({ ids: ["t-run", "t-paused", "r-rent"], skipped: 2 });
    // 没结束的任务归档先取消（186 号票）；待触发的提醒照旧不能归档
    expect(boardBatchTargets(mixed, "archive")).toEqual({ ids: ["t-run", "t-done", "t-paused", "r-visa"], skipped: 1 });
    expect(boardBatchTargets(mixed, "pause")).toEqual({ ids: [], skipped: 5 });
    // 删除对任务和提醒都生效（186 号票）
    expect(boardBatchTargets(mixed, "delete")).toEqual({ ids: ["t-run", "t-done", "t-paused", "r-rent", "r-visa"], skipped: 0 });
    expect(boardBatchWhy(mixed)).toBe("选了任务和简单提醒：能一起取消、归档、删除；暂停、继续要只选任务");
  });

  test("取消先确认一次：只有任务照原来的说法；只有提醒、混选写清几个任务、几条提醒，几个跳过", () => {
    expect(boardBatchCancelConfirm({ tasks: 2, reminders: 0, skipped: 1 })).toEqual(batchCancelConfirm(2, 1));
    expect(boardBatchCancelConfirm({ tasks: 0, reminders: 2, skipped: 1 })).toEqual({
      title: "取消 2 条提醒？",
      body: '2 条提醒会取消，1 条跳过（已经响过或取消过了）。取消了的不再提醒，提醒卡变成已处理。只想换个时间可以在卡片的菜单里"改时间"。',
    });
    expect(boardBatchCancelConfirm({ tasks: 0, reminders: 1, skipped: 0 }).body.startsWith("1 条提醒会取消。")).toBe(true);
    expect(boardBatchCancelConfirm({ tasks: 2, reminders: 1, skipped: 2 })).toEqual({
      title: "取消 2 个任务、1 条提醒？",
      body: '2 个任务、1 条提醒会取消，2 个跳过（已经结束了，或者现在不能取消）。取消了的任务不再执行，会话和记录都留着，定时触发的连同触发一起取消；取消了的提醒不再提醒。想先停一停任务可以只选任务用"暂停"。',
    });
  });
});

describe("一起删除提醒（185 号票）：先确认一次；做完的提示", () => {
  test("确认写清几条、删了以后什么样、收不回", () => {
    expect(boardBatchDeleteConfirm({ reminders: 3 })).toEqual({
      title: "删除 3 条提醒？",
      body: '3 条提醒会删除：还没响的不再提醒，看板、日历、待办里都不再有它们，聊天里的提醒卡写"已删除"。删了收不回；只是不想在"最近结束"里看到可以"归档"。',
    });
  });

  test("做完：全成功一句短提示；有没成的逐条写原因", () => {
    expect(batchResult("delete", [{ taskId: "r-1", ok: true }, { taskId: "r-2", ok: true }], 0, (id) => id)).toEqual({ summary: "已删除 2 个", failures: [] });
    expect(batchResult("archive", [{ taskId: "r-1", ok: false, message: "提醒 r-1「打个电话」已经归档了" }], 1, () => "打个电话")).toEqual({
      summary: "已归档 0 个，跳过 1 个（现在不能归档），1 个没成",
      failures: ["「打个电话」：提醒 r-1「打个电话」已经归档了"],
    });
  });
});

describe("提醒的改时间：时间已过、没改的不能存；保存后提示改成了什么", () => {
  test("不能存的：和现在的一样；一次性的时间已经过了。能存的是 undefined", () => {
    const now = oct(12, 10).getTime();
    expect(reminderRescheduleBlocked(DAILY_9, DAILY_9, now)).toBe("还是现在的时间");
    expect(reminderRescheduleBlocked({ kind: "daily", time: "08:00" }, DAILY_9, now)).toBeUndefined();
    expect(reminderRescheduleBlocked({ kind: "once", at: nowIso(oct(12, 8)) }, DAILY_9, now)).toBe("这个时间已经过了：定一个将来的时间");
    expect(reminderRescheduleBlocked({ kind: "once", at: nowIso(oct(13, 8)) }, DAILY_9, now)).toBeUndefined();
  });

  test("保存后的提示：重复的写新的时间表，一次性的写哪天几点提醒一次", () => {
    expect(reminderRescheduledToast({ kind: "daily", time: "08:00" })).toBe("已改成每天 08:00");
    expect(reminderRescheduledToast({ kind: "once", at: nowIso(oct(13, 8)) })).toBe("已改成 10 月 13 日（周二）08:00 提醒一次");
  });
});
