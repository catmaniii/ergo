// 联网搜索、读网页走哪条路（154 号票起；162 号票改成按设置里的队列）：假的浏览器驱动、本机临时端口上的假 DeepSeek（base URL 可配），
// 不联网、不用真 key。
// - 搜索：不指定 engine 按队列里启用的方式依次试（排前面的先用；DeepSeek 没 key 时跳过），失效了按顺序换下一个并写明；
//   agent-browser 排中间时试到它前面为止、停下让模型用它，只启用了它时回"只用 agent-browser"；
//   engine 指定启用着的方式时只用那一种（deepseek 没成就报，不换），停用了的、没 key 的拒绝；tavily 照旧只在指定时用；
// - 读网页：直接请求 → 队列里的 DeepSeek、浏览器（按队列的顺序，停用了的不用）；DeepSeek 回 403、404 的写明原因再换下一个；
//   本机、内网的网址不交给 DeepSeek；都没读到时 agent-browser 启用着的提示用它。
import { DEFAULT_WEB_SETTINGS, type WebMethod, type WebSettings } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import {
  AllSearchesFailed,
  createDeepSeekTools,
  createWebAccess,
  DeepSeekFailed,
  FetchFailed,
  type FetchFunction,
  OnlyAgentBrowser,
  type PostFunction,
  SearchFailed,
  SearchMethodsUnusable,
  type WebAccess,
  WebMethodUnavailable,
} from "../../src/web/index.ts";
import { deepseekError, type FakeToolsReply, startFakeDeepSeekTools } from "../helpers/fake-deepseek-tools.ts";
import { FakeBrowser, type FakePage } from "../helpers/web.ts";

const NOW = new Date(2026, 9, 18, 10, 30);
const rows = (...titles: string[]) => titles.map((t, i) => ({ title: t, url: `https://site${i}.example/${i}`, snippet: `摘要 ${i}` }));

/** 浏览器：ddg、bing、google 各一页，别的网址按给的 */
function browserWith(pages: Partial<Record<"ddg" | "bing" | "google", FakePage>>, others: Record<string, FakePage> = {}): FakeBrowser {
  return new FakeBrowser((url) => {
    const host = new URL(url).hostname;
    if (host === "duckduckgo.com") return pages.ddg;
    if (host === "www.bing.com") return pages.bing;
    if (host === "www.google.com") return pages.google;
    return others[url];
  });
}

const goodBrowser = () => browserWith({ ddg: { title: "DDG", results: rows("二狗 天气 一", "二狗 天气 二") } });
const deadBrowser = () => browserWith({});

/** 队列：按给的顺序，没列出的方式排在后面、停用 */
function queueOf(...enabled: WebMethod[]): WebSettings {
  const rest = DEFAULT_WEB_SETTINGS.queue.map((e) => e.method).filter((m) => !enabled.includes(m));
  return { queue: [...enabled.map((method) => ({ method, enabled: true })), ...rest.map((method) => ({ method, enabled: false }))] };
}

interface Setup {
  browser?: FakeBrowser;
  reply?: (nth: number) => FakeToolsReply | undefined;
  key?: string | undefined;
  /** 设置里的队列；不给是初始的（DeepSeek → 浏览器 → agent-browser） */
  queue?: WebSettings;
  fetch?: FetchFunction;
  post?: PostFunction;
}

async function setup(options: Setup = {}): Promise<{ access: WebAccess; browser: FakeBrowser; server: Awaited<ReturnType<typeof startFakeDeepSeekTools>>; log: string[] }> {
  const server = await startFakeDeepSeekTools((_r, nth) => options.reply?.(nth));
  const browser = options.browser ?? goodBrowser();
  const log: string[] = [];
  const deepseek = createDeepSeekTools({ key: () => ("key" in options ? options.key : "sk-fake"), baseUrl: server.baseUrl, retryDelaysMs: [0, 0], now: () => NOW, log: (l) => log.push(l) });
  const access = createWebAccess({
    browser,
    deepseek,
    settings: () => options.queue ?? DEFAULT_WEB_SETTINGS,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.post ? { post: options.post } : {}),
    log: (l) => log.push(l),
  });
  return { access, browser, server, log };
}

describe("联网搜索按队列走", () => {
  it("初始顺序（配了 key）：走 DeepSeek，不起浏览器", async () => {
    const { access, browser, server } = await setup();
    const found = await access.search({ query: "DeepSeek V4", n: 5 });
    expect(found.engine).toBe("deepseek");
    expect(found.note).toBeUndefined();
    expect(server.count("search")).toBe(1);
    expect(browser.visited).toEqual([]);
  });

  it("浏览器排第一：走浏览器，不调 DeepSeek", async () => {
    const { access, server } = await setup({ queue: queueOf("browser", "deepseek", "agent-browser") });
    const found = await access.search({ query: "二狗 天气", n: 5 });
    expect(found.engine).toBe("ddg");
    expect(found.note).toBeUndefined();
    expect(server.count("search")).toBe(0);
  });

  it("DeepSeek 排第一但没配 key：跳过它走浏览器，不发请求、不另加说明", async () => {
    const { access, server } = await setup({ key: undefined });
    const found = await access.search({ query: "二狗 天气", n: 5 });
    expect(found.engine).toBe("ddg");
    expect(found.note).toBeUndefined();
    expect(server.requests).toEqual([]);
  });

  it("DeepSeek 没搜成（余额不足、重试后还是限速、服务出错、没结果）：换浏览器，写明 DeepSeek 为什么没搜成", async () => {
    const cases: [FakeToolsReply, string][] = [
      [{ status: 402, json: deepseekError("Insufficient Balance") }, "DeepSeek 余额不足（HTTP 402：Insufficient Balance）"],
      [{ status: 429, json: deepseekError("rate limit") }, "DeepSeek 限速（HTTP 429：rate limit），重试 2 次还是不行"],
      [{ status: 503, json: deepseekError("down") }, "DeepSeek 服务出错（HTTP 503：down），重试 2 次还是不行"],
      [{ status: 200, json: { results: [] } }, "DeepSeek 没搜到结果"],
    ];
    for (const [reply, why] of cases) {
      const { access, browser } = await setup({ reply: () => reply });
      const found = await access.search({ query: "二狗 天气", n: 5 });
      expect(found.engine).toBe("ddg");
      expect(found.note).toBe(`DeepSeek 没搜成（${why}），这次用的是浏览器（ddg）`);
      expect(browser.visited).toHaveLength(1);
    }
  });

  it("查询太长（加上条件超过 128 字）：不发请求，换浏览器并写明", async () => {
    const { access, server } = await setup();
    const found = await access.search({ query: `二狗 天气 ${"长".repeat(130)}`, n: 5 });
    expect(found.engine).toBe("ddg");
    expect(found.note).toBe("DeepSeek 没搜成（查询加上时间、语言的条件后超过 128 字），这次用的是浏览器（ddg）");
    expect(server.requests).toEqual([]);
  });

  it("浏览器排第一没搜到（引擎都没结果、浏览器用不了）：换下一个 DeepSeek 并写明", async () => {
    const { access, server } = await setup({ queue: queueOf("browser", "deepseek", "agent-browser"), browser: deadBrowser() });
    const found = await access.search({ query: "二狗 天气", n: 5 });
    expect(found.engine).toBe("deepseek");
    expect(found.note).toMatch(/^浏览器没搜到（ddg：.*；bing：.*；google：.*），这次用的是 DeepSeek$/);
    expect(server.count("search")).toBe(1);

    const unavailable = await setup({ queue: queueOf("browser", "deepseek", "agent-browser"), browser: new FakeBrowser(() => undefined, { unavailable: "找不到浏览器" }) });
    expect((await unavailable.access.search({ query: "x", n: 5 })).note).toBe("浏览器没搜到（找不到浏览器），这次用的是 DeepSeek");
  });

  it("两种都没搜成：说清楚两边的原因", async () => {
    const { access } = await setup({ browser: deadBrowser(), reply: () => ({ status: 402, json: deepseekError("Insufficient Balance") }) });
    const err = await access.search({ query: "二狗 天气", n: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllSearchesFailed);
    expect((err as Error).message).toMatch(/^DeepSeek：DeepSeek 余额不足（HTTP 402：Insufficient Balance）；浏览器：ddg：/);
    const noKey = await setup({ queue: queueOf("browser", "deepseek", "agent-browser"), browser: deadBrowser(), key: undefined });
    // 没 key：队列里实际只有浏览器，没搜到就照原样报（不换 DeepSeek）
    expect(await noKey.access.search({ query: "x", n: 5 }).catch((e: unknown) => (e as Error).name)).toBe("SearchFailed");
    expect(noKey.server.requests).toEqual([]);
  });

  it("DeepSeek 停用了：浏览器没搜到不换 DeepSeek，照原样报", async () => {
    const { access, server } = await setup({ queue: queueOf("browser"), browser: deadBrowser() });
    expect(await access.search({ query: "x", n: 5 }).catch((e: unknown) => e)).toBeInstanceOf(SearchFailed);
    expect(server.requests).toEqual([]);
  });

  it("agent-browser 排最后、这个 agent 能用（有 bash）：前面的都没成时写明下一个是 agent-browser", async () => {
    const { access } = await setup({ browser: deadBrowser(), reply: () => ({ status: 402, json: deepseekError("Insufficient Balance") }) });
    const err = (await access.search({ query: "二狗 天气", n: 5, agentBrowser: true }).catch((e: unknown) => e)) as AllSearchesFailed;
    expect(err).toBeInstanceOf(AllSearchesFailed);
    expect(err.next).toEqual({ method: "agent-browser", rest: [] });
    // 只有浏览器加 agent-browser：浏览器一种没成也带上"接下来用 agent-browser"
    const free = await setup({ queue: queueOf("browser", "agent-browser"), browser: deadBrowser() });
    const one = (await free.access.search({ query: "x", n: 5, agentBrowser: true }).catch((e: unknown) => e)) as AllSearchesFailed;
    expect(one).toBeInstanceOf(AllSearchesFailed);
    expect(one.message).toMatch(/^浏览器：ddg：/);
    expect(one.next).toEqual({ method: "agent-browser", rest: [] });
    // 用不了 agent-browser（没有 bash）：照原样报
    expect(await free.access.search({ query: "x", n: 5 }).catch((e: unknown) => e)).toBeInstanceOf(SearchFailed);
  });

  it("agent-browser 排中间：试到它前面为止（DeepSeek 没成不换浏览器），写明接下来用 agent-browser、再不行指定浏览器", async () => {
    const { access, browser } = await setup({ queue: queueOf("deepseek", "agent-browser", "browser"), reply: () => ({ status: 200, json: { results: [] } }) });
    const err = (await access.search({ query: "二狗 天气", n: 5, agentBrowser: true }).catch((e: unknown) => e)) as AllSearchesFailed;
    expect(err).toBeInstanceOf(AllSearchesFailed);
    expect(err.message).toBe("DeepSeek：DeepSeek 没搜到结果");
    expect(err.next).toEqual({ method: "agent-browser", rest: ["browser"] });
    expect(browser.visited).toEqual([]);
    // 模型照说明指定了浏览器：只用浏览器
    expect((await access.search({ query: "二狗 天气", n: 5, engine: "browser", agentBrowser: true })).engine).toBe("ddg");
    // 没有 bash 的 agent：agent-browser 当不在，接着换浏览器
    const found = await access.search({ query: "二狗 天气", n: 5 });
    expect(found.engine).toBe("ddg");
    expect(found.note).toBe("DeepSeek 没搜成（DeepSeek 没搜到结果），这次用的是浏览器（ddg）");
  });

  it("agent-browser 排第一：调了 web_search 就按后面的顺序试", async () => {
    const { access, server } = await setup({ queue: queueOf("agent-browser", "browser", "deepseek") });
    expect((await access.search({ query: "二狗 天气", n: 5, agentBrowser: true })).engine).toBe("ddg");
    expect(server.requests).toEqual([]);
  });

  it("只启用了 agent-browser：不试别的，回“只用 agent-browser”（带上这个 agent 用不用得了）", async () => {
    const { access, browser, server } = await setup({ queue: queueOf("agent-browser") });
    const err = (await access.search({ query: "x", n: 5, agentBrowser: true }).catch((e: unknown) => e)) as OnlyAgentBrowser;
    expect(err).toBeInstanceOf(OnlyAgentBrowser);
    expect(err.usable).toBe(true);
    expect(((await access.search({ query: "x", n: 5 }).catch((e: unknown) => e)) as OnlyAgentBrowser).usable).toBe(false);
    expect([browser.visited, server.requests]).toEqual([[], []]);
  });

  it("鸿蒙 App 的内置浏览器排第一（182 号票）：这一轮能用时一种都不试、直接停下（写明后面的）；这一轮用不了时跳过它", async () => {
    const { access, browser, server } = await setup({ queue: queueOf("app-browser", "deepseek", "browser") });
    const err = (await access.search({ query: "二狗 天气", n: 5, agentBrowser: true, appBrowser: true }).catch((e: unknown) => e)) as AllSearchesFailed;
    expect(err).toBeInstanceOf(AllSearchesFailed);
    expect(err.message).toBe("");
    expect(err.next).toEqual({ method: "app-browser", rest: ["deepseek", "browser"] });
    expect([browser.visited, server.requests]).toEqual([[], []]);
    // 不是侧边栏、悬浮按钮来的那一轮：跳过它，照 DeepSeek → 浏览器
    expect((await access.search({ query: "二狗 天气", n: 5, agentBrowser: true })).engine).toBe("deepseek");
  });

  it("内置浏览器排中间：这一轮能用时试到它前面为止（DeepSeek 没成不换浏览器），写明接下来用它", async () => {
    const { access, browser } = await setup({ queue: queueOf("deepseek", "app-browser", "browser"), reply: () => ({ status: 200, json: { results: [] } }) });
    const err = (await access.search({ query: "二狗 天气", n: 5, appBrowser: true }).catch((e: unknown) => e)) as AllSearchesFailed;
    expect(err.message).toBe("DeepSeek：DeepSeek 没搜到结果");
    expect(err.next).toEqual({ method: "app-browser", rest: ["browser"] });
    expect(browser.visited).toEqual([]);
    // 模型用过内置浏览器、照说明指定了浏览器：只用浏览器
    expect((await access.search({ query: "二狗 天气", n: 5, engine: "browser", appBrowser: true })).engine).toBe("ddg");
  });

  it("只启用了内置浏览器、这一轮用不了：不试别的，回用不了（带上是哪几种）", async () => {
    const { access, browser, server } = await setup({ queue: queueOf("app-browser") });
    const err = (await access.search({ query: "x", n: 5, agentBrowser: true }).catch((e: unknown) => e)) as SearchMethodsUnusable;
    expect(err).toBeInstanceOf(SearchMethodsUnusable);
    expect(err.methods).toEqual(["app-browser"]);
    expect([browser.visited, server.requests]).toEqual([[], []]);
  });

  it("engine 指定启用着的 deepseek：不管排第几都只用 DeepSeek，没成就报（不换浏览器）", async () => {
    const ok = await setup({ queue: queueOf("browser", "deepseek", "agent-browser") });
    expect((await ok.access.search({ query: "x", n: 5, engine: "deepseek" })).engine).toBe("deepseek");
    expect(ok.server.count("search")).toBe(1);
    const broke = await setup({ reply: () => ({ status: 402, json: deepseekError("Insufficient Balance") }) });
    const err = await broke.access.search({ query: "x", n: 5, engine: "deepseek" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeepSeekFailed);
    expect(broke.browser.visited).toEqual([]);
  });

  it("engine 指定停用了的、没配 key 的方式：不搜，回这种方式已停用 / 没配 key（浏览器的几个引擎跟着浏览器）", async () => {
    const { access, browser, server } = await setup({ queue: queueOf("browser", "agent-browser") });
    const disabled = (await access.search({ query: "x", n: 5, engine: "deepseek" }).catch((e: unknown) => e)) as WebMethodUnavailable;
    expect(disabled).toBeInstanceOf(WebMethodUnavailable);
    expect([disabled.method, disabled.why]).toEqual(["deepseek", "disabled"]);
    expect(disabled.message).toBe("DeepSeek 付费搜索在设置里停用了");
    const noKey = await setup({ key: undefined });
    const missing = (await noKey.access.search({ query: "x", n: 5, engine: "deepseek" }).catch((e: unknown) => e)) as WebMethodUnavailable;
    expect([missing.method, missing.why, missing.message]).toEqual(["deepseek", "no_key", "没配 DeepSeek 的 key，用不了 DeepSeek 付费搜索"]);
    const noBrowser = await setup({ queue: queueOf("deepseek") });
    for (const engine of ["browser", "ddg", "bing", "google"] as const) {
      const err = (await noBrowser.access.search({ query: "x", n: 5, engine }).catch((e: unknown) => e)) as WebMethodUnavailable;
      expect([err.method, err.why, err.message]).toEqual(["browser", "disabled", "二狗自带的浏览器搜索在设置里停用了"]);
    }
    expect([browser.visited, server.requests, noKey.server.requests, noBrowser.browser.visited, noBrowser.server.requests]).toEqual([[], [], [], [], []]);
  });

  it("engine 指定浏览器（browser、ddg、bing、google）：照旧走浏览器，不调 DeepSeek", async () => {
    const { access, browser, server } = await setup({ browser: browserWith({ ddg: { results: [] }, bing: { results: rows("二狗 天气 一", "二狗 天气 二") }, google: { results: rows("二狗 天气 三", "二狗 天气 四") } }) });
    expect((await access.search({ query: "二狗 天气", n: 5, engine: "browser" })).engine).toBe("bing");
    expect((await access.search({ query: "二狗 天气", n: 5, engine: "google" })).engine).toBe("google");
    expect(browser.visited.map((u) => new URL(u).hostname)).toEqual(["duckduckgo.com", "www.bing.com", "www.google.com"]);
    expect(server.requests).toEqual([]);
  });

  it("engine 指定 tavily、tavily 为真：照旧走 Tavily", async () => {
    const posts: string[] = [];
    const post: PostFunction = async (url) => {
      posts.push(url);
      return { ok: true, status: 200, text: async () => "", json: async () => ({ results: [{ title: "t", url: "https://t.example", content: "c" }] }) };
    };
    const server = await startFakeDeepSeekTools();
    const deepseek = createDeepSeekTools({ key: () => "sk-fake", baseUrl: server.baseUrl, log: () => undefined });
    const access = createWebAccess({ browser: goodBrowser(), post, deepseek, tavilyKey: () => "tvly-fake", log: () => undefined });
    expect((await access.search({ query: "x", n: 5, engine: "tavily" })).engine).toBe("tavily");
    expect((await access.search({ query: "x", n: 5, tavily: true })).engine).toBe("tavily");
    expect(posts).toEqual(["https://api.tavily.com/search", "https://api.tavily.com/search"]);
    expect(server.requests).toEqual([]);
  });

  it("设置每次现取：改了下一次就按新的", async () => {
    const server = await startFakeDeepSeekTools();
    let settings = queueOf("deepseek", "browser", "agent-browser");
    const deepseek = createDeepSeekTools({ key: () => "sk-fake", baseUrl: server.baseUrl, log: () => undefined });
    const access = createWebAccess({ browser: goodBrowser(), deepseek, settings: () => settings, log: () => undefined });
    expect((await access.search({ query: "二狗 天气", n: 5 })).engine).toBe("deepseek");
    settings = queueOf("browser", "deepseek");
    expect((await access.search({ query: "二狗 天气", n: 5 })).engine).toBe("ddg");
    expect(server.count("search")).toBe(1);
  });
});

/** 假的直接请求：一律回这个状态 */
const direct =
  (status: number, body = "<html><head><title>直接</title></head><body><p>直接请求的正文</p></body></html>"): FetchFunction =>
  async () => ({ ok: status < 400, status, headers: { get: () => "text/html" }, text: async () => body });

const articleBrowser = () => browserWith({}, { "https://a.example/article": { status: 200, title: "浏览器", html: "<html><head><title>浏览器</title></head><body><p>浏览器读到的</p></body></html>" } });

describe("读网页按队列走", () => {
  it("直接请求成了：不调 DeepSeek", async () => {
    const { access, server } = await setup({ fetch: direct(200) });
    const page = await access.fetch({ url: "https://a.example/article", max: 8000 });
    expect(page.via).toBe("direct");
    expect(server.count("fetch")).toBe(0);
  });

  it("直接请求被拦：DeepSeek 读网页（Markdown 正文，照 max 截短），不起浏览器", async () => {
    const { access, server, browser } = await setup({ fetch: direct(403), browser: articleBrowser() });
    const page = await access.fetch({ url: "https://a.example/article", max: 8000 });
    expect(page).toEqual({ via: "deepseek", text: "URL: https://a.example/article\n标题: 示例文章\n\n# 示例文章\n\n第一段正文。\n\n第二段正文。" });
    expect(server.requests.map((r) => r.body)).toEqual([{ url: "https://a.example/article" }]);
    expect(browser.visited).toEqual([]);
    const short = await access.fetch({ url: "https://a.example/article", max: 44 });
    expect(short.text).toMatch(/^URL: https:\/\/a\.example\/article\n标题: 示例文章\n\n# 示\n\n…\[已截断，共 \d+ 字，要看更多把 max 调大\]$/);
  });

  it("DeepSeek 回 403、404：写明原因，再换浏览器", async () => {
    for (const [status, why] of [
      [403, "被 DeepSeek 的安全策略拒绝（HTTP 403：policy）"],
      [404, "DeepSeek 没取到可用的正文（HTTP 404：policy）"],
    ] as const) {
      const { access, browser } = await setup({ fetch: direct(429), browser: articleBrowser(), reply: () => ({ status, json: deepseekError("policy") }) });
      const page = await access.fetch({ url: "https://a.example/article", max: 8000 });
      expect(page.via).toBe("browser");
      expect(page.text).toBe(`URL: https://a.example/article\nHTTP: 200\n说明: 直接请求回了 HTTP 429；DeepSeek 没读到（${why}），改用浏览器\n标题: 浏览器\n\n标题: 浏览器\n\n浏览器读到的`);
      expect(browser.visited).toEqual(["https://a.example/article"]);
    }
  });

  it("DeepSeek 停用了、没配 key：直接请求 → 浏览器，不调 DeepSeek", async () => {
    for (const options of [{ queue: queueOf("browser", "agent-browser") }, { key: undefined }] as const) {
      const { access, server } = await setup({ ...options, fetch: direct(403), browser: articleBrowser() });
      const page = await access.fetch({ url: "https://a.example/article", max: 8000 });
      expect(page.via).toBe("browser");
      expect(page.text).not.toContain("DeepSeek");
      expect(server.requests).toEqual([]);
    }
  });

  it("浏览器排在 DeepSeek 前面：直接请求 → 浏览器 → DeepSeek，浏览器没读到时写明再换 DeepSeek", async () => {
    const first = await setup({ queue: queueOf("browser", "deepseek"), fetch: direct(403), browser: articleBrowser() });
    expect((await first.access.fetch({ url: "https://a.example/article", max: 8000 })).via).toBe("browser");
    expect(first.server.requests).toEqual([]);
    const dead = await setup({ queue: queueOf("browser", "deepseek"), fetch: direct(403), browser: new FakeBrowser(() => undefined, { unavailable: "找不到浏览器" }) });
    const page = await dead.access.fetch({ url: "https://a.example/article", max: 8000 });
    expect(page).toEqual({ via: "deepseek", text: "URL: https://a.example/article\n说明: 直接请求回了 HTTP 403；浏览器没读到（找不到浏览器），改用 DeepSeek\n标题: 示例文章\n\n# 示例文章\n\n第一段正文。\n\n第二段正文。" });
  });

  it("浏览器停用了：直接请求 → DeepSeek，都没读到不起浏览器；agent-browser 启用着、这个 agent 用得了时标出来（提示用它）", async () => {
    const { access, browser } = await setup({ queue: queueOf("deepseek", "agent-browser"), fetch: direct(403), browser: articleBrowser(), reply: () => ({ status: 404, json: deepseekError("none") }) });
    const err = (await access.fetch({ url: "https://a.example/article", max: 100, agentBrowser: true }).catch((e: unknown) => e)) as FetchFailed;
    expect(err).toBeInstanceOf(FetchFailed);
    expect(err.message).toBe("没读到 https://a.example/article：直接请求回了 HTTP 403；DeepSeek 没读到（DeepSeek 没取到可用的正文（HTTP 404：none））");
    expect(err.agentBrowser).toBe(true);
    expect(browser.visited).toEqual([]);
    expect(((await access.fetch({ url: "https://a.example/article", max: 100 }).catch((e: unknown) => e)) as FetchFailed).agentBrowser).toBe(false);
  });

  it("只启用了 agent-browser：只直接请求，没读到时提示用 agent-browser", async () => {
    const ok = await setup({ queue: queueOf("agent-browser"), fetch: direct(200) });
    expect((await ok.access.fetch({ url: "https://a.example/article", max: 8000, agentBrowser: true })).via).toBe("direct");
    const { access, browser, server } = await setup({ queue: queueOf("agent-browser"), fetch: direct(403), browser: articleBrowser() });
    const err = (await access.fetch({ url: "https://a.example/article", max: 100, agentBrowser: true }).catch((e: unknown) => e)) as FetchFailed;
    expect([err.message, err.agentBrowser]).toEqual(["没读到 https://a.example/article：直接请求回了 HTTP 403", true]);
    expect([browser.visited, server.requests]).toEqual([[], []]);
  });

  it("内置浏览器（182 号票）不打断读网页；都没读到、这一轮能用它时标出来（提示用 browse_open 打开读）", async () => {
    const { access } = await setup({ queue: queueOf("app-browser", "deepseek"), fetch: direct(403), reply: () => ({ status: 404, json: deepseekError("none") }) });
    const err = (await access.fetch({ url: "https://a.example/article", max: 100, appBrowser: true }).catch((e: unknown) => e)) as FetchFailed;
    expect([err.agentBrowser, err.appBrowser]).toEqual([false, true]);
    expect(((await access.fetch({ url: "https://a.example/article", max: 100 }).catch((e: unknown) => e)) as FetchFailed).appBrowser).toBe(false);
  });

  it("本机、内网的网址不交给 DeepSeek（它取不到，也不该往外送）", async () => {
    const { access, server } = await setup({ fetch: direct(500), browser: browserWith({}, { "http://127.0.0.1:8810/x": { title: "本机" }, "http://192.168.1.5/": { title: "内网" }, "http://nas/": { title: "没有点" } }) });
    for (const url of ["http://127.0.0.1:8810/x", "http://192.168.1.5/", "http://nas/"]) expect((await access.fetch({ url, max: 100 })).via).toBe("browser");
    expect(server.requests).toEqual([]);
  });

  it("三条路都没读到：说清楚每一条", async () => {
    const { access } = await setup({ fetch: direct(403), browser: new FakeBrowser(() => undefined, { unavailable: "找不到浏览器" }), reply: () => ({ status: 404, json: deepseekError("none") }) });
    const err = await access.fetch({ url: "https://a.example/article", max: 100 }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("没读到 https://a.example/article：直接请求回了 HTTP 403；DeepSeek 没读到（DeepSeek 没取到可用的正文（HTTP 404：none））；找不到浏览器");
  });
});
