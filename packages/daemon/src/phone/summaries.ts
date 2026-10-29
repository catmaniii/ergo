// @i18n-ignore-file model：摘要和地点写进素材，给记忆整理模型、检索读的中文（同 data-sources/material.ts 的场景一行；手册第 9 节"给模型看的只用中文"）
// 一天的照片、位置整理成一条摘要（300 号票，issue 25"量大的先整理成摘要再进素材"）。纯函数：只看交进来的原始数据和起了名的地方，
// 时间按守护进程的本地时间分。
// - 地点（308 号票，用户 2026-10-26 选了"系统转地名 + 常去地起名"）：按"起了名的 > 系统地名 > 坐标"写——落在起了名的地方的范围里
//   （几处都盖住取中心最近的）写名字（"家""公司"）；不然写手机系统转出来的地名（这一处的几条里最多的那个，"杭州市西湖区北山街"）；
//   都没有写坐标：经纬度保留两位小数（约一公里）"北纬 30.27°、东经 120.15° 一带"。守护进程自己不联网、不调地图服务，地名是 App 在
//   手机上转好交来的；起名、改名后以前的摘要不重写（摘要写成事件就不动了），往后整理的用新名；
// - 照片：按拍摄时间排，隔了一小时以上、或者都有地点而离开一公里以上就另起一段；摘要写哪个时段拍了几张、几张没有地点，
//   地点不写进摘要正文、只放进场景（位置没打开推断时证据里去掉地点、这条照读——303 号票的规矩）；
// - 位置：照"停留点"的做法（一串点都在 STAY_RADIUS_M 以内、前后超过 STAY_MIN_MS 算在那儿待了一段），同一处的几段合起来，
//   写"去过哪、待了多久"；精度太差的点（定位半径超过 MAX_ACCURACY_M）不用；中间隔了 MAX_GAP_MS 以上没有点的不算一直待着，写明有空档。
//   整条都是位置（敏感类别"位置"），地点同时放进场景。
import { localDate, nowIso, type PhoneAddress, phoneAddressLabel } from "@ergo/protocol";
import type { RawPhoto, RawPoint } from "./raw-store.ts";

/** 待在一处：点都在这个半径（米）以内 */
export const STAY_RADIUS_M = 400;
/** 待够多久才算待过（毫秒） */
export const STAY_MIN_MS = 15 * 60_000;
/** 两个点隔这么久以上没记到，不算一直待着（毫秒） */
export const MAX_GAP_MS = 90 * 60_000;
/** 定位半径超过这个（米）的点不用（低功耗定位靠基站时能差到几公里） */
export const MAX_ACCURACY_M = 1500;
/** 几段停留离得这么近（米）算同一处 */
export const SAME_PLACE_M = 500;
/** 照片：隔这么久以上另起一段（毫秒） */
export const PHOTO_GAP_MS = 60 * 60_000;
/** 照片：都有地点、离开这么远（米）另起一段 */
export const PHOTO_SPREAD_M = 1000;

/** 一天的摘要：从几点到几点、摘要正文、场景里的地点、整理了几条 */
export interface DaySummary {
  at: string;
  end: string;
  text: string;
  place?: string;
  count: number;
}

interface LatLon {
  lat: number;
  lon: number;
}

/** 两点之间的距离（米，球面） */
export function distanceM(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const centroid = (points: readonly LatLon[]): LatLon => ({ lat: points.reduce((s, p) => s + p.lat, 0) / points.length, lon: points.reduce((s, p) => s + p.lon, 0) / points.length });

/** 只用坐标写的地点："北纬 30.27°、东经 120.15° 一带"（两位小数，约一公里） */
export function placeLabel(p: LatLon): string {
  const lat = `${p.lat >= 0 ? "北纬" : "南纬"} ${Math.abs(p.lat).toFixed(2)}°`;
  const lon = `${p.lon >= 0 ? "东经" : "西经"} ${Math.abs(p.lon).toFixed(2)}°`;
  return `${lat}、${lon} 一带`;
}

/** 起了名的一处（308 号票）：名字、中心、范围（半径，米） */
export interface NamedPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radius: number;
}

/** 系统地名写成一段（308 号票，"杭州市西湖区北山街"；协议包的 phoneAddressLabel，网页显示也用它） */
export const addressLabel: (addr: PhoneAddress | undefined) => string | undefined = phoneAddressLabel;

/** 盖住这一点的起了名的那一处（在它的范围里；几处都盖住时取中心最近的）；没有是 undefined */
export function namedPlaceAt(where: LatLon, places: readonly NamedPlace[]): NamedPlace | undefined {
  let best: { place: NamedPlace; d: number } | undefined;
  for (const place of places) {
    const d = distanceM(where, place);
    if (d <= place.radius && (best === undefined || d < best.d)) best = { place, d };
  }
  return best?.place;
}

/** 几条里系统地名最多的那个（一样多取先出现的）；都没有地名是 undefined */
export function commonAddress(items: ReadonlyArray<{ addr?: PhoneAddress }>): string | undefined {
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = addressLabel(item.addr);
    if (label !== undefined) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let best: [string, number] | undefined;
  for (const entry of counts) if (best === undefined || entry[1] > best[1]) best = entry;
  return best?.[0];
}

/** 一处地点怎么写：起了名的 > 系统地名（这一处的几条里最多的） > 坐标一带 */
export function nameOf(where: LatLon, items: ReadonlyArray<{ addr?: PhoneAddress }>, places: readonly NamedPlace[]): string {
  return namedPlaceAt(where, places)?.name ?? commonAddress(items) ?? placeLabel(where);
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** "2026-10-25（周日）" */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${date}（${WEEKDAYS[new Date(y, m - 1, d).getDay()]}）`;
}

const ms = (iso: string) => Date.parse(iso);
/** 本地时间几点几分 */
const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const span = (from: number, to: number) => (hhmm(from) === hhmm(to) ? hhmm(from) : `${hhmm(from)}–${hhmm(to)}`);

/** 一天里的时段（按开始的钟点） */
export function periodOf(t: number): string {
  const h = new Date(t).getHours();
  if (h < 6) return "凌晨";
  if (h < 9) return "早上";
  if (h < 12) return "上午";
  if (h < 13) return "中午";
  if (h < 18) return "下午";
  return "晚上";
}

/** "约 3 小时 20 分" / "约 45 分钟"（按 5 分钟取整，最少 5 分钟） */
export function durationText(lengthMs: number): string {
  const minutes = Math.max(5, Math.round(lengthMs / 60_000 / 5) * 5);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `约 ${m} 分钟`;
  return m === 0 ? `约 ${h} 小时` : `约 ${h} 小时 ${m} 分`;
}

/** 本地日期（守护进程的时区） */
export const dateOfIso = (iso: string) => localDate(new Date(iso));

const located = (p: RawPhoto): p is RawPhoto & LatLon => typeof p.lat === "number" && typeof p.lon === "number";

interface PhotoGroup {
  from: number;
  to: number;
  count: number;
  /** 有地点的那几张的中心（没有一张有地点的没有） */
  where?: LatLon;
  /** 有地点的那几张（带系统地名的带着） */
  located: Array<RawPhoto & LatLon>;
}

/** 照片分段：按拍摄时间排，隔了 PHOTO_GAP_MS 以上、或者都有地点而离开 PHOTO_SPREAD_M 以上另起一段 */
export function groupPhotos(photos: readonly RawPhoto[]): PhotoGroup[] {
  const groups: PhotoGroup[] = [];
  for (const photo of photos.toSorted((a, b) => ms(a.at) - ms(b.at))) {
    const t = ms(photo.at);
    const last = groups.at(-1);
    const where = last?.located.length ? centroid(last.located) : undefined;
    const far = where !== undefined && located(photo) && distanceM(where, photo) > PHOTO_SPREAD_M;
    if (!last || t - last.to > PHOTO_GAP_MS || far) {
      groups.push({ from: t, to: t, count: 1, located: located(photo) ? [photo] : [] });
      continue;
    }
    last.to = t;
    last.count += 1;
    if (located(photo)) last.located.push(photo);
  }
  return groups.map((g) => (g.located.length > 0 ? { ...g, where: centroid(g.located) } : g));
}

/** 场景里的地点：几段各自的时段和地点（起了名的 > 系统地名 > 坐标），挨着的同一处合起来，最多 max 段 */
function placeOfGroups(groups: readonly PhotoGroup[], max: number, places: readonly NamedPlace[]): string | undefined {
  const parts: Array<{ periods: string[]; label: string }> = [];
  for (const g of groups) {
    if (!g.where) continue;
    const label = nameOf(g.where, g.located, places);
    const period = periodOf(g.from);
    const last = parts.at(-1);
    if (last && last.label === label) {
      if (!last.periods.includes(period)) last.periods.push(period);
    } else parts.push({ periods: [period], label });
  }
  if (parts.length === 0) return undefined;
  const shown = parts.slice(0, max).map((p) => `${p.periods.join("、")} ${p.label}`);
  return parts.length > max ? `${shown.join("；")} 等 ${parts.length} 处` : shown.join("；");
}

/** 一天的照片（part 2 起是补的）→ 摘要；places 是起了名的地方（场景里的地点按"起了名的 > 系统地名 > 坐标"写） */
export function summarizePhotos(date: string, photos: readonly RawPhoto[], part: number, places: readonly NamedPlace[] = []): DaySummary {
  const groups = groupPhotos(photos);
  const total = photos.length;
  const unlocated = photos.filter((p) => !located(p)).length;
  const segments = groups.map((g) => `${periodOf(g.from)} ${span(g.from, g.to)} ${g.count} 张`);
  const head = part > 1 ? `${dayLabel(date)}补记：又读到那天拍的 ${total} 张照片` : `${dayLabel(date)}拍了 ${total} 张照片`;
  const tail = unlocated === 0 ? "" : unlocated === total ? "都没有地点。" : `其中 ${unlocated} 张没有地点。`;
  const text = `${head}：${segments.join("，")}。${tail}`;
  const place = placeOfGroups(groups, 4, places);
  return { at: nowIso(new Date(groups[0]!.from)), end: nowIso(new Date(groups.at(-1)!.to)), text, ...(place === undefined ? {} : { place }), count: total };
}

export interface Stay {
  from: number;
  to: number;
  where: LatLon;
  /** 这一段的点（系统地名从这里取） */
  points: RawPoint[];
}

/** 停留点：从一个点起，往后都在 STAY_RADIUS_M 以内（中间没有 MAX_GAP_MS 以上的空档）的一串，前后超过 STAY_MIN_MS 算待了一段 */
export function detectStays(points: readonly RawPoint[]): Stay[] {
  const stays: Stay[] = [];
  let i = 0;
  while (i < points.length) {
    let j = i;
    while (j + 1 < points.length && distanceM(points[i]!, points[j + 1]!) <= STAY_RADIUS_M && ms(points[j + 1]!.at) - ms(points[j]!.at) <= MAX_GAP_MS) j += 1;
    const from = ms(points[i]!.at);
    const to = ms(points[j]!.at);
    if (to - from >= STAY_MIN_MS) {
      const members = points.slice(i, j + 1);
      stays.push({ from, to, where: centroid(members), points: members });
      i = j + 1;
    } else i += 1;
  }
  return stays;
}

interface Place {
  where: LatLon;
  /** 落在起了名的哪一处的范围里（308 号票） */
  named?: NamedPlace;
  spans: Array<{ from: number; to: number }>;
  total: number;
  points: RawPoint[];
}

/** 几段停留合成几处，按第一次到的先后：落在同一处起了名的地方的范围里的算一处（308 号票）；别的离得 SAME_PLACE_M 以内算同一处 */
function mergeStays(stays: readonly Stay[], named: readonly NamedPlace[]): Place[] {
  const places: Place[] = [];
  for (const stay of stays) {
    const own = namedPlaceAt(stay.where, named);
    const same = own ? places.find((p) => p.named?.id === own.id) : places.find((p) => p.named === undefined && distanceM(p.where, stay.where) <= SAME_PLACE_M);
    if (same) {
      same.spans.push({ from: stay.from, to: stay.to });
      same.total += stay.to - stay.from;
      same.points.push(...stay.points);
    } else {
      places.push({
        where: own ? { lat: own.lat, lon: own.lon } : stay.where,
        ...(own ? { named: own } : {}),
        spans: [{ from: stay.from, to: stay.to }],
        total: stay.to - stay.from,
        points: [...stay.points],
      });
    }
  }
  return places;
}

/** 合起来的一处怎么写：起了名的 > 系统地名 > 坐标 */
const placeName = (p: Place) => p.named?.name ?? commonAddress(p.points) ?? placeLabel(p.where);

/**
 * 一天的位置点（part 2 起是补的）→ 摘要；精度太差的点全没了交回 undefined（只把点记成整理过）。
 * named 是起了名的地方（地点按"起了名的 > 系统地名 > 坐标"写）
 */
export function summarizeLocation(date: string, raw: readonly RawPoint[], part: number, named: readonly NamedPlace[] = []): DaySummary | undefined {
  const points = raw.filter((p) => p.acc === undefined || p.acc <= MAX_ACCURACY_M).toSorted((a, b) => ms(a.at) - ms(b.at));
  if (points.length === 0) return undefined;
  const first = ms(points[0]!.at);
  const last = ms(points.at(-1)!.at);
  const places = mergeStays(detectStays(points), named);
  const gaps = points.slice(1).filter((p, k) => ms(p.at) - ms(points[k]!.at) > MAX_GAP_MS).length;
  const head = `${dayLabel(date)}${part > 1 ? "补记的位置" : "的位置"}：记到 ${points.length} 个点（${span(first, last)}）`;
  // 记到过的地方（按第一次记到的先后，同一处只算一次）：一个点也按"起了名的 > 它的系统地名 > 坐标"写
  const seen: Array<{ point: RawPoint; label: string }> = [];
  for (const p of points) {
    const label = nameOf(p, [p], named);
    if (!seen.some((q) => q.label === label)) seen.push({ point: p, label });
  }
  let body: string;
  if (places.length === 0) {
    const where = seen.slice(0, 4).map((s) => `${s.label} ${hhmm(ms(s.point.at))}`);
    body = `，没有在哪儿待够 ${Math.round(STAY_MIN_MS / 60_000)} 分钟：${where.join("；")}。`;
  } else {
    const described = places.map((p) => `${placeName(p)}，${p.spans.map((s) => span(s.from, s.to)).join("、")}，${p.spans.length > 1 ? "共" : ""}${durationText(p.total)}`);
    // 路过的：不在哪一处附近（起了名的按它的范围，至少 SAME_PLACE_M）的点，按坐标（约一公里一格）数几处
    const near = (pl: Place, p: RawPoint) => distanceM(pl.where, p) <= Math.max(SAME_PLACE_M, pl.named?.radius ?? 0);
    const passed = new Set(points.filter((p) => !places.some((pl) => near(pl, p))).map((p) => placeLabel(p))).size;
    body = `。待过 ${places.length} 个地方：${described.join("；")}。${passed > 0 ? `另外路过 ${passed} 处。` : ""}`;
  }
  const text = `${head}${body}${gaps > 0 ? `中间有 ${gaps} 段一个半小时以上没记到。` : ""}`;
  const top = places.toSorted((a, b) => b.total - a.total).slice(0, 3).map(placeName);
  const place = (top.length > 0 ? top : seen.slice(0, 3).map((s) => s.label)).join("；");
  return { at: nowIso(new Date(first)), end: nowIso(new Date(last)), text, place, count: raw.length };
}
