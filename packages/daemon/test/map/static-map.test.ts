// 静态地图（451，聊天卡片的预览图）里各家共用的那一半和两家拼的地址（纯函数，不联网）：
// - 挑点（最多 10 个：足迹挑待得久的、查到的按排名，序号按原来的先后写 1～9，第 10 个不写；"现在在哪"不写序号）；
// - 线（最多 4 条、线上一共最多 200 个点，抽稀留头尾）；视野（看全、留边、级别取整数、收在范围里，一个点看 15 级）；
// - 高德：markers 最多 10 个、paths 最多 4 条、zoom 1～17 的整数、size 最大 1024*1024（等比缩）、scale=2、大陆里转 GCJ-02、国外不转；
// - 谷歌：size 最大 640x640、scale=2、path 是编码的折线（大陆里转 GCJ-02）、深色 colorscheme=dark、语言跟界面。
import { activeLocale, activeLocaleFrom, gcjToWgs, type LatLon, type MapDayView, type MapDrawing, setActiveLocale, wgsToGcj } from "@ergo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { decodePolyline } from "../../src/google-maps/polyline.ts";
import { googleStaticParams } from "../../src/google-maps/static-map.ts";
import type { MapStaticRequest } from "../../src/map/api.ts";
import { amapStaticParams } from "../../src/map/amap-static.ts";
import { dayStatic, drawingStatic, fitLines, fitSize, MAP_STATIC_LINES_MAX, MAP_STATIC_MARKS_MAX, MAP_STATIC_PAD, MAP_STATIC_POINTS_MAX, shownStatic, staticView } from "../../src/map/static-map.ts";
import { builtinCatalogs } from "../../src/i18n/index.ts";

const zh = activeLocale();
afterEach(() => setActiveLocale(zh));

const HANGZHOU = { lat: 30.2741, lon: 120.1551 };
const SINGAPORE = { lat: 1.2834, lon: 103.8607 };

/** 一段从 a 到 b 的直线，n 个点 */
const line = (a: LatLon, b: LatLon, n: number): LatLon[] => Array.from({ length: n }, (_, i) => ({ lat: a.lat + ((b.lat - a.lat) * i) / (n - 1), lon: a.lon + ((b.lon - a.lon) * i) / (n - 1) }));

/** 某一天：12 处，第 i 处待了 (i+1)*10 分钟（越往后待得越久），轨迹 300 个点 */
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
  return { date: "2026-11-06", points, stays, photos: [], unlocatedPhotos: 0, places: [], days: ["2026-11-06"], linked: { location: true, photos: true } };
}

describe("挑点、抽稀、视野", () => {
  it("足迹：12 处里挑待得久的 10 处，序号按先到的先后写 1～9、第 10 个不写；轨迹抽到 200 个点以内、头尾留着", () => {
    const c = dayStatic(busyDay());
    expect(c.marks).toHaveLength(MAP_STATIC_MARKS_MAX);
    // 待得最短的两处（第 0、1 处）没留
    expect(c.marks[0]).toMatchObject({ lat: HANGZHOU.lat + 2 * 0.002, kind: "spot", label: "1" });
    expect(c.marks.map((m) => m.label)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", undefined]);
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]!.length).toBeLessThanOrEqual(MAP_STATIC_POINTS_MAX);
    expect(c.lines[0]![0]).toEqual({ lat: HANGZHOU.lat, lon: HANGZHOU.lon });
    expect(c.lines[0]!.at(-1)!.lat).toBeCloseTo(HANGZHOU.lat + 299 * 0.0001, 9);
    expect(c.bounds.length).toBe(c.marks.length + c.lines[0]!.length);
  });

  it("足迹的轨迹：中间一个半小时以上没有点的断开", () => {
    const day = busyDay();
    const points = [...day.points.slice(0, 10), ...day.points.slice(200, 210).map((p) => ({ ...p, at: new Date(Date.parse(p.at) + 2 * 3600_000).toISOString() }))];
    expect(dayStatic({ ...day, points }).lines.map((l) => l.length)).toEqual([10, 10]);
  });

  it("查到的：现在在哪不写序号、搜到的按排名写 1、2、3；线最多 4 条（留点多的）、一共最多 200 个点", () => {
    const drawing: MapDrawing = {
      id: "amap-p1",
      kind: "places",
      source: "amap",
      title: "附近",
      at: "2026-11-08T09:00:00+08:00",
      marks: [
        { id: "here", ...HANGZHOU, kind: "here" },
        { id: "a", lat: 30.28, lon: 120.16, label: "甲", kind: "search" },
        { id: "b", lat: 30.29, lon: 120.17, label: "乙", kind: "search" },
        { id: "c", lat: 30.3, lon: 120.18, label: "丙", kind: "search" },
      ],
      lines: [],
    };
    expect(drawingStatic(drawing).marks.map((m) => [m.kind, m.label])).toEqual([
      ["here", undefined],
      ["spot", "1"],
      ["spot", "2"],
      ["spot", "3"],
    ]);
    const many = fitLines([line(HANGZHOU, SINGAPORE, 5), line(HANGZHOU, SINGAPORE, 300), line(HANGZHOU, SINGAPORE, 100), line(HANGZHOU, SINGAPORE, 50), line(HANGZHOU, SINGAPORE, 80), [HANGZHOU]]);
    expect(many).toHaveLength(MAP_STATIC_LINES_MAX);
    // 留下点多的四条，照原来的先后
    expect(many.reduce((s, l) => s + l.length, 0)).toBeLessThanOrEqual(MAP_STATIC_POINTS_MAX);
    expect(many[0]!.length).toBeGreaterThan(many[1]!.length);
    for (const l of many) {
      expect(l[0]).toEqual(HANGZHOU);
      expect(l.at(-1)!.lat).toBeCloseTo(SINGAPORE.lat, 9);
    }
  });

  it("秘书给的路线：线就是给的点，标出来的几处按先后写序号", () => {
    const c = shownStatic({ kind: "route", points: [HANGZHOU, { lat: 30.26, lon: 120.14 }], marks: [{ id: "r1", ...HANGZHOU, label: "起点" }, { id: "r2", lat: 30.26, lon: 120.14, label: "终点" }] });
    expect(c.marks.map((m) => m.label)).toEqual(["1", "2"]);
    expect(c.lines).toEqual([[HANGZHOU, { lat: 30.26, lon: 120.14 }]]);
  });

  it("视野：级别是整数、收在范围里；一个点看 15 级；所有点都在留了边的那一块里", () => {
    expect(staticView([], 400, 200, { minZoom: 1, maxZoom: 17 })).toBeUndefined();
    expect(staticView([HANGZHOU], 400, 200, { minZoom: 1, maxZoom: 17 })!.zoom).toBe(15);
    expect(staticView([HANGZHOU, SINGAPORE], 400, 200, { minZoom: 3, maxZoom: 17 })!.zoom).toBe(3);
    const pts = [HANGZHOU, { lat: 30.2598, lon: 120.1452 }, { lat: 30.2801, lon: 120.1302 }];
    const v = staticView(pts, 400, 200, { minZoom: 1, maxZoom: 17 })!;
    expect(Number.isInteger(v.zoom)).toBe(true);
    // 换成这一级的像素：每个点离中心的距离在留了边的那一块里
    const px = (p: LatLon) => {
      const scale = 256 * 2 ** v.zoom;
      const s = Math.sin((p.lat * Math.PI) / 180);
      return { x: ((p.lon + 180) / 360) * scale, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale };
    };
    const c = px(v.center);
    for (const p of pts) {
      const d = px(p);
      expect(d.x - c.x).toBeGreaterThanOrEqual(-200 + MAP_STATIC_PAD.x - 1);
      expect(d.x - c.x).toBeLessThanOrEqual(200 - MAP_STATIC_PAD.x + 1);
      expect(d.y - c.y).toBeGreaterThanOrEqual(-100 + MAP_STATIC_PAD.top - 1);
      expect(d.y - c.y).toBeLessThanOrEqual(100 - MAP_STATIC_PAD.bottom + 1);
    }
    // 大一级就放不下了
    expect(staticView(pts, 400, 200, { minZoom: 1, maxZoom: v.zoom - 1 })!.zoom).toBe(v.zoom - 1);
  });

  it("宽高按上限等比缩", () => {
    expect(fitSize(2000, 1000, 1024)).toEqual({ width: 1024, height: 512 });
    expect(fitSize(400, 200, 640)).toEqual({ width: 400, height: 200 });
  });
});

/** 一张卡要的：大陆里的几个点和一条线 */
const MAINLAND_REQ: MapStaticRequest = {
  marks: Array.from({ length: 10 }, (_, i) => ({ lat: 30.25 + i * 0.003, lon: 120.13 + i * 0.003, kind: "spot" as const, ...(i < 9 ? { label: String(i + 1) } : {}) })),
  lines: [line(HANGZHOU, { lat: 30.2598, lon: 120.1452 }, 50), line({ lat: 30.26, lon: 120.14 }, { lat: 30.27, lon: 120.15 }, 20)],
  bounds: [HANGZHOU, { lat: 30.2598, lon: 120.1452 }, { lat: 30.277, lon: 120.157 }],
  width: 400,
  height: 200,
  scale: 2,
  dark: false,
};

describe("高德的静态地图地址", () => {
  it("markers 一个序号一组（mid 才显示序号）、paths 一条一组；zoom 是 1～17 的整数；size、scale=2；大陆里的点转 GCJ-02", () => {
    const q = amapStaticParams(MAINLAND_REQ);
    expect(q.get("size")).toBe("400*200");
    expect(q.get("scale")).toBe("2");
    const zoom = Number(q.get("zoom"));
    expect(Number.isInteger(zoom) && zoom >= 1 && zoom <= 17).toBe(true);
    const markers = q.get("markers")!.split("|");
    expect(markers).toHaveLength(10);
    expect(markers[0]).toMatch(/^mid,0x[0-9A-F]{6},1:\d+\.\d{6},\d+\.\d{6}$/);
    expect(markers[9]).toMatch(/^mid,0x[0-9A-F]{6},:/);
    // 第一个点：GCJ-02（经度在前），转回来就是原来的点
    const [lon, lat] = markers[0]!.split(":")[1]!.split(",").map(Number) as [number, number];
    const back = gcjToWgs({ lat, lon });
    expect(back.lat).toBeCloseTo(30.25, 5);
    expect(back.lon).toBeCloseTo(120.13, 5);
    expect(lat).not.toBeCloseTo(30.25, 4);
    const paths = q.get("paths")!.split("|");
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/^6,0x2563EB,0\.85,,:/);
    expect(paths[0]!.split(":")[1]!.split(";")).toHaveLength(50);
    // 中心也是 GCJ-02
    const [clon, clat] = q.get("location")!.split(",").map(Number) as [number, number];
    expect(Math.abs(clat - 30.2684)).toBeLessThan(0.02);
    expect(Math.abs(clon - 120.15)).toBeLessThan(0.02);
    expect(q.has("key")).toBe(false);
  });

  it("太大的等比缩到 1024 以内；国外的点不转；不要高清不写 scale；没有线不写 paths", () => {
    const q = amapStaticParams({ marks: [{ ...SINGAPORE, kind: "spot", label: "1" }], lines: [], bounds: [SINGAPORE], width: 1000, height: 1000, scale: 1, dark: true });
    expect(q.get("size")).toBe("1000*1000");
    expect(q.get("markers")).toBe(`mid,0xFC6054,1:${SINGAPORE.lon.toFixed(6)},${SINGAPORE.lat.toFixed(6)}`);
    expect(q.get("zoom")).toBe("15");
    expect(q.has("scale")).toBe(false);
    expect(q.has("paths")).toBe(false);
    expect(amapStaticParams({ ...MAINLAND_REQ, width: 1024, height: 512 }).get("size")).toBe("1024*512");
  });
});

describe("谷歌的静态地图地址", () => {
  it("size 最大 640x640（等比缩）、scale=2、png、语言跟界面；markers 一个点一个参数、带序号；path 是编码的折线（大陆里 GCJ-02）；深色 colorscheme=dark", () => {
    const q = googleStaticParams({ ...MAINLAND_REQ, width: 800, height: 400, dark: true });
    expect(q.get("size")).toBe("640x320");
    expect(q.get("scale")).toBe("2");
    expect(q.get("format")).toBe("png");
    expect(q.get("language")).toBe("zh-CN");
    expect(q.get("colorscheme")).toBe("dark");
    const markers = q.getAll("markers");
    expect(markers).toHaveLength(10);
    expect(markers[0]).toMatch(/^size:mid\|color:0x[0-9A-F]{6}\|label:1\|\d+\.\d{6},\d+\.\d{6}$/);
    expect(markers[9]).not.toContain("label:");
    const paths = q.getAll("path");
    expect(paths).toHaveLength(2);
    const decoded = decodePolyline(paths[0]!.split("|enc:")[1]!);
    expect(decoded).toHaveLength(50);
    const gcj = wgsToGcj(HANGZHOU);
    expect(decoded[0]!.lat).toBeCloseTo(gcj.lat, 5);
    expect(decoded[0]!.lon).toBeCloseTo(gcj.lon, 5);
    expect(q.has("key")).toBe(false);
  });

  it("英文界面写 en；浅色不写 colorscheme；国外的点不转", () => {
    setActiveLocale(activeLocaleFrom(builtinCatalogs().catalogs, "en"));
    const q = googleStaticParams({ marks: [{ ...SINGAPORE, kind: "here" }], lines: [], bounds: [SINGAPORE], width: 320, height: 160, scale: 1, dark: false });
    expect(q.get("language")).toBe("en");
    expect(q.has("colorscheme")).toBe(false);
    expect(q.has("scale")).toBe(false);
    expect(q.getAll("markers")).toEqual([`size:mid|color:0x3B82F6|${SINGAPORE.lat.toFixed(6)},${SINGAPORE.lon.toFixed(6)}`]);
  });
});
