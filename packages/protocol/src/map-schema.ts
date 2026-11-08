// 地图页要的设置（GET /api/map/config 的响应，429 地图插件）。名字、地址在 map.ts，坐标转换在 geo.ts。
import { type Static, Type } from "typebox";

/** 一个区域（map-lookup.ts 的 MAP_REGIONS） */
const MapRegionSchema = Type.Union([Type.Literal("mainland"), Type.Literal("abroad")]);

/**
 * 登记了的一家地图服务（445，地图插件开的"地图服务"插槽；自带高德、OpenStreetMap，别的插件能再登记）：
 * - id、title：编号（和网页那一半登记的底图对上）、名字；
 * - regions：选"自动"时它管哪几个区域；manualRegions：用户手动选它时能用在哪几个区域（谷歌在大陆也能手动选）；
 * - priority："自动"时同一个区域里数大的先用（高德 100、OpenStreetMap 0）；
 * - ownBasemapOnly：它查来的地点、路线只能画在它自己的底图上（高德、谷歌的条款）；
 * - basemap：它有没有底图；ready：底图现在能不能用（填了 Key、Key 没坏）；key：页面加载它的脚本要的浏览器用的 Key
 *   （高德是 Web 端 Key，本来就在页面上；别的密钥不在这里）；problem：上次说 Key 不对（给人看的一句）；
 * - lookup：现在能不能查地点、算路线
 */
export const MapProviderView = Type.Object({
  id: Type.String(),
  title: Type.String(),
  regions: Type.Array(MapRegionSchema),
  manualRegions: Type.Array(MapRegionSchema),
  priority: Type.Number(),
  ownBasemapOnly: Type.Boolean(),
  basemap: Type.Boolean(),
  ready: Type.Boolean(),
  key: Type.Optional(Type.String()),
  problem: Type.Optional(Type.String()),
  lookup: Type.Boolean(),
});
export type MapProviderView = Static<typeof MapProviderView>;

/**
 * 地图页现在能用什么：
 * - amapKey：高德 Web 端（JS API）的 Key，填了 Key 和安全密钥才有。页面拿它加载高德的脚本（高德的设计里这个 Key 本来就在页面上，
 *   能绑域名白名单）；安全密钥**不在这里**，守护进程转发高德的请求时自己拼上。没有就是国内也先用 OpenStreetMap；
 * - amapProblem：高德那边上次说 Key、安全密钥不对（给人看的一句）：页面照样先用 OpenStreetMap，写这一句
 * - providers：登记了的几家地图服务（445：地图服务插槽），页面按它挑底图、列地图切换
 */
export const MapConfigView = Type.Object({
  amapKey: Type.Optional(Type.String()),
  amapProblem: Type.Optional(Type.String()),
  /** 登记了的几家地图服务（445），按登记的先后；旧的守护进程没有这一项，页面按 amapKey 当只有高德、OpenStreetMap 两家 */
  providers: Type.Optional(Type.Array(MapProviderView)),
});
export type MapConfigView = Static<typeof MapConfigView>;

/**
 * 地图页报一家底图的事（446，POST /api/map/basemap）：provider 是地图服务的编号；event：
 * - loaded：建了一次这家的底图（谷歌按"一次地图加载"计费：守护进程数这个月的用量，到了免费量先停用这家的底图）；
 * - auth_failed：这家拒了浏览器用的 Key（谷歌的 gm_authFailure：Key 不对、没开 Maps JavaScript API、网站限制没写这个地址、没开结算）。
 * 只有编号和事，不带位置、不带 Key
 */
export const MapBasemapEventBody = Type.Object({
  provider: Type.String({ minLength: 1, maxLength: 20 }),
  event: Type.Union([Type.Literal("loaded"), Type.Literal("auth_failed")]),
});
export type MapBasemapEventBody = Static<typeof MapBasemapEventBody>;

/** 报了以后：这家认不认得（没登记、停用了的是 false，不算错） */
export const MapBasemapEventReply = Type.Object({ known: Type.Boolean() });
export type MapBasemapEventReply = Static<typeof MapBasemapEventReply>;
