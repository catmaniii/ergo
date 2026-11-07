// 聊天里的地图卡片（431）：Node 里能测的那部分，数据都是编的——
// - 卡片画什么（card-scene.ts）：某一天的足迹（整理一天那一份、概况和去过的几处，算用户自己的足迹）、秘书给的点和路线、
//   查地点和路线查到的那一份（OpenStreetMap 查来的照常画缩略图；高德查来的只能画在高德地图上，amapOnly）；写明数据来自哪家；
// - 卡片画出来的样子（MapCardView，缩略图换成占位：它要浏览器）：足迹卡有缩略图、点开去 #/more/map/<日期>；高德查来的没有缩略图、
//   有"在高德地图上看"去 #/more/map/card/<编号>；取着、取不到、这一天空着写一句；中英文案走 t()，没有"秘书""待我处理"；
// - 原型里的两张卡（昨天的足迹、从公司到西湖边）对得上原型的假足迹和假路线。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { dayContent, drawingContent, type MapCardData, shownContent } from "../../src/plugins/map/card-scene.ts";
import { MapCardView } from "../../src/plugins/map/MapCard.tsx";
import { FAKE_CARDS } from "../../src/prototype/fake-conversations.ts";
import { demoMapDay } from "../../src/prototype/fake-footprints.ts";
import { demoMapDrawing } from "../../src/prototype/fake-map.ts";
import { activeLocale, activeLocaleFrom, localDate, type MapCardPayload, type MapDrawing, setActiveLocale, shiftMapDate } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

// 缩略图要浏览器（瓦片、DOM 里的地图）：这里换成一个占位，只看卡片别的部分
vi.mock("../../src/plugins/map/MapThumb.tsx", () => ({ MapThumb: () => createElement("div", { className: "thumb-stub" }) }));
vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const zh = activeLocale();
afterEach(() => setActiveLocale(zh));

const yesterday = shiftMapDate(localDate(new Date()), -1);

const AMAP_ROUTE: MapDrawing = {
  id: "amap-r1",
  kind: "route",
  source: "amap",
  title: "从家到公司",
  at: "2026-11-07T08:52:00.000+08:00",
  marks: [
    { id: "from", lat: 30.2775, lon: 120.1255, label: "家", kind: "place" },
    { id: "to", lat: 30.2525, lon: 120.2055, label: "公司", kind: "place" },
  ],
  lines: [
    { id: "driving", kind: "route", mode: "driving", points: [{ lat: 30.2775, lon: 120.1255 }, { lat: 30.2525, lon: 120.2055 }] },
    { id: "transit", kind: "route", mode: "transit", points: [{ lat: 30.2775, lon: 120.1255 }, { lat: 30.26, lon: 120.19 }, { lat: 30.2525, lon: 120.2055 }] },
  ],
};

const COFFEE: MapDrawing = {
  id: "amap-p1",
  kind: "places",
  source: "amap",
  title: "公司附近的「咖啡」",
  at: "2026-11-07T08:52:00.000+08:00",
  marks: [
    { id: "here", lat: 30.2525, lon: 120.2055, label: "公司", kind: "place" },
    ...["一号咖啡", "二号咖啡", "三号咖啡", "四号咖啡", "五号咖啡"].map((label, i) => ({ id: `s${i}`, lat: 30.25 + i * 0.001, lon: 120.2, label, kind: "search" as const })),
  ],
  lines: [],
};

const render = (cardId: string, payload: MapCardPayload, data: MapCardData) => renderToStaticMarkup(createElement(MapCardView, { cardId, payload, data }));
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("卡片画什么", () => {
  test("某一天的足迹：整理一天那一份（停留、照片、轨迹、范围圈）、概况、按先后去过的几处；算用户自己的足迹（挑底图一律 OpenStreetMap）", () => {
    const data = dayContent(demoMapDay(yesterday));
    if (data.state !== "ready") throw new Error("该有足迹");
    expect(data.content.footprints).toBe(true);
    expect(data.content.amapOnly).toBe(false);
    expect(data.content.scene.marks.filter((m) => m.kind === "stay")).toHaveLength(3);
    expect(data.content.scene.lines).toHaveLength(1);
    expect(data.content.lines).toEqual(["待过 3 个地方 · 6 张照片", "家、公司、杭州市西湖区北山街"]);
    expect(data.content.bounds.length).toBeGreaterThan(10);
    expect(dayContent(demoMapDay(localDate(new Date())))).toEqual({ state: "empty", text: "这一天没有足迹" });
  });

  test("秘书给的点和路线：点标出来、名字列一行；路线画一条线、写起点 → 终点", () => {
    const points = shownContent({ kind: "points", marks: [{ id: "p1", lat: 30.25, lon: 120.14, label: "西湖" }, { id: "p2", lat: 30.24, lon: 120.1, label: "灵隐寺" }, { id: "p3", lat: 30.2, lon: 120.1 }] });
    expect(points.scene.marks.map((m) => [m.id, m.kind, m.label])).toEqual([
      ["card-p1", "place", "西湖"],
      ["card-p2", "place", "灵隐寺"],
      ["card-p3", "place", undefined],
    ]);
    expect(points.lines).toEqual(["西湖、灵隐寺"]);
    expect(points.footprints).toBe(false);
    const route = shownContent({ kind: "route", points: [{ lat: 30.27, lon: 120.15 }, { lat: 30.26, lon: 120.145 }], marks: [{ id: "r1", lat: 30.27, lon: 120.15, label: "公司" }, { id: "r2", lat: 30.26, lon: 120.145, label: "西湖边" }] });
    expect(route.scene.lines).toEqual([{ id: "card-route", points: [{ lat: 30.27, lon: 120.15 }, { lat: 30.26, lon: 120.145 }], kind: "route" }]);
    expect(route.lines).toEqual(["公司 → 西湖边"]);
    expect(route.amapOnly).toBe(false);
  });

  test("查到的那一份：写走法、数据来自哪家；高德查来的只能画在高德地图上，OpenStreetMap 查来的照常画", async () => {
    const amap = drawingContent(AMAP_ROUTE);
    expect(amap.amapOnly).toBe(true);
    expect(amap.lines).toEqual(["开车、公交", "数据来自高德地图"]);
    expect(amap.scene.lines.map((l) => l.kind)).toEqual(["route", "route"]);
    expect(amap.bounds).toHaveLength(2 + 2 + 3);
    const coffee = drawingContent(COFFEE);
    expect(coffee.lines).toEqual(["一号咖啡、二号咖啡、三号咖啡、四号咖啡 等 5 处", "数据来自高德地图"]);
    expect(coffee.scene.marks.filter((m) => m.kind === "search")).toHaveLength(5);
    const osm = drawingContent(await demoMapDrawing("osm-r1"));
    expect(osm.amapOnly).toBe(false);
    expect(osm.lines).toEqual(["步行、开车", "数据来自 OpenStreetMap"]);
  });
});

describe("卡片画出来的样子", () => {
  const day: MapCardPayload = { show: { kind: "day", date: "2026-11-06" } };
  const amapRoute: MapCardPayload = { title: "从家到公司", show: { kind: "lookup", lookup: "amap-r1", what: "route", source: "amap" } };

  test("足迹卡：标题按日期起，缩略图点开去 #/more/map/<日期>，下面写概况和去过的几处", () => {
    const data = dayContent(demoMapDay(yesterday));
    const html = render("c-1", day, data);
    expect(html).toContain('data-show="day"');
    expect(html).toContain("thumb-stub");
    expect(html).toContain('href="#/more/map/2026-11-06"');
    expect(textOf(html)).toContain("地图 11 月 6 日去过的地方");
    expect(textOf(html)).toContain("看大地图");
    expect(textOf(html)).toContain("家、公司、杭州市西湖区北山街");
    expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("高德查来的路线：不画缩略图，写走法、数据来自高德地图，\"在高德地图上看\"去 #/more/map/card/<编号>", () => {
    const html = render("c-2", amapRoute, { state: "ready", content: drawingContent(AMAP_ROUTE) });
    expect(html).not.toContain("map-card-thumb");
    expect(html).not.toContain("thumb-stub");
    expect(html).toContain('href="#/more/map/card/c-2"');
    expect(textOf(html)).toContain("从家到公司");
    expect(textOf(html)).toContain("开车、公交");
    expect(textOf(html)).toContain("数据来自高德地图");
    expect(textOf(html)).toContain("在高德地图上看");
  });

  test("取着、取不到（过期了）、这一天空着：写一句，没有缩略图；高德的过期了也没有\"在高德地图上看\"", () => {
    expect(textOf(render("c-1", day, { state: "loading" }))).toContain("正在取…");
    expect(textOf(render("c-1", day, { state: "empty", text: "这一天没有足迹" }))).toContain("这一天没有足迹");
    const gone = render("c-2", amapRoute, { state: "failed", text: "这次查到的地点和路线已经过期了" });
    expect(textOf(gone)).toContain("已经过期了");
    expect(gone).not.toContain("在高德地图上看");
    expect(gone).not.toContain("thumb-stub");
  });

  test("英文", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    const html = render("c-1", day, dayContent(demoMapDay(yesterday)));
    expect(textOf(html)).toContain("Where you went on 11/6");
    expect(textOf(html)).toContain("Open map");
    expect(textOf(render("c-2", amapRoute, { state: "ready", content: drawingContent(AMAP_ROUTE) }))).toContain("Data from AMap");
  });
});

describe("原型里的两张地图卡", () => {
  test("昨天的足迹（画得出原型的假足迹）、从公司到西湖边（OpenStreetMap 查的、取得到原型的假路线），都是已处理", async () => {
    const cards = FAKE_CARDS.filter((c) => c.type === "map");
    expect(cards.map((c) => [c.id, c.status])).toEqual([
      ["c-map-day", "handled"],
      ["c-map-route", "handled"],
    ]);
    expect(cards[0]!.payload).toEqual({ show: { kind: "day", date: yesterday } });
    expect(dayContent(demoMapDay(yesterday)).state).toBe("ready");
    const route = cards[1]!.payload as MapCardPayload;
    if (route.show.kind !== "lookup") throw new Error("该是查到的路线");
    expect((await demoMapDrawing(route.show.lookup)).source).toBe("osm");
    await expect(demoMapDrawing("amap-r1")).rejects.toThrow("已经过期了");
  });
});
