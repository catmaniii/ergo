// 简单提醒的时间规则（共享协议包，守护进程和 Web 共用）：下一次响的时间、只改钟点、按重复规则拼时间表、中文写法；
// 以及待我处理事项算不算处理过。时间都是本地时间（构造期望值用本地的 new Date(年, 月, 日, 时, 分)）。
import { describe, expect, test } from "vitest";
import {
  describeSchedule,
  describeTime,
  type InboxItem,
  isInboxItemProcessed,
  isRepeating,
  nextOccurrence,
  nowIso,
  repeatRuleOf,
  repeatSchedule,
  scheduleClockTime,
  withClockTime,
} from "../src/index.ts";

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const NOW = at(10, 7, 21, 5);

describe("下一次响的时间", () => {
  test("一次性：没到点就是那一刻，过了就没有下一次", () => {
    const schedule = { kind: "once" as const, at: nowIso(at(10, 8, 9)) };
    expect(nextOccurrence(schedule, NOW)).toEqual(at(10, 8, 9));
    expect(nextOccurrence(schedule, at(10, 8, 9))).toBeUndefined();
  });

  test("每天：今天的钟点还没到就是今天，到了或过了就是明天", () => {
    expect(nextOccurrence({ kind: "daily", time: "22:00" }, NOW)).toEqual(at(10, 7, 22));
    expect(nextOccurrence({ kind: "daily", time: "21:05" }, NOW)).toEqual(at(10, 8, 21, 5));
    expect(nextOccurrence({ kind: "daily", time: "09:00" }, NOW)).toEqual(at(10, 8, 9));
  });

  test("每周几：取最近的那个周几，跨过周末绕回下周", () => {
    expect(nextOccurrence({ kind: "weekly", time: "09:00", weekdays: [1, 5] }, NOW)).toEqual(at(10, 9, 9));
    expect(nextOccurrence({ kind: "weekly", time: "09:00", weekdays: [3] }, NOW)).toEqual(at(10, 14, 9));
    expect(nextOccurrence({ kind: "weekly", time: "08:30", weekdays: [0] }, NOW)).toEqual(at(10, 11, 8, 30));
  });

  test("每月几号：取最近的那天；这个月没有这一天（比如 11 月 31 号）就在月底那天响", () => {
    expect(nextOccurrence({ kind: "monthly", time: "09:00", days: [8] }, NOW)).toEqual(at(10, 8, 9));
    expect(nextOccurrence({ kind: "monthly", time: "09:00", days: [1, 7] }, NOW)).toEqual(at(11, 1, 9));
    expect(nextOccurrence({ kind: "monthly", time: "09:00", days: [31] }, at(10, 31, 10))).toEqual(at(11, 30, 9));
    expect(nextOccurrence({ kind: "monthly", time: "09:00", days: [30] }, at(2, 1, 0))).toEqual(at(2, 28, 9));
    expect(nextOccurrence({ kind: "monthly", time: "09:00", days: [5] }, at(12, 6, 0))).toEqual(new Date(2027, 0, 5, 9, 0));
  });
});

describe("钟点和重复规则", () => {
  test("钟点：重复的就是规则里的，一次性的取那一刻的", () => {
    expect(scheduleClockTime({ kind: "once", at: nowIso(at(10, 8, 9, 30)) })).toBe("09:30");
    expect(scheduleClockTime({ kind: "weekly", time: "19:00", weekdays: [1] })).toBe("19:00");
  });

  test("只改钟点：重复的还按原来的规则，一次性的还在原来那天", () => {
    expect(withClockTime({ kind: "once", at: nowIso(at(10, 8, 9)) }, "10:00")).toEqual({ kind: "once", at: nowIso(at(10, 8, 10)) });
    expect(withClockTime({ kind: "monthly", time: "09:00", days: [8] }, "10:00")).toEqual({ kind: "monthly", time: "10:00", days: [8] });
  });

  test("按重复规则拼时间表：周几、几号去重排好；缺了就说明缺什么", () => {
    expect(repeatSchedule({ kind: "weekly", weekdays: [5, 1, 1] }, "19:00")).toEqual({ schedule: { kind: "weekly", time: "19:00", weekdays: [1, 5] } });
    expect(repeatSchedule({ kind: "monthly", days: [] }, "09:00")).toEqual({ error: expect.stringContaining("几号") });
    expect(repeatSchedule({ kind: "weekly" }, "09:00")).toEqual({ error: expect.stringContaining("周几") });
  });

  test("是不是重复的、重复规则是什么", () => {
    expect(isRepeating({ kind: "once", at: nowIso(NOW) })).toBe(false);
    expect(isRepeating({ kind: "daily", time: "08:00" })).toBe(true);
    expect(repeatRuleOf({ kind: "weekly", time: "08:00", weekdays: [1, 3] })).toEqual({ kind: "weekly", weekdays: [1, 3] });
  });
});

describe("中文写法", () => {
  test("时刻带星期；不在同一年时带上年份", () => {
    expect(describeTime(at(10, 8, 9))).toBe("10 月 8 日（周四）09:00");
    expect(describeTime(new Date(2027, 2, 1, 8, 0), NOW)).toBe("2027 年 3 月 1 日（周一）08:00");
  });

  test("每天、每周几、每月几号；有 29–31 号的写明没有这天的月份在月底", () => {
    expect(describeSchedule({ kind: "daily", time: "08:00" })).toBe("每天 08:00");
    expect(describeSchedule({ kind: "weekly", time: "19:00", weekdays: [1, 3, 5] })).toBe("每周一、三、五 19:00");
    expect(describeSchedule({ kind: "monthly", time: "09:00", days: [8] })).toBe("每月 8 号 09:00");
    expect(describeSchedule({ kind: "monthly", time: "09:00", days: [31] })).toBe("每月 31 号 09:00（没有这天的月份在月底）");
  });
});

describe("待我处理事项算不算处理过", () => {
  const base = { id: "i1", version: 1, title: "t", source: "系统", urgency: "blocking" as const, pinned: false, createdAt: "x", read: false, archived: false, deleted: false };
  const cardItem: InboxItem = { ...base, kind: "card", cardId: "c1" };
  const notice: InboxItem = { ...base, kind: "notice", notice: "stuck_help", actions: ["我来看看"] };

  test("卡片事项看卡片的状态；卡片还不知道（没收到、找不到）时算没处理过", () => {
    expect(isInboxItemProcessed(cardItem, "pending")).toBe(false);
    expect(isInboxItemProcessed(cardItem, "handled")).toBe(true);
    expect(isInboxItemProcessed(cardItem, "dismissed")).toBe(true);
    expect(isInboxItemProcessed(cardItem, undefined)).toBe(false);
  });

  test("通知类事项看有没有选过它的动作（相关的卡不算）", () => {
    expect(isInboxItemProcessed(notice, undefined)).toBe(false);
    expect(isInboxItemProcessed({ ...notice, handled: "我来看看" }, undefined)).toBe(true);
  });
});
