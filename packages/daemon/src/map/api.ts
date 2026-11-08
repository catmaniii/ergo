// 地图插件对外的接口（ADR-0027）：内核（网关、组合根）只从这里拿地图的东西——服务名（经插件宿主按名字取：插件没启用时
// service 取到 undefined，active 回"地图插件没启用"）和它的类型；不 import 地图插件的别的文件（test/map/boundary.test.ts 检查）。
// 地图插件的服务给三处用：
// - 网关的 /tiles/<源>/<z>/<x>/<y>：转发 OpenStreetMap 的瓦片（带缓存）；
// - 网关的 /_AMapService/…：高德 JS API 的安全密钥代理（拼上安全密钥再转给高德）；
// - GET /api/map/config：地图页现在能用什么（高德 Web 端的 Key；安全密钥不给）、登记了的几家地图服务（445）。
// 另一个服务（430）"我的足迹"给 GET /api/map/day（和秘书的"画在地图上"）：某一天的点、停留、照片地点、常去的地方；
// 还给 GET /api/map/latest（442）：手机最近交来的一个位置点（地图页"回到我现在的位置"在这台设备定不了位时用）。
// 第三个（431）给 GET /api/map/drawing：聊天里的地图卡片按编号取查地点、算路线（432）查到的点和线。
// 第四个（445）是"地图服务"插槽：别的插件（照插件契约 needs: [MAP_PROVIDERS]）经它登记一家地图服务——管哪个区域、优先级、底图
// （浏览器用的 Key）、查询（LookupProvider，下面从 lookup.ts 转出来）、用量。登记交回撤销函数，交给 ctx.effect，插件停用、移除时
// 自动撤掉、退回下一家。网页那一半是网页插槽 mapBasemaps（packages/web/src/plugins/slots.ts）。
import type { MapConfigView, MapDayView, MapDrawing, MapLatestView, MapProviderView, MapRegion, MapTileAddress } from "@ergo/protocol";
import { serviceKey, type Undo } from "../plugins/host.ts";
import type { LookupProvider } from "./lookup.ts";

// 接一家地图服务要实现的查询外形和出错的写法（别的插件只 import 这个文件）
export { MapLookupError, MAX_LINE_POINTS, thinLine } from "./lookup.ts";
export type { LookupProvider, MapLookupFailure, PlaceHit, RouteAnswer, RouteEnd, TrafficJam, TransitLeg, TransitPlan } from "./lookup.ts";

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
   * 登记了的几家地图服务（445 的插槽，按登记的先后）：GET /api/map/config 的 providers 那一项（组合根拼进 config() 的结果里）。
   * 页面按它挑底图、列地图切换；只带浏览器用的 Key，别的密钥不在这里
   */
  providerViews(): MapProviderView[];
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
  /**
   * 手机最近交来的一个位置点（442，GET /api/map/latest）：只这一个点，不给轨迹；经手机插件现取，不联网。
   * 手机还没交来过、手机插件没启用时没有 point（不抛错：地图页拿它当退路，没有就说拿不到）
   */
  latest(): MapLatestView;
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

/** 底图此刻怎样（地图页按它挑、列地图切换） */
export type MapBasemapState =
  | {
      readonly ready: true;
      /** 页面加载这一家的脚本要的浏览器用的 Key（会进页面：只放本来就在页面上的那一种）；不用 Key 的（OpenStreetMap）不写 */
      readonly key?: string;
    }
  | {
      readonly ready: false;
      /** 上次说 Key 不对（给人看的一句）；只是还没填的不写 */
      readonly problem?: string;
    };

/** 查询此刻怎样（给秘书的查地点、算路线工具按它挑） */
export type MapLookupState =
  | { readonly ready: true; readonly provider: LookupProvider }
  | {
      readonly ready: false;
      /** 为什么查不了（给模型看的一句，只用中文："没填查询用的 Key"） */
      readonly why: string;
    };

/** 体检里的一句：文案键 + 参数（和 409 的 DoctorMessage 一样） */
export interface MapUsageMessage {
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

/** 用量的体检结果（和 409 的 DoctorFinding 同形：五种结果之一、事实、怎么修、动作） */
export interface MapUsageFinding {
  readonly level: "ok" | "warn" | "error" | "na";
  readonly fact: MapUsageMessage;
  readonly fix?: MapUsageMessage;
  readonly action?: { readonly kind: "open"; readonly route: string };
}

/** 一家地图服务的用量：地图插件替它在体检的"地图"那一块登记一项（id 是"<编号>-usage"），只读内存和文件、不联网 */
export interface MapUsageCheck {
  /** 体检项的名字：文案键（高德是 "map.doctor.usage.title"） */
  readonly title: string;
  /** 这个月离免费量多远：到了八成注意、到了上限坏了（照 432 的高德用量） */
  run(): MapUsageFinding;
}

/**
 * 一家地图服务（445 的插槽）。高德、OpenStreetMap 是地图插件自己登记的两家；别的插件登记的照这个写（谷歌地图：大陆外、
 * 优先级 50，高于 OpenStreetMap）。几样都是"此刻"的：每次用时现调，Key 填了、坏了、按需查关了都跟着变。
 * 规矩：某一家查来的结果只画在它自己的底图上（ownBasemapOnly）；用户自己的足迹一律 OpenStreetMap，不加载商业地图的脚本（地图页管）。
 */
export interface MapProvider {
  /** 编号（MAP_PROVIDER_ID 的写法，和网页那一半登记的底图一样）：结果编号的前缀、卡片上的来源都是它 */
  readonly id: string;
  /** 给人看的名字（取值函数，走 t()："高德地图"） */
  readonly title: string;
  /** 选"自动"时管哪几个区域 */
  readonly regions: readonly MapRegion[];
  /** 用户在地图切换里手动选它时能用在哪几个区域（谷歌在大陆也能手动选：它自己转 GCJ-02）；不写同 regions */
  readonly manualRegions?: readonly MapRegion[];
  /** "自动"时同一个区域里数大的先用（高德 100、OpenStreetMap 0） */
  readonly priority: number;
  /** 它查来的地点、路线只能画在它自己的底图上（高德协议 4.12.4、谷歌的条款）；OpenStreetMap 不用 */
  readonly ownBasemapOnly: boolean;
  /** 底图此刻怎样；没有底图（只管查询）的不写 */
  basemap?(): MapBasemapState;
  /** 查询此刻怎样；不管查询（只有底图）的不写 */
  lookup?(): MapLookupState;
  /**
   * 给秘书的查地点、算路线工具说明里讲它的半句（给模型看的，只用中文，"大陆以外优先用谷歌地图（有公交、实时路况）"）；
   * 地图插件自带的两家不写（说明里本来就讲了）
   */
  readonly toolNote?: string;
  /** 每月的用量（接近免费量时体检提示）；不收费、不限量的不写 */
  readonly usage?: MapUsageCheck;
}

/** 地图服务插槽：登记一家（交回撤销函数）、列出登记了的（按登记的先后） */
export interface MapProviders {
  /** 登记一家：编号写法不对、和已有的重了直接抛错（装配出错） */
  register(provider: MapProvider): Undo;
  list(): readonly MapProvider[];
}

/** 地图插件提供的"地图服务"插槽 */
export const MAP_PROVIDERS = serviceKey<MapProviders>("map-providers");
