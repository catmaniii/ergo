// DeepSeek 的联网搜索（Search）、读网页（Fetch）接口（154 号票，文档 https://api-docs.deepseek.com/zh-cn/guides/search/ ，2026-10-18 读）：
// 联网搜索、读网页的一种方式，和浏览器、Tavily 并列（用户 2026-10-18 定："作为一种选择，不作为唯一方式"）；用哪种由 access.ts 定。
// - 接口：POST <base>/v1/tools/search（query 1–128 字、count 1–50），POST <base>/v1/tools/fetch（url），回 Markdown 正文；
//   Bearer 用 DeepSeek 的 API key——和模型共用同一份（环境变量 DEEPSEEK_API_KEY，LSM 从数据目录密钥区注入，每次现取）；
// - 选项映射（deepseekQuery）：n → count（最多 50），time → 查询后面加 after:日期，region → lang:（对不上的不加），
//   查询加上这些以后超过 128 字不发请求（交给调用方换别的方式）；
// - 出错照文档：兼容 OpenAI 的 error 对象。408、429、5xx 等一下重试，最多两次；402 余额不足不重试（记下时间，设置页上看得到，
//   之后成功一次就清掉）；别的 4xx 不重试；Fetch 的 403 是被安全策略拒绝、404 是没取到可用的正文。没结果、没正文也算没成
//   （DeepSeek 只对 HTTP 200 且有结果的计费，所以"成了"就是"计费了"，记账照它）；
// - 限速：Search、Fetch 各自账号级 QPS 5（和 key、模型并发无关），这里各一个限速器，守护进程里只有一个客户端，所有 agent 共用；
//   Fetch 另有按目标域名的限速（DeepSeek 那边回 429，照样重试）。
// @i18n-ignore-file model：DeepSeek 出错的原因进联网工具的结果，给模型看；KIND_LABEL 只在日志里用（173 号票）
import { setTimeout as delay } from "node:timers/promises";
import { nowIso } from "@ergo/protocol";
import { providerOf } from "../model-settings/providers.ts";
import type { PostFunction, SearchFound, SearchQuery, SearchResult, SearchTime } from "./search.ts";

/** 正式的地址（测试里换成本机假服务的） */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_SEARCH_PATH = "/v1/tools/search";
export const DEEPSEEK_FETCH_PATH = "/v1/tools/fetch";

/** 查询最多多少字（Unicode 字符） */
export const DEEPSEEK_QUERY_MAX = 128;
/** 一次最多几条 */
export const DEEPSEEK_COUNT_MAX = 50;
/** 账号级的限速：Search、Fetch 各每秒 5 次 */
export const DEEPSEEK_QPS = 5;
/** 408、429、5xx 最多再试几次 */
export const DEEPSEEK_MAX_RETRIES = 2;
/** 重试前等多久（第一次、第二次）；响应带 Retry-After（秒，最多 10 秒）时照它 */
export const DEEPSEEK_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000];
/** 一次请求最多等多久（连上和读完一起算）：搜索 20 秒，读网页要替我们去取网页，30 秒 */
export const DEEPSEEK_SEARCH_TIMEOUT_MS = 20_000;
export const DEEPSEEK_FETCH_TIMEOUT_MS = 30_000;

/** 搜索结果里标"优质"的相关度（rerank_score，0–3）、标"权威"的权威度（authority，0–4，-1 不知道） */
export const DEEPSEEK_GOOD_SCORE = 1.5;
export const DEEPSEEK_AUTHORITY_HIGH = 3;

/** 没成的原因（调用方据此决定换不换路、怎么说） */
export type DeepSeekProblem = "no_key" | "too_long" | "balance" | "key_invalid" | "rate_limited" | "server" | "timeout" | "network" | "rejected" | "no_content" | "empty" | "bad_request";

/** DeepSeek 没成：说法直接给模型看（也写进"这次用的是浏览器"的说明） */
export class DeepSeekFailed extends Error {
  override readonly name = "DeepSeekFailed";
  readonly problem: DeepSeekProblem;
  readonly status: number | undefined;
  constructor(problem: DeepSeekProblem, message: string, status?: number) {
    super(message);
    this.problem = problem;
    this.status = status;
  }
}

/** 一个账号级的限速器：一秒里最多 perSecond 次，多出来的按先后排着等 */
export interface RateLimiter {
  take(signal?: AbortSignal): Promise<void>;
}

/** 时钟（毫秒）和等一会儿（可中止）：测试里换成假的 */
export interface LimiterClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const realClock: LimiterClock = { now: () => Date.now(), sleep: (ms, signal) => delay(ms, undefined, signal ? { signal } : {}) };

/** 滑动窗口：记下最近 perSecond 次开始的时间，满了就等到最早那次满一秒；排着的一个接一个放行 */
export function createRateLimiter(options: { perSecond: number } & Partial<LimiterClock>): RateLimiter {
  const now = options.now ?? realClock.now;
  const sleep = options.sleep ?? realClock.sleep;
  const starts: number[] = [];
  let tail: Promise<void> = Promise.resolve();
  return {
    take(signal) {
      const turn = tail.then(async () => {
        for (;;) {
          signal?.throwIfAborted();
          const t = now();
          while (starts.length > 0 && t - starts[0]! >= 1000) starts.shift();
          if (starts.length < options.perSecond) {
            starts.push(t);
            return;
          }
          await sleep(starts[0]! + 1000 - t, signal);
        }
      });
      tail = turn.catch(() => undefined);
      return turn;
    },
  };
}

/** 本地日期 YYYY-MM-DD */
function dateOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** time（一天、一周、一个月、一年）往前推到哪天 */
function afterDate(time: SearchTime, now: Date): string {
  const d = new Date(now.getTime());
  if (time === "d") d.setDate(d.getDate() - 1);
  else if (time === "w") d.setDate(d.getDate() - 7);
  else if (time === "m") d.setMonth(d.getMonth() - 1);
  else d.setFullYear(d.getFullYear() - 1);
  return dateOf(d);
}

/** 认得的语言代码（lang: 用的） */
const LANGUAGES = new Set(["zh", "en", "ja", "ko", "fr", "de", "es", "ru", "pt", "it", "ar", "nl", "sv", "pl", "tr", "vi", "th", "id", "ms", "hi", "uk", "cs", "el", "he", "da", "fi", "no", "hu", "ro"]);

/**
 * region（照 skill：DDG 的写法"地区-语言"，比如 cn-zh、us-en；Bing、Google 那种"语言-地区"的 zh-CN、en-us 也认）里的语言：
 * 后半段是语言就用它，不然前半段是语言就用它，都不是（wt-wt 这种）不加
 */
export function deepseekLang(region: string): string | undefined {
  const parts = region.toLowerCase().split(/[-_]/);
  if (parts.length >= 2 && LANGUAGES.has(parts[1]!)) return parts[1];
  return LANGUAGES.has(parts[0]!) ? parts[0] : undefined;
}

/** 发给 DeepSeek 的查询：原来的查询词，time 加 after:日期，region 加 lang:（查询里自己写了的不再加） */
export function deepseekQuery(q: SearchQuery, now: Date): string {
  const parts = [q.query.trim()];
  if (q.time && !/(^|\s)after:/i.test(q.query)) parts.push(`after:${afterDate(q.time, now)}`);
  const lang = q.region ? deepseekLang(q.region) : undefined;
  if (lang && !/(^|\s)lang:/i.test(q.query)) parts.push(`lang:${lang}`);
  return parts.join(" ");
}

/** DeepSeek 搜索结果的一条（文档里的字段；site_icon、content 原样留在 raw 里） */
interface RawSearchResult {
  rerank_score?: unknown;
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  summary?: unknown;
  site_name?: unknown;
  date?: unknown;
  authority?: unknown;
}

/** 字符串去掉首尾空白；不是字符串（null 这些）是空串 */
const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** 换成联网搜索的一条结果：没有的、不知道的（null、空串、权威度 -1）不带 */
function toResult(r: RawSearchResult): SearchResult {
  const summary = trimmed(r.summary);
  const date = trimmed(r.date).slice(0, 10);
  const site = trimmed(r.site_name);
  return {
    title: trimmed(r.title),
    url: trimmed(r.url),
    snippet: trimmed(r.snippet),
    ...(summary ? { summary } : {}),
    ...(date ? { date } : {}),
    ...(site ? { site } : {}),
    ...(typeof r.rerank_score === "number" ? { score: r.rerank_score } : {}),
    ...(typeof r.authority === "number" && r.authority >= 0 ? { authority: r.authority } : {}),
  };
}

/** DeepSeek 的 key 从哪个环境变量来（模型服务商登记表里 deepseek 那一项，和模型共用） */
const DEEPSEEK_KEY_ENV = providerOf("deepseek")?.keyEnv ?? "DEEPSEEK_API_KEY";
const DEEPSEEK_SECRET_FILE = providerOf("deepseek")?.secretFile ?? "secrets/deepseek-api-key.txt";

export interface DeepSeekTools {
  /** 配了 key 没有（现取） */
  available(): boolean;
  /** 搜一次：回 engine 是 deepseek 的结果（raw 是原样的字段，query 是实际发出去的查询）；没成抛 DeepSeekFailed */
  search(q: SearchQuery, signal?: AbortSignal): Promise<SearchFound>;
  /** 读一个网页：回标题和 Markdown 正文；没成抛 DeepSeekFailed */
  fetch(url: string, signal?: AbortSignal): Promise<{ title: string; content: string }>;
  /** 最近一次回"余额不足"（402）的时间（协议时间）；之后成功过一次就是 undefined */
  balanceLowAt(): string | undefined;
}

export interface DeepSeekToolsOptions {
  /** DeepSeek 的 key（每次现取；没配是 undefined） */
  key: () => string | undefined;
  /** 不给是正式的 https://api.deepseek.com（测试里是本机的假服务） */
  baseUrl?: string | undefined;
  /** 发请求用的 POST；不给用 Node 的 fetch */
  post?: PostFunction;
  /** 现在（after: 的日期、余额不足的时间）；不给是真的时间 */
  now?: () => Date;
  /** 限速器用的时钟；不给是真的 */
  clock?: LimiterClock;
  /** 重试前等多久；不给是 DEEPSEEK_RETRY_DELAYS_MS */
  retryDelaysMs?: readonly number[];
  timeouts?: { searchMs: number; fetchMs: number };
  log: (line: string) => void;
}

type Kind = "search" | "fetch";
const KIND_LABEL: Record<Kind, string> = { search: "联网搜索", fetch: "读网页" };

/** 出错响应里 DeepSeek 写的原因（error.message），取不到用响应开头 */
function errorMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string" && body.error.message) return body.error.message.slice(0, 200);
  } catch {
    // 不是 JSON：用开头
  }
  return text.trim().slice(0, 200);
}

/** 不再重试时，状态码换成原因和说法 */
function failedOf(kind: Kind, status: number, message: string, retried: boolean): DeepSeekFailed {
  const http = `HTTP ${status}${message ? `：${message}` : ""}`;
  const again = retried ? `，重试 ${DEEPSEEK_MAX_RETRIES} 次还是不行` : "";
  if (status === 402) return new DeepSeekFailed("balance", `DeepSeek 余额不足（${http}）`, status);
  if (status === 401) return new DeepSeekFailed("key_invalid", `DeepSeek 的 key 不对（${http}）`, status);
  if (status === 429) return new DeepSeekFailed("rate_limited", `DeepSeek 限速（${http}）${again}`, status);
  if (status === 408) return new DeepSeekFailed("timeout", `DeepSeek 读请求超时（${http}）${again}`, status);
  if (status >= 500) return new DeepSeekFailed("server", `DeepSeek 服务出错（${http}）${again}`, status);
  if (kind === "fetch" && status === 403) return new DeepSeekFailed("rejected", `被 DeepSeek 的安全策略拒绝（${http}）`, status);
  if (kind === "fetch" && status === 404) return new DeepSeekFailed("no_content", `DeepSeek 没取到可用的正文（${http}）`, status);
  return new DeepSeekFailed("bad_request", `DeepSeek 不收这个请求（${http}）`, status);
}

/** Retry-After（秒）：有就照它（最多 10 秒），没有用默认的 */
function retryDelay(header: string | null | undefined, fallback: number): number {
  const seconds = header ? Number(header) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 10) * 1000 : fallback;
}

export function createDeepSeekTools(options: DeepSeekToolsOptions): DeepSeekTools {
  const base = (options.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, "");
  const post: PostFunction = options.post ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? realClock;
  const delays = options.retryDelaysMs ?? DEEPSEEK_RETRY_DELAYS_MS;
  const timeouts = options.timeouts ?? { searchMs: DEEPSEEK_SEARCH_TIMEOUT_MS, fetchMs: DEEPSEEK_FETCH_TIMEOUT_MS };
  const limiters: Record<Kind, RateLimiter> = { search: createRateLimiter({ perSecond: DEEPSEEK_QPS, ...clock }), fetch: createRateLimiter({ perSecond: DEEPSEEK_QPS, ...clock }) };
  let balanceLowAt: string | undefined;
  const key = () => options.key()?.trim() || undefined;

  /** 没成：记一行日志再抛 */
  const fail = (kind: Kind, err: DeepSeekFailed): never => {
    options.log(`DeepSeek ${KIND_LABEL[kind]}：${err.message}`);
    throw err;
  };

  /** 发一次请求（限速、超时、408 / 429 / 5xx 重试），回解析好的 JSON */
  const call = async (kind: Kind, body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<unknown> => {
    const k = key();
    if (!k) {
      return fail(kind, new DeepSeekFailed("no_key", `没配 DeepSeek 的 key（环境变量 ${DEEPSEEK_KEY_ENV}，和模型共用；LSM 从数据目录密钥区的 ${DEEPSEEK_SECRET_FILE} 注入）`));
    }
    const url = `${base}${kind === "search" ? DEEPSEEK_SEARCH_PATH : DEEPSEEK_FETCH_PATH}`;
    const timeoutMs = kind === "search" ? timeouts.searchMs : timeouts.fetchMs;
    for (let attempt = 0; ; attempt++) {
      await limiters[kind].take(signal);
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let status: number;
      let ok: boolean;
      let text: string;
      let retryAfter: string | null | undefined;
      try {
        const res = await post(url, { method: "POST", headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: combined });
        ({ status, ok } = res);
        retryAfter = res.headers?.get("retry-after");
        text = await res.text();
      } catch (err) {
        signal?.throwIfAborted();
        if (timeout.aborted) return fail(kind, new DeepSeekFailed("timeout", `DeepSeek 没在 ${Math.max(1, Math.round(timeoutMs / 1000))} 秒内回（超时）`));
        const cause = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message).split("\n")[0] : String(err);
        return fail(kind, new DeepSeekFailed("network", `连不上 DeepSeek（${cause}）`));
      }
      if (ok) {
        balanceLowAt = undefined;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return fail(kind, new DeepSeekFailed("server", `DeepSeek 回的不是 JSON（HTTP ${status}）`, status));
        }
      }
      const retryable = status === 408 || status === 429 || status >= 500;
      if (retryable && attempt < DEEPSEEK_MAX_RETRIES) {
        const wait = retryDelay(retryAfter, delays[attempt] ?? delays.at(-1) ?? 0);
        options.log(`DeepSeek ${KIND_LABEL[kind]}：HTTP ${status}，${wait} 毫秒后重试（第 ${attempt + 1} 次）`);
        if (wait > 0) await clock.sleep(wait, signal);
        continue;
      }
      const failed = failedOf(kind, status, errorMessage(text), retryable);
      if (failed.problem === "balance") balanceLowAt = nowIso(now());
      return fail(kind, failed);
    }
  };

  return {
    available: () => key() !== undefined,
    async search(q, signal) {
      const query = deepseekQuery(q, now());
      if ([...query].length > DEEPSEEK_QUERY_MAX) return fail("search", new DeepSeekFailed("too_long", `查询加上时间、语言的条件后超过 ${DEEPSEEK_QUERY_MAX} 字`));
      const data = (await call("search", { query, count: Math.min(Math.max(1, q.n), DEEPSEEK_COUNT_MAX) }, signal)) as { results?: unknown };
      const raw = (Array.isArray(data.results) ? data.results : []).slice(0, q.n) as RawSearchResult[];
      if (raw.length === 0) return fail("search", new DeepSeekFailed("empty", "DeepSeek 没搜到结果"));
      return { engine: "deepseek", query, results: raw.map(toResult), raw };
    },
    async fetch(url, signal) {
      const data = (await call("fetch", { url }, signal)) as { title?: unknown; content?: unknown };
      const content = typeof data.content === "string" ? data.content : "";
      if (!content.trim()) return fail("fetch", new DeepSeekFailed("no_content", "DeepSeek 没取到正文"));
      return { title: typeof data.title === "string" ? data.title : "", content };
    },
    balanceLowAt: () => balanceLowAt,
  };
}
