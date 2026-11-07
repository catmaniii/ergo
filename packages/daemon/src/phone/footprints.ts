// "手机"插件的足迹（430，地图页的"我的足迹"）：某一天的原始位置点、照片的时间地点、起了名的常去的地方 → 那一天的
// 点、停留、有地点的照片、常去的地方（协议包的 MapDayView）。纯函数：只看交进来的，不读文件、**不联网、不调任何地图服务**
// （地名是 App 在手机上转好交来的；画在哪张底图上是页面的事，点本身不外发）。
// 停留怎么聚（和记忆里那条位置摘要同一个口径，参数都在 summaries.ts，只在那里定一次）：
// 1. 精度太差的点（定位半径超过 MAX_ACCURACY_M = 1500 米）不用，剩下的按时间排；
// 2. 按时间和距离：从一个点起，往后的点都在它 STAY_RADIUS_M = 400 米以内、相邻两点之间没有 MAX_GAP_MS = 90 分钟以上的空档，
//    这一串从头到尾够 STAY_MIN_MS = 15 分钟算一段停留（detectStays），停留的位置是这一串点的中心，时长是头尾之差；
// 3. 同一处的几段归成一处（spot，地图上一处一个点）：落在同一处起了名的地方的范围里的算一处（几处都盖住取中心最近的）；
//    别的离那一处第一次待的中心 SAME_PLACE_M = 500 米以内算同一处（同摘要的 mergeStays）；
// 4. 地名：起了名的写名字（name）；系统地名取这一段的点里最多的那个（address）；都没有的页面写坐标。
import { MAP_DAY_DAYS_MAX, type MapDayPhoto, type MapDayPlace, type MapDayStay, type MapDayView, nowIso } from "@ergo/protocol";
import type { RawPhoto, RawPoint } from "./raw-store.ts";
import { commonAddress, detectStays, distanceM, MAX_ACCURACY_M, type NamedPlace, namedPlaceAt, SAME_PLACE_M } from "./summaries.ts";

export interface DayFootprintsInput {
  date: string;
  /** 这一天的原始位置点（插件自己的存储里的，顺序不要紧） */
  points: readonly RawPoint[];
  /** 这一天的照片的时间地点 */
  photos: readonly RawPhoto[];
  /** 起了名的常去的地方 */
  places: ReadonlyArray<NamedPlace>;
  /** 有足迹的日子（位置点或照片，顺序、重复不要紧） */
  days: readonly string[];
  /** 手机上的"位置""照片的时间地点"现在连着没有 */
  linked: { location: boolean; photos: boolean };
}

/** 坐标留 5 位小数（约一米） */
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;
const ms = (iso: string) => Date.parse(iso);

/** 一处（同一处的几段停留归到它）：键、第一次待的中心、落在哪一处起了名的地方 */
interface Spot {
  key: string;
  where: { lat: number; lon: number };
  placeId?: string;
}

/** 某一天的足迹（见文件头）。时间是协议时间（守护进程的本地时间写的），坐标一律 WGS-84 */
export function dayFootprints(input: DayFootprintsInput): MapDayView {
  const usable = input.points.filter((p) => p.acc === undefined || p.acc <= MAX_ACCURACY_M).toSorted((a, b) => ms(a.at) - ms(b.at));
  const spots: Spot[] = [];
  const stays = detectStays(usable).map((stay): MapDayStay => {
    const own = namedPlaceAt(stay.where, input.places);
    let spot = own ? spots.find((s) => s.placeId === own.id) : spots.find((s) => s.placeId === undefined && distanceM(s.where, stay.where) <= SAME_PLACE_M);
    if (!spot) {
      spot = { key: own ? own.id : `spot-${spots.filter((s) => s.placeId === undefined).length + 1}`, where: stay.where, ...(own ? { placeId: own.id } : {}) };
      spots.push(spot);
    }
    const address = commonAddress(stay.points);
    return {
      id: `stay-${stay.from}`,
      spot: spot.key,
      from: nowIso(new Date(stay.from)),
      to: nowIso(new Date(stay.to)),
      minutes: Math.round((stay.to - stay.from) / 60_000),
      lat: round5(stay.where.lat),
      lon: round5(stay.where.lon),
      points: stay.points.length,
      ...(own ? { placeId: own.id, name: own.name } : {}),
      ...(address === undefined ? {} : { address }),
    };
  });
  const photos = input.photos
    .filter((p): p is RawPhoto & { lat: number; lon: number } => typeof p.lat === "number" && typeof p.lon === "number")
    .toSorted((a, b) => ms(a.at) - ms(b.at))
    .map((p): MapDayPhoto => ({ id: p.id, at: p.at, lat: p.lat, lon: p.lon }));
  const places = input.places.map((p): MapDayPlace => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, radius: p.radius }));
  return {
    date: input.date,
    points: usable.map((p) => ({ at: p.at, lat: p.lat, lon: p.lon })),
    stays,
    photos,
    unlocatedPhotos: input.photos.length - photos.length,
    places,
    days: [...new Set(input.days)].toSorted((a, b) => b.localeCompare(a)).slice(0, MAP_DAY_DAYS_MAX),
    linked: { ...input.linked },
  };
}
