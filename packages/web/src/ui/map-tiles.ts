// 瓦片地图的算术（429）：Web 墨卡托投影（OpenStreetMap、高德的瓦片都是这一套，256 像素一张），纯函数，测试在 Node 里跑。
// 455 从地图插件挪到核心：地图插件自己画的瓦片引擎、那一层，和别的插件的底图引擎（高德）都用（插件之间不互相 import）；
// 地图插件的 plugins/map/tiles.ts 原样转出。地图页能看的级别（MAP_MIN_ZOOM、MAP_MAX_ZOOM）也在这里定一次。
// - 世界坐标：第 z 级整个世界是 256 × 2^z 像素见方，左上角是 (0, 0)；级别可以带小数（缩放到一半时）；
// - 一屏要哪些瓦片（tilesFor）：瓦片取最近的整数级，按差的那一点小数放大缩小；横着可以绕地球一圈（列号取模），竖着不绕。
import type { LatLon } from "../state/index.ts";

export const TILE_SIZE = 256;

/** 地图页能看的级别：瓦片底图（OpenStreetMap）的瓦片到 19 级；高德能到 20 级，统一收到 19（换底图时级别不跳） */
export const MAP_MIN_ZOOM = 3;
export const MAP_MAX_ZOOM = 19;

/** 级别收进能看的范围 */
export function clampZoom(zoom: number): number {
  return Math.min(MAP_MAX_ZOOM, Math.max(MAP_MIN_ZOOM, zoom));
}
/** Web 墨卡托能画到的最高纬度 */
export const MAX_LATITUDE = 85.05112878;

/** 一个点在第 zoom 级的世界坐标（像素） */
export function worldPoint(p: LatLon, zoom: number): { x: number; y: number } {
  const size = TILE_SIZE * 2 ** zoom;
  const lat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, p.lat));
  const sin = Math.sin((lat * Math.PI) / 180);
  return { x: ((p.lon + 180) / 360) * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
}

/** 第 zoom 级世界坐标对应的点（经度收进 -180～180） */
export function pointAt(x: number, y: number, zoom: number): LatLon {
  const size = TILE_SIZE * 2 ** zoom;
  const lon = (x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / size;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat: Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat)), lon: ((((lon + 180) % 360) + 360) % 360) - 180 };
}

/** 一屏里的一张瓦片：级别、列（没取模的，用来摆位置）、行、取模后的列（拿瓦片用） */
export interface TileSlot {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly wrappedX: number;
  readonly key: string;
}

/** 一屏要的瓦片：中心、级别（可以带小数）、宽高（像素）；瓦片级别取最近的整数，不超过 maxTileZoom */
export function tilesFor(center: LatLon, zoom: number, width: number, height: number, maxTileZoom: number): { z: number; tiles: TileSlot[] } {
  const z = Math.max(0, Math.min(maxTileZoom, Math.round(zoom)));
  const scale = 2 ** (zoom - z);
  const c = worldPoint(center, z);
  const halfW = width / 2 / scale;
  const halfH = height / 2 / scale;
  const n = 2 ** z;
  const x0 = Math.floor((c.x - halfW) / TILE_SIZE);
  const x1 = Math.floor((c.x + halfW) / TILE_SIZE);
  const y0 = Math.max(0, Math.floor((c.y - halfH) / TILE_SIZE));
  const y1 = Math.min(n - 1, Math.floor((c.y + halfH) / TILE_SIZE));
  const tiles: TileSlot[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const wrappedX = ((x % n) + n) % n;
      tiles.push({ z, x, y, wrappedX, key: `${z}/${x}/${y}` });
    }
  }
  return { z, tiles };
}

/** 一个点在屏幕上的位置（像素，相对地图左上角）：中心在屏幕正中 */
export function screenPoint(p: LatLon, center: LatLon, zoom: number, width: number, height: number): { x: number; y: number } {
  const a = worldPoint(p, zoom);
  const c = worldPoint(center, zoom);
  const size = TILE_SIZE * 2 ** zoom;
  // 横着取离中心最近的那一份（跨 180 度经线时不画到地球另一边去）
  let dx = a.x - c.x;
  if (dx > size / 2) dx -= size;
  if (dx < -size / 2) dx += size;
  return { x: width / 2 + dx, y: height / 2 + (a.y - c.y) };
}

/** 屏幕上一个位置对应的点 */
export function pointOnScreen(x: number, y: number, center: LatLon, zoom: number, width: number, height: number): LatLon {
  const c = worldPoint(center, zoom);
  return pointAt(c.x + (x - width / 2), c.y + (y - height / 2), zoom);
}

/** 在某个纬度、某个级别下一像素是多少米 */
export function metersPerPixel(lat: number, zoom: number): number {
  return (Math.cos((lat * Math.PI) / 180) * 2 * Math.PI * 6378137) / (TILE_SIZE * 2 ** zoom);
}
