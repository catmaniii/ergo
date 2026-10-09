// 联网搜索、读网页两个工具（70 号票）：给模型看的文字、参数的校验、出错时的说法。联网经假的实现，不起浏览器、不联网。
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_REGISTRY, TOOL } from "../../src/guard/index.ts";
import { BrowserUnavailable, TavilyFailed, TavilyKeyMissing, WEB_FETCH_DEFAULT_MAX, WEB_SEARCH_DEFAULT_N, webTools } from "../../src/web/index.ts";
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
    expect(out).toEqual({ text: "搜索: 二狗 （2 条）\n\n1. 第一条\n   https://a.example/1\n   摘要一\n\n2. 第二条\n   https://b.example/2\n   摘要二" });
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
    expect(tool.spec.description).toContain("选项：n 条数、time 时间范围、engine 指定引擎、region 地区和语言、tavily 用 Tavily、json 结果写成 JSON");
    const bad: Record<string, string>[] = [{ query: "x", engine: "baidu" }, { query: "x", region: "" }, { query: "x", tavily: "yes" }];
    for (const args of bad) {
      expect((await tool.run(args, CALL)).isError).toBe(true);
    }
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
      text: "Tavily 没搜成：Tavily HTTP 500 oops。不用 tavily 再搜一次（走浏览器）",
      isError: true,
    });
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
