// 秘书在工具里给的时间 → 时间表（纯函数）：具体的本地日期时间、哪天几点、最近的周几、几天后、几分钟后、重复规则；
// 以及改提醒时只给了一部分（只改钟点、"改到周五"）。时间都是本地时间（构造期望值用本地的 new Date(年, 月, 日, 时, 分)）。
// 规则本身（下一次响的时间、中文写法）在共享协议包里测（packages/protocol/test/reminder-schedule.test.ts）。
import { nowIso } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import { editedSchedule, ReminderInputError, type ReminderTimeSpec, resolveReminderTime } from "../../src/reminders/schedule.ts";

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const once = (date: Date) => ({ kind: "once", at: nowIso(date) });
const NOW = at(10, 7, 21, 5);

describe("秘书给的时间落成时间表", () => {
  test("具体的本地日期时间（at）：照写；也认中间带 T 的写法", () => {
    expect(resolveReminderTime({ at: "2026-10-08 09:00" }, NOW)).toEqual(once(at(10, 8, 9)));
    expect(resolveReminderTime({ at: "2026-10-20T15:30" }, NOW)).toEqual(once(at(10, 20, 15, 30)));
  });

  test("凌晨说\"明早 9 点\"：按当前日期写成具体日期时间，落在今天早上，不会跑到后天", () => {
    const earlyMorning = at(10, 8, 0, 30);
    expect(resolveReminderTime({ at: "2026-10-08 09:00" }, earlyMorning)).toEqual(once(at(10, 8, 9)));
    // 相对写法"1 天后"在凌晨会落到 10-09（对用户来说是后天），所以工具说明里要秘书知道日期时优先用 at
    expect(resolveReminderTime({ inDays: 1, time: "09:00" }, earlyMorning)).toEqual(once(at(10, 9, 9)));
  });

  test("最近的那个周几：今天就是这天、钟点还没到就是今天；过了就是下周", () => {
    // 周三 21:05：周五 → 10-09；周三 22:00 → 今天；周三 09:00 → 下周三
    expect(resolveReminderTime({ weekday: 5, time: "09:00" }, NOW)).toEqual(once(at(10, 9, 9)));
    expect(resolveReminderTime({ weekday: 3, time: "22:00" }, NOW)).toEqual(once(at(10, 7, 22)));
    expect(resolveReminderTime({ weekday: 3, time: "09:00" }, NOW)).toEqual(once(at(10, 14, 9)));
    expect(resolveReminderTime({ weekday: 0, time: "10:00" }, NOW)).toEqual(once(at(10, 11, 10)));
  });

  test("几天后的几点（明早 9 点 = 1 天后 09:00）", () => {
    expect(resolveReminderTime({ inDays: 1, time: "09:00" }, NOW)).toEqual(once(at(10, 8, 9)));
    expect(resolveReminderTime({ inDays: 0, time: "23:30" }, NOW)).toEqual(once(at(10, 7, 23, 30)));
  });

  test("只给钟点：今天还没到就是今天，过了就是明天；9:00 这种写法也认", () => {
    expect(resolveReminderTime({ time: "22:00" }, NOW)).toEqual(once(at(10, 7, 22)));
    expect(resolveReminderTime({ time: "9:00" }, NOW)).toEqual(once(at(10, 8, 9)));
  });

  test("哪天：年-月-日照写；只写月-日取最近的将来那天", () => {
    expect(resolveReminderTime({ date: "2026-10-20", time: "15:00" }, NOW)).toEqual(once(at(10, 20, 15)));
    expect(resolveReminderTime({ date: "10-20", time: "15:00" }, NOW)).toEqual(once(at(10, 20, 15)));
    expect(resolveReminderTime({ date: "03-01", time: "08:00" }, NOW)).toEqual(once(new Date(2027, 2, 1, 8, 0)));
  });

  test("几分钟后（半小时后 = 30 分钟后），精确到分钟", () => {
    expect(resolveReminderTime({ inMinutes: 30 }, NOW)).toEqual(once(at(10, 7, 21, 35)));
  });

  test("重复：每天、每周几、每月几号，都在某个钟点；周几和几号去重、排好序", () => {
    expect(resolveReminderTime({ time: "07:30", repeat: { kind: "daily" } }, NOW)).toEqual({ kind: "daily", time: "07:30" });
    expect(resolveReminderTime({ time: "19:00", repeat: { kind: "weekly", weekdays: [5, 1, 3, 1] } }, NOW)).toEqual({ kind: "weekly", time: "19:00", weekdays: [1, 3, 5] });
    expect(resolveReminderTime({ time: "09:00", repeat: { kind: "monthly", days: [15, 1] } }, NOW)).toEqual({ kind: "monthly", time: "09:00", days: [1, 15] });
  });

  test.each<[string, ReminderTimeSpec, RegExp]>([
    ["已经过去的时刻", { at: "2026-10-01 09:00" }, /已经过去/],
    ["日期不存在", { date: "2026-02-30", time: "09:00" }, /日期/],
    ["at 写法不对", { at: "下周一 9 点" }, /at 的写法/],
    ["日期写法不对", { date: "下周一", time: "09:00" }, /日期/],
    ["一次性的没给钟点", { inDays: 1 }, /几点/],
    ["周几超出范围", { weekday: 7, time: "09:00" }, /weekday/],
    ["日期和几天后同时给", { date: "10-20", inDays: 1, time: "09:00" }, /只能给一种/],
    ["at 又给了钟点", { at: "2026-10-08 09:00", time: "10:00" }, /at/],
    ["几分钟后又给了钟点", { inMinutes: 10, time: "09:00" }, /inMinutes/],
    ["重复提醒给了日期", { date: "10-20", time: "09:00", repeat: { kind: "daily" } }, /重复/],
    ["每周几没给周几", { time: "09:00", repeat: { kind: "weekly" } }, /周几/],
    ["每月几号没给几号", { time: "09:00", repeat: { kind: "monthly", days: [] } }, /几号/],
  ])("%s → 说明错在哪，好让秘书改了再试", (_name, spec, message) => {
    expect(() => resolveReminderTime(spec, NOW)).toThrow(ReminderInputError);
    expect(() => resolveReminderTime(spec, NOW)).toThrow(message);
  });
});

describe("改提醒时新的时间表", () => {
  const tomorrowNine = once(at(10, 8, 9)) as { kind: "once"; at: string };

  test("没给和时间有关的参数：不改", () => {
    expect(editedSchedule(tomorrowNine, {}, NOW)).toBeUndefined();
  });

  test("只给几点：一次性的还在原来那天，重复的还按原来的规则", () => {
    expect(editedSchedule(tomorrowNine, { time: "10:00" }, NOW)).toEqual(once(at(10, 8, 10)));
    expect(editedSchedule({ kind: "weekly", time: "19:00", weekdays: [1, 5] }, { time: "20:00" }, NOW)).toEqual({ kind: "weekly", time: "20:00", weekdays: [1, 5] });
  });

  test("\"改到周五\"：换到最近的周五，钟点不变；也可以连钟点一起改", () => {
    expect(editedSchedule(tomorrowNine, { weekday: 5 }, NOW)).toEqual(once(at(10, 9, 9)));
    expect(editedSchedule(tomorrowNine, { weekday: 5, time: "14:00" }, NOW)).toEqual(once(at(10, 9, 14)));
  });

  test("改到具体的日期时间、改成重复的（钟点沿用原来的）", () => {
    expect(editedSchedule(tomorrowNine, { at: "2026-10-12 08:00" }, NOW)).toEqual(once(at(10, 12, 8)));
    expect(editedSchedule(tomorrowNine, { repeat: { kind: "daily" } }, NOW)).toEqual({ kind: "daily", time: "09:00" });
  });
});
