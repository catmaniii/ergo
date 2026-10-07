// 个人工作日历（规格第 21 节，29 号票）的纯函数：输入日期、节假日数据、额外规则和手动标记，输出上班或休息及原因。
// 我的工作日 = 新加坡工作日 ∪ 国内工作日（含调休补班）∪ 额外上班规则 ∪ 手动标记的上班日 − 手动标记的休息日。
// 节假日数据用的是调研文件 docs/research/13-holidays-sg-cn.md 里 2026 年的一部分（框架自带的完整数据在守护进程包里，另有测试逐日核对）。
import { describe, expect, test } from "vitest";
import {
  applyWorkdayChange,
  type DayVerdict,
  dayReasonLabel,
  describeExtraRule,
  describeWorkdayChange,
  type HolidayYear,
  workdayCalendar,
  type WorkdaySettings,
} from "../src/index.ts";

const SOURCE = [{ title: "测试用", url: "https://example.invalid/" }];

const SG_2026: HolidayYear = {
  format: 1,
  region: "sg",
  year: 2026,
  sources: SOURCE,
  days: [
    { date: "2026-01-01", name: "New Year's Day 元旦", kind: "holiday" },
    { date: "2026-02-17", name: "Chinese New Year 农历新年", kind: "holiday" },
    { date: "2026-02-18", name: "Chinese New Year 农历新年", kind: "holiday" },
    { date: "2026-05-01", name: "Labour Day 劳动节", kind: "holiday" },
    { date: "2026-05-31", name: "Vesak Day 卫塞节", kind: "holiday" },
    { date: "2026-06-01", name: "Vesak Day (Observed) 卫塞节补假", kind: "observed" },
    { date: "2026-11-08", name: "Deepavali 屠妖节", kind: "holiday" },
    { date: "2026-11-09", name: "Deepavali (Observed) 屠妖节补假", kind: "observed" },
    { date: "2026-12-25", name: "Christmas Day 圣诞节", kind: "holiday" },
  ],
};

const CN_2026: HolidayYear = {
  format: 1,
  region: "cn",
  year: 2026,
  sources: SOURCE,
  days: [
    { date: "2026-01-01", name: "元旦", kind: "holiday" },
    { date: "2026-01-02", name: "元旦", kind: "holiday" },
    { date: "2026-01-03", name: "元旦", kind: "holiday" },
    { date: "2026-01-04", name: "元旦调休上班", kind: "makeup_workday" },
    { date: "2026-02-17", name: "春节", kind: "holiday" },
    { date: "2026-02-18", name: "春节", kind: "holiday" },
    { date: "2026-05-01", name: "劳动节", kind: "holiday" },
    { date: "2026-09-20", name: "国庆节调休上班", kind: "makeup_workday" },
    { date: "2026-09-25", name: "中秋节", kind: "holiday" },
    { date: "2026-10-01", name: "国庆节", kind: "holiday" },
    { date: "2026-10-05", name: "国庆节", kind: "holiday" },
    { date: "2026-10-10", name: "国庆节调休上班", kind: "makeup_workday" },
  ],
};

const HOLIDAYS = [SG_2026, CN_2026];
const NONE: WorkdaySettings = { rules: [], marks: [] };
const LAST_SATURDAY = { kind: "last_weekday", weekday: 6 } as const;

/** 一天的结果：上班还是休息，原因（中文写法） */
const brief = (v: DayVerdict) => [v.workday ? "上班" : "休息", ...v.reasons.map(dayReasonLabel)];

describe("一天是上班还是休息，原因是什么", () => {
  const calendar = workdayCalendar(HOLIDAYS, NONE);
  test.each([
    ["普通的周一到周五：两边都上班", "2026-10-08", ["上班", "新加坡工作日", "国内工作日"]],
    ["普通周末", "2026-10-11", ["休息", "周末"]],
    ["新加坡公众假期（补假），国内上班：上班，原因是国内工作日", "2026-11-09", ["上班", "国内工作日"]],
    ["国内法定假日，新加坡上班：上班，原因是新加坡工作日", "2026-10-01", ["上班", "新加坡工作日"]],
    ["国内因调休放假的工作日，新加坡上班：同样算新加坡工作日", "2026-10-05", ["上班", "新加坡工作日"]],
    ["两边都放假：休息，写明两边的假期", "2026-05-01", ["休息", "新加坡假期：Labour Day 劳动节", "国内假期：劳动节"]],
    ["新加坡的补假（周日的假期顺延到周一），国内上班", "2026-06-01", ["上班", "国内工作日"]],
    ["国内调休补班的周六：上班，原因是调休补班", "2026-10-10", ["上班", "调休补班"]],
    ["国内调休补班的周日也算", "2026-09-20", ["上班", "调休补班"]],
    ["周日的新加坡假期：休息，写明假期和周末", "2026-11-08", ["休息", "新加坡假期：Deepavali 屠妖节", "周末"]],
  ])("%s", (_name, date, expected) => {
    expect(brief(calendar.day(date))).toEqual(expected);
  });

  test("一天的结果里列出当天两边的节假日（不论是否决定结果），新加坡的补假标成补假", () => {
    expect(calendar.day("2026-06-01").holidays).toEqual([{ region: "sg", name: "Vesak Day (Observed) 卫塞节补假", kind: "observed" }]);
    expect(calendar.day("2026-10-10").holidays).toEqual([{ region: "cn", name: "国庆节调休上班", kind: "makeup_workday" }]);
    expect(calendar.day("2026-10-08").holidays).toEqual([]);
  });

  test("额外规则\"每月最后一个周六\"命中的周六：上班，原因是额外规则；没命中的周六照样休息", () => {
    const withRule = workdayCalendar(HOLIDAYS, { rules: [LAST_SATURDAY], marks: [] });
    expect(brief(withRule.day("2026-10-31"))).toEqual(["上班", "额外规则：每月最后一个周六"]);
    expect(brief(withRule.day("2026-10-24"))).toEqual(["休息", "周末"]);
    // 2 月的最后一个周六是 28 号
    expect(withRule.day("2026-02-28").workday).toBe(true);
  });

  test("额外规则的三种写法：每周几、每月第 N 个周几、每月最后一个周几", () => {
    const rules = workdayCalendar(HOLIDAYS, { rules: [{ kind: "weekly", weekday: 0 }, { kind: "nth_weekday", n: 1, weekday: 6 }], marks: [] });
    expect(rules.day("2026-10-04").workday).toBe(true); // 周日
    expect(rules.day("2026-10-03").workday).toBe(true); // 10 月第一个周六
    expect(rules.day("2026-10-17").workday).toBe(false); // 第三个周六
    expect(describeExtraRule({ kind: "weekly", weekday: 0 })).toBe("每周日");
    expect(describeExtraRule({ kind: "nth_weekday", n: 2, weekday: 6 })).toBe("每月第二个周六");
    expect(describeExtraRule(LAST_SATURDAY)).toBe("每月最后一个周六");
  });

  test("手动标记的上班日：上班，原因是手动标记", () => {
    const marked = workdayCalendar(HOLIDAYS, { rules: [], marks: [{ date: "2026-10-04", mark: "work" }] });
    expect(brief(marked.day("2026-10-04"))).toEqual(["上班", "手动标记上班"]);
  });

  test("手动标记的休息日压过以上所有原因：普通工作日、调休补班、额外规则命中的日子", () => {
    const marks = ["2026-10-08", "2026-10-10", "2026-10-31", "2026-11-09"].map((date) => ({ date, mark: "rest" as const }));
    const marked = workdayCalendar(HOLIDAYS, { rules: [LAST_SATURDAY], marks });
    for (const { date } of marks) expect(brief(marked.day(date))).toEqual(["休息", "手动标记休息"]);
  });

  test("isWorkday 按本地日期判断（给调度器用）", () => {
    expect(calendar.isWorkday(new Date(2026, 9, 10, 9, 0))).toBe(true);
    expect(calendar.isWorkday(new Date(2026, 9, 11, 9, 0))).toBe(false);
  });
});

describe("某一年缺节假日数据", () => {
  const calendar = workdayCalendar(HOLIDAYS, { rules: [LAST_SATURDAY], marks: [{ date: "2027-01-04", mark: "rest" }] });

  test("那一年按周一到周五加个人规则和手动标记算，结果标明缺哪边的数据", () => {
    // 2027 年两边都没有：元旦（周五）也按工作日算
    expect(calendar.day("2027-01-01")).toMatchObject({ workday: true, missing: ["sg", "cn"] });
    expect(brief(calendar.day("2027-01-02"))).toEqual(["休息", "周末"]);
    expect(brief(calendar.day("2027-01-30"))).toEqual(["上班", "额外规则：每月最后一个周六"]);
    expect(brief(calendar.day("2027-01-04"))).toEqual(["休息", "手动标记休息"]);
    expect(calendar.day("2026-10-08").missing).toEqual([]);
  });

  test("只缺一边：缺的那边按周一到周五算", () => {
    const sgOnly = workdayCalendar([{ ...SG_2026, year: 2027, days: [{ date: "2027-01-01", name: "New Year's Day 元旦", kind: "holiday" }] }], NONE);
    expect(sgOnly.day("2027-01-01")).toMatchObject({ workday: true, reasons: [{ kind: "cn_workday" }], missing: ["cn"] });
    expect(sgOnly.missing(2027)).toEqual(["cn"]);
    expect(sgOnly.missing(2028)).toEqual(["sg", "cn"]);
  });

  test("按月看：每天的结果，月份对得上", () => {
    const days = calendar.month(2026, 10);
    expect(days).toHaveLength(31);
    expect(days[0]).toMatchObject({ date: "2026-10-01", weekday: 4 });
    expect(days.at(-1)?.date).toBe("2026-10-31");
    expect(calendar.month(2027, 2)).toHaveLength(28);
  });
});

describe("改个人规则和手动标记", () => {
  test("同一天只有一个手动标记：后标的覆盖先标的；清掉标记就回到按规则算", () => {
    const first = applyWorkdayChange(NONE, { kind: "mark", date: "2026-10-12", mark: "work" });
    const second = applyWorkdayChange(first.settings, { kind: "mark", date: "2026-10-12", mark: "rest" });
    expect(second).toMatchObject({ changed: true, settings: { marks: [{ date: "2026-10-12", mark: "rest" }] } });
    const cleared = applyWorkdayChange(second.settings, { kind: "clear_mark", date: "2026-10-12" });
    expect(cleared).toMatchObject({ changed: true, settings: { marks: [] } });
    // 没有标记的那天再清：没有变化
    expect(applyWorkdayChange(cleared.settings, { kind: "clear_mark", date: "2026-10-12" })).toMatchObject({ changed: false });
  });

  test("标记按日期排好；同样的标记再标一次没有变化", () => {
    let settings = NONE;
    for (const date of ["2026-11-02", "2026-10-12"]) settings = applyWorkdayChange(settings, { kind: "mark", date, mark: "rest" }).settings;
    expect(settings.marks.map((m) => m.date)).toEqual(["2026-10-12", "2026-11-02"]);
    expect(applyWorkdayChange(settings, { kind: "mark", date: "2026-10-12", mark: "rest" }).changed).toBe(false);
  });

  test("额外规则：同一条只加一次；按写法删掉；删不存在的没有变化", () => {
    const added = applyWorkdayChange(NONE, { kind: "add_rule", rule: LAST_SATURDAY });
    expect(added).toMatchObject({ changed: true, settings: { rules: [LAST_SATURDAY] } });
    expect(applyWorkdayChange(added.settings, { kind: "add_rule", rule: { weekday: 6, kind: "last_weekday" } }).changed).toBe(false);
    expect(applyWorkdayChange(added.settings, { kind: "remove_rule", rule: LAST_SATURDAY })).toMatchObject({ changed: true, settings: { rules: [] } });
    expect(applyWorkdayChange(NONE, { kind: "remove_rule", rule: LAST_SATURDAY }).changed).toBe(false);
  });

  test("不存在的日期不收", () => {
    expect(() => applyWorkdayChange(NONE, { kind: "mark", date: "2026-02-30", mark: "rest" })).toThrow(/2026-02-30/);
  });

  test("改动的中文写法（快速动作卡上给用户核对）", () => {
    expect(describeWorkdayChange({ kind: "mark", date: "2026-10-12", mark: "rest" })).toBe("把 2026 年 10 月 12 日（周一）标为休息");
    expect(describeWorkdayChange({ kind: "mark", date: "2026-10-04", mark: "work" })).toBe("把 2026 年 10 月 4 日（周日）标为上班");
    expect(describeWorkdayChange({ kind: "clear_mark", date: "2026-10-12" })).toBe("清掉 2026 年 10 月 12 日（周一）的手动标记");
    expect(describeWorkdayChange({ kind: "add_rule", rule: LAST_SATURDAY })).toBe("加一条额外上班规则：每月最后一个周六");
    expect(describeWorkdayChange({ kind: "remove_rule", rule: LAST_SATURDAY })).toBe("删掉额外上班规则：每月最后一个周六");
  });
});
