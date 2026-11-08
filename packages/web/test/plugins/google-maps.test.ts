// 谷歌地图插件的网页这一半（446）：Node 里能测的那部分（不连真的谷歌，加载器、谷歌都是假的）——
// - 谷歌那一种引擎进出都转坐标：大陆里交给谷歌的是 GCJ-02，拿回来的转回 WGS-84，大陆外原样；线、圈同样转；
//   只要地图本身（不要谷歌自带的按钮、不让点谷歌的兴趣点）；每建一张谷歌地图报一次 loaded，换深浅色重建一次；
//   谷歌说 Key 不对（gm_authFailure）时报 onFailed（只报一次），拆了以后不再报；
// - 官方加载法：脚本地址带写死的版本、Key、回调 google.maps.__ib__，脚本好了 importLibrary("maps")；一页只加载一次，换了 Key 要刷新；
//   加载不上抛"连不上谷歌"；
// - 底图那一条（mapBasemaps）：没 Key 抛错；建好的引擎报 loaded / auth_failed 给守护进程；
// - "自动"大陆外用谷歌（优先级 50 > OpenStreetMap 0），大陆里照旧；地图切换里国内国外都列它；这台设备连不上谷歌时标"连不上"、
//   手动选的退回"自动"；
// - 插件登记的：底图 google、数据源 google-maps 那一块；停用时撤掉；
// - 设置 · 数据源 · 谷歌地图那一块：两个密码框、加限制的说明（写这一页的地址）、每一项的用量、超了的说明、"超了还接着用"、英文；
//   界面上没有"秘书""待我处理"；卡片底下写"数据来自 Google 地图"。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { googleBasemap } from "../../src/plugins/google-maps/basemap.ts";
import { createGoogleEngine, type GoogleMapsLibrary } from "../../src/plugins/google-maps/google-engine.ts";
import { GoogleMapsPanelView, type GoogleMapsPanelViewProps, googleMapsResultOf } from "../../src/plugins/google-maps/GoogleMapsPanel.tsx";
import { GOOGLE_MAPS_SCRIPT_URL, GOOGLE_MAPS_VERSION, googleAuthFailed, loadGoogleScript, setGoogleLoader } from "../../src/plugins/google-maps/loader.ts";
import { googleMapsWebPlugin } from "../../src/plugins/google-maps/plugin.tsx";
import { createWebPluginHost } from "../../src/plugins/host.ts";
import { WEB_PLUGIN_MANIFEST } from "../../src/plugins/manifest.ts";
import { sourceLine } from "../../src/plugins/map/card-scene.ts";
import { autoBasemap, type BasemapPage, choiceBroken, pickBasemap, switchEntries } from "../../src/plugins/map/providers.ts";
import { activeLocale, activeLocaleFrom, type DataSourceView, distanceMeters, GOOGLE_MAPS_SKUS, type GoogleMapsSourcePanel, type MapProviderView, setActiveLocale, wgsToGcj } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const zh = activeLocale();
afterEach(() => {
  setActiveLocale(zh);
  vi.unstubAllGlobals();
});

const HANGZHOU = { lat: 30.2741, lon: 120.1551 };
const SINGAPORE = { lat: 1.2834, lon: 103.8607 };

/** 一个最小的假元素（Node 里没有 DOM）：引擎用到的那几样 */
function fakeElement(doc: { createElement: (tag: string) => unknown }): Record<string, unknown> {
  const el: Record<string, unknown> = {
    className: "",
    dataset: {},
    style: {},
    children: [] as unknown[],
    ownerDocument: doc,
    append(...kids: unknown[]) {
      (el.children as unknown[]).push(...kids);
    },
    replaceChildren(...kids: unknown[]) {
      el.children = kids;
    },
    remove() {},
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
  };
  return el;
}
const doc = { createElement: (): unknown => fakeElement(doc) };
const host = fakeElement(doc) as unknown as HTMLElement;

/** 假的线、圈：记下参数 */
const shape = (list: Array<Record<string, unknown>>) =>
  class {
    constructor(options: Record<string, unknown>) {
      list.push(options);
    }
    setMap() {}
  };

/** 一个最小的假谷歌：记下建了几张地图、每张的参数、线和圈的参数、叫 idle */
function fakeLibrary() {
  const seen = { maps: [] as Array<Record<string, unknown>>, lines: [] as Array<Record<string, unknown>>, circles: [] as Array<Record<string, unknown>>, idle: [] as Array<() => void>, center: { lat: 0, lng: 0 }, zoom: 0 };
  class FakeMap {
    constructor(_el: unknown, options: Record<string, unknown>) {
      seen.maps.push(options);
      seen.center = options.center as { lat: number; lng: number };
      seen.zoom = options.zoom as number;
    }
    getCenter() {
      return { lat: () => seen.center.lat, lng: () => seen.center.lng };
    }
    getZoom() {
      return seen.zoom;
    }
    setCenter(c: { lat: number; lng: number }) {
      seen.center = c;
    }
    setZoom(z: number) {
      seen.zoom = z;
    }
    addListener(_e: string, fn: () => void) {
      seen.idle.push(fn);
      return { remove: () => seen.idle.splice(seen.idle.indexOf(fn), 1) };
    }
  }
  class FakeOverlayView {
    setMap() {}
    getPanes() {
      return null;
    }
    getProjection() {
      return null;
    }
  }
  const lib = { Map: FakeMap, Polyline: shape(seen.lines), Circle: shape(seen.circles), OverlayView: FakeOverlayView } as unknown as GoogleMapsLibrary;
  return { lib, seen };
}

describe("谷歌那一种：进出都转坐标", () => {
  test("大陆里：交给谷歌的是 GCJ-02（偏几百米），拿回来的转回 WGS-84；只要地图本身；线、圈也转", () => {
    const { lib, seen } = fakeLibrary();
    const loaded: number[] = [];
    const engine = createGoogleEngine(host, lib, { view: { ...HANGZHOU, zoom: 14 }, dark: false, onMoveEnd() {}, onLoaded: () => loaded.push(1) });
    expect(engine.kind).toBe("google");
    const gcj = wgsToGcj(HANGZHOU);
    expect(seen.maps[0]).toMatchObject({ center: { lat: gcj.lat, lng: gcj.lon }, zoom: 14, colorScheme: "LIGHT", disableDefaultUI: true, clickableIcons: false, gestureHandling: "greedy" });
    expect(distanceMeters({ lat: seen.center.lat, lon: seen.center.lng }, HANGZHOU)).toBeGreaterThan(100);
    expect(distanceMeters(engine.view(), HANGZHOU)).toBeLessThan(1);
    expect(loaded).toEqual([1]);
    engine.setScene({ marks: [{ id: "a", ...HANGZHOU, label: "家" }], lines: [{ id: "r", points: [HANGZHOU, { lat: 30.28, lon: 120.13 }], kind: "route" }], circles: [{ id: "c", ...HANGZHOU, radius: 50, kind: "accuracy" }] });
    const path = seen.lines[0]!.path as Array<{ lat: number; lng: number }>;
    expect(path[0]).toEqual({ lat: gcj.lat, lng: gcj.lon });
    expect(seen.lines[0]).toMatchObject({ strokeWeight: 6, clickable: false });
    expect(seen.circles[0]).toMatchObject({ center: { lat: gcj.lat, lng: gcj.lon }, radius: 50, fillOpacity: 0.15 });
    engine.setView({ lat: 31.2304, lon: 121.4737, zoom: 12 });
    expect(distanceMeters(engine.view(), { lat: 31.2304, lon: 121.4737 })).toBeLessThan(1);
    expect(engine.view().zoom).toBe(12);
    engine.zoomBy(1);
    expect(seen.zoom).toBe(13);
  });

  test("大陆外：原样交给谷歌；停下来（idle）报现在看的是哪里", () => {
    const { lib, seen } = fakeLibrary();
    const views: Array<{ lat: number; lon: number }> = [];
    createGoogleEngine(host, lib, { view: { ...SINGAPORE, zoom: 15 }, dark: true, onMoveEnd: (v) => views.push(v) });
    expect(seen.maps[0]).toMatchObject({ center: { lat: SINGAPORE.lat, lng: SINGAPORE.lon }, colorScheme: "DARK" });
    for (const fn of seen.idle) fn();
    expect(views).toEqual([{ ...SINGAPORE, zoom: 15 }]);
  });

  test("换深浅色：带着同一个中心重建一张（谷歌的 colorScheme 只能建地图时定），又报一次 loaded；同样的不重建", () => {
    const { lib, seen } = fakeLibrary();
    let loads = 0;
    const engine = createGoogleEngine(host, lib, { view: { ...SINGAPORE, zoom: 15 }, dark: false, onMoveEnd() {}, onLoaded: () => loads++ });
    engine.setDark(false);
    expect(seen.maps).toHaveLength(1);
    engine.setDark(true);
    expect(seen.maps).toHaveLength(2);
    expect(seen.maps[1]).toMatchObject({ center: { lat: SINGAPORE.lat, lng: SINGAPORE.lon }, zoom: 15, colorScheme: "DARK" });
    expect(loads).toBe(2);
  });

  test("谷歌说 Key 不对：报 onFailed 一次（给人看的那句）；拆了以后不再报", () => {
    const { lib } = fakeLibrary();
    const failed: string[] = [];
    let handler: (() => void) | undefined;
    const engine = createGoogleEngine(host, lib, {
      view: { ...SINGAPORE, zoom: 15 },
      dark: false,
      onMoveEnd() {},
      onFailed: (r) => failed.push(r),
      watchAuth: (h) => {
        handler = h;
        return () => (handler = undefined);
      },
      authFailedText: "谷歌拒了",
    });
    handler!();
    handler!();
    expect(failed).toEqual(["谷歌拒了"]);
    engine.destroy();
    expect(handler).toBeUndefined();
  });
});

describe("官方加载法", () => {
  test("脚本带写死的版本、Key、回调 google.maps.__ib__；好了以后 importLibrary(\"maps\")；一页只加载一次，换了 Key 要刷新；gm_authFailure 转给登记的", async () => {
    const scripts: Array<{ src: string; listeners: Record<string, () => void> }> = [];
    const { lib } = fakeLibrary();
    const win: Record<string, unknown> = {};
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", {
      createElement: () => {
        const s = { src: "", async: false, listeners: {} as Record<string, () => void>, addEventListener: (e: string, fn: () => void) => (s.listeners[e] = fn) };
        return s;
      },
      head: {
        append: (s: { src: string; listeners: Record<string, () => void> }) => {
          scripts.push(s);
          // 扮谷歌：脚本加载完，换上真的 importLibrary，再叫回调
          const maps = (win.google as { maps: Record<string, unknown> }).maps;
          maps.importLibrary = (name: string) => Promise.resolve(name === "maps" ? lib : {});
          queueMicrotask(() => (maps["__ib__"] as () => void)());
        },
      },
    });
    const got = await loadGoogleScript("AIza-test-key-0000000000000000000");
    expect(got).toBe(lib);
    expect(scripts).toHaveLength(1);
    const url = new URL(scripts[0]!.src);
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_MAPS_SCRIPT_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({ key: "AIza-test-key-0000000000000000000", v: GOOGLE_MAPS_VERSION, language: "zh-CN", callback: "google.maps.__ib__" });
    expect(GOOGLE_MAPS_VERSION).toMatch(/^3\.\d+$/);
    expect(await loadGoogleScript("AIza-test-key-0000000000000000000")).toBe(lib);
    expect(scripts).toHaveLength(1);
    await expect(loadGoogleScript("AIza-other-key-000000000000000000")).rejects.toThrow("刷新页面后生效");
    expect(win.gm_authFailure).toBe(googleAuthFailed);
  });
});

describe("底图那一条（mapBasemaps）", () => {
  test("没 Key 抛错；加载不上抛那一句；建好的引擎报 loaded，谷歌说 Key 不对时报 auth_failed、引擎报 onFailed", async () => {
    const reports: string[] = [];
    const entry = googleBasemap((e) => reports.push(e));
    expect(entry.id).toBe("google");
    expect(entry.title).toBe("谷歌地图");
    await expect(Promise.resolve().then(() => entry.prepare(undefined))).rejects.toThrow("还没填浏览器用的 Key");
    setGoogleLoader(() => Promise.reject(new Error("连不上谷歌（这台设备可能在中国大陆，或者断网了）")));
    await expect(Promise.resolve().then(() => entry.prepare("k"))).rejects.toThrow("连不上谷歌");
    const { lib } = fakeLibrary();
    setGoogleLoader(() => Promise.resolve(lib));
    const factory = await entry.prepare("k");
    const failed: string[] = [];
    const engine = factory(host, { view: { ...SINGAPORE, zoom: 15 }, dark: false, onMoveEnd() {}, onFailed: (r) => failed.push(r) });
    expect(reports).toEqual(["loaded"]);
    googleAuthFailed();
    expect(reports).toEqual(["loaded", "auth_failed"]);
    expect(failed).toEqual(["谷歌拒了浏览器用的 Key（去 设置 · 数据源 · 谷歌地图 看看）"]);
    engine.destroy();
    googleAuthFailed();
    expect(reports).toEqual(["loaded", "auth_failed"]);
    setGoogleLoader(loadGoogleScript);
  });
});

const p = (id: string, over: Partial<MapProviderView>): MapProviderView => ({ id, title: id, regions: ["abroad"], manualRegions: ["abroad"], priority: 0, ownBasemapOnly: true, basemap: true, ready: true, lookup: true, ...over });
/** 这一页上：都登记了，哪几家加载失败了 */
const page = (failed: Record<string, string> = {}): BasemapPage => ({ has: () => true, failed: (id) => failed[id] });

describe("挑底图：谷歌接进来以后", () => {
  const AMAP = p("amap", { regions: ["mainland"], manualRegions: ["mainland"], priority: 100, key: "a" });
  const OSM = p("osm", { regions: ["mainland", "abroad"], manualRegions: ["mainland", "abroad"], ownBasemapOnly: false });
  const GOOGLE = p("google", { manualRegions: ["abroad", "mainland"], priority: 50, key: "g" });
  const ALL = [AMAP, OSM, GOOGLE];

  test("\"自动\"：大陆外谷歌、大陆里高德；地图切换里国内国外都列谷歌", () => {
    expect(autoBasemap("abroad", ALL, page())).toBe("google");
    expect(autoBasemap("mainland", ALL, page())).toBe("amap");
    expect(switchEntries("abroad", ALL, page()).map((e) => e.id)).toEqual(["google", "osm"]);
    expect(switchEntries("mainland", ALL, page()).map((e) => e.id)).toEqual(["amap", "google", "osm"]);
    expect(pickBasemap({ region: "mainland", choice: "google", providers: ALL, page: page() })).toEqual({ wanted: "google", auto: "amap", manual: true });
    // 看足迹一律 OpenStreetMap
    expect(pickBasemap({ region: "abroad", providers: ALL, page: page(), footprints: true }).wanted).toBe("osm");
  });

  test("这台设备连不上谷歌（在大陆）：切换里标\"连不上\"，手动选的要退回\"自动\"，大陆外\"自动\"退到 OpenStreetMap", () => {
    const broken = page({ google: "连不上谷歌" });
    expect(switchEntries("mainland", ALL, broken).find((e) => e.id === "google")).toEqual({ id: "google", failed: "连不上谷歌" });
    expect(choiceBroken("mainland", "google", ALL, broken)).toBe(true);
    expect(autoBasemap("abroad", ALL, broken)).toBe("osm");
    // 谷歌那边超了免费量、Key 被拒：守护进程报 ready: false，切换里不列
    expect(switchEntries("abroad", [AMAP, OSM, { ...GOOGLE, ready: false }], page()).map((e) => e.id)).toEqual(["osm"]);
  });
});

describe("插件登记的", () => {
  test("底图 google、数据源 google-maps 那一块；停用时撤掉，那两处交回\"谷歌地图\"", () => {
    const plugins = createWebPluginHost({ plugins: WEB_PLUGIN_MANIFEST, log: () => {} });
    plugins.apply(undefined);
    expect(googleMapsWebPlugin.owns).toEqual({ dataSources: ["google-maps"], mapBasemaps: ["google"] });
    expect(plugins.ownerOf("mapBasemaps", "google")?.name).toBe("google-maps");
    expect(plugins.ownerOf("dataSources", "google-maps")?.name).toBe("google-maps");
    expect(googleMapsWebPlugin.brings).toHaveLength(2);
    plugins.disable("google-maps");
    expect(plugins.list("mapBasemaps").map((b) => b.id)).toEqual(["amap", "osm"]);
    expect(plugins.unavailable("dataSources", "google-maps")).toBe("谷歌地图");
    expect(plugins.unavailable("mapBasemaps", "google")).toBe("谷歌地图");
  });

  test("卡片底下写数据来自 Google 地图（谷歌要求写明 Google Maps）", () => {
    expect(sourceLine("google")).toBe("数据来自 Google 地图");
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    expect(sourceLine("google")).toBe("Data from Google Maps");
  });
});

function googleSource(panel: Partial<GoogleMapsSourcePanel> = {}, extra: Partial<DataSourceView> = {}): DataSourceView {
  const counts = { dynamicMaps: 46, textSearch: 23, nearbySearch: 4, geocoding: 31, routesEssentials: 12, routesPro: 9 };
  const limits = { dynamicMaps: 10000, textSearch: 5000, nearbySearch: 5000, geocoding: 10000, routesEssentials: 10000, routesPro: 5000 };
  return {
    id: "google-maps",
    title: "谷歌地图",
    plugin: "google-maps",
    pluginTitle: "谷歌地图",
    available: true,
    connection: "connected",
    account: "浏览器用的 Key：已填 · 服务端用的 Key：已填",
    usages: [{ usage: "query", on: true }],
    sensitive: [],
    count: 0,
    syncing: false,
    canSync: false,
    files: [],
    configurable: true,
    panel: { kind: "google-maps", browserKey: true, serverKey: true, usage: { month: "2026-11", counts, limits }, allowOverage: false, over: [], ...panel },
    ...extra,
  } as DataSourceView;
}
const noop = () => {};
const renderPanel = (props: Partial<GoogleMapsPanelViewProps> = {}) =>
  renderToStaticMarkup(createElement(GoogleMapsPanelView, { source: googleSource(), values: { browserKey: "", serverKey: "" }, busy: false, result: undefined, origin: "http://127.0.0.1:8810", onValue: noop, onSubmit: noop, onAllowOverage: noop, ...props }));

describe("设置 · 数据源 · 谷歌地图那一块", () => {
  test("两个密码框（不回显）、加限制的说明写这一页的地址、每一项的用量、\"超了还接着用\"；没有\"秘书\"\"待我处理\"", () => {
    const html = renderPanel();
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html).toContain("浏览器用的 Key（Maps JavaScript API");
    expect(html).toContain("服务端用的 Key（Places API (New)、Routes API、Geocoding API");
    expect(html).toContain("http://127.0.0.1:8810/*");
    expect(html).toContain("「IP 地址」限制");
    expect(html).toContain("不改就留空（沿用存着的）");
    expect(html).toContain("已填谷歌地图的 Key：要换就重新填");
    for (const sku of GOOGLE_MAPS_SKUS) expect(html).toContain(`data-sku="${sku}"`);
    expect(html).toContain("23 / 5,000");
    expect(html).toContain("超了免费量还接着用");
    expect(html).toContain("预算提醒");
    expect(html).not.toMatch(/秘书|待我处理/);
  });

  test("超了免费量：标出那几项、写先停用了；放开了写按量收费；没填 Key 时按钮灰着", () => {
    const over = renderPanel({ source: googleSource({ over: ["textSearch"] }) });
    expect(over).toContain('data-sku="textSearch" data-over=""');
    expect(over).toContain("这个月超了免费量，先停用了：搜地点");
    expect(renderPanel({ source: googleSource({ over: ["textSearch"], allowOverage: true }) })).toContain("你放开了，超出的谷歌按量收费");
    const empty = renderPanel({ source: googleSource({ browserKey: false, serverKey: false }, { connection: "not_connected", panel: undefined }) });
    expect(empty).toContain("填谷歌地图的两个 Key");
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>测试并保存/);
    expect(empty).not.toContain("data-google-usage");
  });

  test("测完说一句；英文", () => {
    const view = { sources: [googleSource()], importFolder: undefined } as never;
    expect(googleMapsResultOf(view, "google-maps")).toEqual({ ok: true, text: "测过了，存好了：浏览器用的 Key：已填 · 服务端用的 Key：已填" });
    expect(googleMapsResultOf({ sources: [googleSource({}, { connection: "error", problem: "服务端用的 Key：谷歌不认" })] } as never, "google-maps").ok).toBe(false);
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    const html = renderPanel();
    expect(html).toContain("Browser key (Maps JavaScript API");
    expect(html).toContain("Keep using it after the free usage");
    expect(html).not.toMatch(/[一-鿿]/u);
  });
});
