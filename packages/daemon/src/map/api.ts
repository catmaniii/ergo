// 地图插件对外的接口（ADR-0027）：内核（网关、组合根）只从这里拿地图的东西——服务名（经插件宿主按名字取：插件没启用时
// service 取到 undefined，active 回"地图插件没启用"）和它的类型；不 import 地图插件的别的文件（test/map/boundary.test.ts 检查）。
// 地图插件的服务给三处用：
// - 网关的 /tiles/<源>/<z>/<x>/<y>：转发 OpenStreetMap 的瓦片（带缓存）；
// - 网关的 /_AMapService/…：高德 JS API 的安全密钥代理（拼上安全密钥再转给高德）；
// - GET /api/map/config：地图页现在能用什么（高德 Web 端的 Key；安全密钥不给）。
import type { MapConfigView, MapTileAddress } from "@ergo/protocol";
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
