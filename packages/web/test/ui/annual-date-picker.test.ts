// 449：档案页上生日、纪念日的选择器（pages/more/AnnualDatePicker.tsx）和它的草稿（state/personal-files.ts）——
// 公历 / 农历切换，年（第一项"不记得哪年"，往下今年到 1900 年）、月、日三个下拉；打开时按现在的值预选；公历的日按年月限
// （2 月 29 日只在闰年或不记得哪年时有），换年换月日子往回收；农历的月是正月…腊月、可勾闰月，日是初一…三十；拼成存的样子。
// 每年提醒那句小字：农历写"暂时不能自动提醒"，认不出的不在那里说（值旁边提示）。中英两种语言。用 React 在 Node 里渲染出来查。
// 460：以前随手写的值由二狗统一成存的样子，档案页上那一条的出处写"二狗统一了写法"（不写谁改的、没有原话）。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test } from "vitest";
import { AnnualDatePicker } from "../../src/pages/more/AnnualDatePicker.tsx";
import {
  activeLocaleFrom,
  type AnnualDraft,
  annualDayChoices,
  annualDraftOf,
  annualDraftValue,
  annualNote,
  annualYearChoices,
  changeAnnualDraft,
  DEFAULT_LANGUAGE,
  setActiveLocale,
  sourceQuote,
  valueSourceLine,
} from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

const inEnglish = () => setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
afterEach(() => setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE)));

const render = (draft: AnnualDraft) => renderToStaticMarkup(createElement(AnnualDatePicker, { label: "生日", draft, onChange: () => undefined }));
/** 某个下拉（按 aria-label 找）里的选项文字 */
const optionsOf = (html: string, label: string): string[] => {
  const select = new RegExp(`<select[^>]*aria-label="${label}"[^>]*>(.*?)</select>`).exec(html)?.[1] ?? "";
  return [...select.matchAll(/<option[^>]*>(.*?)<\/option>/g)].map((m) => m[1]!);
};
/** 某个下拉选中的那一项 */
const selectedOf = (html: string, label: string): string | undefined => {
  const select = new RegExp(`<select[^>]*aria-label="${label}"[^>]*>(.*?)</select>`).exec(html)?.[1] ?? "";
  return /<option[^>]*selected=""[^>]*>(.*?)<\/option>/.exec(select)?.[1];
};

describe("草稿", () => {
  test("按现在的值预选（存的样子、以前认得出的写法）；没有值、认不出的从公历、不记得哪年、月日没选起", () => {
    expect(annualDraftOf("1990-03-02")).toEqual({ calendar: "solar", year: 1990, month: 3, day: 2, leap: false });
    expect(annualDraftOf("3月2日")).toEqual({ calendar: "solar", month: 3, day: 2, leap: false });
    expect(annualDraftOf("lunar:--L04-15")).toEqual({ calendar: "lunar", month: 4, day: 15, leap: true });
    expect(annualDraftOf(undefined)).toEqual({ calendar: "solar", leap: false });
    expect(annualDraftOf("大学开学那天")).toEqual({ calendar: "solar", leap: false });
  });

  test("2 月 29 日只在闰年或不记得哪年时有：换成平年往回收到 28 日；农历三十换成公历 2 月收到 29 日；换成公历没有闰月", () => {
    const leapDay = annualDraftOf("2024-02-29");
    expect(annualDayChoices(leapDay)).toHaveLength(29);
    const common = changeAnnualDraft(leapDay, { year: 2023 });
    expect(common).toMatchObject({ year: 2023, month: 2, day: 28 });
    expect(annualDayChoices(common)).toHaveLength(28);
    expect(annualDayChoices(changeAnnualDraft(common, { year: null }))).toHaveLength(29);
    const lunar = changeAnnualDraft(annualDraftOf("lunar:--L02-30"), { calendar: "solar" });
    expect(lunar).toEqual({ calendar: "solar", month: 2, day: 29, leap: false });
    expect(changeAnnualDraft(annualDraftOf("--01-31"), { month: 4 }).day).toBe(30);
  });

  test("选好了拼成存的样子，没选好是 undefined", () => {
    expect(annualDraftValue({ calendar: "solar", leap: false })).toBeUndefined();
    expect(annualDraftValue({ calendar: "solar", month: 3, leap: false })).toBeUndefined();
    expect(annualDraftValue({ calendar: "solar", month: 3, day: 2, leap: false })).toBe("--03-02");
    expect(annualDraftValue({ calendar: "solar", year: 1990, month: 3, day: 2, leap: false })).toBe("1990-03-02");
    expect(annualDraftValue({ calendar: "lunar", year: 1990, month: 4, day: 15, leap: true })).toBe("lunar:1990-L04-15");
    expect(annualDraftValue(changeAnnualDraft({ calendar: "solar", leap: false }, { calendar: "lunar", month: 8, day: 15 }))).toBe("lunar:--08-15");
  });

  test("年份：今年到 1900 年；现在的值更早时也列上", () => {
    const years = annualYearChoices(2026);
    expect([years[0], years.at(-1), years.length]).toEqual([2026, 1900, 127]);
    expect(annualYearChoices(2026, 1890).at(-1)).toBe(1890);
  });

  test("每年提醒的小字：农历写暂时不能自动提醒；认不出的不在这里说", () => {
    expect(annualNote({ blocked: "not_gregorian" }, "lunar:--08-15")).toBe("农历的暂时不能自动提醒");
    expect(annualNote({ blocked: "not_gregorian" }, "大学开学那天")).toBeUndefined();
  });
});

describe("选择器", () => {
  test("公历 / 农历切换、年月日三个下拉；年第一项不记得哪年；按值预选；公历闰年 2 月到 29 日", () => {
    const html = render(annualDraftOf("2024-02-29"));
    expect(html).toContain('role="radio" aria-checked="true" class="on"');
    expect(html).toMatch(/aria-checked="true" class="on">公历<\/button>/);
    expect(html).toContain(">农历</button>");
    const years = optionsOf(html, "年");
    expect(years.slice(0, 2)).toEqual(["不记得哪年", `${new Date().getFullYear()} 年`]);
    expect(years.at(-1)).toBe("1900 年");
    expect(selectedOf(html, "年")).toBe("2024 年");
    expect(optionsOf(html, "月")).toEqual(["1 月", "2 月", "3 月", "4 月", "5 月", "6 月", "7 月", "8 月", "9 月", "10 月", "11 月", "12 月"]);
    expect(selectedOf(html, "月")).toBe("2 月");
    expect(optionsOf(html, "日").at(-1)).toBe("29 日");
    expect(selectedOf(html, "日")).toBe("29 日");
    expect(html).not.toContain("闰月");
    // 平年的 2 月到 28 日
    expect(optionsOf(render(annualDraftOf("2023-02-28")), "日")).toHaveLength(28);
  });

  test("还没选：年是不记得哪年，月、日先是一项选月份、选日子", () => {
    const html = render(annualDraftOf(undefined));
    expect(selectedOf(html, "年")).toBe("不记得哪年");
    expect(optionsOf(html, "月")[0]).toBe("选月份");
    expect(optionsOf(html, "日")[0]).toBe("选日子");
  });

  test("农历：月是正月…腊月、日是初一…三十，能勾闰月", () => {
    const html = render(annualDraftOf("lunar:--L04-15"));
    expect(html).toMatch(/aria-checked="true" class="on">农历<\/button>/);
    const months = optionsOf(html, "月");
    expect([months[0], months[9], months[10], months[11]]).toEqual(["正月", "十月", "冬月", "腊月"]);
    expect(selectedOf(html, "月")).toBe("四月");
    const days = optionsOf(html, "日");
    expect([days[0], days[14], days.at(-1), days.length]).toEqual(["初一", "十五", "三十", 30]);
    expect(html).toMatch(/<input type="checkbox" checked=""\/><span>闰月<\/span>/);
  });

  test("英文", () => {
    inEnglish();
    const html = render(annualDraftOf("lunar:--08-15"));
    expect(html).toContain(">Gregorian</button>");
    expect(optionsOf(html, "Year")[0]).toBe("Year unknown");
    expect(optionsOf(html, "Month")[7]).toBe("8th month");
    expect(selectedOf(html, "Day")).toBe("15");
    expect(html).toContain("Leap month");
    expect(optionsOf(render(annualDraftOf("1990-03-02")), "Month")[2]).toBe("Mar");
    expect(annualNote({ blocked: "not_gregorian" }, "lunar:--08-15")).toBe("Yearly reminders for lunar dates aren't supported yet");
  });
});

describe("460：二狗统一了写法的那一条", () => {
  const tidied = { value: "2018-10-01", since: "2026-11-10T08:00:00+08:00", source: { via: "tidy" as const, at: "2026-11-10T08:00:00+08:00" } };
  const old = { value: "2018年10月1日", since: "2026-10-25T20:30:00+08:00", until: "2026-11-10T08:00:00+08:00", source: { via: "page" as const, at: "2026-10-25T20:30:00+08:00" } };

  test("出处写一句好懂的话，不写谁改的、没有原话；原来的写法照旧写到哪天为止", () => {
    expect(valueSourceLine(tidied)).toBe("2026-11-10 起 · 二狗统一了写法");
    expect(sourceQuote(tidied.source)).toBeUndefined();
    expect(valueSourceLine(old)).toBe("2026-10-25 到 2026-11-10 · 你在档案页填的");
  });

  test("英文", () => {
    inEnglish();
    expect(valueSourceLine(tidied)).toBe("since 2026-11-10 · ergo standardized the format");
  });
});
