// 消耗页的粗估成本怎么定单价（94 号票）：配置里写了单价的模型以配置为准（不分时段）；没写的用框架自带的价格表
// （DeepSeek，分高峰、空闲，每一笔按记账时间落在哪个时段算）；两边都没有的列在"没配单价"、不算进成本。
// 节假日数据用框架自带的（cn-2026.json 里 10 月 1–7 日国庆放假，10 月 10 日周六调休上班）。
import { BUILTIN_PRICE_SOURCE, describePeakHours, type TokenCounts } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import type { TokenPriceTable } from "../src/config/config.ts";
import { createSummaryPricing } from "../src/ledger/pricing.ts";
import { loadBuiltinHolidays } from "../src/workday/index.ts";

const holidays = loadBuiltinHolidays();
const M = 1_000_000;
/** 命中、未命中、输出各一百万 token */
const ONE_EACH: TokenCounts = { cacheHit: M, cacheMiss: M, output: M };
const FLASH = "deepseek/deepseek-flash";
const PRO = "deepseek/deepseek-v4-pro";
/** 2026-10-12 周一上午，高峰 */
const MON_PEAK = "2026-10-12T10:00:00.000+08:00";
/** 同一天晚上，空闲 */
const MON_NIGHT = "2026-10-12T20:00:00.000+08:00";
/** 国庆假期里的周一上午，空闲 */
const HOLIDAY = "2026-10-05T10:00:00.000+08:00";
const noConfig = (): TokenPriceTable => ({ currency: "CNY", models: {} });

const BUILTIN_NOTE = { source: BUILTIN_PRICE_SOURCE, peakHours: describePeakHours(), missingHolidayYears: [] };
const FLASH_PRICE = { cacheHit: 0.02, cacheMiss: 1, output: 4 };
const FLASH_PEAK = { cacheHit: 0.04, cacheMiss: 2, output: 8 };

describe("没配单价的用框架自带的价格表", () => {
  test("deepseek-flash、deepseek-v4-pro 按时段算：高峰是空闲的两倍；周末、法定节假日全天空闲", () => {
    const pricing = createSummaryPricing(noConfig, holidays);
    expect(pricing.cost(FLASH, MON_PEAK, ONE_EACH)).toBeCloseTo(10.04, 10);
    expect(pricing.cost(FLASH, MON_NIGHT, ONE_EACH)).toBeCloseTo(5.02, 10);
    expect(pricing.cost(FLASH, HOLIDAY, ONE_EACH)).toBeCloseTo(5.02, 10);
    expect(pricing.cost(PRO, MON_PEAK, ONE_EACH)).toBeCloseTo(36.3, 10);
    expect(pricing.cost(PRO, "2026-10-17T10:00:00.000+08:00", ONE_EACH)).toBeCloseTo(18.15, 10);
    // 调休上班的周六（10 月 10 日）：官网写的是周一至周五，按空闲
    expect(pricing.cost(PRO, "2026-10-10T10:00:00.000+08:00", ONE_EACH)).toBeCloseTo(18.15, 10);
    // 只有输出、只有命中的
    expect(pricing.cost(FLASH, MON_PEAK, { cacheHit: 0, cacheMiss: 0, output: 500_000 })).toBeCloseTo(4, 10);
    expect(pricing.cost(FLASH, MON_NIGHT, { cacheHit: 2_000_000, cacheMiss: 0, output: 0 })).toBeCloseTo(0.04, 10);
    expect(pricing.result()).toEqual({
      estimate: true,
      currency: "CNY",
      prices: [
        { model: FLASH, source: "builtin", pricedAs: FLASH, offPeak: FLASH_PRICE, peak: FLASH_PEAK },
        { model: PRO, source: "builtin", pricedAs: PRO, offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }, peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 } },
      ],
      unpriced: [],
      builtin: BUILTIN_NOTE,
    });
  });

  test("两个旧名字按 deepseek-flash 的价格算，单价里写明按谁算", () => {
    const pricing = createSummaryPricing(noConfig, holidays);
    expect(pricing.cost("deepseek/deepseek-v4-flash", MON_PEAK, ONE_EACH)).toBeCloseTo(10.04, 10);
    expect(pricing.cost("deepseek/deepseek-v4-flash-vision-exp", MON_NIGHT, ONE_EACH)).toBeCloseTo(5.02, 10);
    expect(pricing.result().prices).toEqual([
      { model: "deepseek/deepseek-v4-flash", source: "builtin", pricedAs: FLASH, offPeak: FLASH_PRICE, peak: FLASH_PEAK },
      { model: "deepseek/deepseek-v4-flash-vision-exp", source: "builtin", pricedAs: FLASH, offPeak: FLASH_PRICE, peak: FLASH_PEAK },
    ]);
  });

  test("记账时间不是 +08:00 的按北京时间判断时段", () => {
    const pricing = createSummaryPricing(noConfig, holidays);
    // UTC 02:00 = 北京 10:00（高峰）；纽约周日晚上 = 北京周一上午（高峰）；伦敦周一 11:00 = 北京 18:00（空闲）
    expect(pricing.cost(FLASH, "2026-10-12T02:00:00.000Z", ONE_EACH)).toBeCloseTo(10.04, 10);
    expect(pricing.cost(FLASH, "2026-10-11T21:00:00.000-05:00", ONE_EACH)).toBeCloseTo(10.04, 10);
    expect(pricing.cost(FLASH, "2026-10-12T11:00:00.000+01:00", ONE_EACH)).toBeCloseTo(5.02, 10);
  });

  test("某一年没有国内节假日数据：那一年只按周一至周五算，写明哪几年缺", () => {
    const pricing = createSummaryPricing(noConfig, holidays);
    // 2027-01-01 是周五（实际是元旦）：没有 2027 年的数据，按高峰
    expect(pricing.cost(FLASH, "2027-01-01T10:00:00.000+08:00", ONE_EACH)).toBeCloseTo(10.04, 10);
    expect(pricing.cost(FLASH, "2028-01-03T20:00:00.000+08:00", ONE_EACH)).toBeCloseTo(5.02, 10);
    expect(pricing.cost(FLASH, MON_PEAK, ONE_EACH)).toBeCloseTo(10.04, 10);
    expect(pricing.result().builtin).toEqual({ ...BUILTIN_NOTE, missingHolidayYears: [2027, 2028] });
  });
});

describe("配置里的单价照旧优先", () => {
  test("配置里写了单价的模型以配置为准，不分时段；没写的照旧用自带价格表", () => {
    const pricing = createSummaryPricing(() => ({ currency: "CNY", models: { [FLASH]: { cacheHit: 1, cacheMiss: 1, output: 1 } } }), holidays);
    expect(pricing.cost(FLASH, MON_PEAK, ONE_EACH)).toBeCloseTo(3, 10);
    expect(pricing.cost(FLASH, MON_NIGHT, ONE_EACH)).toBeCloseTo(3, 10);
    expect(pricing.cost(PRO, MON_PEAK, ONE_EACH)).toBeCloseTo(36.3, 10);
    expect(pricing.result().prices).toEqual([
      { model: FLASH, source: "config", cacheHit: 1, cacheMiss: 1, output: 1 },
      { model: PRO, source: "builtin", pricedAs: PRO, offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }, peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 } },
    ]);
  });

  test("全按配置算的：不带自带价格表的说明；缺节假日数据的年份也不算", () => {
    const pricing = createSummaryPricing(() => ({ currency: "CNY", models: { faux: { cacheHit: 0.5, cacheMiss: 2, output: 8 } } }), holidays);
    expect(pricing.cost("faux", "2027-01-01T10:00:00.000+08:00", ONE_EACH)).toBeCloseTo(10.5, 10);
    expect(pricing.result()).toEqual({ estimate: true, currency: "CNY", prices: [{ model: "faux", source: "config", cacheHit: 0.5, cacheMiss: 2, output: 8 }], unpriced: [] });
  });

  test("两边都没有的列在没配单价、不算进成本（没有用量的不列）", () => {
    const pricing = createSummaryPricing(noConfig, holidays);
    expect(pricing.cost("other/m", MON_PEAK, ONE_EACH)).toBe(0);
    expect(pricing.cost("other/empty", MON_PEAK, { cacheHit: 0, cacheMiss: 0, output: 0 })).toBe(0);
    expect(pricing.result()).toEqual({ estimate: true, currency: "CNY", prices: [], unpriced: ["other/m"] });
  });

  test("配置的货币不是人民币：自带价格表（人民币）不混进来，那些模型列在没配单价", () => {
    const pricing = createSummaryPricing(() => ({ currency: "USD", models: { faux: { cacheHit: 0, cacheMiss: 1, output: 2 } } }), holidays);
    expect(pricing.cost(FLASH, MON_PEAK, ONE_EACH)).toBe(0);
    expect(pricing.cost("faux", MON_PEAK, ONE_EACH)).toBeCloseTo(3, 10);
    expect(pricing.result()).toEqual({ estimate: true, currency: "USD", prices: [{ model: "faux", source: "config", cacheHit: 0, cacheMiss: 1, output: 2 }], unpriced: [FLASH] });
  });

  test("配置里的单价读不出来：写明原因，自带价格表照用", () => {
    const pricing = createSummaryPricing(() => {
      throw new Error("tokenPrices.models[\"faux\"].cacheHit 必须是不小于 0 的数");
    }, holidays);
    expect(pricing.cost("faux", MON_PEAK, ONE_EACH)).toBe(0);
    expect(pricing.cost(FLASH, MON_PEAK, ONE_EACH)).toBeCloseTo(10.04, 10);
    expect(pricing.result()).toEqual({
      estimate: true,
      currency: "CNY",
      prices: [{ model: FLASH, source: "builtin", pricedAs: FLASH, offPeak: FLASH_PRICE, peak: FLASH_PEAK }],
      unpriced: ["faux"],
      builtin: BUILTIN_NOTE,
      problem: "tokenPrices.models[\"faux\"].cacheHit 必须是不小于 0 的数",
    });
  });
});
