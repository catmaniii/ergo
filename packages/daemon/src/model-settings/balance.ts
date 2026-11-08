// 服务商余额（440）：消耗页顶上那一块、秘书的 check_balance、体检的"DeepSeek 余额"都读这一份。
// - 每个服务商一个"余额来源"（BalanceSource：用哪个 Key、怎么查一次），这票只有 DeepSeek（deepseek-balance.ts）；
//   别的服务商以后要加余额，写一个来源挂进来就行，接口、页面、体检、秘书的工具都不用改。
// - Key 只在守护进程里用：每次现取（网页上换了 Key 就用新的），不进结果、日志、事件；换了 Key（按 Key 的摘要认）上一次的结果作废。
// - 缓存：查成的在 BALANCE_CACHE_MS 内直接用（打开页面不每次都打服务商），没查成的过 BALANCE_RETRY_FAILED_MS 再查；
//   同一时间一个服务商只查一次（一起来的请求等同一次）。"刷新"马上重查，但离上一次开始查不到 BALANCE_REFRESH_GAP_MS 的不重查（防连点）。
// - 没配 Key 不查。一次最多等 BALANCE_TIMEOUT_MS，到点中止，算"超时"；出错照实记原因（Key 不对、限流、服务商出错、超时、连不上、看不懂）。
// - 查余额不花钱，不记进 token 账本。
// - cached() 只读内存里的，不查：体检读它（平时体检不联网，见 doctor/checks.ts 的 cost 档）。
// @i18n-ignore-file log：没查成的说明只进日志（页面、秘书按原因 problem 自己说）
import { createHash } from "node:crypto";
import { type BalanceProblem, nowIso, type ProviderBalance, type ProviderBalanceAmount, type ProviderBalanceView } from "@ergo/protocol";

/** 查成的余额在这么久里直接用（毫秒） */
export const BALANCE_CACHE_MS = 5 * 60_000;
/** 没查成的过这么久再查（打开页面时；"刷新"不等它） */
export const BALANCE_RETRY_FAILED_MS = 60_000;
/** 离上一次开始查不到这么久，"刷新"不重查（防连点） */
export const BALANCE_REFRESH_GAP_MS = 10_000;
/** 一次最多等多久（连上和读完一起算） */
export const BALANCE_TIMEOUT_MS = 10_000;
/** 低于多少算"余额不多了"（按币种；DeepSeek 的币种是 CNY、USD，约 7 元 = 1 美元） */
export const BALANCE_LOW_BELOW: Readonly<Record<string, number>> = Object.freeze({ CNY: 10, USD: 1.5 });

/** 查余额没成：原因和服务商回的状态码（超时、连不上没有） */
export class BalanceFailed extends Error {
  override readonly name = "BalanceFailed";
  readonly problem: BalanceProblem;
  readonly status: number | undefined;
  constructor(problem: BalanceProblem, message: string, status?: number) {
    super(message);
    this.problem = problem;
    this.status = status;
  }
}

/** 查一次查到的 */
export interface BalanceReading {
  available: boolean;
  balances: ProviderBalanceAmount[];
}

/** 一个服务商的余额来源 */
export interface BalanceSource {
  /** 服务商登记表里的 id */
  readonly provider: string;
  /** 给人看的名字 */
  readonly label: string;
  /** 开放平台的充值页（页面上"去充值"、秘书的工具说去哪充值）；没有的不给 */
  readonly topUpUrl?: string;
  /** 用哪个 Key 查（每次现取；没配是 undefined） */
  key(): string | undefined;
  /** 查一次：signal 在超时时置位。没成抛 BalanceFailed（别的错按"连不上"算） */
  query(key: string, signal: AbortSignal): Promise<BalanceReading>;
}

export interface ProviderBalanceService {
  /** 现在的余额：缓存还新就用缓存，不然查一次（配了 Key 的才查） */
  view(): Promise<ProviderBalanceView>;
  /** "刷新"：马上重查（离上一次开始查不到 BALANCE_REFRESH_GAP_MS 的不重查，回现在那一份） */
  refresh(): Promise<ProviderBalanceView>;
  /** 只读内存里的，不查（体检用） */
  cached(): ProviderBalanceView;
}

export interface ProviderBalanceOptions {
  sources: readonly BalanceSource[];
  /** 此刻（毫秒时间戳）；不给是真的时间 */
  now?: () => number;
  /** 一次最多等多久；不给是 BALANCE_TIMEOUT_MS */
  timeoutMs?: number;
  log: (line: string) => void;
}

/** 用不了了，或者认得提醒线的币种都低于提醒线 */
export function balanceLow(reading: BalanceReading, lowBelow: Readonly<Record<string, number>> = BALANCE_LOW_BELOW): boolean {
  if (!reading.available) return true;
  const known = reading.balances.filter((b) => lowBelow[b.currency.toUpperCase()] !== undefined && b.total.trim() !== "" && Number.isFinite(Number(b.total)));
  return known.length > 0 && known.every((b) => Number(b.total) < lowBelow[b.currency.toUpperCase()]!);
}

/** 一个服务商在内存里的样子（换了 Key 换一份新的，旧的那次查询写进旧的这份、没人再看） */
interface Entry {
  /** 这份对应的 Key 的摘要（不存 Key 本身） */
  fingerprint: string;
  result?: ProviderBalance["result"];
  failure?: ProviderBalance["failure"];
  /** 上一次结束（查成或没成）的时刻 */
  settledAt?: number;
  /** 上一次开始查的时刻 */
  startedAt?: number;
  inflight?: Promise<void>;
}

const fingerprintOf = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

const viewOf = (providers: ProviderBalance[]): ProviderBalanceView => ({ providers, lowBelow: { ...BALANCE_LOW_BELOW } });

export function createProviderBalances(options: ProviderBalanceOptions): ProviderBalanceService {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? BALANCE_TIMEOUT_MS;
  const entries = new Map<string, Entry>();

  /** 这个服务商现在的那份：没配 Key 是 undefined（清掉旧的），换了 Key 换一份新的 */
  const entryOf = (source: BalanceSource): { entry: Entry; key: string } | undefined => {
    const key = source.key()?.trim();
    if (!key) {
      entries.delete(source.provider);
      return undefined;
    }
    const fingerprint = fingerprintOf(key);
    let entry = entries.get(source.provider);
    if (entry?.fingerprint !== fingerprint) {
      entry = { fingerprint };
      entries.set(source.provider, entry);
    }
    return { entry, key };
  };

  /** 查一次（已经在查就等那一次） */
  const start = (source: BalanceSource, entry: Entry, key: string): Promise<void> => {
    if (entry.inflight) return entry.inflight;
    entry.startedAt = now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    const run = (async () => {
      try {
        const reading = await source.query(key, controller.signal);
        if (timedOut) throw new BalanceFailed("timeout", "超时");
        entry.result = { available: reading.available, balances: reading.balances, checkedAt: nowIso(new Date(now())), low: balanceLow(reading) };
        delete entry.failure;
      } catch (err) {
        const failed = timedOut ? new BalanceFailed("timeout", `${Math.round(timeoutMs / 1000)} 秒没回`) : err instanceof BalanceFailed ? err : new BalanceFailed("network", err instanceof Error ? err.message : String(err));
        entry.failure = { problem: failed.problem, ...(failed.status === undefined ? {} : { status: failed.status }), at: nowIso(new Date(now())) };
        // 只记服务商、原因、状态码：Key 不进日志（来源给的说明也不带 Key）
        options.log(`查 ${source.label} 余额没成（${failed.problem}${failed.status === undefined ? "" : ` ${failed.status}`}）：${failed.message}`);
      } finally {
        clearTimeout(timer);
        entry.settledAt = now();
        delete entry.inflight;
      }
    })();
    entry.inflight = run;
    return run;
  };

  /** 打开页面时要不要查：没查过、查成的过了缓存期、没查成的过了重试间隔 */
  const stale = (entry: Entry): boolean => {
    if (entry.settledAt === undefined) return true;
    const age = now() - entry.settledAt;
    return entry.failure === undefined ? age >= BALANCE_CACHE_MS : age >= BALANCE_RETRY_FAILED_MS;
  };

  const entryView = (source: BalanceSource, current: { entry: Entry } | undefined): ProviderBalance => {
    const base = { provider: source.provider, label: source.label, ...(source.topUpUrl === undefined ? {} : { topUpUrl: source.topUpUrl }) };
    if (!current) return { ...base, configured: false };
    const { entry } = current;
    const nextAt = entry.startedAt === undefined ? undefined : entry.startedAt + BALANCE_REFRESH_GAP_MS;
    return {
      ...base,
      configured: true,
      ...(entry.result === undefined ? {} : { result: entry.result }),
      ...(entry.failure === undefined ? {} : { failure: entry.failure }),
      ...(nextAt !== undefined && nextAt > now() ? { nextRefreshAt: nowIso(new Date(nextAt)) } : {}),
    };
  };

  const settle = async (force: boolean): Promise<ProviderBalanceView> => {
    const providers = await Promise.all(
      options.sources.map(async (source) => {
        const current = entryOf(source);
        if (current) {
          const { entry, key } = current;
          const tooSoon = entry.startedAt !== undefined && now() - entry.startedAt < BALANCE_REFRESH_GAP_MS;
          if (entry.inflight) await entry.inflight;
          else if (force ? !tooSoon : stale(entry)) await start(source, entry, key);
        }
        // 查的时候 Key 可能换了：按现在的 Key 给
        return entryView(source, entryOf(source));
      }),
    );
    return viewOf(providers);
  };

  return {
    view: () => settle(false),
    refresh: () => settle(true),
    cached: () => viewOf(options.sources.map((source) => entryView(source, entryOf(source)))),
  };
}
