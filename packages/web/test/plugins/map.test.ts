// 地图插件的网页这一半（429）：Node 里能测的那部分——
// - 瓦片的算术（Web 墨卡托：世界坐标、一屏要哪些瓦片、横着绕地球一圈、一像素多少米）；
// - 一屏用哪种底图：大陆里、高德能用才用高德，国外、香港、没填 Key 用 OpenStreetMap（455 起地图插件不认得哪一家：这里按插槽报的
//   两家挑，高德只管大陆的样子，和 429 一样）；
// - 记住的上次看的地方坏了不用；一组点都看得见的视野；
// - 高德那一种进出都转坐标：交给高德的是 GCJ-02，从高德拿回的转回 WGS-84（大陆外不转）；
// - 设置 · 数据源里高德地图那一块：三个密码框、不回显、按钮的字、测完说一句；
// - 插件登记了地图页（导航里排在记忆后面、设置前面）；455 起高德地图那一块是高德地图插件的，三家底图各一个插件；
//   界面文字里没有"秘书""待我处理"。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { AmapPanelView, type AmapPanelViewProps, amapResultOf } from "../../src/plugins/amap/AmapPanel.tsx";
import { type AmapNamespace, createAmapEngine } from "../../src/plugins/amap/amap-engine.ts";
import { amapWebPlugin } from "../../src/plugins/amap/plugin.tsx";
import type { MapSurfaceView } from "../../src/plugins/map/engine.ts";
import { mapWebPlugin } from "../../src/plugins/map/plugin.tsx";
import { EVERY_BASEMAP, pickBasemap } from "../../src/plugins/map/providers.ts";
import { FOOTPRINTS_ON_CURRENT_MAP, clampZoom, DEFAULT_VIEW, type MapView, parseSavedView, viewToFit } from "../../src/plugins/map/scene.ts";
import { openStreetMapWebPlugin } from "../../src/plugins/openstreetmap/plugin.tsx";
import { metersPerPixel, pointAt, pointOnScreen, screenPoint, tilesFor, worldPoint } from "../../src/plugins/map/tiles.ts";
import { createWebPluginHost } from "../../src/plugins/host.ts";
import { WEB_PLUGIN_MANIFEST } from "../../src/plugins/manifest.ts";
import { type DataSourcesView, type DataSourceView, distanceMeters, type MapProviderView, mapRegionOf, navItemsFor, wgsToGcj } from "../../src/state/index.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const at = (lat: number, lon: number) => ({ lat, lon });
const HANGZHOU = at(30.2741, 120.1551);
const SINGAPORE = at(1.2834, 103.8607);
const HONG_KONG = at(22.2819, 114.1586);

/** 429 那时的两家（插槽报的样子）：高德只管大陆、要填 Key；OpenStreetMap 哪儿都管 */
const twoProviders = (amapReady: boolean): MapProviderView[] => [
  { id: "amap", title: "高德地图", regions: ["mainland"], manualRegions: ["mainland"], priority: 100, ownBasemapOnly: true, basemap: true, ready: amapReady, lookup: false, ...(amapReady ? { key: "k" } : {}) },
  { id: "osm", title: "OpenStreetMap", regions: ["mainland", "abroad"], manualRegions: ["mainland", "abroad"], priority: 0, ownBasemapOnly: false, basemap: true, ready: true, lookup: false },
];
/** 这一屏用哪一家（455 以前是 scene.ts 的 chooseBasemap；地图插件不再认得哪一家，照插槽报的挑） */
const chooseBasemap = (v: Pick<MapView, "lat" | "lon">, amapUsable: boolean, footprints = false) => pickBasemap({ region: mapRegionOf(v), providers: twoProviders(amapUsable), page: EVERY_BASEMAP, footprints }).wanted;

describe("瓦片的算术", () => {
  test("世界坐标：第 0 级整个世界 256 像素，(0,0) 在正中；来回换算回得来", () => {
    expect(worldPoint(at(0, 0), 0)).toEqual({ x: 128, y: 128 });
    for (const p of [HANGZHOU, SINGAPORE, at(-33.86, 151.21), at(64.1, -21.9)]) {
      const w = worldPoint(p, 13.4);
      const back = pointAt(w.x, w.y, 13.4);
      expect(distanceMeters(back, p)).toBeLessThan(0.01);
    }
  });

  test("一屏要哪些瓦片：取最近的整数级，只要看得见的；横着绕一圈（列号取模），竖着不绕", () => {
    const { z, tiles } = tilesFor(at(0, 0), 2, 512, 512, 19);
    expect(z).toBe(2);
    expect(tiles.map((t) => t.key)).toEqual(["2/1/1", "2/2/1", "2/3/1", "2/1/2", "2/2/2", "2/3/2", "2/1/3", "2/2/3", "2/3/3"]);
    // 2.4 级取第 2 级的瓦片（放大着画），2.6 级取第 3 级
    expect(tilesFor(HANGZHOU, 2.4, 390, 700, 19).z).toBe(2);
    expect(tilesFor(HANGZHOU, 2.6, 390, 700, 19).z).toBe(3);
    // 超过瓦片的最高级就用最高级的放大
    expect(tilesFor(HANGZHOU, 20, 390, 700, 19).z).toBe(19);
    // 跨 180 度经线：列号取模到 0..2^z-1
    const wrap = tilesFor(at(10, 179.9), 1, 600, 200, 19);
    const row = wrap.tiles.filter((t) => t.y === wrap.tiles[0]!.y).map((t) => [t.x, t.wrappedX]);
    expect(row).toEqual([
      [0, 0],
      [1, 1],
      [2, 0],
      [3, 1],
    ]);
    // 两极外面没有瓦片
    expect(tilesFor(at(85, 0), 3, 400, 2000, 19).tiles.every((t) => t.y >= 0 && t.y < 8)).toBe(true);
  });

  test("屏幕位置：中心在正中；跨 180 度经线的点画在近的那一边；屏幕位置换回点", () => {
    expect(screenPoint(HANGZHOU, HANGZHOU, 12, 400, 600)).toEqual({ x: 200, y: 300 });
    const near = screenPoint(at(0, -179.9), at(0, 179.9), 5, 400, 400);
    expect(Math.abs(near.x - 200)).toBeLessThan(10);
    const p = pointOnScreen(250, 120, HANGZHOU, 14, 400, 600);
    const s = screenPoint(p, HANGZHOU, 14, 400, 600);
    expect(Math.abs(s.x - 250) + Math.abs(s.y - 120)).toBeLessThan(1e-6);
  });

  test("一像素多少米：赤道第 0 级约 156 公里，纬度越高越少", () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(156543.03, 1);
    expect(metersPerPixel(60, 10)).toBeCloseTo(metersPerPixel(0, 10) / 2, 5);
  });
});

describe("一屏用哪种底图", () => {
  test("大陆里、高德能用：高德；没填 Key、高德加载不上：OpenStreetMap", () => {
    expect(chooseBasemap(HANGZHOU, true)).toBe("amap");
    expect(chooseBasemap(HANGZHOU, false)).toBe("osm");
  });

  test("国外、香港：一律 OpenStreetMap（那里 GCJ-02 等于 WGS-84，OSM 的瓦片和二狗的点对得上）", () => {
    expect(chooseBasemap(SINGAPORE, true)).toBe("osm");
    expect(chooseBasemap(HONG_KONG, true)).toBe("osm");
  });

  test("画着用户自己的足迹：451 起也用当前地图（用户 2026-11-09 定，改了 11-07 的一律 OpenStreetMap）——大陆里高德能用就是高德", () => {
    expect(FOOTPRINTS_ON_CURRENT_MAP).toBe(true);
    expect(chooseBasemap(HANGZHOU, true, true)).toBe("amap");
    expect(chooseBasemap(HANGZHOU, false, true)).toBe("osm");
  });
});

describe("看哪里", () => {
  test("记住的上次看的地方：坏了、超出范围的不用；级别收进能看的范围", () => {
    expect(parseSavedView(JSON.stringify({ lat: 30.27, lon: 120.15, zoom: 14 }))).toEqual({ lat: 30.27, lon: 120.15, zoom: 14 });
    expect(parseSavedView(JSON.stringify({ lat: 30.27, lon: 120.15, zoom: 21 }))).toEqual({ lat: 30.27, lon: 120.15, zoom: 19 });
    for (const bad of [null, "", "{", "[]", JSON.stringify({ lat: 99, lon: 0, zoom: 3 }), JSON.stringify({ lat: "30", lon: 120, zoom: 3 })]) expect(parseSavedView(bad)).toBeUndefined();
    expect(clampZoom(1)).toBe(3);
    expect(DEFAULT_VIEW.zoom).toBe(4);
  });

  test("一组点都看得见：中心在中间，级别够把两头都放进去；一个点给 15 级；没有点给 undefined", () => {
    const shanghai = at(31.2304, 121.4737);
    const v = viewToFit([HANGZHOU, shanghai], 390, 700)!;
    expect(v.lat).toBeGreaterThan(HANGZHOU.lat);
    expect(v.lat).toBeLessThan(shanghai.lat);
    for (const p of [HANGZHOU, shanghai]) {
      const s = screenPoint(p, v, v.zoom, 390, 700);
      expect(s.x).toBeGreaterThan(0);
      expect(s.x).toBeLessThan(390);
    }
    expect(viewToFit([HANGZHOU], 390, 700)).toEqual({ ...HANGZHOU, zoom: 15 });
    expect(viewToFit([], 390, 700)).toBeUndefined();
  });
});

describe("高德那一种：进出都转坐标；453 起只出底图", () => {
  /** 一个最小的假 AMap（只记下中心）和一个最小的假宿主元素：Node 里没有 DOM */
  function fakeAmap() {
    const seen: { center?: [number, number]; zoom?: number } = {};
    class FakeMap {
      constructor(_el: unknown, options: Record<string, unknown>) {
        seen.center = options.center as [number, number];
        seen.zoom = options.zoom as number;
      }
      getCenter() {
        return { getLng: () => seen.center![0], getLat: () => seen.center![1] };
      }
      getZoom() {
        return seen.zoom!;
      }
      setZoomAndCenter(zoom: number, center: [number, number]) {
        seen.zoom = zoom;
        seen.center = center;
      }
      setZoom() {}
      setCenter(center: [number, number]) {
        seen.center = center;
      }
      setMapStyle() {}
      on() {}
      destroy() {}
    }
    return { ns: { Map: FakeMap } as unknown as AmapNamespace, seen };
  }
  const doc = { createElement: () => ({ className: "", dataset: {}, clientWidth: 400, clientHeight: 300, remove() {}, append() {}, addEventListener() {} }), defaultView: { requestAnimationFrame: () => 1, cancelAnimationFrame() {} } };
  const host = { ownerDocument: doc, append() {} } as unknown as HTMLElement;
  const events = { onMoveEnd() {} };

  test("大陆里：交给高德的是 GCJ-02（偏几百米），拿回来的转回 WGS-84（差不到 1 米）", () => {
    const { ns, seen } = fakeAmap();
    const engine = createAmapEngine(host, ns, { view: { ...HANGZHOU, zoom: 14 }, dark: false, ...events });
    const gcj = wgsToGcj(HANGZHOU);
    expect(seen.center).toEqual([gcj.lon, gcj.lat]);
    expect(distanceMeters(at(seen.center![1], seen.center![0]), HANGZHOU)).toBeGreaterThan(100);
    const back = engine.view();
    expect(distanceMeters(back, HANGZHOU)).toBeLessThan(1);
    expect(back.zoom).toBe(14);
    engine.setView({ lat: 31.2304, lon: 121.4737, zoom: 12 });
    expect(distanceMeters(engine.view(), at(31.2304, 121.4737))).toBeLessThan(1);
  });

  test("大陆外：原样交给高德", () => {
    const { ns, seen } = fakeAmap();
    createAmapEngine(host, ns, { view: { ...SINGAPORE, zoom: 14 }, dark: false, ...events });
    expect(seen.center).toEqual([SINGAPORE.lon, SINGAPORE.lat]);
  });

  test("只出底图：没有 setScene（足迹、点、线不交给高德）；一建好就报此刻画着哪一片（高德的坐标、datum gcj02、底图的大小）；按住点拖时 panBy 挪中心", () => {
    const { ns, seen } = fakeAmap();
    const surfaces: MapSurfaceView[] = [];
    const engine = createAmapEngine(host, ns, { view: { ...HANGZHOU, zoom: 14 }, dark: false, ...events, onSurface: (v: MapSurfaceView) => surfaces.push(v) });
    expect(engine.setScene).toBeUndefined();
    const gcj = wgsToGcj(HANGZHOU);
    expect(surfaces[0]).toEqual({ lat: gcj.lat, lon: gcj.lon, zoom: 14, width: 400, height: 300, datum: "gcj02" });
    // 往右拖 256 像素：第 14 级里中心往西挪 256 / (256·2^14) 圈
    engine.panBy!(256, 0);
    expect(seen.center![0]).toBeCloseTo(gcj.lon - 360 / 2 ** 14, 9);
    expect(seen.center![1]).toBeCloseTo(gcj.lat, 9);
    expect(surfaces.at(-1)!.lon).toBeCloseTo(gcj.lon - 360 / 2 ** 14, 9);
  });

  // 458：捏合到一半级别带小数；高德 2.0 的 getZoom() 默认只留 2 位，离中心远的点会差一两个像素
  test("捏合途中报给那一层的级别要够准（getZoom 默认只留两位，要 6 位）；松手、双击也叫醒（松手后高德还在滑、在放大）", () => {
    const { ns, seen } = fakeAmap();
    const Base = (ns as unknown as { Map: new (el: unknown, o: Record<string, unknown>) => object }).Map;
    class Rounding extends Base {
      getZoom(digits = 2) {
        return Number(seen.zoom!.toFixed(digits));
      }
    }
    const listened: string[] = [];
    const frames: Array<() => void> = [];
    const doc2 = {
      createElement: () => ({ className: "", dataset: {}, clientWidth: 400, clientHeight: 300, remove() {}, append() {}, addEventListener: (type: string) => listened.push(type) }),
      defaultView: { requestAnimationFrame: (fn: () => void) => frames.push(fn), cancelAnimationFrame() {} },
    };
    const host2 = { ownerDocument: doc2, append() {} } as unknown as HTMLElement;
    const surfaces: MapSurfaceView[] = [];
    createAmapEngine(host2, { Map: Rounding } as unknown as AmapNamespace, { view: { ...HANGZHOU, zoom: 14 }, dark: false, ...events, onSurface: (v: MapSurfaceView) => surfaces.push(v) });
    seen.zoom = 14.123456789;
    for (const fn of frames.splice(0)) fn();
    expect(surfaces.at(-1)!.zoom).toBeCloseTo(14.123457, 6);
    for (const e of ["touchend", "touchcancel", "pointerup", "pointercancel", "dblclick"]) expect(listened).toContain(e);
  });
});

function amapSource(extra: Partial<DataSourceView> = {}): DataSourceView {
  return {
    id: "amap",
    title: "高德地图",
    plugin: "map",
    pluginTitle: "地图",
    summary: "填了 Key，地图页在国内用高德地图",
    available: true,
    connection: "not_connected",
    usages: [],
    sensitive: [],
    count: 0,
    syncing: false,
    canSync: false,
    files: [],
    configurable: true,
    ...extra,
  };
}
const view = (s: DataSourceView): DataSourcesView => ({ sources: [s], folder: { path: "x", importedPath: "x/imported", pending: [], recent: [] } });
const noop = () => {};
const renderPanel = (props: Partial<AmapPanelViewProps> = {}) =>
  renderToStaticMarkup(createElement(AmapPanelView, { source: amapSource(), values: { jsKey: "", securityCode: "", serviceKey: "" }, busy: false, result: undefined, onValue: noop, onSubmit: noop, ...props }));

describe("设置 · 数据源 · 高德地图那一块", () => {
  test("没填过：三个密码框（Web 端 Key、安全密钥、Web 服务 Key 选填），按钮\"测试并保存\"先灰着；说明里写 Key 在哪建、只存在这台电脑上、地图服务看得到什么", () => {
    const html = renderPanel();
    expect(html.match(/type="password"/g)).toHaveLength(3);
    expect(html).toContain("Web 端（JS API）Key");
    expect(html).toContain("安全密钥");
    expect(html).toContain("选填");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>测试并保存<\/button>/);
    expect(html).toContain("在高德开放平台的控制台建");
    expect(html).toContain("只存在这台电脑上");
    expect(html).toContain("足迹、二狗画的点和线只在这台设备上画在高德地图上面，不交给高德；聊天卡片的预览图只向高德要那一片的底图");
    expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("填了：按钮能点；存过的不填是\"再测一次\"，框里写沿用存着的", () => {
    expect(renderPanel({ values: { jsKey: "k", securityCode: "s", serviceKey: "" } })).toMatch(/<button[^>]*>测试并保存<\/button>/);
    const saved = renderPanel({ source: amapSource({ connection: "connected", account: "地图：已填 · 查地点和路线：没填" }) });
    expect(saved).toContain("再测一次");
    expect(saved).toContain("不改就留空（沿用存着的）");
  });

  test("测完说一句：连着、没问题是\"测过了\"带两组各填了没有，否则写原因", () => {
    expect(amapResultOf(view(amapSource({ connection: "connected", account: "地图：已填 · 查地点和路线：没填" })), "amap")).toEqual({ ok: true, text: "测过了，存好了：地图：已填 · 查地点和路线：没填" });
    expect(amapResultOf(view(amapSource({ connection: "error", problem: "地图：高德不认这个 Key" })), "amap")).toEqual({ ok: false, text: "没通过：地图：高德不认这个 Key" });
  });
});

describe("插件登记的", () => {
  test("地图页（导航里排在记忆后面、设置前面，收进\"更多\"时有返回）、高德地图那一块、聊天里的地图卡片（431）", () => {
    const host = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, log: noop });
    host.apply(undefined);
    expect(host.ownerOf("pages", "map")?.name).toBe("map");
    // 455：高德地图那一块是高德地图插件的
    expect(host.ownerOf("dataSources", "amap")?.name).toBe("amap");
    const page = host.get("pages", "map")!;
    expect({ order: page.order, icon: page.icon, navLabel: page.navLabel, title: page.title, column: typeof page.Column }).toEqual({ order: 85, icon: "map", navLabel: "地图", title: "地图", column: "function" });
    expect(navItemsFor({ browse: false, plugins: host.list("pages") }).slice(-3)).toEqual(["memory", "map", "settings"]);
    expect(host.ownerOf("cards", "map")?.name).toBe("map");
    // 455：地图插件自己不带哪一家；三家各一个插件，照"地图服务"插槽登记（mapBasemaps）
    expect(mapWebPlugin.owns).toEqual({ pages: ["map"], cards: ["map"] });
    expect(openStreetMapWebPlugin.owns).toEqual({ mapBasemaps: ["osm"] });
    expect(amapWebPlugin.owns).toEqual({ dataSources: ["amap"], mapBasemaps: ["amap"] });
    expect(host.list("mapBasemaps").map((b) => [b.id, b.title, b.tiles === undefined ? "prepare" : "tiles"])).toEqual([
      ["osm", "OpenStreetMap", "tiles"],
      ["amap", "高德地图", "prepare"],
      ["google", "谷歌地图", "prepare"],
    ]);
    expect(host.ownerOf("mapBasemaps", "osm")?.name).toBe("openstreetmap");
    expect(host.ownerOf("mapBasemaps", "amap")?.name).toBe("amap");
  });
});
