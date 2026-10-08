// 简单提醒的时间规则（共享协议包，守护进程和 Web 共用）：下一次响的时间、只改钟点、按重复规则拼时间表、中文写法；
// 以及待我处理事项算不算处理过。时间都是本地时间（构造期望值用本地的 new Date(年, 月, 日, 时, 分)）。
import { describe, expect, test } from "vitest";
import {
  dependsOnWorkdayCalendar,
  describeSchedule,
  describeTime,
  type InboxItem,
  isInboxItemProcessed,
  isRepeating,
  nextClockTime,
  nextOccurrence,
  nowIso,
  occurrencesBetween,
  repeatRuleOf,
  REPEAT_KIND_LABEL,
  REPEAT_KINDS,
  repeatSchedule,
  scheduleClockTime,
  type WorkdayCalendar,
  withClockTime,
  workdayCalendar,
} from "../src/index.ts";

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const NOW = at(10, 7, 21, 5);
/** 不看工作日历的规则也要给一个（这里是空的：只按周一到周五） */
const CTX = { calendar: workdayCalendar([], { rules: [], marks: [] }) };

describe("下一次响的时间", () => {
  test("一次性：没到点就是那一刻，过了就没有下一次", () => {
    const schedule = { kind: "once" as const, at: nowIso(at(10, 8, 9)) };
    expect(nextOccurrence(schedule, NOW, CTX)).toEqual(at(10, 8, 9));
    expect(nextOccurrence(schedule, at(10, 8, 9), CTX)).toBeUndefined();
  });

  test("某个钟点下一次出现：今天还没到就是今天，到了或过了就是明天", () => {
    expect(nextClockTime("22:00", NOW)).toEqual(at(10, 7, 22));
    expect(nextClockTime("21:05", NOW)).toEqual(at(10, 8, 21, 5));
  });

  test("每天：今天的钟点还没到就是今天，到了或过了就是明天", () => {
    expect(nextOccurrence({ kind: "daily", time: "22:00" }, NOW, CTX)).toEqual(at(10, 7, 22));
    expect(nextOccurrence({ kind: "daily", time: "21:05" }, NOW, CTX)).toEqual(at(10, 8, 21, 5));
    expect(nextOccurrence({ kind: "daily", time: "09:00" }, NOW, CTX)).toEqual(at(10, 8, 9));
  });

  test("每周几：取最近的那个周几，跨过周末绕回下周", () => {
    expect(nextOccurrence({ kind: "weekly", time: "09:00", weekdays: [1, 5] }, NOW, CTX)).toEqual(at(10, 9, 9));
    expect(nextOccurrence({ kind: "weekly", time: "09:00", weekdays: [3] }, NOW, CTX)).toEqual(at(10, 14, 9));
    expect(nextOccurrence({ kind: "weekly", time: "08:30", weekdays: [0] }, NOW, CTX)).toEqual(at(10, 11, 8, 30));
  });

  test("每月几号：取最近的那天；这个月没有这一天（比如 11 月 31 号）就在月底那天响", () => {
    expect(nextOccurrence({ kind: "monthly", time: "09:00", days: [8] }, NOW, CTX)).toEqual(at(10, 8, 9));
    expect(nextOccurrence({ kind: "monthly", time: "09:00", days: [1, 7] }, NOW, CTX)).toEqual(at(11, 1, 9));
    expect(nextOccurrence({ kind: "monthly", time: "09:00", days: [31] }, at(10, 31, 10), CTX)).toEqual(at(11, 30, 9));
    expect(nextOccurrence({ kind: "monthly", time: "09:00", days: [30] }, at(2, 1, 0), CTX)).toEqual(at(2, 28, 9));
    expect(nextOccurrence({ kind: "monthly", time: "09:00", days: [5] }, at(12, 6, 0), CTX)).toEqual(new Date(2027, 0, 5, 9, 0));
  });
});

describe("按我的工作日：只在工作日历上的上班日响，日历由调用方传进来", () => {
  // 10 月 10 日（周六）调休补班、10 月 12 日（周一）手动标了休息；其余按周一到周五
  const calendar: WorkdayCalendar = workdayCalendar(
    [{ format: 1, region: "cn", year: 2026, sources: [{ title: "测试用", url: "https://example.invalid/" }], days: [{ date: "2026-10-10", name: "国庆节调休上班", kind: "makeup_workday" }] }],
    { rules: [], marks: [{ date: "2026-10-12", mark: "rest" }] },
  );
  const schedule = { kind: "workdays" as const, time: "09:00" };

  test("下一个上班日的钟点：跳过周末和休息日，补班的周六照响", () => {
    expect(nextOccurrence(schedule, NOW, { calendar })).toEqual(at(10, 8, 9));
    expect(nextOccurrence(schedule, at(10, 9, 9), { calendar })).toEqual(at(10, 10, 9));
    // 10 月 11 日周日、12 日手动休息
    expect(nextOccurrence(schedule, at(10, 10, 9), { calendar })).toEqual(at(10, 13, 9));
  });

  test("在日历上展开一段时间（35 号票用）：[from, to) 之间的每一次，跳过周末和休息日，补班的周六照算；正好在 from 的也算", () => {
    expect(occurrencesBetween(schedule, at(10, 8, 9), at(10, 14, 0), { calendar })).toEqual([at(10, 8, 9), at(10, 9, 9), at(10, 10, 9), at(10, 13, 9)]);
    expect(occurrencesBetween({ kind: "daily", time: "09:00" }, at(10, 8, 0), at(10, 10, 9), { calendar })).toEqual([at(10, 8, 9), at(10, 9, 9)]);
    expect(occurrencesBetween({ kind: "daily", time: "09:00" }, at(10, 8, 0), at(10, 30, 0), { calendar }, 3)).toHaveLength(3);
    expect(occurrencesBetween({ kind: "once", at: nowIso(at(10, 9, 9)) }, at(10, 10, 0), at(10, 12, 0), { calendar })).toEqual([]);
  });

  test("每次按当时的工作日历算：工作日历变了，下一次跟着变", () => {
    const marked = workdayCalendar([], { rules: [], marks: [{ date: "2026-10-08", mark: "rest" }] });
    expect(nextOccurrence(schedule, NOW, { calendar: marked })).toEqual(at(10, 9, 9));
  });

  test("只有按我的工作日跟着工作日历变（日历改了要重算下一次的就是这些）", () => {
    expect(dependsOnWorkdayCalendar(schedule)).toBe(true);
    for (const other of [{ kind: "daily" as const, time: "09:00" }, { kind: "weekly" as const, time: "09:00", weekdays: [1] }, { kind: "once" as const, at: nowIso(NOW) }]) {
      expect(dependsOnWorkdayCalendar(other)).toBe(false);
    }
  });

  test("是重复的一种：规则、钟点、只改钟点、中文写法", () => {
    expect(REPEAT_KINDS).toContain("workdays");
    expect(REPEAT_KIND_LABEL.workdays).toBe("按我的工作日");
    expect(repeatSchedule({ kind: "workdays" }, "09:00")).toEqual({ schedule });
    expect(repeatRuleOf(schedule)).toEqual({ kind: "workdays" });
    expect(isRepeating(schedule)).toBe(true);
    expect(scheduleClockTime(schedule)).toBe("09:00");
    expect(withClockTime(schedule, "08:30")).toEqual({ kind: "workdays", time: "08:30" });
    expect(describeSchedule(schedule)).toBe("按我的工作日 09:00");
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
