// 静态预览图上自己画的点和线（453，plugins/map/static-overlay.tsx）：Node 里能测的那部分，数据都是编的——
// - 投影：给定视野（回应头 X-Map-View 那一份），已知坐标落在图上对的像素（赤道、66.5° 那几个算得出来的数；横着绕一圈取近的那一份）；
//   gcj02 的那一家大陆里的点先转 GCJ-02（中心在大陆外、点在大陆里时差出转的那一段）；
// - 图照 object-fit: cover 放进盒子：缩放、左上角；
// - 序号：足迹给停留编号、查到的给搜到的、别的给地点，没有上限（第 10、11 个照写）；"现在在哪"、照片不写；
// - 那一层的样子：点摆在投影出来的位置（针尖在点上）、线照画、只画到标志那一条上面；卡片取到图和视野时放图加那一层；
// - 原型的假静态图：只有底图（没有点、没有线），交回的视野照守护进程的算法（下面留出标志那一条）。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { shownContent } from "../../src/plugins/map/card-scene.ts";
import { MapCardView } from "../../src/plugins/map/MapCard.tsx";
import type { MapMark, MapScene } from "../../src/plugins/map/scene.ts";
import { coverFit, LOGO_BAND, numberedMarks, previewPoint, StaticOverlay } from "../../src/plugins/map/static-overlay.tsx";
import { demoStaticMap } from "../../src/prototype/fake-map.ts";
import { activeLocale, type MapPreviewView, setActiveLocale, wgsToGcj } from "../../src/state/index.ts";

vi.mock("../../src/plugins/map/MapThumb.tsx", () => ({ MapThumb: () => createElement("div", { className: "thumb-stub" }) }));
vi.mock("../../src/app/build-info.ts", () => ({ APP_VERSION: "0.0.0-test", CHANGELOG: "", PAGE_WEB_VERSION: undefined }));

const zh = activeLocale();
afterEach(() => setActiveLocale(zh));

const view = (over: Partial<MapPreviewView> = {}): MapPreviewView => ({ lat: 0, lon: 0, zoom: 1, width: 512, height: 512, scale: 1, datum: "wgs84", ...over });

describe("投影", () => {
  test("已知坐标：第 1 级整个世界 512 像素，中心在 0,0、图 512 见方——东经 90° 在 x=384；北纬 66.51326° 在 y=128；经度 180° 取离中心近的那一份", () => {
    expect(previewPoint({ lat: 0, lon: 0 }, view())).toEqual({ x: 256, y: 256 });
    const east = previewPoint({ lat: 0, lon: 90 }, view());
    expect(east.x).toBeCloseTo(384, 6);
    expect(east.y).toBeCloseTo(256, 6);
    // 墨卡托 y = π/2 的纬度：2·atan(e^(π/2)) - π/2
    const lat = ((2 * Math.atan(Math.exp(Math.PI / 2)) - Math.PI / 2) * 180) / Math.PI;
    expect(previewPoint({ lat, lon: 0 }, view()).y).toBeCloseTo(128, 6);
    // 中心在东经 170°：西经 170° 画在右边（近的那一份），不是跑到左边去
    const wrapped = previewPoint({ lat: 0, lon: -170 }, view({ lon: 170 }));
    expect(wrapped.x).toBeCloseTo(256 + (20 / 360) * 512, 6);
  });

  test("级别、宽高：第 15 级里相距 0.001° 经度（赤道）是 0.001/360·256·2^15 像素；图的中心在宽高的一半", () => {
    const v = view({ zoom: 15, width: 400, height: 200 });
    const p = previewPoint({ lat: 0, lon: 0.001 }, v);
    expect(p.x).toBeCloseTo(200 + (0.001 / 360) * 256 * 2 ** 15, 6);
    expect(p.y).toBeCloseTo(100, 6);
  });

  test("gcj02：大陆里的点先转 GCJ-02；中心在香港（不转）、点在深圳（转）时差出转的那一段；wgs84 的不转", () => {
    const shenzhen = { lat: 22.5431, lon: 114.0579 };
    const hk = { lat: 22.3193, lon: 114.1694 };
    const v = view({ ...hk, zoom: 12, width: 800, height: 800, datum: "gcj02" });
    const gcjPoint = previewPoint(shenzhen, v);
    const wgsPoint = previewPoint(shenzhen, { ...v, datum: "wgs84" });
    const shifted = previewPoint(wgsToGcj(shenzhen), { ...v, datum: "wgs84" });
    expect(gcjPoint.x).toBeCloseTo(shifted.x, 6);
    expect(gcjPoint.y).toBeCloseTo(shifted.y, 6);
    // 转了的确实挪了（几百米，第 12 级是几个像素）
    expect(Math.hypot(gcjPoint.x - wgsPoint.x, gcjPoint.y - wgsPoint.y)).toBeGreaterThan(5);
    // 中心和点都在大陆里：两个一起转，挨着的点几乎不差
    const hz = { lat: 30.25, lon: 120.15 };
    const near = { lat: 30.255, lon: 120.16 };
    const a = previewPoint(near, view({ ...hz, zoom: 14, width: 400, height: 200, datum: "gcj02" }));
    const b = previewPoint(near, view({ ...hz, zoom: 14, width: 400, height: 200, datum: "wgs84" }));
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1);
  });

  test("图照 object-fit: cover 放进盒子：一样大不缩不挪；宽了按宽放大、上下裁掉一点、居中", () => {
    expect(coverFit({ width: 400, height: 168 }, { width: 400, height: 168 })).toEqual({ scale: 1, left: 0, top: 0 });
    const fit = coverFit({ width: 680, height: 167 }, { width: 640, height: 158 });
    expect(fit.scale).toBeCloseTo(1.0625, 9);
    expect(fit.left).toBeCloseTo(0, 9);
    expect(fit.top).toBeCloseTo((167 - 158 * 1.0625) / 2, 9);
    expect(fit.top).toBeLessThan(0);
  });
});

const mark = (id: string, kind: MapMark["kind"]): MapMark => ({ id, lat: 0, lon: 0, kind });

describe("序号", () => {
  test("足迹：只给停留编号（照画的先后），没去的常去地方、照片不写", () => {
    const n = numberedMarks([mark("fp-place-a", "place"), mark("ph1", "photo"), mark("s1", "stay"), mark("s2", "stay")]);
    expect([...n]).toEqual([
      ["s1", 1],
      ["s2", 2],
    ]);
  });

  test("查到的：给搜到的编号，现在在哪不写；点、路线给地点编号；没有上限（第 10、12 个照写）", () => {
    expect([...numberedMarks([mark("here", "here"), mark("a", "search"), mark("b", "search")])]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    const twelve = numberedMarks(Array.from({ length: 12 }, (_, i) => mark(`p${i}`, "place")));
    expect(twelve.get("p9")).toBe(10);
    expect(twelve.get("p11")).toBe(12);
  });
});

/** 一张卡：三个点，第一个在图的正中 */
const POINTS = shownContent({
  kind: "route",
  points: [
    { lat: 30.25, lon: 120.15 },
    { lat: 30.255, lon: 120.16 },
  ],
  marks: [
    { id: "a", lat: 30.25, lon: 120.15, label: "起点" },
    { id: "b", lat: 30.255, lon: 120.16, label: "终点" },
  ],
});

describe("那一层的样子", () => {
  test("点摆在投影出来的位置（盒子和图一样大）、写序号；线照画；只画到标志那一条上面；图比盒子小时一起放大", () => {
    const v: MapPreviewView = { lat: 30.25, lon: 120.15, zoom: 14, width: 400, height: 168, scale: 2, datum: "gcj02" };
    const html = renderToStaticMarkup(createElement(StaticOverlay, { scene: POINTS.scene, view: v, box: { width: 400, height: 168 } }));
    expect(html).toContain('class="map-overlay map-static-overlay"');
    expect(html).toContain(`height:${168 - LOGO_BAND}px`);
    // 第一个点就是中心：针尖在 200,84
    expect(html).toMatch(/data-id="card-a" data-kind="place" data-n="1" style="transform:translate\(200px, 84px\)"/);
    const b = previewPoint({ lat: 30.255, lon: 120.16 }, v);
    expect(html).toContain(`translate(${Math.round(b.x)}px, ${Math.round(b.y)}px)`);
    expect(html).toContain('<span class="map-mark-num">2</span>');
    expect(html).toMatch(/<polyline class="map-line map-line-route" points="200\.0,84\.0 /);
    // 盒子宽了：一起放大、居中
    const big = renderToStaticMarkup(createElement(StaticOverlay, { scene: POINTS.scene, view: v, box: { width: 800, height: 336 } }));
    expect(big).toContain("translate(400px, 168px)");
    expect(renderToStaticMarkup(createElement(StaticOverlay, { scene: POINTS.scene, view: v, box: { width: 0, height: 0 } }))).toBe("");
  });

  test("足迹卡的圈：半径按这一级一像素多少米换", () => {
    const scene: MapScene = { marks: [], lines: [], circles: [{ id: "c1", lat: 0, lon: 0, radius: 1000 }] };
    const v = view({ zoom: 15, width: 400, height: 200 });
    const html = renderToStaticMarkup(createElement(StaticOverlay, { scene, view: v, box: { width: 400, height: 200 } }));
    const mpp = (2 * Math.PI * 6378137) / (256 * 2 ** 15);
    expect(html).toContain(`r="${(1000 / mpp).toFixed(1)}"`);
  });

  test("卡片取到了图和视野：放图加那一层（量到盒子以后画）；没有视野（旧守护进程）只放图", () => {
    const payload = { title: "两处", show: { kind: "route" as const, points: [{ lat: 30.25, lon: 120.15 }], marks: [{ id: "a", lat: 30.25, lon: 120.15 }] } };
    const data = { state: "ready" as const, content: POINTS };
    const v: MapPreviewView = { lat: 30.25, lon: 120.15, zoom: 14, width: 400, height: 168, scale: 2, datum: "gcj02" };
    const withView = renderToStaticMarkup(createElement(MapCardView, { cardId: "c1", payload, data, thumb: { kind: "image", provider: "amap", name: "高德地图", preview: { state: "ready", url: "blob:x", view: v } } }));
    expect(withView).toContain('class="map-preview" data-overlay=""');
    expect(withView).toContain('src="blob:x"');
    const without = renderToStaticMarkup(createElement(MapCardView, { cardId: "c1", payload, data, thumb: { kind: "image", provider: "amap", name: "高德地图", preview: { state: "ready", url: "blob:x" } } }));
    expect(without).not.toContain("data-overlay");
    expect(without).toContain('src="blob:x"');
  });
});

describe("原型的假静态图", () => {
  test("只有底图：没有点、没有线；视野照守护进程的算法（看全、下面留出标志那一条、宽高按上限缩）", () => {
    const pts = [
      { lat: 30.25, lon: 120.15 },
      { lat: 30.26, lon: 120.17 },
    ];
    const image = demoStaticMap("google", pts, { width: 800, height: 400, scale: 2, dark: false });
    const svg = decodeURIComponent(image.url.slice(image.url.indexOf(",") + 1));
    expect(svg).not.toContain("<polyline");
    expect(svg).not.toContain("<circle");
    expect(svg).not.toMatch(/fill="#fc6054"/i);
    expect(image.view).toMatchObject({ width: 640, height: 320, scale: 2, datum: "gcj02" });
    expect(Number.isInteger(image.view.zoom)).toBe(true);
    for (const p of pts) {
      const at = previewPoint(p, image.view);
      expect(at.x).toBeGreaterThanOrEqual(24 - 1);
      expect(at.x).toBeLessThanOrEqual(640 - 24 + 1);
      expect(at.y).toBeGreaterThanOrEqual(40 - 1);
      expect(at.y).toBeLessThanOrEqual(320 - 28 + 1);
    }
  });
});
