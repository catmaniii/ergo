// 地图页的"我的足迹"（430）：把某一天的足迹（GET /api/map/day 的 MapDayView）变成地图上画的东西和旁边列的字。
// 纯函数，不碰 DOM、不联网，测试在 Node 里跑。坐标一律 WGS-84（画到高德地图上时由高德那一套自己转）。
// 画什么（都放进 429 的 MapScene，编号一律以 fp- 开头，样式按它挑：styles/map-footprints.css）：
// - 轨迹线（kind track）：按时间连起这一天的点；停留那一段的点收成停留的中心（不画一团乱线），
//   中间一个半小时以上没有点的断开（不把没记到的那段画成直线）；
// - 停留点（kind stay）：同一处（spot）的几段一个点，旁边写名字（起的名字 > 系统地名 > 几点到的）和一共待了多久；
// - 照片小点（kind photo）：挨着拍的（半小时内、百米以内）合成一个，旁边写几点拍的（几张）；
// - 常去的地方：起了名的每一处画范围圈；这一天没在那里待过的另写一个名字。
// 这些点只在二狗里画，不发给任何地图服务。
import { clockLabel, distanceMeters, type LatLon, type MapDayPhoto, type MapDayStay, type MapDayView, t } from "../../state/index.ts";
import type { MapCircle, MapLine, MapMark, MapScene } from "./scene.ts";

/** 足迹画的东西的编号前缀（地图页按它分辨点的是不是足迹） */
export const FOOTPRINT_PREFIX = "fp-";
/** 轨迹在这么久以上没有点就断开（毫秒；和守护进程认停留时的空档一样） */
export const TRACK_GAP_MS = 90 * 60_000;
/** 照片合成一个点：前后隔不到这么久（毫秒）…… */
export const PHOTO_GROUP_MS = 30 * 60_000;
/** ……而且离这一组第一张不到这么远（米） */
export const PHOTO_GROUP_M = 100;

/** 一处：同一个 spot 的几段停留（按时间先后） */
export interface FootprintSpot {
  readonly key: string;
  readonly markId: string;
  readonly stays: readonly MapDayStay[];
  /** 画在哪：第一段的中心 */
  readonly lat: number;
  readonly lon: number;
  readonly name?: string | undefined;
  readonly address?: string | undefined;
  readonly placeId?: string | undefined;
  /** 一共待了几分钟 */
  readonly minutes: number;
  /** 待着的时候在附近拍了几张照片 */
  readonly photos: number;
}

/** 挨着拍的几张照片 */
export interface PhotoGroup {
  readonly markId: string;
  readonly at: string;
  readonly until: string;
  readonly count: number;
  readonly lat: number;
  readonly lon: number;
}

/** 列表里的一行（按时间先后）：一段停留，或者一组照片（不在停留里拍的） */
export type TimelineEntry = { readonly kind: "stay"; readonly at: string; readonly stay: MapDayStay; readonly spot: FootprintSpot } | { readonly kind: "photos"; readonly at: string; readonly group: PhotoGroup };

/** 整理好的一天：画什么、列什么 */
export interface FootprintDay {
  readonly spots: readonly FootprintSpot[];
  readonly photoGroups: readonly PhotoGroup[];
  readonly timeline: readonly TimelineEntry[];
  readonly scene: MapScene;
  /** 看全这一天要看的点（定视野用） */
  readonly bounds: readonly LatLon[];
  /** 这一天有没有能画的东西 */
  readonly empty: boolean;
}

const ms = (iso: string) => Date.parse(iso);
const markIdOfSpot = (key: string) => `${FOOTPRINT_PREFIX}stay-${key}`;

/** 时长："45 分钟"、"2 小时"、"2 小时 5 分" */
export function durationLabel(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return t("ui.plugins.map.day.minutes", { m: rest });
  return rest === 0 ? t("ui.plugins.map.day.hours", { h }) : t("ui.plugins.map.day.hoursMinutes", { h, m: rest });
}

/** 一段停留几点到几点："08:00–10:00" */
export function stayRange(stay: Pick<MapDayStay, "from" | "to">): string {
  return `${clockLabel(stay.from)}–${clockLabel(stay.to)}`;
}

/** 一处叫什么：起的名字 > 系统地名 > "没起名的地方" */
export function spotTitle(spot: Pick<FootprintSpot, "name" | "address">): string {
  return spot.name ?? spot.address ?? t("ui.plugins.map.day.unnamed");
}

/** 坐标写成一行（没有地名时给人对照）："30.25950, 120.14520" */
export function coordsLabel(p: LatLon): string {
  return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
}

/** 照片合成几组：按时间排，前后隔不到半小时、离这一组第一张不到百米的合在一起 */
export function groupPhotos(photos: readonly MapDayPhoto[]): PhotoGroup[] {
  const groups: Array<{ first: MapDayPhoto; last: MapDayPhoto; members: MapDayPhoto[] }> = [];
  for (const p of photos.toSorted((a, b) => ms(a.at) - ms(b.at))) {
    const g = groups.at(-1);
    if (g && ms(p.at) - ms(g.last.at) <= PHOTO_GROUP_MS && distanceMeters(g.first, p) <= PHOTO_GROUP_M) {
      g.last = p;
      g.members.push(p);
    } else groups.push({ first: p, last: p, members: [p] });
  }
  return groups.map((g) => ({
    markId: `${FOOTPRINT_PREFIX}photo-${g.first.id}`,
    at: g.first.at,
    until: g.last.at,
    count: g.members.length,
    lat: g.members.reduce((s, p) => s + p.lat, 0) / g.members.length,
    lon: g.members.reduce((s, p) => s + p.lon, 0) / g.members.length,
  }));
}

/** 这张照片是不是在这段停留的时候、在附近拍的（停留的范围按守护进程的 400 米，加一点余量） */
const takenDuring = (photo: MapDayPhoto, stay: MapDayStay) => ms(photo.at) >= ms(stay.from) && ms(photo.at) <= ms(stay.to) && distanceMeters(photo, stay) <= 500;

/** 停留按 spot 归成几处（按第一次到的先后） */
export function footprintSpots(view: Pick<MapDayView, "stays" | "photos">): FootprintSpot[] {
  const order: string[] = [];
  const byKey = new Map<string, MapDayStay[]>();
  for (const stay of view.stays.toSorted((a, b) => ms(a.from) - ms(b.from))) {
    if (!byKey.has(stay.spot)) {
      byKey.set(stay.spot, []);
      order.push(stay.spot);
    }
    byKey.get(stay.spot)!.push(stay);
  }
  return order.map((key) => {
    const stays = byKey.get(key)!;
    const first = stays[0]!;
    return {
      key,
      markId: markIdOfSpot(key),
      stays,
      lat: first.lat,
      lon: first.lon,
      name: stays.find((s) => s.name !== undefined)?.name,
      address: stays.find((s) => s.address !== undefined)?.address,
      placeId: stays.find((s) => s.placeId !== undefined)?.placeId,
      minutes: stays.reduce((sum, s) => sum + s.minutes, 0),
      photos: view.photos.filter((p) => stays.some((s) => takenDuring(p, s))).length,
    };
  });
}

/** 轨迹线：停留那一段的点收成停留的中心，一个半小时以上没有点的断开；少于两个点的段不画 */
export function trackLines(view: Pick<MapDayView, "points" | "stays">): MapLine[] {
  const stays = view.stays.map((s) => ({ from: ms(s.from), to: ms(s.to), where: { lat: s.lat, lon: s.lon } }));
  const segments: LatLon[][] = [];
  let current: LatLon[] = [];
  let lastAt: number | undefined;
  let lastStay: (typeof stays)[number] | undefined;
  for (const p of view.points.toSorted((a, b) => ms(a.at) - ms(b.at))) {
    const at = ms(p.at);
    if (lastAt !== undefined && at - lastAt > TRACK_GAP_MS) {
      segments.push(current);
      current = [];
      lastStay = undefined;
    }
    lastAt = at;
    const stay = stays.find((s) => at >= s.from && at <= s.to);
    if (stay) {
      if (stay !== lastStay) current.push(stay.where);
      lastStay = stay;
      continue;
    }
    lastStay = undefined;
    current.push({ lat: p.lat, lon: p.lon });
  }
  segments.push(current);
  return segments.filter((s) => s.length >= 2).map((points, i) => ({ id: `${FOOTPRINT_PREFIX}track-${i + 1}`, points, kind: "track" as const }));
}

/** 停留点旁边写的：名字 > 系统地名 > 几点到的，加上一共待了多久 */
function stayMarkLabel(spot: FootprintSpot): string {
  const head = spot.name ?? spot.address ?? clockLabel(spot.stays[0]!.from);
  return `${head} · ${durationLabel(spot.minutes)}`;
}

/** 照片小点旁边写的：几点拍的（几张） */
function photoMarkLabel(group: PhotoGroup): string {
  const time = clockLabel(group.at);
  return group.count > 1 ? t("ui.plugins.map.day.photoLabel", { time, count: group.count }) : time;
}

/** 整理一天：几处停留、几组照片、列表、地图上画的、看全要看的点 */
export function footprintDay(view: MapDayView): FootprintDay {
  const spots = footprintSpots(view);
  const photoGroups = groupPhotos(view.photos);
  const visited = new Set(spots.flatMap((s) => (s.placeId === undefined ? [] : [s.placeId])));
  const lines = trackLines(view);
  const circles: MapCircle[] = view.places.map((p) => ({ id: `${FOOTPRINT_PREFIX}circle-${p.id}`, lat: p.lat, lon: p.lon, radius: p.radius }));
  const marks: MapMark[] = [
    // 先画的在下面：常去的地方的名字、照片、停留
    ...view.places.filter((p) => !visited.has(p.id)).map((p): MapMark => ({ id: `${FOOTPRINT_PREFIX}place-${p.id}`, lat: p.lat, lon: p.lon, label: p.name, kind: "place" })),
    ...photoGroups.map((g): MapMark => ({ id: g.markId, lat: g.lat, lon: g.lon, label: photoMarkLabel(g), kind: "photo" })),
    ...spots.map((s): MapMark => ({ id: s.markId, lat: s.lat, lon: s.lon, label: stayMarkLabel(s), kind: "stay" })),
  ];
  // 列表：每段停留一行；照片只列不在停留里拍的那几组（在停留里拍的写在那一处的详情里）
  const inStay = (g: PhotoGroup) => view.stays.some((s) => ms(g.at) >= ms(s.from) && ms(g.at) <= ms(s.to) && distanceMeters(g, s) <= 500);
  const timeline: TimelineEntry[] = [
    ...spots.flatMap((spot) => spot.stays.map((stay): TimelineEntry => ({ kind: "stay", at: stay.from, stay, spot }))),
    ...photoGroups.filter((g) => !inStay(g)).map((group): TimelineEntry => ({ kind: "photos", at: group.at, group })),
  ].toSorted((a, b) => ms(a.at) - ms(b.at));
  const bounds: LatLon[] = [...view.points, ...view.photos, ...view.stays].map((p) => ({ lat: p.lat, lon: p.lon }));
  return { spots, photoGroups, timeline, scene: { marks, lines, circles }, bounds, empty: bounds.length === 0 };
}

/** 地图页原来的东西加上足迹（足迹画在上面） */
export function withFootprints(base: MapScene, footprints: MapScene | undefined): MapScene {
  if (!footprints) return base;
  return { marks: [...base.marks, ...footprints.marks], lines: [...base.lines, ...footprints.lines], circles: [...base.circles, ...footprints.circles] };
}

/** 一天的概况："待过 3 个地方 · 6 张照片"；只有路上的点写一句；什么都没有给 undefined */
export function daySummary(view: MapDayView, day: FootprintDay): string | undefined {
  const parts: string[] = [];
  if (day.spots.length > 0) parts.push(t("ui.plugins.map.day.places", { count: day.spots.length }));
  else if (view.points.length > 0) parts.push(t("ui.plugins.map.day.passing"));
  const photos = view.photos.length + view.unlocatedPhotos;
  if (photos > 0) parts.push(t("ui.plugins.map.day.photos", { count: photos }));
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** 视野往右让出 px 像素（左边盖着一栏时，让看全的东西落在剩下那一块的正中）：中心往西挪 px 像素对应的经度 */
export function shiftViewRight<V extends { lat: number; lon: number; zoom: number }>(view: V, px: number): V {
  if (px === 0) return view;
  return { ...view, lon: view.lon - (px * 360) / (256 * 2 ** view.zoom) };
}

/** 这一天之前最近有足迹的一天（没有给 undefined；days 是新的在前） */
export function latestDayBefore(days: readonly string[], date: string): string | undefined {
  return days.find((d) => d < date);
}
