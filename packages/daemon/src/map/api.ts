// 地图插件对外的接口（ADR-0027）：内核（网关、组合根）和接进来的地图服务插件只从这里拿地图的东西——服务名（经插件宿主按名字取：
// 插件没启用时 service 取到 undefined，active 回"地图插件没启用"）和它的类型；不 import 地图插件的别的文件（test/map/boundary.test.ts 检查）。
// 455 起地图插件只管地图本身，不认识任何一家地图服务的名字：OpenStreetMap、高德、谷歌各是一个插件（openstreetmap、amap、google-maps），
// 都 needs 下面的"地图服务"插槽（MAP_PROVIDERS），在 setup 里登记一家（ADR-0061）。
// 地图插件的服务给这几处用：
// - 网关的 /tiles/<编号>/<z>/<x>/<y>：转给登记了瓦片（MapProvider.tiles）的那一家（OpenStreetMap 的瓦片转发，带缓存）；
// - 网关的 /_AMapService/…：转给登记了这个转发口（MapProvider.proxy）的那一家（高德 JS API 的安全密钥代理）；
// - GET /api/map/config：登记了的几家地图服务（445）：管哪儿、优先级、底图现在能不能用、浏览器用的 Key（安全密钥、服务端 Key 不给）；
// - POST /api/map/basemap：地图页报一家底图的事（446：建了一次——谷歌按"一次地图加载"计费；那家拒了浏览器用的 Key），转给登记的那一家。
// 另一个服务（430）"我的足迹"给 GET /api/map/day（和秘书的"画在地图上"）：某一天的点、停留、照片地点、常去的地方；
// 还给 GET /api/map/latest（442）：手机最近交来的一个位置点（地图页"回到我现在的位置"在这台设备定不了位时用）。
// 第三个（431）给 GET /api/map/drawing：聊天里的地图卡片按编号取查地点、算路线（432）查到的点和线。
// "在地图上看"（447）给 POST /api/map/find：浏览里网页上选中的地址、地名不经秘书直接查一处，放进同一份能画的，交回编号。
// 第四个（445）是"地图服务"插槽：地图服务插件（照插件契约 needs: [MAP_PROVIDERS]）经它登记一家——管哪个区域、优先级、底图
// （浏览器用的 Key）、查询（LookupProvider，下面从 lookup.ts 转出来）、用量、静态地图、瓦片、转发口。登记交回撤销函数，交给 ctx.effect，
// 插件停用、移除时自动撤掉、退回下一家；一家都没有时地图页说"没有能用的地图"。网页那一半是网页插槽 mapBasemaps（packages/web/src/plugins/slots.ts）。
// 第五个（451）给 GET /api/map/preview：聊天里地图卡片的预览图——按卡片编号（或查到的编号）取出要看全的东西、算好视野，
// 向那一家的静态地图（MapProvider.staticMap：高德、谷歌，守护进程拿 Key 去取）只要一张光底图（453：不带点和线），图原样转回，
// 视野写进回应头 X-Map-View，点和线由页面自己画；地址里不放坐标，不缓存。
import type { LatLon, MapBasemapEventBody, MapBasemapEventReply, MapConfigView, MapDatum, MapDayView, MapDrawing, MapFindResult, MapLatestView, MapPreviewQuery, MapProviderView, MapRegion, MapTileAddress } from "@ergo/protocol";
import { serviceKey, type Undo } from "../plugins/host.ts";
import type { LookupProvider } from "./lookup.ts";

// 接一家地图服务要实现的查询外形和出错的写法（别的插件只 import 这个文件）
export { MapLookupError, MAX_LINE_POINTS, thinLine } from "./lookup.ts";
// 静态地图（451）：看全时留的边、视野怎么算（453 起由地图插件算好交给各家，各家不用再算）
export { MAP_STATIC_PAD, staticView, type StaticView } from "./static-map.ts";
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
  /** 地图页现在能用什么（GET /api/map/config）：登记了的几家（providers；455 以前另给的高德 Key amapKey、amapProblem 不再给） */
  config(): MapConfigView;
  /**
   * 登记了的几家地图服务（445 的插槽，按登记的先后）：GET /api/map/config 的 providers 那一项（组合根拼进 config() 的结果里）。
   * 页面按它挑底图、列地图切换；只带浏览器用的 Key，别的密钥不在这里
   */
  providerViews(): MapProviderView[];
  /**
   * 地图页报一家底图的事（POST /api/map/basemap，446）：转给登记的那一家（MapProvider.basemapEvent）。没登记的、不收的交回 known: false，
   * 不算错（插件刚停用、旧页面）
   */
  basemapEvent(body: MapBasemapEventBody): MapBasemapEventReply;
  /**
   * 一张瓦片（网关的 /tiles/<编号>/…）：转给编号是 address.source、登记了瓦片的那一家（MapProvider.tiles）；没有这一家回 404。
   * signal 是浏览器那边断了（看别处去了）：还在排队的不再去取，已经在取的取完照样存下
   */
  tile(address: MapTileAddress, signal: AbortSignal): Promise<MapReply>;
  /**
   * 一家自己的转发口（网关的 /_AMapService/… 这类）：pathname 是整个路径，转给 MapProvider.proxy.prefix 对得上的那一家
   * （交给它的是前缀后面的那段，以 / 开头）；search 是原样的查询串（带不带 ? 都行），userAgent 是浏览器的。没有这一家回 404
   */
  proxy(pathname: string, search: string, signal: AbortSignal, userAgent?: string): Promise<MapReply>;
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

/** "在地图上看"（447）：POST /api/map/find 用 */
export interface MapFindService {
  /**
   * 网页上选中的一段地址、地名（浏览里点了"在地图上看"）直接查一处：照秘书查地点的先后（"自动"），先搜地点、搜不到当地址查；
   * 查到的放进能画的那一份（只在内存里），交回编号。没查到、地图服务没查成也交回（ok: false 和给人看的一句），不抛错
   */
  find(text: string, signal?: AbortSignal): Promise<MapFindResult>;
}

/** 地图插件提供的"在地图上看"服务 */
export const MAP_FIND = serviceKey<MapFindService>("map-find");

/** 预览图取不到（那家没填 Key、没开静态地图、超了免费量、连不上……）：message 是给人看的原因，接口回 503 带这句 */
export class MapPreviewUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MapPreviewUnavailable";
  }
}

/** 聊天里地图卡片的预览图（451）：GET /api/map/preview 用 */
export interface MapPreviewService {
  /**
   * 一张那家的静态地图：卡片编号取卡片负载（足迹按日期现算，点和路线就在卡上），查到的编号从内存取（过期了抛 RequestRejected("not_found")，
   * 接口回 404）；查到的（只能画在自己地图上的那几家查的）一律用查它的那家，q.provider 不管。那家没登记、不出静态图、取不到抛
   * MapPreviewUnavailable（503 带原因）。signal 是浏览器那边断了。
   * 453 起交给那家的只有中心、级别、尺寸、清晰度、深浅（光底图），回应头 X-Map-View 写着这张图看的是哪一片（MapPreviewView），
   * 页面照它把点和线画在图上
   */
  preview(q: MapPreviewQuery, signal: AbortSignal): Promise<MapReply>;
}

/** 地图插件提供的"卡片预览图"服务 */
export const MAP_PREVIEW = serviceKey<MapPreviewService>("map-preview");

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

/**
 * 要一张光底图（451 起聊天卡片的预览图；453 起只要底图）：只有中心、级别、尺寸、清晰度、深浅——**不带点和线**，足迹、二狗画的点和线
 * 不交给地图服务，页面拿回图以后按回应头里的视野自己画上去。中心和级别由地图插件按要看全的东西算好（static-map.ts 的 planStatic），
 * 尺寸已经按这家的上限（MapStaticSource.maxSide）缩过、级别收在这家的范围里，各家只管拼自己的参数
 */
export interface MapStaticRequest {
  /** 图的正中：这家地图自己的坐标（datum 是 gcj02 时大陆里已经转成 GCJ-02），各家原样写进参数 */
  readonly center: LatLon;
  /** 级别（整数） */
  readonly zoom: number;
  /** 宽高（逻辑像素） */
  readonly width: number;
  readonly height: number;
  /** 2 是高清（像素翻倍、看的范围不变） */
  readonly scale: 1 | 2;
  readonly dark: boolean;
}

/**
 * 一家的静态地图（451，453 起只出光底图）：上限和坐标写在这里，地图插件按它算视野；get 拿这家的 Key 去取、图原样交回，不缓存
 * （高德、谷歌的条款）。Key 只在守护进程里用，不进地址以外的地方（日志、出错的原因里都没有）
 */
export interface MapStaticSource {
  /** 一边最多多少逻辑像素（高德 1024、谷歌 640；scale 2 时像素再翻倍） */
  readonly maxSide: number;
  /** 级别的范围（整数） */
  readonly minZoom: number;
  readonly maxZoom: number;
  /** scale 2 时最大到第几级（高德：17 级时高清图不再加一级、看的范围对不上，收到 16）；不写同 maxZoom */
  readonly maxZoomHiDpi?: number;
  /** 这家的坐标：中心照它转好再交来，页面照它投影 */
  readonly datum: MapDatum;
  /** 有深色的图（455：谷歌 colorscheme=dark）：页面深色时要深色的；没有的（高德）页面要浅色的、自己压暗一点 */
  readonly dark?: boolean;
  get(req: MapStaticRequest, signal?: AbortSignal): Promise<MapStaticResult>;
}

/**
 * 静态地图取到了（图原样交回：状态、Content-Type、上游的 Cache-Control）或者没取到：哪一种、给人看的一句
 * （no_key 没填 Key、off 没开静态地图 / Key 的限制没勾它、over 超了免费量、key Key 不对、quota 到上限、network 连不上、other 别的）
 */
export type MapStaticResult =
  | { readonly ok: true; readonly reply: MapReply }
  | { readonly ok: false; readonly failure: "no_key" | "off" | "over" | "key" | "quota" | "network" | "other"; readonly reason: string };

/**
 * 一家的瓦片（455：OpenStreetMap 的瓦片转发）：网关的 /tiles/<编号>/<z>/<x>/<y> 经地图插件转给它。先看缓存，过期了问上游，
 * 上游不通时有旧的给旧的；signal 是浏览器那边断了
 */
export interface MapTileServer {
  get(address: MapTileAddress, signal: AbortSignal): Promise<MapReply>;
}

/**
 * 一家在网关上自己的转发口（455：高德 JS API 的安全密钥代理 /_AMapService）：网关只给认得的几个前缀（协议包的常量），地图插件按
 * prefix 转给它；path 是前缀后面的那段（以 / 开头），search 原样的查询串，userAgent 是浏览器的。回应原样交给浏览器
 */
export interface MapProxy {
  readonly prefix: string;
  serve(path: string, search: string, signal: AbortSignal, userAgent?: string): Promise<MapReply>;
}

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
 * 一家地图服务（445 的插槽）。455 起每一家都是一个插件登记的：OpenStreetMap（openstreetmap 插件，哪儿都管、优先级 0、不用 Key）、
 * 高德（amap 插件，国内 100、国外 30）、谷歌（google-maps 插件，大陆外 50）；以后接进来的照这个写，地图插件不认得任何一家的名字。
 * 几样都是"此刻"的：每次用时现调，Key 填了、坏了、按需查关了都跟着变。
 * 规矩：某一家查来的结果只画在它自己的底图上（ownBasemapOnly）。451 起地图页、足迹、聊天卡片的预览图都用"当前地图"
 * （这台设备在这个区域手动选的，没选就是"自动"挑的：同一个区域里优先级大的先，regionPriority 能按区域另给）。
 */
export interface MapProvider {
  /** 编号（MAP_PROVIDER_ID 的写法，和网页那一半登记的底图一样）：结果编号的前缀、卡片上的来源都是它 */
  readonly id: string;
  /** 给人看的名字（取值函数，走 t()："高德地图"） */
  readonly title: string;
  /** 给模型看的名字（只用中文："高德地图"；交给秘书的地图上下文、工具说明里写它）；不写用编号 */
  readonly modelName?: string;
  /** 选"自动"时管哪几个区域 */
  readonly regions: readonly MapRegion[];
  /** 用户在地图切换里手动选它时能用在哪几个区域（谷歌在大陆也能手动选：它自己转 GCJ-02）；不写同 regions */
  readonly manualRegions?: readonly MapRegion[];
  /** "自动"时同一个区域里数大的先用（高德 100、谷歌 50、OpenStreetMap 0） */
  readonly priority: number;
  /**
   * 某个区域里另给的优先级（451，不写用 priority）：高德在国外写 30——国外先谷歌（50）、再高德、最后 OpenStreetMap；国内照旧高德最先
   */
  readonly regionPriority?: Readonly<Partial<Record<MapRegion, number>>>;
  /**
   * 查地点、算路线管哪几个区域（451，不写同 regions；手动选它时不写就是 regions 加上 manualRegions）：高德的底图国外也能用
   * （世界地图），查询照旧只管大陆，写 ["mainland"]
   */
  readonly lookupRegions?: readonly MapRegion[];
  /** 它查来的地点、路线只能画在它自己的底图上（高德协议 4.12.4、谷歌的条款）；OpenStreetMap 不用 */
  readonly ownBasemapOnly: boolean;
  /** 底图此刻怎样；没有底图（只管查询）的不写 */
  basemap?(): MapBasemapState;
  /** 查询此刻怎样；不管查询（只有底图）的不写 */
  lookup?(): MapLookupState;
  /**
   * 给秘书的查地点、算路线工具说明里讲它的半句（给模型看的，只用中文，"大陆以外优先用谷歌地图（有公交、实时路况）"）；
   * 地图插件按优先级把登记了的几家的这半句拼成"数据从哪来"那一句。不管查询的不写
   */
  readonly toolNote?: string;
  /** 每月的用量（接近免费量时体检提示）；不收费、不限量的不写 */
  readonly usage?: MapUsageCheck;
  /**
   * 地图页报这一家底图的事（446，POST /api/map/basemap）：loaded 建了一次（按"一次地图加载"计费的据此数用量）、auth_failed 这家拒了
   * 浏览器用的 Key（记下：basemap() 不再交 Key、写原因）。要快、不联网；不按次计费、自己测得出 Key 的（高德、OpenStreetMap）不写
   */
  basemapEvent?(event: MapBasemapEventBody["event"]): void;
  /**
   * 这家的静态地图（451，聊天卡片的预览图，GET /api/map/preview 经地图插件来；453 起只要光底图，点和线页面自己画）。
   * 没有静态地图的（OpenStreetMap：页面自己画）不写
   */
  readonly staticMap?: MapStaticSource;
  /** 瓦片（455：网关的 /tiles/<编号>/… 转给它；页面自己画的那种底图，OpenStreetMap）；没有的不写 */
  readonly tiles?: MapTileServer;
  /** 网关上自己的转发口（455：高德的安全密钥代理 /_AMapService）；没有的不写 */
  readonly proxy?: MapProxy;
}

/** 地图服务插槽：登记一家（交回撤销函数）、列出登记了的（按登记的先后） */
export interface MapProviders {
  /** 登记一家：编号写法不对、和已有的重了直接抛错（装配出错） */
  register(provider: MapProvider): Undo;
  list(): readonly MapProvider[];
}

/** 地图插件提供的"地图服务"插槽 */
export const MAP_PROVIDERS = serviceKey<MapProviders>("map-providers");
