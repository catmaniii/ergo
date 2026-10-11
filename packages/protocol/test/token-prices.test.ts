// 框架自带的单价表（94 号票）：DeepSeek 的价格分高峰、空闲两个时段。
// - 自带价格表里的模型（和官网说按 Flash 计费的两个旧名字）查得到单价，高峰价是空闲价的两倍；
// - 高峰时段：北京时间周一至周五（不含国内法定节假日）9:00–12:00、14:00–18:00，含开头不含结尾；
//   周末、法定节假日全天空闲；按北京时间判断，记账时间带别的时区偏移的照样算对；某一年没有国内节假日数据时只按周一至周五算，标出来。
import { describe, expect, test } from "vitest";
import {
  BUILTIN_PRICE_SOURCE,
  BUILTIN_TOKEN_PRICES,
  builtinPriceOf,
  describePeakHours,
  type HolidayYear,
  pricePeriodJudge,
} from "../src/index.ts";

const SOURCE = [{ title: "测试用", url: "https://example.invalid/" }];

/** 国内 2026 年的一部分（摘自框架自带的 cn-2026.json）：中秋、国庆放假，10 月 10 日（周六）调休上班 */
const CN_2026: HolidayYear = {
  format: 1,
  region: "cn",
  year: 2026,
  sources: SOURCE,
  days: [
    { date: "2026-09-25", name: "中秋节", kind: "holiday" },
    { date: "2026-10-01", name: "国庆节", kind: "holiday" },
    { date: "2026-10-02", name: "国庆节", kind: "holiday" },
    { date: "2026-10-05", name: "国庆节", kind: "holiday" },
    { date: "2026-10-07", name: "国庆节", kind: "holiday" },
    { date: "2026-10-10", name: "国庆节调休上班", kind: "makeup_workday" },
  ],
};

/** 新加坡的假期不影响 DeepSeek 的时段（10 月 13 日是周二，虚构的） */
const SG_2026: HolidayYear = { format: 1, region: "sg", year: 2026, sources: SOURCE, days: [{ date: "2026-10-13", name: "虚构的假期", kind: "holiday" }] };

describe("自带价格表", () => {
  test("deepseek-flash、deepseek-v4-pro 照官网的价格（元 / 百万 token）", () => {
    expect(builtinPriceOf("deepseek/deepseek-flash")).toEqual({
      pricedAs: "deepseek/deepseek-flash",
      offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
      peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    });
    expect(builtinPriceOf("deepseek/deepseek-v4-pro")).toEqual({
      pricedAs: "deepseek/deepseek-v4-pro",
      offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
      peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    });
    expect(BUILTIN_PRICE_SOURCE).toMatchObject({ url: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing", readOn: "2026-10-12" });
  });

  test("两个旧名字按 deepseek-flash 算；表里没有的查不到", () => {
    for (const legacy of ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash-vision-exp"]) {
      expect(builtinPriceOf(legacy)).toEqual({ ...builtinPriceOf("deepseek/deepseek-flash"), pricedAs: "deepseek/deepseek-flash" });
    }
    expect(builtinPriceOf("faux")).toBeUndefined();
    expect(builtinPriceOf("deepseek/deepseek-flash-x")).toBeUndefined();
    expect(builtinPriceOf("toString")).toBeUndefined();
  });

  test("每个模型每一项的高峰价都是空闲价的两倍", () => {
    for (const price of Object.values(BUILTIN_TOKEN_PRICES)) {
      expect(price.peak).toEqual({ cacheHit: price.offPeak.cacheHit * 2, cacheMiss: price.offPeak.cacheMiss * 2, output: price.offPeak.output * 2 });
    }
  });
});

describe("高峰时段", () => {
  const periodOf = pricePeriodJudge([CN_2026, SG_2026]);
  const period = (time: string) => periodOf(time).period;

  test("工作日 9:00–12:00、14:00–18:00 是高峰，整点边界含开头不含结尾", () => {
    // 2026-10-12 是周一
    const cases: Array<[string, "peak" | "off_peak"]> = [
      ["00:00:00.000", "off_peak"],
      ["08:59:59.999", "off_peak"],
      ["09:00:00.000", "peak"],
      ["10:30:00.000", "peak"],
      ["11:59:59.999", "peak"],
      ["12:00:00.000", "off_peak"],
      ["13:59:59.999", "off_peak"],
      ["14:00:00.000", "peak"],
      ["17:59:59.999", "peak"],
      ["18:00:00.000", "off_peak"],
      ["23:59:59.999", "off_peak"],
    ];
    for (const [clock, expected] of cases) expect([clock, period(`2026-10-12T${clock}+08:00`)]).toEqual([clock, expected]);
    // 周五也是工作日
    expect(period("2026-10-16T10:00:00.000+08:00")).toBe("peak");
  });

  test("周末全天空闲（调休上班的周六也按周末算：官网写的是周一至周五）", () => {
    expect(period("2026-10-17T10:00:00.000+08:00")).toBe("off_peak");
    expect(period("2026-10-18T15:00:00.000+08:00")).toBe("off_peak");
    expect(period("2026-10-10T10:00:00.000+08:00")).toBe("off_peak");
  });

  test("国内法定节假日全天空闲（按节假日数据），新加坡的假期不算", () => {
    expect(period("2026-10-01T10:00:00.000+08:00")).toBe("off_peak");
    expect(period("2026-10-05T15:00:00.000+08:00")).toBe("off_peak");
    expect(period("2026-09-25T09:00:00.000+08:00")).toBe("off_peak");
    expect(period("2026-10-13T10:00:00.000+08:00")).toBe("peak");
    expect(periodOf("2026-10-01T10:00:00.000+08:00")).toEqual({ period: "off_peak", date: "2026-10-01", holidayDataMissing: false });
  });

  test("某一年没有国内节假日数据：只按周一至周五算，标出来", () => {
    // 2027-01-01 是周五（实际是元旦），没有 2027 年的数据只能按工作日算
    expect(periodOf("2027-01-01T10:00:00.000+08:00")).toEqual({ period: "peak", date: "2027-01-01", holidayDataMissing: true });
    expect(periodOf("2027-01-02T10:00:00.000+08:00")).toEqual({ period: "off_peak", date: "2027-01-02", holidayDataMissing: true });
    // 只有新加坡的数据也算缺
    expect(pricePeriodJudge([SG_2026])("2026-10-01T10:00:00.000+08:00")).toEqual({ period: "peak", date: "2026-10-01", holidayDataMissing: true });
  });

  test("记账时间带别的时区偏移：换成北京时间再判断（时刻、星期、节假日都按北京的）", () => {
    // UTC 01:00 = 北京 09:00
    expect(period("2026-10-12T00:59:59.999Z")).toBe("off_peak");
    expect(period("2026-10-12T01:00:00.000Z")).toBe("peak");
    // +05:30 的 06:30 = 北京 09:00
    expect(period("2026-10-12T06:29:00.000+05:30")).toBe("off_peak");
    expect(period("2026-10-12T06:30:00.000+05:30")).toBe("peak");
    // +01:00 的 10:59 = 北京 17:59；11:00 = 北京 18:00
    expect(period("2026-10-12T10:59:00.000+01:00")).toBe("peak");
    expect(period("2026-10-12T11:00:00.000+01:00")).toBe("off_peak");
    // 当地是周日晚上，北京已经是周一上午
    expect(periodOf("2026-10-11T20:00:00.000-05:00")).toEqual({ period: "peak", date: "2026-10-12", holidayDataMissing: false });
    // 当地是周五晚上，北京已经是周六
    expect(period("2026-10-16T22:00:00.000-04:00")).toBe("off_peak");
    // 当地是 9 月 30 日（周三）晚上，北京已经是国庆
    expect(period("2026-09-30T19:00:00.000-07:00")).toBe("off_peak");
    // 当地还是 10 月 7 日（国庆）晚上，北京已经是 10 月 8 日（周四，上班）上午
    expect(period("2026-10-07T21:00:00.000-05:00")).toBe("peak");
  });

  test("规则的说法：北京时间、周一至周五、两段时间、节假日、空闲价是一半", () => {
    const text = describePeakHours();
    for (const part of ["北京时间", "周一至周五", "9:00–12:00", "14:00–18:00", "法定节假日", "一半"]) expect(text).toContain(part);
  });
});
