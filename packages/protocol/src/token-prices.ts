// 框架自带的 token 单价表（94 号票）：用户的配置里没写单价（tokenPrices）的模型，消耗页的粗估成本按这里算。
// DeepSeek 的价格分高峰、空闲两个时段：每一笔用量按它记账的时间落在哪个时段算价。
//
// 价格和高峰时段的规则都取自 DeepSeek 官网（https://api-docs.deepseek.com/zh-cn/quick_start/pricing），2026-10-12 读的。
// 官网会改价：改价、改时段只改这个文件（BUILTIN_PRICE_SOURCE 的日期跟着改）。
// 守护进程（账本算成本）和 Web（原型的假账本）共用。不引用 TypeBox。
import { localDateKey } from "./local-date.ts";
import type { TokenPrice } from "./usage-schema.ts";
import { HOLIDAY_DAY_KIND_REST, type HolidayYear, mergeHolidayYears } from "./workday-calendar.ts";

/** 自带价格表从哪来：官网的哪一页、哪天读的 */
export const BUILTIN_PRICE_SOURCE = Object.freeze({
  title: "DeepSeek 官网的价格页",
  url: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
  readOn: "2026-10-12",
});

/** 自带价格表的货币：人民币（配置里的货币不是它时不用自带价格表，免得两种货币加在一起） */
export const BUILTIN_PRICE_CURRENCY = "CNY";

/** 计价时段：高峰、空闲 */
export const PRICE_PERIODS = ["peak", "off_peak"] as const;
export type PricePeriod = (typeof PRICE_PERIODS)[number];
export const PRICE_PERIOD_LABEL: Readonly<Record<PricePeriod, string>> = { peak: "高峰", off_peak: "空闲" };

/** 分时段的单价（每百万 token）：高峰、空闲各一份 */
export interface TimedTokenPrice {
  peak: TokenPrice;
  offPeak: TokenPrice;
}

/** 自带价格表（元 / 百万 token）。键是模型在配置里的键（「provider/模型 id」，和 tokenPrices 的键一样） */
export const BUILTIN_TOKEN_PRICES: Readonly<Record<string, TimedTokenPrice>> = Object.freeze({
  "deepseek/deepseek-flash": {
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  },
  "deepseek/deepseek-v4-pro": {
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  },
});

/** 官网说按别的模型计费的旧名字 → 按哪个模型算 */
export const BUILTIN_PRICE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "deepseek/deepseek-v4-flash": "deepseek/deepseek-flash",
  "deepseek/deepseek-v4-flash-vision-exp": "deepseek/deepseek-flash",
});

/**
 * 高峰时段：北京时间（UTC+8）周一至周五、不含国内法定节假日的 9:00–12:00、14:00–18:00（含开头不含结尾，分钟数从零点起）。
 * 其余时间（含周末、法定节假日全天）是空闲时段。法定节假日看国内的节假日数据（29 号票，框架自带的加导入的）；
 * 调休上班的周末官网没说，照"周一至周五"按空闲算
 */
export const PEAK_HOURS = Object.freeze({
  /** 北京时间比 UTC 早几分钟 */
  utcOffsetMinutes: 8 * 60,
  /** 周几（0 是周日）有高峰时段 */
  weekdays: [1, 2, 3, 4, 5] as readonly number[],
  windows: [
    { from: 9 * 60, to: 12 * 60 },
    { from: 14 * 60, to: 18 * 60 },
  ] as ReadonlyArray<{ from: number; to: number }>,
});

/** 某个模型在自带价格表里的单价（旧名字按它对应的模型，pricedAs 是按哪个模型算的）；表里没有是 undefined */
export function builtinPriceOf(model: string): (TimedTokenPrice & { pricedAs: string }) | undefined {
  const pricedAs = Object.hasOwn(BUILTIN_PRICE_ALIASES, model) ? BUILTIN_PRICE_ALIASES[model]! : model;
  if (!Object.hasOwn(BUILTIN_TOKEN_PRICES, pricedAs)) return undefined;
  const { peak, offPeak } = BUILTIN_TOKEN_PRICES[pricedAs]!;
  return { pricedAs, offPeak, peak };
}

/** 一笔用量落在哪个时段：北京时间的日期，那一年有没有国内节假日数据（没有时只按周一至周五算） */
export interface PricePeriodOf {
  period: PricePeriod;
  /** 北京时间的日期 YYYY-MM-DD（写法不对的时间是空串） */
  date: string;
  holidayDataMissing: boolean;
}

/**
 * 按节假日数据建一个时段判断（建一次、逐笔用）：time 是协议时间（带时区偏移的 ISO 时间，偏移是几都行），
 * 换成北京时间再看星期、钟点和国内法定节假日。时间写法不对时按高峰算（粗估往高里算）
 */
export function pricePeriodJudge(holidays: readonly HolidayYear[]): (time: string) => PricePeriodOf {
  const cnYears = mergeHolidayYears(holidays).filter((y) => y.region === "cn");
  const present = new Set(cnYears.map((y) => y.year));
  const restDays = new Set(cnYears.flatMap((y) => y.days.filter((d) => HOLIDAY_DAY_KIND_REST[d.kind]).map((d) => d.date)));
  return (time) => {
    const instant = Date.parse(time);
    if (!Number.isFinite(instant)) return { period: "peak", date: "", holidayDataMissing: false };
    // 挪 8 小时后按 UTC 读出来的年月日、星期、钟点就是北京时间的
    const beijing = new Date(instant + PEAK_HOURS.utcOffsetMinutes * 60_000);
    const year = beijing.getUTCFullYear();
    const date = localDateKey(year, beijing.getUTCMonth() + 1, beijing.getUTCDate());
    const minute = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
    const holidayDataMissing = !present.has(year);
    const peak =
      PEAK_HOURS.weekdays.includes(beijing.getUTCDay()) && !restDays.has(date) && PEAK_HOURS.windows.some((w) => minute >= w.from && minute < w.to);
    return { period: peak ? "peak" : "off_peak", date, holidayDataMissing };
  };
}

const clock = (minutes: number) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;

/** 高峰时段规则的说法（消耗页上写明） */
export function describePeakHours(): string {
  const windows = PEAK_HOURS.windows.map((w) => `${clock(w.from)}–${clock(w.to)}`).join("、");
  return `高峰时段是北京时间周一至周五（国内法定节假日除外）的 ${windows}；其余时间（含周末、法定节假日全天）是空闲时段，空闲价是高峰价的一半。每一笔用量按记账时间落在哪个时段算价。`;
}
