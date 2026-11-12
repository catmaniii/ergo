// 地图页用哪一家底图、地图切换里列哪几家（445，"地图服务"插槽的网页一半）：纯函数，不碰 DOM，测试在 Node 里跑。
// 455 起地图插件不认得任何一家（OpenStreetMap、高德、谷歌各是一个插件），这里只看登记的几家报的东西：
// - 几家从哪来：守护进程报的（GET /api/map/config 的 providers：管哪儿、手动能用的区域、优先级、底图能不能用、浏览器用的 Key、
//   查来的能不能画在别家地图上 ownBasemapOnly），加上网页这边登记了没有（mapBasemaps 插槽：插件停用了就没有）、这一页加载它失败了没有
//   （设备连不上那家）；
// - "自动"（autoBasemap）：管这个区域、能用的里优先级最大的那家（451 起按区域另给的优先级 regionPriority：国内高德 → OSM；
//   国外谷歌 → 高德 → OSM）；一家都没有是 undefined（地图页说"没有能用的地图"，卡片只有字）。
// - 手动（这台设备按区域记的，MapChoice）：选了、而且这一页上能选它（selectable）就用它，不然照"自动"——记着的那一家不能用了，
//   地图页把这个区域退回"自动"并说一句（choiceBroken）；
// - "当前地图"（451，用户 2026-11-09）：这台设备在这个区域手动选的，没选就是"自动"挑的；地图页、开着足迹的地图页、某一天的足迹、
//   聊天卡片的预览图都用它（FOOTPRINTS_ON_CURRENT_MAP：11-07 定的"看足迹一律 OSM"反过来了）。卡片挑哪家看 cardBasemap；
// - 某一家查来的地点、路线只画在它自己的底图上（ownBasemapOf）：那家报了 ownBasemapOnly 是 false 的（OpenStreetMap）哪儿都能画，
//   别家的（高德、谷歌……）、不认得的（插件停了、还没取到）一律只画在它自己的上；
//   地图页点开它们时这一屏临时用那家（pickBasemap 的 temporary，不改记着的选择）；
// - 交给秘书的地图编号（查询跟着它走，lookupBasemap）：就是真画着的那一家（451 起底图就是当前地图，看足迹也不例外）。
import { type LatLon, type MapChoice, type MapConfigView, type MapProviderView, MAP_PROVIDER_ID, MAP_REGIONS, type MapRegion, mapRegionOf } from "../../state/index.ts";

/**
 * 画着用户自己的足迹（轨迹、停留、照片地点）时也用当前地图吗：**用**（用户 2026-11-09 定，改了 11-07 的"一律 OpenStreetMap"）。
 * 453 起足迹只在本机画，地图公司看不到。地图页、聊天卡片都经这里挑，要改回去只改这一个值（false：看足迹时只用查来的哪儿都能画的
 * 那几家——OpenStreetMap 这种，不为它加载商业地图的脚本）
 */
export const FOOTPRINTS_ON_CURRENT_MAP: boolean = true;

/** 一家此刻在这一页上：网页那一半登记了没有、加载它失败了没有（原因） */
export interface BasemapPage {
  has(id: string): boolean;
  failed(id: string): string | undefined;
}

/** 都登记了、都没失败（聊天页、测试） */
export const EVERY_BASEMAP: BasemapPage = { has: () => true, failed: () => undefined };

/** 守护进程报的几家（455 起去掉了旧守护进程只给 amapKey 时当两家的退路：页面和守护进程一起发）；还没取到是空的 */
export function providersOf(config: MapConfigView | undefined): readonly MapProviderView[] {
  return config?.providers ?? [];
}

/** 这一家在这个区域的优先级（451：regionPriority 里写了这个区域的用它，不然 priority） */
export const priorityIn = (p: Pick<MapProviderView, "priority" | "regionPriority">, region: MapRegion): number => p.regionPriority?.[region] ?? p.priority;

/** 这个区域里优先级大的在前，一样大的照原来的先后 */
const byPriority = (list: readonly MapProviderView[], region: MapRegion) => list.toSorted((a, b) => priorityIn(b, region) - priorityIn(a, region));

/** 这一家的底图这一页上用得了吗：有底图、填了 Key 没坏、网页那一半在、这一页没加载失败 */
const usable = (p: MapProviderView, page: BasemapPage) => p.basemap && p.ready && page.has(p.id) && page.failed(p.id) === undefined;

/**
 * "自动"时这个区域用哪家：管这个区域、用得了的里优先级最大的；管这个区域的一家都用不了时（455：只开着谷歌、人在大陆），
 * 退到在这个区域能手动选的（谷歌在大陆能手动选，它自己转坐标）；都没有是 undefined
 */
export function autoBasemap(region: MapRegion, providers: readonly MapProviderView[], page: BasemapPage): string | undefined {
  const usableHere = providers.filter((p) => usable(p, page));
  return (
    byPriority(
      usableHere.filter((p) => p.regions.includes(region)),
      region,
    )[0]?.id ??
    byPriority(
      usableHere.filter((p) => p.manualRegions.includes(region)),
      region,
    )[0]?.id
  );
}

/**
 * 一家底图都用不了时为什么（455，地图页那一句）：off 是开着的一家都没有（三家插件都停了，去设置 · 插件启用）；
 * unusable 是开着的几家都用不了（没填 Key、Key 坏了、这一页加载不上），names 是它们的编号
 */
export function noMapReason(providers: readonly MapProviderView[], page: BasemapPage): { readonly kind: "off" } | { readonly kind: "unusable"; readonly ids: readonly string[] } {
  const enabled = providers.filter((p) => p.basemap && page.has(p.id));
  return enabled.length === 0 ? { kind: "off" } : { kind: "unusable", ids: enabled.map((p) => p.id) };
}

/** 看足迹时一律用的（FOOTPRINTS_ON_CURRENT_MAP 改回 false 时）：查来的哪儿都能画的那几家里"自动"会挑的 */
const footprintSafe = (region: MapRegion, providers: readonly MapProviderView[], page: BasemapPage) =>
  autoBasemap(
    region,
    providers.filter((p) => !p.ownBasemapOnly),
    page,
  );

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
 * 地图切换里这个区域列哪几家（"自动"另算）：手动能用在这个区域、有底图、填了 Key 没坏、网页那一半在的——"自动"会挑的几家
 * （管这个区域的）按这个区域的优先级排在前面，只能手动选的排在后面；这一页加载失败的也列，带原因（设备连不上那家，比如在大陆连谷歌）
 */
export function switchEntries(region: MapRegion, providers: readonly MapProviderView[], page: BasemapPage): SwitchEntry[] {
  const listed = providers.filter((p) => p.basemap && p.ready && p.manualRegions.includes(region) && page.has(p.id));
  const auto = byPriority(
    listed.filter((p) => p.regions.includes(region)),
    region,
  );
  const manualOnly = byPriority(
    listed.filter((p) => !p.regions.includes(region)),
    region,
  );
  return [...auto, ...manualOnly].map((p) => {
    const failed = page.failed(p.id);
    return failed === undefined ? { id: p.id } : { id: p.id, failed };
  });
}

/**
 * 这一屏用哪家：wanted 想用的（451：还在加载的那一会儿地图页不先画别家，等它）、auto 是"自动"会挑的、manual 是不是照手动选的、
 * current 是没有临时那一家时的当前地图（手动选的或自动）、temporary 是不是临时用查它的那家（点开别家查到的卡片）。
 * 一家都用不了时 wanted、auto、current 都是 undefined（455：三家都停了、都没填 Key）
 */
export interface BasemapPick {
  readonly wanted: string | undefined;
  readonly auto: string | undefined;
  readonly manual: boolean;
  readonly current: string | undefined;
  readonly temporary: boolean;
}

/**
 * 挑这一屏的底图。temporary 是这一屏临时要用的那一家（地图页点开别家查到的卡片：查它的那家，条款要求只画在它自己的地图上）——
 * 它在这里能选（手动能用在这个区域、Key 没坏、网页一半在、这一页没加载失败）就用它，不改记着的手动选择；用不了照常挑
 */
export function pickBasemap(q: {
  region: MapRegion;
  choice?: string | undefined;
  providers: readonly MapProviderView[];
  page: BasemapPage;
  footprints?: boolean | undefined;
  temporary?: string | undefined;
}): BasemapPick {
  const auto = autoBasemap(q.region, q.providers, q.page);
  const chosen = q.choice !== undefined && selectable(q.providers.find((p) => p.id === q.choice), q.region, q.page) ? q.choice : undefined;
  const current = q.footprints === true && !FOOTPRINTS_ON_CURRENT_MAP ? footprintSafe(q.region, q.providers, q.page) : (chosen ?? auto);
  if (q.temporary !== undefined && q.temporary !== current && selectable(q.providers.find((p) => p.id === q.temporary), q.region, q.page)) return { wanted: q.temporary, auto, manual: false, current, temporary: true };
  return { wanted: current, auto, manual: chosen !== undefined && current === chosen, current, temporary: false };
}

/** 这一家能出静态地图（聊天卡片的预览图，守护进程经 GET /api/map/preview 取）：守护进程报的 preview；瓦片底图（OpenStreetMap）不报、页面自己画 */
export function previewable(id: string, providers: readonly MapProviderView[]): boolean {
  return providers.find((p) => p.id === id)?.preview === true;
}

/**
 * 一张卡片画在哪家的地图上、怎么画：查到的（只能画在自己地图上的）用查它的那家；足迹、点、路线、哪儿都能画的那家查的用当前地图。
 * 一家都用不了时 provider 是 undefined（卡片只有字）
 */
export interface CardBasemap {
  /** 那一家的编号 */
  readonly provider: string | undefined;
  /** 是查到的、只能画在它自己地图上的（取不到图时不能退回页面自己画，只写字） */
  readonly own: boolean;
  /** 要不要经守护进程取它的静态地图（不是：页面自己画瓦片底图，或者只有字） */
  readonly image: boolean;
}

/**
 * 挑卡片的地图（451）：own 是查它的那家（别家查来的；OpenStreetMap 查的、足迹、点、路线不写），center 是内容的中心（挑区域），
 * choice 是这台设备按区域记的手动选择，page 同地图页（聊天页不加载外站脚本：网页一半在不在看插槽，加载失败的不知道）。
 * 查到的那家报了不出静态图（旧守护进程没报的当能出，取不到再说）的不取，只写字
 */
export function cardBasemap(q: { own?: string | undefined; center: LatLon; footprints?: boolean | undefined; providers: readonly MapProviderView[]; choice: MapChoice; page: BasemapPage }): CardBasemap {
  if (q.own !== undefined) return { provider: q.own, own: true, image: q.providers.find((p) => p.id === q.own)?.preview !== false };
  const region = mapRegionOf(q.center);
  const provider = pickBasemap({ region, choice: q.choice[region], providers: q.providers, page: q.page, footprints: q.footprints }).wanted;
  return { provider, own: false, image: provider !== undefined && previewable(provider, q.providers) };
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

/**
 * 这一家查来的只能画在哪家的底图上：那家报了 ownBasemapOnly 是 false 的（OpenStreetMap）哪儿都能画（undefined）；别家的只画在它自己的上，
 * 不认得的（插件停了、守护进程报的还没取到）也一律这样（不知道条款的宁严勿松，和守护进程的 preview.ts 一样）
 */
export function ownBasemapOf(source: string, providers: readonly MapProviderView[] | undefined): string | undefined {
  return providers?.find((p) => p.id === source)?.ownBasemapOnly === false ? undefined : source;
}

/** 地图那块报上来的、挑交给秘书的地图编号要的那几样（MapView.tsx 的 BasemapStatus） */
export interface LookupBasemapStatus {
  readonly region: MapRegion;
  readonly rendered: string;
  readonly auto: string | undefined;
  readonly options: readonly { readonly id: string; readonly failed?: string }[];
}

/**
 * 地图上下文里交给秘书的地图编号（秘书照它把查询工具的 map 写成这一家，查询跟着地图走，444 × 445 的接线）：
 * - 就是真画着的那一家（rendered；451 起看足迹也用当前地图，FOOTPRINTS_ON_CURRENT_MAP）；
 * - 要是改回"看足迹一律画在哪儿都能画的那家"：查询不跟着写它（用户 2026-11-08 定）——写这个区域手动选的那一家（还在能选的里、
 *   这一页没加载失败），没选过写"自动"会挑的那家
 */
export function lookupBasemap(status: LookupBasemapStatus, choice: MapChoice, footprints: boolean): string {
  if (!footprints || FOOTPRINTS_ON_CURRENT_MAP) return status.rendered;
  const chosen = choice[status.region];
  if (chosen !== undefined && status.options.some((o) => o.id === chosen && o.failed === undefined)) return chosen;
  return status.auto ?? status.rendered;
}
