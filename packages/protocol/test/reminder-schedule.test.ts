// 简单提醒的时间规则（共享协议包，守护进程和 Web 共用）：下一次响的时间（含每年某月某日）、只改钟点、按重复规则拼时间表、中文写法；
// 以及待我处理事项算不算处理过。时间都是本地时间（构造期望值用本地的 new Date(年, 月, 日, 时, 分)）。
import { describe, expect, test } from "vitest";
import {
  activeLocaleFrom,
  DEFAULT_LANGUAGE,
  dependsOnWorkdayCalendar,
  describeRepeatRule,
  describeSchedule,
  describeTime,
  type InboxItem,
  isInboxItemProcessed,
  isMonthDay,
  isRepeating,
  latestOccurrence,
  monthDayBefore,
  nextClockTime,
  nextOccurrence,
  nowIso,
  occurrencesBetween,
  repeatRuleOf,
  REPEAT_KIND_LABEL,
  REPEAT_KINDS,
  repeatSchedule,
  repeatScheduleError,
  scheduleClockTime,
  type WorkdayCalendar,
  withClockTime,
  setActiveLocale,
  workdayCalendar,
} from "../src/index.ts";
import { TEST_LOCALES } from "./setup-locales.ts";

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

  test("在日历上展开一段时间（用）：[from, to) 之间的每一次，跳过周末和休息日，补班的周六照算；正好在 from 的也算", () => {
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

describe("每年某月某日（公历）", () => {
  const birthday = { kind: "yearly" as const, time: "09:00", month: 3, day: 2 };
  const leapDay = { kind: "yearly" as const, time: "09:00", month: 2, day: 29 };

  test("今年的还没到就是今年；到了或过了就是明年同一天（跨年）", () => {
    expect(nextOccurrence(birthday, NOW, CTX)).toEqual(new Date(2027, 2, 2, 9, 0));
    expect(nextOccurrence(birthday, at(3, 2, 8, 59), CTX)).toEqual(at(3, 2, 9));
    expect(nextOccurrence(birthday, at(3, 2, 9), CTX)).toEqual(new Date(2027, 2, 2, 9, 0));
    // 12 月 31 日晚上：1 月 1 日的在明年
    expect(nextOccurrence({ kind: "yearly", time: "00:00", month: 1, day: 1 }, at(12, 31, 23, 59), CTX)).toEqual(new Date(2027, 0, 1, 0, 0));
    expect(nextOccurrence({ kind: "yearly", time: "20:00", month: 12, day: 31 }, at(12, 31, 19), CTX)).toEqual(at(12, 31, 20));
  });

  test("2 月 29 日：闰年在 2 月 29 日响，平年在 2 月 28 日响", () => {
    expect(nextOccurrence(leapDay, NOW, CTX)).toEqual(new Date(2027, 1, 28, 9, 0));
    expect(nextOccurrence(leapDay, new Date(2027, 1, 28, 9, 0), CTX)).toEqual(new Date(2028, 1, 29, 9, 0));
    expect(nextOccurrence(leapDay, new Date(2028, 1, 28, 9, 0), CTX)).toEqual(new Date(2028, 1, 29, 9, 0));
    expect(occurrencesBetween(leapDay, at(1, 1, 0), new Date(2030, 0, 1), CTX)).toEqual([
      at(2, 28, 9),
      new Date(2027, 1, 28, 9, 0),
      new Date(2028, 1, 29, 9, 0),
      new Date(2029, 1, 28, 9, 0),
    ]);
  });

  test("按本地时间：响的是本地的那天那个钟点（带的是本地时区的偏移）", () => {
    // 本地 3 月 2 日 00:30：在东八区是 UTC 的 3 月 1 日，照样是今天 09:00
    const next = nextOccurrence(birthday, at(3, 2, 0, 30), CTX)!;
    expect([next.getFullYear(), next.getMonth() + 1, next.getDate(), next.getHours(), next.getMinutes()]).toEqual([2026, 3, 2, 9, 0]);
    expect(nowIso(next)).toMatch(/^2026-03-02T09:00:00\.000[+-]\d{2}:\d{2}$/);
  });

  test("停机期间错过：从错过的第一次往后数，最后一个不晚于现在的、一共几次", () => {
    expect(latestOccurrence(birthday, at(3, 2, 9), new Date(2028, 5, 1), CTX)).toEqual({ due: new Date(2028, 2, 2, 9, 0), count: 3 });
  });

  test("是重复的一种：规则、钟点、只改钟点、不跟着工作日历变", () => {
    expect(REPEAT_KINDS).toContain("yearly");
    expect(REPEAT_KIND_LABEL.yearly).toBe("每年");
    expect(repeatSchedule({ kind: "yearly", month: 3, day: 2 }, "09:00")).toEqual({ schedule: birthday });
    expect(repeatRuleOf(birthday)).toEqual({ kind: "yearly", month: 3, day: 2 });
    expect(isRepeating(birthday)).toBe(true);
    expect(dependsOnWorkdayCalendar(birthday)).toBe(false);
    expect(scheduleClockTime(birthday)).toBe("09:00");
    expect(withClockTime(birthday, "08:30")).toEqual({ ...birthday, time: "08:30" });
  });

  test("拼时间表只收日历上有的日子：2 月 29 日可以，2 月 30 日、4 月 31 日、没给几月几日的不行", () => {
    expect(repeatSchedule({ kind: "yearly", month: 2, day: 29 }, "09:00")).toEqual({ schedule: leapDay });
    for (const rule of [{ month: 2, day: 30 }, { month: 4, day: 31 }, { month: 13, day: 1 }, { month: 0, day: 1 }, { month: 3 }, { day: 2 }, { month: 1.5, day: 2 }]) {
      expect(repeatSchedule({ kind: "yearly", ...rule }, "09:00")).toEqual({ error: expect.stringContaining("几月几日") });
    }
    expect(isMonthDay({ month: 12, day: 31 })).toBe(true);
    expect(isMonthDay({ month: 6, day: 31 })).toBe(false);
  });

  test("中文写法：每年 3 月 2 日 09:00；2 月 29 日写明平年在 2 月 28 日；英文也有写法", () => {
    expect(describeSchedule(birthday)).toBe("每年 3 月 2 日 09:00");
    expect(describeSchedule(leapDay)).toBe("每年 2 月 29 日 09:00（平年在 2 月 28 日）");
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    try {
      expect(describeSchedule(birthday)).toBe("Every year on Mar 2 at 09:00");
      expect(describeSchedule(leapDay)).toBe("Every year on Feb 29 at 09:00 (Feb 28 in common years)");
      expect(REPEAT_KIND_LABEL.yearly).toBe("Yearly");
    } finally {
      setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE));
    }
  });

  test("提前几天（生日提醒用）：按平年往前数，跨月、跨年；提前 0 天是原来那天", () => {
    expect(monthDayBefore({ month: 3, day: 2 }, 3)).toEqual({ month: 2, day: 27 });
    expect(monthDayBefore({ month: 1, day: 1 }, 3)).toEqual({ month: 12, day: 29 });
    expect(monthDayBefore({ month: 10, day: 25 }, 7)).toEqual({ month: 10, day: 18 });
    expect(monthDayBefore({ month: 2, day: 29 }, 3)).toEqual({ month: 2, day: 26 });
    expect(monthDayBefore({ month: 2, day: 29 }, 0)).toEqual({ month: 2, day: 29 });
    expect(monthDayBefore({ month: 3, day: 1 }, 1)).toEqual({ month: 2, day: 28 });
  });
});

/** 每 2 天 20:00，从 11 月 3 日起 */
const EVERY_OTHER = { kind: "everyNDays" as const, time: "20:00", interval: 2, anchor: "2026-11-03" };
/** 一个时刻的本地年月日时分 */
const local = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
/** 建好以后模拟连跑 n 次：每次到点响过，再按响的那一刻算下一次（守护进程就是这么排的） */
const runs = (schedule: typeof EVERY_OTHER, createdAt: Date, n = 10): string[] => {
  const out: string[] = [];
  let due = nextOccurrence(schedule, createdAt, CTX);
  while (due && out.length < n) {
    out.push(local(due));
    due = nextOccurrence(schedule, due, CTX);
  }
  return out;
};
/** 在某个时区里跑（Node 改 TZ 立即生效）；跑完换回原来的时区 */
const inTimeZone = (zone: string, run: () => void) => {
  const before = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = zone;
  try {
    run();
  } finally {
    process.env.TZ = before;
  }
};

describe("每 N 天：从起算日起每隔 N 个本地日历日", () => {
  const everyOther = EVERY_OTHER;

  test("起算日那天的钟点还没到就是那天；过了就是 N 天后；起算日之前不响", () => {
    expect(nextOccurrence(everyOther, at(11, 3, 19), CTX)).toEqual(at(11, 3, 20));
    expect(nextOccurrence(everyOther, at(11, 3, 20), CTX)).toEqual(at(11, 5, 20));
    expect(nextOccurrence(everyOther, at(11, 4, 23, 59), CTX)).toEqual(at(11, 5, 20));
    expect(nextOccurrence(everyOther, at(10, 20, 8), CTX)).toEqual(at(11, 3, 20));
    // 起算日很久以前：还是从起算日数（隔了 365 天，今年的 11 月 3 日不在这一串里，4 日在），不按建的那天
    expect(nextOccurrence({ ...everyOther, anchor: "2025-11-03" }, at(11, 3, 9), CTX)).toEqual(at(11, 4, 20));
  });

  test("连跑 10 次落点日期都对：跨月（10 月 31 日 → 11 月 2 日）", () => {
    expect(runs({ ...everyOther, anchor: "2026-10-25" }, at(10, 25, 8))).toEqual([
      "2026-10-25 20:00",
      "2026-10-27 20:00",
      "2026-10-29 20:00",
      "2026-10-31 20:00",
      "2026-11-2 20:00",
      "2026-11-4 20:00",
      "2026-11-6 20:00",
      "2026-11-8 20:00",
      "2026-11-10 20:00",
      "2026-11-12 20:00",
    ]);
  });

  test("连跑 10 次落点日期都对：闰年的 2 月 29 日照算一天、平年的 2 月没有这天；跨年", () => {
    expect(runs({ ...everyOther, anchor: "2028-02-21" }, new Date(2028, 1, 21, 8))).toEqual([
      "2028-2-21 20:00",
      "2028-2-23 20:00",
      "2028-2-25 20:00",
      "2028-2-27 20:00",
      "2028-2-29 20:00",
      "2028-3-2 20:00",
      "2028-3-4 20:00",
      "2028-3-6 20:00",
      "2028-3-8 20:00",
      "2028-3-10 20:00",
    ]);
    expect(runs({ ...everyOther, anchor: "2027-02-21" }, new Date(2027, 1, 21, 8), 5)).toEqual(["2027-2-21 20:00", "2027-2-23 20:00", "2027-2-25 20:00", "2027-2-27 20:00", "2027-3-1 20:00"]);
    expect(runs({ ...everyOther, interval: 3, anchor: "2026-12-26" }, at(12, 26, 8), 4)).toEqual(["2026-12-26 20:00", "2026-12-29 20:00", "2027-1-1 20:00", "2027-1-4 20:00"]);
  });

  test("夏令时切换日照样在本地那个钟点、那一天（纽约 3 月 8 日拨快、11 月 1 日拨慢；伦敦 3 月 29 日、10 月 25 日）", () => {
    inTimeZone("America/New_York", () => {
      // 确实换到了有夏令时的时区：切换前后两天和 UTC 差的不一样
      expect(new Date(2026, 2, 7, 12).getTimezoneOffset()).not.toBe(new Date(2026, 2, 9, 12).getTimezoneOffset());
      const spring = { ...everyOther, time: "08:30", anchor: "2026-03-02" };
      expect(runs(spring, new Date(2026, 2, 1, 12))).toEqual([
        "2026-3-2 8:30",
        "2026-3-4 8:30",
        "2026-3-6 8:30",
        "2026-3-8 8:30",
        "2026-3-10 8:30",
        "2026-3-12 8:30",
        "2026-3-14 8:30",
        "2026-3-16 8:30",
        "2026-3-18 8:30",
        "2026-3-20 8:30",
      ]);
      // 按毫秒加 2×24 小时会在切换后差一个钟头；按日历日数不会
      const fall = { ...everyOther, anchor: "2026-10-26" };
      expect(runs(fall, new Date(2026, 9, 26, 12), 5)).toEqual(["2026-10-26 20:00", "2026-10-28 20:00", "2026-10-30 20:00", "2026-11-1 20:00", "2026-11-3 20:00"]);
      // 切换那天凌晨刚过：下一次还是当天晚上
      expect(local(nextOccurrence(fall, new Date(2026, 10, 1, 3), CTX)!)).toBe("2026-11-1 20:00");
    });
    inTimeZone("Europe/London", () => {
      expect(runs({ ...everyOther, interval: 7, time: "09:00", anchor: "2026-03-22" }, new Date(2026, 2, 22, 8), 3)).toEqual(["2026-3-22 9:00", "2026-3-29 9:00", "2026-4-5 9:00"]);
      expect(runs({ ...everyOther, interval: 5, time: "09:00", anchor: "2026-10-20" }, new Date(2026, 9, 20, 8), 3)).toEqual(["2026-10-20 9:00", "2026-10-25 9:00", "2026-10-30 9:00"]);
    });
    // 换回来了
    expect(nextOccurrence(everyOther, at(11, 3, 19), CTX)).toEqual(at(11, 3, 20));
  });

  test("改起算日就整体平移：往后挪一天，每一次都晚一天；挪 N 天的整数倍还是同一串", () => {
    const shifted = { ...everyOther, anchor: "2026-11-04" };
    expect(runs(everyOther, at(11, 3, 8), 3)).toEqual(["2026-11-3 20:00", "2026-11-5 20:00", "2026-11-7 20:00"]);
    expect(runs(shifted, at(11, 3, 8), 3)).toEqual(["2026-11-4 20:00", "2026-11-6 20:00", "2026-11-8 20:00"]);
    expect(nextOccurrence({ ...everyOther, anchor: "2026-11-01" }, at(11, 3, 21), CTX)).toEqual(nextOccurrence(everyOther, at(11, 3, 21), CTX));
  });

  test("日历上展开、停机期间错过：和别的规则一样按下一次一个个数", () => {
    const every3 = { ...everyOther, interval: 3 };
    expect(occurrencesBetween(every3, at(11, 1, 0), at(11, 13, 0), CTX)).toEqual([at(11, 3, 20), at(11, 6, 20), at(11, 9, 20), at(11, 12, 20)]);
    expect(latestOccurrence(every3, at(11, 3, 20), at(11, 20, 9), CTX)).toEqual({ due: at(11, 18, 20), count: 6 });
  });

  test("拼时间表：给每几天和起算日；没给起算日是今天（今天这个钟点过了，第一次就是 N 天后）", () => {
    expect(repeatSchedule({ kind: "everyNDays", interval: 2, anchor: "2026-11-03" }, "20:00")).toEqual({ schedule: everyOther });
    const lateEvening = at(11, 3, 21);
    const made = repeatSchedule({ kind: "everyNDays", interval: 2 }, "08:00", lateEvening);
    expect(made).toEqual({ schedule: { kind: "everyNDays", time: "08:00", interval: 2, anchor: "2026-11-03" } });
    expect(nextOccurrence((made as { schedule: typeof everyOther }).schedule, lateEvening, CTX)).toEqual(at(11, 5, 8));
  });

  test("每几天要是 2–365 的整数，起算日要是日历上有的日子：不对就说明缺什么", () => {
    for (const interval of [undefined, 1, 366, 2.5]) {
      expect(repeatSchedule({ kind: "everyNDays", ...(interval === undefined ? {} : { interval }), anchor: "2026-11-03" }, "20:00")).toEqual({ error: expect.stringContaining("每几天") });
    }
    expect(repeatSchedule({ kind: "everyNDays", interval: 365, anchor: "2026-11-03" }, "20:00")).toHaveProperty("schedule");
    expect(repeatSchedule({ kind: "everyNDays", interval: 2, anchor: "2026-02-30" }, "20:00")).toEqual({ error: expect.stringContaining("2026-02-30") });
    expect(repeatScheduleError({ ...everyOther, anchor: "2026-02-30" })).toContain("起算日");
    expect(repeatScheduleError(everyOther)).toBeUndefined();
    expect(repeatScheduleError({ kind: "yearly", time: "09:00", month: 2, day: 30 })).toContain("几月几日");
    expect(repeatScheduleError({ kind: "once", at: nowIso(NOW) })).toBeUndefined();
  });

  test("是重复的一种：规则、钟点、只改钟点（起算日不变）、不跟着工作日历变", () => {
    expect(REPEAT_KINDS).toContain("everyNDays");
    expect(REPEAT_KIND_LABEL.everyNDays).toBe("每 N 天");
    expect(repeatRuleOf(everyOther)).toEqual({ kind: "everyNDays", interval: 2, anchor: "2026-11-03" });
    expect(isRepeating(everyOther)).toBe(true);
    expect(dependsOnWorkdayCalendar(everyOther)).toBe(false);
    expect(scheduleClockTime(everyOther)).toBe("20:00");
    expect(withClockTime(everyOther, "21:30")).toEqual({ ...everyOther, time: "21:30" });
  });

  test("中文写法：每 2 天 20:00，从 11 月 3 日起；起算日不在今年时带年份；英文也有写法", () => {
    expect(describeSchedule(everyOther)).toBe("每 2 天 20:00，从 11 月 3 日起");
    expect(describeSchedule(everyOther, NOW)).toBe("每 2 天 20:00，从 11 月 3 日起");
    expect(describeSchedule({ ...everyOther, anchor: "2025-12-30" }, NOW)).toBe("每 2 天 20:00，从 2025 年 12 月 30 日起");
    // 看秘书调了什么工具：没给起算日的不写从哪天起（起算日是调用那天）
    expect(describeRepeatRule({ kind: "everyNDays", interval: 3 }, "08:00")).toBe("每 3 天 08:00");
    expect(describeRepeatRule({ kind: "everyNDays", interval: 2, anchor: "2026-11-03" }, "20:00")).toBe("每 2 天 20:00，从 11 月 3 日起");
    expect(describeRepeatRule({ kind: "everyNDays", interval: 1 }, "08:00")).toBeUndefined();
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    try {
      expect(describeSchedule(everyOther)).toBe("Every 2 days at 20:00, starting Nov 3");
      expect(describeSchedule({ ...everyOther, anchor: "2025-12-30" }, NOW)).toBe("Every 2 days at 20:00, starting Dec 30, 2025");
      expect(REPEAT_KIND_LABEL.everyNDays).toBe("Every N days");
    } finally {
      setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE));
    }
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
