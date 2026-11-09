// 静态地图（451，聊天卡片的预览图；453 起只要光底图）里各家共用的那一半和两家拼的地址（纯函数，不联网）：
// - 要看全的点：足迹（轨迹、照片地点、停留，和网页 footprintDay 一样）、点和路线、查到的；
// - 视野（看全、留边——下面留出地图公司标志那一条、级别取整数、收在范围里，一个点看 15 级）；
// - planStatic：尺寸按那家的上限缩、高清图的级别上限、中心按那家的坐标转（大陆里 GCJ-02、国外不转），回应头的视野是 WGS-84 的中心；
// - 高德、谷歌的地址里只有中心、级别、尺寸、清晰度（谷歌再加固定的 format、maptype、language 和深色），没有 markers、paths、path。
import { activeLocale, activeLocaleFrom, gcjToWgs, type LatLon, type MapDayView, type MapDrawing, setActiveLocale, wgsToGcj } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { GOOGLE_STATIC, googleStaticParams } from "../../src/google-maps/static-map.ts";
import { AMAP_STATIC, amapStaticParams } from "../../src/map/amap-static.ts";
import { dayBounds, drawingBounds, fitSize, MAP_STATIC_PAD, planStatic, shownBounds, staticView } from "../../src/map/static-map.ts";
import { builtinCatalogs } from "../../src/i18n/index.ts";

const zh = activeLocale();
afterEach(() => setActiveLocale(zh));

const HANGZHOU = { lat: 30.2741, lon: 120.1551 };
const SINGAPORE = { lat: 1.2834, lon: 103.8607 };

/** 某一天：12 处停留、轨迹 300 个点、一张照片 */
function busyDay(): MapDayView {
  const stays = Array.from({ length: 12 }, (_, i) => ({
    id: `s${i}`,
    spot: `spot-${i}`,
    from: `2026-11-06T${String(8 + i).padStart(2, "0")}:00:00.000+08:00`,
    to: `2026-11-06T${String(8 + i).padStart(2, "0")}:30:00.000+08:00`,
    minutes: (i + 1) * 10,
    lat: HANGZHOU.lat + i * 0.002,
    lon: HANGZHOU.lon + i * 0.002,
    points: 3,
  }));
  const points = Array.from({ length: 300 }, (_, i) => ({ at: new Date(Date.parse("2026-11-06T08:00:00+08:00") + i * 60_000).toISOString(), lat: HANGZHOU.lat + i * 0.0001, lon: HANGZHOU.lon + i * 0.0001 }));
  const photos = [{ id: "p1", at: "2026-11-06T09:10:00.000+08:00", lat: 30.31, lon: 120.2 }];
  return { date: "2026-11-06", points, stays, photos, unlocatedPhotos: 0, places: [], days: ["2026-11-06"], linked: { location: true, photos: true } } as MapDayView;
}

/** 这一级的世界像素 */
function px(p: LatLon, zoom: number) {
  const scale = 256 * 2 ** zoom;
  const s = Math.sin((p.lat * Math.PI) / 180);
  return { x: ((p.lon + 180) / 360) * scale, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale };
}

describe("要看全的点", () => {
  it("足迹：轨迹的每个点、照片地点、每段停留都算进去（和网页画的同一份），不挑、不抽稀", () => {
    const day = busyDay();
    const b = dayBounds(day);
    expect(b).toHaveLength(300 + 1 + 12);
    expect(b).toContainEqual({ lat: 30.31, lon: 120.2 });
  });

  it("查到的：点和线上的点；秘书给的路线看全线上的点、一组点看全这几个点", () => {
    const drawing: MapDrawing = {
      id: "amap-r1",
      kind: "route",
      source: "amap",
      title: "去西湖",
      at: "2026-11-08T09:00:00+08:00",
      marks: [{ id: "here", ...HANGZHOU, kind: "here" }],
      lines: [{ id: "l1", points: [HANGZHOU, { lat: 30.26, lon: 120.14 }], kind: "route" }],
    };
    expect(drawingBounds(drawing)).toEqual([HANGZHOU, HANGZHOU, { lat: 30.26, lon: 120.14 }]);
    const route = { kind: "route" as const, points: [HANGZHOU, { lat: 30.26, lon: 120.14 }], marks: [{ id: "r1", ...HANGZHOU, label: "起点" }] };
    expect(shownBounds(route)).toEqual([HANGZHOU, { lat: 30.26, lon: 120.14 }]);
    expect(shownBounds({ kind: "points", marks: [{ id: "a", ...SINGAPORE }] })).toEqual([SINGAPORE]);
  });
});

describe("视野", () => {
  it("级别是整数、收在范围里；一个点看 15 级；所有点都在留了边的那一块里（下面留出标志那一条）", () => {
    expect(staticView([], 400, 200, { minZoom: 1, maxZoom: 17 })).toBeUndefined();
    expect(staticView([HANGZHOU], 400, 200, { minZoom: 1, maxZoom: 17 })!.zoom).toBe(15);
    expect(staticView([HANGZHOU, SINGAPORE], 400, 200, { minZoom: 3, maxZoom: 17 })!.zoom).toBe(3);
    const pts = [HANGZHOU, { lat: 30.2598, lon: 120.1452 }, { lat: 30.2801, lon: 120.1302 }];
    const v = staticView(pts, 400, 200, { minZoom: 1, maxZoom: 17 })!;
    expect(Number.isInteger(v.zoom)).toBe(true);
    const c = px(v.center, v.zoom);
    for (const p of pts) {
      const d = px(p, v.zoom);
      expect(d.x - c.x).toBeGreaterThanOrEqual(-200 + MAP_STATIC_PAD.x - 1);
      expect(d.x - c.x).toBeLessThanOrEqual(200 - MAP_STATIC_PAD.x + 1);
      expect(d.y - c.y).toBeGreaterThanOrEqual(-100 + MAP_STATIC_PAD.top - 1);
      expect(d.y - c.y).toBeLessThanOrEqual(100 - MAP_STATIC_PAD.bottom + 1);
    }
    expect(MAP_STATIC_PAD.bottom).toBeGreaterThanOrEqual(24);
    // 大一级就放不下了
    expect(staticView(pts, 400, 200, { minZoom: 1, maxZoom: v.zoom - 1 })!.zoom).toBe(v.zoom - 1);
  });

  it("宽高按上限等比缩", () => {
    expect(fitSize(2000, 1000, 1024)).toEqual({ width: 1024, height: 512 });
    expect(fitSize(400, 200, 640)).toEqual({ width: 400, height: 200 });
  });

  it("planStatic：尺寸按那家的上限缩；中心大陆里转 GCJ-02 交给那家、回应头里是 WGS-84；国外不转", () => {
    const pts = [HANGZHOU, { lat: 30.2598, lon: 120.1452 }];
    const plan = planStatic(pts, GOOGLE_STATIC, { width: 800, height: 400, scale: 2, dark: true })!;
    expect(plan.request).toMatchObject({ width: 640, height: 320, scale: 2, dark: true });
    expect(plan.view).toMatchObject({ width: 640, height: 320, scale: 2, zoom: plan.request.zoom, datum: "gcj02" });
    const gcj = wgsToGcj({ lat: plan.view.lat, lon: plan.view.lon });
    expect(plan.request.center.lat).toBeCloseTo(gcj.lat, 9);
    expect(plan.request.center.lon).toBeCloseTo(gcj.lon, 9);
    expect(plan.request.center.lat).not.toBeCloseTo(plan.view.lat, 4);
    // 国外：一样
    const abroad = planStatic([SINGAPORE], AMAP_STATIC, { width: 400, height: 200, scale: 1, dark: false })!;
    expect(abroad.request.center).toEqual({ lat: abroad.view.lat, lon: abroad.view.lon });
    expect(abroad.request.zoom).toBe(15);
    // 处处 WGS-84 的那一家：不转
    const wgs = planStatic(pts, { ...GOOGLE_STATIC, datum: "wgs84" }, { width: 400, height: 200, scale: 1, dark: false })!;
    expect(wgs.request.center).toEqual({ lat: wgs.view.lat, lon: wgs.view.lon });
    expect(planStatic([], AMAP_STATIC, { width: 400, height: 200, scale: 1, dark: false })).toBeUndefined();
  });

  it("planStatic：高清图的级别收在 maxZoomHiDpi（高德 16：17 级时高清图不再加一级、看的范围对不上），普通图收在 maxZoom", () => {
    expect(AMAP_STATIC.maxZoomHiDpi).toBe(16);
    const one = [HANGZHOU];
    const capped = { ...AMAP_STATIC, maxZoomHiDpi: 10 };
    expect(planStatic(one, capped, { width: 400, height: 200, scale: 2, dark: false })!.request.zoom).toBe(10);
    expect(planStatic(one, capped, { width: 400, height: 200, scale: 1, dark: false })!.request.zoom).toBe(15);
    expect(planStatic(one, GOOGLE_STATIC, { width: 400, height: 200, scale: 2, dark: false })!.request.zoom).toBe(15);
  });
});

/** 一张卡要的光底图：大陆里（中心已经是 GCJ-02） */
const MAINLAND_REQ = { center: wgsToGcj(HANGZHOU), zoom: 14, width: 400, height: 200, scale: 2 as const, dark: false };

describe("高德的静态地图地址：只有底图", () => {
  it("location 是交来的中心（经度在前、6 位小数）、zoom、size、scale=2；没有 markers、labels、paths", () => {
    const q = amapStaticParams(MAINLAND_REQ);
    expect([...q.keys()].toSorted()).toEqual(["location", "scale", "size", "zoom"]);
    expect(q.get("size")).toBe("400*200");
    expect(q.get("scale")).toBe("2");
    expect(q.get("zoom")).toBe("14");
    const [lon, lat] = q.get("location")!.split(",").map(Number) as [number, number];
    const back = gcjToWgs({ lat, lon });
    expect(back.lat).toBeCloseTo(HANGZHOU.lat, 5);
    expect(back.lon).toBeCloseTo(HANGZHOU.lon, 5);
    expect(q.get("location")).toMatch(/^\d+\.\d{6},\d+\.\d{6}$/);
  });

  it("不要高清不写 scale；深色也不写什么（高德没有深色，页面压暗）", () => {
    const q = amapStaticParams({ center: SINGAPORE, zoom: 15, width: 1000, height: 1000, scale: 1, dark: true });
    expect([...q.keys()].toSorted()).toEqual(["location", "size", "zoom"]);
    expect(q.get("location")).toBe(`${SINGAPORE.lon.toFixed(6)},${SINGAPORE.lat.toFixed(6)}`);
  });
});

describe("谷歌的静态地图地址：只有底图", () => {
  it("center、zoom、size、scale=2、png、roadmap、语言跟界面、深色 colorscheme=dark；没有 markers、path", () => {
    const q = googleStaticParams({ ...MAINLAND_REQ, width: 640, height: 320, dark: true });
    expect([...q.keys()].toSorted()).toEqual(["center", "colorscheme", "format", "language", "maptype", "scale", "size", "zoom"]);
    expect(q.get("size")).toBe("640x320");
    expect(q.get("format")).toBe("png");
    expect(q.get("language")).toBe("zh-CN");
    expect(q.get("colorscheme")).toBe("dark");
    expect(q.get("center")).toBe(`${MAINLAND_REQ.center.lat.toFixed(6)},${MAINLAND_REQ.center.lon.toFixed(6)}`);
  });

  it("英文界面写 en；浅色不写 colorscheme；不要高清不写 scale", () => {
    setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, "en"));
    const q = googleStaticParams({ center: SINGAPORE, zoom: 15, width: 320, height: 160, scale: 1, dark: false });
    expect(q.get("language")).toBe("en");
    expect(q.has("colorscheme")).toBe(false);
    expect(q.has("scale")).toBe(false);
    expect(q.has("markers")).toBe(false);
  });
});
