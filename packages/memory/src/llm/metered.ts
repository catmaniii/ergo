// 给真模型套一层（192 号票，评测的"真模型"开关用）：记实际的调用次数和 token、同样的请求只问一次、失败了最多重试 2 次、总次数封顶。
// - token 照模型回应里的 usage 记（DeepSeek 的 prompt_tokens、completion_tokens），费用照 estimate.ts 的价格表算（输入按缓存未命中，往高里算），
//   每次调用按发出的时间落在高峰还是空闲时段算价（时段规则同 packages/protocol/src/token-prices.ts 的 PEAK_HOURS，法定节假日这里不管、按工作日算，往高里算）；
// - 同样的请求（用途、系统提示、内容、输出上限都一样）直接用上次的回答，不再发、不记 token：评测里好几个库的数据一样，请求也一样；
// - 失败（网络、限流、服务端错）最多重试 2 次（中间等一会儿）；还不行就记下来，交回一个空回答——推理实现把它当"解析不了"丢掉、记进 dropped，
//   评测接着跑，报告里照实写失败了几次；
// - 花费封顶（maxYuan）：发之前按"输入照字数估、输出按 maxTokens 写满"算这次最多花多少，加上已经花的超过上限就不发；
// - 总次数到了上限（maxCalls）就不再发，同样交回空回答、记下来；连着几个请求（默认 3 个）重试完都失败，也不再发（key、模型名、网络不对时别空等）。
import type { ChatModel, ChatPurpose, ChatRequest, ChatResponse } from "./chat.ts";
import { DEEPSEEK_PRICES, estimateTokens } from "./estimate.ts";

export interface MeteredChatOptions {
  /** 最多真发几次（不含缓存命中、不含重试）；不给不封顶 */
  maxCalls?: number;
  /** 失败后最多重试几次，默认 2 */
  retries?: number;
  /** 第 n 次重试前等多久（毫秒），默认 2 秒、5 秒 */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** 现在几点（算高峰还是空闲），测试注入 */
  now?: () => Date;
  /** 连着几个请求重试完都失败就不再发，默认 3 */
  maxConsecutiveFailures?: number;
  /** 最多花多少钱（元，照价格表按时段算；这次请求最坏的花费加上已经花的超过它就不发）；不给不封顶 */
  maxYuan?: number;
}

export interface MeterFailure {
  purpose: ChatPurpose;
  /** 出错信息（DeepSeekChat 已经把 key 换成 ***） */
  message: string;
  /** 这次请求试了几次 */
  attempts: number;
}

export interface MeterReport {
  model: string;
  /** 真发出去、成功拿到回答的次数 */
  calls: number;
  /** 发出去的总次数（含失败、重试） */
  attempts: number;
  /** 同样的请求直接用了上次的回答 */
  cacheHits: number;
  /** 重试以后还是失败的请求 */
  failures: MeterFailure[];
  /** 到了上限、或者连着失败停下以后没发的请求 */
  capped: number;
  /** 连着失败停下了 */
  stopped: boolean;
  inputTokens: number;
  outputTokens: number;
  byPurpose: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
  /** 几次调用落在高峰时段 */
  peakCalls: number;
  /** 照价格表、按每次调用的时段算的费用（元；价格表里没有这个模型时是 null） */
  yuan: number | null;
}

const EMPTY: ChatResponse = { content: "", usage: { inputTokens: 0, outputTokens: 0 } };
const keyOf = (r: ChatRequest) => JSON.stringify([r.purpose, r.system, r.user, r.maxTokens]);

export class MeteredChat implements ChatModel {
  readonly name: string;
  private readonly inner: ChatModel;
  private readonly options: Required<MeteredChatOptions>;
  private readonly cache = new Map<string, ChatResponse>();
  private readonly usage: { purpose: ChatPurpose; inputTokens: number; outputTokens: number; peak: boolean }[] = [];
  private attempts = 0;
  private cacheHits = 0;
  private capped = 0;
  private consecutiveFailures = 0;
  private readonly failures: MeterFailure[] = [];

  constructor(inner: ChatModel, options: MeteredChatOptions = {}) {
    this.inner = inner;
    this.name = inner.name;
    this.options = {
      maxCalls: options.maxCalls ?? Number.POSITIVE_INFINITY,
      retries: options.retries ?? 2,
      retryDelaysMs: options.retryDelaysMs ?? [2000, 5000],
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: options.now ?? (() => new Date()),
      maxConsecutiveFailures: options.maxConsecutiveFailures ?? 3,
      maxYuan: options.maxYuan ?? Number.POSITIVE_INFINITY,
    };
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const key = keyOf(request);
    const cached = this.cache.get(key);
    if (cached) {
      this.cacheHits += 1;
      return cached;
    }
    if (this.usage.length + this.failures.length >= this.options.maxCalls || this.stopped || this.overBudget(request)) {
      this.capped += 1;
      return EMPTY;
    }
    let lastError = "";
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      if (attempt > 0) await this.options.sleep(this.options.retryDelaysMs[Math.min(attempt - 1, this.options.retryDelaysMs.length - 1)] ?? 0);
      this.attempts += 1;
      try {
        const peak = isDeepSeekPeak(this.options.now());
        const response = await this.inner.complete(request);
        this.usage.push({ purpose: request.purpose, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, peak });
        this.cache.set(key, response);
        this.consecutiveFailures = 0;
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    this.failures.push({ purpose: request.purpose, message: lastError, attempts: this.options.retries + 1 });
    this.consecutiveFailures += 1;
    return EMPTY;
  }

  /** 这次请求最坏的花费（输入照字数估、输出写满 maxTokens）加上已经花的，超过上限 */
  private overBudget(request: ChatRequest): boolean {
    if (!Number.isFinite(this.options.maxYuan)) return false;
    const price = DEEPSEEK_PRICES[this.name];
    if (!price) return false;
    const p = isDeepSeekPeak(this.options.now()) ? price.peak : price.offPeak;
    const worst = (estimateTokens(request.system + request.user) * p.input + request.maxTokens * p.output) / 1_000_000;
    return this.spent() + worst > this.options.maxYuan;
  }

  /** 已经花的（元） */
  spent(): number {
    const price = DEEPSEEK_PRICES[this.name];
    if (!price) return 0;
    return this.usage.reduce((s, u) => s + (u.inputTokens * (u.peak ? price.peak : price.offPeak).input + u.outputTokens * (u.peak ? price.peak : price.offPeak).output) / 1_000_000, 0);
  }

  /** 连着失败太多次，停了 */
  get stopped(): boolean {
    return this.consecutiveFailures >= this.options.maxConsecutiveFailures;
  }

  report(): MeterReport {
    const byPurpose: MeterReport["byPurpose"] = {};
    for (const u of this.usage) {
      const p = (byPurpose[u.purpose] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
      p.calls += 1;
      p.inputTokens += u.inputTokens;
      p.outputTokens += u.outputTokens;
    }
    const inputTokens = this.usage.reduce((s, u) => s + u.inputTokens, 0);
    const outputTokens = this.usage.reduce((s, u) => s + u.outputTokens, 0);
    const yuan = DEEPSEEK_PRICES[this.name] ? this.spent() : null;
    return {
      model: this.name,
      calls: this.usage.length,
      attempts: this.attempts,
      cacheHits: this.cacheHits,
      failures: [...this.failures],
      capped: this.capped,
      stopped: this.stopped,
      inputTokens,
      outputTokens,
      byPurpose,
      peakCalls: this.usage.filter((u) => u.peak).length,
      yuan,
    };
  }
}

/**
 * DeepSeek 的高峰时段：北京时间周一至周五 9:00–12:00、14:00–18:00（照 packages/protocol/src/token-prices.ts 的 PEAK_HOURS，
 * PoC 不跨包引用，抄在这里）；其余是空闲时段（半价）。法定节假日这里不管，按工作日算（往高里算）。
 */
export function isDeepSeekPeak(at: Date): boolean {
  const local = new Date(at.getTime() + 8 * 3600_000);
  const day = local.getUTCDay();
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (day === 0 || day === 6) return false;
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}
