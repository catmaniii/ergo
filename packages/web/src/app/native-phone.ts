// 鸿蒙 App 读本机（299 号票）在网页这一侧的接口：App 里的实现在 frontend/harmony/entry/src/main/ets/phone/PhoneData.ets，
// 经原生桥 ergoNative 的这一组方法调（名字和 NativeBridge.ets 的 NATIVE_BRIDGE_METHODS 里的一样）：
// - phoneContactsPick()：拉起系统的选人界面（不用通讯录权限、不读整个通讯录），回用户挑的几个人
//   （{"ok": true, "device", "contacts": [{"name", "phones", "birthday"?, "addresses"}]}，取消了 {"ok": false, "reason": "cancelled"}）；
// - phoneCalendarState()：读手机日历的授权给没给、问没问过、这台设备叫什么（{"granted", "asked", "device"}）；
// - phoneCalendarPrepare(userAction)：没给就弹系统的授权框；userAction 为真而用户拒过时拉起系统的二次授权（设置）；回之后的状态；
// - phoneCalendarRead(from, to)：只读 [from, to)（毫秒）里的日程，重复的展开成每一次
//   （{"ok": true, "events": [{"key", "title", "start", "end"?, "allDay", "location"?, "calendar"?}]}，start、end 是毫秒；
//   读不了 {"ok": false, "state": "denied" | "unavailable", "message"?}）。
// 300 号票加了两组（NativePhone.photos、NativePhone.location；旧一点的 App 没有这两组，只有前面四个）：
// - phonePhotosState()：读相册、读照片位置的授权给没给、问没问过、这台设备叫什么（{"granted", "location", "asked", "device"}）；
// - phonePhotosPrepare(userAction)：没给就弹系统的授权框（读相册、读照片位置一起要）；userAction 为真而用户拒过时拉起二次授权；回之后的状态；
// - phonePhotosRead(from, to)：只读 [from, to)（毫秒）里拍的照片的拍摄时间和地点，不读照片本身
//   （{"ok": true, "location", "photos": [{"key", "takenAt", "lat"?, "lon"?}]}，takenAt 是毫秒；读不了 {"ok": false, "state", "message"?}）；
// - phoneLocationState()：定位的授权（大概 / 精确）、问没问过、在不在记、后台也记没有、系统的位置开关关没关、这台设备叫什么
//   （{"granted", "precise", "asked", "recording", "background", "device"}）；
// - phoneLocationPrepare(userAction)：要定位的授权（同上）；
// - phoneLocationRecord(on, background)：开始 / 停下记位置（App 开着时每 5 分钟、低功耗；background 为真时 App 在后台靠位置类的
//   长时任务每 10 分钟接着记，通知栏一直显示）；停下时手机上没交出去的点一起删；回之后的状态；
// - phoneLocationRead()：手机上记下、还没交出去的点（{"ok": true, "points": [{"at", "lat", "lon", "accuracy"?}]}，at 是毫秒）；
// - phoneLocationAck(until)：交给守护进程了，删掉 until（毫秒）以前（含）的点。
// 308 号票：照片、位置点多一个 App 用系统的坐标转地址转好的地名（"address": {"spot", "district", "city"}，转不了的没有），定位的状态多一个
// 系统能不能转地名（"geocoder"）；另加一组"常去的地方"手动加一处用的（NativePhone.places；旧一点的 App 没有）：
// - phonePlaceHere()：现在在哪（定一次位、转地名）：{"ok": true, "lat", "lon", "address"?}；没定位授权 {"ok": false, "state": "denied"}；
// - phonePlaceFind(text)：按地名找（系统的地址转坐标）：{"ok": true, "lat", "lon", "address"?}；找不到 {"ok": false, "state": "not_found"}。
// 读不了都是 {"ok": false, "state": "unavailable", "message"}。
// App 回的东西形状不一定对：一律核对、截到协议包的上限（phone-schema.ts），不对就当失败，不抛错。旧版 App 没有这一组：NativeApp.phone 没有。
import {
  nowIso,
  PHONE_ADDRESS_PART_MAX,
  PHONE_CALENDAR_EVENTS_MAX,
  PHONE_CONTACTS_MAX,
  PHONE_LOCATION_POINTS_MAX,
  PHONE_PHOTOS_MAX,
  type PhoneAddress,
  type PhoneCalendarEvent,
  type PhoneContact,
  type PhoneLocationPoint,
  type PhonePhoto,
} from "../state/index.ts";

/** 原生桥上手机这一组方法的名字（四个都在才算有） */
export const NATIVE_PHONE_METHODS = ["phoneContactsPick", "phoneCalendarState", "phoneCalendarPrepare", "phoneCalendarRead"] as const;
/** 照片的时间地点这一组（300 号票，三个都在才算有） */
export const NATIVE_PHONE_PHOTOS_METHODS = ["phonePhotosState", "phonePhotosPrepare", "phonePhotosRead"] as const;
/** 位置这一组（300 号票，五个都在才算有） */
export const NATIVE_PHONE_LOCATION_METHODS = ["phoneLocationState", "phoneLocationPrepare", "phoneLocationRecord", "phoneLocationRead", "phoneLocationAck"] as const;
/** 常去的地方手动加一处用的这一组（308 号票，两个都在才算有） */
export const NATIVE_PHONE_PLACE_METHODS = ["phonePlaceHere", "phonePlaceFind"] as const;

/** 读手机日历的授权：给没给、问没问过用户、这台设备给人看的名字 */
export interface NativeCalendarState {
  readonly granted: boolean;
  readonly asked: boolean;
  readonly device?: string;
}

/** 挑人的结果：挑好了（几个人、哪台设备）、取消了、出错了 */
export type NativeContactsPick = { ok: true; contacts: PhoneContact[]; device?: string } | { ok: false; reason: "cancelled" | "failed"; message?: string };

/** 读日历的结果：读到了（日程，时间换成了协议时间）、没授权、读不了 */
export type NativeCalendarRead = { ok: true; events: PhoneCalendarEvent[] } | { ok: false; state: "denied" | "unavailable"; message?: string };

/** 读相册的授权（300 号票）：读相册给没给、读照片位置给没给、问没问过、这台设备的名字 */
export interface NativePhotosState {
  readonly granted: boolean;
  readonly location: boolean;
  readonly asked: boolean;
  readonly device?: string;
}

/** 读照片的结果：读到了（时间换成了协议时间；location 是有没有读照片位置的授权）、没授权、读不了 */
export type NativePhotosRead = { ok: true; photos: PhonePhoto[]; location: boolean } | { ok: false; state: "denied" | "unavailable"; message?: string };

/** 定位的授权和记的状况（300 号票）：给没给（precise 是精确位置也给了）、问没问过、在不在记、后台也记没有、这台设备的名字 */
export interface NativeLocationState {
  readonly granted: boolean;
  readonly precise: boolean;
  readonly asked: boolean;
  readonly recording: boolean;
  readonly background: boolean;
  /** 系统的位置开关关着（记不到；模拟器上默认关着） */
  readonly switchOff?: true;
  /** 系统能不能把坐标转成地名（308 号票；旧一点的 App 不报，没有） */
  readonly geocoder?: boolean;
  readonly device?: string;
}

/** 读手机上记下的点：读到了（时间换成了协议时间，按先后）、没授权、读不了 */
export type NativeLocationRead = { ok: true; points: PhoneLocationPoint[] } | { ok: false; state: "denied" | "unavailable"; message?: string };

/** 定位一次、按地名找的结果（308 号票）：找到了（经纬度、系统地名）、没有定位授权、没找到、读不了 */
export type NativePlaceFix = { ok: true; lat: number; lon: number; address?: PhoneAddress } | { ok: false; reason: "denied" | "not_found" | "unavailable"; message?: string };

/** 常去的地方手动加一处用的（308 号票） */
export interface NativePhonePlaces {
  /** 现在在哪（定一次位，转好地名） */
  here(): Promise<NativePlaceFix>;
  /** 按地名找（系统的地址转坐标） */
  find(text: string): Promise<NativePlaceFix>;
}

/** 照片的时间地点（300 号票） */
export interface NativePhonePhotos {
  /** App 回的不对是 undefined */
  state(): NativePhotosState | undefined;
  /** 要授权（系统的授权框，读相册、读照片位置一起要）；userAction 为真而用户拒过时拉起二次授权。回之后的状态 */
  prepare(userAction: boolean): Promise<NativePhotosState | undefined>;
  read(from: Date, to: Date): Promise<NativePhotosRead>;
}

/** 位置（300 号票） */
export interface NativePhoneLocation {
  /** App 回的不对是 undefined */
  state(): NativeLocationState | undefined;
  prepare(userAction: boolean): Promise<NativeLocationState | undefined>;
  /** 开始 / 停下记（停下时手机上没交出去的点一起删）；回之后的状态 */
  record(on: boolean, background: boolean): Promise<NativeLocationState | undefined>;
  read(): Promise<NativeLocationRead>;
  /** 交给守护进程了：删掉手机上 until 以前（含）的点 */
  ack(until: Date): void;
}

export interface NativePhone {
  pickContacts(): Promise<NativeContactsPick>;
  /** App 回的不对是 undefined */
  calendarState(): NativeCalendarState | undefined;
  /** 要授权（系统的授权框）；userAction 为真而用户拒过时拉起二次授权。回之后的状态 */
  prepareCalendar(userAction: boolean): Promise<NativeCalendarState | undefined>;
  readCalendar(from: Date, to: Date): Promise<NativeCalendarRead>;
  /** 照片的时间地点（300 号票）；旧一点的 App 没有 */
  readonly photos?: NativePhonePhotos;
  /** 位置（300 号票）；旧一点的 App 没有 */
  readonly location?: NativePhoneLocation;
  /** 常去的地方手动加一处用的（308 号票）；旧一点的 App 没有 */
  readonly places?: NativePhonePlaces;
}

type BridgeObject = Record<string, unknown>;

function parseObject(json: unknown): Record<string, unknown> | undefined {
  if (typeof json !== "string" || json === "") return undefined;
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** 一段字：去掉首尾空白、截到 max 个字；不是字或者空的是 undefined */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  return s === "" ? undefined : [...s].slice(0, max).join("");
}

/** 一组字（最多 count 个） */
function texts(value: unknown, max: number, count: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const s = text(v, max);
    return s === undefined ? [] : [s];
  }).slice(0, count);
}

/** App 回的授权状态（{"granted", "asked", "device"?}）；不对是 undefined */
export function parseCalendarState(json: unknown): NativeCalendarState | undefined {
  const o = parseObject(json);
  if (!o || typeof o.granted !== "boolean" || typeof o.asked !== "boolean") return undefined;
  const device = text(o.device, 60);
  return { granted: o.granted, asked: o.asked, ...(device === undefined ? {} : { device }) };
}

/** App 回的挑人结果；不对当出错 */
export function parseContactsPick(json: unknown): NativeContactsPick {
  const o = parseObject(json);
  if (!o) return { ok: false, reason: "failed" };
  if (o.ok !== true) {
    const message = text(o.message, 200);
    return { ok: false, reason: o.reason === "cancelled" ? "cancelled" : "failed", ...(message === undefined ? {} : { message }) };
  }
  const contacts = (Array.isArray(o.contacts) ? o.contacts : []).flatMap((raw): PhoneContact[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const c = raw as Record<string, unknown>;
    const name = text(c.name, 60);
    if (name === undefined) return [];
    const birthday = text(c.birthday, 40);
    return [{ name, phones: texts(c.phones, 40, 5), ...(birthday === undefined ? {} : { birthday }), addresses: texts(c.addresses, 200, 3) }];
  });
  if (contacts.length === 0) return { ok: false, reason: "cancelled" };
  const device = text(o.device, 60);
  return { ok: true, contacts: contacts.slice(0, PHONE_CONTACTS_MAX), ...(device === undefined ? {} : { device }) };
}

const validMs = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** App 回的读日历结果：时间（毫秒）换成协议时间；不对的那一条跳过，整个不对当读不了 */
export function parseCalendarRead(json: unknown): NativeCalendarRead {
  const o = parseObject(json);
  if (!o) return { ok: false, state: "unavailable" };
  if (o.ok !== true) {
    const message = text(o.message, 300);
    return { ok: false, state: o.state === "denied" ? "denied" : "unavailable", ...(message === undefined ? {} : { message }) };
  }
  const events = (Array.isArray(o.events) ? o.events : []).flatMap((raw): PhoneCalendarEvent[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const e = raw as Record<string, unknown>;
    const key = text(e.key, 200);
    if (key === undefined || !validMs(e.start)) return [];
    const location = text(e.location, 300);
    const calendar = text(e.calendar, 100);
    return [
      {
        key,
        title: text(e.title, 300) ?? "",
        start: nowIso(new Date(e.start)),
        ...(validMs(e.end) && e.end >= e.start ? { end: nowIso(new Date(e.end)) } : {}),
        allDay: e.allDay === true,
        ...(location === undefined ? {} : { location }),
        ...(calendar === undefined ? {} : { calendar }),
      },
    ];
  });
  return { ok: true, events: events.slice(0, PHONE_CALENDAR_EVENTS_MAX) };
}

/** App 回的读相册授权（{"granted", "location", "asked", "device"?}）；不对是 undefined */
export function parsePhotosState(json: unknown): NativePhotosState | undefined {
  const o = parseObject(json);
  if (!o || typeof o.granted !== "boolean" || typeof o.asked !== "boolean") return undefined;
  const device = text(o.device, 60);
  return { granted: o.granted, location: o.location === true, asked: o.asked, ...(device === undefined ? {} : { device }) };
}

const latitude = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= -90 && v <= 90;
const longitude = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= -180 && v <= 180;
/** 经纬度都对才算有地点；正好 (0, 0) 当没有地点（读不到位置时有的写成 0） */
function placeOf(lat: unknown, lon: unknown): { lat: number; lon: number } | undefined {
  if (!latitude(lat) || !longitude(lon) || (lat === 0 && lon === 0)) return undefined;
  return { lat, lon };
}

/** App 交来的系统地名（308 号票）：每段截到上限，空的去掉；一段都没有是 undefined */
export function parseAddress(value: unknown): PhoneAddress | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const out: { spot?: string; district?: string; city?: string } = {};
  for (const key of ["spot", "district", "city"] as const) {
    const part = text(o[key], PHONE_ADDRESS_PART_MAX);
    if (part !== undefined) out[key] = part;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** App 回的读照片结果：时间（毫秒）换成协议时间；没 key、没时间的跳过，经纬度不对的当没有地点（地名跟着地点走）；整个不对当读不了 */
export function parsePhotosRead(json: unknown): NativePhotosRead {
  const o = parseObject(json);
  if (!o) return { ok: false, state: "unavailable" };
  if (o.ok !== true) {
    const message = text(o.message, 300);
    return { ok: false, state: o.state === "denied" ? "denied" : "unavailable", ...(message === undefined ? {} : { message }) };
  }
  const location = o.location === true;
  const photos = (Array.isArray(o.photos) ? o.photos : []).flatMap((raw): PhonePhoto[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const p = raw as Record<string, unknown>;
    const key = text(p.key, 300);
    if (key === undefined || !validMs(p.takenAt)) return [];
    const place = location ? placeOf(p.lat, p.lon) : undefined;
    const address = place ? parseAddress(p.address) : undefined;
    return [{ key, takenAt: nowIso(new Date(p.takenAt)), ...place, ...(address === undefined ? {} : { address }) }];
  });
  return { ok: true, location, photos: photos.slice(0, PHONE_PHOTOS_MAX) };
}

/** App 回的定位授权和记的状况；不对是 undefined */
export function parseLocationState(json: unknown): NativeLocationState | undefined {
  const o = parseObject(json);
  if (!o || typeof o.granted !== "boolean" || typeof o.asked !== "boolean") return undefined;
  const device = text(o.device, 60);
  return {
    granted: o.granted,
    precise: o.precise === true,
    asked: o.asked,
    recording: o.recording === true,
    background: o.background === true,
    ...(o.switchOff === true ? { switchOff: true as const } : {}),
    ...(typeof o.geocoder === "boolean" ? { geocoder: o.geocoder } : {}),
    ...(device === undefined ? {} : { device }),
  };
}

/** App 回的记下的点：时间（毫秒）换成协议时间，按先后；时间、经纬度不对的跳过；整个不对当读不了 */
export function parseLocationRead(json: unknown): NativeLocationRead {
  const o = parseObject(json);
  if (!o) return { ok: false, state: "unavailable" };
  if (o.ok !== true) {
    const message = text(o.message, 300);
    return { ok: false, state: o.state === "denied" ? "denied" : "unavailable", ...(message === undefined ? {} : { message }) };
  }
  const points = (Array.isArray(o.points) ? o.points : [])
    .flatMap((raw): Array<{ ms: number; point: PhoneLocationPoint }> => {
      if (typeof raw !== "object" || raw === null) return [];
      const p = raw as Record<string, unknown>;
      const place = placeOf(p.lat, p.lon);
      if (!validMs(p.at) || !place) return [];
      const accuracy = typeof p.accuracy === "number" && Number.isFinite(p.accuracy) && p.accuracy >= 0 ? Math.min(p.accuracy, 100_000) : undefined;
      const address = parseAddress(p.address);
      return [{ ms: p.at, point: { at: nowIso(new Date(p.at)), ...place, ...(accuracy === undefined ? {} : { accuracy }), ...(address === undefined ? {} : { address }) } }];
    })
    .toSorted((a, b) => a.ms - b.ms)
    .slice(0, PHONE_LOCATION_POINTS_MAX)
    .map((p) => p.point);
  return { ok: true, points };
}

/** App 回的定位一次、按地名找的结果（308 号票）；不对当读不了 */
export function parsePlaceFix(json: unknown): NativePlaceFix {
  const o = parseObject(json);
  if (!o) return { ok: false, reason: "unavailable" };
  if (o.ok !== true) {
    const message = text(o.message, 300);
    const reason = o.state === "denied" ? "denied" : o.state === "not_found" ? "not_found" : "unavailable";
    return { ok: false, reason, ...(message === undefined ? {} : { message }) };
  }
  const place = placeOf(o.lat, o.lon);
  if (!place) return { ok: false, reason: "unavailable" };
  const address = parseAddress(o.address);
  return { ok: true, ...place, ...(address === undefined ? {} : { address }) };
}

/** 调一个回 Promise<string> 的方法；没有、出错、回的不是字都当空串 */
async function callAsync(bridge: BridgeObject, method: string, ...args: (string | boolean)[]): Promise<string> {
  const fn = bridge[method];
  if (typeof fn !== "function") return "";
  try {
    const result: unknown = await (fn.apply(bridge, args) as unknown);
    return typeof result === "string" ? result : "";
  } catch {
    return "";
  }
}

/** 调一个直接回字的方法；没有、出错、回的不是字都当空串 */
function callSync(bridge: BridgeObject, method: string, ...args: string[]): string {
  const fn = bridge[method];
  if (typeof fn !== "function") return "";
  try {
    const result: unknown = fn.apply(bridge, args);
    return typeof result === "string" ? result : "";
  } catch {
    return "";
  }
}

/** 照片的时间地点这一组（300 号票）都在时包装起来 */
function wrapPhotos(bridge: BridgeObject): NativePhonePhotos | undefined {
  if (!NATIVE_PHONE_PHOTOS_METHODS.every((m) => typeof bridge[m] === "function")) return undefined;
  return {
    state: () => parsePhotosState(callSync(bridge, "phonePhotosState")),
    prepare: async (userAction) => parsePhotosState(await callAsync(bridge, "phonePhotosPrepare", userAction)),
    read: async (from, to) => parsePhotosRead(await callAsync(bridge, "phonePhotosRead", String(from.getTime()), String(to.getTime()))),
  };
}

/** 位置这一组（300 号票）都在时包装起来 */
function wrapLocation(bridge: BridgeObject): NativePhoneLocation | undefined {
  if (!NATIVE_PHONE_LOCATION_METHODS.every((m) => typeof bridge[m] === "function")) return undefined;
  return {
    state: () => parseLocationState(callSync(bridge, "phoneLocationState")),
    prepare: async (userAction) => parseLocationState(await callAsync(bridge, "phoneLocationPrepare", userAction)),
    record: async (on, background) => parseLocationState(await callAsync(bridge, "phoneLocationRecord", on, background)),
    read: async () => parseLocationRead(await callAsync(bridge, "phoneLocationRead")),
    ack: (until) => void callSync(bridge, "phoneLocationAck", String(until.getTime())),
  };
}

/** 常去的地方这一组（308 号票）都在时包装起来 */
function wrapPlaces(bridge: BridgeObject): NativePhonePlaces | undefined {
  if (!NATIVE_PHONE_PLACE_METHODS.every((m) => typeof bridge[m] === "function")) return undefined;
  return {
    here: async () => parsePlaceFix(await callAsync(bridge, "phonePlaceHere")),
    find: async (query) => parsePlaceFix(await callAsync(bridge, "phonePlaceFind", query)),
  };
}

/** 原生桥上有手机这一组方法（新版 App）时包装起来；没有是 undefined。照片、位置、常去的地方几组另外认（旧一点的 App 没有） */
export function wrapNativePhone(bridge: BridgeObject): NativePhone | undefined {
  if (!NATIVE_PHONE_METHODS.every((m) => typeof bridge[m] === "function")) return undefined;
  const photos = wrapPhotos(bridge);
  const location = wrapLocation(bridge);
  const places = wrapPlaces(bridge);
  return {
    pickContacts: async () => parseContactsPick(await callAsync(bridge, "phoneContactsPick")),
    calendarState() {
      try {
        return parseCalendarState((bridge.phoneCalendarState as () => unknown).call(bridge));
      } catch {
        return undefined;
      }
    },
    prepareCalendar: async (userAction) => parseCalendarState(await callAsync(bridge, "phoneCalendarPrepare", userAction)),
    readCalendar: async (from, to) => parseCalendarRead(await callAsync(bridge, "phoneCalendarRead", String(from.getTime()), String(to.getTime()))),
    ...(photos ? { photos } : {}),
    ...(location ? { location } : {}),
    ...(places ? { places } : {}),
  };
}
