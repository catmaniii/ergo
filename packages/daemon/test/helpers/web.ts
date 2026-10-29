// 联网搜索、读网页的替身（70 号票）：测试里一律不起浏览器、不连真网络。
// - fakeWebAccess：按给的函数回搜索结果和网页（记下每次的请求）；不给的那一样回"测试里不联网"；
// - FakeBrowser：假的浏览器驱动，按网址给页面（标题、正文、HTML、搜索结果），记下打开过的网址，测 search.ts、fetch.ts 的逻辑。
import type { BrowserDriver, BrowserPage, FetchedPage, FetchRequest, PageOptions, RawResult, ResultSelectors, SearchFound, SearchRequest, WebAccess } from "../../src/web/index.ts";
import { BrowserUnavailable, FetchFailed, SearchFailed } from "../../src/web/index.ts";

export interface FakeWebAccess extends WebAccess {
  readonly searches: SearchRequest[];
  readonly fetches: FetchRequest[];
}

/** 假的联网：search、fetch 给了就按它回（抛错照抛），没给的回"测试里不联网" */
export function fakeWebAccess(script: { search?: (q: SearchRequest) => SearchFound; fetch?: (r: FetchRequest) => FetchedPage } = {}): FakeWebAccess {
  const searches: SearchRequest[] = [];
  const fetches: FetchRequest[] = [];
  return {
    searches,
    fetches,
    async search(q) {
      searches.push(q);
      if (!script.search) throw new SearchFailed([{ engine: "ddg", reason: "测试里不联网" }]);
      return script.search(q);
    },
    async fetch(r) {
      fetches.push(r);
      if (!script.fetch) throw new FetchFailed(`没读到 ${r.url}：测试里不联网`);
      return script.fetch(r);
    },
  };
}

/** 假浏览器上的一页：打开时的 HTTP 状态（抛错就写 error）、标题、正文、HTML、搜索结果 */
export interface FakePage {
  status?: number;
  /** 打开时抛这个错（模拟超时、打不开） */
  error?: string;
  title?: string;
  body?: string;
  html?: string;
  results?: RawResult[];
}

/** 假的浏览器驱动：网址 → 页面（找不到的网址按打不开算）；unavailable 时起不来 */
export class FakeBrowser implements BrowserDriver {
  /** 打开过的网址，按先后 */
  readonly visited: string[] = [];
  /** 每次起浏览器时的设置 */
  readonly launches: PageOptions[] = [];
  /** 每次取结果时用的选择器 */
  readonly selectors: ResultSelectors[] = [];
  private readonly pages: (url: string) => FakePage | undefined;
  private readonly unavailable: string | undefined;

  constructor(pages: (url: string) => FakePage | undefined, options: { unavailable?: string } = {}) {
    this.pages = pages;
    this.unavailable = options.unavailable;
  }

  async withPage<T>(options: PageOptions, work: (page: BrowserPage) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.unavailable !== undefined) throw new BrowserUnavailable(this.unavailable);
    this.launches.push(options);
    let current: FakePage | undefined;
    const page: BrowserPage = {
      goto: async (url) => {
        this.visited.push(url);
        current = this.pages(url);
        if (!current) throw new Error(`net::ERR_NAME_NOT_RESOLVED at ${url}`);
        if (current.error !== undefined) throw new Error(current.error);
        return current.status ?? 200;
      },
      wait: async () => {},
      title: async () => current?.title ?? "",
      bodyText: async (max) => (max === undefined ? (current?.body ?? "") : (current?.body ?? "").slice(0, max)),
      html: async () => current?.html ?? "",
      results: async (selectors) => {
        this.selectors.push(selectors);
        return current?.results ?? [];
      },
      // 假的截图（140 号票）：一段写着网址和画质的字节
      screenshot: async ({ quality }) => Buffer.from(`fake-jpeg ${current ? "page" : "none"} q${quality}`),
    };
    return work(page);
  }
}
