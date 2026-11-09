// 生日、纪念日的日子（449）：各种写法认成结构、规范成存的样子、显示成好读的样子（中、英）、选择器上某月最多几号；
// 个人档案的值经 checkPersonalValue 规范化，monthDayOf 认存的样子（含不记得哪年的 --03-02）。
import { afterEach, describe, expect, it } from "vitest";
import {
  activeLocaleFrom,
  type AnnualDate,
  annualDateLabel,
  annualDateText,
  annualDayMax,
  annualValueUnreadable,
  checkPersonalValue,
  DEFAULT_LANGUAGE,
  formatAnnualDate,
  lunarDayName,
  lunarMonthName,
  monthDayOf,
  normalizeAnnualDate,
  parseAnnualDate,
  personalValueText,
  setActiveLocale,
} from "../src/index.ts";
import { TEST_LOCALES } from "./setup-locales.ts";

const inEnglish = () => setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
afterEach(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE)));

describe("认各种写法", () => {
  it.each<[string, AnnualDate]>([
    // 存的样子
    ["1990-03-02", { calendar: "solar", year: 1990, month: 3, day: 2 }],
    ["--03-02", { calendar: "solar", month: 3, day: 2 }],
    ["lunar:1990-08-15", { calendar: "lunar", year: 1990, month: 8, day: 15 }],
    ["lunar:--08-15", { calendar: "lunar", month: 8, day: 15 }],
    ["lunar:--L04-15", { calendar: "lunar", month: 4, day: 15, leap: true }],
    ["lunar:1990-L04-15", { calendar: "lunar", year: 1990, month: 4, day: 15, leap: true }],
    // 公历的各种写法
    ["1990年3月2日", { calendar: "solar", year: 1990, month: 3, day: 2 }],
    ["1990 年 3 月 2 日", { calendar: "solar", year: 1990, month: 3, day: 2 }],
    ["3月2号", { calendar: "solar", month: 3, day: 2 }],
    ["3 月 2 日", { calendar: "solar", month: 3, day: 2 }],
    ["1990/3/2", { calendar: "solar", year: 1990, month: 3, day: 2 }],
    ["1990.03.02", { calendar: "solar", year: 1990, month: 3, day: 2 }],
    ["19900302", { calendar: "solar", year: 1990, month: 3, day: 2 }],
    ["03-02", { calendar: "solar", month: 3, day: 2 }],
    ["3/2", { calendar: "solar", month: 3, day: 2 }],
    ["--0302", { calendar: "solar", month: 3, day: 2 }],
    ["１２月３１日", { calendar: "solar", month: 12, day: 31 }],
    ["每年 12 月 31 日", { calendar: "solar", month: 12, day: 31 }],
    ["公历三月二日", { calendar: "solar", month: 3, day: 2 }],
    ["三月二日", { calendar: "solar", month: 3, day: 2 }],
    ["2月29日", { calendar: "solar", month: 2, day: 29 }],
    ["2020-02-29", { calendar: "solar", year: 2020, month: 2, day: 29 }],
    ["March 2, 1990", { calendar: "solar", year: 1990, month: 3, day: 2 }],
    ["Mar 2", { calendar: "solar", month: 3, day: 2 }],
    ["2 March 1990", { calendar: "solar", year: 1990, month: 3, day: 2 }],
    ["October 1st", { calendar: "solar", month: 10, day: 1 }],
    // 农历
    ["农历八月十五", { calendar: "lunar", month: 8, day: 15 }],
    ["阴历8月15日", { calendar: "lunar", month: 8, day: 15 }],
    ["正月初一", { calendar: "lunar", month: 1, day: 1 }],
    ["腊月廿三", { calendar: "lunar", month: 12, day: 23 }],
    ["冬月三十", { calendar: "lunar", month: 11, day: 30 }],
    ["八月十五", { calendar: "lunar", month: 8, day: 15 }],
    ["农历1990年闰四月十五", { calendar: "lunar", year: 1990, month: 4, day: 15, leap: true }],
    ["1990年农历十月初十", { calendar: "lunar", year: 1990, month: 10, day: 10 }],
    ["闰四月二十", { calendar: "lunar", month: 4, day: 20, leap: true }],
    ["3月2日（农历）", { calendar: "lunar", month: 3, day: 2 }],
    ["lunar 8/15", { calendar: "lunar", month: 8, day: 15 }],
  ])("%s", (text, expected) => {
    expect(parseAnnualDate(text)).toEqual(expected);
  });

  it.each(["下个月", "中秋节", "大概六月中旬", "13800001111", "2月30日", "2023-02-29", "13月1日", "农历八月三十一", "公历闰四月十五", "", "0000-03-02", "Smarch 2"])("认不出：%s", (text) => {
    expect(parseAnnualDate(text)).toBeUndefined();
  });
});

describe("规范成存的样子", () => {
  it.each<[string, string]>([
    ["1990年3月2日", "1990-03-02"],
    ["3月2号", "--03-02"],
    ["03-02", "--03-02"],
    ["农历八月十五", "lunar:--08-15"],
    ["农历 1990 年八月十五", "lunar:1990-08-15"],
    ["闰四月十五", "lunar:--L04-15"],
    ["正月初一", "lunar:--01-01"],
    ["腊月廿三", "lunar:--12-23"],
    ["June 18, 1962", "1962-06-18"],
  ])("%s → %s", (text, stored) => {
    expect(normalizeAnnualDate(text)).toBe(stored);
    // 存的样子再认一遍还是它
    expect(normalizeAnnualDate(stored)).toBe(stored);
  });

  it("结构写回去", () => {
    expect(formatAnnualDate({ calendar: "solar", month: 3, day: 2 })).toBe("--03-02");
    expect(formatAnnualDate({ calendar: "lunar", year: 1990, month: 4, day: 15, leap: true })).toBe("lunar:1990-L04-15");
  });
});

describe("显示成好读的样子", () => {
  const cases: Array<[string, string, string]> = [
    ["1990-03-02", "1990 年 3 月 2 日", "Mar 2, 1990"],
    ["--03-02", "3 月 2 日", "Mar 2"],
    ["lunar:--08-15", "农历八月十五", "Lunar 8th month, day 15"],
    ["lunar:--01-01", "农历正月初一", "Lunar 1st month, day 1"],
    ["lunar:--12-23", "农历腊月廿三", "Lunar 12th month, day 23"],
    ["lunar:1990-L04-15", "农历 1990 年闰四月十五", "Lunar leap 4th month, day 15, 1990"],
    ["lunar:--L04-20", "农历闰四月二十", "Lunar leap 4th month, day 20"],
  ];

  it.each(cases)("中文：%s → %s", (stored, zh) => {
    expect(annualDateText(stored)).toBe(zh);
  });

  it.each(cases)("英文：%s → %s / %s", (stored, _zh, en) => {
    inEnglish();
    expect(annualDateText(stored)).toBe(en);
  });

  it("以前存的认得出的写法也照新样子写；认不出的是 undefined", () => {
    expect(annualDateText("3月2日")).toBe("3 月 2 日");
    expect(annualDateText("2018年10月1日")).toBe("2018 年 10 月 1 日");
    expect(annualDateText("大概六月中旬")).toBeUndefined();
    expect(annualDateLabel({ calendar: "lunar", month: 11, day: 30 })).toBe("农历冬月三十");
  });

  it("农历的月份、日子（选择器上用）", () => {
    expect([1, 10, 11, 12].map(lunarMonthName)).toEqual(["正月", "十月", "冬月", "腊月"]);
    expect([1, 10, 11, 20, 21, 30].map(lunarDayName)).toEqual(["初一", "初十", "十一", "二十", "廿一", "三十"]);
    inEnglish();
    expect([1, 2, 3, 11, 12].map(lunarMonthName)).toEqual(["1st month", "2nd month", "3rd month", "11th month", "12th month"]);
    expect(lunarDayName(15)).toBe("15");
  });
});

describe("选择器上某月最多几号", () => {
  it("公历按年月：2 月 29 日只在闰年或者不记得哪年时有；农历一律到三十", () => {
    expect(annualDayMax("solar", 2024, 2)).toBe(29);
    expect(annualDayMax("solar", 2023, 2)).toBe(28);
    expect(annualDayMax("solar", 1900, 2)).toBe(28);
    expect(annualDayMax("solar", undefined, 2)).toBe(29);
    expect(annualDayMax("solar", undefined, 4)).toBe(30);
    expect(annualDayMax("solar", 2026, 12)).toBe(31);
    expect(annualDayMax("lunar", 2023, 2)).toBe(30);
  });
});

describe("档案里的生日、纪念日", () => {
  it("写进来的规范成存的样子；认不出的拒绝，错误写明怎么写；别的字段照旧", () => {
    expect(checkPersonalValue("birthday", "3月2号")).toEqual({ ok: true, value: "--03-02" });
    expect(checkPersonalValue("anniversary:结婚纪念日", " 2018年10月1日 ")).toEqual({ ok: true, value: "2018-10-01" });
    expect(checkPersonalValue("custom:女儿生日", "农历八月十五")).toEqual({ ok: true, value: "lunar:--08-15" });
    const rejected = checkPersonalValue("birthday", "下个月");
    expect(rejected.ok ? "" : rejected.error).toMatch(/认不出日子.*1990-03-02.*3月2日.*农历八月十五/);
    inEnglish();
    const english = checkPersonalValue("birthday", "next month");
    expect(english.ok ? "" : english.error).toMatch(/1990-03-02/);
    // 名字不带生日、纪念日的自定义字段不管
    expect(checkPersonalValue("custom:备注", "下个月")).toEqual({ ok: true, value: "下个月" });
  });

  it("monthDayOf 认存的样子（含不记得哪年的 --03-02）；农历的不算", () => {
    expect(monthDayOf("--03-02")).toEqual({ month: 3, day: 2 });
    expect(monthDayOf("1990-03-02")).toEqual({ month: 3, day: 2 });
    expect(monthDayOf("--02-29")).toEqual({ month: 2, day: 29 });
    expect(monthDayOf("lunar:--08-15")).toBeUndefined();
    expect(monthDayOf("lunar:--L04-15")).toBeUndefined();
  });

  it("给人看的样子：生日、纪念日认得出的写成好读的，认不出的原样（旁边提示）；别的字段原样", () => {
    expect(personalValueText("birthday", "--03-02")).toBe("3 月 2 日");
    expect(personalValueText("birthday", "大概六月中旬")).toBe("大概六月中旬");
    expect(personalValueText("address", "1990-03-02")).toBe("1990-03-02");
    expect(annualValueUnreadable("birthday", "大概六月中旬")).toBe(true);
    expect(annualValueUnreadable("birthday", "3月2日")).toBe(false);
    expect(annualValueUnreadable("birthday", undefined)).toBe(false);
    expect(annualValueUnreadable("address", "随便写")).toBe(false);
  });
});
