// 地图插件对外的接口（ADR-0027）：内核（网关、组合根）只从这里拿地图的东西——服务名（经插件宿主按名字取：插件没启用时
// service 取到 undefined，active 回"地图插件没启用"）和它的类型；不 import 地图插件的别的文件（test/map/boundary.test.ts 检查）。
// 地图插件的服务给三处用：
// - 网关的 /tiles/<源>/<z>/<x>/<y>：转发 OpenStreetMap 的瓦片（带缓存）；
// - 网关的 /_AMapService/…：高德 JS API 的安全密钥代理（拼上安全密钥再转给高德）；
// - GET /api/map/config：地图页现在能用什么（高德 Web 端的 Key；安全密钥不给）。
// 另一个服务（430）"我的足迹"给 GET /api/map/day（和秘书的"画在地图上"）：某一天的点、停留、照片地点、常去的地方。
// 第三个（431）给 GET /api/map/drawing：聊天里的地图卡片按编号取查地点、算路线（432）查到的点和线。
import type { MapConfigView, MapDayView, MapDrawing, MapTileAddress } from "@ergo/protocol";
import { serviceKey } from "../plugins/host.ts";

/** 插件名（配置 plugins.disabled 里写的、网页插件的名字） */
export const MAP_PLUGIN = "map";

/** 转发回来、要原样交给浏览器的一个回应：状态码、要写的几个头、正文 */
export interface MapReply {
  readonly status: number;
  /** 只放 Content-Type、Cache-Control 这类要原样写给浏览器的 */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export interface MapService {
  /** 地图页现在能用什么（GET /api/map/config）：高德 Web 端的 Key（填了 Key 和安全密钥、高德没说它不对才有） */
  config(): MapConfigView;
  /**
   * 一张瓦片（网关的 /tiles/）：先看缓存，过期了带条件请求问上游，上游不通时有旧的给旧的。
   * signal 是浏览器那边断了（看别处去了）：还在排队的不再去取，已经在取的取完照样存下
   */
  tile(address: MapTileAddress, signal: AbortSignal): Promise<MapReply>;
  /**
   * 高德安全密钥代理（网关的 /_AMapService/<path>）：path 是前缀后面的那段（以 / 开头），search 是原样的查询串（带不带 ? 都行）。
   * 拼上安全密钥转给高德，回应原样交回，不缓存（高德协议不许缓存）。userAgent 是浏览器的（照高德官方 nginx 代理那样原样带过去）
   */
  amapService(path: string, search: string, signal: AbortSignal, userAgent?: string): Promise<MapReply>;
}

/** 地图插件提供的服务 */
export const MAP = serviceKey<MapService>("map");

/** 我的足迹（430）：GET /api/map/day 和以后秘书的"画在地图上"（431）用 */
export interface MapDayService {
  /**
   * 某一天（YYYY-MM-DD）的足迹：位置点、停留、有地点的照片、起了名的常去的地方（经手机插件现算，只读它自己的存储，
   * 不联网、不调任何地图服务）。日期写法不对、手机插件没启用抛 RequestRejected（接口回 400 带这句）
   */
  day(date: string): MapDayView;
}

/** 地图插件提供的"我的足迹"服务 */
export const MAP_DAY = serviceKey<MapDayService>("map-day");

/** 聊天里的地图卡片（431）：GET /api/map/drawing 用 */
export interface MapDrawingService {
  /**
   * 查地点、算路线（432）那一次查到的能画的那一份（点、线，WGS-84）：只在内存里留一会儿（高德的协议不许存），
   * 过期了、二狗重启过、没有这个编号抛 RequestRejected("not_found")（接口回 404 带这句）
   */
  drawing(lookup: string): MapDrawing;
}

/** 地图插件提供的"查到的能画的那一份"服务 */
export const MAP_DRAWING = serviceKey<MapDrawingService>("map-drawing");
