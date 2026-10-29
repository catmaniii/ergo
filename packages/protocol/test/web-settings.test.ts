// 设置里的联网搜索队列（162 号票）：初始顺序、实际用哪几种（DeepSeek 要配 key）、至少留一个、154 号票旧设置的迁移、schema。
// 182 号票：队列里多第四种"鸿蒙 App 的内置浏览器"（排最后、启用）；162 号票存的三项的文件读的时候把它加在最后，认不得的方式跳过。
// "浏览"页签的搜索引擎（必应、百度……）拼结果页地址的函数挪到协议包（守护进程给秘书拼内置浏览器要打开的结果页）。
import { describe, expect, test } from "vitest";
import {
  BROWSE_SEARCH_ENGINE_IDS,
  browseSearchEngineOf,
  browseSearchUrl,
  BrowserStatusParams,
  copyWebSettings,
  DEFAULT_WEB_SETTINGS,
  effectiveWebQueue,
  migrateWebSettingsV1,
  normalizeWebQueue,
  schemaChecker,
  WEB_METHOD_LABEL,
  type WebSettings,
  WebSettingsBody,
  WebSettingsFile,
  WebSettingsFileV1,
  webQueueFallback,
  webSettingsProblem,
} from "../src/index.ts";

const queue = (...entries: [WebSettings["queue"][number]["method"], boolean][]): WebSettings => ({ queue: entries.map(([method, enabled]) => ({ method, enabled })) });

describe("联网搜索的队列", () => {
  test("初始顺序照 161 号票的报告：DeepSeek → 浏览器 → agent-browser，182 号票的鸿蒙 App 的内置浏览器排最后，都启用；默认值改不动", () => {
    expect(DEFAULT_WEB_SETTINGS).toEqual(queue(["deepseek", true], ["browser", true], ["agent-browser", true], ["app-browser", true]));
    expect(WEB_METHOD_LABEL["app-browser"]).toBe("鸿蒙 App 的内置浏览器");
    expect(Object.isFrozen(DEFAULT_WEB_SETTINGS.queue[0])).toBe(true);
    const copy = copyWebSettings(DEFAULT_WEB_SETTINGS);
    copy.queue[0]!.enabled = false;
    expect(DEFAULT_WEB_SETTINGS.queue[0]!.enabled).toBe(true);
  });

  test("实际用的：启用了、用得上的按队列；没配 DeepSeek 的 key 时跳过它；一个都没有时临时用浏览器", () => {
    expect(effectiveWebQueue(DEFAULT_WEB_SETTINGS, true)).toEqual(["deepseek", "browser", "agent-browser", "app-browser"]);
    expect(effectiveWebQueue(DEFAULT_WEB_SETTINGS, false)).toEqual(["browser", "agent-browser", "app-browser"]);
    expect(effectiveWebQueue(queue(["agent-browser", true], ["browser", false], ["deepseek", true], ["app-browser", false]), true)).toEqual(["agent-browser", "deepseek"]);
    const onlyDeepseek = queue(["deepseek", true], ["browser", false], ["agent-browser", false], ["app-browser", false]);
    expect(effectiveWebQueue(onlyDeepseek, true)).toEqual(["deepseek"]);
    expect(webQueueFallback(onlyDeepseek, true)).toBe(false);
    expect(effectiveWebQueue(onlyDeepseek, false)).toEqual(["browser"]);
    expect(webQueueFallback(onlyDeepseek, false)).toBe(true);
  });

  test("要存的：四种各一项、至少留一个启用而且用得上的（只启用鸿蒙 App 的内置浏览器也算留了一个）", () => {
    expect(webSettingsProblem(DEFAULT_WEB_SETTINGS, true)).toBeUndefined();
    expect(webSettingsProblem(queue(["agent-browser", true], ["deepseek", false], ["browser", false], ["app-browser", false]), true)).toBeUndefined();
    expect(webSettingsProblem(queue(["app-browser", true], ["deepseek", false], ["browser", false], ["agent-browser", false]), true)).toBeUndefined();
    expect(webSettingsProblem(queue(["deepseek", false], ["browser", false], ["agent-browser", false], ["app-browser", false]), true)).toBe("至少要留一种启用的方式");
    // 没 key：只启用 DeepSeek 不算；DeepSeek 存着启用、另外还启用了一种就行（存着的照旧，配上 key 马上用上）
    expect(webSettingsProblem(queue(["deepseek", true], ["browser", false], ["agent-browser", false], ["app-browser", false]), false)).toBe("至少要留一种启用的方式（没配 DeepSeek 的 key，只启用它不算）");
    expect(webSettingsProblem(queue(["deepseek", true], ["browser", false], ["agent-browser", true], ["app-browser", false]), false)).toBeUndefined();
    for (const bad of [
      queue(["deepseek", true], ["deepseek", true], ["browser", true], ["agent-browser", true]),
      queue(["deepseek", true], ["browser", true], ["agent-browser", true]),
    ]) {
      expect(webSettingsProblem(bad, true)).toBe("队列里要四种方式各一项（deepseek、browser、agent-browser、app-browser）");
    }
  });

  test("设置文件里的队列（182 号票）：162 号票存的三项读成四项，鸿蒙 App 的内置浏览器加在最后、启用；认不得的方式跳过；重复的留给合规检查", () => {
    const old = [
      { method: "browser", enabled: true },
      { method: "agent-browser", enabled: false },
      { method: "deepseek", enabled: true },
    ];
    expect(normalizeWebQueue(old)).toEqual({ settings: queue(["browser", true], ["agent-browser", false], ["deepseek", true], ["app-browser", true]), skipped: [], added: ["app-browser"] });
    expect(normalizeWebQueue([{ method: "tavily", enabled: true }, ...old, { method: "app-browser", enabled: false }])).toEqual({
      settings: queue(["browser", true], ["agent-browser", false], ["deepseek", true], ["app-browser", false]),
      skipped: ["tavily"],
      added: [],
    });
    const dup = normalizeWebQueue([...old, { method: "browser", enabled: true }]);
    expect(webSettingsProblem(dup.settings, true)).toMatch(/^队列里要四种方式各一项/);
  });

  test("154 号票的旧设置并进队列：默认浏览器的浏览器排第一、DeepSeek 第二，agent-browser、鸿蒙 App 的内置浏览器在后面，都启用；读网页的开关没有对应的了", () => {
    expect(migrateWebSettingsV1({ search: "deepseek", deepseekFetch: true })).toEqual(queue(["deepseek", true], ["browser", true], ["agent-browser", true], ["app-browser", true]));
    expect(migrateWebSettingsV1({ search: "deepseek", deepseekFetch: false })).toEqual(queue(["deepseek", true], ["browser", true], ["agent-browser", true], ["app-browser", true]));
    expect(migrateWebSettingsV1({ search: "browser", deepseekFetch: false })).toEqual(queue(["browser", true], ["deepseek", true], ["agent-browser", true], ["app-browser", true]));
  });

  test("schema：请求体只有队列（四项，每项方式和开关），文件多一个 format 2（认不得的方式、少几项也读得进来，读完再整理）；旧文件 format 1 照认", () => {
    const body = schemaChecker(WebSettingsBody);
    expect(body.check(copyWebSettings(DEFAULT_WEB_SETTINGS))).toBe(true);
    const three = [
      { method: "deepseek", enabled: true },
      { method: "browser", enabled: true },
      { method: "agent-browser", enabled: true },
    ];
    for (const bad of [{ search: "browser", deepseekFetch: true }, { queue: [] }, { queue: three }, { queue: [{ method: "tavily", enabled: true }, ...three] }, { ...DEFAULT_WEB_SETTINGS, extra: 1 }]) {
      expect(body.check(bad)).toBe(false);
    }
    const file = schemaChecker(WebSettingsFile);
    expect(file.check({ format: 2, ...copyWebSettings(DEFAULT_WEB_SETTINGS) })).toBe(true);
    expect(file.check({ format: 2, queue: three })).toBe(true);
    expect(file.check({ format: 2, queue: [{ method: "tavily", enabled: true }, ...three] })).toBe(true);
    for (const bad of [{ format: 2, queue: [] }, { format: 2, queue: [{ method: "browser" }] }, { format: 2, queue: three, extra: 1 }]) expect(file.check(bad)).toBe(false);
    expect(schemaChecker(WebSettingsFileV1).check({ format: 1, search: "browser", deepseekFetch: false })).toBe(true);
    expect(file.check({ format: 1, search: "browser", deepseekFetch: false })).toBe(false);
  });
});

describe("“浏览”页签的搜索引擎（182 号票挪到协议包）", () => {
  test("必应、百度、搜狗、谷歌；认不得的、没记过的按默认必应；关键词按 encodeURIComponent 接在结果页地址后面", () => {
    expect(BROWSE_SEARCH_ENGINE_IDS).toEqual(["bing", "baidu", "sogou", "google"]);
    expect(browseSearchEngineOf(undefined)).toBe("bing");
    expect(browseSearchEngineOf(null)).toBe("bing");
    expect(browseSearchEngineOf("yahoo")).toBe("bing");
    expect(browseSearchEngineOf("baidu")).toBe("baidu");
    expect(browseSearchUrl("二狗 天气 & 新闻", "bing")).toBe("https://cn.bing.com/search?q=%E4%BA%8C%E7%8B%97%20%E5%A4%A9%E6%B0%94%20%26%20%E6%96%B0%E9%97%BB");
    expect(browseSearchUrl("x", "baidu")).toBe("https://www.baidu.com/s?wd=x");
    expect(browseSearchUrl("x", "sogou")).toBe("https://www.sogou.com/web?query=x");
    expect(browseSearchUrl("x", "google")).toBe("https://www.google.com/search?q=x");
  });

  test("设备报的浏览器样子带上它在用的搜索引擎（可以不带：旧页面）", () => {
    const status = schemaChecker(BrowserStatusParams);
    expect(status.check({ browser: "b-0123456789abcdef", searchEngine: "baidu" })).toBe(true);
    expect(status.check({ browser: "b-0123456789abcdef" })).toBe(true);
  });
});
