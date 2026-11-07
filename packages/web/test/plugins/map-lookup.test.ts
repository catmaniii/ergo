// 设置 · 数据源 · 高德地图那一块里的"试查一下"（432，AmapTry.tsx），Node 里直接渲染：
// - 没填 Web 服务 Key：按钮灰着、写一句先填；填了：按钮能点，写这个月的用量；
// - 查到了：写查的是什么（固定的地点）、列出搜到的、数据来自高德和用量；没查成写原因；
// - 放在填 Key 那一块的说明前面；守护进程没带这一块要的（没连上）时不画；
// - 界面文字里没有"秘书""待我处理"。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { AmapPanelView } from "../../src/plugins/map/AmapPanel.tsx";
import { AmapTryView, type AmapTryViewProps } from "../../src/plugins/map/AmapTry.tsx";
import { type AmapSourcePanel, type DataSourceView, isAmapSourcePanel } from "../../src/state/index.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const noop = () => {};
const PANEL: AmapSourcePanel = { kind: "amap", lookup: true, usage: { month: "2026-11", search: 37, lbs: 212, searchLimit: 5000, lbsLimit: 150000 } };
const render = (props: Partial<AmapTryViewProps> = {}) => renderToStaticMarkup(createElement(AmapTryView, { panel: PANEL, busy: false, result: undefined, failed: undefined, onTry: noop, ...props }));

describe("试查一下", () => {
  test("没填 Web 服务 Key：按钮灰着，写一句先填；用量照写", () => {
    const html = render({ panel: { ...PANEL, lookup: false } });
    expect(html).toContain("试查一下");
    expect(html).toContain("填好 Web 服务 Key（测试并保存）以后才能试查");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>试查一下<\/button>/);
    expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("填了：按钮能点，写搜的是固定的地点、这个月的用量", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*data-action="amap-try"[^>]*>试查一下<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled/);
    expect(html).toContain("北京的天安门，不是你的位置");
    expect(html).toContain("这个月已查：搜地点 37 / 5000 次，地址和路线 212 / 150000 次");
    expect(render({ busy: true })).toMatch(/<button[^>]*disabled=""[^>]*>正在查…<\/button>/);
  });

  test("查到了：列出搜到的，写数据来自高德和查完时的用量（不再写那块里的旧用量）", () => {
    const html = render({
      result: {
        state: "ok",
        at: "2026-11-07T09:00:00.000+08:00",
        scope: "试查：在北京搜「天安门」（固定的词，不是你的位置）",
        items: [{ id: "B0FAKE", title: "示例广场", subtitle: "北京市东城区 · 示例长安街 1 号 · 风景名胜" }],
        notes: ["通了：查地点、算路线能用。数据来自高德，现查的，不存", "这个月已查：搜地点 38 / 5000 次，地址和路线 212 / 150000 次"],
      },
    });
    expect(html).toContain('data-amap-try-state="ok"');
    expect(html).toContain("示例广场");
    expect(html).toContain("北京市东城区 · 示例长安街 1 号 · 风景名胜");
    expect(html).toContain("数据来自高德");
    expect(html).toContain("搜地点 38 / 5000 次");
    expect(html).not.toContain("搜地点 37 / 5000 次");
  });

  test("没查成：写原因（守护进程给的，或者请求本身没成）", () => {
    const failed = render({ result: { state: "error", at: "2026-11-07T09:00:00.000+08:00", items: [], problem: "高德说用量到上限了（USER_DAILY_QUERY_OVER_LIMIT 10044）" } });
    expect(failed).toContain('data-amap-try-state="error"');
    expect(failed).toContain("没查成：高德说用量到上限了（USER_DAILY_QUERY_OVER_LIMIT 10044）");
    expect(render({ failed: "连不上" })).toContain("没查成：连不上");
  });

  test("放在填 Key 那一块的说明前面；认得守护进程带来的那一块数据", () => {
    const source: DataSourceView = {
      id: "amap",
      title: "高德地图",
      summary: "填了 Key，地图页在国内用高德地图",
      plugin: "map",
      pluginTitle: "地图",
      available: true,
      connection: "connected",
      account: "地图：已填 · 查地点和路线：已填",
      usages: [{ usage: "query", on: true }],
      sensitive: [],
      count: 0,
      syncing: false,
      canSync: false,
      files: [],
      configurable: true,
      panel: PANEL,
    };
    const html = renderToStaticMarkup(
      createElement(AmapPanelView, { source, values: { jsKey: "", securityCode: "", serviceKey: "" }, busy: false, result: undefined, onValue: noop, onSubmit: noop, extra: createElement(AmapTryView, { panel: PANEL, busy: false, result: undefined, failed: undefined, onTry: noop }) }),
    );
    expect(html.indexOf("data-amap-try")).toBeGreaterThan(html.indexOf("测试并保存") === -1 ? html.indexOf("再测一次") : html.indexOf("测试并保存"));
    expect(html.indexOf("data-amap-try")).toBeLessThan(html.indexOf("source-notes"));
    expect(isAmapSourcePanel(PANEL)).toBe(true);
    expect(isAmapSourcePanel({ kind: "phone-places" })).toBe(false);
    expect(isAmapSourcePanel(undefined)).toBe(false);
  });
});
