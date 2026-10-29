// 设置 · 浏览与填框里"agent 联网搜索、读网页"（154 号票；162 号票改成队列，182 号票起四种方式）的状态层：每一项的名字、特点、
// 用的英文工具名（182 号票）、开关（没 key 的、最后一个启用的点不了，写明原因）、上移下移和拖动、改一处存整份、现在的顺序、
// 余额不足的提醒；消耗页"联网搜索、读网页"一节的合计和说明。
import { describe, expect, test } from "vitest";
import {
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

const KEY = { configured: true, envVar: "DEEPSEEK_API_KEY", secretFile: "secrets/deepseek-api-key.txt", lsm: true };
const queue = (...entries: [WebMethod, boolean][]): WebSettings => ({ queue: entries.map(([method, enabled]) => ({ method, enabled })) });
const INITIAL = queue(["deepseek", true], ["browser", true], ["agent-browser", true], ["app-browser", true]);
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
      "agent-browser": "免费 · 最慢、最费 token · 能下载文件、能操作网页",
      "app-browser": "免费 · 在你手机上的浏览器里做、你看得见 · 能点、能填框、能交文件 · 只在浏览侧边栏和悬浮按钮那一轮能用",
    });
    expect(webQueueRows(view())).toEqual([
      { method: "deepseek", label: "DeepSeek 付费搜索", tools: webMethodTools("deepseek"), trait: WEB_METHOD_TRAIT.deepseek, rank: 1, on: true, locked: false, canUp: false, canDown: true },
      { method: "browser", label: "二狗自带的浏览器搜索", tools: webMethodTools("browser"), trait: WEB_METHOD_TRAIT.browser, rank: 2, on: true, locked: false, canUp: true, canDown: true },
      { method: "agent-browser", label: "agent-browser", tools: webMethodTools("agent-browser"), trait: WEB_METHOD_TRAIT["agent-browser"], rank: 3, on: true, locked: false, canUp: true, canDown: true },
      { method: "app-browser", label: "鸿蒙 App 的内置浏览器", tools: webMethodTools("app-browser"), trait: WEB_METHOD_TRAIT["app-browser"], rank: 4, on: true, locked: false, canUp: true, canDown: false },
    ]);
  });

  test("工具名（182 号票）：DeepSeek 和浏览器用同一对工具，靠 engine 区分；agent-browser 是 bash 里的命令；内置浏览器是 browse_* 工具", () => {
    expect(toolLine("deepseek")).toBe("`web_search`（[engine: deepseek]）、`web_fetch`（被拦时由它代读）");
    expect(toolLine("browser")).toBe("`web_search`（[engine: browser / ddg / bing / google]）、`web_fetch`（被拦时由它代读）");
    expect(toolLine("agent-browser")).toBe("bash 里的 `agent-browser` 命令");
    expect(toolLine("app-browser")).toBe("`browse_open`、`browse_read_page`、`browse_snapshot`、`browse_click`（另有 `browse_fill`、`browse_attach_files`）");
  });

  test("说明：写明不写 engine 时按队列挑、结果的标题写着用了哪种；内置浏览器只在侧边栏、悬浮按钮那一轮用，停用只是不拿它来搜索", () => {
    expect(webQueueIntro()).toContain("不写 engine 时按队列挑，每次结果的标题写着实际用了哪种");
    expect(webToolsHint()).toContain("鸿蒙 App 的内置浏览器只有");
    expect(webToolsHint()).toContain("停用了也只是不拿它来搜索");
  });

  test("不能全停：剩最后一个启用的，它的开关点不了并写明原因", () => {
    const rows = webQueueRows(view(queue(["browser", true], ["deepseek", false], ["agent-browser", false], ["app-browser", false])));
    expect(rows.map((r) => [r.method, r.on, r.locked, r.note])).toEqual([
      ["browser", true, true, "至少要留一种：这是最后一个启用的，停用不了"],
      ["deepseek", false, false, undefined],
      ["agent-browser", false, false, undefined],
      ["app-browser", false, false, undefined],
    ]);
    // 只留内置浏览器也算留了一个
    const app = webQueueRows(view(queue(["app-browser", true], ["deepseek", false], ["browser", false], ["agent-browser", false])));
    expect(app.map((r) => [r.method, r.on, r.locked])).toEqual([
      ["app-browser", true, true],
      ["deepseek", false, false],
      ["browser", false, false],
      ["agent-browser", false, false],
    ]);
  });

  test("没配 DeepSeek 的 key：那一项写明、关着、点不了（存着的不变）；剩下的启用的只有一个时它也锁住", () => {
    const rows = webQueueRows(view(queue(["deepseek", true], ["browser", true], ["agent-browser", false], ["app-browser", false]), false));
    expect(rows.map((r) => [r.method, r.on, r.locked, r.note])).toEqual([
      ["deepseek", false, true, "没配 DeepSeek 的 key，不能启用"],
      ["browser", true, true, "至少要留一种：这是最后一个启用的，停用不了"],
      ["agent-browser", false, false, undefined],
      ["app-browser", false, false, undefined],
    ]);
    // 启用的都用不上（只启用了 DeepSeek、key 又没了）：临时用浏览器，写明
    const fallback = webQueueRows(view(queue(["deepseek", true], ["browser", false], ["agent-browser", false], ["app-browser", false]), false));
    expect(fallback.map((r) => [r.method, r.on, r.locked, r.note])).toEqual([
      ["deepseek", false, true, "没配 DeepSeek 的 key，不能启用"],
      ["browser", true, true, "启用的方式都用不上（没配 DeepSeek 的 key），临时用它"],
      ["agent-browser", false, false, undefined],
      ["app-browser", false, false, undefined],
    ]);
  });

  test("改一处存整份：开关只改那一项，上移下移、拖动换位置；临时用着的浏览器一并存成启用", () => {
    const v = view(queue(["deepseek", true], ["browser", false], ["agent-browser", true], ["app-browser", true]));
    expect(withWebMethodEnabled(v, "browser", true)).toEqual(queue(["deepseek", true], ["browser", true], ["agent-browser", true], ["app-browser", true]));
    expect(withWebMethodEnabled(v, "app-browser", false)).toEqual(queue(["deepseek", true], ["browser", false], ["agent-browser", true], ["app-browser", false]));
    expect(withWebMethodMoved(v, 3, 0)).toEqual(queue(["app-browser", true], ["deepseek", true], ["browser", false], ["agent-browser", true]));
    expect(withWebMethodMoved(v, 0, 1)).toEqual(queue(["browser", false], ["deepseek", true], ["agent-browser", true], ["app-browser", true]));
    expect(withWebMethodMoved(v, 0, 0)).toEqual(v.settings);
    const fallback = view(queue(["deepseek", true], ["browser", false], ["agent-browser", false], ["app-browser", false]), false);
    expect(withWebMethodEnabled(fallback, "agent-browser", true)).toEqual(queue(["deepseek", true], ["browser", true], ["agent-browser", true], ["app-browser", false]));
  });

  test("现在的顺序：实际用的按顺序写；没配 key 时写明没用上 DeepSeek", () => {
    expect(webQueueSummary(view())).toBe("现在的顺序：DeepSeek 付费搜索 → 二狗自带的浏览器搜索 → agent-browser → 鸿蒙 App 的内置浏览器");
    expect(webQueueSummary(view(INITIAL, false))).toBe("现在的顺序：二狗自带的浏览器搜索 → agent-browser → 鸿蒙 App 的内置浏览器（没配 DeepSeek 的 key，跳过它）");
  });

  test("余额不足：写明哪天几点回的 402、这期间按顺序换了后面的；没有就不写", () => {
    expect(webBalanceText(view())).toBeUndefined();
    expect(webBalanceText(view(INITIAL, true, { deepseekBalanceLowAt: "2026-10-18T10:30:00.000+08:00" }))).toBe(
      "DeepSeek 余额不足（10-18 10:30 回的 402）：这期间联网搜索、读网页按顺序换成了后面的方式；充值后下一次就恢复",
    );
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
