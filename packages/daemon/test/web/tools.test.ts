// 联网搜索、读网页两个工具（70 号票）：给模型看的文字、参数的校验、出错时的说法。联网经假的实现，不起浏览器、不联网。
// 154 号票：engine 多了 deepseek、browser、tavily；DeepSeek 的结果写长摘要、站点、日期和"优质""权威"的提示，json 给原样的字段；
// 换了路的写一句说明；DeepSeek 成了的调用（计费的）交给 onBilled 记账，记在发起调用的 agent 名下。
// 162 号票：工具说明、能写的 engine 跟着设置里的队列（停用了的、没 key 的不写，Tavily 配了 key 才写）；agent-browser 在队列里的位置写进
// 说明（排第一先用它、排中间/最后什么时候用、停用了别拿它搜、只启用了它时别调 web_search；别用管道接它的输出）；结果的标题行写明用了哪种；
// 只用 agent-browser、指定的方式停用了、试到 agent-browser 为止、读网页都没读到时的说法。
import type { WebMethod } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_REGISTRY, TOOL } from "../../src/guard/index.ts";
import {
  AllSearchesFailed,
  appBrowserTurnNote,
  BrowserUnavailable,
  DeepSeekFailed,
  FetchFailed,
  OnlyAgentBrowser,
  SearchMethodsUnusable,
  TavilyFailed,
  TavilyKeyMissing,
  WEB_FETCH_DEFAULT_MAX,
  WEB_SEARCH_DEFAULT_N,
  type WebBilledCall,
  WebMethodUnavailable,
  webFetchDescription,
  webSearchDescription,
  webTools,
} from "../../src/web/index.ts";
import { FAKE_SEARCH_RESULTS } from "../helpers/fake-deepseek-tools.ts";
import { fakeWebAccess } from "../helpers/web.ts";

const CALL = { toolCallId: "call-1" };
const byName = (tools: ReturnType<typeof webTools>, name: string) => tools.find((t) => t.spec.name === name)!;

describe("联网工具", () => {
  it("登记就是框架自带注册表里的那份（中文名、只读或幂等都取自它）", () => {
    const tools = webTools(fakeWebAccess());
    expect(tools.map((t) => t.spec.name)).toEqual([TOOL.web_search, TOOL.web_fetch]);
    for (const t of tools) expect(t.descriptor).toBe(BUILTIN_TOOL_REGISTRY[t.spec.name]);
  });

  it("搜索：结果照 skill 的样子写给模型（标题、链接、摘要），默认 8 条", async () => {
    const access = fakeWebAccess({
      search: () => ({
        engine: "bing",
        results: [
          { title: "第一条", url: "https://a.example/1", snippet: "摘要一" },
          { title: "第二条", url: "https://b.example/2", snippet: "摘要二" },
        ],
      }),
    });
    const out = await byName(webTools(access), TOOL.web_search).run({ query: "二狗", time: "w" }, CALL);
    expect(out).toEqual({ text: "搜索: 二狗 （浏览器 bing，2 条）\n\n1. 第一条\n   https://a.example/1\n   摘要一\n\n2. 第二条\n   https://b.example/2\n   摘要二" });
    expect(access.searches).toEqual([{ query: "二狗", n: WEB_SEARCH_DEFAULT_N, time: "w" }]);
  });

  it("搜索：都没搜到、浏览器用不了，按出错交回，说清楚接下来怎么办", async () => {
    const failed = await byName(webTools(fakeWebAccess()), TOOL.web_search).run({ query: "x", n: 3 }, CALL);
    expect(failed.isError).toBe(true);
    expect(failed.text).toBe("没搜到「x」（ddg：测试里不联网）。换更短、更通用的关键词再试，再不行换英文关键词。");
    const noBrowser = fakeWebAccess({
      search: () => {
        throw new BrowserUnavailable("找不到浏览器（Chrome 或 Edge）。在数据目录的配置里写 web.browserPath");
      },
    });
    const out = await byName(webTools(noBrowser), TOOL.web_search).run({ query: "x" }, CALL);
    expect(out).toEqual({ text: "联网搜索用不了：找不到浏览器（Chrome 或 Edge）。在数据目录的配置里写 web.browserPath", isError: true });
  });

  it("搜索的选项照 skill 逐个对齐：engine、region、tavily 交给实现，json 时结果写成 JSON", async () => {
    const access = fakeWebAccess({ search: () => ({ engine: "tavily", results: [{ title: "一", url: "https://a.example/1", snippet: "摘要" }] }) });
    const tool = byName(webTools(access), TOOL.web_search);
    const out = await tool.run({ query: "二狗", n: 3, engine: "google", region: "cn-zh", tavily: true, json: true }, CALL);
    expect(out).toEqual({ text: JSON.stringify([{ title: "一", url: "https://a.example/1", snippet: "摘要" }], null, 2) });
    expect(access.searches).toEqual([{ query: "二狗", n: 3, engine: "google", region: "cn-zh", tavily: true }]);
    const spec = tool.spec.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(spec.properties)).toEqual(["query", "n", "time", "engine", "region", "tavily", "json"]);
    expect(tool.spec.description).toContain("选项：n 条数、time 时间范围、engine 指定方式、region 地区和语言、tavily 用 Tavily、json 结果写成 JSON");
    const bad: Record<string, string>[] = [{ query: "x", engine: "baidu" }, { query: "x", region: "" }, { query: "x", tavily: "yes" }];
    for (const args of bad) {
      expect((await tool.run(args, CALL)).isError).toBe(true);
    }
    for (const engine of ["deepseek", "browser", "ddg", "bing", "google", "tavily"]) {
      expect((await tool.run({ query: "x", engine }, CALL)).isError).toBeUndefined();
    }
    expect(access.searches.slice(-6).map((q) => q.engine)).toEqual(["deepseek", "browser", "ddg", "bing", "google", "tavily"]);
  });

  it("Tavily 没配 key、没搜成：按出错交回，说清楚怎么办", async () => {
    const message = "没配 tavily 的 key：请在 LSM 里给二狗加环境变量 TAVILY_API_KEY（从数据目录密钥区的文件注入），或者不用 tavily";
    const missing = fakeWebAccess({
      search: () => {
        throw new TavilyKeyMissing(message);
      },
    });
    expect(await byName(webTools(missing), TOOL.web_search).run({ query: "x", tavily: true }, CALL)).toEqual({ text: message, isError: true });
    const failed = fakeWebAccess({
      search: () => {
        throw new TavilyFailed("Tavily HTTP 500 oops");
      },
    });
    expect(await byName(webTools(failed), TOOL.web_search).run({ query: "x", tavily: true }, CALL)).toEqual({
      text: "Tavily 没搜成：Tavily HTTP 500 oops。不用 tavily 再搜一次（不指定 engine 按设置里的顺序）",
      isError: true,
    });
  });

  it("DeepSeek 的结果：标题、链接，站点 · 日期 · 优质 · 权威，长摘要（没有用短摘要）；实际查询和原来的不一样时写出来", async () => {
    const access = fakeWebAccess({
      search: () => ({
        engine: "deepseek",
        query: "DeepSeek V4 after:2026-10-11 lang:zh",
        results: [
          { title: "DeepSeek V4 发布", url: "https://news.example/deepseek-v4", snippet: "短摘要一", summary: "长摘要一", date: "2026-06-01", site: "新闻站", score: 2.4, authority: 3 },
          { title: "某论坛的讨论", url: "https://forum.example/t/1", snippet: "短摘要二", score: 0.9 },
        ],
        raw: FAKE_SEARCH_RESULTS,
      }),
    });
    const tool = byName(webTools(access), TOOL.web_search);
    expect((await tool.run({ query: "DeepSeek V4", time: "w", region: "cn-zh" }, CALL)).text).toBe(
      "搜索: DeepSeek V4 （DeepSeek，2 条）\n实际查询: DeepSeek V4 after:2026-10-11 lang:zh\n\n" +
        "1. DeepSeek V4 发布\n   https://news.example/deepseek-v4\n   新闻站 · 2026-06-01 · 优质 · 权威\n   长摘要一\n\n" +
        "2. 某论坛的讨论\n   https://forum.example/t/1\n   短摘要二",
    );
    // json：DeepSeek 原样的字段
    expect((await tool.run({ query: "DeepSeek V4", json: true }, CALL)).text).toBe(JSON.stringify(FAKE_SEARCH_RESULTS, null, 2));
    expect(tool.spec.description).toMatch(/site:/);
    expect(tool.spec.description).toMatch(/lang:/);
    expect(tool.spec.description).toMatch(/after:/);
  });

  it("换了路的：结果前面写一句说明", async () => {
    const access = fakeWebAccess({ search: () => ({ engine: "ddg", results: [{ title: "一", url: "https://a.example/1", snippet: "摘要" }], note: "DeepSeek 没搜成（DeepSeek 余额不足（HTTP 402）），这次用的是浏览器（ddg）" }) });
    expect((await byName(webTools(access), TOOL.web_search).run({ query: "二狗" }, CALL)).text).toBe(
      "搜索: 二狗 （浏览器 ddg，1 条）\n说明: DeepSeek 没搜成（DeepSeek 余额不足（HTTP 402）），这次用的是浏览器（ddg）\n\n1. 一\n   https://a.example/1\n   摘要",
    );
  });

  it("指定 DeepSeek 没搜成、两种都没搜成：按出错交回，说清楚接下来怎么办", async () => {
    const ds = fakeWebAccess({
      search: () => {
        throw new DeepSeekFailed("balance", "DeepSeek 余额不足（HTTP 402：Insufficient Balance）", 402);
      },
    });
    expect(await byName(webTools(ds), TOOL.web_search).run({ query: "x", engine: "deepseek" }, CALL)).toEqual({
      text: "DeepSeek 没搜成：DeepSeek 余额不足（HTTP 402：Insufficient Balance）。不指定 engine 再搜一次（按设置里的顺序，没搜成自动换下一个），或者 engine 写 browser 用浏览器",
      isError: true,
    });
    const both = fakeWebAccess({
      search: () => {
        throw new AllSearchesFailed("DeepSeek：DeepSeek 没搜到结果；浏览器：ddg：没有结果");
      },
    });
    expect(await byName(webTools(both), TOOL.web_search).run({ query: "x" }, CALL)).toEqual({
      text: "没搜到「x」（DeepSeek：DeepSeek 没搜到结果；浏览器：ddg：没有结果）。换更短、更通用的关键词再试，再不行换英文关键词。",
      isError: true,
    });
  });

  it("记账：DeepSeek 成了的搜索、读网页交给 onBilled（记在发起调用的 agent 名下）；浏览器的、出错的不记", async () => {
    let engine: "deepseek" | "ddg" = "deepseek";
    let via: "deepseek" | "direct" | "browser" = "deepseek";
    const access = fakeWebAccess({ search: () => ({ engine, results: [{ title: "一", url: "https://a.example/1", snippet: "" }] }), fetch: () => ({ text: "正文", via }) });
    const billed: WebBilledCall[] = [];
    const tools = webTools(access, { onBilled: (b) => billed.push(b) });
    const call = { toolCallId: "c", agentId: "tm-3" };
    await byName(tools, TOOL.web_search).run({ query: "x" }, call);
    await byName(tools, TOOL.web_fetch).run({ url: "https://a.example/1" }, call);
    engine = "ddg";
    via = "browser";
    await byName(tools, TOOL.web_search).run({ query: "x" }, call);
    await byName(tools, TOOL.web_fetch).run({ url: "https://a.example/1" }, call);
    via = "direct";
    await byName(tools, TOOL.web_fetch).run({ url: "https://a.example/1" }, call);
    await byName(webTools(fakeWebAccess(), { onBilled: (b) => billed.push(b) }), TOOL.web_search).run({ query: "x" }, call);
    expect(billed).toEqual([
      { service: "deepseek", kind: "search", agentId: "tm-3" },
      { service: "deepseek", kind: "fetch", agentId: "tm-3" },
    ]);
  });

  it("读网页：交回正文，默认最多 8000 字；读不到按出错交回", async () => {
    const access = fakeWebAccess({ fetch: (r) => ({ text: `URL: ${r.url}\n标题: 页\n\n正文`, via: "direct" }) });
    const tool = byName(webTools(access), TOOL.web_fetch);
    expect(await tool.run({ url: "https://example.com/a" }, CALL)).toEqual({ text: "URL: https://example.com/a\n标题: 页\n\n正文" });
    expect(access.fetches).toEqual([{ url: "https://example.com/a", max: WEB_FETCH_DEFAULT_MAX }]);
    const failed = await byName(webTools(fakeWebAccess()), TOOL.web_fetch).run({ url: "https://example.com/b", max: 100 }, CALL);
    expect(failed).toEqual({ text: "没读到 https://example.com/b：测试里不联网", isError: true });
  });

  it("参数不对：不联网，直接按出错交回", async () => {
    const access = fakeWebAccess();
    const tools = webTools(access);
    for (const [name, args] of [
      [TOOL.web_fetch, { url: "file:///C:/Windows/win.ini" }],
      [TOOL.web_fetch, { url: "https://example.com", max: 0 }],
      [TOOL.web_search, { query: "" }],
      [TOOL.web_search, { query: "x", time: "h" }],
      [TOOL.web_search, { query: "x", n: 0 }],
    ] as const) {
      const out = await byName(tools, name).run(args, CALL);
      expect({ name, args, isError: out.isError, text: out.text.slice(0, 5) }).toEqual({ name, args, isError: true, text: "参数不对：" });
    }
    expect([access.searches, access.fetches]).toEqual([[], []]);
  });
});

const ALL: WebMethod[] = ["deepseek", "browser", "agent-browser"];
const engineEnum = (tools: ReturnType<typeof webTools>) => {
  const spec = byName(tools, TOOL.web_search).spec.parameters as { properties: Record<string, { anyOf?: { const: string }[] }> };
  return spec.properties.engine?.anyOf?.map((v) => v.const);
};
/** 搜索一律抛这个错的假实现 */
const thrower = (err: Error) =>
  fakeWebAccess({
    search: () => {
      throw err;
    },
  });
/** 有 bash 的 agent、初始的队列，搜索一律抛这个错时 web_search 回的 */
const searchWith = (err: Error) => byName(webTools(thrower(err), { setup: { queue: ALL, tavily: false }, agentBrowser: true }), TOOL.web_search).run({ query: "x" }, CALL);
/** 搜索一律回一条、引擎是这个的假实现 */
const found = (engine: "ddg" | "tavily") => fakeWebAccess({ search: () => ({ engine, results: [{ title: "一", url: "https://a.example/1", snippet: "摘要" }] }) });
const searchKeys = (tools: ReturnType<typeof webTools>) => Object.keys((byName(tools, TOOL.web_search).spec.parameters as { properties: object }).properties);

describe("工具说明、能写的 engine 跟着设置里的队列（162 号票）", () => {
  it("初始顺序：写明顺序，各种方式都写；agent-browser 排最后、都没搜成时用它，别用管道接它的输出", () => {
    const text = webSearchDescription({ queue: ALL, tavily: false }, true);
    expect(text).toContain("用户在设置里排的联网搜索顺序：DeepSeek → 浏览器 → agent-browser，排前面的先用。不填 engine 时按这个顺序试，没搜成自动换下一个，结果里写明用了哪种、前面的为什么没成。");
    expect(text).toContain("deepseek：DeepSeek 的搜索接口");
    expect(text).toContain("browser：浏览器真实渲染搜索结果页");
    expect(text).not.toContain("tavily");
    expect(text).toContain("web_search 都没搜成时再用 agent-browser（浏览器命令行，在 bash 里跑，用法见 agent-browser skill，或在 bash 里跑 agent-browser skills get core）搜。");
    expect(text).toContain("用 agent-browser 时别用管道接它的输出（| head、| cat 会卡住），把输出重定向到文件再读（比如 agent-browser … > ab.txt 2>&1）。");
    expect(text).toContain("下载图片、PDF 这类文件用 agent-browser 或 bash（web_fetch 只读文字）。");
  });

  it("停用了的、没 key 的不写进说明和 engine；Tavily 配了 key 才写；engine 一种都没有时不给这个参数", () => {
    const browserOnly = webTools(fakeWebAccess(), { setup: { queue: ["browser"], tavily: false }, agentBrowser: true });
    const text = byName(browserOnly, TOOL.web_search).spec.description;
    expect(text).not.toMatch(/deepseek|DeepSeek|tavily|site:/);
    expect(engineEnum(browserOnly)).toEqual(["browser", "ddg", "bing", "google"]);
    expect(searchKeys(browserOnly)).toEqual(["query", "n", "time", "engine", "region", "json"]);
    expect(text).toContain("选项：n 条数、time 时间范围、engine 指定方式、region 地区和语言、json 结果写成 JSON。");
    const withTavily = webTools(fakeWebAccess(), { setup: { queue: ["deepseek", "agent-browser"], tavily: true }, agentBrowser: true });
    expect(engineEnum(withTavily)).toEqual(["deepseek", "tavily"]);
    expect(searchKeys(withTavily)).toEqual(["query", "n", "time", "engine", "region", "tavily", "json"]);
    const onlyAb = webTools(fakeWebAccess(), { setup: { queue: ["agent-browser"], tavily: false }, agentBrowser: true });
    expect(searchKeys(onlyAb)).toEqual(["query", "n", "time", "region", "json"]);
  });

  it("agent-browser 排第一、排中间、停用了、只启用了它；这个 agent 没有 bash 时不提它（只启用了它时说明用不了）", () => {
    expect(webSearchDescription({ queue: ["browser", "agent-browser", "deepseek"], tavily: false }, true)).toContain("agent-browser 排在浏览器后面：不填 engine 时 web_search 只试浏览器，没成就停下");
    expect(webSearchDescription({ queue: ["agent-browser", "browser", "deepseek"], tavily: false }, true)).toContain(
      "agent-browser 排第一：搜索、下载先用 agent-browser（浏览器命令行，在 bash 里跑，用法见 agent-browser skill，或在 bash 里跑 agent-browser skills get core），用不成再调 web_search（按浏览器 → DeepSeek 的顺序试）。",
    );
    expect(webSearchDescription({ queue: ["deepseek", "agent-browser", "browser"], tavily: false }, true)).toContain(
      "agent-browser 排在 DeepSeek 后面：不填 engine 时 web_search 只试 DeepSeek，没成就停下，这时用 agent-browser（浏览器命令行，在 bash 里跑，用法见 agent-browser skill，或在 bash 里跑 agent-browser skills get core）搜；还不成再调 web_search，engine 写 browser。",
    );
    const off = webSearchDescription({ queue: ["deepseek", "browser"], tavily: false }, true);
    expect(off).toContain("agent-browser 在设置里停用了联网搜索：别拿它来搜索；操作网页、下载文件照旧能用它。");
    expect(off).toContain("别用管道接它的输出");
    const only = webSearchDescription({ queue: ["agent-browser"], tavily: false }, true);
    expect(only).toContain("用户在设置里只启用了 agent-browser 来联网搜索：用 agent-browser（浏览器命令行，在 bash 里跑，用法见 agent-browser skill，或在 bash 里跑 agent-browser skills get core）搜索、下载，不要调 web_search（会直接回“只用 agent-browser”）；读网页可以先用 web_fetch。");
    expect(only).not.toContain("用户在设置里排的联网搜索顺序");
    // 没有 bash：顺序里不写 agent-browser，也不提它
    const noBash = webSearchDescription({ queue: ["deepseek", "agent-browser", "browser"], tavily: false }, false);
    expect(noBash).toContain("用户在设置里排的联网搜索顺序：DeepSeek → 浏览器，排前面的先用。");
    expect(noBash).not.toContain("agent-browser");
    expect(webSearchDescription({ queue: ["agent-browser"], tavily: false }, false)).toContain(
      "用户在设置里只启用了 agent-browser 来联网搜索，你这里没有 bash，用不了它，也就搜不了；要联网查资料，告诉用户去设置 · 浏览与填框里启用别的方式。",
    );
  });

  it("读网页的说明：直接请求之后按队列换；都停用了时说明只直接请求", () => {
    expect(webFetchDescription({ queue: ALL, tavily: false }, true)).toContain("先直接请求，被拦了、超时了按设置里的顺序换：先让 DeepSeek 读（回 Markdown，按次计费），再不行用浏览器真实渲染。");
    expect(webFetchDescription({ queue: ["browser", "deepseek"], tavily: false }, true)).toContain("先直接请求，被拦了、超时了按设置里的顺序换：先用浏览器真实渲染，再不行让 DeepSeek 读（回 Markdown，按次计费）。");
    expect(webFetchDescription({ queue: ["browser"], tavily: false }, true)).toContain("先直接请求，被拦了、超时了用浏览器真实渲染。");
    expect(webFetchDescription({ queue: ["agent-browser"], tavily: false }, true)).toContain("只直接请求（用户在设置里停用了 DeepSeek 和浏览器），被拦了就读不到，这时用 agent-browser 打开网页读。");
  });

  it("调用时交给实现：这个 agent 能不能用 agent-browser", async () => {
    const access = fakeWebAccess({ search: () => ({ engine: "ddg", results: [] }), fetch: () => ({ text: "正文", via: "direct" }) });
    const tools = webTools(access, { setup: { queue: ALL, tavily: false }, agentBrowser: false });
    await byName(tools, TOOL.web_search).run({ query: "x" }, CALL);
    await byName(tools, TOOL.web_fetch).run({ url: "https://a.example/1" }, CALL);
    expect(access.searches).toEqual([{ query: "x", n: WEB_SEARCH_DEFAULT_N, agentBrowser: false }]);
    expect(access.fetches).toEqual([{ url: "https://a.example/1", max: WEB_FETCH_DEFAULT_MAX, agentBrowser: false }]);
  });

  it("只用 agent-browser、指定的方式停用了 / 没 key：按出错交回，说清楚怎么办", async () => {
    expect(await searchWith(new OnlyAgentBrowser(true))).toEqual({
      text: "联网搜索现在只用 agent-browser（用户在设置里只启用了它）：用 agent-browser（浏览器命令行，在 bash 里跑，用法见 agent-browser skill，或在 bash 里跑 agent-browser skills get core）搜；别用管道接它的输出（| head、| cat 会卡住），把输出重定向到文件再读。",
      isError: true,
    });
    expect(await searchWith(new OnlyAgentBrowser(false))).toEqual({
      text: "联网搜索现在只用 agent-browser（用户在设置里只启用了它），你这里没有 bash，用不了；要联网查资料，告诉用户去设置 · 浏览与填框里启用别的方式。",
      isError: true,
    });
    expect(await searchWith(new WebMethodUnavailable("deepseek", "disabled"))).toEqual({ text: "这种方式已停用：DeepSeek 付费搜索在设置里停用了。不填 engine 按设置里的顺序搜。", isError: true });
    expect(await searchWith(new WebMethodUnavailable("deepseek", "no_key"))).toEqual({ text: "没配 DeepSeek 的 key，用不了 DeepSeek 付费搜索。不填 engine 按设置里的顺序搜。", isError: true });
  });

  it("试到 agent-browser 为止都没成：写明接下来用 agent-browser（排中间的再写还不成时指定哪种）", async () => {
    expect((await searchWith(new AllSearchesFailed("DeepSeek：DeepSeek 没搜到结果", { method: "agent-browser", rest: ["browser"] }))).text).toBe(
      "没搜到「x」（DeepSeek：DeepSeek 没搜到结果）。设置里接下来是 agent-browser：用它（在 bash 里跑，用法见 agent-browser skill，或在 bash 里跑 agent-browser skills get core）搜；还不成再调 web_search，engine 写 browser。别用管道接它的输出（会卡住），重定向到文件再读。",
    );
    expect((await searchWith(new AllSearchesFailed("DeepSeek：DeepSeek 没搜到结果", { method: "agent-browser", rest: [] }))).text).toBe(
      "没搜到「x」（DeepSeek：DeepSeek 没搜到结果）。设置里接下来是 agent-browser：用它（在 bash 里跑，用法见 agent-browser skill，或在 bash 里跑 agent-browser skills get core）搜。别用管道接它的输出（会卡住），重定向到文件再读。",
    );
  });

  it("读网页都没读到、agent-browser 启用着：提示用它打开读", async () => {
    const access = fakeWebAccess({
      fetch: () => {
        throw new FetchFailed("没读到 https://a.example/1：直接请求回了 HTTP 403", { agentBrowser: true });
      },
    });
    expect(await byName(webTools(access, { setup: { queue: ALL, tavily: false }, agentBrowser: true }), TOOL.web_fetch).run({ url: "https://a.example/1" }, CALL)).toEqual({
      text: "没读到 https://a.example/1：直接请求回了 HTTP 403。可以用 agent-browser（在 bash 里跑，用法见 agent-browser skill，或在 bash 里跑 agent-browser skills get core）打开这个网址读。",
      isError: true,
    });
  });

  it("结果的标题行写明用了哪种：浏览器带引擎、DeepSeek、Tavily", async () => {
    expect((await byName(webTools(found("ddg")), TOOL.web_search).run({ query: "x" }, CALL)).text).toMatch(/^搜索: x （浏览器 ddg，1 条）/);
    expect((await byName(webTools(found("tavily")), TOOL.web_search).run({ query: "x" }, CALL)).text).toMatch(/^搜索: x （Tavily，1 条）/);
  });
});

const FOUR: WebMethod[] = ["deepseek", "browser", "agent-browser", "app-browser"];
/** 秘书（有 bash、有 browse_* 工具）的 web_search；sideTurn 时这一轮能用内置浏览器（发消息那台设备的"浏览"用 engine 搜） */
const secretarySearch = (access: ReturnType<typeof fakeWebAccess>, queue: WebMethod[], sideTurn: false | "bing" | "baidu" = "bing") =>
  byName(webTools(access, { setup: { queue, tavily: false }, agentBrowser: true, appBrowser: () => (sideTurn ? { engine: sideTurn } : undefined) }), TOOL.web_search);

describe("鸿蒙 App 的内置浏览器（182 号票）", () => {
  it("说明：只给有 browse_* 工具的（秘书）写它的位置、只在侧边栏和悬浮按钮那一轮算数、那一轮的顺序；没有的不提", () => {
    const text = webSearchDescription({ queue: ["app-browser", "deepseek", "browser", "agent-browser"], tavily: false }, true, true);
    expect(text).toContain("用户在设置里排的联网搜索顺序：鸿蒙 App 的内置浏览器 → DeepSeek → 浏览器 → agent-browser，排前面的先用。");
    expect(text).toContain(
      "鸿蒙 App 的内置浏览器（用户手机上二狗 App「浏览」里的浏览器，用户看得见你在做什么）只在用户从浏览侧边栏、悬浮按钮跟你说话的那一轮算进联网搜索的顺序，别的轮次跳过它、web_search 照其余的顺序试。",
    );
    expect(text).toContain(
      "那一轮它排第一：不填 engine 调 web_search 会直接停下、给出搜索结果页的地址（用户在「浏览」里设的搜索引擎），这时用 browse_open 打开它或者目标网站，再用 browse_read_page 读、browse_snapshot 和 browse_click 看和点；还不成再照 web_search 停下时说的往后用。",
    );
    // agent-browser 的位置照不算内置浏览器的那几轮写（排最后）
    expect(text).toContain("web_search 都没搜成时再用 agent-browser");
    const middle = webSearchDescription({ queue: ["deepseek", "app-browser", "browser", "agent-browser"], tavily: false }, true, true);
    expect(middle).toContain("那一轮的顺序是 DeepSeek → 鸿蒙 App 的内置浏览器 → 浏览器 → agent-browser：不填 engine 时 web_search 只试 DeepSeek，没成就停下、给出搜索结果页的地址");
    const last = webSearchDescription({ queue: FOUR, tavily: false }, true, true);
    expect(last).toContain("那一轮的顺序是 DeepSeek → 浏览器 → agent-browser → 鸿蒙 App 的内置浏览器：它排在后面，前面的都没成时再用（web_search 停下时会写明，给出搜索结果页的地址）");
    // 维护者这类没有 browse_* 工具的：顺序里不写它，也不提
    const maintainer = webSearchDescription({ queue: ["app-browser", "deepseek", "browser", "agent-browser"], tavily: false }, true);
    expect(maintainer).toContain("用户在设置里排的联网搜索顺序：DeepSeek → 浏览器 → agent-browser，排前面的先用。");
    expect(maintainer).not.toMatch(/内置浏览器|browse_/);
  });

  it("说明：停用了就写别拿它搜索，用户明确要操作网页时 browse_* 照旧能用", () => {
    const off = webSearchDescription({ queue: ["deepseek", "browser", "agent-browser"], tavily: false }, true, true);
    expect(off).toContain("鸿蒙 App 的内置浏览器在设置里停用了联网搜索：别拿它来搜索；用户明确要你在网页上点、填框、交文件时 browse_* 工具照旧能用（停用只是不拿它来搜索）。");
    expect(off).toContain("用户在设置里排的联网搜索顺序：DeepSeek → 浏览器 → agent-browser，排前面的先用。");
  });

  it("说明：只启用了它", () => {
    expect(webSearchDescription({ queue: ["app-browser"], tavily: false }, true, true)).toContain(
      "用户在设置里只启用了鸿蒙 App 的内置浏览器来联网搜索：只在用户从浏览侧边栏、悬浮按钮跟你说话的那一轮能用——那一轮调 web_search 会直接停下、给出搜索结果页的地址，用 browse_open 打开它或者目标网站，再用 browse_read_page 读、browse_snapshot 和 browse_click 看和点；别的轮次搜不了，要联网查资料，告诉用户去设置 · 浏览与填框里启用别的方式。",
    );
    expect(webSearchDescription({ queue: ["app-browser"], tavily: false }, true)).toContain(
      "用户在设置里只启用了鸿蒙 App 的内置浏览器来联网搜索，你这里用不了它，也就搜不了；要联网查资料，告诉用户去设置 · 浏览与填框里启用别的方式。",
    );
  });

  it("侧边栏、悬浮按钮那一轮、排第一：web_search 停下，给出发消息那台设备的搜索引擎的结果页地址，让模型先用 browse_*；后面的写明", async () => {
    const queue: WebMethod[] = ["app-browser", "deepseek", "browser", "agent-browser"];
    const access = thrower(new AllSearchesFailed("", { method: "app-browser", rest: ["deepseek", "browser", "agent-browser"] }));
    const out = await secretarySearch(access, queue, "baidu").run({ query: "二狗 天气" }, CALL);
    expect(out).toEqual({
      text:
        "这一轮联网搜索先用鸿蒙 App 的内置浏览器（用户在设置里把它排在前面）：用 browse_open 打开 https://www.baidu.com/s?wd=%E4%BA%8C%E7%8B%97%20%E5%A4%A9%E6%B0%94（百度搜「二狗 天气」的结果页）或者直接打开目标网站，再用 browse_read_page 读、browse_snapshot 和 browse_click 看和点" +
        "；还不成再调 web_search，engine 依次写 deepseek、browser；再不成用 agent-browser（在 bash 里跑，用法见 agent-browser skill，或在 bash 里跑 agent-browser skills get core）搜。",
      isError: true,
    });
    // 交给实现的：这一轮能用内置浏览器
    expect(access.searches).toEqual([{ query: "二狗 天气", n: WEB_SEARCH_DEFAULT_N, agentBrowser: true, appBrowser: true }]);
  });

  it("排中间：前面的没成才停下（写明原因）；排在 agent-browser 后面：agent-browser 那句后面接上它", async () => {
    const mid = await secretarySearch(thrower(new AllSearchesFailed("DeepSeek：DeepSeek 没搜到结果", { method: "app-browser", rest: ["browser"] })), FOUR).run({ query: "x" }, CALL);
    expect(mid.text).toBe(
      "没搜到「x」（DeepSeek：DeepSeek 没搜到结果）。设置里接下来是鸿蒙 App 的内置浏览器：用 browse_open 打开 https://cn.bing.com/search?q=x（必应搜「x」的结果页）或者直接打开目标网站，再用 browse_read_page 读、browse_snapshot 和 browse_click 看和点；还不成再调 web_search，engine 写 browser。",
    );
    const afterAb = await secretarySearch(thrower(new AllSearchesFailed("DeepSeek：DeepSeek 没搜到结果；浏览器：ddg：没有结果", { method: "agent-browser", rest: ["app-browser"] })), FOUR).run({ query: "x" }, CALL);
    expect(afterAb.text).toBe(
      "没搜到「x」（DeepSeek：DeepSeek 没搜到结果；浏览器：ddg：没有结果）。设置里接下来是 agent-browser：用它（在 bash 里跑，用法见 agent-browser skill，或在 bash 里跑 agent-browser skills get core）搜；还不成用鸿蒙 App 的内置浏览器（browse_open 打开 https://cn.bing.com/search?q=x）。别用管道接它的输出（会卡住），重定向到文件再读。",
    );
  });

  it("不是侧边栏、悬浮按钮那一轮：交给实现的是这一轮用不了；只启用了它时说明这一轮搜不了", async () => {
    const access = fakeWebAccess({ search: () => ({ engine: "ddg", results: [] }) });
    await secretarySearch(access, FOUR, false).run({ query: "x" }, CALL);
    expect(access.searches).toEqual([{ query: "x", n: WEB_SEARCH_DEFAULT_N, agentBrowser: true, appBrowser: false }]);
    expect(await secretarySearch(thrower(new SearchMethodsUnusable(["app-browser"])), ["app-browser"], false).run({ query: "x" }, CALL)).toEqual({
      text: "联网搜索现在只用鸿蒙 App 的内置浏览器（用户在设置里只启用了它），它只在用户从浏览侧边栏、悬浮按钮跟秘书说话的那一轮能用，这里用不了；要联网查资料，告诉用户去设置 · 浏览与填框里启用别的方式。",
      isError: true,
    });
    expect((await secretarySearch(thrower(new SearchMethodsUnusable(["agent-browser", "app-browser"])), ["agent-browser", "app-browser"], false).run({ query: "x" }, CALL)).text).toBe(
      "联网搜索现在只用 agent-browser、鸿蒙 App 的内置浏览器（用户在设置里只启用了它们），这里都用不了（agent-browser 要 bash；内置浏览器只在用户从浏览侧边栏、悬浮按钮跟秘书说话的那一轮能用）；要联网查资料，告诉用户去设置 · 浏览与填框里启用别的方式。",
    );
  });

  it("读网页都没读到、这一轮能用内置浏览器：提示用 browse_open 打开读", async () => {
    const access = fakeWebAccess({
      fetch: () => {
        throw new FetchFailed("没读到 https://a.example/1：直接请求回了 HTTP 403", { agentBrowser: true, appBrowser: true });
      },
    });
    const tool = byName(webTools(access, { setup: { queue: FOUR, tavily: false }, agentBrowser: true, appBrowser: () => ({ engine: "bing" }) }), TOOL.web_fetch);
    expect(await tool.run({ url: "https://a.example/1" }, CALL)).toEqual({
      text: "没读到 https://a.example/1：直接请求回了 HTTP 403。可以用 agent-browser（在 bash 里跑，用法见 agent-browser skill，或在 bash 里跑 agent-browser skills get core）打开这个网址读，或者用 browse_open 在鸿蒙 App 的内置浏览器里打开它、browse_read_page 读。",
      isError: true,
    });
    expect(access.fetches).toEqual([{ url: "https://a.example/1", max: WEB_FETCH_DEFAULT_MAX, agentBrowser: true, appBrowser: true }]);
  });

  it("侧边栏、悬浮按钮那一轮交给秘书的输入后面加的一句：启用着时写这一轮算上它和顺序，停用了不写", () => {
    expect(appBrowserTurnNote(["deepseek", "app-browser", "browser", "agent-browser"])).toBe(
      "这一轮联网搜索算上鸿蒙 App 的内置浏览器（设置里的顺序：DeepSeek → 鸿蒙 App 的内置浏览器 → 浏览器 → agent-browser）：轮到它时 web_search 会停下、给出搜索结果页的地址，用 browse_open 打开它或者目标网站再看、点。",
    );
    expect(appBrowserTurnNote(["deepseek", "browser", "agent-browser"])).toBeUndefined();
  });
});
