// 联网搜索、读网页的实现（70 号票）：两个工具只经这个接口联网，测试里整个换成假的（不起浏览器、不连真网络）。
// 正式的由 createWebAccess 拼成：搜索走浏览器（search.ts），要 tavily 的走 Tavily 的接口；读网页先直接请求、不行再走浏览器（fetch.ts）。
import type { BrowserDriver } from "./browser.ts";
import { type FetchedPage, type FetchFunction, type FetchRequest, webFetch } from "./fetch.ts";
import { type PostFunction, type SearchFound, type SearchQuery, searchTavily, webSearch } from "./search.ts";

/** 一次搜索：查询、条数、时间、引擎、地区（search.ts 的 SearchQuery），tavily 为真时走 Tavily（照 skill 的 --tavily） */
export interface SearchRequest extends SearchQuery {
  tavily?: boolean | undefined;
}

export interface WebAccess {
  /**
   * 搜索：搜到了交回引擎和结果。浏览器用不了抛 BrowserUnavailable，都没搜到抛 SearchFailed；
   * 走 Tavily 时没配 key 抛 TavilyKeyMissing，没搜成抛 TavilyFailed
   */
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchFound>;
  /** 读网页：交回给模型的文字（已截断）；都没读到抛 FetchFailed */
  fetch(request: FetchRequest, signal?: AbortSignal): Promise<FetchedPage>;
}

export function createWebAccess(deps: {
  browser: BrowserDriver;
  fetch?: FetchFunction;
  /** 调 Tavily 用的 POST；不给用 Node 的 fetch */
  post?: PostFunction;
  /** Tavily 的 key：只从守护进程的环境里取（LSM 从数据目录密钥区的文件注入，config/secrets.ts）；不给就是没配 */
  tavilyKey?: () => string | undefined;
  log: (line: string) => void;
}): WebAccess {
  const fetchFn: FetchFunction = deps.fetch ?? ((url, init) => fetch(url, init));
  const post: PostFunction = deps.post ?? ((url, init) => fetch(url, init));
  return {
    search: ({ tavily, ...query }, signal) => (tavily ? searchTavily(post, deps.tavilyKey?.(), query, signal) : webSearch(deps.browser, query, { signal, log: deps.log })),
    fetch: (request, signal) => webFetch({ fetch: fetchFn, browser: deps.browser }, request, { signal, log: deps.log }),
  };
}
