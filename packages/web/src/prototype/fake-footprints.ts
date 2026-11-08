// 原型的"我的足迹"（430）：演示页不连守护进程，地图页的足迹用编的——
// - 昨天一整天（杭州）：家 07:00–08:15 → 路上 → 公司 08:50–17:30 → 路上 → 西湖边 18:10–20:30，三处停留、一条轨迹，
//   西湖边拍了几张照片（一处三张、一处一张），公司附近午饭时一张，还有一张没有地点；
// - 四天前：家、健身房两处停留；今天什么都没有（页面自己跳到最近有足迹的一天）；
// - 起了名的常去的地方：家、公司、健身房（健身房昨天没去，只画范围圈）。
// 坐标是编的（挑在西湖一带，演示页的底图是占位图，看不出真地方），停留按守护进程的口径算好了写死。
// - 手机最近交来的一个位置点（442，FakeDaemonHttp.mapLatest）：12 分钟前、西湖边。
// 只在演示页里用（FakeDaemonHttp.mapDay、mapLatest）。英文在 en/fake-footprints.ts。
import { localDate, type MapDayPhoto, type MapDayPlace, type MapDayPoint, type MapDayStay, type MapDayView, type MapLatestView, nowIso, shiftMapDate } from "../state/index.ts";

interface Where {
  lat: number;
  lon: number;
}

const HOME: Where = { lat: 30.2815, lon: 120.118 };
const OFFICE: Where = { lat: 30.2738, lon: 120.1495 };
const LAKE: Where = { lat: 30.2598, lon: 120.1452 };
const GYM: Where = { lat: 30.2702, lon: 120.1296 };

const PLACES: readonly MapDayPlace[] = [
  { id: "demo-fp-home", name: "家", ...HOME, radius: 200 },
  { id: "demo-fp-office", name: "公司", ...OFFICE, radius: 200 },
  { id: "demo-fp-gym", name: "健身房", ...GYM, radius: 300 },
];

/** 那一天几点几分（协议时间，本地时间写的） */
function at(date: string, hh: number, mm: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return nowIso(new Date(y, m - 1, d, hh, mm));
}

/** 待着的那一段：每隔 5 分钟一个点，在 where 附近抖几十米 */
function staying(date: string, from: [number, number], to: [number, number], where: Where): MapDayPoint[] {
  const out: MapDayPoint[] = [];
  for (let t = from[0] * 60 + from[1], k = 0; t <= to[0] * 60 + to[1]; t += 5, k++) {
    const dx = ((k * 37) % 7) - 3;
    const dy = ((k * 53) % 7) - 3;
    out.push({ at: at(date, Math.floor(t / 60), t % 60), lat: round5(where.lat + dy * 0.00012), lon: round5(where.lon + dx * 0.00014) });
  }
  return out;
}

/** 路上：从 a 经过 via 到 b，每隔 5 分钟一个点（不含两头） */
function moving(date: string, from: [number, number], to: [number, number], path: readonly Where[]): MapDayPoint[] {
  const start = from[0] * 60 + from[1];
  const end = to[0] * 60 + to[1];
  const out: MapDayPoint[] = [];
  for (let t = start + 5; t < end; t += 5) {
    const f = ((t - start) / (end - start)) * (path.length - 1);
    const i = Math.min(path.length - 2, Math.floor(f));
    const r = f - i;
    out.push({ at: at(date, Math.floor(t / 60), t % 60), lat: round5(path[i]!.lat + (path[i + 1]!.lat - path[i]!.lat) * r), lon: round5(path[i]!.lon + (path[i + 1]!.lon - path[i]!.lon) * r) });
  }
  return out;
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** 一段停留（中心、点数按这一段的点算） */
function stay(date: string, points: readonly MapDayPoint[], from: [number, number], to: [number, number], spot: string, extra: Partial<MapDayStay>): MapDayStay {
  const own = points.filter((p) => p.at >= at(date, ...from) && p.at <= at(date, ...to));
  const minutes = to[0] * 60 + to[1] - (from[0] * 60 + from[1]);
  return {
    id: `demo-fp-stay-${date}-${from.join("")}`,
    spot,
    from: at(date, ...from),
    to: at(date, ...to),
    minutes,
    lat: round5(own.reduce((s, p) => s + p.lat, 0) / own.length),
    lon: round5(own.reduce((s, p) => s + p.lon, 0) / own.length),
    points: own.length,
    ...extra,
  };
}

/** 昨天：三处停留、两段路、几张照片 */
function fullDay(date: string): Pick<MapDayView, "points" | "stays" | "photos" | "unlocatedPhotos"> {
  const points = [
    ...staying(date, [7, 0], [8, 15], HOME),
    ...moving(date, [8, 15], [8, 50], [HOME, { lat: 30.2808, lon: 120.1302 }, { lat: 30.2771, lon: 120.1405 }, OFFICE]),
    ...staying(date, [8, 50], [17, 30], OFFICE),
    ...moving(date, [17, 30], [18, 10], [OFFICE, { lat: 30.2689, lon: 120.1512 }, { lat: 30.2633, lon: 120.1488 }, LAKE]),
    ...staying(date, [18, 10], [20, 30], LAKE),
  ];
  const stays = [
    stay(date, points, [7, 0], [8, 15], "demo-fp-home", { placeId: "demo-fp-home", name: "家" }),
    stay(date, points, [8, 50], [17, 30], "demo-fp-office", { placeId: "demo-fp-office", name: "公司", address: "杭州市西湖区天目山路" }),
    stay(date, points, [18, 10], [20, 30], "spot-1", { address: "杭州市西湖区北山街" }),
  ];
  const photo = (id: string, hh: number, mm: number, where: Where): MapDayPhoto => ({ id: `demo-fp-photo-${id}`, at: at(date, hh, mm), lat: where.lat, lon: where.lon });
  const photos = [
    photo("1", 12, 20, { lat: 30.2726, lon: 120.1511 }),
    photo("2", 18, 25, { lat: 30.2601, lon: 120.1441 }),
    photo("3", 18, 27, { lat: 30.2602, lon: 120.1443 }),
    photo("4", 18, 40, { lat: 30.2599, lon: 120.1447 }),
    photo("5", 19, 35, { lat: 30.2585, lon: 120.1478 }),
  ];
  return { points, stays, photos, unlocatedPhotos: 1 };
}

/** 四天前：家、健身房 */
function shortDay(date: string): Pick<MapDayView, "points" | "stays" | "photos" | "unlocatedPhotos"> {
  const points = [...staying(date, [9, 0], [10, 0], HOME), ...moving(date, [10, 0], [10, 20], [HOME, GYM]), ...staying(date, [10, 20], [11, 40], GYM)];
  const stays = [
    stay(date, points, [9, 0], [10, 0], "demo-fp-home", { placeId: "demo-fp-home", name: "家" }),
    stay(date, points, [10, 20], [11, 40], "demo-fp-gym", { placeId: "demo-fp-gym", name: "健身房" }),
  ];
  return { points, stays, photos: [], unlocatedPhotos: 0 };
}

/** 手机"最近交来"的那个点在哪、几分钟前、精度（米） */
const LATEST = { ...LAKE, minutesAgo: 12, accuracy: 35 };

/**
 * 演示页手机最近交来的一个位置点（442，地图页"回到我现在的位置"在这台设备定不了位时的退路）：12 分钟前、西湖边，精度 35 米。
 * 只是演示退路的样子，和上面的足迹不连着（演示页今天的足迹是空的）
 */
export function demoMapLatest(now: Date): MapLatestView {
  return { point: { at: nowIso(new Date(now.getTime() - LATEST.minutesAgo * 60_000)), lat: LATEST.lat, lon: LATEST.lon, accuracy: LATEST.accuracy } };
}

/** 演示页某一天的足迹（日期按这台设备的今天算：昨天一整天、四天前半天，别的日子什么都没有） */
export function demoMapDay(date: string): MapDayView {
  const today = localDate(new Date());
  const yesterday = shiftMapDate(today, -1);
  const earlier = shiftMapDate(today, -4);
  const body = date === yesterday ? fullDay(date) : date === earlier ? shortDay(date) : { points: [], stays: [], photos: [], unlocatedPhotos: 0 };
  return { date, ...body, places: [...PLACES], days: [yesterday, earlier], linked: { location: true, photos: true } };
}
