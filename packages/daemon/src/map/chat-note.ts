// 地图页的二狗（444）：地图页右边的聊天窗、右下角的二狗悬浮按钮里发的消息（MessageEnvelope.map）交给秘书时后面跟的那段——
// 用户是在地图页上说的、地图现在看的是哪里（中心、缩放、底图）、看的是哪一天的足迹（选中了哪一处）、哪张地图卡片，
// 这一轮怎么在地图上给他看（show_on_map）。地图插件经 agent 贡献的"输入附注"给（插件停用时没有这段）。
// 给模型看的话，照旧只用中文（多语言第 6 条）。
import type { MapMark } from "@ergo/protocol";
import { SHOW_ON_MAP_TOOL } from "./show-on-map.ts";

/** 底图的说法：认得的写名字，别的（以后接进来的地图服务）原样 */
function basemapText(basemap: string): string {
  if (basemap === "amap") return "高德地图"; // @i18n-ignore model
  if (basemap === "osm") return "OpenStreetMap";
  if (basemap === "loading") return "还没画上"; // @i18n-ignore model
  return basemap;
}

/** 坐标写成几位小数（5 位约 1 米） */
const coord = (n: number) => n.toFixed(5);

// @i18n-ignore-start model：交给秘书的输入附注（给模型看）
/** 地图页上发的那条消息后面那段 */
export function mapChatNote(mark: MapMark): string {
  const how = mark.via === "button" ? (mark.spoken ? "右下角的二狗悬浮按钮上按住说的（语音认出来的字）" : "右下角的二狗悬浮按钮上点它打的字") : "右边的二狗聊天窗里说的";
  const view = `地图现在看的中心在纬度 ${coord(mark.lat)}、经度 ${coord(mark.lon)}（WGS-84），缩放 ${Math.round(mark.zoom * 10) / 10} 级（3 级看全国、11 级看一个城市、17 级看街道），底图是${basemapText(mark.basemap)}`;
  const looking = mark.card
    ? `看的是聊天里的一张地图卡片${mark.card.title ? `「${mark.card.title}」` : ""}（卡片 ${mark.card.id}）`
    : mark.footprints
      ? `"足迹"开着，看的是 ${mark.footprints.date} 那一天的足迹${mark.footprints.spot ? `，选中了「${mark.footprints.spot}」` : ""}`
      : `"足迹"关着`;
  const lines = [
    `（这句是用户在二狗的地图页上，${how}：${view}；${looking}。`,
    `用户说"这里""这一片""附近"多半指地图现在看的这一带，不一定是他本人现在的位置（他的位置不在这段里）。`,
    `要在地图上给他看地点、路线、某一天的足迹，用 ${SHOW_ON_MAP_TOOL} 画成聊天里的地图卡片（他点开就在地图页上看）。`,
    ...(mark.via === "button" ? ["从悬浮按钮来的：用户在地图上按钮旁边的小气泡里看你的回话，回话要短，一两句话（30 字上下），不列清单。"] : []),
  ];
  return `${lines.join("\n")}）`;
}
// @i18n-ignore-end
