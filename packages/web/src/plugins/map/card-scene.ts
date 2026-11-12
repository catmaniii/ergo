// 聊天里的地图卡片（431）画什么：卡片负载（足迹按日期现取来的那一天、查地点和路线按编号现取来的那一份）→ 地图上的东西（MapScene）、
// 看全要看的点、卡上地图下面写的几行字。纯函数，不碰 DOM、不联网，测试在 Node 里跑。卡片的缩略图（MapThumb.tsx）和点开后的地图页
// （MapPage.tsx）都照这一份画。坐标一律 WGS-84。
// **高德、谷歌查来的结果（地点、路线）只能画在它们自己的地图上**（高德开放平台服务协议 4.12.4 不许脱离它的服务单独展示、7.7 要标明来源；
// 谷歌同样）：这种内容写 ownBasemap（哪一家）。451 起卡片放那一家的静态预览图（取不到只写文字和"在地图上看"），地图页这一屏临时用那一家画它。
// 用户自己的足迹、秘书给的点和路线、哪儿都能画的那家（OpenStreetMap，433）查来的，哪家地图上都能画（用当前地图）。
// 455 起地图插件不认得任何一家：哪家只能画在自己地图上看那家报的 ownBasemapOnly，"数据来自 X"写那家网页一半登记的名字（CardSources）。
import { type LatLon, type MapCardShow, type MapDayView, type MapDrawing, type MapProviderView, t } from "../../state/index.ts";
import { ownBasemapOf } from "./providers.ts";
import { daySummary, footprintDay, spotTitle } from "./footprints.ts";
import type { MapLine, MapMark, MapScene } from "./scene.ts";

/** 卡片画的东西的编号前缀（和地图页别的东西分开） */
export const CARD_PREFIX = "card-";
/** 卡上列名字最多列几个（多的写"等 N 处"） */
const NAMES_MAX = 4;

/**
 * 画得出来的一张卡：画什么、看全要看的点、卡上写的几行字、是不是用户自己的足迹（挑底图用）、
 * 只能画在哪一家的地图上（高德、谷歌查来的：ownBasemap 写是哪一家；455 以前另有个 amapOnly，去掉了）
 */
export interface MapCardContent {
  readonly scene: MapScene;
  readonly bounds: readonly LatLon[];
  readonly lines: readonly string[];
  readonly footprints: boolean;
  /** 只能画在哪一家的底图上（地图服务的编号）；哪儿都能画的不写 */
  readonly ownBasemap?: string;
  /** 查到的那一份自己的标题（查的时候起的；不经卡片直接看查到的一处时地图页标题栏写它，447）；别的不写 */
  readonly title?: string;
}

/**
 * 取到哪一步了：还在取、能画了、这一天什么都没有、取不到（查地点和路线的结果过期了也是这个：守护进程回的那句"过期了，再问一次"；
 * 手机插件、地图插件没启用也是）
 */
export type MapCardData =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly content: MapCardContent }
  | { readonly state: "empty"; readonly text: string }
  | { readonly state: "failed"; readonly text: string };

/** 几个名字列成一行："家、公司、西湖边"，多了"…等 6 处" */
function namesLine(names: readonly string[]): string | undefined {
  if (names.length === 0) return undefined;
  const shown = names.slice(0, NAMES_MAX).join(t("pages.common.listSep"));
  return names.length > NAMES_MAX ? t("ui.plugins.map.card.more", { names: shown, total: names.length }) : shown;
}

/** 某一天的足迹：整理一天（footprints.ts）那一份，下面写概况和按先后去过的几处 */
export function dayContent(view: MapDayView): MapCardData {
  const day = footprintDay(view);
  if (day.empty) return { state: "empty", text: t("ui.plugins.map.day.empty") };
  const lines = [daySummary(view, day), namesLine(day.spots.map((s) => spotTitle(s)))].filter((l): l is string => l !== undefined);
  return { state: "ready", content: { scene: day.scene, bounds: day.bounds, lines, footprints: true } };
}

/** 秘书给的一组点、一条路线（存在卡上的） */
export function shownContent(show: Extract<MapCardShow, { kind: "points" | "route" }>): MapCardContent {
  const marks: MapMark[] = show.marks.map((m) => ({ id: `${CARD_PREFIX}${m.id}`, lat: m.lat, lon: m.lon, ...(m.label === undefined ? {} : { label: m.label }), kind: "place" }));
  const lines: MapLine[] = show.kind === "route" ? [{ id: `${CARD_PREFIX}route`, points: show.points, kind: "route" }] : [];
  const bounds = show.kind === "route" ? show.points : show.marks;
  // 路线写"起点 → 途经 → 终点"，一组点写"西湖、灵隐寺、…"
  const labels = show.marks.flatMap((m) => (m.label === undefined ? [] : [m.label]));
  const text = show.kind === "route" ? (labels.length > 0 ? labels.join(" → ") : undefined) : namesLine(labels);
  return { scene: { marks, lines, circles: [] }, bounds, lines: text === undefined ? [] : [text], footprints: false };
}

/** 一种走法叫什么（432 的开车、公交、步行；不认得的不写） */
function modeLabel(mode: string | undefined): string | undefined {
  return mode === "driving" ? t("ui.plugins.map.card.mode.driving") : mode === "transit" ? t("ui.plugins.map.card.mode.transit") : mode === "walking" ? t("ui.plugins.map.card.mode.walking") : undefined;
}

/**
 * 卡片要知道的几家（455）：守护进程报的几家（哪家查来的只能画在自己地图上：ownBasemapOnly；还没取到是 undefined，一律当只能画在自己的上），
 * 和"数据来自 X"里写的名字（那家网页一半登记的 credit，没写用 title；没登记的不知道）
 */
export interface CardSources {
  readonly providers?: readonly MapProviderView[] | undefined;
  credit?(id: string): string | undefined;
}

/**
 * 数据从哪来："数据来自 OpenStreetMap"、"数据来自高德地图"、"数据来自 Google 地图"（几家都要求标明来源；谷歌要写 Google Maps，446）。
 * name 是那家登记的名字（谷歌插件写"Google 地图"）；不知道时写编号
 */
export function sourceLine(source: string, name?: string | undefined): string {
  const shown = name ?? source;
  // 名字以汉字开头的不空格（"数据来自高德地图"），英文名前空一格（"数据来自 OpenStreetMap"）
  return t(/^\p{Script=Han}/u.test(shown) ? "ui.plugins.map.card.source.named" : "ui.plugins.map.card.source.other", { source: shown });
}

/** 查地点、算路线查到的那一份（按编号现取来的）：只能画在自己地图上的那几家查来的只画在那一家的地图上（ownBasemap） */
export function drawingContent(drawing: MapDrawing, sources: CardSources = {}): MapCardContent {
  const marks: MapMark[] = drawing.marks.map((m) => ({ id: `${CARD_PREFIX}${m.id}`, lat: m.lat, lon: m.lon, ...(m.label === undefined ? {} : { label: m.label }), kind: m.kind }));
  const lines: MapLine[] = drawing.lines.map((l) => ({ id: `${CARD_PREFIX}${l.id}`, points: l.points, kind: "route" }));
  const bounds: LatLon[] = [...drawing.marks, ...drawing.lines.flatMap((l) => l.points)];
  const modes = [...new Set(drawing.lines.map((l) => modeLabel(l.mode)).filter((m): m is string => m !== undefined))];
  // 地点写搜到的几处的名字、地址写那一处；路线的起终点标题里有了，写走法
  const named = drawing.marks.filter((m) => drawing.kind !== "places" || m.kind === "search").flatMap((m) => (m.label === undefined ? [] : [m.label]));
  const found = drawing.kind === "route" ? undefined : namesLine(named);
  const text = [found, modes.length > 0 ? modes.join(t("pages.common.listSep")) : undefined, sourceLine(drawing.source, sources.credit?.(drawing.source))].filter((l): l is string => l !== undefined && l !== "");
  const own = ownBasemapOf(drawing.source, sources.providers);
  return { scene: { marks, lines, circles: [] }, bounds, lines: text, footprints: false, ...(own === undefined ? {} : { ownBasemap: own }), title: drawing.title };
}

/** 内容的中心（外接框的中心）：卡片按它在哪个区域挑当前地图（451）；没有点给 0,0 */
export function contentCenter(content: Pick<MapCardContent, "bounds">): LatLon {
  if (content.bounds.length === 0) return { lat: 0, lon: 0 };
  const lats = content.bounds.map((p) => p.lat);
  const lons = content.bounds.map((p) => p.lon);
  return { lat: (Math.max(...lats) + Math.min(...lats)) / 2, lon: (Math.max(...lons) + Math.min(...lons)) / 2 };
}

/** 地图卡片点开后地图页那一条写的：标题后面跟的那几行（不重复标题） */
export function contentSummary(data: MapCardData): string | undefined {
  if (data.state === "ready") return data.content.lines.join(" · ") || undefined;
  return data.state === "loading" ? undefined : data.text;
}
