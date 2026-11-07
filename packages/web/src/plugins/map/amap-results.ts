// 高德查来的结果（432 的地点、路线）只能画在高德自己的地图上（高德开放平台服务协议 4.12.4 不许脱离它的服务单独展示、7.7 要标明
// "高德地图"）。聊天里地图卡片这边"高德那条路"都从这里认：
// - 卡片上不画缩略图（聊天页不加载高德的脚本），只写查到的和"在高德地图上看"（MapCard.tsx）；
// - 点开的地图页只在底图是高德时画它，画不上时说为什么（MapView.tsx 的 amapScene、MapPage.tsx 交过去）。
// 别的来源（以后 OpenStreetMap 查来的、用户自己的足迹、秘书给的点和路线）照常画在 OpenStreetMap 上。拆掉高德时删这个文件和用到它的几处。
import type { MapCardShow } from "../../state/index.ts";

/** 高德查来的那一份的来源名（432 的 MapLookupSource） */
export const AMAP_RESULT_SOURCE = "amap";

/** 这个来源查来的只能画在它自己家的地图上（高德） */
export function ownMapOnly(source: string): boolean {
  return source === AMAP_RESULT_SOURCE;
}

/** 卡上画的是不是只能画在高德地图上的（看负载就知道，不用等取到） */
export function amapOnlyShow(show: MapCardShow): boolean {
  return show.kind === "lookup" && ownMapOnly(show.source);
}
