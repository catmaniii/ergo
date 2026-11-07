// 查地点、算路线（432：国内用高德 Web 服务；433 再接国外的 OpenStreetMap）在守护进程和网页之间共用的形状。不引用 TypeBox。
// - 查到的能画在地图上的那一份（MapLookupDrawing）：坐标一律 WGS-84，点、线的样子照网页地图页的 MapScene（plugins/map/scene.ts）
//   ——点的 kind 是 search（搜到的）/ place（常去的地方）/ here（现在在哪），线的 kind 是 route；431 的"画在地图上"工具、
//   聊天里的地图卡片拿它画。守护进程只在内存里留一会儿（不落盘、不进记忆素材：高德的协议不许存、不许缓存）；
// - 设置 · 数据源 · 高德地图那一块要的（AmapSourcePanel）：Web 服务 Key 填了没有（"试查一下"能不能点）、这个月查了几次。
import type { LatLon } from "./geo.ts";

/** 查地点、算路线的数据从哪来：432 只有高德（433 加 OpenStreetMap） */
export const MAP_LOOKUP_SOURCES = ["amap"] as const;
export type MapLookupSource = (typeof MAP_LOOKUP_SOURCES)[number];

/** 算路线的几种走法：开车、公交（含地铁）、步行 */
export const MAP_ROUTE_MODES = ["driving", "transit", "walking"] as const;
export type MapRouteMode = (typeof MAP_ROUTE_MODES)[number];

/** 画在地图上的一个点（WGS-84） */
export interface MapLookupMark {
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
  readonly label?: string;
  readonly kind: "search" | "place" | "here";
}

/** 画在地图上的一条路线（WGS-84）：哪种走法 */
export interface MapLookupLine {
  readonly id: string;
  readonly points: readonly LatLon[];
  readonly kind: "route";
  readonly mode: MapRouteMode;
}

/**
 * 一次查询能画出来的东西：编号（工具结果里写给模型的那个，"amap-r1"）、查的是什么（地点 / 路线 / 地址）、数据从哪来、
 * 一句标题（"从家到公司"）、什么时候查的，点和线
 */
export interface MapLookupDrawing {
  readonly id: string;
  readonly kind: "places" | "route" | "address";
  readonly source: MapLookupSource;
  readonly title: string;
  readonly at: string;
  readonly marks: readonly MapLookupMark[];
  readonly lines: readonly MapLookupLine[];
}

/** 这个月查了几次：月份（YYYY-MM，本地）、两类各几次和高德个人认证档每月的免费量 */
export interface AmapUsageView {
  readonly month: string;
  /** 搜地点（关键字、周边） */
  readonly search: number;
  /** 地址和路线（地理编码、逆地理编码、路线规划） */
  readonly lbs: number;
  readonly searchLimit: number;
  readonly lbsLimit: number;
}

/** 设置 · 数据源 · 高德地图的连接状态里带给插件那一块的（DataSourceView.panel） */
export interface AmapSourcePanel {
  readonly kind: "amap";
  /** 存着 Web 服务 Key（能查地点、算路线，"试查一下"能点） */
  readonly lookup: boolean;
  readonly usage: AmapUsageView;
}

/** 是不是高德那一块的数据（网页按它认，不认得的不画） */
export function isAmapSourcePanel(value: unknown): value is AmapSourcePanel {
  const v = value as Partial<AmapSourcePanel> | null;
  return typeof v === "object" && v !== null && v.kind === "amap" && typeof v.lookup === "boolean" && typeof v.usage === "object" && v.usage !== null;
}
