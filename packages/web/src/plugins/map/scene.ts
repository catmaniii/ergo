// 地图页上画什么、看哪里（429 地图插件）：纯的类型和函数，不碰 DOM，测试在 Node 里跑。
// - 坐标一律 WGS-84（二狗里存的、手机交来的就是它）；画到高德地图上时由高德那一套（amap-engine.ts）自己转 GCJ-02；
// - 一屏用哪种底图（chooseBasemap）：看的那一片的中心在中国大陆、高德能用（填了 Key、脚本加载上了）用高德，别的用 OpenStreetMap；
//   画着用户自己的足迹时一律 OpenStreetMap（AMAP_WITH_FOOTPRINTS）；
// - 地图上的东西（MapScene）：点（地点、停留、照片、搜到的）、线（轨迹、路线）、圈（常去的地方的范围）。429 只有原型里的两个地点，
//   430（我的足迹）、431（聊天里的地图卡片）、432（高德查地点、路线）往里放各自的东西，地图页和两种底图都照这一份画；
//   聊天里地图卡片的缩略图（MapThumb.tsx）也照它画。
import { inMainlandChina, type LatLon } from "../../state/index.ts";

/** 看的是哪里：中心（WGS-84）和级别（Web 墨卡托的级别，可以带小数） */
export interface MapView {
  readonly lat: number;
  readonly lon: number;
  readonly zoom: number;
}

/** 两种底图：高德（国内，要填 Key）、OpenStreetMap（国外和没填 Key 时） */
export type BasemapKind = "amap" | "osm";

/** 地图上的一个点 */
export interface MapMark {
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
  /** 旁边写的字（地名、"14:20 · 停留 2 小时"） */
  readonly label?: string;
  /**
   * 种类：样式按它分（地点、停留、照片、搜到的、现在在哪）。me 是地图页"回到我现在的位置"（442）定到的那一点：蓝点，不是定位针
   * （here 是查路线时"从当前位置"那一头，照旧是针）
   */
  readonly kind?: "place" | "stay" | "photo" | "search" | "here" | "me";
}

/** 一条线：轨迹、路线 */
export interface MapLine {
  readonly id: string;
  readonly points: readonly LatLon[];
  readonly kind?: "track" | "route";
}

/** 一个圈：常去的地方的范围；定位的精度圈（442） */
export interface MapCircle {
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
  /** 半径（米） */
  readonly radius: number;
  /** 种类：不写是范围（强调色）；accuracy 是"回到我现在的位置"的精度圈（和蓝点同色） */
  readonly kind?: "accuracy";
}

/** 地图上画的全部东西 */
export interface MapScene {
  readonly marks: readonly MapMark[];
  readonly lines: readonly MapLine[];
  readonly circles: readonly MapCircle[];
}

export const EMPTY_SCENE: MapScene = { marks: [], lines: [], circles: [] };

/** 能看的级别：OpenStreetMap 的瓦片到 19 级；高德能到 20 级，换回 OSM 时收到 19 */
export const MAP_MIN_ZOOM = 3;
export const MAP_MAX_ZOOM = 19;

/** 什么都没有时看哪里：整个中国大致在中间（第一次打开、没记住上次看哪里时） */
export const DEFAULT_VIEW: MapView = { lat: 34.5, lon: 108.9, zoom: 4 };

/**
 * 画着用户自己的足迹（轨迹、停留、照片地点）时，国内也用高德吗：**不用**（用户 2026-11-07 定）。高德的地图是页面里加载的高德脚本画的，
 * 足迹的点要是和它在同一个页面里，它理论上看得到；为了守住"每天的轨迹、照片地点不外发"，看足迹时一律 OpenStreetMap
 * （瓦片经这台电脑转发，点自己画），也不为它加载高德的脚本。地图页、聊天里地图卡片的缩略图都经 chooseBasemap 挑，要改只改这一个值
 */
export const AMAP_WITH_FOOTPRINTS: boolean = false;

/**
 * 这一屏用哪种底图：中心在中国大陆、高德能用时用高德；别的（国外、香港澳门台湾、没填 Key、高德没加载上）用 OpenStreetMap。
 * 大陆外 GCJ-02 和 WGS-84 一样，OSM 的瓦片、二狗的点都对得上；大陆里只有高德的底图和二狗转过的点对得上。
 * - amapUsable：这个页面上高德能用（填了 Key、高德没说它不对、脚本加载上了）。聊天页不加载高德的脚本，卡片的缩略图传 false；
 * - footprints：画着用户自己的足迹（地图页开着"足迹"、聊天里的足迹卡片），按 AMAP_WITH_FOOTPRINTS 走（现在是一律 OpenStreetMap）。
 * 地图页（MapView.tsx）和聊天里的地图卡片（MapThumb.tsx）都只经这一处挑，别处不另写挑法
 */
export function chooseBasemap(view: Pick<MapView, "lat" | "lon">, amapUsable: boolean, footprints = false): BasemapKind {
  if (footprints && !AMAP_WITH_FOOTPRINTS) return "osm";
  return amapUsable && inMainlandChina(view) ? "amap" : "osm";
}

/** 级别收进能看的范围 */
export function clampZoom(zoom: number): number {
  return Math.min(MAP_MAX_ZOOM, Math.max(MAP_MIN_ZOOM, zoom));
}

/** 看的是不是一个说得通的地方（存着的、地址里带的可能是坏的） */
export function isMapView(v: unknown): v is MapView {
  if (typeof v !== "object" || v === null) return false;
  const { lat, lon, zoom } = v as Record<string, unknown>;
  return typeof lat === "number" && typeof lon === "number" && typeof zoom === "number" && Math.abs(lat) <= 85 && Math.abs(lon) <= 180 && zoom >= 0 && zoom <= 22;
}

/** 这台设备上次看的是哪里（存在浏览器里，只是方便：坏了、没有就用默认的） */
export function parseSavedView(text: string | null): MapView | undefined {
  if (text === null) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return isMapView(v) ? { lat: v.lat, lon: v.lon, zoom: clampZoom(v.zoom) } : undefined;
  } catch {
    return undefined;
  }
}

/** 纬度在墨卡托投影里的纵坐标（弧度单位） */
function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

/** 一组点都看得见的视野（宽高是地图的像素大小）：没有点给 undefined，一个点给 15 级 */
export function viewToFit(points: readonly LatLon[], width: number, height: number): MapView | undefined {
  if (points.length === 0) return undefined;
  if (points.length === 1) return { lat: points[0]!.lat, lon: points[0]!.lon, zoom: 15 };
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const north = Math.max(...lats);
  const south = Math.min(...lats);
  const east = Math.max(...lons);
  const west = Math.min(...lons);
  // 一个瓦片 256 像素时，整个世界在第 0 级是 256 像素宽；按两个方向各要多少级取小的，留一圈边
  const y = mercatorY;
  const zx = Math.log2(((width * 0.8) / 256) * (360 / Math.max(east - west, 1e-6)));
  const zy = Math.log2(((height * 0.8) / 256) * ((2 * Math.PI) / Math.max(y(north) - y(south), 1e-9)));
  const center = Math.atan(Math.sinh((y(north) + y(south)) / 2));
  return { lat: (center * 180) / Math.PI, lon: (east + west) / 2, zoom: clampZoom(Math.floor(Math.min(zx, zy) * 2) / 2) };
}
