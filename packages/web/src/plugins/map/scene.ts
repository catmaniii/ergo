// 地图页上画什么、看哪里（429 地图插件）：纯的类型和函数，不碰 DOM，测试在 Node 里跑。
// - 坐标一律 WGS-84（二狗里存的、手机交来的就是它）；要转 GCJ-02 的底图（高德、谷歌在大陆）由它们自己的引擎转；
// - 一屏用哪种底图：445 起地图页按登记了的几家和手动切换挑（providers.ts）；451 起看足迹也用当前地图（FOOTPRINTS_ON_CURRENT_MAP）；
//   455 起地图插件不认得任何一家（以前这里有个只认高德、OpenStreetMap 两家的 chooseBasemap，去掉了）；
// - 地图上的东西（MapScene）：点（地点、停留、照片、搜到的）、线（轨迹、路线）、圈（常去的地方的范围）。429 只有原型里的两个地点，
//   430（我的足迹）、431（聊天里的地图卡片）、432（高德查地点、路线）往里放各自的东西，地图页和两种底图都照这一份画；
//   聊天里地图卡片的缩略图（MapThumb.tsx）也照它画。
import type { LatLon } from "../../state/index.ts";
import type { MapScene, MapView } from "../../model/map.ts";
import { clampZoom } from "../../ui/map-tiles.ts";

// 445：画什么、看哪里的类型挪到核心（model/map.ts：地图服务插槽的条目要用它），这里原样转出，插件里照旧从这里 import
export type { MapCircle, MapLine, MapMark, MapScene, MapView } from "../../model/map.ts";

export const EMPTY_SCENE: MapScene = { marks: [], lines: [], circles: [] };

// 能看的级别（MAP_MIN_ZOOM、MAP_MAX_ZOOM、clampZoom）455 起在核心 ui/map-tiles.ts（高德插件的引擎也用），这里原样转出
export { clampZoom, MAP_MAX_ZOOM, MAP_MIN_ZOOM } from "../../ui/map-tiles.ts";

/** 什么都没有时看哪里：整个中国大致在中间（第一次打开、没记住上次看哪里时） */
export const DEFAULT_VIEW: MapView = { lat: 34.5, lon: 108.9, zoom: 4 };

// 看足迹时用不用当前地图（FOOTPRINTS_ON_CURRENT_MAP，451 起是用）和挑底图的规矩一起放在 providers.ts，这里原样转出
export { FOOTPRINTS_ON_CURRENT_MAP } from "./providers.ts";

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
