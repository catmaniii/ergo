// 某一家查来的结果只能画在它自己的地图上（432 高德开放平台服务协议 4.12.4 不许脱离它的服务单独展示、7.7 要标明来源；谷歌的条款同样）。
// 455 起地图插件不认得任何一家（原来叫 amap-results.ts）：哪家查来的能画在别家地图上，看那家自己报的 ownBasemapOnly
// （守护进程 GET /api/map/config 的 providers：OpenStreetMap 报 false，哪儿都能画）；不认得的一律只画在它自己的上。
// 聊天里地图卡片这边"只画在它自己的底图上"都从这里认：
// - 卡片放那一家的静态预览图（取不到只写字和"在<那一家>上看"，MapCard.tsx）；
// - 点开的地图页这一屏临时用那一家画它，画不上时说为什么（MapView.tsx 的 ownScene、MapPage.tsx 交过去）。
// 别的来源（哪儿都能画的那家查来的、用户自己的足迹、秘书给的点和路线）画在当前地图上。
import type { MapCardShow, MapProviderView } from "../../state/index.ts";
import { ownBasemapOf } from "./providers.ts";

/** 这个来源查来的只能画在它自己家的地图上（providers 是守护进程报的几家；还没取到时一律当是） */
export function ownMapOnly(source: string, providers: readonly MapProviderView[] | undefined): boolean {
  return ownBasemapOf(source, providers) !== undefined;
}

/** 卡上画的只能画在哪一家的底图上（看负载和那几家报的就知道，不用等取到）；哪儿都能画的是 undefined */
export function ownBasemapShow(show: MapCardShow, providers: readonly MapProviderView[] | undefined): string | undefined {
  return show.kind === "lookup" ? ownBasemapOf(show.source, providers) : undefined;
}
