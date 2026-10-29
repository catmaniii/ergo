// 联网搜索的逻辑（70 号票，照搬用户 web-search skill 的 search.mjs）：假的浏览器驱动，不起浏览器、不联网。
// 回退顺序 DDG → Bing → Google；没结果、结果和查询不相关、被反爬拦截、打不开都换下一个；浏览器用不了直接报；Bing 跳转链接解包；
// 指定引擎就只用它；地区照 skill 的写法进各引擎的地址；Tavily 走假的 POST（不联网、key 是假的）。
import { describe, expect, it } from "vitest";
import {
  BrowserUnavailable,
  createWebAccess,
  looksRelevant,
  type PostFunction,
  RESULT_SELECTORS,
  SearchFailed,
  searchTavily,
  searchUrl,
  TAVILY_SEARCH_URL,
  TavilyFailed,
  TavilyKeyMissing,
  unwrapUrl,
  webSearch,
} from "../../src/web/index.ts";
import { FakeBrowser, type FakePage } from "../helpers/web.ts";

const hostOf = (url: string) => new URL(url).hostname;
const results = (...titles: string[]) => titles.map((t, i) => ({ title: t, url: `https://site${i}.example/${i}`, snippet: `摘要 ${i}` }));

/** 按引擎给页面：ddg、bing、google 各一页 */
function engines(pages: Partial<Record<"ddg" | "bing" | "google", FakePage>>): FakeBrowser {
  return new FakeBrowser((url) => {
    const host = hostOf(url);
    if (host === "duckduckgo.com") return pages.ddg;
    if (host === "www.bing.com") return pages.bing;
    if (host === "www.google.com") return pages.google;
    return undefined;
  });
}

describe("搜索结果页的地址", () => {
  it("照 skill：DDG 带 kl=wt-wt，时间用 df；Bing 用 qft；Google 用 tbs", () => {
    expect(searchUrl("ddg", { query: "二狗 天气", n: 8 })).toBe("https://duckduckgo.com/?q=%E4%BA%8C%E7%8B%97+%E5%A4%A9%E6%B0%94&kl=wt-wt");
    expect(searchUrl("ddg", { query: "x", n: 8, time: "w" })).toBe("https://duckduckgo.com/?q=x&kl=wt-wt&df=w");
    expect(searchUrl("bing", { query: "x", n: 8, time: "d" })).toBe("https://www.bing.com/search?q=x&qft=%2Bfilterui%3Aage-lt24h");
    expect(searchUrl("google", { query: "x", n: 8, time: "y" })).toBe("https://www.google.com/search?q=x&tbs=qdr%3Ay");
    expect(searchUrl("google", { query: "x", n: 8 })).toBe("https://www.google.com/search?q=x");
  });

  it("地区照 skill：DDG 的 kl 原样；Bing 取前半段当 setlang；Google 前半段当 hl、后半段当 gl（没有后半段用整个）", () => {
    expect(searchUrl("ddg", { query: "x", n: 8, region: "cn-zh" })).toBe("https://duckduckgo.com/?q=x&kl=cn-zh");
    expect(searchUrl("bing", { query: "x", n: 8, region: "zh-CN" })).toBe("https://www.bing.com/search?q=x&setlang=zh");
    expect(searchUrl("google", { query: "x", n: 8, region: "en-us", time: "m" })).toBe("https://www.google.com/search?q=x&tbs=qdr%3Am&hl=en&gl=us");
    expect(searchUrl("google", { query: "x", n: 8, region: "fr" })).toBe("https://www.google.com/search?q=x&hl=fr&gl=fr");
  });
});

describe("Bing 的跳转链接", () => {
  it("/ck/a?u=a1<base64url> 解出真实地址；别的原样", () => {
    const real = "https://example.com/中文?a=1&b=2";
    const u = `a1${Buffer.from(real, "utf8").toString("base64url")}`;
    expect(unwrapUrl(`https://www.bing.com/ck/a?!&&p=abc&u=${u}&ntb=1`, "bing")).toBe(real);
    expect(unwrapUrl("https://example.com/x", "bing")).toBe("https://example.com/x");
    expect(unwrapUrl(`https://www.bing.com/ck/a?u=${u}`, "ddg")).toBe(`https://www.bing.com/ck/a?u=${u}`);
  });
});

describe("相关性（照 skill 的质量门）", () => {
  it("标题含查询里两个字以上的词的要有 min(2, 条数) 条；没有够长的词不查", () => {
    expect(looksRelevant(results("Node 22 发布", "Node 文档", "别的"), "node 22")).toBe(true);
    expect(looksRelevant(results("毫不相干", "也不相干"), "node release")).toBe(false);
    expect(looksRelevant(results("Node 文档", "别的"), "node release")).toBe(false);
    expect(looksRelevant(results("Node 文档"), "node release")).toBe(true);
    expect(looksRelevant(results("随便"), "a b")).toBe(true);
    expect(looksRelevant([], "x")).toBe(false);
  });
});

describe("搜索", () => {
  it("DDG 有相关的结果就用它：按链接去重，最多 n 条，浏览器照 skill 的标识和语言起", async () => {
    const rows = [...results("二狗 天气 一", "二狗 天气 二", "二狗 天气 三"), { title: "二狗 天气 重复", url: "https://site0.example/0", snippet: "" }];
    const browser = engines({ ddg: { title: "DuckDuckGo", results: rows } });
    const found = await webSearch(browser, { query: "二狗 天气", n: 2 });
    expect(found.engine).toBe("ddg");
    expect(found.results.map((r) => r.title)).toEqual(["二狗 天气 一", "二狗 天气 二"]);
    expect(browser.visited.map(hostOf)).toEqual(["duckduckgo.com"]);
    expect(browser.selectors).toEqual([RESULT_SELECTORS.ddg]);
    expect(browser.launches[0]).toMatchObject({ locale: "zh-CN", viewport: { width: 1280, height: 900 } });
    expect(browser.launches[0]!.userAgent).toContain("Chrome/131");
  });

  it("DDG 没结果、Bing 结果不相关：回退到 Google；Bing 的跳转链接解包", async () => {
    const real = "https://docs.example.com/node";
    const browser = engines({
      ddg: { results: [] },
      bing: { results: results("完全无关", "也无关") },
      google: { results: [{ title: "Node 文档", url: real, snippet: "s" }, ...results("Node 版本")] },
    });
    const logs: string[] = [];
    const found = await webSearch(browser, { query: "node docs", n: 8 }, { log: (l) => logs.push(l) });
    expect(found.engine).toBe("google");
    expect(found.results[0]!.url).toBe(real);
    expect(browser.visited.map(hostOf)).toEqual(["duckduckgo.com", "www.bing.com", "www.google.com"]);
    expect(logs.join("\n")).toMatch(/ddg 没搜到（没有结果）[\s\S]*bing 没搜到（结果和查询不相关）/);
  });

  it("被反爬拦截（验证码、异常流量）、打不开：换下一个", async () => {
    const browser = engines({
      ddg: { title: "Please complete the CAPTCHA", results: results("x y") },
      bing: { body: "我们的系统检测到您的计算机网络中存在异常流量", results: results("x y") },
      google: { error: "Timeout 20000ms exceeded" },
    });
    const err = await webSearch(browser, { query: "x y", n: 8 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchFailed);
    expect((err as SearchFailed).reasons).toEqual([
      { engine: "ddg", reason: "被反爬拦截（ddg）" },
      { engine: "bing", reason: "被反爬拦截（bing）" },
      { engine: "google", reason: "Timeout 20000ms exceeded" },
    ]);
  });

  it("浏览器用不了：不再试别的引擎，照原样报出（说法给模型看）", async () => {
    const browser = new FakeBrowser(() => undefined, { unavailable: "找不到浏览器（Chrome 或 Edge）。在数据目录的配置里写 web.browserPath" });
    await expect(webSearch(browser, { query: "x", n: 8 })).rejects.toBeInstanceOf(BrowserUnavailable);
    expect(browser.visited).toEqual([]);
  });

  it("指定了引擎：只用它，不回退；结果不相关照样算没搜到", async () => {
    const browser = engines({ ddg: { results: results("x y 一", "x y 二") }, google: { results: results("毫不相干", "也不相干") } });
    const err = await webSearch(browser, { query: "node release", n: 8, engine: "google" }).catch((e: unknown) => e);
    expect((err as SearchFailed).reasons).toEqual([{ engine: "google", reason: "结果和查询不相关" }]);
    expect(browser.visited.map(hostOf)).toEqual(["www.google.com"]);
    const bing = engines({ bing: { results: results("x y 一", "x y 二") } });
    expect((await webSearch(bing, { query: "x y", n: 8, engine: "bing", region: "zh-CN" })).engine).toBe("bing");
    expect(bing.visited).toEqual(["https://www.bing.com/search?q=x+y&setlang=zh"]);
  });

  it("中止了：不再往下搜", async () => {
    const controller = new AbortController();
    controller.abort();
    const browser = engines({ ddg: { results: results("x") } });
    await expect(webSearch(browser, { query: "x", n: 8 }, { signal: controller.signal })).rejects.toThrow(/aborted/);
    expect(browser.visited).toEqual([]);
  });
});

/** 假的 POST（调 Tavily 用）：记下请求，按给的回 */
function fakePost(reply: { status: number; body: unknown } | Error) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const post: PostFunction = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown>, headers: init.headers });
    if (reply instanceof Error) throw reply;
    return { ok: reply.status === 200, status: reply.status, text: async () => JSON.stringify(reply.body), json: async () => reply.body };
  };
  return { post, calls };
}

describe("Tavily（照 skill 的 --tavily）", () => {

  it("key 放在请求体的 api_key 里，max_results 是 n、search_depth 是 basic；结果取标题、链接、content 当摘要，最多 n 条", async () => {
    const { post, calls } = fakePost({
      status: 200,
      body: {
        results: [
          { title: "一", url: "https://a.example", content: "内容一" },
          { title: "二", url: "https://b.example" },
          { title: "三", url: "https://c.example", content: "c" },
        ],
      },
    });
    const found = await searchTavily(post, "tvly-fake-key", { query: "二狗", n: 2, time: "w", region: "cn-zh" });
    expect(found).toEqual({
      engine: "tavily",
      results: [
        { title: "一", url: "https://a.example", snippet: "内容一" },
        { title: "二", url: "https://b.example", snippet: "" },
      ],
    });
    expect(calls).toEqual([
      { url: TAVILY_SEARCH_URL, headers: { "Content-Type": "application/json" }, body: { api_key: "tvly-fake-key", query: "二狗", max_results: 2, search_depth: "basic" } },
    ]);
  });

  it("没配 key：不发请求，说清楚去 LSM 里加；HTTP 出错、连不上：说清楚", async () => {
    const { post, calls } = fakePost({ status: 200, body: {} });
    const missing = await searchTavily(post, undefined, { query: "x", n: 8 }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(TavilyKeyMissing);
    expect((missing as Error).message).toMatch(/^没配 tavily 的 key：请在 LSM 里给二狗加环境变量 TAVILY_API_KEY/);
    expect(calls).toEqual([]);
    const http = await searchTavily(fakePost({ status: 401, body: { detail: "bad key" } }).post, "k", { query: "x", n: 8 }).catch((e: unknown) => e);
    expect(http).toBeInstanceOf(TavilyFailed);
    expect((http as Error).message).toBe('Tavily HTTP 401 {"detail":"bad key"}');
    const down = await searchTavily(fakePost(new TypeError("fetch failed")).post, "k", { query: "x", n: 8 }).catch((e: unknown) => e);
    expect((down as Error).message).toBe("连不上 Tavily（fetch failed）");
  });

  it("接进 createWebAccess：tavily 为真走 Tavily（不起浏览器），key 每次现取", async () => {
    const { post, calls } = fakePost({ status: 200, body: { results: [{ title: "t", url: "https://t.example", content: "c" }] } });
    const browser = engines({});
    let key: string | undefined;
    const access = createWebAccess({ browser, post, tavilyKey: () => key, log: () => undefined });
    await expect(access.search({ query: "x", n: 8, tavily: true })).rejects.toBeInstanceOf(TavilyKeyMissing);
    key = "tvly-fake";
    expect((await access.search({ query: "x", n: 8, tavily: true })).engine).toBe("tavily");
    expect(calls.map((c) => c.body.api_key)).toEqual(["tvly-fake"]);
    expect(browser.visited).toEqual([]);
  });
});
