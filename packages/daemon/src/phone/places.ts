// @i18n-ignore-file model：坐标一带的写法和摘要里的一样（summaries.ts 的 placeLabel），给人看的说法走 t()（photos-location.ts）
// "手机"插件的常去的地方（308 号票，用户 2026-10-26 选了"系统转地名 + 常去地起名"）：
// - 起了名的地方存在插件自己的存储里（数据目录的 phone/places.json，{ format: 1, places: [...] }）：名字、中心、范围（半径，默认 200 米）、
//   起名时知道的系统地名。数据源页"手机 · 位置"下面起名、改名、删、手动加一处；摘要和场景里落在范围里的点和照片写名字（summaries.ts）。
//   断开"手机 · 位置"并连已导入的一起删时整个删掉（照片那边的摘要也用它，但它是从位置点聚出来、在位置下面管的），移除插件连数据删时跟着
//   phone/ 整个删掉；跟数据目录一起进备份快照；
// - 按位置点聚出常待的几处（frequentPlaces，纯函数）：每天的原始位置点找停留点（summaries.ts 的 detectStays，同摘要的口径），
//   几天的停留点离得近的（默认范围以内）合成一处，数待过几次、分在几天，地名取这一处的点里系统地名最多的那个、没有写坐标；
//   落在起了名的地方的范围里的算那一处的次数、不再列；没起名的列待过两次以上的几处（多的在前）。
import fs from "node:fs";
import path from "node:path";
import { PHONE_PLACE_RADIUS_DEFAULT_M, PHONE_PLACE_SUGGESTIONS_MAX, type PhonePlaceSuggestionView } from "@ergo/protocol";
import type { RawPoint } from "./raw-store.ts";
import { commonAddress, detectStays, distanceM, MAX_ACCURACY_M, type NamedPlace, namedPlaceAt, placeLabel, type Stay } from "./summaries.ts";

/** 起了名的一处（存进 places.json 的） */
export interface PhonePlace extends NamedPlace {
  /** 起名时知道的系统地名（给人看的一段） */
  address?: string;
  /** 什么时候加的（协议时间） */
  addedAt: string;
}

export interface PlacesStore {
  list(): PhonePlace[];
  /** 整个换成这些（按加的先后） */
  save(places: readonly PhonePlace[]): void;
  /** 整个删掉（文件也删） */
  clearAll(): void;
}

interface PlacesFile {
  format: 1;
  places: PhonePlace[];
}

const isPlace = (v: unknown): v is PhonePlace => {
  const p = v as Partial<PhonePlace> | null;
  return (
    typeof p === "object" &&
    p !== null &&
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    typeof p.lat === "number" &&
    typeof p.lon === "number" &&
    typeof p.radius === "number" &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    p.radius > 0
  );
};

/** 打开 places.json（第一次用时读一遍；读不了当没有、记日志）。写文件先写临时文件再改名 */
export function openPlacesStore(file: string, log: (line: string) => void): PlacesStore {
  let places: PhonePlace[] | undefined;
  const ensure = (): PhonePlace[] => {
    if (places) return places;
    places = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PlacesFile>;
      places = (Array.isArray(parsed.places) ? parsed.places : []).filter(isPlace);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`手机：${file} 读不了，当作没有起名的地方：${err instanceof Error ? err.message : String(err)}`);
    }
    return places;
  };
  return {
    list: () => [...ensure()],
    save(next) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ format: 1, places: [...next] } satisfies PlacesFile));
      fs.renameSync(tmp, file);
      places = [...next];
    },
    clearAll() {
      fs.rmSync(file, { force: true });
      places = [];
    },
  };
}

/** 一天的原始位置点 */
export interface PointsOfDay {
  date: string;
  points: readonly RawPoint[];
}

/** 聚出来的一处：中心、待过几次、分在几天、一共待了多久、这一处的点 */
interface Cluster {
  lat: number;
  lon: number;
  visits: number;
  dates: Set<string>;
  total: number;
  points: RawPoint[];
}

/** 起了名的一处待过几次（按停留点数） */
export interface PlaceVisits {
  id: string;
  visits: number;
}

/** 按位置点聚出来的常待的几处：起了名的各待过几次；没起名的（待过两次以上，多的在前，最多几处） */
export interface FrequentPlaces {
  named: PlaceVisits[];
  suggestions: PhonePlaceSuggestionView[];
}

/** 中心的编号："30.25900,120.13000" */
const keyOf = (lat: number, lon: number) => `${lat.toFixed(5)},${lon.toFixed(5)}`;

/**
 * 按几天的原始位置点聚出常待的几处（纯函数）：每天找停留点（精度太差的点不用，同摘要），几天的停留点离得 PHONE_PLACE_RADIUS_DEFAULT_M
 * 以内的合成一处（中心按待的时长加权）；落在起了名的地方的范围里的算那一处的次数
 */
export function frequentPlaces(days: readonly PointsOfDay[], named: readonly NamedPlace[], max = PHONE_PLACE_SUGGESTIONS_MAX): FrequentPlaces {
  const visits = new Map<string, number>(named.map((p) => [p.id, 0]));
  const clusters: Cluster[] = [];
  for (const { date, points } of days.toSorted((a, b) => a.date.localeCompare(b.date))) {
    const usable = points.filter((p) => p.acc === undefined || p.acc <= MAX_ACCURACY_M).toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const stay of detectStays(usable)) {
      const own = namedPlaceAt(stay.where, named);
      if (own) {
        visits.set(own.id, (visits.get(own.id) ?? 0) + 1);
        continue;
      }
      addStay(clusters, stay, date);
    }
  }
  const suggestions = clusters
    .filter((c) => c.visits >= 2)
    .toSorted((a, b) => b.visits - a.visits || b.total - a.total)
    .slice(0, max)
    .map((c): PhonePlaceSuggestionView => {
      const lat = Math.round(c.lat * 1e5) / 1e5;
      const lon = Math.round(c.lon * 1e5) / 1e5;
      const address = commonAddress(c.points);
      return { key: keyOf(lat, lon), lat, lon, label: address ?? placeLabel({ lat, lon }), ...(address === undefined ? {} : { address }), visits: c.visits, days: c.dates.size };
    });
  return { named: named.map((p) => ({ id: p.id, visits: visits.get(p.id) ?? 0 })), suggestions };
}

/** 一段停留并进离得最近的那一处（默认范围以内），没有就另起一处 */
function addStay(clusters: Cluster[], stay: Stay, date: string): void {
  const length = Math.max(1, stay.to - stay.from);
  let best: { cluster: Cluster; d: number } | undefined;
  for (const cluster of clusters) {
    const d = distanceM(cluster, stay.where);
    if (d <= PHONE_PLACE_RADIUS_DEFAULT_M && (best === undefined || d < best.d)) best = { cluster, d };
  }
  if (!best) {
    clusters.push({ lat: stay.where.lat, lon: stay.where.lon, visits: 1, dates: new Set([date]), total: length, points: [...stay.points] });
    return;
  }
  const c = best.cluster;
  c.lat = (c.lat * c.total + stay.where.lat * length) / (c.total + length);
  c.lon = (c.lon * c.total + stay.where.lon * length) / (c.total + length);
  c.total += length;
  c.visits += 1;
  c.dates.add(date);
  c.points.push(...stay.points);
}

/** 离这一点最近的、聚出来的一处的系统地名（手动加一处、没给地名时补上；在范围以内的才算） */
export function addressNear(where: { lat: number; lon: number }, radius: number, days: readonly PointsOfDay[]): string | undefined {
  const near = days.flatMap((d) => d.points.filter((p) => p.addr !== undefined && distanceM(p, where) <= radius));
  return commonAddress(near);
}
