// 静态地图（451，聊天卡片的预览图）里各家共用的那一半：要看全哪些点、视野怎么算。纯函数，不联网。
// 453 起向地图服务只要一张**光底图**（中心、级别、尺寸、清晰度、深浅），足迹、二狗给的点和线、查到的点和线都不进发给地图公司的请求：
// 这里只拿它们算"看哪一片"，点和线由页面按回应头 X-Map-View 写的视野自己画在图上（plugins/map/static-overlay.ts）。
// - 要看全的点（*Bounds）：和页面画卡片时用的同一份（足迹：轨迹的点、照片地点、停留；点和路线：卡上的；查到的：点和线上的点），
//   页面画的东西才都落在图里；
// - 视野（staticView）：看全所有点，四周留边（针头往上伸，上面多留；下面留出地图公司的标志和版权那一条，页面画的东西不盖住它），
//   级别取整数、收在那家的范围里。Web 墨卡托、256 像素一张瓦片：高德、谷歌的静态地图都是这个投影，scale=2 时像素翻倍、看的范围不变，
//   所以按逻辑像素算；
// - planStatic：按那家的上限（MapStaticSource）缩尺寸、定级别范围，把中心按那家的坐标转好，交回给那家的请求和写进回应头的视野。
import { type LatLon, type MapCardShow, type MapDayView, type MapDrawing, type MapPreviewView, wgsToGcj } from "@ergo/protocol";
import type { MapStaticRequest, MapStaticSource } from "./api.ts";

/**
 * 看全时四周留的边（逻辑像素）：针头往上伸 30 像素，上面多留；下面留出地图公司的标志和版权那一条（谷歌、高德都在左下、右下，
 * 约 20 像素高），点的针尖和线不落进去
 */
export const MAP_STATIC_PAD = { x: 24, top: 40, bottom: 28 } as const;

/** 某一天的足迹要看全的点：轨迹的点、有地点的照片、停留（和网页 footprints.ts 的 footprintDay 一样） */
export function dayBounds(view: MapDayView): LatLon[] {
  return [...view.points, ...view.photos, ...view.stays].map((p) => ({ lat: p.lat, lon: p.lon }));
}

/** 秘书给的一组点、一条路线（卡上存的）：路线看全线上的点，一组点看全这几个点（和网页 card-scene.ts 一样） */
export function shownBounds(show: Extract<MapCardShow, { kind: "points" | "route" }>): LatLon[] {
  return (show.kind === "route" ? show.points : show.marks).map((p) => ({ lat: p.lat, lon: p.lon }));
}

/** 查到的那一份：点和线上的点 */
export function drawingBounds(drawing: MapDrawing): LatLon[] {
  return [...drawing.marks, ...drawing.lines.flatMap((l) => l.points)].map((p) => ({ lat: p.lat, lon: p.lon }));
}

/** 宽高按上限等比缩（逻辑像素，取整） */
export function fitSize(width: number, height: number, max: number): { width: number; height: number } {
  const ratio = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)) };
}

/** 视野：中心、级别（整数） */
export interface StaticView {
  readonly center: LatLon;
  readonly zoom: number;
}

const MAX_LAT = 85.05112878;
/** 经纬度 → 第 z 级的世界像素 */
function world(p: LatLon, z: number): { x: number; y: number } {
  const scale = 256 * 2 ** z;
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, p.lat));
  const s = Math.sin((lat * Math.PI) / 180);
  return { x: ((p.lon + 180) / 360) * scale, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale };
}
/** 第 z 级的世界像素 → 经纬度 */
function unworld(x: number, y: number, z: number): LatLon {
  const scale = 256 * 2 ** z;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lon: (x / scale) * 360 - 180 };
}

/**
 * 看全这些点的视野（宽高是逻辑像素）：留出 MAP_STATIC_PAD 的边，级别取能放下的最大整数、收在 [minZoom, maxZoom]；
 * 只有一个点（或都挤在一处）看 single 级。没有点给 undefined
 */
export function staticView(bounds: readonly LatLon[], width: number, height: number, range: { minZoom: number; maxZoom: number; single?: number }): StaticView | undefined {
  if (bounds.length === 0) return undefined;
  const room = { w: Math.max(16, width - 2 * MAP_STATIC_PAD.x), h: Math.max(16, height - MAP_STATIC_PAD.top - MAP_STATIC_PAD.bottom) };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of bounds) {
    const w = world(p, 0);
    minX = Math.min(minX, w.x);
    maxX = Math.max(maxX, w.x);
    minY = Math.min(minY, w.y);
    maxY = Math.max(maxY, w.y);
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const single = range.single ?? 15;
  const fit = spanX < 1e-9 && spanY < 1e-9 ? single : Math.floor(Math.min(Math.log2(room.w / Math.max(spanX, 1e-9)), Math.log2(room.h / Math.max(spanY, 1e-9))));
  const zoom = Math.min(range.maxZoom, Math.max(range.minZoom, Math.min(fit, single)));
  // 中心：外接框的中心，再往上挪半个"上下边的差"，东西落在留了边以后剩下那一块的正中
  const scale = 2 ** zoom;
  const cx = ((maxX + minX) / 2) * scale;
  const cy = ((maxY + minY) / 2) * scale - (MAP_STATIC_PAD.top - MAP_STATIC_PAD.bottom) / 2;
  return { center: unworld(cx, cy, zoom), zoom };
}

/**
 * 向那一家要的光底图和写进回应头的视野：宽高按那家的上限缩、级别收在那家的范围里（高清图另有上限），中心按那家的坐标转好。
 * 没有要看全的点给 undefined
 */
export function planStatic(
  bounds: readonly LatLon[],
  source: Pick<MapStaticSource, "maxSide" | "minZoom" | "maxZoom" | "maxZoomHiDpi" | "datum">,
  q: { width: number; height: number; scale: 1 | 2; dark: boolean },
): { request: MapStaticRequest; view: MapPreviewView } | undefined {
  const size = fitSize(q.width, q.height, source.maxSide);
  const maxZoom = q.scale === 2 ? Math.min(source.maxZoom, source.maxZoomHiDpi ?? source.maxZoom) : source.maxZoom;
  const view = staticView(bounds, size.width, size.height, { minZoom: source.minZoom, maxZoom });
  if (view === undefined) return undefined;
  const center = source.datum === "gcj02" ? wgsToGcj(view.center) : view.center;
  return {
    request: { center, zoom: view.zoom, width: size.width, height: size.height, scale: q.scale, dark: q.dark },
    view: { lat: view.center.lat, lon: view.center.lon, zoom: view.zoom, width: size.width, height: size.height, scale: q.scale, datum: source.datum },
  };
}

/** 坐标写几位小数（地址里：6 位约 0.1 米） */
export const fixed = (n: number, digits: number) => n.toFixed(digits);
