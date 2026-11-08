// 某一家查来的结果（432 高德、445 起别的插件登记的谷歌……）只能画在它自己的地图上（高德开放平台服务协议 4.12.4 不许脱离它的服务
// 单独展示、7.7 要标明"高德地图"；谷歌的条款同样）。OpenStreetMap 查来的哪儿都能画。聊天里地图卡片这边"只画在它自己的底图上"
// 都从这里认：
// - 卡片上不画缩略图（聊天页不加载商业地图的脚本），只写查到的和"在高德地图上看"（MapCard.tsx）；
// - 点开的地图页只在底图是那一家时画它，画不上时说为什么（MapView.tsx 的 ownScene、MapPage.tsx 交过去）。
// 别的来源（OpenStreetMap 查来的、用户自己的足迹、秘书给的点和路线）照常画在 OpenStreetMap 上。
import type { MapCardShow } from "../../state/index.ts";
import { ownBasemapOf } from "./providers.ts";

/** 高德查来的那一份的来源名（432 的 MapLookupSource） */
export const AMAP_RESULT_SOURCE = "amap";

/** 这个来源查来的只能画在它自己家的地图上（OpenStreetMap 以外的都是：高德、谷歌……） */
export function ownMapOnly(source: string): boolean {
  return ownBasemapOf(source) !== undefined;
}

/** 卡上画的只能画在哪一家的底图上（看负载就知道，不用等取到）；哪儿都能画的是 undefined */
export function ownBasemapShow(show: MapCardShow): string | undefined {
  return show.kind === "lookup" ? ownBasemapOf(show.source) : undefined;
}

/** 卡上画的是不是只能画在它自己家的地图上的（445 前只有高德，名字留着） */
export function amapOnlyShow(show: MapCardShow): boolean {
  return ownBasemapShow(show) !== undefined;
}
