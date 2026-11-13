// 设置 · 浏览与填框里"agent 联网搜索、读网页"（改成队列，四种方式）的状态层：每一项的名字、特点、
// 用的英文工具名、开关（没 key 的、最后一个启用的点不了，写明原因）、上移下移和拖动、改一处存整份、现在的顺序、
// 余额不足的提醒；消耗页"联网搜索、读网页"一节的合计和说明。466：第三种是 ego 浏览器（中英两份）。
import { describe, expect, test } from "vitest";
import {
  activeLocaleFrom,
  DEFAULT_LANGUAGE,
  setActiveLocale,
  type UsageWeb,
  usageWebNotes,
  usageWebTotal,
  WEB_METHOD_TRAIT,
  type WebMethod,
  webBalanceText,
  webMethodTools,
  webQueueIntro,
  webQueueRows,
  webQueueSummary,
  type WebSettings,
  type WebSettingsView,
  webToolsHint,
  withWebMethodEnabled,
  withWebMethodMoved,
} from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

const KEY = { configured: true, envVar: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", lsm: true };
const queue = (...entries: [WebMethod, boolean][]): WebSettings => ({ queue: entries.map(([method, enabled]) => ({ method, enabled })) });
const INITIAL = queue(["deepseek", true], ["browser", true], ["ego-browser", true], ["app-browser", true]);
const view = (settings: WebSettings = INITIAL, configured = true, patch: Partial<WebSettingsView> = {}): WebSettingsView => {
  const usable = settings.queue.filter((e) => e.enabled && (e.method !== "deepseek" || configured)).map((e) => e.method);
  return { settings, effective: usable.length > 0 ? usable : ["browser"], deepseekKey: { ...KEY, configured }, ...patch };
};
/** 工具名那一行拼成一串：工具名写成 `x`，engine 写成 [x] */
const toolLine = (method: WebMethod) => webMethodTools(method).map((p) => (p.kind === "tool" ? `\`${p.text}\`` : p.kind === "engine" ? `[${p.text}]` : p.text)).join("");

describe("设置里的联网搜索队列", () => {
  test("四个标签：名字和一句话特点、用的英文工具名、排第几、开关、能不能上移下移", () => {
    expect(WEB_METHOD_TRAIT).toEqual({
      deepseek: "按次收费（每次 0.005 元）· 最快 · 只能搜和读",
      browser: "免费 · 中等速度 · 只能搜和读",
      "ego-browser": "免费 · 用你在 ego lite 里登录好的网站 · 能下载文件、能操作网页 · 要登录、过验证时交给你",
      "app-browser": "免费 · 在你手机上的浏览器里做、你看得见 · 能点、能填框、能交文件 · 只在浏览侧边栏和悬浮按钮那一轮能用",
    });
    expect(webQueueRows(view())).toEqual([
      { method: "deepseek", label: "DeepSeek 付费搜索", tools: webMethodTools("deepseek"), trait: WEB_METHOD_TRAIT.deepseek, rank: 1, on: true, locked: false, canUp: false, canDown: true },
      { method: "browser", label: "二狗自带的浏览器搜索", tools: webMethodTools("browser"), trait: WEB_METHOD_TRAIT.browser, rank: 2, on: true, locked: false, canUp: true, canDown: true },
      { method: "ego-browser", label: "ego 浏览器", tools: webMethodTools("ego-browser"), trait: WEB_METHOD_TRAIT["ego-browser"], rank: 3, on: true, locked: false, canUp: true, canDown: true },
      { method: "app-browser", label: "手机 App 的内置浏览器", tools: webMethodTools("app-browser"), trait: WEB_METHOD_TRAIT["app-browser"], rank: 4, on: true, locked: false, canUp: true, canDown: false },
    ]);
  });

  test("工具名：DeepSeek 和浏览器用同一对工具，靠 engine 区分；ego 浏览器是 bash 里的 ego-browser 命令；内置浏览器是 browse_* 工具", () => {
    expect(toolLine("deepseek")).toBe("`web_search`（[engine: deepseek]）、`web_fetch`（被拦时由它代读）");
    expect(toolLine("browser")).toBe("`web_search`（[engine: browser / ddg / bing / google]）、`web_fetch`（被拦时由它代读）");
    expect(toolLine("ego-browser")).toBe("bash 里的 `ego-browser` 命令");
    expect(toolLine("app-browser")).toBe("`browse_open`、`browse_read_page`、`browse_snapshot`、`browse_click`（另有 `browse_fill`、`browse_attach_files`）");
  });

  test("说明：写明不写 engine 时按队列挑、结果的标题写着用了哪种；内置浏览器只在侧边栏、悬浮按钮那一轮用，停用只是不拿它来搜索", () => {
    expect(webQueueIntro()).toContain("不写 engine 时按队列挑，每次结果的标题写着实际用了哪种");
    expect(webToolsHint()).toContain("手机 App 的内置浏览器只有");
    expect(webToolsHint()).toContain("停用了也只是不拿它来搜索");
    // 466：讲 ego 浏览器，不再讲 agent-browser；没装时去哪装
    expect(webToolsHint()).toContain("ego 浏览器是 agent 在 bash 里用 ego-browser 命令操作你电脑上的 ego lite");
    expect(webToolsHint()).toContain("lite.ego.app");
    expect(webToolsHint()).not.toContain("agent-browser");
  });

  test("不能全停：剩最后一个启用的，它的开关点不了并写明原因", () => {
    const rows = webQueueRows(view(queue(["browser", true], ["deepseek", false], ["ego-browser", false], ["app-browser", false])));
    expect(rows.map((r) => [r.method, r.on, r.locked, r.note])).toEqual([
      ["browser", true, true, "至少要留一种：这是最后一个启用的，停用不了"],
      ["deepseek", false, false, undefined],
      ["ego-browser", false, false, undefined],
      ["app-browser", false, false, undefined],
    ]);
    // 只留内置浏览器也算留了一个
    const app = webQueueRows(view(queue(["app-browser", true], ["deepseek", false], ["browser", false], ["ego-browser", false])));
    expect(app.map((r) => [r.method, r.on, r.locked])).toEqual([
      ["app-browser", true, true],
      ["deepseek", false, false],
      ["browser", false, false],
      ["ego-browser", false, false],
    ]);
  });

  test("没配 DeepSeek 的 key：那一项写明、关着、点不了（存着的不变）；剩下的启用的只有一个时它也锁住", () => {
    const rows = webQueueRows(view(queue(["deepseek", true], ["browser", true], ["ego-browser", false], ["app-browser", false]), false));
    expect(rows.map((r) => [r.method, r.on, r.locked, r.note])).toEqual([
      ["deepseek", false, true, "没配 DeepSeek 的 key，不能启用"],
      ["browser", true, true, "至少要留一种：这是最后一个启用的，停用不了"],
      ["ego-browser", false, false, undefined],
      ["app-browser", false, false, undefined],
    ]);
    // 启用的都用不上（只启用了 DeepSeek、key 又没了）：临时用浏览器，写明
    const fallback = webQueueRows(view(queue(["deepseek", true], ["browser", false], ["ego-browser", false], ["app-browser", false]), false));
    expect(fallback.map((r) => [r.method, r.on, r.locked, r.note])).toEqual([
      ["deepseek", false, true, "没配 DeepSeek 的 key，不能启用"],
      ["browser", true, true, "启用的方式都用不上（没配 DeepSeek 的 key），临时用它"],
      ["ego-browser", false, false, undefined],
      ["app-browser", false, false, undefined],
    ]);
  });

  test("改一处存整份：开关只改那一项，上移下移、拖动换位置；临时用着的浏览器一并存成启用", () => {
    const v = view(queue(["deepseek", true], ["browser", false], ["ego-browser", true], ["app-browser", true]));
    expect(withWebMethodEnabled(v, "browser", true)).toEqual(queue(["deepseek", true], ["browser", true], ["ego-browser", true], ["app-browser", true]));
    expect(withWebMethodEnabled(v, "app-browser", false)).toEqual(queue(["deepseek", true], ["browser", false], ["ego-browser", true], ["app-browser", false]));
    expect(withWebMethodMoved(v, 3, 0)).toEqual(queue(["app-browser", true], ["deepseek", true], ["browser", false], ["ego-browser", true]));
    expect(withWebMethodMoved(v, 0, 1)).toEqual(queue(["browser", false], ["deepseek", true], ["ego-browser", true], ["app-browser", true]));
    expect(withWebMethodMoved(v, 0, 0)).toEqual(v.settings);
    const fallback = view(queue(["deepseek", true], ["browser", false], ["ego-browser", false], ["app-browser", false]), false);
    expect(withWebMethodEnabled(fallback, "ego-browser", true)).toEqual(queue(["deepseek", true], ["browser", true], ["ego-browser", true], ["app-browser", false]));
  });

  test("现在的顺序：实际用的按顺序写；没配 key 时写明没用上 DeepSeek", () => {
    expect(webQueueSummary(view())).toBe("现在的顺序：DeepSeek 付费搜索 → 二狗自带的浏览器搜索 → ego 浏览器 → 手机 App 的内置浏览器");
    expect(webQueueSummary(view(INITIAL, false))).toBe("现在的顺序：二狗自带的浏览器搜索 → ego 浏览器 → 手机 App 的内置浏览器（没配 DeepSeek 的 key，跳过它）");
  });

  test("余额不足：写明哪天几点回的 402、这期间按顺序换了后面的；没有就不写", () => {
    expect(webBalanceText(view())).toBeUndefined();
    expect(webBalanceText(view(INITIAL, true, { deepseekBalanceLowAt: "2026-10-18T10:30:00.000+08:00" }))).toBe(
      "DeepSeek 余额不足（10-18 10:30 回的 402）：这期间联网搜索、读网页按顺序换成了后面的方式；充值后下一次就恢复",
    );
  });
});

describe("466：英文下 ego 浏览器那一项", () => {
  test("名字、特点、工具名、说明都是英文的 ego browser；换回中文照旧", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    try {
      const row = webQueueRows(view()).find((r) => r.method === "ego-browser")!;
      expect(row.label).toBe("ego browser");
      expect(row.trait).toBe("Free · Uses the sites you're signed in to in ego lite · Can download files and operate web pages · Hands sign-ins and verifications to you");
      expect(toolLine("ego-browser")).toBe("the `ego-browser` command in bash");
      expect(webToolsHint()).toContain("The ego browser means the agent runs the ego-browser command in bash");
      expect(webToolsHint()).not.toContain("agent-browser");
    } finally {
      setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE));
    }
    expect(webQueueRows(view()).find((r) => r.method === "ego-browser")!.label).toBe("ego 浏览器");
  });
});

describe("消耗页的联网搜索、读网页", () => {
  const SOURCE = { title: "DeepSeek 官网的联网搜索文档", url: "https://api-docs.deepseek.com/zh-cn/guides/search/", readOn: "2026-10-18" };
  test("合计是两种相加；说明写单价、来源、只算成功的、记在谁名下", () => {
    const web: UsageWeb = { search: { calls: 3, cost: 0.015 }, fetch: { calls: 1, cost: 0.005 }, agents: [], price: { service: "deepseek", search: 0.005, fetch: 0.005, currency: "CNY", source: SOURCE }, unpriced: false };
    expect(usageWebTotal(web)).toEqual({ calls: 4, cost: 0.02 });
    expect(usageWebNotes(web)).toEqual([
      "DeepSeek 的联网搜索、读网页每次 ¥0.005（每 1000 次 5 元，取自 DeepSeek 官网的联网搜索文档（2026-10-18）），只算成功、有结果的；记在发起调用的 agent 名下。浏览器搜索不花钱。",
    ]);
  });

  test("货币不是人民币：没算进成本、写明", () => {
    const web: UsageWeb = { search: { calls: 1, cost: 0 }, fetch: { calls: 0, cost: 0 }, agents: [], unpriced: true };
    expect(usageWebNotes(web)).toEqual(["配置里的货币不是人民币，联网调用的自带单价是人民币，没算进成本。"]);
  });
});
