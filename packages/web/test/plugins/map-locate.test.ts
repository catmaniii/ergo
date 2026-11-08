// 地图页的"回到我现在的位置"（442）：Node 里能测的那部分，位置都是编的，不连外网——
// - 现在的位置从哪来（locate.ts 的 locateMe）：鸿蒙 App 的原生定位（假的原生桥）→ 浏览器定位（假的 geolocation：成功、拒绝、超时、
//   一直不回）→ 手机最近交来的点（假的 GET /api/map/latest）→ 都没有；前一处拿到了就不问后一处；
// - 挪到哪、放大到几级（精度圈比一屏大时退几级）、画什么（蓝点、精度圈，手机的点旁边写几点交来的）、说哪句话（中英）；
// - 一分钟内这台设备上定到的算新的，再点直接回去；手机交来的不算；
// - 高德底图上画蓝点时转了坐标（大陆内交给高德的是 GCJ-02，大陆外原样），精度圈是"跟你有关的颜色"；
// - 演示页的退路数据：12 分钟前、西湖边；手机插件停用了没有。
import { afterEach, describe, expect, test, vi } from "vitest";
import { type AmapNamespace, createAmapEngine } from "../../src/plugins/map/amap-engine.ts";
import {
  type AppPlaceFix,
  agoText,
  type BrowserGeolocation,
  browserFix,
  fixIsFresh,
  HERE_CIRCLE_ID,
  HERE_MARK_ID,
  type HereFix,
  hereScene,
  LOCATE_TIMEOUT_MS,
  locateMe,
  locateNote,
  locateView,
  withHere,
} from "../../src/plugins/map/locate.ts";
import { chooseBasemap, EMPTY_SCENE } from "../../src/plugins/map/scene.ts";
import { metersPerPixel } from "../../src/plugins/map/tiles.ts";
import { demoMapLatest } from "../../src/prototype/fake-footprints.ts";
import { activeLocale, activeLocaleFrom, distanceMeters, type MapLatestView, nowIso, setActiveLocale, wgsToGcj } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

const zh = activeLocale();
afterEach(() => {
  setActiveLocale(zh);
  vi.useRealTimers();
});

const NOW = new Date(2026, 10, 8, 10, 30).getTime();
const HANGZHOU = { lat: 30.2741, lon: 120.1551 };
const SINGAPORE = { lat: 1.2834, lon: 103.8607 };
/** 手机 12 分钟前交来的点 */
const PHONE_POINT: MapLatestView = { point: { at: nowIso(new Date(NOW - 12 * 60_000)), lat: 30.2598, lon: 120.1452, accuracy: 35 } };

/** 假的浏览器定位：按给的结果回话，记下每次的参数 */
function fakeGeo(reply: { lat: number; lon: number; accuracy: number } | { code: number } | "silent") {
  const calls: PositionOptions[] = [];
  const geo: BrowserGeolocation = {
    getCurrentPosition(success, error, options) {
      calls.push(options);
      if (reply === "silent") return;
      if ("code" in reply) queueMicrotask(() => error(reply));
      else queueMicrotask(() => success({ coords: { latitude: reply.lat, longitude: reply.lon, accuracy: reply.accuracy } }));
    },
  };
  return { geo, calls };
}

/** 假的原生桥"现在在哪"，记下叫了几次 */
function fakeApp(reply: AppPlaceFix) {
  const app = { calls: 0, here: () => ((app.calls += 1), Promise.resolve(reply)) };
  return app;
}

/** 假的"手机最近一个点"，记下叫了几次 */
function fakeLatest(view: MapLatestView | "fail") {
  const latest = { calls: 0, get: () => ((latest.calls += 1), view === "fail" ? Promise.reject(new Error("地图插件没启用")) : Promise.resolve(view)) };
  return latest;
}

describe("现在的位置从哪来：App 的原生定位 → 浏览器定位 → 手机最近交来的点", () => {
  test("鸿蒙 App 里：原生定位拿到了就用它（没有精度），浏览器、手机的点都不问", async () => {
    const app = fakeApp({ ok: true, lat: 30.28, lon: 120.12 });
    const { geo, calls } = fakeGeo({ lat: 1, lon: 2, accuracy: 3 });
    const latest = fakeLatest(PHONE_POINT);
    const r = await locateMe({ appHere: app.here, geolocation: geo, latest: latest.get, now: () => NOW });
    expect(r).toEqual({ fix: { lat: 30.28, lon: 120.12, source: "app", gotAt: NOW } });
    expect([app.calls, calls.length, latest.calls]).toEqual([1, 0, 0]);
    expect(locateNote(r, NOW)).toBeUndefined();
  });

  test("App 没给定位权限：再问浏览器，浏览器给了就用（带精度），不说话", async () => {
    const app = fakeApp({ ok: false, reason: "denied" });
    const { geo, calls } = fakeGeo({ lat: SINGAPORE.lat, lon: SINGAPORE.lon, accuracy: 25 });
    const latest = fakeLatest(PHONE_POINT);
    const r = await locateMe({ appHere: app.here, geolocation: geo, latest: latest.get, now: () => NOW });
    expect(r).toEqual({ fix: { ...SINGAPORE, accuracy: 25, source: "browser", gotAt: NOW } });
    expect(latest.calls).toBe(0);
    // 高精度、10 秒超时、30 秒内定过的可以直接用
    expect(calls).toEqual([{ enableHighAccuracy: true, timeout: LOCATE_TIMEOUT_MS, maximumAge: 30_000 }]);
    expect(LOCATE_TIMEOUT_MS).toBe(10_000);
    expect(locateNote(r, NOW)).toBeUndefined();
  });

  test("浏览器拒绝：用手机 12 分钟前交来的点，说一句没拿到这台设备的位置", async () => {
    const latest = fakeLatest(PHONE_POINT);
    const r = await locateMe({ geolocation: fakeGeo({ code: 1 }).geo, latest: latest.get, now: () => NOW });
    expect(r).toEqual({ fix: { lat: 30.2598, lon: 120.1452, accuracy: 35, source: "phone", at: PHONE_POINT.point!.at, gotAt: NOW }, device: "denied" });
    expect(locateNote(r, NOW)).toBe("没拿到这台设备的位置（没给定位权限），这是 12 分钟前手机交来的位置");
  });

  test("浏览器超时：照样退到手机的点，写定位超时", async () => {
    const r = await locateMe({ geolocation: fakeGeo({ code: 3 }).geo, latest: fakeLatest(PHONE_POINT).get, now: () => NOW });
    expect(r.device).toBe("timeout");
    expect(locateNote(r, NOW)).toBe("没拿到这台设备的位置（定位超时），这是 12 分钟前手机交来的位置");
    const unavailable = await locateMe({ geolocation: fakeGeo({ code: 2 }).geo, latest: fakeLatest(PHONE_POINT).get, now: () => NOW });
    expect(unavailable.device).toBe("unavailable");
  });

  test("浏览器一直不回话（关了定位的 WebView）：到点再多等 2 秒自己放弃，当超时", async () => {
    vi.useFakeTimers();
    const { geo } = fakeGeo("silent");
    let settled: Awaited<ReturnType<typeof browserFix>> | undefined;
    void browserFix(geo).then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(LOCATE_TIMEOUT_MS + 1_900);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe("timeout");
  });

  test("浏览器给的坐标不对当定不了；调用就抛错也当定不了", async () => {
    expect(await browserFix(fakeGeo({ lat: 200, lon: 0, accuracy: 5 }).geo)).toBe("unavailable");
    expect(await browserFix({ getCurrentPosition: () => { throw new Error("boom"); } })).toBe("unavailable");
  });

  test("这个页面用不了定位（没有接口、不是安全上下文）也不在 App 里：直接用手机的点，写为什么", async () => {
    const r = await locateMe({ latest: fakeLatest(PHONE_POINT).get, now: () => NOW });
    expect(r.device).toBe("unsupported");
    expect(locateNote(r, NOW)).toBe("没拿到这台设备的位置（这个页面用不了定位），这是 12 分钟前手机交来的位置");
  });

  test("在 App 里原生的、网页的都没拿到：说原生那一步为什么（网页定位在 App 里本来关着）", async () => {
    const denied = await locateMe({ appHere: fakeApp({ ok: false, reason: "denied" }).here, geolocation: fakeGeo({ code: 1 }).geo, latest: fakeLatest(PHONE_POINT).get, now: () => NOW });
    expect(denied.device).toBe("denied");
    const failed = await locateMe({ appHere: fakeApp({ ok: false, reason: "unavailable" }).here, geolocation: fakeGeo({ code: 1 }).geo, latest: fakeLatest(PHONE_POINT).get, now: () => NOW });
    expect(failed.device).toBe("unavailable");
    // 原生桥出错（Promise 被拒）也当定不了，接着往下问
    const thrown = await locateMe({ appHere: () => Promise.reject(new Error("bridge")), geolocation: fakeGeo({ lat: 30, lon: 120, accuracy: 9 }).geo, latest: fakeLatest(PHONE_POINT).get, now: () => NOW });
    expect(thrown.fix?.source).toBe("browser");
  });

  test("什么都没有（手机也没交来过、取不到）：说拿不到你现在的位置", async () => {
    const none = await locateMe({ geolocation: fakeGeo({ code: 1 }).geo, latest: fakeLatest({}).get, now: () => NOW });
    expect(none).toEqual({ device: "denied" });
    expect(locateNote(none, NOW)).toBe("拿不到你现在的位置：这台设备没给（没给定位权限），手机也还没交来过位置");
    const failed = await locateMe({ latest: fakeLatest("fail").get, now: () => NOW });
    expect(failed).toEqual({ device: "unsupported" });
  });

  test("手机的点：不到 1 分钟写刚交来的；几小时前的、几天前的；超过 2 小时提一句可能不在那儿了", () => {
    const phone = (msAgo: number) => ({ fix: { lat: 30, lon: 120, source: "phone" as const, at: nowIso(new Date(NOW - msAgo)), gotAt: NOW }, device: "denied" as const });
    expect(locateNote(phone(20_000), NOW)).toBe("没拿到这台设备的位置（没给定位权限），这是手机刚交来的位置");
    expect(locateNote(phone(90 * 60_000), NOW)).toBe("没拿到这台设备的位置（没给定位权限），这是 1 小时前手机交来的位置");
    expect(locateNote(phone(5 * 3600_000), NOW)).toBe("没拿到这台设备的位置（没给定位权限），这是 5 小时前手机交来的位置，你可能已经不在那儿了");
    expect(agoText(nowIso(new Date(NOW - 3 * 86_400_000)), NOW)).toBe("3 天前");
  });

  test("英文", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    const phone = { fix: { lat: 30, lon: 120, source: "phone" as const, at: nowIso(new Date(NOW - 12 * 60_000)), gotAt: NOW }, device: "denied" as const };
    expect(locateNote(phone, NOW)).toBe("Couldn't get this device's location (location permission not granted). This is where your phone was 12 minutes ago");
    expect(locateNote({ device: "unsupported" }, NOW)).toBe("Can't find your location: this device didn't share it (location isn't available on this page), and your phone hasn't sent one yet");
    expect(agoText(nowIso(new Date(NOW - 60_000)), NOW)).toBe("1 minute ago");
    expect(hereScene(phone.fix).marks[0]!.label).toBe("Phone · 10:18");
  });
});

describe("挪到哪、画什么", () => {
  test("挪过去放大到街道级（17）；精度圈比一屏大时退到看得全那个圈的级别；不知道精度也是 17", () => {
    expect(locateView({ ...HANGZHOU, accuracy: 20 }, 390, 700)).toEqual({ ...HANGZHOU, zoom: 17 });
    expect(locateView(HANGZHOU, 390, 700)).toEqual({ ...HANGZHOU, zoom: 17 });
    const wide = locateView({ ...HANGZHOU, accuracy: 3000 }, 390, 700);
    expect(wide.zoom).toBeLessThan(17);
    // 圈的直径放得进短边
    expect((2 * 3000) / metersPerPixel(HANGZHOU.lat, wide.zoom)).toBeLessThanOrEqual(390);
    expect((2 * 3000) / metersPerPixel(HANGZHOU.lat, wide.zoom + 1)).toBeGreaterThan(390 * 0.8);
    // 再大也不缩到比能看的最小级别还小
    expect(locateView({ ...HANGZHOU, accuracy: 5_000_000 }, 390, 700).zoom).toBe(3);
  });

  test("知道精度：蓝点（me）加精度圈；不知道：只有蓝点；手机交来的点旁边写几点交来的（今天的只写时间，别的日子带日期）", () => {
    const browser: HereFix = { ...HANGZHOU, accuracy: 25, source: "browser", gotAt: NOW };
    expect(hereScene(browser)).toEqual({
      marks: [{ id: HERE_MARK_ID, ...HANGZHOU, kind: "me" }],
      lines: [],
      circles: [{ id: HERE_CIRCLE_ID, ...HANGZHOU, radius: 25, kind: "accuracy" }],
    });
    expect(hereScene({ ...HANGZHOU, source: "app", gotAt: NOW })).toEqual({ marks: [{ id: HERE_MARK_ID, ...HANGZHOU, kind: "me" }], lines: [], circles: [] });
    expect(hereScene({ ...HANGZHOU, source: "phone", at: nowIso(new Date(NOW - 12 * 60_000)), gotAt: NOW }).marks[0]!.label).toBe("手机 · 10:18");
    expect(hereScene({ ...HANGZHOU, source: "phone", at: nowIso(new Date(2026, 10, 6, 22, 5)), gotAt: NOW }).marks[0]!.label).toBe("手机 · 11-06 22:05");
    expect(hereScene(undefined)).toEqual(EMPTY_SCENE);
  });

  test("加到地图上已有的东西后面（压在最上面）；还没定过原样不动", () => {
    const base = { marks: [{ id: "a", lat: 1, lon: 2 }], lines: [], circles: [{ id: "c", lat: 1, lon: 2, radius: 100 }] };
    expect(withHere(base, EMPTY_SCENE)).toBe(base);
    const here = hereScene({ ...HANGZHOU, accuracy: 25, source: "browser", gotAt: NOW });
    const both = withHere(base, here);
    expect(both.marks.map((m) => m.id)).toEqual(["a", HERE_MARK_ID]);
    expect(both.circles.map((c) => c.id)).toEqual(["c", HERE_CIRCLE_ID]);
  });

  test("一分钟内这台设备上定到的算新的（再点直接回去）；手机交来的、一分钟以前的不算", () => {
    expect(fixIsFresh({ ...HANGZHOU, source: "browser", gotAt: NOW - 30_000 }, NOW)).toBe(true);
    expect(fixIsFresh({ ...HANGZHOU, source: "app", gotAt: NOW - 59_000 }, NOW)).toBe(true);
    expect(fixIsFresh({ ...HANGZHOU, source: "browser", gotAt: NOW - 61_000 }, NOW)).toBe(false);
    expect(fixIsFresh({ ...HANGZHOU, source: "phone", gotAt: NOW }, NOW)).toBe(false);
    expect(fixIsFresh(undefined, NOW)).toBe(false);
  });

  test("不在大陆：挪过去之后按 429 的规则挑底图，新加坡是 OpenStreetMap、杭州是高德", () => {
    expect(chooseBasemap(locateView({ ...SINGAPORE, accuracy: 20 }, 390, 700), true)).toBe("osm");
    expect(chooseBasemap(locateView({ ...HANGZHOU, accuracy: 20 }, 390, 700), true)).toBe("amap");
  });
});

/** 假 AMap 的标记、圆收到的参数 */
type SeenMarker = { position: [number, number]; zIndex?: number; content: { dataset: Record<string, string> } };

/** 假 AMap：记下标记、圆收到的参数（地图本身什么都不做） */
function fakeAmap() {
  const markers: SeenMarker[] = [];
  const circles: Array<Record<string, unknown>> = [];
  class FakeMap {
    getCenter() {
      return { getLng: () => 0, getLat: () => 0 };
    }
    getZoom() {
      return 15;
    }
    setZoomAndCenter() {}
    setZoom() {}
    setMapStyle() {}
    on() {}
    add() {}
    remove() {}
    destroy() {}
  }
  const Marker = function (options: SeenMarker) {
    markers.push(options);
  };
  const Circle = function (options: Record<string, unknown>) {
    circles.push(options);
  };
  return { ns: { Map: FakeMap, Marker, Circle, Polyline: Circle } as unknown as AmapNamespace, markers, circles };
}

/** Node 里没有 DOM：一个最小的元素（fillMark、取颜色要用到的那几样） */
function element(): Record<string, unknown> {
  return {
    className: "",
    dataset: {},
    style: {},
    ownerDocument: doc,
    remove() {},
    append() {},
    replaceChildren() {},
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
  };
}
const doc = { createElement: element };

describe("高德底图上画蓝点：转了坐标", () => {
  const host = { ownerDocument: doc, append() {} } as unknown as HTMLElement;
  vi.stubGlobal("getComputedStyle", () => ({ color: "rgb(0, 0, 0)", getPropertyValue: (name: string) => (name === "--you" ? "#2a5ff5" : name === "--primary" ? "#3b6cf6" : "") }));

  test("大陆里：蓝点交给高德的是 GCJ-02（偏几百米），压在别的点上面；精度圈同样转了、是 --you 的颜色", () => {
    const { ns, markers, circles } = fakeAmap();
    const engine = createAmapEngine(host, ns, { view: { ...HANGZHOU, zoom: 15 }, dark: false, onMoveEnd() {} });
    engine.setScene(withHere({ marks: [{ id: "p", lat: 30.25, lon: 120.14 }], lines: [], circles: [] }, hereScene({ ...HANGZHOU, accuracy: 30, source: "browser", gotAt: NOW })));
    const me = markers.find((m) => m.content.dataset.kind === "me")!;
    const gcj = wgsToGcj(HANGZHOU);
    expect(me.position).toEqual([gcj.lon, gcj.lat]);
    expect(distanceMeters({ lat: me.position[1], lon: me.position[0] }, HANGZHOU)).toBeGreaterThan(100);
    expect(me.zIndex).toBeGreaterThan(markers.find((m) => m.content.dataset.id === "p")!.zIndex!);
    expect(circles).toHaveLength(1);
    expect(circles[0]).toMatchObject({ center: [gcj.lon, gcj.lat], radius: 30, strokeColor: "#2a5ff5", fillColor: "#2a5ff5", extData: { id: HERE_CIRCLE_ID, kind: "accuracy" } });
  });

  test("大陆外：原样交给高德", () => {
    const { ns, markers } = fakeAmap();
    const engine = createAmapEngine(host, ns, { view: { ...SINGAPORE, zoom: 15 }, dark: false, onMoveEnd() {} });
    engine.setScene(hereScene({ ...SINGAPORE, source: "app", gotAt: NOW }));
    expect(markers[0]!.position).toEqual([SINGAPORE.lon, SINGAPORE.lat]);
  });
});

describe("演示页的退路数据", () => {
  test("12 分钟前、西湖边、精度 35 米", () => {
    const view = demoMapLatest(new Date(NOW));
    expect(view.point).toMatchObject({ lat: 30.2598, lon: 120.1452, accuracy: 35 });
    expect(NOW - Date.parse(view.point!.at)).toBe(12 * 60_000);
  });
});
