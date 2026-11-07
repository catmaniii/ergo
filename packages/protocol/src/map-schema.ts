// 地图页要的设置（GET /api/map/config 的响应，429 地图插件）。名字、地址在 map.ts，坐标转换在 geo.ts。
import { type Static, Type } from "typebox";

/**
 * 地图页现在能用什么：
 * - amapKey：高德 Web 端（JS API）的 Key，填了 Key 和安全密钥才有。页面拿它加载高德的脚本（高德的设计里这个 Key 本来就在页面上，
 *   能绑域名白名单）；安全密钥**不在这里**，守护进程转发高德的请求时自己拼上。没有就是国内也先用 OpenStreetMap；
 * - amapProblem：高德那边上次说 Key、安全密钥不对（给人看的一句）：页面照样先用 OpenStreetMap，写这一句
 */
export const MapConfigView = Type.Object({
  amapKey: Type.Optional(Type.String()),
  amapProblem: Type.Optional(Type.String()),
});
export type MapConfigView = Static<typeof MapConfigView>;
