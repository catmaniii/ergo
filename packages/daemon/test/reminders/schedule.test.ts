// 简单提醒的时间规则（纯函数）：秘书说的"几点、哪天、几分钟后、每天 / 每周几 / 每月几号"落成什么规则，
// 以及规则下一次该在什么时候响。时间都是本地时间（构造期望值用本地的 new Date(年, 月, 日, 时, 分)）。
import { nowIso } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import { nextOccurrence, ReminderInputError, resolveReminderTime } from "../../src/reminders/schedule.ts";

/** 本地时间 2026 年 m 月 d 日 hh:mm */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
/** 2026-10-07 是周三 */
const NOW = at(10, 7, 21, 5);

describe("下一次响的时间", () => {
  test("一次性：没到点就是那一刻，过了就没有下一次", () => {
    const schedule = { kind: "once" as const, at: at(10, 8, 9).toISOString() };
    expect(nextOccurrence(schedule, NOW)).toEqual(at(10, 8, 9));
    expect(nextOccurrence(schedule, at(10, 8, 9))).toBeUndefined();
  });

  test("每天：今天的钟点还没到就是今天，到了或过了就是明天", () => {
    expect(nextOccurrence({ kind: "daily", time: "22:00" }, NOW)).toEqual(at(10, 7, 22));
    expect(nextOccurrence({ kind: "daily", time: "21:05" }, NOW)).toEqual(at(10, 8, 21, 5));
    expect(nextOccurrence({ kind: "daily", time: "09:00" }, NOW)).toEqual(at(10, 8, 9));
  });

  test("每周几：取最近的那个周几，跨过周末绕回下周", () => {
    // 周三 21:05 之后：每周一、五 09:00 → 周五 10-09
    expect(nextOccurrence({ kind: "weekly", time: "09:00", weekdays: [1, 5] }, NOW)).toEqual(at(10, 9, 9));
    // 只有周三：今天的已经过了 → 下周三
    expect(nextOccurrence({ kind: "weekly", time: "09:00", weekdays: [3] }, NOW)).toEqual(at(10, 14, 9));
    // 周日（0）
    expect(nextOccurrence({ kind: "weekly", time: "08:30", weekdays: [0] }, NOW)).toEqual(at(10, 11, 8, 30));
  });

  test("每月几号：取最近的那天；这个月没有这一天（比如 11 月 31 号）就在月底那天响", () => {
    expect(nextOccurrence({ kind: "monthly", time: "09:00", days: [8] }, NOW)).toEqual(at(10, 8, 9));
    expect(nextOccurrence({ kind: "monthly", time: "09:00", days: [1, 7] }, NOW)).toEqual(at(11, 1, 9));
    expect(nextOccurrence({ kind: "monthly", time: "09:00", days: [31] }, at(10, 31, 10))).toEqual(at(11, 30, 9));
    expect(nextOccurrence({ kind: "monthly", time: "09:00", days: [30] }, at(2, 1, 0))).toEqual(at(2, 28, 9));
    // 跨年
    expect(nextOccurrence({ kind: "monthly", time: "09:00", days: [5] }, at(12, 6, 0))).toEqual(new Date(2027, 0, 5, 9, 0));
  });
});

describe("秘书给的时间落成规则", () => {
  test("几天后的几点（明早 9 点 = 1 天后 09:00）", () => {
    expect(resolveReminderTime({ inDays: 1, time: "09:00" }, NOW)).toEqual({ kind: "once", at: nowIso(at(10, 8, 9)) });
    expect(resolveReminderTime({ inDays: 0, time: "23:30" }, NOW)).toEqual({ kind: "once", at: nowIso(at(10, 7, 23, 30)) });
  });

  test("只给钟点：今天还没到就是今天，过了就是明天", () => {
    expect(resolveReminderTime({ time: "22:00" }, NOW)).toEqual({ kind: "once", at: nowIso(at(10, 7, 22)) });
    expect(resolveReminderTime({ time: "09:00" }, NOW)).toEqual({ kind: "once", at: nowIso(at(10, 8, 9)) });
  });

  test("具体日期：年-月-日照写；只写月-日取最近的将来那天", () => {
    expect(resolveReminderTime({ date: "2026-10-20", time: "15:00" }, NOW)).toEqual({ kind: "once", at: nowIso(at(10, 20, 15)) });
    expect(resolveReminderTime({ date: "10-20", time: "15:00" }, NOW)).toEqual({ kind: "once", at: nowIso(at(10, 20, 15)) });
    expect(resolveReminderTime({ date: "03-01", time: "08:00" }, NOW)).toEqual({ kind: "once", at: nowIso(new Date(2027, 2, 1, 8, 0)) });
  });

  test("几分钟后（半小时后 = 30 分钟后），精确到分钟", () => {
    expect(resolveReminderTime({ inMinutes: 30 }, NOW)).toEqual({ kind: "once", at: nowIso(at(10, 7, 21, 35)) });
  });

  test("重复：每天、每周几、每月几号，都在某个钟点；周几和几号去重、排好序", () => {
    expect(resolveReminderTime({ time: "07:30", repeat: { kind: "daily" } }, NOW)).toEqual({ kind: "daily", time: "07:30" });
    expect(resolveReminderTime({ time: "19:00", repeat: { kind: "weekly", weekdays: [5, 1, 3, 1] } }, NOW)).toEqual({ kind: "weekly", time: "19:00", weekdays: [1, 3, 5] });
    expect(resolveReminderTime({ time: "09:00", repeat: { kind: "monthly", days: [15, 1] } }, NOW)).toEqual({ kind: "monthly", time: "09:00", days: [1, 15] });
  });

  test.each([
    ["已经过去的时刻", { date: "2026-10-01", time: "09:00" }, /已经过去/],
    ["日期不存在", { date: "2026-02-30", time: "09:00" }, /日期/],
    ["日期写法不对", { date: "下周一", time: "09:00" }, /日期/],
    ["一次性的没给钟点", { inDays: 1 }, /几点/],
    ["日期和几天后同时给", { date: "10-20", inDays: 1, time: "09:00" }, /只能给一种/],
    ["几分钟后又给了钟点", { inMinutes: 10, time: "09:00" }, /只能给一种/],
    ["重复提醒给了日期", { date: "10-20", time: "09:00", repeat: { kind: "daily" } }, /重复/],
    ["每周几没给周几", { time: "09:00", repeat: { kind: "weekly" } }, /周几/],
    ["每月几号没给几号", { time: "09:00", repeat: { kind: "monthly", days: [] } }, /几号/],
  ])("%s → 说明错在哪，好让秘书改了再试", (_name, spec, message) => {
    expect(() => resolveReminderTime(spec, NOW)).toThrow(ReminderInputError);
    expect(() => resolveReminderTime(spec, NOW)).toThrow(message);
  });
});
