// 聊天里的地图卡片（431）：秘书的"画在地图上"（地图插件的 show_on_map）放进聊天的一张缩略地图（卡片类型 map），点开进地图页看大的。
// 名字、上限、纯函数、"查到的能画的那一份"的形状（不引用 TypeBox），卡片负载的 schema 在 map-card-schema.ts。
// - 卡上存什么（每种只存画得出来要的最少的那些）：
//   · 某一天的足迹（day）：只存日期——轨迹、停留、照片地点每次由网页按日期现取（GET /api/map/day，430），手机那边删了卡上也跟着没了；
//   · 一组点（points）、一条路线（route）：秘书自己给的坐标（WGS-84），存在卡上；
//   · 查地点、算路线的结果（lookup，432）：只存编号、种类、哪家查的——高德的协议不许存它的结果，点和线只在守护进程的内存里留一会儿，
//     网页按编号现取（GET /api/map/drawing?lookup=…）；过期了、二狗重启过，卡上只剩标题和一句"过期了，再问一次"。
// - 点开去哪：足迹卡去 #/more/map/<日期>（430 的地址，地图页看那一天）；别的去 #/more/map/card/<卡片编号>（mapCardPath），
//   地图页从手里的卡片状态取出这张卡画。
// - 不经卡片直接看查到的一处（447，"浏览"里网页上选中地址点"在地图上看"）：#/more/map/lookup/<查到的编号>（mapLookupPath），
//   地图页照编号现取那一份画（和查到的卡片同一套：GET /api/map/drawing，高德查的只画在高德底图上）。
import type { LatLon } from "./geo.ts";
import { t } from "./i18n/runtime.ts";
import type { MapCardPayload, MapCardShow } from "./map-card-schema.ts";

/** 地图页的页面 id（#/more/map）：地图插件登记的页面、聊天里的地图卡片、"浏览"里网页上的地址（447，浏览插件不 import 地图插件）都用它 */
export const MAP_PAGE_ID = "map";

/** 地图页地址里"看一张地图卡片"那一段：#/more/map/card/<卡片编号> */
export const MAP_CARD_ITEM = "card";

/** 地图页地址里"看查到的一处"那一段（447）：#/more/map/lookup/<查到的编号> */
export const MAP_LOOKUP_ITEM = "lookup";

/**
 * 查到的那一份的编号的写法（守护进程地图插件 lookup-results.ts 起的："<地图服务编号>-<种类><序号>"，种类 p 地点、r 路线、a 地址）：
 * 网页只凭编号就知道是哪家查的（只能画在那家底图上）、查的是什么
 */
const LOOKUP_ID = /^([a-z][a-z0-9-]{0,19})-([pra])([0-9]{1,9})$/;
const LOOKUP_KIND: Readonly<Record<string, MapDrawingKind>> = { p: "places", r: "route", a: "address" };

/** 一张卡最多标几个点 */
export const MAP_CARD_MARKS_MAX = 30;
/** 一条路线最多几个点（秘书自己给的；查路线的折线不存在卡上，不受它限） */
export const MAP_CARD_ROUTE_POINTS_MAX = 500;
/** 点旁边写的字、卡片标题最长多少个字 */
export const MAP_CARD_LABEL_MAX = 40;
export const MAP_CARD_TITLE_MAX = 60;

/** 查到的能画的那一份是什么：地点（搜到的几处）、路线、地址（地理编码、逆地理编码的那一处） */
export const MAP_DRAWING_KINDS = ["places", "route", "address"] as const;
export type MapDrawingKind = (typeof MAP_DRAWING_KINDS)[number];

/**
 * 查地点、算路线（432）查到的能画的那一份（GET /api/map/drawing?lookup=amap-r1 的响应）：编号、种类、哪家查的（"amap"）、
 * 标题（查的时候按界面语言起的"从家到公司"）、什么时候查的、点（搜到的 search、常去的地方 place、现在在哪 here）和线（路线，带走法）。
 * 和 432 的 MapLookupDrawing 同形（那一份能原样交过来）；只在守护进程的内存里，不落盘、不进卡片
 */
export interface MapDrawing {
  readonly id: string;
  readonly kind: MapDrawingKind;
  readonly source: string;
  readonly title: string;
  readonly at: string;
  readonly marks: readonly { readonly id: string; readonly lat: number; readonly lon: number; readonly label?: string; readonly kind: "search" | "place" | "here" }[];
  readonly lines: readonly { readonly id: string; readonly points: readonly LatLon[]; readonly kind: "route"; readonly mode?: string }[];
}

/** 地图卡片点开去地图页的哪里（Route 的 item、sub）：足迹卡看那一天，别的看这张卡 */
export function mapCardPath(cardId: string, show: MapCardShow): { item: string; sub?: string } {
  return show.kind === "day" ? { item: show.date } : { item: MAP_CARD_ITEM, sub: cardId };
}

/** 看查到的一处去地图页的哪里（Route 的 item、sub，447） */
export function mapLookupPath(lookup: string): { item: string; sub: string } {
  return { item: MAP_LOOKUP_ITEM, sub: lookup };
}

/**
 * 地图页地址里的 item、sub 是不是"看查到的一处"：是的给出画它要的（和查到的卡片同形的 show：编号、种类、哪家查的）；
 * 编号写法不对的不认
 */
export function parseMapLookupPath(item: string | undefined, sub: string | undefined): Extract<MapCardShow, { kind: "lookup" }> | undefined {
  if (item !== MAP_LOOKUP_ITEM || sub === undefined) return undefined;
  const m = LOOKUP_ID.exec(sub);
  if (!m) return undefined;
  return { kind: "lookup", lookup: sub, what: LOOKUP_KIND[m[2]!]!, source: m[1]! };
}

/** 地图页地址里的 item、sub 是不是"看一张地图卡片"：是的给卡片编号 */
export function parseMapCardPath(item: string | undefined, sub: string | undefined): string | undefined {
  return item === MAP_CARD_ITEM && sub !== undefined && sub !== "" ? sub : undefined;
}

/** 卡片的标题：秘书写了用它，没写的按画的是什么起（"11 月 6 日去过的地方""标了 3 处""查到的路线"），跟着现在的界面语言 */
export function mapCardTitle(payload: MapCardPayload): string {
  if (payload.title !== undefined) return payload.title;
  const show = payload.show;
  switch (show.kind) {
    case "day": {
      const [, month, day] = show.date.split("-").map(Number) as [number, number, number];
      return t("protocol.mapCard.title.day", { month, day });
    }
    case "points":
      return t("protocol.mapCard.title.points", { count: show.marks.length });
    case "route":
      return t("protocol.mapCard.title.route");
    case "lookup":
      return show.what === "places" ? t("protocol.mapCard.title.places") : show.what === "route" ? t("protocol.mapCard.title.lookupRoute") : t("protocol.mapCard.title.address");
  }
}
