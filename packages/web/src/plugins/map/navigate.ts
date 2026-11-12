// "用手机地图导航"（434，用户 2026-11-12：点了按钮就打开手机上的地图应用去导航）：往哪导航、交给谁、怎么交。纯函数，不碰 DOM，
// 测试在 Node 里跑；按钮在 MapNavigate.tsx（聊天里的地图卡片、地图页标题栏上看着二狗画的那一条）。
// - 往哪：卡片上能导航去的几处（card-scene.ts 整理卡片时算好 targets）：秘书标的点、搜到的几处、查到的地址各是一处；路线是终点
//   （查到的路线带走法，有开车的用开车）；足迹卡没有（去过的地方不用导航）。坐标一律 WGS-84；
// - 怎么交（navHandoff），按这一页开在哪：
//   · 新版鸿蒙 App（原生桥有 openNavigation，app/native-navigation.ts）：系统的"选导航应用"面板（startAbilityByType），列出手机上
//     能导航的地图 App，点一个就开始导航；面板拉不起来时退回导航网址；
//   · 安卓 App：geo: 链接交给系统（App 原有的"别的链接交给系统"那条路，MainActivity.kt 的 openOutside，不改原生），系统弹出能打开
//     它的地图 App 让用户挑（设了默认的直接打开），打开后是那一处的地点页，点"路线 / 导航"开始；
//   · 浏览器（手机、电脑）、旧版鸿蒙 App：那一家地图的导航网址（navigationUrl：地图服务插槽里登记了 navigation 的几家，按点所在区域的
//     优先级挑第一家给得出网址的——默认国内高德、国外谷歌，都没开时 OpenStreetMap 的网页）。高德的网址在手机浏览器里拉起装了的
//     高德 App，电脑上是高德网页版的导航；谷歌的网址手机上打开谷歌地图 App，电脑上是网页版。
// - 大陆里的点交出去一律 GCJ-02（鸿蒙的面板、高德都要它）；geo: 规范上是 WGS-84，但国内的地图 App 都用 GCJ-02，按它读的多——
//   没在真机上核实，偏了要改这里（geoUri）。大陆外原样（wgsToGcj 不动大陆外的点）。
// 地图插件不认得任何一家（455）：哪家的网址怎么写由那一家的插件在插槽里登记（MapBasemapSlot.navigation）。
import { type AppPlatform, distanceMeters, type MapDrawing, type MapProviderView, mapRegionOf, type MapRouteMode, MAP_ROUTE_MODES, wgsToGcj } from "../../state/index.ts";
import type { MapNavTarget } from "../api.ts";
import { priorityIn } from "./providers.ts";

export type { MapNavTarget };

/** 菜单里最多列几处（搜到的地点多的时候） */
export const MAP_NAV_MAX = 10;

/** 路线的终点离秘书标的哪个点不到这么远（米），就用那个点的名字当终点的名字 */
const END_LABEL_WITHIN_M = 300;

/** 一个点要的那几样（名字是空的不写） */
function targetOf(p: { lat: number; lon: number; label?: string | undefined }, mode?: MapRouteMode): MapNavTarget {
  const name = p.label?.trim();
  return { lat: p.lat, lon: p.lon, ...(name ? { name } : {}), ...(mode === undefined ? {} : { mode }) };
}

/** 秘书给的一组点：每个点一处 */
export function pointsTargets(marks: readonly { lat: number; lon: number; label?: string | undefined }[]): MapNavTarget[] {
  return marks.slice(0, MAP_NAV_MAX).map((m) => targetOf(m));
}

/** 秘书给的路线：终点（最后一个点）；名字用离终点最近、不到 300 米的那个标出来的点的字 */
export function routeTargets(points: readonly { lat: number; lon: number }[], marks: readonly { lat: number; lon: number; label?: string | undefined }[]): MapNavTarget[] {
  const end = points.at(-1);
  if (end === undefined) return [];
  const named = marks
    .filter((m) => m.label?.trim())
    .map((m) => ({ m, d: distanceMeters(m, end) }))
    .filter((x) => x.d <= END_LABEL_WITHIN_M)
    .toSorted((a, b) => a.d - b.d)[0]?.m;
  return [targetOf({ lat: end.lat, lon: end.lon, label: named?.label })];
}

/** 一条查到的路线是哪种走法（不认得的不算） */
const modeOf = (mode: string | undefined): MapRouteMode | undefined => (MAP_ROUTE_MODES as readonly string[]).includes(mode ?? "") ? (mode as MapRouteMode) : undefined;

/**
 * 查到的那一份：地点是搜到的几处（kind 是 search 的；"附近"的中心、"我在哪"不算）、地址是那一处、路线是终点（编号 to 的那个点，
 * 没有就用最后一个点、再没有用线的最后一点）；路线的走法有开车的用开车，没有用第一条线的
 */
export function drawingTargets(drawing: Pick<MapDrawing, "kind" | "marks" | "lines">): MapNavTarget[] {
  if (drawing.kind === "route") {
    const modes = drawing.lines.map((l) => modeOf(l.mode)).filter((m): m is MapRouteMode => m !== undefined);
    const mode = modes.includes("driving") ? "driving" : modes[0];
    const end = drawing.marks.find((m) => m.id === "to") ?? drawing.marks.at(-1);
    if (end) return [targetOf(end, mode)];
    const last = drawing.lines[0]?.points.at(-1);
    return last ? [targetOf(last, mode)] : [];
  }
  const found = drawing.kind === "places" ? drawing.marks.filter((m) => m.kind === "search") : drawing.marks.filter((m) => m.kind !== "here");
  return found.slice(0, MAP_NAV_MAX).map((m) => targetOf(m));
}

/**
 * 浏览器里交给哪一家的导航网址：守护进程报的几家里，管这个点所在区域的按这个区域的优先级排在前面，只能手动选的排在后面；
 * 第一家登记了导航网址、给得出这个点的网址的就用它（不看 Key：导航网址不用 Key）。几家还没取到、一家都给不出是 undefined
 */
export function navigationUrl(
  target: MapNavTarget,
  providers: readonly MapProviderView[] | undefined,
  navigationOf: (id: string) => ((target: MapNavTarget) => string | undefined) | undefined,
): string | undefined {
  if (providers === undefined) return undefined;
  const region = mapRegionOf(target);
  const ranked = (list: readonly MapProviderView[]) => list.toSorted((a, b) => priorityIn(b, region) - priorityIn(a, region));
  const order = [...ranked(providers.filter((p) => p.regions.includes(region))), ...ranked(providers.filter((p) => !p.regions.includes(region) && p.manualRegions.includes(region)))];
  for (const p of order) {
    const url = navigationOf(p.id)?.(target);
    if (url !== undefined) return url;
  }
  return undefined;
}

/** 坐标写到小数点后 6 位（约 0.1 米） */
const fixed = (n: number) => n.toFixed(6);

/**
 * 安卓交给系统的 geo: 链接：geo:纬度,经度?q=纬度,经度(名字)——q 里带坐标和名字，地图 App 在那里标一个点、写上名字。
 * 大陆里写 GCJ-02（见文件开头），名字里的括号换成空格（括号是 geo: 里名字的边）
 */
export function geoUri(target: MapNavTarget): string {
  const p = wgsToGcj(target);
  const at = `${fixed(p.lat)},${fixed(p.lon)}`;
  const name = target.name?.replace(/[()（）]/g, " ").trim(); // @i18n-ignore fixed：认括号的正则，不是给人看的句子
  return `geo:${at}?q=${at}${name ? `(${encodeURIComponent(name)})` : ""}`;
}

/** 交给 App 的那一份：大陆里转成 GCJ-02，名字、走法照原样 */
export function nativeTarget(target: MapNavTarget): { lat: number; lon: number; name: string | undefined; mode: MapRouteMode } {
  const p = wgsToGcj(target);
  return { lat: Number(fixed(p.lat)), lon: Number(fixed(p.lon)), name: target.name, mode: target.mode ?? "driving" };
}

/**
 * 怎么交出去：
 * - panel：新版鸿蒙 App 的系统面板（fallback 是拉不起来时打开的导航网址）；
 * - system：安卓 App 把 geo: 交给系统；
 * - web：打开导航网址（浏览器在新窗口；旧版鸿蒙 App 里外部网址进"浏览"或者系统浏览器）
 */
export type NavHandoff =
  | { readonly kind: "panel"; readonly fallback?: string | undefined }
  | { readonly kind: "system"; readonly url: string }
  | { readonly kind: "web"; readonly url: string };

/** 这一页开在哪：哪种 App（有原生桥时按浏览器标识认，浏览器里是 undefined）、App 有没有系统的"选导航应用"面板、是不是手机 */
export interface NavEnv {
  readonly app: AppPlatform | undefined;
  readonly panel: boolean;
  /** 手机（App 里、手机浏览器）：按钮写"用手机地图导航"；电脑写"打开网页地图导航" */
  readonly phone: boolean;
}

/** 这一处怎么交出去（webUrl 是 navigationUrl 挑的导航网址）；交不出去（浏览器里一家导航网址都没有）是 undefined，不给按钮 */
export function navHandoff(target: MapNavTarget, env: NavEnv, webUrl: string | undefined): NavHandoff | undefined {
  if (env.panel) return { kind: "panel", ...(webUrl === undefined ? {} : { fallback: webUrl }) };
  if (env.app === "android") return { kind: "system", url: geoUri(target) };
  return webUrl === undefined ? undefined : { kind: "web", url: webUrl };
}

/** 按浏览器标识认是不是手机浏览器（电脑上的 Chrome、Edge 不是） */
export function phoneUserAgent(userAgent: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|OpenHarmony/i.test(userAgent);
}
