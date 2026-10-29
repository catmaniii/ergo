// "手机"插件的照片、位置（300 号票）：收手机上的二狗 App 交来的（经内核的数据源 push，查过 schema）。
// - 照片的时间地点：连着（用户在 App 里点了"连上相册"）时收 App 读到的最近几天拍的照片的拍摄时间和地点（不收照片本身），
//   按本地日期存进插件自己的存储（raw-store.ts，一张照片按 App 给的编号的哈希只收一次）；
// - 位置：连着（用户在 App 里点了"开始记位置"）时收 App 记下的位置点，同样按天存进插件自己的存储（按时间只收一次）；
// - 整理：每次交来以后，今天以前还有没整理的那几天各整理成一条摘要（summaries.ts），写成 phone_photos_day / phone_location_day，
//   由采集规则变成素材（plugin.ts）。今天的等过完这一天、下一次交来时再整理（App 开着时会把记下的都交过来）；整理之后又交来那天的，
//   补一条（part 2 起）。只在交来时整理：导入关着、断开了就不再整理新的（已经整理好的摘要照旧在素材里）；
// - 没授权、撤回了、读不了的记下状况和原因（数据源页写明），同手机日历；断开时记下没连着，连已导入的一起删时插件自己存储里的那一份整个删掉
//   （摘要由内核按 records 删，素材跟着删）；
// - 原始数据数据源页按天列出、能按天清掉（数据源的 raw）。
// 308 号票（地名）：
// - App 交来的照片、位置点可以带系统转出来的地名（App 在手机上转，转不了的只有坐标），和坐标一起存进原始数据；收过的照片这次带来了
//   原来没有的地名时补上（raw-store.ts）；
// - 常去的地方（places.ts）：起了名的存在插件自己的存储里（phone/places.json），"手机 · 位置"的连接状态里带"常去的地方"那一块（panel：
//   起了名的几处和各待过几次、按最近的位置点聚出来还没起名的几处），起名、改名、删、手动加一处经填设置（values.places）交来；
//   做不成的原因写在那一块里（refused，下一次填设置时清掉）；
// - 整理摘要时把起了名的地方交给 summaries.ts，地点按"起了名的 > 系统地名 > 坐标"写；改名后以前的摘要不动，往后的用新名；
// - 断开"手机 · 位置"并连已导入的一起删时起了名的地方一起删（断开的确认框里说一句）。
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  formatList,
  localDate,
  nowIso,
  PHONE_PLACE_DAYS,
  PHONE_PLACE_NAME_MAX,
  PHONE_PLACE_RADII_M,
  PHONE_PLACE_RADIUS_DEFAULT_M,
  PHONE_PLACES_MAX,
  type PhoneAddress,
  type PhoneLocationPush,
  type PhonePhotosPush,
  type PhonePlacesView,
  t,
} from "@ergo/protocol";
import type { DataSourcePushOutcome, DataSourceRawDay, DataSourceStatus } from "../data-sources/api.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore } from "../events/event-store.ts";
import {
  livePayloads,
  mediaStatus,
  PHONE_CHANNEL,
  PHONE_LOCATION_DAY,
  PHONE_LOCATION_STATUS,
  PHONE_PHOTOS_DAY,
  PHONE_PHOTOS_STATUS,
  type PhoneDaySummaryPayload,
  type PhoneMediaStatusPayload,
} from "./events.ts";
import { addressNear, frequentPlaces, openPlacesStore, type PhonePlace, type PointsOfDay } from "./places.ts";
import { openRawStore, type RawItem, type RawPhoto, type RawPoint, type RawStore } from "./raw-store.ts";
import { dateOfIso, type DaySummary, type NamedPlace, summarizeLocation, summarizePhotos } from "./summaries.ts";

/** 插件自己的存储在数据目录里的哪（移除插件连数据删时删它） */
export const PHONE_DATA_DIR = "phone";
/** 起了名的常去的地方存在插件自己的存储里的哪个文件（308 号票） */
export const PLACES_FILE = "places.json";

export interface PhoneMediaServiceOptions {
  store: EventStore;
  /** 现在（毫秒，守护进程的时钟） */
  nowMs: () => number;
  /** 数据目录（插件自己的存储在它下面的 phone/） */
  dataDir: string;
  log: (line: string) => void;
}

/** 照片、位置共用的一套：收、状态、断开、原始数据 */
export interface PhoneMediaService {
  receivePhotos(push: PhonePhotosPush): DataSourcePushOutcome;
  receiveLocation(push: PhoneLocationPush): DataSourcePushOutcome;
  photosStatus(): DataSourceStatus;
  locationStatus(): DataSourceStatus;
  /** 在数据源页断开了；purge 时插件自己存储里的那一份整个删掉 */
  unlinkPhotos(purge: boolean): void;
  unlinkLocation(purge: boolean): void;
  photosRawDays(): DataSourceRawDay[];
  locationRawDays(): DataSourceRawDay[];
  clearPhotosRaw(dates: readonly string[]): number;
  clearLocationRaw(dates: readonly string[]): number;
  /** 常去的地方（308 号票）：起名、改名、删、手动加一处（values.places 是哪一样，见协议包 phone.ts）；交回"手机 · 位置"不算出错的状态 */
  configurePlaces(values: Readonly<Record<string, string>>): DataSourceStatus;
}

/** 一种（照片、位置）的那几样 */
interface Kind<T extends RawItem> {
  name: "photos" | "location";
  day: typeof PHONE_PHOTOS_DAY | typeof PHONE_LOCATION_DAY;
  status: typeof PHONE_PHOTOS_STATUS | typeof PHONE_LOCATION_STATUS;
  /** 记录编号的前缀 */
  prefix: string;
  raw: RawStore<T>;
  summarize(date: string, items: readonly T[], part: number, places: readonly NamedPlace[]): DaySummary | undefined;
}

type AnyKind = Kind<RawPhoto> | Kind<RawPoint>;

const DAY_MS = 24 * 60 * 60_000;
/** 一个时间认不认得出 */
const validTime = (iso: string) => !Number.isNaN(Date.parse(iso));
/** 坐标留 5 位小数（约一米） */
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;
/** "10-25、10-26" */
const shortDates = (dates: readonly string[]) => formatList(dates.map((d) => d.slice(5)));

/** App 交来的系统地名：每段去掉首尾空白、空的去掉；一段都没有是 undefined（308 号票） */
function cleanAddress(addr: PhoneAddress | undefined): PhoneAddress | undefined {
  if (!addr) return undefined;
  const out: PhoneAddress = {};
  for (const key of ["spot", "district", "city"] as const) {
    const part = addr[key]?.replace(/\s+/g, " ").trim();
    if (part) out[key] = part;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** 常去的地方的名字：空白合成一个、去掉首尾；空的是空串 */
const cleanName = (raw: string | undefined) => (raw ?? "").replace(/\s+/g, " ").trim();
/** 填设置交来的一个小数；没有、不是数是 NaN */
const numberOf = (raw: string | undefined) => (raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw));
/** 填设置交来的范围（米）：没给是 undefined，不是能选的那几档是 "bad" */
function radiusOf(raw: string | undefined): number | undefined | "bad" {
  if (raw === undefined || raw.trim() === "") return undefined;
  const r = Number(raw);
  return (PHONE_PLACE_RADII_M as readonly number[]).includes(r) ? r : "bad";
}

export function createPhoneMediaService(options: PhoneMediaServiceOptions): PhoneMediaService {
  const { store, log } = options;
  const root = path.join(options.dataDir, PHONE_DATA_DIR);
  const photos: Kind<RawPhoto> = {
    name: "photos",
    day: PHONE_PHOTOS_DAY,
    status: PHONE_PHOTOS_STATUS,
    prefix: "pp",
    raw: openRawStore<RawPhoto>(path.join(root, "photos"), log),
    summarize: summarizePhotos,
  };
  const location: Kind<RawPoint> = {
    name: "location",
    day: PHONE_LOCATION_DAY,
    status: PHONE_LOCATION_STATUS,
    prefix: "pl",
    raw: openRawStore<RawPoint>(path.join(root, "locations"), log),
    summarize: summarizeLocation,
  };
  /** 起了名的常去的地方（308 号票） */
  const places = openPlacesStore(path.join(root, PLACES_FILE), log);
  /** "常去的地方"那一块（不含 refused）：位置点、起了名的变了才重算 */
  let placesCache: PhonePlacesView | undefined;
  /** 上一次起名、改名、删、加没做成的原因（下一次填设置时清掉） */
  let placesRefused: string | undefined;
  /** 最近几天的原始位置点（新的在前，最多 PHONE_PLACE_DAYS 天） */
  const recentPoints = (): PointsOfDay[] =>
    location.raw
      .days()
      .slice(0, PHONE_PLACE_DAYS)
      .map((d) => ({ date: d.date, points: location.raw.itemsOf(d.date) }));
  const placesView = (): PhonePlacesView => {
    if (!placesCache) {
      const days = recentPoints();
      const saved = places.list();
      const found = frequentPlaces(days, saved);
      placesCache = {
        kind: "phone-places",
        places: saved.map((p) => ({
          id: p.id,
          name: p.name,
          lat: p.lat,
          lon: p.lon,
          radius: p.radius,
          ...(p.address === undefined ? {} : { address: p.address }),
          visits: found.named.find((v) => v.id === p.id)?.visits ?? 0,
        })),
        suggestions: found.suggestions,
        days: days.length,
      };
    }
    return placesRefused === undefined ? placesCache : { ...placesCache, refused: placesRefused };
  };

  const appendStatus = (kind: AnyKind, status: Omit<PhoneMediaStatusPayload, "at">) =>
    store.append({ channel: PHONE_CHANNEL, type: kind.status, payload: { at: nowIso(new Date(options.nowMs())), ...status } satisfies PhoneMediaStatusPayload });

  /** 今天以前还有没整理的那几天各整理成一条摘要（补的是第 2、3……份），交回整理了哪几天 */
  const closeDays = <T extends RawItem>(kind: Kind<T>, device: string | undefined): string[] => {
    const today = localDate(new Date(options.nowMs()));
    const written: string[] = [];
    // 起了名的地方（308 号票）：整理时的样子，改名以后整理的才用新名
    const named = places.list();
    for (const { date, items } of kind.raw.pending(today)) {
      const parts = livePayloads<PhoneDaySummaryPayload>(store, kind.day).filter((p) => p.date === date).map((p) => p.part);
      const part = Math.max(0, ...parts) + 1;
      const summary = kind.summarize(date, items, part, named);
      if (summary) {
        store.append({
          channel: PHONE_CHANNEL,
          type: kind.day,
          payload: { id: `${kind.prefix}-${date}-${part}`, date, part, ...summary, ...(device === undefined ? {} : { device }) } satisfies PhoneDaySummaryPayload,
        });
        written.push(date);
      }
      kind.raw.markSummarized(
        date,
        items.map((i) => i.id),
      );
    }
    if (written.length > 0) log(`手机：${kind.name === "photos" ? "照片" : "位置"}整理出 ${written.join("、")} 的摘要`);
    return written;
  };

  /** 交来的是没授权、撤回了、读不了：连着时记下状况和原因（变了才记），交回给人看的那一句 */
  const lost = (kind: AnyKind, push: { state: "denied" | "revoked" | "unavailable"; device?: string; reason?: string }): DataSourcePushOutcome => {
    const status = mediaStatus(store, kind.status);
    if (status?.linked !== true) throw new RequestRejected("not_allowed", t(`phone.${kind.name}.notLinked`));
    const reason = push.reason?.trim() || undefined;
    if (status.state !== push.state || status.reason !== reason) {
      const device = push.device ?? status.device;
      appendStatus(kind, {
        linked: true,
        ...(device === undefined ? {} : { device }),
        state: push.state,
        ...(reason === undefined ? {} : { reason }),
        ...(status.location === undefined ? {} : { location: status.location }),
        ...(status.background === undefined ? {} : { background: status.background }),
      });
    }
    log(`手机：${kind.name === "photos" ? "相册" : "位置"}读不了（${push.state}${reason === undefined ? "" : `：${reason}`}）`);
    return { added: 0, summary: t(`phone.media.lost.${push.state}`) };
  };

  /** 这次交来以后的那一句：今天以前整理出了哪几天、今天的等过完再整理 */
  const afterwards = <T extends RawItem>(kind: Kind<T>, written: readonly string[]): string => {
    const today = localDate(new Date(options.nowMs()));
    const waiting = kind.raw.days().some((d) => d.date >= today && !d.summarized);
    return `${written.length > 0 ? t("phone.media.summarized", { dates: shortDates(written) }) : ""}${waiting ? t("phone.media.waiting") : ""}`;
  };

  const receivePhotos = (push: PhonePhotosPush): DataSourcePushOutcome => {
    if (push.state !== "granted") return lost(photos, push);
    const status = mediaStatus(store, PHONE_PHOTOS_STATUS);
    const linked = status?.linked === true;
    if (!linked && push.link !== true) throw new RequestRejected("not_allowed", t("phone.photos.notLinked"));
    if (!validTime(push.from) || !validTime(push.to)) throw new RequestRejected("bad_params", t("phone.media.badWindow"));
    if (push.photos.some((p) => !validTime(p.takenAt))) throw new RequestRejected("bad_params", t("phone.photos.badTime"));
    const device = push.device ?? status?.device;
    if (!linked || status?.state !== "granted" || status.location !== push.location || (push.device !== undefined && status.device !== push.device)) {
      appendStatus(photos, { linked: true, ...(device === undefined ? {} : { device }), state: "granted", location: push.location });
    }
    // 拍摄时间在明天以后的（时钟乱了）不收
    const latest = options.nowMs() + DAY_MS;
    const items = push.photos.flatMap((p): RawPhoto[] => {
      const taken = Date.parse(p.takenAt);
      if (taken > latest) return [];
      const id = createHash("sha256").update(p.key, "utf8").digest("hex").slice(0, 16);
      if (p.lat === undefined || p.lon === undefined) return [{ id, at: nowIso(new Date(taken)) }];
      const addr = cleanAddress(p.address);
      return [{ id, at: nowIso(new Date(taken)), lat: round5(p.lat), lon: round5(p.lon), ...(addr === undefined ? {} : { addr }) }];
    });
    const { added } = photos.raw.add(items, (i) => dateOfIso(i.at));
    const written = closeDays(photos, device);
    log(`手机：相册交来 ${push.photos.length} 张照片的时间地点（新 ${added} 张${push.location ? "" : "，没有读照片位置的授权"}）`);
    const summary = `${t("phone.photos.synced", { total: push.photos.length, added })}${push.location ? "" : t("phone.photos.noLocation")}${afterwards(photos, written)}`;
    return { added: written.length, summary };
  };

  const receiveLocation = (push: PhoneLocationPush): DataSourcePushOutcome => {
    if (push.state !== "granted") return lost(location, push);
    const status = mediaStatus(store, PHONE_LOCATION_STATUS);
    const linked = status?.linked === true;
    if (!linked && push.link !== true) throw new RequestRejected("not_allowed", t("phone.location.notLinked"));
    if (push.points.some((p) => !validTime(p.at))) throw new RequestRejected("bad_params", t("phone.location.badTime"));
    const device = push.device ?? status?.device;
    if (!linked || status?.state !== "granted" || status.background !== push.background || (push.device !== undefined && status.device !== push.device)) {
      appendStatus(location, { linked: true, ...(device === undefined ? {} : { device }), state: "granted", background: push.background });
    }
    const latest = options.nowMs() + DAY_MS;
    const items = push.points.flatMap((p): RawPoint[] => {
      const when = Date.parse(p.at);
      if (when > latest) return [];
      const addr = cleanAddress(p.address);
      return [
        {
          id: String(when),
          at: nowIso(new Date(when)),
          lat: round5(p.lat),
          lon: round5(p.lon),
          ...(p.accuracy === undefined ? {} : { acc: Math.round(p.accuracy) }),
          ...(addr === undefined ? {} : { addr }),
        },
      ];
    });
    const { added } = location.raw.add(items, (i) => dateOfIso(i.at));
    placesCache = undefined;
    const written = closeDays(location, device);
    log(`手机：位置交来 ${push.points.length} 个点（新 ${added} 个，${push.background ? "后台也记" : "只在 App 开着时记"}）`);
    return { added: written.length, summary: `${t("phone.location.synced", { total: push.points.length, added })}${afterwards(location, written)}` };
  };

  /** 连接状态：没连着、授权没了（出错，写明原因）、连着（账号写哪台设备，位置另写怎么记） */
  const statusOf = (kind: AnyKind): DataSourceStatus => {
    const status = mediaStatus(store, kind.status);
    if (!status?.linked) return { connection: "not_connected" };
    const mode = kind.name === "location" ? t(status.background ? "phone.location.mode.background" : "phone.location.mode.foreground") : undefined;
    const accountText = [status.device, mode].filter((s): s is string => s !== undefined && s !== "").join(t("phone.location.accountSep"));
    const account = accountText === "" ? {} : { account: accountText };
    if (status.state !== undefined && status.state !== "granted") {
      const reason = status.reason === undefined ? "" : t("phone.calendar.reason", { reason: status.reason });
      return { connection: "error", problem: t(`phone.${kind.name}.problem.${status.state}`, { reason }), ...account };
    }
    return { connection: "connected", ...account };
  };

  /** "手机 · 位置"的连接状态（308 号票）：带"常去的地方"那一块（没连着也画：可以先起名、手动加），起了名的有几处时断开的确认框里说一句 */
  const locationStatus = (): DataSourceStatus => {
    const saved = places.list();
    const note = saved.length === 0 ? {} : { disconnectNote: t("phone.places.disconnectNote", { names: formatList(saved.slice(0, 5).map((p) => p.name)), total: saved.length }) };
    return { ...statusOf(location), panel: placesView(), ...note };
  };

  const unlink = (kind: AnyKind, purge: boolean) => {
    if (mediaStatus(store, kind.status)?.linked) appendStatus(kind, { linked: false });
    if (purge) kind.raw.clearAll();
    // 断开位置并连已导入的一起删：起了名的常去的地方一起删（308 号票）
    if (purge && kind.name === "location") {
      places.clearAll();
      placesRefused = undefined;
    }
    if (kind.name === "location") placesCache = undefined;
  };

  /** 起名、改名、删、手动加一处（308 号票）；做不成的原因记在 placesRefused（那一块里写） */
  const applyPlaces = (values: Readonly<Record<string, string>>): string | undefined => {
    const saved = places.list();
    const checkName = (name: string, self?: string): string | undefined => {
      if (name === "") return t("phone.places.refused.noName");
      if ([...name].length > PHONE_PLACE_NAME_MAX) return t("phone.places.refused.tooLong", { max: PHONE_PLACE_NAME_MAX });
      if (saved.some((p) => p.id !== self && p.name === name)) return t("phone.places.refused.duplicate", { name });
      return undefined;
    };
    switch (values.places) {
      case "add": {
        const name = cleanName(values.name);
        const bad = checkName(name);
        if (bad !== undefined) return bad;
        const lat = numberOf(values.lat);
        const lon = numberOf(values.lon);
        if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || (lat === 0 && lon === 0)) return t("phone.places.refused.badWhere");
        const radius = radiusOf(values.radius);
        if (radius === "bad") return t("phone.places.refused.badRadius");
        if (saved.length >= PHONE_PLACES_MAX) return t("phone.places.refused.tooMany", { max: PHONE_PLACES_MAX });
        const where = { lat: round5(lat), lon: round5(lon) };
        const range = radius ?? PHONE_PLACE_RADIUS_DEFAULT_M;
        // 没给系统地名（电脑上手动填的坐标）：用附近记到过的点的地名
        const address = cleanName(values.address).slice(0, 90) || addressNear(where, range, recentPoints());
        const place: PhonePlace = { id: `place-${randomUUID().slice(0, 8)}`, name, ...where, radius: range, ...(address ? { address } : {}), addedAt: nowIso(new Date(options.nowMs())) };
        places.save([...saved, place]);
        log(`手机：常去的地方加了一处（${place.id}，范围 ${range} 米）`);
        return undefined;
      }
      case "rename": {
        const target = saved.find((p) => p.id === values.id);
        if (!target) return t("phone.places.refused.notFound");
        const name = values.name === undefined ? target.name : cleanName(values.name);
        const bad = checkName(name, target.id);
        if (bad !== undefined) return bad;
        const radius = radiusOf(values.radius);
        if (radius === "bad") return t("phone.places.refused.badRadius");
        places.save(saved.map((p) => (p.id === target.id ? { ...p, name, radius: radius ?? p.radius } : p)));
        log(`手机：常去的地方改了一处（${target.id}）`);
        return undefined;
      }
      case "remove": {
        if (!saved.some((p) => p.id === values.id)) return t("phone.places.refused.notFound");
        places.save(saved.filter((p) => p.id !== values.id));
        log(`手机：常去的地方删了一处（${values.id}）`);
        return undefined;
      }
      default:
        return t("phone.places.refused.unknown");
    }
  };

  return {
    receivePhotos,
    receiveLocation,
    photosStatus: () => statusOf(photos),
    locationStatus,
    unlinkPhotos: (purge) => unlink(photos, purge),
    unlinkLocation: (purge) => unlink(location, purge),
    photosRawDays: () => photos.raw.days(),
    locationRawDays: () => location.raw.days(),
    clearPhotosRaw: (dates) => photos.raw.clear(dates, options.nowMs()),
    clearLocationRaw: (dates) => {
      placesCache = undefined;
      return location.raw.clear(dates, options.nowMs());
    },
    configurePlaces(values) {
      placesRefused = applyPlaces(values);
      placesCache = undefined;
      // 改常去的地方不是填连接设置：交回不算出错的状态——内核会把出错的状态记成"填设置没过"、一直挂在那一行上，
      // 位置授权的问题由手机交来的状况管，恢复了就没了
      const connection = statusOf(location).connection;
      return { connection: connection === "error" ? "connected" : connection };
    },
  };
}
