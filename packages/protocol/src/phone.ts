// 手机上的二狗 App 读本机（299 号票，issue 25 生活数据源；调研 docs/research/36、39）：守护进程的"手机"插件登记的数据源、
// App 交来的东西的上限。交来的样子（TypeBox）在 phone-schema.ts。不引用 TypeBox。
// - 通讯录选人（phone-contacts）：App 拉起系统的选人界面（不用权限、不批量读整个通讯录），用户挑的人的称呼、电话、生日、地址经网页交给
//   守护进程，进个人档案的候选核对卡（逐条确认才写，号码逐位核对）；不进记忆素材；
// - 手机日历（phone-calendar）：弹窗授权后 App 只读手机日历里的日程，App 开着时每隔一会儿交一次，日历插件当外部日历显示
//   （标出来自手机）；不进记忆素材；授权被撤回时 App 交来原因，数据源页写明。
// 300 号票：同一个插件的下两个数据源——
// - 照片的时间地点（phone-photos）：弹窗授权后 App 只读相册里照片的拍摄时间和地点（不传照片本身），App 开着时交最近几天拍的，
//   守护进程按天整理成一条摘要进素材（观察到的本人行为，地点放场景）；
// - 位置（phone-location）：弹窗授权后 App 定时记位置（App 开着时；打开"后台也记"时 App 在后台靠位置类的长时任务接着记），
//   App 开着时把记下的点交过来；守护进程把原始坐标点存在插件自己的存储里（能按天清掉），按天整理成"去过哪、待了多久"一条摘要进素材。
//   位置只能从开始记的那一刻起有，拿不到以前的（docs/research/39）。

/** 通讯录选人这个数据源的 id */
export const PHONE_CONTACTS_SOURCE = "phone-contacts";
/** 手机日历这个数据源的 id */
export const PHONE_CALENDAR_SOURCE = "phone-calendar";

/** 照片的时间地点这个数据源的 id（300 号票） */
export const PHONE_PHOTOS_SOURCE = "phone-photos";
/** 位置这个数据源的 id（300 号票） */
export const PHONE_LOCATION_SOURCE = "phone-location";

/** 一次最多交几个联系人（系统选人界面多选的） */
export const PHONE_CONTACTS_MAX = 20;
/** 一次同步最多交几条日程（重复的每一次算一条；守护进程收的请求最多 1 MB） */
export const PHONE_CALENDAR_EVENTS_MAX = 2000;

/** App 开着时多久同步一次手机日历（毫秒）：打开、回到前台时也同步一次 */
export const PHONE_CALENDAR_SYNC_EVERY_MS = 30 * 60_000;
/** 同步手机日历的范围：从上个月一号起往后几个月（往前的不再改） */
export const PHONE_CALENDAR_MONTHS_AHEAD = 6;

/** 一次最多交几张照片的时间地点（守护进程收的请求最多 1 MB；一张不到 150 字节） */
export const PHONE_PHOTOS_MAX = 3000;
/** 一次最多交几个位置点（App 一次交不完的下次接着交） */
export const PHONE_LOCATION_POINTS_MAX = 3000;
/** 照片读最近几天拍的（第一次连上、平常都是）；上次同步更早时往前读到上次同步的前一天，最多 PHONE_PHOTOS_MAX_DAYS 天 */
export const PHONE_PHOTOS_DAYS = 7;
export const PHONE_PHOTOS_MAX_DAYS = 30;
/**
 * 位置多久记一个点（秒，交给鸿蒙的持续定位 ContinuousLocationRequest.interval，场景是低功耗）：App 开着时 5 分钟；
 * 打开"后台也记"、App 在后台时 10 分钟（长时任务一直开着，间隔放长省电）
 */
export const PHONE_LOCATION_INTERVAL_S = 300;
export const PHONE_LOCATION_BACKGROUND_INTERVAL_S = 600;
/** App 里没交出去的位置点最多留几天（手机上的缓冲，交给守护进程后就删） */
export const PHONE_LOCATION_BUFFER_DAYS = 7;

/** 手机日历的授权：给了、没给（用户拒了）、撤回了（以前给过）、读不了（设备没有日历、出错） */
export const PHONE_CALENDAR_STATES = ["granted", "denied", "revoked", "unavailable"] as const;
export type PhoneCalendarState = (typeof PHONE_CALENDAR_STATES)[number];
/** 照片、位置的授权（300 号票）：同手机日历的四种 */
export type PhoneDeviceState = PhoneCalendarState;

/** 同步范围：从 now 所在月的上个月一号 0 点起，到往后 PHONE_CALENDAR_MONTHS_AHEAD 个月的一号 0 点（本地时间） */
export function phoneCalendarWindow(now: Date): { from: Date; to: Date } {
  return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth() + PHONE_CALENDAR_MONTHS_AHEAD + 1, 1) };
}

/**
 * 这次读哪段时间拍的照片（300 号票）：[from, to)，to 是现在往后一天（时钟稍有出入的也算上）；from 是 PHONE_PHOTOS_DAYS 天前，
 * 上次同步更早时往前挪到上次同步的前一天，最多 PHONE_PHOTOS_MAX_DAYS 天前。读重了不要紧，守护进程按照片认、只收一次
 */
export function phonePhotosWindow(now: Date, lastSyncAt?: string): { from: Date; to: Date } {
  const day = 24 * 60 * 60_000;
  const to = new Date(now.getTime() + day);
  const usual = now.getTime() - PHONE_PHOTOS_DAYS * day;
  const last = lastSyncAt === undefined ? Number.NaN : Date.parse(lastSyncAt);
  const from = Number.isNaN(last) ? usual : Math.max(now.getTime() - PHONE_PHOTOS_MAX_DAYS * day, Math.min(usual, last - day));
  return { from: new Date(from), to };
}

// 308 号票（手机位置和照片的地点变成地名；用户 2026-10-26 选了"系统转地名 + 常去地起名"）：
// - 系统转地名：App 原生层用鸿蒙的坐标转地址（geoLocationManager.getAddressesFromLocation，大概率走华为的地图服务，坐标会发给华为，
//   用户接受）把照片的拍摄地点、位置点转成地名（街道或地标、区县、城市），连同坐标一起交（PhoneAddress，phone-schema.ts）；转不了的只交坐标；
// - 常去的地方：数据源页"手机 · 位置"下面列出起了名的几处和按位置点聚出来、还没起名的常待的几处（PhonePlacesView，守护进程报在数据源的
//   panel 上），起名、改名、删、手动加一处经填设置（values.places）交给守护进程；摘要和场景里的地点按"起了名的 > 系统地名 > 坐标"写。

/** 系统地名里每一段（街道或地标、区县、城市）最多几个字 */
export const PHONE_ADDRESS_PART_MAX = 30;
/** 常去的地方：范围（半径，米）能选的几档，默认 200 米 */
export const PHONE_PLACE_RADII_M = [100, 200, 300, 500, 1000] as const;
export const PHONE_PLACE_RADIUS_DEFAULT_M = 200;
/** 常去的地方的名字最多几个字 */
export const PHONE_PLACE_NAME_MAX = 20;
/** 最多起名几处 */
export const PHONE_PLACES_MAX = 50;
/** 按位置点聚出来、还没起名的列几处（待过两次以上的） */
export const PHONE_PLACE_SUGGESTIONS_MAX = 6;
/** 按最近几天的原始位置点聚 */
export const PHONE_PLACE_DAYS = 30;

/** 起了名的一处（数据源页"常去的地方"） */
export interface PhonePlaceView {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** 范围（半径，米）：这里面的点和照片摘要里写名字 */
  radius: number;
  /** 系统地名（起名时知道的；没有的不写） */
  address?: string;
  /** 最近记到的位置点里在这儿待过几次 */
  visits: number;
}

/** 按位置点聚出来、还没起名的常待的一处 */
export interface PhonePlaceSuggestionView {
  /** 这一处的编号（中心坐标，起名时原样交回） */
  key: string;
  lat: number;
  lon: number;
  /** 给人看的：系统地名，没有的写坐标一带 */
  label: string;
  /** 系统地名（有的才有，起名时一起交回） */
  address?: string;
  /** 待过几次、分在几天 */
  visits: number;
  days: number;
}

/** 数据源"手机 · 位置"下面"常去的地方"那一块（DataSourceView.panel） */
export interface PhonePlacesView {
  kind: "phone-places";
  places: PhonePlaceView[];
  suggestions: PhonePlaceSuggestionView[];
  /** 按最近几天记到的位置点聚的（还没有点是 0） */
  days: number;
  /** 上一次起名、改名、删、加没做成的原因：给人看的 */
  refused?: string;
}

/**
 * 填设置时交给守护进程的（POST /api/data-sources/phone-location，action configure）：values.places 是做哪一样——
 * - add：起名、手动加一处（name；lat、lon：小数；radius：米，不给是默认；address：系统地名，有的才给）；
 * - rename：改名、改范围（id；name；radius 不给不动）；
 * - remove：删（id）。
 * 起名、改名后以前的摘要不重写，往后的用新名
 */
export const PHONE_PLACES_OPS = ["add", "rename", "remove"] as const;
export type PhonePlacesOp = (typeof PHONE_PLACES_OPS)[number];

const isPlainRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 数据源页交来的 panel 是不是"常去的地方"那一块（网页插件画之前认一下，认不出就不画） */
export function isPhonePlacesView(value: unknown): value is PhonePlacesView {
  return isPlainRecord(value) && value.kind === "phone-places" && Array.isArray(value.places) && Array.isArray(value.suggestions);
}

/**
 * 系统地名写成一段（308 号票）："杭州市西湖区北山街"——城市、区县、街道或地标接起来；后一段以前一段开头的（"杭州市" + "杭州市西湖区"）
 * 只留后一段，已经写进去的不重复。一段都没有是 undefined（守护进程写摘要、网页显示都用它）
 */
export function phoneAddressLabel(addr: { spot?: string; district?: string; city?: string } | undefined): string | undefined {
  if (!addr) return undefined;
  const parts: string[] = [];
  for (const raw of [addr.city, addr.district, addr.spot]) {
    const part = raw?.trim() ?? "";
    if (part === "") continue;
    const last = parts.at(-1);
    if (last !== undefined && part.startsWith(last)) parts[parts.length - 1] = part;
    else if (!parts.some((q) => q.includes(part))) parts.push(part);
  }
  return parts.length === 0 ? undefined : parts.join("");
}
