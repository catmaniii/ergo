// "手机"插件的事件（299 号票）：守护进程内部的频道 phone（不是前端协议的频道，前端订阅不了；数据源页、日历经 HTTP 取）。
// - phone_contact_picked：用户在手机上的二狗 App 里从通讯录挑的一个人（规范化过的称呼、电话、生日、地址），交给了档案候选；
//   数据源"手机 · 通讯录选人"拥有它（断开并删已导入的时整条换成标记）；
// - phone_calendar_event：手机日历的一条日程变了——put（新的、改了的，带整条）、remove（范围里没了）。增量记，现在的样子按先后归并；
//   数据源"手机 · 日历"拥有它；
// - phone_calendar_status：手机日历连没连着、授权怎么样（给了、拒了、撤回了、读不了和原因）、哪台设备交的。数据源页的连接状态按最后一条。
// 都不进记忆素材（issue 25：日历只给日历插件显示；通讯录挑的人只进档案候选，号码、住址本来就不进整理）。
// 300 号票（照片的时间地点、位置）：
// - phone_photos_day / phone_location_day：一天的照片、位置整理成的一条摘要（插件按天整理好再写，原始的时间地点、坐标点在插件自己的
//   存储里，见 raw-store.ts）；数据源"手机 · 照片的时间地点""手机 · 位置"各自拥有，采成素材（观察到的本人行为）。一天正常一条，
//   整理之后又交来那天的（比如后来存进相册的照片）再补一条（part 2、3……）；
// - phone_photos_status / phone_location_status：连没连着、授权怎么样、哪台设备交的（照片另记有没有读照片位置的授权，位置另记后台也记没有），
//   同 phone_calendar_status。
import { isDeletedEventPayload, type PhoneCalendarEvent, type PhoneCalendarState, type PhoneContact, type PhoneDeviceState } from "@ergo/protocol";
import type { EventStore } from "../events/event-store.ts";

/** 守护进程内部的频道 */
export const PHONE_CHANNEL = "phone";
export const PHONE_CONTACT_PICKED = "phone_contact_picked";
export const PHONE_CALENDAR_EVENT = "phone_calendar_event";
export const PHONE_CALENDAR_STATUS = "phone_calendar_status";
export const PHONE_PHOTOS_DAY = "phone_photos_day";
export const PHONE_PHOTOS_STATUS = "phone_photos_status";
export const PHONE_LOCATION_DAY = "phone_location_day";
export const PHONE_LOCATION_STATUS = "phone_location_status";

export interface PhoneContactPickedPayload {
  id: string;
  at: string;
  device?: string;
  contact: PhoneContact;
}

export type PhoneCalendarEventPayload = { op: "put"; key: string; event: PhoneCalendarEvent; device?: string } | { op: "remove"; key: string };

export interface PhoneCalendarStatusPayload {
  at: string;
  /** 连着（用户在 App 里点了"连上手机日历"，还没在数据源页断开） */
  linked: boolean;
  device?: string;
  /** 连着时最后一次交来的授权状况 */
  state?: PhoneCalendarState;
  /** 没授权、撤回了、读不了时 App 交来的原因 */
  reason?: string;
}

/**
 * 一天的照片或位置整理成的一条摘要（300 号票）：插件写好的摘要（给模型、给检索的中文）、地点（场景里的，经纬度一带）、
 * 从几点到几点、整理了几条原始数据。彻底删除时 text 换成标记、地点去掉
 */
export interface PhoneDaySummaryPayload {
  /** 记录编号：pp-<日期>-<第几份>（照片）、pl-<日期>-<第几份>（位置） */
  id: string;
  /** 哪一天（本地日期 YYYY-MM-DD） */
  date: string;
  /** 第几份：1 是这一天的摘要，2 起是整理之后又交来的那天的（补的） */
  part: number;
  /** 这一份里最早、最晚的时间（协议时间） */
  at: string;
  end: string;
  text: string;
  /** 场景里的地点（照片按时段写、位置按待得久的写；没有地点的没有） */
  place?: string;
  /** 整理了几条原始数据（几张照片、几个位置点） */
  count: number;
  device?: string;
}

/** 照片、位置连没连着（300 号票，同 phone_calendar_status）：location 是有没有读照片位置的授权，background 是 App 在后台也记没有 */
export interface PhoneMediaStatusPayload {
  at: string;
  linked: boolean;
  device?: string;
  state?: PhoneDeviceState;
  reason?: string;
  location?: boolean;
  background?: boolean;
}

/** 还在的（没被换成"已删除"标记的）某一类事件的负载，按先后 */
export function livePayloads<T>(store: Pick<EventStore, "read">, type: string): T[] {
  return store
    .read(PHONE_CHANNEL, 0, type)
    .filter((e) => !isDeletedEventPayload(e.payload))
    .map((e) => e.payload as T);
}

/** 手机日历现在的样子：key → 日程（按增量归并） */
export function currentCalendar(store: Pick<EventStore, "read">): Map<string, { event: PhoneCalendarEvent; device?: string }> {
  const now = new Map<string, { event: PhoneCalendarEvent; device?: string }>();
  for (const p of livePayloads<PhoneCalendarEventPayload>(store, PHONE_CALENDAR_EVENT)) {
    if (p.op === "put") now.set(p.key, { event: p.event, ...(p.device === undefined ? {} : { device: p.device }) });
    else now.delete(p.key);
  }
  return now;
}

/** 手机日历最后的状况（没有过是没连着） */
export function calendarStatus(store: Pick<EventStore, "read">): PhoneCalendarStatusPayload | undefined {
  return livePayloads<PhoneCalendarStatusPayload>(store, PHONE_CALENDAR_STATUS).at(-1);
}

/** 照片、位置最后的状况（300 号票；没有过是没连着） */
export function mediaStatus(store: Pick<EventStore, "read">, type: typeof PHONE_PHOTOS_STATUS | typeof PHONE_LOCATION_STATUS): PhoneMediaStatusPayload | undefined {
  return livePayloads<PhoneMediaStatusPayload>(store, type).at(-1);
}
