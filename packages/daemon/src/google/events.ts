// Google 插件自己的事件（297 号票）：守护进程内部的频道 google（前端不订阅；日历页经日历插件按月取，数据源页经 HTTP 取）。
// - google_calendar_feed：订阅的一个日历——它的 id（私密地址的哈希，不是地址本身）、用户起的名字、日历自己的名字（X-WR-CALNAME）
//   和默认时区（X-WR-TIMEZONE）；removed 是用户在设置里删掉了这个日历；
// - google_calendar_item：一个日历里的一个 VEVENT（ical.ts 解析后的样子，改期的那一次单独一条）——同步时和现在的比，只写新的、变了的、
//   没了的（removed）；同一个事件按最后一版算。删掉一个日历时它的每一个事件各写一条 removed，再写日历的 removed。
// 私密地址只在密钥区（data-sources/secrets.ts），这里一个都不写。这些事件不采成素材（日历的事件给日历插件显示，issue 25 第 3 节）。
// 数据源断开并删、移除插件连数据删时整条换成"已删除"标记（数据源的 records、插件的 removal.declare）。
// 298 号票（Gmail）加了两类，只在开了"导入我发出的邮件"时写（按需查现查不存，什么都不写）：
// - google_gmail_sent：导入的一封你发出的邮件——它在"已发邮件"里的编号（UIDVALIDITY 和 UID）、Message-ID、发出的时间、主题、收件人的称呼、
//   主题加去掉了引用原文的正文；采成"本人写的"素材（plugin.ts 的采集规则），彻底删除时主题、正文、收件人换掉；
// - google_gmail_cursor：导到哪了（没正文的、早就导过的跳过时，"已发邮件"里的编号照样往前挪），只在最后几封都跳过时写一条。
// Gmail 地址和应用专用密码只在密钥区，这里一个都不写。
import { isDeletedEventPayload } from "@ergo/protocol";
import type { SensitiveCategory } from "../config/config.ts";
import type { StoredEvent } from "../events/event-store.ts";
import type { IcalEvent } from "./ical.ts";

/** 守护进程内部的频道 */
export const GOOGLE_CHANNEL = "google";
export const GOOGLE_CALENDAR_FEED = "google_calendar_feed";
export const GOOGLE_CALENDAR_ITEM = "google_calendar_item";
export const GOOGLE_GMAIL_SENT = "google_gmail_sent";
export const GOOGLE_GMAIL_CURSOR = "google_gmail_cursor";

/** 导入的一封你发出的邮件 */
export interface GoogleGmailSentPayload {
  /** 在"已发邮件"里的编号：UIDVALIDITY-UID */
  id: string;
  uidValidity: number;
  uid: number;
  messageId?: string;
  /** 发出的时间（带时区偏移的 ISO） */
  at: string;
  subject: string;
  /** 收件人、抄送的称呼（没有名字的写邮箱） */
  to: string[];
  /** 主题加正文（引用的别人的原文去掉了）：素材的原文 */
  text: string;
  /** 正文太长截掉了后面 */
  truncated?: true;
  /** 这封落在哪些敏感类别（gmail-sensitive.ts 按关键词写窄，判不准的不标；旧的没有这一项按不涉及） */
  sensitive?: SensitiveCategory[];
}

/** 导到哪了 */
export interface GoogleGmailCursorPayload {
  uidValidity: number;
  uid: number;
  at: string;
}

export interface GoogleCalendarFeedPayload {
  feed: string;
  at: string;
  /** 用户起的名字（设置里填的，"工作"） */
  label?: string;
  /** 日历自己的名字（X-WR-CALNAME；Google 的主日历是邮箱） */
  name?: string;
  /** 日历的默认时区（X-WR-TIMEZONE） */
  timeZone?: string;
  removed?: true;
}

export interface GoogleCalendarItemPayload {
  feed: string;
  /** 事件在这个日历里的键（ical.ts 的 eventKey） */
  key: string;
  at: string;
  /** 这一版（removed 的没有） */
  event?: IcalEvent;
  removed?: true;
}

/** 折出来的一个日历 */
export interface FeedState {
  readonly id: string;
  readonly label?: string;
  readonly name?: string;
  readonly timeZone?: string;
  /** 键 → 最后一版 */
  readonly items: ReadonlyMap<string, IcalEvent>;
}

/** 按先后折出现在的几个日历和它们的事件（删掉了的日历不在里面；"已删除"标记跳过） */
export function foldCalendars(events: readonly StoredEvent[]): Map<string, FeedState> {
  const feeds = new Map<string, { id: string; label?: string; name?: string; timeZone?: string; items: Map<string, IcalEvent> }>();
  for (const e of events) {
    if (isDeletedEventPayload(e.payload)) continue;
    if (e.type === GOOGLE_CALENDAR_FEED) {
      const p = e.payload as GoogleCalendarFeedPayload;
      if (p.removed) {
        feeds.delete(p.feed);
        continue;
      }
      const items = feeds.get(p.feed)?.items ?? new Map<string, IcalEvent>();
      feeds.set(p.feed, { id: p.feed, ...(p.label === undefined ? {} : { label: p.label }), ...(p.name === undefined ? {} : { name: p.name }), ...(p.timeZone === undefined ? {} : { timeZone: p.timeZone }), items });
    } else if (e.type === GOOGLE_CALENDAR_ITEM) {
      const p = e.payload as GoogleCalendarItemPayload;
      const feed = feeds.get(p.feed) ?? { id: p.feed, items: new Map<string, IcalEvent>() };
      feeds.set(p.feed, feed);
      if (p.removed || !p.event) feed.items.delete(p.key);
      else feed.items.set(p.key, p.event);
    }
  }
  return feeds;
}
