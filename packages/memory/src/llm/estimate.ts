// 预计 token 和费用（模型版跑之前先报）。不调模型，只按字数估：
// - token：DeepSeek 文档的经验值，1 个中文字符约 0.6 个 token，1 个英文字符约 0.3 个 token；
// - 价格：照二狗的自带价格表（packages/protocol/src/token-prices.ts，DeepSeek 官网 2026-10-12 读的；PoC 不跨包引用，抄在这里），
//   元 / 百万 token，输入按缓存未命中算；分高峰、空闲两档，报两个数，"往高里算"看高峰那个。

/** 估一段文字有多少 token */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[　-〿㐀-鿿＀-￯]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 0.6 + other * 0.3);
}

export interface TokenPrice {
  /** 输入（缓存未命中），元 / 百万 token */
  input: number;
  /** 输出，元 / 百万 token */
  output: number;
}

export const PRICE_SOURCE = "packages/protocol/src/token-prices.ts（DeepSeek 官网，2026-10-12 读）";

export const DEEPSEEK_PRICES: Readonly<Record<string, { peak: TokenPrice; offPeak: TokenPrice }>> = {
  "deepseek-flash": { peak: { input: 2, output: 8 }, offPeak: { input: 1, output: 4 } },
  "deepseek-v4-pro": { peak: { input: 9, output: 27 }, offPeak: { input: 4.5, output: 13.5 } },
};

export interface PlannedCall {
  purpose: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CostEstimate {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** 元；按高峰价 */
  peakYuan: number;
  /** 元；按空闲价 */
  offPeakYuan: number;
  byPurpose: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
}

export function estimateCost(model: string, calls: readonly PlannedCall[]): CostEstimate {
  const price = DEEPSEEK_PRICES[model];
  if (!price) throw new Error(`价格表里没有 ${model}（有：${Object.keys(DEEPSEEK_PRICES).join("、")}）`);
  const byPurpose: CostEstimate["byPurpose"] = {};
  let inputTokens = 0;
  let outputTokens = 0;
  for (const c of calls) {
    inputTokens += c.inputTokens;
    outputTokens += c.outputTokens;
    const p = (byPurpose[c.purpose] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
    p.calls += 1;
    p.inputTokens += c.inputTokens;
    p.outputTokens += c.outputTokens;
  }
  const yuan = (p: TokenPrice) => (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  return { model, calls: calls.length, inputTokens, outputTokens, peakYuan: yuan(price.peak), offPeakYuan: yuan(price.offPeak), byPurpose };
}
