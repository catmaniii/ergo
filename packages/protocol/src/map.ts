// 地图（429 地图插件）的地址和常量：网关的瓦片转发、高德安全密钥的代理在哪个前缀下，网页和守护进程都从这里取。
// 不引用 TypeBox（页面要的地图设置的 schema 在 map-schema.ts）。坐标转换在 geo.ts。
// - 瓦片：GET /tiles/<源>/<z>/<x>/<y>（后面可以带 .png），守护进程转发并缓存（现在只有 OpenStreetMap，源名 osm）；
//   浏览器不直接连瓦片服务器：遵守 OSM 的瓦片使用政策（带能认出二狗的 User-Agent、按缓存头缓存、不预取），
//   手机的 IP 和正在看的那一片也不直接发给地图服务；
// - 高德 JS API 的安全密钥代理：页面在加载高德的脚本之前设 window._AMapSecurityConfig = { serviceHost: <本页的来源>/_AMapService }，
//   高德的脚本把要带安全密钥的请求发到这个前缀下，守护进程拼上安全密钥（jscode）再转给高德（高德官方推荐的代理方式，
//   前缀 _AMapService 是高德定的、不能改）。安全密钥因此不进页面。

/** 瓦片转发的地址前缀 */
export const MAP_TILE_PREFIX = "/tiles/";

/** 能转发的瓦片源 */
export const MAP_TILE_SOURCES = ["osm"] as const;
export type MapTileSource = (typeof MAP_TILE_SOURCES)[number];

/** 各个瓦片源最大到第几级（OSM 官方瓦片到 19 级） */
export const MAP_TILE_MAX_ZOOM: Readonly<Record<MapTileSource, number>> = { osm: 19 };

/** 一张瓦片：源、级别、列、行 */
export interface MapTileAddress {
  readonly source: MapTileSource;
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

/** 一张瓦片在网关上的地址 */
export function mapTilePath(source: MapTileSource, z: number, x: number, y: number): string {
  return `${MAP_TILE_PREFIX}${source}/${z}/${x}/${y}`;
}

const TILE_PATH = /^\/tiles\/([a-z]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})(?:\.png)?$/;

/** 拆瓦片地址：源认得、级别不超过它的上限、列和行在这一级的范围里才算；别的给 undefined */
export function parseMapTilePath(pathname: string): MapTileAddress | undefined {
  const m = TILE_PATH.exec(pathname);
  if (!m) return undefined;
  const source = m[1] as MapTileSource;
  if (!(MAP_TILE_SOURCES as readonly string[]).includes(source)) return undefined;
  const z = Number(m[2]);
  const x = Number(m[3]);
  const y = Number(m[4]);
  const span = 2 ** z;
  if (z > MAP_TILE_MAX_ZOOM[source] || x >= span || y >= span) return undefined;
  return { source, z, x, y };
}

/** 高德安全密钥代理的前缀（高德定的名字，不能改；后面跟高德原来的路径，比如 /_AMapService/v3/geocode/regeo） */
export const AMAP_SERVICE_PREFIX = "/_AMapService";

/** 高德地图那个数据源的 id（设置 · 数据源里填 Key 的那一格，密钥区里的文件名也是它） */
export const AMAP_SOURCE_ID = "amap";

/** 地图页的地址里定位到哪（#/more/map/<纬度>,<经度>[,<级别>]）：拼 */
export function mapFocusItem(focus: { lat: number; lon: number; zoom?: number | undefined }): string {
  const round = (n: number) => String(Math.round(n * 1e6) / 1e6);
  return [round(focus.lat), round(focus.lon), ...(focus.zoom === undefined ? [] : [String(Math.round(focus.zoom * 10) / 10)])].join(",");
}

/** 地图页的地址里定位到哪：拆；不是"纬度,经度[,级别]"、超出范围的给 undefined */
export function parseMapFocusItem(item: string | undefined): { lat: number; lon: number; zoom?: number } | undefined {
  if (item === undefined) return undefined;
  const parts = item.split(",").map((s) => s.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((s) => s === "" || !Number.isFinite(Number(s)))) return undefined;
  const [lat, lon, zoom] = parts.map(Number) as [number, number, number | undefined];
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return undefined;
  if (zoom !== undefined && (zoom < 0 || zoom > 22)) return undefined;
  return { lat, lon, ...(zoom === undefined ? {} : { zoom }) };
}
