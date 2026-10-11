// 消耗页的粗估成本怎么定单价（24 号票，94 号票改成分时段）：每次算消耗页时建一份，逐笔算成本，最后给出页面上的 pricing。
// - 配置里写了单价（tokenPrices）的模型以配置为准，不分时段（和以前一样）；
// - 没写的用框架自带的价格表（协议包 token-prices.ts：DeepSeek，取自官网），每一笔按记账时间落在高峰还是空闲时段算，
//   法定节假日看国内的节假日数据（框架自带的加导入的）；某一年没有数据时只按周一至周五算，页面上写明那几年；
//   自带价格表是人民币，配置里的货币不是人民币时不用它（不把两种货币加在一起）；
// - 两边都没有的不算进成本，列在"没配单价"；
// - 配置每次现读，读不出来时不用配置里的单价、写明原因，自带价格表照用。
import {
  BUILTIN_PRICE_CURRENCY,
  BUILTIN_PRICE_SOURCE,
  builtinPriceOf,
  costOf,
  describePeakHours,
  type HolidayYear,
  type ModelPrice,
  pricePeriodJudge,
  type TokenCounts,
  tokenTotal,
  type UsagePricing,
} from "@ergou/protocol";
import { DEFAULT_TOKEN_PRICE_CURRENCY, type TokenPriceTable } from "../config/config.ts";

export interface SummaryPricing {
  /** 一笔用量（model 是模型在配置里的键，time 是记账时间）的粗估成本；没有单价的是 0（记下来，列在没配单价） */
  cost(model: string, time: string, tokens: TokenCounts): number;
  /** 消耗页上的 pricing：用到的单价、没有单价的模型、自带价格表的说明、配置读不出来的原因 */
  result(): UsagePricing;
}

/** prices 现读配置里的单价（读不出来时抛错）；holidays 是节假日数据（框架自带的加导入的） */
export function createSummaryPricing(prices: () => TokenPriceTable, holidays: readonly HolidayYear[]): SummaryPricing {
  let config: TokenPriceTable;
  let problem: string | undefined;
  try {
    config = prices();
  } catch (err) {
    config = { currency: DEFAULT_TOKEN_PRICE_CURRENCY, models: {} };
    problem = err instanceof Error ? err.message : String(err);
  }
  const useBuiltin = config.currency === BUILTIN_PRICE_CURRENCY;
  const periodOf = pricePeriodJudge(holidays);
  const used = new Map<string, ModelPrice>();
  const unpriced = new Set<string>();
  const missingYears = new Set<number>();
  let builtinUsed = false;

  return {
    cost(model, time, tokens) {
      if (Object.hasOwn(config.models, model)) {
        const price = config.models[model]!;
        used.set(model, { model, source: "config", ...price });
        return costOf(tokens, price);
      }
      const builtin = useBuiltin ? builtinPriceOf(model) : undefined;
      if (!builtin) {
        if (tokenTotal(tokens) > 0) unpriced.add(model);
        return 0;
      }
      builtinUsed = true;
      used.set(model, { model, source: "builtin", ...builtin });
      const { period, date, holidayDataMissing } = periodOf(time);
      if (holidayDataMissing) missingYears.add(Number(date.slice(0, 4)));
      return costOf(tokens, period === "peak" ? builtin.peak : builtin.offPeak);
    },
    result() {
      return {
        estimate: true,
        currency: config.currency,
        prices: [...used.values()].toSorted((a, b) => a.model.localeCompare(b.model)),
        unpriced: [...unpriced].toSorted(),
        ...(builtinUsed
          ? { builtin: { source: { ...BUILTIN_PRICE_SOURCE }, peakHours: describePeakHours(), missingHolidayYears: [...missingYears].toSorted((a, b) => a - b) } }
          : {}),
        ...(problem === undefined ? {} : { problem }),
      };
    },
  };
}
