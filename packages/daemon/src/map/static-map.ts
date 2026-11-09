// 静态地图（451，聊天卡片的预览图）里各家共用的那一半：要画的点和线怎么挑、怎么抽稀（各家的地址长度都够），看全它们的视野怎么算。
// 纯函数，不联网。坐标一律 WGS-84（大陆里各家拼地址时自己转 GCJ-02）。
// - 点：最多 MAP_STATIC_MARKS_MAX 个（高德的上限是 10）。足迹挑待得久的那几处、查到的按排名（就是给的先后）、点和路线按先后；
//   挑完按原来的先后写序号 1～9（谷歌的标注只认一个数字或字母，第 10 个不写）；"现在在哪"另一种颜色、不写序号；
// - 线：最多 MAP_STATIC_LINES_MAX 条（高德的上限是 4），线上的点一共最多 MAP_STATIC_POINTS_MAX 个——按各条的点数分，均匀抽掉（thinLine）；
// - 视野（staticView）：看全所有点，四周留边（针头往上伸，上面多留），级别取整数、收在各家的范围里。Web 墨卡托、256 像素一张瓦片：
//   高德、谷歌的静态地图都是这个投影，scale=2 时像素翻倍、看的范围不变，所以按逻辑像素算。
import type { LatLon, MapCardShow, MapDayView, MapDrawing } from "@ergo/protocol";
import type { MapStaticMark } from "./api.ts";
import { thinLine } from "./lookup.ts";

/** 静态地图上最多几个点、几条线、线上一共几个点 */
export const MAP_STATIC_MARKS_MAX = 10;
export const MAP_STATIC_LINES_MAX = 4;
export const MAP_STATIC_POINTS_MAX = 200;
/** 写序号的点最多几个（1～9） */
const LABELED_MAX = 9;

/** 看全时四周留的边（逻辑像素）：针头往上伸，上面多留 */
export const MAP_STATIC_PAD = { x: 24, top: 40, bottom: 16 } as const;

/** 要画的东西：点、线、要看全的点 */
export interface StaticContent {
  readonly marks: readonly MapStaticMark[];
  readonly lines: readonly (readonly LatLon[])[];
  readonly bounds: readonly LatLon[];
}

/** 一个点：有序号（排进 marks 的先后）或者是"现在在哪" */
interface Candidate extends LatLon {
  readonly here?: boolean;
  /** 挑哪几个时的分（大的先留；不写按先后） */
  readonly weight?: number;
}

/** 挑点、写序号：先按分（不写按先后）留下最多 MAP_STATIC_MARKS_MAX 个，再按原来的先后写序号 */
function pickMarks(list: readonly Candidate[]): MapStaticMark[] {
  const indexed = list.map((c, i) => ({ c, i }));
  const kept = indexed
    .toSorted((a, b) => (b.c.weight ?? 0) - (a.c.weight ?? 0) || a.i - b.i)
    .slice(0, MAP_STATIC_MARKS_MAX)
    .toSorted((a, b) => a.i - b.i);
  let n = 0;
  return kept.map(({ c }) => {
    if (c.here) return { lat: c.lat, lon: c.lon, kind: "here" as const };
    n += 1;
    return { lat: c.lat, lon: c.lon, kind: "spot" as const, ...(n <= LABELED_MAX ? { label: String(n) } : {}) };
  });
}

/** 线：最多 MAP_STATIC_LINES_MAX 条（多了留点多的几条，照原来的先后），点一共最多 MAP_STATIC_POINTS_MAX 个，按各条的点数分 */
export function fitLines(lines: readonly (readonly LatLon[])[]): LatLon[][] {
  const usable = lines.map((l, i) => ({ l, i })).filter((x) => x.l.length >= 2);
  const kept = usable
    .toSorted((a, b) => b.l.length - a.l.length || a.i - b.i)
    .slice(0, MAP_STATIC_LINES_MAX)
    .toSorted((a, b) => a.i - b.i)
    .map((x) => x.l);
  const total = kept.reduce((s, l) => s + l.length, 0);
  if (total <= MAP_STATIC_POINTS_MAX) return kept.map((l) => [...l]);
  return kept.map((l) => thinLine(l, Math.max(2, Math.floor((MAP_STATIC_POINTS_MAX * l.length) / total))));
}

const contentOf = (marks: readonly Candidate[], lines: readonly (readonly LatLon[])[]): StaticContent => {
  const picked = pickMarks(marks);
  const fitted = fitLines(lines);
  return { marks: picked, lines: fitted, bounds: [...picked, ...fitted.flat()] };
};

/** 轨迹在这么久以上没有点就断开（毫秒；和网页的足迹一样） */
const TRACK_GAP_MS = 90 * 60_000;

/** 某一天的足迹：每处（同一个 spot）一个点，挑待得久的；轨迹按时间连、隔太久断开 */
export function dayStatic(view: MapDayView): StaticContent {
  const spots = new Map<string, { lat: number; lon: number; minutes: number; first: string }>();
  for (const stay of view.stays.toSorted((a, b) => a.from.localeCompare(b.from))) {
    const s = spots.get(stay.spot);
    if (s) s.minutes += stay.minutes;
    else spots.set(stay.spot, { lat: stay.lat, lon: stay.lon, minutes: stay.minutes, first: stay.from });
  }
  const marks = [...spots.values()].toSorted((a, b) => a.first.localeCompare(b.first)).map((s) => ({ lat: s.lat, lon: s.lon, weight: s.minutes }));
  const lines: LatLon[][] = [];
  let current: LatLon[] = [];
  let last: number | undefined;
  for (const p of view.points.toSorted((a, b) => a.at.localeCompare(b.at))) {
    const at = Date.parse(p.at);
    if (last !== undefined && at - last > TRACK_GAP_MS && current.length > 0) {
      lines.push(current);
      current = [];
    }
    current.push({ lat: p.lat, lon: p.lon });
    last = at;
  }
  if (current.length > 0) lines.push(current);
  const content = contentOf(marks, lines);
  // 一处都没待过、也没有轨迹：照片地点当看全的点（只是定视野，不画）
  return content.bounds.length > 0 ? content : { ...content, bounds: view.photos.map((p) => ({ lat: p.lat, lon: p.lon })) };
}

/** 秘书给的一组点、一条路线（卡上存的） */
export function shownStatic(show: Extract<MapCardShow, { kind: "points" | "route" }>): StaticContent {
  const marks = show.marks.map((m) => ({ lat: m.lat, lon: m.lon }));
  return contentOf(marks, show.kind === "route" ? [show.points] : []);
}

/** 查到的那一份：搜到的按排名（给的先后），"现在在哪"另画 */
export function drawingStatic(drawing: MapDrawing): StaticContent {
  const marks = drawing.marks.map((m, i) => ({ lat: m.lat, lon: m.lon, ...(m.kind === "here" ? { here: true, weight: 1 } : { weight: -i }) }));
  return contentOf(marks, drawing.lines.map((l) => l.points));
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
  const at0 = bounds.map((p) => world(p, 0));
  const xs = at0.map((p) => p.x);
  const ys = at0.map((p) => p.y);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  const single = range.single ?? 15;
  const fit = spanX < 1e-9 && spanY < 1e-9 ? single : Math.floor(Math.min(Math.log2(room.w / Math.max(spanX, 1e-9)), Math.log2(room.h / Math.max(spanY, 1e-9))));
  const zoom = Math.min(range.maxZoom, Math.max(range.minZoom, Math.min(fit, single)));
  // 中心：外接框的中心，再往上挪半个"上下边的差"，东西落在留了边以后剩下那一块的正中
  const scale = 2 ** zoom;
  const cx = ((Math.max(...xs) + Math.min(...xs)) / 2) * scale;
  const cy = ((Math.max(...ys) + Math.min(...ys)) / 2) * scale - (MAP_STATIC_PAD.top - MAP_STATIC_PAD.bottom) / 2;
  return { center: unworld(cx, cy, zoom), zoom };
}

/** 坐标写几位小数（地址里：6 位约 0.1 米，5 位约 1 米） */
export const fixed = (n: number, digits: number) => n.toFixed(digits);
