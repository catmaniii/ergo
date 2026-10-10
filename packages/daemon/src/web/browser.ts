// 驱动浏览器的薄接口（70 号票）：联网搜索和读网页的浏览器兜底只经它碰浏览器，测试里换成假的（不起浏览器、不联网）。
// 正式的实现是 playwright-core 驱动系统装的 Chrome / Edge（不下载浏览器，路径见 browser-path.ts），照用户的 web-search skill：
// 每次用都起一个无头浏览器、开一页，用完关掉（首次起要 1–3 秒）。playwright-core 在第一次用到时才加载，不拖慢守护进程启动。
import type { Page } from "playwright-core";

/** 打开一页时的设置：浏览器标识、语言、窗口大小 */
export interface PageOptions {
  userAgent: string;
  locale: string;
  viewport?: { width: number; height: number };
}

/** 搜索结果页上一条结果怎么取：结果的容器、标题链接、摘要（CSS 选择器） */
export interface ResultSelectors {
  item: string;
  title: string;
  snippet: string;
}

/** 页面上取到的一条结果（链接还没解包） */
export interface RawResult {
  title: string;
  url: string;
  snippet: string;
}

/** 开着的一页 */
export interface BrowserPage {
  /** 打开网址，等到 DOMContentLoaded；返回 HTTP 状态（没有响应是 0）。打不开、超时抛错 */
  goto(url: string, timeoutMs: number): Promise<number>;
  /** 等一会儿（等结果渲染） */
  wait(ms: number): Promise<void>;
  title(): Promise<string>;
  /** 页面正文的文字（document.body.innerText），最多 max 个字；没有 body 是空串 */
  bodyText(max?: number): Promise<string>;
  /** 页面现在的 HTML */
  html(): Promise<string>;
  /** 按选择器在页面里取搜索结果（pickResults）：每个容器里取标题（文字）、链接（标题自己的 href，没有就用包着它的 a 的）、摘要；没有标题、链接不是 http(s) 的不要 */
  results(selectors: ResultSelectors): Promise<RawResult[]>;
}

export interface BrowserDriver {
  /** 起一个无头浏览器、开一页交给 work，用完（或 signal 中止时）关掉浏览器。浏览器起不来时抛 BrowserUnavailable */
  withPage<T>(options: PageOptions, work: (page: BrowserPage) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** 浏览器用不了（找不到、起不来）：说法直接给模型看 */
export class BrowserUnavailable extends Error {
  override readonly name = "BrowserUnavailable";
}

/** 起浏览器最多等多久（照 skill 的 20 秒） */
const LAUNCH_TIMEOUT_MS = 20_000;

/** 页面里用到的那点 DOM（守护进程的类型里没有 DOM；这几个函数是送进浏览器里跑的，类型剥离后原样序列化） */
interface PageElement {
  innerText?: string;
  href?: string;
  querySelector(selector: string): PageElement | null;
  closest(selector: string): PageElement | null;
}
interface PageDocument {
  body: PageElement | null;
  querySelectorAll(selector: string): Iterable<PageElement>;
}

/**
 * 在页面里按选择器取搜索结果（照 skill 的 extractResults 里送进浏览器的那段）：每个容器里取标题、链接、摘要。
 * 送进浏览器里跑（page.evaluate 把函数原样序列化过去），所以不能引用外面的任何东西。
 * 录下的结果页的测试也是经 playwrightPage 在真浏览器里跑它（81 号票）。
 * 和 skill 不一样的一处（81 号票）：标题元素自己没有链接时用包着它的那个 a 的链接——Google 的标题选择器 `a h3` 选中的是 h3，
 * skill 直接取 h3 的 href（没有），每条都被当成"链接不是 http(s)"丢掉，Google 永远没有结果。
 */
export function pickResults(selectors: ResultSelectors): RawResult[] {
  const doc = (globalThis as unknown as { document: PageDocument }).document;
  const out: RawResult[] = [];
  for (const el of doc.querySelectorAll(selectors.item)) {
    const a = el.querySelector(selectors.title);
    if (!a) continue;
    const link = a.href ? a : a.closest("a");
    const url = (link && link.href) || "";
    const t = (a.innerText || "").trim();
    const sEl = el.querySelector(selectors.snippet);
    const sn = sEl ? (sEl.innerText || "").trim() : "";
    if (t && /^https?:/.test(url)) out.push({ title: t, url, snippet: sn });
  }
  return out;
}

/**
 * playwright 的一页包成 BrowserPage。正式的驱动和录下结果页的测试共用这一份（81 号票）：
 * 测试给它一页拦下了所有网络请求、只回录下页面的，在真浏览器里跑和正式代码同一套取法
 */
export function playwrightPage(page: Page): BrowserPage {
  return {
    async goto(url, timeoutMs) {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      return response ? response.status() : 0;
    },
    wait: (ms) => page.waitForTimeout(ms),
    title: () => page.title(),
    bodyText: (max) =>
      page.evaluate((limit: number | null) => {
        const doc = (globalThis as unknown as { document: PageDocument }).document;
        const text = doc.body ? (doc.body.innerText ?? "") : "";
        return limit === null ? text : text.slice(0, limit);
      }, max ?? null),
    html: () => page.content(),
    results: (selectors) => page.evaluate(pickResults, selectors),
  };
}

/** playwright-core 驱动的浏览器；executablePath 每次起浏览器前现取（找不到时 missing 说明原因） */
export function playwrightDriver(input: { executablePath: () => string | undefined; missing: () => string }): BrowserDriver {
  return {
    async withPage(options, work, signal) {
      signal?.throwIfAborted();
      const executablePath = input.executablePath();
      if (!executablePath) throw new BrowserUnavailable(input.missing());
      const { chromium } = await import("playwright-core");
      let browser: Awaited<ReturnType<typeof chromium.launch>>;
      try {
        browser = await chromium.launch({ executablePath, headless: true, timeout: LAUNCH_TIMEOUT_MS });
      } catch (err) {
        throw new BrowserUnavailable(`浏览器起不来（${executablePath}）：${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
      const close = () => void browser.close().catch(() => {});
      signal?.addEventListener("abort", close, { once: true });
      try {
        const context = await browser.newContext({ userAgent: options.userAgent, locale: options.locale, ...(options.viewport ? { viewport: options.viewport } : {}) });
        return await work(playwrightPage(await context.newPage()));
      } finally {
        signal?.removeEventListener("abort", close);
        await browser.close().catch(() => {});
      }
    },
  };
}
