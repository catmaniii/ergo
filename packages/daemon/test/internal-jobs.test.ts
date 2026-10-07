// 内部作业"错过了没有"的判断（纯函数，19 号票的定时作业也用它）：上一次之后的下一次过没过点。
// 守护进程里怎么补跑、补完不再补，在主切面测（test/main/backup.test.ts 的"错过的内部作业开机后补一次"）。
import { type ReminderSchedule, workdayCalendar } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import { nextDue } from "../src/scheduler/internal-jobs.ts";

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三，10-11 是周日） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const nightly: ReminderSchedule = { kind: "daily", time: "03:30" };
const sundays: ReminderSchedule = { kind: "weekly", time: "04:30", weekdays: [0] };

describe("错过了没有", () => {
  test.each([
    ["当晚还没到点", nightly, at(10, 7, 21), at(10, 8, 1), { at: at(10, 8, 3, 30), missed: false }],
    ["正好到点算错过（马上跑）", nightly, at(10, 7, 21), at(10, 8, 3, 30), { at: at(10, 8, 3, 30), missed: true }],
    ["停了好几晚：只看上一次之后的那一次，错过了（只补一次）", nightly, at(10, 7, 21), at(10, 12, 9), { at: at(10, 8, 3, 30), missed: true }],
    ["每周日：周三跑过，周六还没到", sundays, at(10, 7, 4, 30), at(10, 10, 23), { at: at(10, 11, 4, 30), missed: false }],
    ["每周日：周一才开机，错过了周日那次", sundays, at(10, 7, 4, 30), at(10, 12, 8), { at: at(10, 11, 4, 30), missed: true }],
  ])("%s", (_name, schedule, last, now, expected) => {
    expect(nextDue(schedule, last, now)).toEqual(expected);
  });

  test("按我的工作日：按给的工作日历算（周末和手动休息日跳过）", () => {
    const calendar = workdayCalendar([], { rules: [], marks: [{ date: "2026-10-12", mark: "rest" }] });
    const workdays: ReminderSchedule = { kind: "workdays", time: "08:00" };
    // 周五跑过，周一手动休息：下一次是周二；周日开机还没到
    expect(nextDue(workdays, at(10, 9, 8), at(10, 11, 9), calendar)).toEqual({ at: at(10, 13, 8), missed: false });
    expect(nextDue(workdays, at(10, 9, 8), at(10, 13, 9), calendar)).toEqual({ at: at(10, 13, 8), missed: true });
  });

  test("一次性的已经过了：没有下一次", () => {
    expect(nextDue({ kind: "once", at: at(10, 8, 9).toISOString() }, at(10, 8, 9), at(10, 9, 0))).toBeUndefined();
  });
});
