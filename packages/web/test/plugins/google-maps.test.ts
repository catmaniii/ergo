// 谷歌地图插件的网页这一半（446）：Node 里能测的那部分（不连真的谷歌，加载器、谷歌都是假的）——
// - 谷歌的小桥（453，google-bridge.ts：关进隔离框里跑的那一段）：自成一体（整段转成字符串在只有 env、config 的地方照样跑，
//   演示页的假谷歌、占位瓦片那两段也是）；官方加载法（脚本地址带写死的版本、Key、语言、回调 google.maps.__ib__，好了 importLibrary）；
//   只要地图本身（不要谷歌自带的按钮、不让点谷歌的兴趣点）；报 loaded、ready、此刻画着哪一片、停下来；照外层说的挪、放大缩小、
//   按像素平移、换深浅（重建、又报 loaded）；谷歌说 Key 不对、加载不上报 failed 一次；
// - 谷歌那一种引擎（外层）：建一个 sandbox="allow-scripts" 的框，框说好了才交 init（代码和设置：Key、GCJ-02 的视野、深浅——没有足迹），
//   只交一次；没有 setScene；框里报来的转给地图页（视野交给那一层、停下来转回 WGS-84、用量、失败只报一次），别的窗口发来的不理；
//   拆了以后不再收；不隔离（退路）时同一段小桥在页面里跑；
// - 底图那一条（mapBasemaps）：没 Key 抛错；建好的引擎报 loaded / auth_failed 给守护进程；
// - "自动"大陆外用谷歌（优先级 50 > OpenStreetMap 0），大陆里照旧；地图切换里国内国外都列它；这台设备连不上谷歌时标"连不上"、
//   手动选的退回"自动"；
// - 插件登记的：底图 google、数据源 google-maps 那一块；停用时撤掉；
// - 设置 · 数据源 · 谷歌地图那一块：两个密码框、加限制的说明（写这一页的地址）、每一项的用量、超了的说明、"超了还接着用"、英文；
//   界面上没有"秘书""待我处理"；卡片底下写"数据来自 Google 地图"。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GOOGLE_FRAME_ISOLATED, googleBasemap } from "../../src/plugins/google-maps/basemap.ts";
import { installFakeGoogle } from "../../src/plugins/google-maps/demo-google.ts";
import { googleBridge, type GoogleBridgeConfig, type GoogleBridgeEnv } from "../../src/plugins/google-maps/google-bridge.ts";
import { bridgeCode, createGoogleEngine, GOOGLE_MAPS_SCRIPT_URL, GOOGLE_MAPS_VERSION } from "../../src/plugins/google-maps/google-engine.ts";
import { GoogleMapsPanelView, type GoogleMapsPanelViewProps, googleMapsResultOf } from "../../src/plugins/google-maps/GoogleMapsPanel.tsx";
import { googleMapsWebPlugin } from "../../src/plugins/google-maps/plugin.tsx";
import { createWebPluginHost } from "../../src/plugins/host.ts";
import { WEB_PLUGIN_MANIFEST } from "../../src/plugins/manifest.ts";
import { sourceLine } from "../../src/plugins/map/card-scene.ts";
import type { MapSurfaceView } from "../../src/plugins/map/engine.ts";
import { autoBasemap, type BasemapPage, choiceBroken, pickBasemap, switchEntries } from "../../src/plugins/map/providers.ts";
import { demoTileSource } from "../../src/prototype/fake-map.ts";
import { MAP_FRAME_MARK } from "../../src/ui/map-frame.ts";
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

/** 一个最小的 DOM（Node 里没有）：元素记下孩子、属性、样式、监听；窗口记下 message 监听、动画帧 */
interface FakeEl {
  tag: string;
  className: string;
  dataset: Record<string, string>;
  style: Record<string, string>;
  attrs: Record<string, string>;
  children: FakeEl[];
  parent?: FakeEl | undefined;
  listeners: Record<string, Array<(e: unknown) => void>>;
  clientWidth: number;
  clientHeight: number;
  textContent: string;
  src: string;
  async: boolean;
  draggable: boolean;
  alt: string;
  ownerDocument: FakeDoc;
  contentWindow?: { postMessage(msg: unknown, target: string): void };
  append(...kids: FakeEl[]): void;
  replaceChildren(...kids: FakeEl[]): void;
  remove(): void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
}
interface FakeDoc {
  createElement(tag: string): FakeEl;
  createElementNS(ns: string, tag: string): FakeEl;
  head: FakeEl;
  defaultView: FakeWin;
}
interface FakeWin {
  document: FakeDoc;
  location: { protocol: string };
  messages: Array<(e: { source: unknown; data: unknown }) => void>;
  frames: Array<() => void>;
  google?: unknown;
  gm_authFailure?: () => void;
  addEventListener(type: string, fn: (e: { source: unknown; data: unknown }) => void): void;
  removeEventListener(type: string, fn: (e: { source: unknown; data: unknown }) => void): void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  requestAnimationFrame(fn: () => void): number;
  cancelAnimationFrame(id: number): void;
}

function fakeDom(): { doc: FakeDoc; win: FakeWin; sentToFrame: unknown[] } {
  const sentToFrame: unknown[] = [];
  const win = {
    location: { protocol: "http:" },
    messages: [] as Array<(e: { source: unknown; data: unknown }) => void>,
    frames: [] as Array<() => void>,
    addEventListener(type: string, fn: (e: { source: unknown; data: unknown }) => void) {
      if (type === "message") win.messages.push(fn);
    },
    removeEventListener(type: string, fn: (e: { source: unknown; data: unknown }) => void) {
      if (type === "message") win.messages = win.messages.filter((f) => f !== fn);
    },
    setTimeout,
    clearTimeout,
    requestAnimationFrame(fn: () => void) {
      win.frames.push(fn);
      return win.frames.length;
    },
    cancelAnimationFrame() {},
  } as unknown as FakeWin;
  const make = (tag: string): FakeEl => {
    const el: FakeEl = {
      tag,
      className: "",
      dataset: {},
      style: {},
      attrs: {},
      children: [],
      listeners: {},
      clientWidth: 600,
      clientHeight: 400,
      textContent: "",
      src: "",
      async: false,
      draggable: true,
      alt: "",
      ownerDocument: doc,
      append(...kids) {
        for (const k of kids) {
          k.parent = el;
          el.children.push(k);
        }
      },
      replaceChildren(...kids) {
        el.children = kids;
      },
      remove() {
        if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
      },
      setAttribute(name, value) {
        el.attrs[name] = value;
      },
      addEventListener(type, fn) {
        (el.listeners[type] ??= []).push(fn);
      },
      removeEventListener(type, fn) {
        el.listeners[type] = (el.listeners[type] ?? []).filter((f) => f !== fn);
      },
    };
    if (tag === "iframe") el.contentWindow = { postMessage: (msg) => sentToFrame.push(msg) };
    return el;
  };
  const doc: FakeDoc = { createElement: make, createElementNS: (_ns, tag) => make(tag), head: undefined as unknown as FakeEl, defaultView: win };
  doc.head = make("head");
  win.document = doc;
  return { doc, win, sentToFrame };
}

/** 一个最小的假谷歌库（只有 Map）：记下建了几张地图、每张的参数、监听 */
function fakeLibrary() {
  const seen = { maps: [] as Array<Record<string, unknown>>, listeners: [] as Array<{ event: string; fn: () => void }>, center: { lat: 0, lng: 0 }, zoom: 0 };
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
    addListener(event: string, fn: () => void) {
      const entry = { event, fn };
      seen.listeners.push(entry);
      return { remove: () => seen.listeners.splice(seen.listeners.indexOf(entry), 1) };
    }
  }
  return { lib: { Map: FakeMap }, seen };
}

const CONFIG: GoogleBridgeConfig = {
  key: "AIza-test-key-0000000000000000000",
  version: GOOGLE_MAPS_VERSION,
  language: "zh-CN",
  scriptUrl: GOOGLE_MAPS_SCRIPT_URL,
  lat: 1.2834,
  lng: 103.8607,
  zoom: 15,
  dark: false,
  minZoom: 3,
  maxZoom: 20,
  timeoutMs: 5000,
  unreachable: "连不上谷歌",
  authFailed: "谷歌拒了",
};

/** 在假窗口里跑小桥（asString：整段转成字符串再跑，和框里一样）：报出来的、发指令的口子 */
function runBridge(win: FakeWin, config: GoogleBridgeConfig = CONFIG, asString = false) {
  const out: Array<Record<string, unknown>> = [];
  const handlers: Array<(m: { type: string }) => void> = [];
  const container = win.document.createElement("div");
  const env = { win, container, post: (m: Record<string, unknown>) => out.push(m), listen: (fn: (m: { type: string }) => void) => handlers.push(fn) };
  if (asString) new Function("env", "config", bridgeCode())(env, config);
  else googleBridge(env as unknown as GoogleBridgeEnv, config);
  return { out, container, send: (m: Record<string, unknown> & { type: string }) => handlers.forEach((fn) => fn(m)), types: () => out.map((m) => m.type) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("谷歌的小桥（453：框里跑的那一段）", () => {
  test("自成一体：整段转成字符串、在只有 env、config 的地方照样跑（框里就是这样）；假谷歌、演示瓦片那两段也一样", async () => {
    const { win } = fakeDom();
    const { lib } = fakeLibrary();
    win.google = { maps: { importLibrary: () => Promise.resolve(lib) } };
    const bridge = runBridge(win, CONFIG, true);
    await flush();
    expect(bridge.types()).toEqual(["loaded", "surface", "ready"]);
    // 演示页交给框的：先装假谷歌（瓦片也是整段交过去的），再跑小桥
    const other = fakeDom();
    const code = `(${installFakeGoogle.toString()})(env.win, ${demoTileSource()}, {"unreachable":false});`;
    new Function("env", "config", `${code}\n(${googleBridge.toString()})(env, config);`)({ win: other.win, container: other.doc.createElement("div"), post() {}, listen() {} }, CONFIG);
    const fake = (other.win.google as { maps: { importLibrary(n: string): Promise<{ Map: new (el: unknown, o: object) => unknown }> } }).maps;
    const FakeMap = (await fake.importLibrary("maps")).Map;
    const el = other.doc.createElement("div");
    expect(new FakeMap(el, { center: { lat: 1.28, lng: 103.86 }, zoom: 15 })).toBeDefined();
    const tiles = el.children[0]!.children;
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles[0]!.src).toMatch(/^data:image\/svg\+xml/);
    expect(el.children[1]!.textContent).toBe("Google");
  });

  test("没有谷歌时照官方加载法加脚本：版本写死、Key、语言、回调 google.maps.__ib__；好了以后 importLibrary(\"maps\")，建一张只有底图的地图", async () => {
    const { win, doc } = fakeDom();
    const { lib, seen } = fakeLibrary();
    const bridge = runBridge(win);
    const script = doc.head.children[0]!;
    const url = new URL(script.src);
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_MAPS_SCRIPT_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({ key: CONFIG.key, v: GOOGLE_MAPS_VERSION, language: "zh-CN", callback: "google.maps.__ib__" });
    expect(GOOGLE_MAPS_VERSION).toMatch(/^3\.\d+$/);
    // 扮谷歌：脚本好了，换上 importLibrary，叫回调
    const maps = (win.google as { maps: Record<string, unknown> }).maps;
    maps.importLibrary = (name: string) => Promise.resolve(name === "maps" ? lib : {});
    (maps["__ib__"] as () => void)();
    await flush();
    expect(seen.maps[0]).toMatchObject({ center: { lat: CONFIG.lat, lng: CONFIG.lng }, zoom: 15, colorScheme: "LIGHT", disableDefaultUI: true, clickableIcons: false, gestureHandling: "greedy", keyboardShortcuts: false });
    expect(bridge.out.find((m) => m.type === "surface")).toMatchObject({ lat: CONFIG.lat, lng: CONFIG.lng, zoom: 15, width: 600, height: 400 });
    expect(bridge.types()).toContain("ready");
    // 停下来（idle）报 moveend
    for (const l of seen.listeners.filter((x) => x.event === "idle")) l.fn();
    expect(bridge.out.at(-1)).toEqual({ type: "moveend", lat: CONFIG.lat, lng: CONFIG.lng, zoom: 15 });
  });

  test("外层的指令：setView、zoomBy、panBy（按像素挪中心）、setDark（带着同一个中心重建、又报 loaded）；动了就报 surface", async () => {
    const { win } = fakeDom();
    const { lib, seen } = fakeLibrary();
    win.google = { maps: { importLibrary: () => Promise.resolve(lib) } };
    const bridge = runBridge(win);
    await flush();
    bridge.send({ type: "setView", lat: 30.27, lng: 120.16, zoom: 12 });
    expect(seen.center).toEqual({ lat: 30.27, lng: 120.16 });
    expect(seen.zoom).toBe(12);
    expect(bridge.out.at(-1)).toMatchObject({ type: "surface", lat: 30.27, lng: 120.16, zoom: 12 });
    bridge.send({ type: "zoomBy", delta: 1 });
    expect(seen.zoom).toBe(13);
    // 往右拖 256 像素：第 13 级里中心往西挪 256 / (256·2^13) 圈
    bridge.send({ type: "panBy", dx: 256, dy: 0 });
    expect(seen.center.lng).toBeCloseTo(120.16 - 360 / 2 ** 13, 9);
    expect(seen.center.lat).toBeCloseTo(30.27, 9);
    const loads = bridge.types().filter((t) => t === "loaded").length;
    bridge.send({ type: "setDark", dark: true });
    expect(seen.maps.at(-1)).toMatchObject({ colorScheme: "DARK", zoom: 13 });
    expect(bridge.types().filter((t) => t === "loaded").length).toBe(loads + 1);
    bridge.send({ type: "setDark", dark: true });
    expect(seen.maps).toHaveLength(2);
  });

  test("谷歌说 Key 不对（gm_authFailure）：报 failed 一次、带 auth；加载不上：报连不上", async () => {
    const { win } = fakeDom();
    const { lib } = fakeLibrary();
    win.google = { maps: { importLibrary: () => Promise.resolve(lib) } };
    const bridge = runBridge(win);
    await flush();
    win.gm_authFailure!();
    win.gm_authFailure!();
    expect(bridge.out.filter((m) => m.type === "failed")).toEqual([{ type: "failed", reason: "谷歌拒了", auth: true }]);
    const other = fakeDom();
    other.win.google = { maps: { importLibrary: () => Promise.reject(new Error("x")) } };
    const failing = runBridge(other.win);
    await flush();
    expect(failing.out).toEqual([{ type: "failed", reason: "连不上谷歌", auth: false }]);
  });
});

/** 外层的引擎（关进框里）：框发来一条 */
function fromFrame(win: FakeWin, frame: FakeEl, data: Record<string, unknown>) {
  for (const fn of win.messages) fn({ source: frame.contentWindow, data: { ...data, [MAP_FRAME_MARK]: 1 } });
}
const TEXTS = { unreachable: "连不上谷歌", authFailed: "谷歌拒了" };

describe("谷歌那一种引擎（453：关在隔离框里，只出底图）", () => {
  test("建一个 sandbox=\"allow-scripts\" 的框（守护进程的 /map-frame.html）；框说好了才交 init——小桥的代码和设置（Key、GCJ-02 的视野、深浅），只交一次；没有 setScene", () => {
    const { doc, win, sentToFrame } = fakeDom();
    const host = doc.createElement("div");
    const engine = createGoogleEngine(host as unknown as HTMLElement, { key: "k-1", view: { ...HANGZHOU, zoom: 14 }, dark: false, onMoveEnd() {}, texts: TEXTS });
    expect(engine.setScene).toBeUndefined();
    // 建好时还在加载：地图页写"正在加载谷歌地图…"，等 onReady
    expect(engine.loading).toBe(true);
    const root = host.children[0]!;
    expect(root.dataset).toMatchObject({ engine: "google", isolated: "frame", state: "loading" });
    const frame = root.children[0]!;
    expect(frame.tag).toBe("iframe");
    expect(frame.attrs.sandbox).toBe("allow-scripts");
    expect(frame.src).toBe("/map-frame.html");
    expect(sentToFrame).toEqual([]);
    engine.setView({ lat: 31.2304, lon: 121.4737, zoom: 12 });
    fromFrame(win, frame, { type: "frame-ready" });
    fromFrame(win, frame, { type: "frame-ready" });
    const init = sentToFrame[0] as { type: string; code: string; config: GoogleBridgeConfig };
    expect(init.type).toBe("init");
    expect(sentToFrame.filter((m) => (m as { type: string }).type === "init")).toHaveLength(1);
    expect(init.code).toContain("google.maps.__ib__");
    const gcj = wgsToGcj(HANGZHOU);
    expect(init.config).toMatchObject({ key: "k-1", lat: gcj.lat, lng: gcj.lon, zoom: 14, dark: false, version: GOOGLE_MAPS_VERSION });
    // 设置里只有这几样（没有足迹、点、线）
    expect(Object.keys(init.config).toSorted()).toEqual(["authFailed", "dark", "key", "language", "lat", "lng", "maxZoom", "minZoom", "scriptUrl", "timeoutMs", "unreachable", "version", "zoom"]);
    // init 之前的指令排着，之后发出去（GCJ-02）
    const shanghai = wgsToGcj({ lat: 31.2304, lon: 121.4737 });
    expect(sentToFrame[1]).toMatchObject({ type: "setView", lat: shanghai.lat, lng: shanghai.lon, zoom: 12, [MAP_FRAME_MARK]: 1 });
  });

  test("框里报来的：surface 交给地图页那一层（谷歌的坐标、datum gcj02），moveend 转回 WGS-84，loaded 报用量，ready 报 onReady（只一次），failed 只报一次（Key 不对另报 auth）；别的窗口发来的不理", () => {
    const { doc, win } = fakeDom();
    const host = doc.createElement("div");
    const got = { surfaces: [] as MapSurfaceView[], ends: [] as Array<{ lat: number; lon: number; zoom: number }>, loaded: 0, ready: 0, auth: 0, failed: [] as string[] };
    createGoogleEngine(host as unknown as HTMLElement, {
      key: "k",
      view: { ...SINGAPORE, zoom: 15 },
      dark: true,
      texts: TEXTS,
      onMoveEnd: (v) => got.ends.push(v),
      onSurface: (v) => got.surfaces.push(v),
      onLoaded: () => got.loaded++,
      onReady: () => got.ready++,
      onAuthFailed: () => got.auth++,
      onFailed: (r) => got.failed.push(r),
    });
    const root = host.children[0]!;
    const frame = root.children[0]!;
    const gcj = wgsToGcj(HANGZHOU);
    fromFrame(win, frame, { type: "loaded" });
    fromFrame(win, frame, { type: "ready" });
    fromFrame(win, frame, { type: "ready" });
    expect(root.dataset.state).toBe("ready");
    expect(got.ready).toBe(1);
    fromFrame(win, frame, { type: "surface", lat: gcj.lat, lng: gcj.lon, zoom: 14.5, width: 390, height: 700 });
    expect(got.surfaces).toEqual([{ lat: gcj.lat, lon: gcj.lon, zoom: 14.5, width: 390, height: 700, datum: "gcj02" }]);
    fromFrame(win, frame, { type: "moveend", lat: gcj.lat, lng: gcj.lon, zoom: 14 });
    expect(distanceMeters(got.ends[0]!, HANGZHOU)).toBeLessThan(1);
    // 别的窗口发来的、没带记号的：不理
    for (const fn of win.messages) fn({ source: {}, data: { type: "failed", reason: "x", [MAP_FRAME_MARK]: 1 } });
    for (const fn of win.messages) fn({ source: frame.contentWindow, data: { type: "failed", reason: "x" } });
    expect(got.failed).toEqual([]);
    fromFrame(win, frame, { type: "failed", reason: "谷歌拒了", auth: true });
    fromFrame(win, frame, { type: "failed", reason: "又一次" });
    expect(got).toMatchObject({ loaded: 1, auth: 1, failed: ["谷歌拒了"] });
  });

  test("指令原样转给框；拆了以后框没了、不再收", () => {
    const { doc, win, sentToFrame } = fakeDom();
    const host = doc.createElement("div");
    const engine = createGoogleEngine(host as unknown as HTMLElement, { key: "k", view: { ...SINGAPORE, zoom: 15 }, dark: false, onMoveEnd() {}, texts: TEXTS });
    const frame = host.children[0]!.children[0]!;
    fromFrame(win, frame, { type: "frame-ready" });
    engine.zoomBy(-1);
    engine.panBy!(10, -5);
    engine.setDark(true);
    expect(sentToFrame.slice(1).map((m) => (m as { type: string }).type)).toEqual(["zoomBy", "panBy", "setDark"]);
    expect(sentToFrame[2]).toMatchObject({ dx: 10, dy: -5 });
    engine.destroy();
    expect(host.children).toEqual([]);
    expect(win.messages).toEqual([]);
  });

  test("不隔离（退路：GOOGLE_FRAME_ISOLATED 改成 false）：同一段小桥直接在页面里跑，照样只出底图", async () => {
    expect(GOOGLE_FRAME_ISOLATED).toBe(true);
    const { doc } = fakeDom();
    const { lib, seen } = fakeLibrary();
    const surfaces: MapSurfaceView[] = [];
    const host = doc.createElement("div");
    const engine = createGoogleEngine(host as unknown as HTMLElement, {
      key: "k",
      view: { ...SINGAPORE, zoom: 15 },
      dark: false,
      isolated: false,
      fake: { code: "", install: (w) => ((w as unknown as FakeWin).google = { maps: { importLibrary: () => Promise.resolve(lib) } }) },
      onMoveEnd() {},
      onSurface: (v) => surfaces.push(v),
      texts: TEXTS,
    });
    await flush();
    expect(host.children[0]!.dataset.isolated).toBe("page");
    expect(seen.maps).toHaveLength(1);
    expect(surfaces[0]).toMatchObject({ lat: SINGAPORE.lat, lon: SINGAPORE.lon, zoom: 15, datum: "gcj02" });
    engine.setView({ ...SINGAPORE, zoom: 11 });
    expect(seen.zoom).toBe(11);
    engine.destroy();
  });
});

describe("底图那一条（mapBasemaps）", () => {
  test("没 Key 抛错；建好的引擎：框里建了一张报 loaded，谷歌说 Key 不对报 auth_failed、引擎报 onFailed（给人看的那句）", async () => {
    const reports: string[] = [];
    const entry = googleBasemap((e) => reports.push(e));
    expect(entry.id).toBe("google");
    expect(entry.title).toBe("谷歌地图");
    await expect(Promise.resolve().then(() => entry.prepare(undefined))).rejects.toThrow("还没填浏览器用的 Key");
    const factory = await entry.prepare("k");
    const { doc, win } = fakeDom();
    const host = doc.createElement("div");
    const failed: string[] = [];
    factory(host as unknown as HTMLElement, { view: { ...SINGAPORE, zoom: 15 }, dark: false, onMoveEnd() {}, onFailed: (r) => failed.push(r) });
    const frame = host.children[0]!.children[0]!;
    fromFrame(win, frame, { type: "loaded" });
    fromFrame(win, frame, { type: "failed", reason: "谷歌拒了浏览器用的 Key（去 设置 · 数据源 · 谷歌地图 看看）", auth: true });
    expect(reports).toEqual(["loaded", "auth_failed"]);
    expect(failed).toEqual(["谷歌拒了浏览器用的 Key（去 设置 · 数据源 · 谷歌地图 看看）"]);
  });
});

const p = (id: string, over: Partial<MapProviderView>): MapProviderView => ({ id, title: id, regions: ["abroad"], manualRegions: ["abroad"], priority: 0, ownBasemapOnly: true, basemap: true, ready: true, lookup: true, ...over });
/** 这一页上：都登记了，哪几家加载失败了 */
const page = (failed: Record<string, string> = {}): BasemapPage => ({ has: () => true, failed: (id) => failed[id] });

describe("挑底图：谷歌接进来以后（451：一个区域一家当前地图，国外谷歌 > 高德 > OpenStreetMap）", () => {
  // 451 起高德的底图国内国外都管，国外的优先级 30（低于谷歌 50）
  const AMAP = p("amap", { regions: ["mainland", "abroad"], manualRegions: ["mainland", "abroad"], priority: 100, regionPriority: { abroad: 30 }, key: "a" });
  const OSM = p("osm", { regions: ["mainland", "abroad"], manualRegions: ["mainland", "abroad"], ownBasemapOnly: false });
  const GOOGLE = p("google", { manualRegions: ["abroad", "mainland"], priority: 50, key: "g" });
  const ALL = [AMAP, OSM, GOOGLE];

  test("\"自动\"：大陆外谷歌、大陆里高德；地图切换里国内国外都列谷歌，\"自动\"会挑的排前面、只能手动选的排后面；看足迹也用当前地图", () => {
    expect(autoBasemap("abroad", ALL, page())).toBe("google");
    expect(autoBasemap("mainland", ALL, page())).toBe("amap");
    expect(switchEntries("abroad", ALL, page()).map((e) => e.id)).toEqual(["google", "amap", "osm"]);
    expect(switchEntries("mainland", ALL, page()).map((e) => e.id)).toEqual(["amap", "osm", "google"]);
    expect(pickBasemap({ region: "mainland", choice: "google", providers: ALL, page: page() })).toEqual({ wanted: "google", auto: "amap", manual: true, current: "google", temporary: false });
    expect(pickBasemap({ region: "abroad", providers: ALL, page: page(), footprints: true }).wanted).toBe("google");
  });

  test("国外没填谷歌（或者谷歌的插件停了、超了）：\"自动\"是高德；高德也没填才是 OpenStreetMap；国内\"自动\"照旧高德", () => {
    const noGoogle = [AMAP, OSM, { ...GOOGLE, ready: false }];
    expect(autoBasemap("abroad", noGoogle, page())).toBe("amap");
    expect(autoBasemap("abroad", [AMAP, OSM], page())).toBe("amap");
    expect(autoBasemap("abroad", [{ ...AMAP, ready: false }, OSM], page())).toBe("osm");
    expect(autoBasemap("mainland", ALL, page())).toBe("amap");
    expect(switchEntries("abroad", noGoogle, page()).map((e) => e.id)).toEqual(["amap", "osm"]);
  });

  test("这台设备连不上谷歌（在大陆）：切换里标\"连不上\"，手动选的要退回\"自动\"，大陆外\"自动\"退到高德（高德也加载不上才 OpenStreetMap）", () => {
    const broken = page({ google: "连不上谷歌" });
    expect(switchEntries("mainland", ALL, broken).find((e) => e.id === "google")).toEqual({ id: "google", failed: "连不上谷歌" });
    expect(choiceBroken("mainland", "google", ALL, broken)).toBe(true);
    expect(autoBasemap("abroad", ALL, broken)).toBe("amap");
    expect(autoBasemap("abroad", ALL, page({ google: "连不上谷歌", amap: "timeout" }))).toBe("osm");
    // 谷歌那边超了免费量、Key 被拒：守护进程报 ready: false，切换里不列
    expect(switchEntries("abroad", [AMAP, OSM, { ...GOOGLE, ready: false }], page()).map((e) => e.id)).toEqual(["amap", "osm"]);
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
