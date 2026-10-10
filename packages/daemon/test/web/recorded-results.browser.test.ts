// 录下的结果页（81 号票）：2026-10-10 搜"Node.js 最新版本"，DuckDuckGo、Bing、Google 各录一页（test/fixtures/web/）。
// **要本机的浏览器**：在真浏览器里打开录下的页面，按正式代码同一套取法（playwrightPage → pickResults）取结果——
// 浏览器按二狗同样的顺序找（web/browser-path.ts），找不到（比如没有浏览器的 CI）每一条都跳过，原因写进测试报告。
// 不连真网络：浏览器的所有请求都被拦下，页面本身回录下的 HTML，别的一律中止。
// 摘要为空的根因：DDG 的摘要容器改成了 data-result="snippet"，skill 认的 data-testid="result-snippet" 一个都选不中；
// Google 的标题选择器 a h3 选中的是 h3，skill 取 h3 的 href（没有），每条都被丢掉，一条结果都没有。
import { readFileSync } from "node:fs";
import os from "node:os";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type BrowserDriver,
  createBrowserLocator,
  createWebAccess,
  playwrightPage,
  RESULT_SELECTORS,
  type ResultSelectors,
  type SearchEngine,
  SEARCH_USER_AGENT,
  searchResultText,
  searchUrl,
  webSearch,
} from "../../src/web/index.ts";

const QUERY = "Node.js 最新版本";
const HOSTS: Record<string, SearchEngine> = { "duckduckgo.com": "ddg", "www.bing.com": "bing", "www.google.com": "google" };
const recorded = (engine: SearchEngine) => readFileSync(new URL(`../fixtures/web/${engine}.html`, import.meta.url), "utf8");

const executable = createBrowserLocator({ homeDir: os.homedir(), env: process.env, log: () => undefined }).path();
const SKIP_NOTE = "本机找不到 Chrome / Edge：录下的结果页要在真浏览器里跑正式的取法，跳过";

/**
 * 测试用的驱动：共用一个浏览器，每次开一个新的上下文（浏览器标识、语言、窗口照正式的）；所有请求都拦下——
 * 打开页面的那一个请求按 pages 回 HTML（给 undefined 就中止），别的（脚本、图片……）一律中止。页面是死的，不用等渲染
 */
function recordedDriver(browser: Browser, pages: (url: string) => string | undefined): BrowserDriver & { visited: string[] } {
  const visited: string[] = [];
  return {
    visited,
    async withPage(options, work) {
      const context = await browser.newContext({ userAgent: options.userAgent, locale: options.locale, ...(options.viewport ? { viewport: options.viewport } : {}), serviceWorkers: "block" });
      await context.route("**/*", (route) => {
        const request = route.request();
        const html = request.resourceType() === "document" ? pages(request.url()) : undefined;
        if (request.resourceType() === "document") visited.push(request.url());
        return html === undefined ? route.abort() : route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
      });
      try {
        return await work({ ...playwrightPage(await context.newPage()), wait: async () => {} });
      } finally {
        await context.close();
      }
    },
  };
}

describe("录下的结果页（要本机的 Chrome / Edge，找不到时跳过）", () => {
  let browser: Browser;
  beforeAll(async () => {
    if (!executable) return;
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ executablePath: executable, headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  // 没有浏览器时每一条都跳过，原因写进测试报告
  beforeEach((ctx) => {
    ctx.skip(!executable, SKIP_NOTE);
  });

  /** 三个引擎的地址都回录下的那一页 */
  const engines = () => recordedDriver(browser, (url) => recorded(HOSTS[new URL(url).hostname]!));

  /** 在一页 HTML 上按给的选择器取结果（不经去重、解包）：url 是这一页的地址 */
  const pick = (html: string, url: string, selectors: ResultSelectors) =>
    recordedDriver(browser, (u) => (u === url ? html : undefined)).withPage({ userAgent: SEARCH_USER_AGENT, locale: "zh-CN" }, async (page) => {
      await page.goto(url, 10_000);
      return page.results(selectors);
    });

  describe("三个引擎的结果都带摘要", () => {
    it.each(["ddg", "bing", "google"] as const)("%s：取满 8 条，每条都有标题、http(s) 链接、摘要", async (engine) => {
      const found = await webSearch(engines(), { query: QUERY, n: 8, engine });
      expect(found.engine).toBe(engine);
      expect(found.results).toHaveLength(8);
      for (const r of found.results) {
        expect(r.title).not.toBe("");
        expect(r.url).toMatch(/^https?:\/\//);
        expect(r.snippet).not.toBe("");
      }
    });

    it("DDG：链接是结果自己的，摘要是结果下面那段话", async () => {
      const found = await webSearch(engines(), { query: QUERY, n: 8, engine: "ddg" });
      expect(found.results[0]).toEqual({
        title: "Node.js — 下载 Node.js®",
        url: "https://nodejs.org/zh-cn/download",
        snippet: "Node.js® is a free, open-source, cross-platform JavaScript runtime environment that lets developers create servers, web apps, command line tools and scripts.",
      });
    });

    it("Bing：跳转链接解包成真实地址，摘要照旧取得到（藏起来的\"阅读更多\"不算进去）", async () => {
      const found = await webSearch(engines(), { query: QUERY, n: 8, engine: "bing" });
      expect(found.results[0]).toEqual({
        title: "Node.js — Run JavaScript Everywhere",
        url: "https://nodejs.org/",
        snippet: "Node.js® is a free, open-source, cross-platform JavaScript runtime environment that lets developers create servers, web apps, …",
      });
      expect(found.results.filter((r) => r.url.includes("bing.com/ck/"))).toEqual([]);
    });

    it("Google：链接取包着标题的那个 a（Google 的跳转链接，打开后转到真实地址），摘要是结果下面那段话", async () => {
      const found = await webSearch(engines(), { query: QUERY, n: 8, engine: "google" });
      expect(found.results[0]!.title).toBe("下载Node.js");
      expect(found.results[0]!.url).toMatch(/^https:\/\/www\.google\.com\/goto\?url=/);
      expect(found.results[0]!.snippet).toContain("nvm install 24");
    });

    it("不指定引擎：DDG 第一个就用它，给模型看的结果里每条都有摘要那一行", async () => {
      const driver = engines();
      const found = await createWebAccess({ browser: driver, log: () => undefined }).search({ query: QUERY, n: 5 });
      expect(found.engine).toBe("ddg");
      expect(driver.visited.map((u) => new URL(u).hostname)).toEqual(["duckduckgo.com"]);
      const blocks = searchResultText(QUERY, found).split("\n\n").slice(1);
      expect(blocks).toHaveLength(5);
      for (const block of blocks) expect(block.split("\n")[2]!.trim()).not.toBe("");
    });
  });

  describe("摘要为空的根因（照 skill 的取法在录下的页面上跑）", () => {
    it('DDG：skill 认的 data-testid="result-snippet" 选不中任何摘要；加上 data-result="snippet" 才取得到', async () => {
      const url = searchUrl("ddg", { query: QUERY, n: 8 });
      const old = await pick(recorded("ddg"), url, { ...RESULT_SELECTORS.ddg, snippet: '[data-testid="result-snippet"]' });
      expect(old.length).toBeGreaterThanOrEqual(8);
      expect(old.filter((r) => r.snippet !== "")).toEqual([]);
      const now = await pick(recorded("ddg"), url, RESULT_SELECTORS.ddg);
      expect(now.filter((r) => r.snippet === "")).toEqual([]);
    });

    it("Google：标题选择器选中的 h3 自己没有链接，用包着它的 a 的；页面上的结果都取得到", async () => {
      const tiny = '<div class="g"><a href="https://x.example/a"><h3>标题</h3><cite>x.example</cite></a><div class="VwiC3b">摘要</div></div>';
      expect(await pick(tiny, "https://www.google.com/search?q=x", RESULT_SELECTORS.google)).toEqual([{ title: "标题", url: "https://x.example/a", snippet: "摘要" }]);
      expect((await pick(recorded("google"), searchUrl("google", { query: QUERY, n: 8 }), RESULT_SELECTORS.google)).length).toBeGreaterThanOrEqual(8);
    });

    it("标题自己就是链接的（Bing、DDG）照旧取它自己的 href；没有链接、链接不是 http(s) 的照旧不要", async () => {
      const html =
        '<ol id="b_results"><li class="b_algo"><h2><a href="https://a.example/">甲</a></h2><p>摘要甲</p></li>' +
        '<li class="b_algo"><h2>没有链接</h2><p>x</p></li>' +
        '<li class="b_algo"><h2><a href="javascript:void(0)">乙</a></h2><p>y</p></li></ol>';
      expect(await pick(html, "https://www.bing.com/search?q=x", RESULT_SELECTORS.bing)).toEqual([{ title: "甲", url: "https://a.example/", snippet: "摘要甲" }]);
    });
  });
});
