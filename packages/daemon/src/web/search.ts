// 联网搜索（70 号票）：照搬用户 web-search skill 的 search.mjs——浏览器真实渲染搜索结果页，不要 API key；
// 默认 DuckDuckGo，失败（被反爬拦截、没结果、结果和查询不相关、浏览器出错）依次回退 Bing、Google。每个引擎各起一次浏览器。
// skill 的选项都对齐（用户 2026-10-10 要求）：--n、--time、--engine（指定了就只用它，不回退）、--region（各引擎的地区、语言参数）、
// --tavily（Tavily 的搜索接口，要 API key，见 tavily 那几行）、--json（工具里写成 JSON，见 tools.ts）。
// 和 skill 不一样的一处：浏览器用不了（找不到、起不来）时不再一个个引擎试下去，直接报。
import type { BrowserDriver, BrowserPage, RawResult, ResultSelectors } from "./browser.ts";
import { BrowserUnavailable } from "./browser.ts";

/** 搜索结果页的浏览器标识（照 skill：桌面版 Chrome） */
export const SEARCH_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 引擎和回退的顺序：DDG → Bing → Google */
export const SEARCH_ENGINES = ["ddg", "bing", "google"] as const;
export type SearchEngine = (typeof SEARCH_ENGINES)[number];

/** 只要最近一段时间的：d 一天、w 一周、m 一个月、y 一年 */
export const SEARCH_TIMES = ["d", "w", "m", "y"] as const;
export type SearchTime = (typeof SEARCH_TIMES)[number];

export interface SearchQuery {
  query: string;
  /** 最多几条 */
  n: number;
  time?: SearchTime | undefined;
  /** 只用这个引擎（不回退）；不填按 DDG → Bing → Google */
  engine?: SearchEngine | undefined;
  /** 地区、语言（照 skill：DDG 的 kl，比如 cn-zh、us-en；Bing 取前半段当 setlang；Google 前半段当 hl、后半段当 gl） */
  region?: string | undefined;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 搜到了：哪个引擎（或 Tavily）、结果（去重、解包过的） */
export interface SearchFound {
  engine: SearchEngine | "tavily";
  results: SearchResult[];
}

/** 每个引擎都没搜到（各自的原因）；浏览器用不了另抛 BrowserUnavailable */
export class SearchFailed extends Error {
  override readonly name = "SearchFailed";
  readonly reasons: readonly { engine: SearchEngine; reason: string }[];
  constructor(reasons: readonly { engine: SearchEngine; reason: string }[]) {
    super(reasons.map((r) => `${r.engine}：${r.reason}`).join("；"));
    this.reasons = reasons;
  }
}

/** 打开搜索页最多等多久、等结果渲染多久（照 skill） */
const GOTO_TIMEOUT_MS = 20_000;
const RENDER_WAIT_MS = 1_500;

/** 搜索结果页的地址（照 skill 的 buildUrl） */
export function searchUrl(engine: SearchEngine, q: SearchQuery): string {
  const timeMap: Record<SearchTime, string> = { d: "24h", w: "168h", m: "720h", y: "8760h" };
  const [lang, country] = (q.region ?? "").split("-");
  if (engine === "bing") {
    const p = new URLSearchParams({ q: q.query });
    if (q.time) p.set("qft", `+filterui:age-lt${timeMap[q.time]}`);
    if (q.region) p.set("setlang", lang!);
    return `https://www.bing.com/search?${p.toString()}`;
  }
  if (engine === "google") {
    const p = new URLSearchParams({ q: q.query });
    if (q.time) p.set("tbs", `qdr:${q.time}`);
    if (q.region) {
      p.set("hl", lang!);
      p.set("gl", country || q.region);
    }
    return `https://www.google.com/search?${p.toString()}`;
  }
  const p = new URLSearchParams({ q: q.query, kl: q.region || "wt-wt" });
  if (q.time) p.set("df", q.time);
  return `https://duckduckgo.com/?${p.toString()}`;
}

/** Bing 的部分链接是 /ck/a 跳转（?u=<base64url>，带 a1 前缀）：解出真实地址；别的原样 */
export function unwrapUrl(href: string, engine: SearchEngine): string {
  if (engine !== "bing") return href;
  try {
    const u = new URL(href);
    if (u.hostname.includes("bing.com") && u.pathname.startsWith("/ck/a")) {
      const b = (u.searchParams.get("u") ?? "").replace(/^a1/, "");
      if (b) {
        const pad = b.length % 4 ? "=".repeat(4 - (b.length % 4)) : "";
        return Buffer.from((b + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      }
    }
  } catch {
    // 解不开就用原来的
  }
  return href;
}

/** 各引擎的结果怎么取（照 skill） */
export const RESULT_SELECTORS: Readonly<Record<SearchEngine, ResultSelectors>> = {
  bing: { item: "#b_results > li.b_algo", title: "h2 a", snippet: ".b_caption p, .b_lineclamp2, p" },
  google: { item: "div.MjjYud, div.g", title: "a h3", snippet: ".VwiC3b, [data-sncf]" },
  ddg: { item: 'li[data-layout="organic"]', title: 'h2 a[data-testid="result-title-a"], h2 a', snippet: '[data-testid="result-snippet"]' },
};

/** 取结果：按链接去重（同一条被几个容器匹配到），Bing 的跳转链接解包 */
export async function extractResults(page: Pick<BrowserPage, "results">, engine: SearchEngine): Promise<SearchResult[]> {
  const rows: RawResult[] = await page.results(RESULT_SELECTORS[engine]);
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of rows) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({ ...r, url: unwrapUrl(r.url, engine) });
  }
  return out;
}

/**
 * 结果和查询相关吗（照 skill 的质量门）：Bing 在无头浏览器下对中文查询会回降级的垃圾结果（标题对、结果错）。
 * 查询按空白切成词（两个字以上的），结果标题里含其中一个词的要有 min(2, 结果数) 条；没有够长的词时不查
 */
export function looksRelevant(rows: readonly SearchResult[], query: string): boolean {
  if (rows.length === 0) return false;
  const keys = query
    .toLowerCase()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter((k) => k.length >= 2);
  if (keys.length === 0) return true;
  const hit = rows.filter((r) => keys.some((k) => (r.title || "").toLowerCase().includes(k))).length;
  return hit >= Math.min(2, rows.length);
}

/** 被反爬拦截的页面（验证码、异常流量）：标题和正文开头里的说法 */
const BLOCKED_PAGE = /captcha|unusual traffic|robot check|验证码|安全验证|异常流量/i;

/** 用一个引擎搜一次：起浏览器、打开结果页、等渲染、看是不是被拦了、取结果，最多 n 条 */
export async function searchWithEngine(browser: BrowserDriver, engine: SearchEngine, q: SearchQuery, signal?: AbortSignal): Promise<SearchResult[]> {
  return browser.withPage(
    { userAgent: SEARCH_USER_AGENT, locale: "zh-CN", viewport: { width: 1280, height: 900 } },
    async (page) => {
      await page.goto(searchUrl(engine, q), GOTO_TIMEOUT_MS);
      await page.wait(RENDER_WAIT_MS);
      const title = await page.title().catch(() => "");
      const head = await page.bodyText(400).catch(() => "");
      if (BLOCKED_PAGE.test(`${title} ${head}`)) throw new Error(`被反爬拦截（${engine}）`);
      return (await extractResults(page, engine)).slice(0, q.n);
    },
    signal,
  );
}

/**
 * 搜索：指定了引擎就只用它；没指定按 DDG → Bing → Google 的顺序，第一个有结果、而且结果和查询相关的就用它（指定了的也过这道质量门）。
 * 浏览器用不了（找不到、起不来）不再试别的引擎，抛 BrowserUnavailable；都没搜到抛 SearchFailed（各引擎的原因）
 */
export async function webSearch(browser: BrowserDriver, q: SearchQuery, options: { signal?: AbortSignal | undefined; log?: (line: string) => void } = {}): Promise<SearchFound> {
  const reasons: { engine: SearchEngine; reason: string }[] = [];
  for (const engine of q.engine ? [q.engine] : SEARCH_ENGINES) {
    options.signal?.throwIfAborted();
    try {
      const rows = await searchWithEngine(browser, engine, q, options.signal);
      if (rows.length > 0 && looksRelevant(rows, q.query)) return { engine, results: rows };
      reasons.push({ engine, reason: rows.length > 0 ? "结果和查询不相关" : "没有结果" });
    } catch (err) {
      if (err instanceof BrowserUnavailable) throw err;
      options.signal?.throwIfAborted();
      reasons.push({ engine, reason: err instanceof Error ? err.message.split("\n")[0]! : String(err) });
    }
    options.log?.(`联网搜索：${engine} 没搜到（${reasons.at(-1)!.reason}）`);
  }
  throw new SearchFailed(reasons);
}

/** Tavily 的搜索接口（照 skill 的 searchTavily） */
export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

/** 调 Tavily 用的 POST（Node 的 fetch；测试换成假的） */
export type PostFunction = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

/** 没配 Tavily 的 key：说法直接给模型看 */
export class TavilyKeyMissing extends Error {
  override readonly name = "TavilyKeyMissing";
}

/** Tavily 没搜成（HTTP 出错、网络出错） */
export class TavilyFailed extends Error {
  override readonly name = "TavilyFailed";
}

/**
 * 用 Tavily 搜（照 skill 的 searchTavily：key 放在请求体的 api_key 里，max_results 是 n，search_depth 是 basic；
 * time、region、engine 它不管）。key 只从守护进程的环境里取（LSM 从数据目录密钥区的文件注入），没配抛 TavilyKeyMissing
 */
export async function searchTavily(post: PostFunction, key: string | undefined, q: SearchQuery, signal?: AbortSignal): Promise<SearchFound> {
  if (!key) throw new TavilyKeyMissing("没配 tavily 的 key：请在 LSM 里给二狗加环境变量 TAVILY_API_KEY（从数据目录密钥区的文件注入），或者不用 tavily");
  let res: Awaited<ReturnType<PostFunction>>;
  try {
    res = await post(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query: q.query, max_results: q.n, search_depth: "basic" }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    signal?.throwIfAborted();
    throw new TavilyFailed(`连不上 Tavily（${err instanceof Error ? err.message.split("\n")[0] : String(err)}）`);
  }
  if (!res.ok) throw new TavilyFailed(`Tavily HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const body = (await res.json()) as { results?: { title?: unknown; url?: unknown; content?: unknown }[] };
  const results = (body.results ?? []).slice(0, q.n).map((r) => ({ title: String(r.title ?? ""), url: String(r.url ?? ""), snippet: typeof r.content === "string" ? r.content : "" }));
  return { engine: "tavily", results };
}
