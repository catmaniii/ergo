// 谷歌地图插件（446）在守护进程和网页之间共用的名字和形状。不引用 TypeBox。
// - 数据源 google-maps"谷歌地图"：设置 · 数据源里填两个 Key——浏览器用的（Maps JavaScript API，会进页面）、服务端用的（Places API (New)、
//   Routes API、Geocoding API，只在这台电脑上）；密钥区里的文件名也是它；
// - 地图服务的编号 google（445 的插槽：守护进程登记的、网页 mapBasemaps 登记的底图都是它，也是查询结果编号的前缀、卡片上的来源）；
// - 每月的用量按谷歌的计费项（SKU）分开数：地图加载（Dynamic Maps）、搜地点（Text Search Pro）、周边（Nearby Search Pro）、
//   地址 ↔ 位置（Geocoding）、路线（Compute Routes Essentials：步行、公交；Compute Routes Pro：开车带实时路况）；
//   免费量写在守护进程 google-maps/usage.ts（只在那里定一次），这里只有形状；
// - 设置 · 数据源 · 谷歌地图那一块要的（GoogleMapsSourcePanel）：两个 Key 填了没有、这个月的用量、超了免费量还接着用没有（放开了没有）。

/** 谷歌地图那个数据源的 id（设置 · 数据源里填 Key 的那一格，密钥区里的文件名也是它） */
export const GOOGLE_MAPS_SOURCE_ID = "google-maps";

/** 谷歌地图在"地图服务"插槽里的编号（底图、查询、卡片上的来源） */
export const GOOGLE_MAP_PROVIDER = "google";

/**
 * 数的几种计费项：地图加载、搜地点（Text Search Pro）、周边（Nearby Search Pro）、地址 ↔ 位置（Geocoding）、
 * 步行和公交的路线（Compute Routes Essentials）、开车带实时路况的路线（Compute Routes Pro）
 */
export const GOOGLE_MAPS_SKUS = ["dynamicMaps", "textSearch", "nearbySearch", "geocoding", "routesEssentials", "routesPro"] as const;
export type GoogleMapsSku = (typeof GOOGLE_MAPS_SKUS)[number];

/** 这个月用了多少：月份（YYYY-MM，本地）、每个计费项用了几次、每月的免费量 */
export interface GoogleMapsUsageView {
  readonly month: string;
  readonly counts: Readonly<Record<GoogleMapsSku, number>>;
  readonly limits: Readonly<Record<GoogleMapsSku, number>>;
}

/** 设置 · 数据源 · 谷歌地图的连接状态里带给插件那一块的（DataSourceView.panel） */
export interface GoogleMapsSourcePanel {
  readonly kind: "google-maps";
  /** 存着浏览器用的 Key（地图页能用谷歌底图） */
  readonly browserKey: boolean;
  /** 存着服务端用的 Key（能查地点、算路线） */
  readonly serverKey: boolean;
  readonly usage: GoogleMapsUsageView;
  /** 超了免费量还接着用（用户在设置里放开了：超出的部分谷歌按量收费） */
  readonly allowOverage: boolean;
  /** 这个月已经超了免费量的计费项（没放开时这家先停用、退回 OpenStreetMap） */
  readonly over: readonly GoogleMapsSku[];
}

/** 是不是谷歌地图那一块的数据（网页按它认，不认得的不画） */
export function isGoogleMapsSourcePanel(value: unknown): value is GoogleMapsSourcePanel {
  const v = value as Partial<GoogleMapsSourcePanel> | null;
  return typeof v === "object" && v !== null && v.kind === "google-maps" && typeof v.browserKey === "boolean" && typeof v.serverKey === "boolean" && typeof v.usage === "object" && v.usage !== null && Array.isArray(v.over);
}
