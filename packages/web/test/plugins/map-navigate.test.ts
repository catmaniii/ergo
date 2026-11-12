// "用手机地图导航"（434）：Node 里能测的那部分，数据都是编的——
// - 往哪：卡片整理时算好的几处（点、路线终点、搜到的、地址；足迹没有）；
// - 交给谁：浏览器里按点所在区域、各家优先级挑第一家给得出导航网址的（默认国内高德、国外谷歌，都没开时 OpenStreetMap），三家插件真登记的网址；
// - 怎么交：新版鸿蒙 App 系统面板（拉不起来退回网址）、安卓 App geo: 交给系统、浏览器和旧版鸿蒙 App 打开网址；大陆里一律 GCJ-02；
// - 卡片上的按钮：一处直接是链接或按钮，几处先弹菜单；手机写"用手机地图导航"、电脑写"打开网页地图导航"；中英文案。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { amapBasemap, amapNavigationUrl } from "../../src/plugins/amap/basemap.ts";
import type { MapBasemapSlot } from "../../src/plugins/api.ts";
import { googleBasemap, googleNavigationUrl } from "../../src/plugins/google-maps/basemap.ts";
import { drawingContent, dayContent, shownContent } from "../../src/plugins/map/card-scene.ts";
import { MapCardView } from "../../src/plugins/map/MapCard.tsx";
import type { NavChoices } from "../../src/plugins/map/MapNavigate.tsx";
import { geoUri, type MapNavTarget, nativeTarget, navHandoff, navigationUrl, phoneUserAgent } from "../../src/plugins/map/navigate.ts";
import { osmBasemap, osmNavigationUrl } from "../../src/plugins/openstreetmap/plugin.tsx";
import { demoMapDay } from "../../src/prototype/fake-footprints.ts";
import { activeLocale, activeLocaleFrom, localDate, type MapCardPayload, type MapDrawing, type MapProviderView, setActiveLocale, shiftMapDate, wgsToGcj } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/plugins/map/MapThumb.tsx", () => ({ MapThumb: () => createElement("div", { className: "thumb-stub" }) }));
vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const zh = activeLocale();
afterEach(() => setActiveLocale(zh));

/** 杭州西湖边（大陆）、新加坡麦士威（大陆外） */
const WEST_LAKE: MapNavTarget = { lat: 30.2529, lon: 120.1529, name: "西湖边" };
const MAXWELL: MapNavTarget = { lat: 1.2803, lon: 103.8448, name: "Maxwell Food Centre" };

/** 守护进程报的三家（和真的一样：高德管国内国外、国外优先级低于谷歌；谷歌只管国外、国内能手动选；OpenStreetMap 都管、优先级最低） */
const AMAP: MapProviderView = { id: "amap", title: "高德地图", regions: ["mainland", "abroad"], manualRegions: ["mainland", "abroad"], priority: 100, regionPriority: { abroad: 40 }, ownBasemapOnly: true, basemap: true, ready: false, lookup: true };
const GOOGLE: MapProviderView = { id: "google", title: "谷歌地图", regions: ["abroad"], manualRegions: ["mainland", "abroad"], priority: 50, ownBasemapOnly: true, basemap: true, ready: false, lookup: true };
const OSM: MapProviderView = { id: "osm", title: "OpenStreetMap", regions: ["mainland", "abroad"], manualRegions: ["mainland", "abroad"], priority: 10, ownBasemapOnly: false, basemap: true, ready: true, lookup: true };
const ALL = [OSM, AMAP, GOOGLE];
/** 三家插件真登记的那几条 */
const ENTRIES: Readonly<Record<string, MapBasemapSlot>> = { osm: osmBasemap, amap: amapBasemap, google: googleBasemap() };
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const navOf = (ids: readonly string[] = Object.keys(ENTRIES)) => (id: string) => (ids.includes(id) ? ENTRIES[id]?.navigation : undefined);

describe("往哪导航", () => {
  test("秘书标的点：每个点一处（名字照点上写的，没写的不写）；路线：终点，名字用离终点最近、不到 300 米的那个标出来的点", () => {
    const points = shownContent({ kind: "points", marks: [{ id: "p1", lat: 30.25, lon: 120.14, label: "西湖" }, { id: "p2", lat: 30.2, lon: 120.1 }] });
    expect(points.targets).toEqual([{ lat: 30.25, lon: 120.14, name: "西湖" }, { lat: 30.2, lon: 120.1 }]);
    const route = shownContent({
      kind: "route",
      points: [{ lat: 30.27, lon: 120.15 }, { lat: 30.26, lon: 120.145 }],
      marks: [{ id: "r1", lat: 30.27, lon: 120.15, label: "公司" }, { id: "r2", lat: 30.2601, lon: 120.1451, label: "西湖边" }],
    });
    expect(route.targets).toEqual([{ lat: 30.26, lon: 120.145, name: "西湖边" }]);
    // 终点附近没有标出来的点：只有坐标
    const bare = shownContent({ kind: "route", points: [{ lat: 30.27, lon: 120.15 }, { lat: 30.2, lon: 120.0 }], marks: [{ id: "r1", lat: 30.27, lon: 120.15, label: "公司" }] });
    expect(bare.targets).toEqual([{ lat: 30.2, lon: 120.0 }]);
  });

  test("查到的：路线是终点（编号 to），有开车的用开车；地点是搜到的几处（附近的中心不算）；地址是那一处；足迹没有", () => {
    const route: MapDrawing = {
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
        { id: "transit", kind: "route", mode: "transit", points: [{ lat: 30.2775, lon: 120.1255 }, { lat: 30.2525, lon: 120.2055 }] },
        { id: "driving", kind: "route", mode: "driving", points: [{ lat: 30.2775, lon: 120.1255 }, { lat: 30.2525, lon: 120.2055 }] },
      ],
    };
    expect(drawingContent(route).targets).toEqual([{ lat: 30.2525, lon: 120.2055, name: "公司", mode: "driving" }]);
    expect(drawingContent({ ...route, lines: [route.lines[0]!] }).targets).toEqual([{ lat: 30.2525, lon: 120.2055, name: "公司", mode: "transit" }]);
    const places: MapDrawing = {
      ...route,
      id: "amap-p1",
      kind: "places",
      marks: [{ id: "center", lat: 30.25, lon: 120.2, label: "公司", kind: "place" }, ...["一号咖啡", "二号咖啡"].map((label, i) => ({ id: `hit-${i + 1}`, lat: 30.25 + i * 0.001, lon: 120.2, label, kind: "search" as const }))],
      lines: [],
    };
    expect(drawingContent(places).targets.map((x) => x.name)).toEqual(["一号咖啡", "二号咖啡"]);
    const address: MapDrawing = { ...places, id: "amap-a1", kind: "address", marks: [{ id: "hit-1", lat: 30.24, lon: 120.1, label: "文三路 478 号", kind: "search" }] };
    expect(drawingContent(address).targets).toEqual([{ lat: 30.24, lon: 120.1, name: "文三路 478 号" }]);
    const day = dayContent(demoMapDay(shiftMapDate(localDate(new Date()), -1)));
    if (day.state !== "ready") throw new Error("该有足迹");
    expect(day.content.targets).toEqual([]);
  });
});

describe("三家的导航网址", () => {
  test("高德：终点 GCJ-02 写\"经度,纬度,名字\"、开车 car / 公交 bus / 步行 walk、callnative=1；名字里的逗号换掉；大陆以外不给", () => {
    const gcj = wgsToGcj(WEST_LAKE);
    expect(gcj.lat).not.toBeCloseTo(WEST_LAKE.lat, 4);
    expect(amapNavigationUrl(WEST_LAKE)).toBe(`https://uri.amap.com/navigation?to=${gcj.lon.toFixed(6)},${gcj.lat.toFixed(6)},${encodeURIComponent("西湖边")}&mode=car&src=ergo&callnative=1`);
    expect(amapNavigationUrl({ ...WEST_LAKE, mode: "transit" })).toContain("&mode=bus&");
    expect(amapNavigationUrl({ ...WEST_LAKE, mode: "walking", name: undefined })).toBe(`https://uri.amap.com/navigation?to=${gcj.lon.toFixed(6)},${gcj.lat.toFixed(6)}&mode=walk&src=ergo&callnative=1`);
    expect(amapNavigationUrl({ ...WEST_LAKE, name: "A,B" })).toContain(`,${encodeURIComponent("A，B")}&`);
    expect(amapNavigationUrl(MAXWELL)).toBeUndefined();
  });

  test("谷歌：通用的 Maps URLs，终点写坐标（大陆外原样、大陆里 GCJ-02），走法同名；OpenStreetMap：网站的\"路线\"，起点空着", () => {
    expect(googleNavigationUrl(MAXWELL)).toBe("https://www.google.com/maps/dir/?api=1&destination=1.280300,103.844800&travelmode=driving");
    expect(googleNavigationUrl({ ...MAXWELL, mode: "transit" })).toContain("travelmode=transit");
    const gcj = wgsToGcj(WEST_LAKE);
    expect(googleNavigationUrl(WEST_LAKE)).toContain(`destination=${gcj.lat.toFixed(6)},${gcj.lon.toFixed(6)}`);
    expect(osmNavigationUrl(MAXWELL)).toBe("https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=%3B1.280300%2C103.844800");
    expect(osmNavigationUrl({ ...MAXWELL, mode: "walking" })).toContain("engine=fossgis_osrm_foot&");
    expect(osmNavigationUrl({ ...MAXWELL, mode: "transit" })).toBe("https://www.openstreetmap.org/directions?route=%3B1.280300%2C103.844800");
  });

  test("挑哪一家：国内高德、国外谷歌；谷歌插件停了国外用 OpenStreetMap（高德不给大陆以外的）；高德停了国内用 OpenStreetMap；几家还没取到不给", () => {
    expect(navigationUrl(WEST_LAKE, ALL, navOf())).toMatch(/^https:\/\/uri\.amap\.com\/navigation\?/);
    expect(navigationUrl(MAXWELL, ALL, navOf())).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\//);
    expect(navigationUrl(MAXWELL, ALL, navOf(["osm", "amap"]))).toMatch(/^https:\/\/www\.openstreetmap\.org\/directions\?/);
    expect(navigationUrl(WEST_LAKE, ALL, navOf(["osm", "google"]))).toMatch(/^https:\/\/www\.openstreetmap\.org\/directions\?/);
    // 只开着谷歌、点在国内：谷歌在国内只能手动选，排在后面也照样给
    expect(navigationUrl(WEST_LAKE, [GOOGLE], navOf())).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\//);
    expect(navigationUrl(WEST_LAKE, undefined, navOf())).toBeUndefined();
    expect(navigationUrl(WEST_LAKE, ALL, navOf([]))).toBeUndefined();
  });
});

describe("怎么交出去", () => {
  const url = "https://uri.amap.com/navigation?to=1,2";
  test("新版鸿蒙 App：系统面板（退路是网址）；安卓 App：geo: 交给系统；浏览器、旧版鸿蒙 App：网址；浏览器里没有网址不给按钮", () => {
    expect(navHandoff(WEST_LAKE, { app: "harmony", panel: true, phone: true }, url)).toEqual({ kind: "panel", fallback: url });
    expect(navHandoff(WEST_LAKE, { app: "harmony", panel: true, phone: true }, undefined)).toEqual({ kind: "panel" });
    expect(navHandoff(WEST_LAKE, { app: "android", panel: false, phone: true }, url)).toEqual({ kind: "system", url: geoUri(WEST_LAKE) });
    expect(navHandoff(WEST_LAKE, { app: "harmony", panel: false, phone: true }, url)).toEqual({ kind: "web", url });
    expect(navHandoff(WEST_LAKE, { app: undefined, panel: false, phone: false }, url)).toEqual({ kind: "web", url });
    expect(navHandoff(WEST_LAKE, { app: undefined, panel: false, phone: true }, undefined)).toBeUndefined();
  });

  test("geo:：大陆里 GCJ-02、大陆外原样，q 里带坐标和名字（括号换掉）；交给鸿蒙面板的也是 GCJ-02，走法不写当开车", () => {
    const gcj = wgsToGcj(WEST_LAKE);
    const at = `${gcj.lat.toFixed(6)},${gcj.lon.toFixed(6)}`;
    expect(geoUri(WEST_LAKE)).toBe(`geo:${at}?q=${at}(${encodeURIComponent("西湖边")})`);
    expect(geoUri({ lat: 1.2803, lon: 103.8448 })).toBe("geo:1.280300,103.844800?q=1.280300,103.844800");
    expect(geoUri({ ...MAXWELL, name: "Maxwell (Chinatown)" })).toContain(`(${encodeURIComponent("Maxwell  Chinatown")})`);
    expect(nativeTarget(WEST_LAKE)).toEqual({ lat: Number(gcj.lat.toFixed(6)), lon: Number(gcj.lon.toFixed(6)), name: "西湖边", mode: "driving" });
    expect(nativeTarget({ ...MAXWELL, mode: "walking" })).toEqual({ lat: 1.2803, lon: 103.8448, name: "Maxwell Food Centre", mode: "walking" });
  });

  test("手机浏览器按浏览器标识认（安卓、iPhone、鸿蒙），电脑上的 Chrome 不是", () => {
    expect(phoneUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36")).toBe(true);
    expect(phoneUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148")).toBe(true);
    expect(phoneUserAgent("Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 ArkWeb/4.1.6.1 Mobile")).toBe(true);
    expect(phoneUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36")).toBe(false);
  });
});

describe("卡片上的按钮", () => {
  const routePayload: MapCardPayload = { title: "从家到公司", show: { kind: "route", points: [{ lat: 30.27, lon: 120.15 }, { lat: 30.26, lon: 120.145 }], marks: [{ id: "r2", lat: 30.26, lon: 120.145, label: "西湖边" }] } };
  const routeContent = shownContent(routePayload.show as Extract<MapCardPayload["show"], { kind: "route" }>);
  const render = (nav: NavChoices | undefined, payload: MapCardPayload = routePayload, content = routeContent) =>
    renderToStaticMarkup(createElement(MapCardView, { cardId: "c-1", payload, data: { state: "ready", content }, nav }));
  const target = routeContent.targets[0]!;

  test("浏览器（手机）：一个新窗口打开的链接，写\"用手机地图导航\"；电脑上写\"打开网页地图导航\"", () => {
    const url = navigationUrl(target, ALL, navOf())!;
    const html = render({ items: [{ target, handoff: { kind: "web", url } }], phone: true });
    expect(html).toContain('class="map-card-acts"');
    expect(html).toContain(`<a class="map-nav-btn" data-handoff="web" href="${url.replaceAll("&", "&amp;")}" target="_blank" rel="noopener noreferrer">`);
    expect(textOf(html)).toContain("用手机地图导航");
    expect(textOf(render({ items: [{ target, handoff: { kind: "web", url } }], phone: false }))).toContain("打开网页地图导航");
    expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("安卓 App：geo: 链接，不开新窗口；新版鸿蒙 App：一个按钮（点了拉系统面板）", () => {
    const geo = render({ items: [{ target, handoff: { kind: "system", url: geoUri(target) } }], phone: true });
    expect(geo).toMatch(/<a class="map-nav-btn" data-handoff="system" href="geo:[^"]+">/);
    expect(geo).not.toContain('target="_blank"');
    const panel = render({ items: [{ target, handoff: { kind: "panel" } }], phone: true });
    expect(panel).toContain('<button type="button" class="map-nav-btn" data-handoff="panel">');
  });

  test("几处：一个按钮，点了弹菜单挑去哪一处（菜单开着之前不画）；没有能去的、没给的不画按钮", () => {
    const points: MapCardPayload = { show: { kind: "points", marks: [{ id: "p1", lat: 30.25, lon: 120.14, label: "西湖" }, { id: "p2", lat: 30.24, lon: 120.1 }] } };
    const content = shownContent(points.show as Extract<MapCardPayload["show"], { kind: "points" }>);
    const items = content.targets.map((t) => ({ target: t, handoff: { kind: "web" as const, url: navigationUrl(t, ALL, navOf())! } }));
    const html = render({ items, phone: true }, points, content);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("map-nav-menu");
    expect(render({ items: [], phone: true })).not.toContain("map-nav-btn");
    expect(render(undefined)).not.toContain("map-card-acts");
  });

  test("英文", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    const url = navigationUrl(target, ALL, navOf())!;
    expect(textOf(render({ items: [{ target, handoff: { kind: "web", url } }], phone: true }))).toContain("Navigate in a maps app");
    expect(textOf(render({ items: [{ target, handoff: { kind: "web", url } }], phone: false }))).toContain("Get directions on the web");
  });
});
