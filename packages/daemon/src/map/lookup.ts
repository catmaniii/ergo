// 查地点、算路线的统一外形（432）：给秘书的工具（lookup-tools.ts）只认这一套，不管背后是哪家地图服务。
// 两家：OpenStreetMap（osm-lookup.ts：Nominatim 查地点、OSRM 算路线，哪儿都管，433）一直在；高德（amap-lookup.ts，只管中国大陆，432）
// 只在填了 Web 服务 Key、按需查开着、Key 没坏时排在前面（service.ts 定给不给）。工具按点挑第一家管它的（covers），所以有高德时
// 国内走高德、国外走 OpenStreetMap，没有高德时国内国外都走 OpenStreetMap。
// 坐标进出一律 WGS-84（二狗里存的、手机交来的就是它），各家自己转（高德是 GCJ-02）。
// 各家能做的不一样，写在这里让工具照着说：哪几种走法（OpenStreetMap 没有公交）、有没有实时路况、结果末尾怎么署名、某处的数据全不全、
// 出错时怎么说（去哪重新填 Key、免费服务暂时不可用）。
// 查到的只现用：不落盘、不进记忆素材（高德的协议不许存、不许缓存；OpenStreetMap 的照同样办，只在内存里按它的规矩缓存一阵）。
// 出错一律抛 MapLookupError：哪一种（要重新填 Key、用量到上限、查得太频繁、点在国外、找不到路……）加上服务原话，
// 给模型的话（lookup-tools.ts）和给人看的话（试查一下）各自按种类写。
import type { LatLon, MapLookupSource, MapRouteMode } from "@ergo/protocol";

/** 一条折线最多留多少个点（再多的均匀抽掉：画在小卡片、地图页上足够了） */
export const MAX_LINE_POINTS = 2_000;

/** 点太多时均匀抽掉一些（头尾留着） */
export function thinLine(points: readonly LatLon[], max = MAX_LINE_POINTS): LatLon[] {
  if (points.length <= max) return [...points];
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]!);
}

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
 * - no_key 没填查询用的 Key；key Key 不认、被删了（要重新填）；denied 这个 Key 没有这项服务的权限（OpenStreetMap：服务拒绝了，可能被封）；
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

/** 一家地图服务（高德、OpenStreetMap） */
export interface LookupProvider {
  readonly id: MapLookupSource;
  /** 数据来自谁（给模型看的，只用中文："高德"）；给人看的来源名走 t("map.lookup.source.<id>") */
  readonly name: string;
  /** 结果末尾的那句（给模型看的）：数据来自谁、署名、存没存（"数据来自高德，现查的，没存"） */
  readonly credit: string;
  /** 能算哪几种走法（OpenStreetMap 没有公交） */
  readonly routeModes: readonly MapRouteMode[];
  /** 没说要哪几种走法时算哪几种 */
  readonly defaultModes: readonly MapRouteMode[];
  /** 开车的用时带不带实时路况（高德带，OpenStreetMap 不带） */
  readonly liveTraffic: boolean;
  /** 不说找什么也能列出某处附近有什么（高德能；Nominatim 不能，要说找什么） */
  readonly browsesNearby: boolean;
  /** 这个点它管不管（高德：中国大陆；OpenStreetMap：哪儿都管） */
  covers(p: LatLon): boolean;
  /** 这一处的数据全不全要提一句的（OpenStreetMap 在中国大陆："国内的地点用 OpenStreetMap 查，店名和小路可能不全"），给模型看的 */
  coverageNote?(p: LatLon): string | undefined;
  /** 出错时给模型的话（这一家自己的说法：去哪重新填 Key、免费服务暂时不可用）；交回 undefined 的用工具那边通用的说法 */
  explain?(err: MapLookupError): string | undefined;
  /**
   * 按关键字搜（city 是在哪个城市找，不写全国）。near 是这一问里已经知道的另一处（路线的另一头）：只用来让结果靠近它
   * （OpenStreetMap 的 viewbox；高德不用），它本来就要发出去
   */
  searchText(q: { keyword: string; city?: string; limit: number; near?: LatLon }, signal?: AbortSignal): Promise<PlaceHit[]>;
  /** 在一个点附近搜（radius 米），近的在前 */
  searchNear(q: { center: LatLon; keyword?: string; radius: number; limit: number }, signal?: AbortSignal): Promise<PlaceHit[]>;
  /** 地址 → 位置（地理编码）；near 同 searchText */
  geocode(q: { address: string; city?: string; near?: LatLon }, signal?: AbortSignal): Promise<PlaceHit[]>;
  /** 位置 → 地址（逆地理编码）；那里什么都没有是 undefined */
  reverse(p: LatLon, signal?: AbortSignal): Promise<PlaceHit | undefined>;
  /** 一种走法的路线 */
  route(q: { from: RouteEnd; to: RouteEnd; mode: MapRouteMode }, signal?: AbortSignal): Promise<RouteAnswer>;
}
