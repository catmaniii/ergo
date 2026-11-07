// 聊天里的地图卡片（431）画什么：卡片负载（足迹按日期现取来的那一天、查地点和路线按编号现取来的那一份）→ 地图上的东西（MapScene）、
// 看全要看的点、卡上地图下面写的几行字。纯函数，不碰 DOM、不联网，测试在 Node 里跑。卡片的缩略图（MapThumb.tsx）和点开后的地图页
// （MapPage.tsx）都照这一份画。坐标一律 WGS-84。
// **高德查来的结果（地点、路线）只能画在高德的地图上**（高德开放平台服务协议 4.12.4 不许脱离它的服务单独展示、7.7 要标明"高德地图"）：
// 这种内容 amapOnly，卡片上不画缩略图（聊天页不加载高德的脚本）、只写文字和"在地图上看"，地图页只在底图是高德时画它。
// 用户自己的足迹、秘书给的点和路线、以后 OpenStreetMap 查来的（433）能画在 OpenStreetMap 上。
import { type LatLon, type MapCardShow, type MapDayView, type MapDrawing, t } from "../../state/index.ts";
import { ownMapOnly } from "./amap-results.ts";
import { daySummary, footprintDay, spotTitle } from "./footprints.ts";
import type { MapLine, MapMark, MapScene } from "./scene.ts";

/** 卡片画的东西的编号前缀（和地图页别的东西分开） */
export const CARD_PREFIX = "card-";
/** 卡上列名字最多列几个（多的写"等 N 处"） */
const NAMES_MAX = 4;

/**
 * 画得出来的一张卡：画什么、看全要看的点、卡上写的几行字、是不是用户自己的足迹（挑底图用）、
 * 是不是只能画在高德地图上（高德查来的）
 */
export interface MapCardContent {
  readonly scene: MapScene;
  readonly bounds: readonly LatLon[];
  readonly lines: readonly string[];
  readonly footprints: boolean;
  readonly amapOnly: boolean;
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
  return { state: "ready", content: { scene: day.scene, bounds: day.bounds, lines, footprints: true, amapOnly: false } };
}

/** 秘书给的一组点、一条路线（存在卡上的） */
export function shownContent(show: Extract<MapCardShow, { kind: "points" | "route" }>): MapCardContent {
  const marks: MapMark[] = show.marks.map((m) => ({ id: `${CARD_PREFIX}${m.id}`, lat: m.lat, lon: m.lon, ...(m.label === undefined ? {} : { label: m.label }), kind: "place" }));
  const lines: MapLine[] = show.kind === "route" ? [{ id: `${CARD_PREFIX}route`, points: show.points, kind: "route" }] : [];
  const bounds = show.kind === "route" ? show.points : show.marks;
  // 路线写"起点 → 途经 → 终点"，一组点写"西湖、灵隐寺、…"
  const labels = show.marks.flatMap((m) => (m.label === undefined ? [] : [m.label]));
  const text = show.kind === "route" ? (labels.length > 0 ? labels.join(" → ") : undefined) : namesLine(labels);
  return { scene: { marks, lines, circles: [] }, bounds, lines: text === undefined ? [] : [text], footprints: false, amapOnly: false };
}

/** 一种走法叫什么（432 的开车、公交、步行；不认得的不写） */
function modeLabel(mode: string | undefined): string | undefined {
  return mode === "driving" ? t("ui.plugins.map.card.mode.driving") : mode === "transit" ? t("ui.plugins.map.card.mode.transit") : mode === "walking" ? t("ui.plugins.map.card.mode.walking") : undefined;
}

/** 数据从哪来："数据来自 OpenStreetMap"、"数据来自高德地图"（两家都要求标明来源） */
export function sourceLine(source: string): string {
  if (source === "osm") return t("ui.plugins.map.card.source.osm");
  return source === "amap" ? t("ui.plugins.map.card.source.amap") : t("ui.plugins.map.card.source.other", { source });
}

/** 查地点、算路线查到的那一份（按编号现取来的）：高德查来的只能画在高德地图上（amapOnly） */
export function drawingContent(drawing: MapDrawing): MapCardContent {
  const marks: MapMark[] = drawing.marks.map((m) => ({ id: `${CARD_PREFIX}${m.id}`, lat: m.lat, lon: m.lon, ...(m.label === undefined ? {} : { label: m.label }), kind: m.kind }));
  const lines: MapLine[] = drawing.lines.map((l) => ({ id: `${CARD_PREFIX}${l.id}`, points: l.points, kind: "route" }));
  const bounds: LatLon[] = [...drawing.marks, ...drawing.lines.flatMap((l) => l.points)];
  const modes = [...new Set(drawing.lines.map((l) => modeLabel(l.mode)).filter((m): m is string => m !== undefined))];
  // 地点写搜到的几处的名字、地址写那一处；路线的起终点标题里有了，写走法
  const named = drawing.marks.filter((m) => drawing.kind !== "places" || m.kind === "search").flatMap((m) => (m.label === undefined ? [] : [m.label]));
  const found = drawing.kind === "route" ? undefined : namesLine(named);
  const text = [found, modes.length > 0 ? modes.join(t("pages.common.listSep")) : undefined, sourceLine(drawing.source)].filter((l): l is string => l !== undefined && l !== "");
  return { scene: { marks, lines, circles: [] }, bounds, lines: text, footprints: false, amapOnly: ownMapOnly(drawing.source) };
}

/** 地图卡片点开后地图页那一条写的：标题后面跟的那几行（不重复标题） */
export function contentSummary(data: MapCardData): string | undefined {
  if (data.state === "ready") return data.content.lines.join(" · ") || undefined;
  return data.state === "loading" ? undefined : data.text;
}
