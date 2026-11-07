// 查地点、算路线的统一外形（432）：给秘书的工具（lookup-tools.ts）只认这一套，不管背后是哪家地图服务。
// 432 只有高德（amap-lookup.ts，国内）；433 加 OpenStreetMap（国外：Nominatim 查地点、OSRM 算路线），按点在不在中国大陆挑
// （covers），工具这边不用改。坐标进出一律 WGS-84（二狗里存的、手机交来的就是它），各家自己转（高德是 GCJ-02）。
// 查到的只现用：不落盘、不进记忆素材（高德的协议不许存、不许缓存）。
// 出错一律抛 MapLookupError：哪一种（要重新填 Key、用量到上限、查得太频繁、点在国外、找不到路……）加上服务原话，
// 给模型的话（lookup-tools.ts）和给人看的话（试查一下）各自按种类写。
import type { LatLon, MapLookupSource, MapRouteMode } from "@ergo/protocol";

/** 一个地点：搜到的、地理编码出来的、逆地理编码出来的（WGS-84） */
export interface PlaceHit {
  /** 服务那边的编号（高德的 POI id），没有就不写 */
  readonly id?: string;
  readonly name: string;
  /** 地址（街道门牌） */
  readonly address?: string;
  /** 省市区写成一段（"浙江省杭州市西湖区"） */
  readonly area?: string;
  /** 种类（"餐饮服务;咖啡厅;咖啡厅"取最后一段） */
  readonly type?: string;
  /** 离中心多远（米，周边搜才有） */
  readonly distanceM?: number;
  readonly lat: number;
  readonly lon: number;
  /** 城市编码（高德的 citycode，算公交要用） */
  readonly cityCode?: string;
  /** 地理编码匹配到哪一级（门牌号、道路、兴趣点……） */
  readonly level?: string;
}

/** 路线的一头：坐标，知道的话带城市编码（算公交要用，不知道的由服务自己查） */
export interface RouteEnd extends LatLon {
  readonly cityCode?: string;
}

/** 堵的一段路：路名、多堵、多长 */
export interface TrafficJam {
  readonly road: string;
  readonly status: "slow" | "jam" | "severe";
  readonly meters: number;
}

/** 公交方案里的一段：走路、坐车（公交、地铁）、坐火车、打车 */
export type TransitLeg =
  | { readonly kind: "walk"; readonly meters: number }
  | { readonly kind: "ride"; readonly name: string; readonly from: string; readonly to: string; readonly stops?: number; readonly subway: boolean }
  | { readonly kind: "rail"; readonly name: string; readonly from: string; readonly to: string }
  | { readonly kind: "taxi"; readonly meters: number };

/** 一个公交方案 */
export interface TransitPlan {
  readonly durationS: number;
  readonly distanceM: number;
  /** 一共走多少路（米） */
  readonly walkingM: number;
  /** 票价（元），不知道不写 */
  readonly fare?: number;
  readonly legs: readonly TransitLeg[];
  readonly line: readonly LatLon[];
}

/** 一种走法算出来的 */
export type RouteAnswer =
  | {
      readonly mode: "driving";
      readonly durationS: number;
      readonly distanceM: number;
      readonly tolls?: number;
      readonly lights?: number;
      /** 打车大约多少钱（元） */
      readonly taxiCost?: number;
      /** 服务给了路况才有（空数组是一路畅通） */
      readonly traffic?: readonly TrafficJam[];
      readonly line: readonly LatLon[];
    }
  | { readonly mode: "walking"; readonly durationS: number; readonly distanceM: number; readonly line: readonly LatLon[] }
  | { readonly mode: "transit"; readonly plans: readonly TransitPlan[] };

/**
 * 出错的种类：
 * - no_key 没填查询用的 Key；key Key 不认、被删了（要重新填）；denied 这个 Key 没有这项服务的权限；
 * - quota 用量到上限（今天的、额度用完）；rate 查得太频繁（一会儿就好）；
 * - abroad 点在服务管不到的地方（高德只管中国大陆）；no_route 找不到能走的路；too_far 两头太远；
 * - params 参数不对；network 连不上、等太久；server 服务那边出错；other 别的
 */
export type MapLookupFailure = "no_key" | "key" | "denied" | "quota" | "rate" | "abroad" | "no_route" | "too_far" | "params" | "network" | "server" | "other";

export class MapLookupError extends Error {
  readonly failure: MapLookupFailure;
  /** 服务的原话（高德的 info）或者连不上的原因；不带 Key */
  readonly detail: string;
  /** 服务的错误码（高德的 infocode） */
  readonly code: string | undefined;
  constructor(failure: MapLookupFailure, detail: string, code?: string) {
    super(`${failure}: ${detail}${code === undefined ? "" : ` (${code})`}`);
    this.name = "MapLookupError";
    this.failure = failure;
    this.detail = detail;
    this.code = code;
  }
}

/** 一家地图服务（432 是高德；433 加 OpenStreetMap） */
export interface LookupProvider {
  readonly id: MapLookupSource;
  /** 数据来自谁（给模型看的，只用中文："高德"）；给人看的来源名走 t("map.lookup.source.<id>") */
  readonly name: string;
  /** 这个点它管不管（高德：中国大陆） */
  covers(p: LatLon): boolean;
  /** 按关键字搜（city 是在哪个城市找，不写全国） */
  searchText(q: { keyword: string; city?: string; limit: number }, signal?: AbortSignal): Promise<PlaceHit[]>;
  /** 在一个点附近搜（radius 米），近的在前 */
  searchNear(q: { center: LatLon; keyword?: string; radius: number; limit: number }, signal?: AbortSignal): Promise<PlaceHit[]>;
  /** 地址 → 位置（地理编码） */
  geocode(q: { address: string; city?: string }, signal?: AbortSignal): Promise<PlaceHit[]>;
  /** 位置 → 地址（逆地理编码）；那里什么都没有是 undefined */
  reverse(p: LatLon, signal?: AbortSignal): Promise<PlaceHit | undefined>;
  /** 一种走法的路线 */
  route(q: { from: RouteEnd; to: RouteEnd; mode: MapRouteMode }, signal?: AbortSignal): Promise<RouteAnswer>;
}
