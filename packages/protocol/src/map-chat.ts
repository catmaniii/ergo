// 地图页的二狗（444）发的消息带的地图上下文：记成什么（mapMarkOf）、会话里这条下面的小字怎么写（mapLabel）。
// 形状在 map-chat-schema.ts。纯函数，守护进程（记进消息）和网页（乐观显示的那条、会话里的小字）共用。
import { t } from "./i18n/runtime.ts";
import type { MapContext, MapMark } from "./map-chat-schema.ts";

/** 小数留几位 */
const round = (n: number, digits: number) => Number(n.toFixed(digits));

/** 发来的地图上下文记成什么：坐标留 6 位小数（约 0.1 米）、级别留 2 位，只取认得的字段（前端多带的不进事件日志） */
export function mapMarkOf(context: MapContext): MapMark {
  return {
    lat: round(context.lat, 6),
    lon: round(context.lon, 6),
    zoom: round(context.zoom, 2),
    basemap: context.basemap,
    ...(context.footprints ? { footprints: { date: context.footprints.date, ...(context.footprints.spot ? { spot: context.footprints.spot } : {}) } } : {}),
    ...(context.card ? { card: { id: context.card.id, ...(context.card.title ? { title: context.card.title } : {}) } } : {}),
    ...(context.via === "button" ? { via: "button" as const, ...(context.spoken ? { spoken: true as const } : {}) } : {}),
  };
}

/** 会话里地图页发的那条消息下面的小字："在地图上说"；悬浮按钮上的："在地图上用悬浮按钮打字 / 说" */
export function mapLabel(mark: Pick<MapMark, "via" | "spoken">): string {
  if (mark.via !== "button") return t("protocol.map.label.chat");
  return t(mark.spoken ? "protocol.map.label.buttonSpoke" : "protocol.map.label.buttonTyped");
}
