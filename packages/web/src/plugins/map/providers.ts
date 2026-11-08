// 地图页用哪一家底图、地图切换里列哪几家（445，"地图服务"插槽的网页一半）：纯函数，不碰 DOM，测试在 Node 里跑。
// - 几家从哪来：守护进程报的（GET /api/map/config 的 providers：管哪儿、手动能用的区域、优先级、底图能不能用、浏览器用的 Key），
//   加上网页这边登记了没有（mapBasemaps 插槽：插件停用了就没有）、这一页加载它失败了没有（设备连不上那家）；
//   旧的守护进程没有 providers 时按 amapKey 当只有高德、OpenStreetMap 两家（providersOf）；
// - "自动"（autoBasemap）：管这个区域、能用的里优先级最大的那家；一家都没有就是 OpenStreetMap。只有高德、OpenStreetMap 时就是
//   429 的挑法：大陆里高德能用（填了 Key、没说 Key 不对、没加载失败）用高德，别的 OpenStreetMap；
// - 手动（这台设备按区域记的，MapChoice）：选了、而且这一页上能选它（selectable）就用它，不然照"自动"——记着的那一家不能用了，
//   地图页把这个区域退回"自动"并说一句（choiceBroken）；
// - 画着用户自己的足迹时一律 OpenStreetMap，不管选了谁（AMAP_WITH_FOOTPRINTS，用户 2026-11-07 定；不为它加载商业地图的脚本）；
// - 某一家查来的地点、路线只画在它自己的底图上（ownBasemapOf）：OpenStreetMap 的哪儿都能画，别家的（高德、谷歌……）一律只画在它自己的上；
// - 交给秘书的地图编号（查询跟着它走，lookupBasemap）：平常是真画着的那一家；看足迹时底图固定 OpenStreetMap，查询不跟它——
//   写这个区域手动选的那一家，没选过按"自动"（国内即高德），用户 2026-11-08 定。
import { type MapChoice, type MapConfigView, type MapProviderView, MAP_PROVIDER_ID, MAP_REGIONS, type MapRegion } from "../../state/index.ts";

/** 自带两家的编号（和守护进程登记的一样） */
const OSM = "osm";
const AMAP = "amap";

/**
 * 画着用户自己的足迹（轨迹、停留、照片地点）时，国内也用高德吗：**不用**（用户 2026-11-07 定）。高德的地图是页面里加载的高德脚本画的，
 * 足迹的点要是和它在同一个页面里，它理论上看得到；为了守住"每天的轨迹、照片地点不外发"，看足迹时一律 OpenStreetMap
 * （瓦片经这台电脑转发，点自己画），也不为它加载高德的脚本。445 起别家的商业地图（谷歌）同样。地图页、聊天里地图卡片的缩略图
 * 都经这里挑，要改只改这一个值
 */
export const AMAP_WITH_FOOTPRINTS: boolean = false;

/** 一家此刻在这一页上：网页那一半登记了没有、加载它失败了没有（原因） */
export interface BasemapPage {
  has(id: string): boolean;
  failed(id: string): string | undefined;
}

/** 都登记了、都没失败（聊天页、测试） */
export const EVERY_BASEMAP: BasemapPage = { has: () => true, failed: () => undefined };

/** 守护进程报的几家；旧的守护进程只给 amapKey 时当只有高德、OpenStreetMap 两家（445 以前的样子） */
export function providersOf(config: MapConfigView | undefined): readonly MapProviderView[] {
  if (config === undefined) return [];
  if (config.providers !== undefined) return config.providers;
  return [
    {
      id: AMAP,
      title: AMAP,
      regions: ["mainland"],
      manualRegions: ["mainland"],
      priority: 100,
      ownBasemapOnly: true,
      basemap: true,
      ready: config.amapKey !== undefined,
      ...(config.amapKey === undefined ? {} : { key: config.amapKey }),
      ...(config.amapProblem === undefined ? {} : { problem: config.amapProblem }),
      lookup: false,
    },
    { id: OSM, title: OSM, regions: ["mainland", "abroad"], manualRegions: ["mainland", "abroad"], priority: 0, ownBasemapOnly: false, basemap: true, ready: true, lookup: false },
  ];
}

/** 优先级大的在前，一样大的照原来的先后 */
const byPriority = (list: readonly MapProviderView[]) => list.toSorted((a, b) => b.priority - a.priority);

/** 这一家的底图这一页上用得了吗：有底图、填了 Key 没坏、网页那一半在、这一页没加载失败 */
const usable = (p: MapProviderView, page: BasemapPage) => p.basemap && p.ready && page.has(p.id) && page.failed(p.id) === undefined;

/** "自动"时这个区域用哪家：管这个区域、用得了的里优先级最大的；都没有是 OpenStreetMap */
export function autoBasemap(region: MapRegion, providers: readonly MapProviderView[], page: BasemapPage): string {
  return byPriority(providers.filter((p) => p.regions.includes(region) && usable(p, page)))[0]?.id ?? OSM;
}

/** 手动能在这个区域选它吗：手动能用在这个区域（manualRegions），而且用得了 */
export function selectable(p: MapProviderView | undefined, region: MapRegion, page: BasemapPage): p is MapProviderView {
  return p !== undefined && p.manualRegions.includes(region) && usable(p, page);
}

/** 地图切换里这个区域的一家：编号；这一页加载它失败了的带原因（标"连不上"，点不了） */
export interface SwitchEntry {
  readonly id: string;
  readonly failed?: string;
}

/**
 * 地图切换里这个区域列哪几家（"自动"另算）：手动能用在这个区域、有底图、填了 Key 没坏、网页那一半在的，按优先级；
 * 这一页加载失败的也列，带原因（设备连不上那家，比如在大陆连谷歌）
 */
export function switchEntries(region: MapRegion, providers: readonly MapProviderView[], page: BasemapPage): SwitchEntry[] {
  return byPriority(providers.filter((p) => p.basemap && p.ready && p.manualRegions.includes(region) && page.has(p.id))).map((p) => {
    const failed = page.failed(p.id);
    return failed === undefined ? { id: p.id } : { id: p.id, failed };
  });
}

/** 这一屏用哪家：wanted 想用的（还在加载的那一会儿地图页先画 OpenStreetMap）、auto 是"自动"会挑的、manual 是不是照手动选的 */
export interface BasemapPick {
  readonly wanted: string;
  readonly auto: string;
  readonly manual: boolean;
}

export function pickBasemap(q: { region: MapRegion; choice?: string | undefined; providers: readonly MapProviderView[]; page: BasemapPage; footprints?: boolean | undefined }): BasemapPick {
  const auto = autoBasemap(q.region, q.providers, q.page);
  if (q.footprints === true && !AMAP_WITH_FOOTPRINTS) return { wanted: OSM, auto, manual: false };
  if (q.choice !== undefined && selectable(q.providers.find((p) => p.id === q.choice), q.region, q.page)) return { wanted: q.choice, auto, manual: true };
  return { wanted: auto, auto, manual: false };
}

/** 这个区域记着的手动选择不能用了吗（地图页要退回"自动"并说一句）：选了、而且这一页上选不了它 */
export function choiceBroken(region: MapRegion, choice: string | undefined, providers: readonly MapProviderView[], page: BasemapPage): boolean {
  return choice !== undefined && !selectable(
    providers.find((p) => p.id === choice),
    region,
    page,
  );
}

/** 这台设备按区域记的手动切换存在哪（浏览器里） */
export const MAP_CHOICE_KEY = "ergo-map-choice";

/** 存着的手动切换：坏的、不认得的写法当"自动" */
export function parseMapChoice(text: string | null): MapChoice {
  if (text === null) return {};
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null) return {};
    const out: Partial<Record<MapRegion, string>> = {};
    for (const region of MAP_REGIONS) {
      const id = (v as Record<string, unknown>)[region];
      if (typeof id === "string" && MAP_PROVIDER_ID.test(id)) out[region] = id;
    }
    return out;
  } catch {
    return {};
  }
}

/** 换掉一个区域的手动选择（undefined 是"自动"） */
export function withChoice(choice: MapChoice, region: MapRegion, id: string | undefined): MapChoice {
  const next: Partial<Record<MapRegion, string>> = { ...choice };
  if (id === undefined) delete next[region];
  else next[region] = id;
  return next;
}

/** 这一家查来的只能画在哪家的底图上：OpenStreetMap 的哪儿都能画（undefined）；别家的只画在它自己的上（不知道条款的一律这样） */
export function ownBasemapOf(source: string): string | undefined {
  return source === OSM ? undefined : source;
}

/** 地图那块报上来的、挑交给秘书的地图编号要的那几样（MapView.tsx 的 BasemapStatus） */
export interface LookupBasemapStatus {
  readonly region: MapRegion;
  readonly rendered: string;
  readonly auto: string;
  readonly options: readonly { readonly id: string; readonly failed?: string }[];
}

/**
 * 地图上下文里交给秘书的地图编号（秘书照它把查询工具的 map 写成这一家，查询跟着地图走，444 × 445 的接线）：
 * - 平常是真画着的那一家（rendered）；
 * - 画着足迹时底图一律 OpenStreetMap（AMAP_WITH_FOOTPRINTS），查询不跟着写 osm（用户 2026-11-08 定：国内开着足迹也照样用高德查）——
 *   写这个区域手动选的那一家（还在能选的里、这一页没加载失败），没选过（或选的那家现在选不了）写"自动"会挑的那家（国内即高德）。
 *   足迹的点不会因此给那家：交出去的只是这个编号，秘书查的还是用户问的那一处
 */
export function lookupBasemap(status: LookupBasemapStatus, choice: MapChoice, footprints: boolean): string {
  if (!footprints) return status.rendered;
  const chosen = choice[status.region];
  if (chosen !== undefined && status.options.some((o) => o.id === chosen && o.failed === undefined)) return chosen;
  return status.auto;
}
