// "手机"插件的服务：收手机上的二狗 App 交来的（经内核的数据源 push，查过 schema），写插件自己的事件（events.ts）。
// - 通讯录选人：挑的几个人写成 phone_contact_picked，交给个人档案的候选（origin contacts：不用提到几次就上卡，电话、住址也收），
//   当场合成候选核对卡（还没处理的那张接着往里加），交回卡的编号让网页领着去核对；
// - 手机日历：连着（用户在 App 里点了"连上手机日历"）时收同步范围里的全部日程，和现在的样子比出增量（新、改、删）写成
//   phone_calendar_event；没授权、撤回了、读不了的记下状况和原因（数据源页写明）；日历插件按月取时给 [from, to) 里的日程。
//   授权给着却交来 0 条、范围里原来有不少条（PHONE_CALENDAR_HOLD_MIN）的，多半是手机那一下没读到（App 在后台、系统没给），
//   不删，记下这一段（phone_calendar_held，体检看它）；连着几次、或者隔了一天还是 0 条，在待办里问一次手机上是不是真的清空了，
//   用户选"清空了，删掉"才删。这一段里一直当没读到，手机又交来了日程就过去了（没回的那条记成作废）。少量的变化照常删。
// 数据源页的"共几条"：通讯录是挑过几个人（按记录数），日历是现在有几条日程（count）。
// 照片的时间地点、位置在 photos-location.ts（插件自己的存储、按天整理成摘要），这里合进同一个服务。
import { randomUUID } from "node:crypto";
import {
  formatList,
  inboxActionText,
  type NoticeType,
  PHONE_CALENDAR_EMPTY_ACTIONS,
  type PhoneCalendarEvent,
  type PhoneCalendarPush,
  type PhoneContact,
  type PhoneContactsPush,
  type PhoneContactsReply,
  PHONE_CONTACTS_SOURCE,
  t,
} from "@ergo/protocol";
import type { DataSourceCalendarEvent, DataSourcePushOutcome, DataSourceStatus, DataSourceStoredQuery, DataSourceStoredResult } from "../data-sources/api.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { CandidateInput, PersonalFilesForMemory } from "../personal-files/index.ts";
import { createPhoneMediaService, type PhoneMediaService } from "./photos-location.ts";
import {
  calendarHeld,
  calendarStatus,
  currentCalendar,
  livePayloads,
  PHONE_CALENDAR_EVENT,
  PHONE_CALENDAR_HELD,
  PHONE_CALENDAR_STATUS,
  PHONE_CHANNEL,
  PHONE_CONTACT_PICKED,
  type PhoneCalendarEventPayload,
  type PhoneCalendarHeld,
  type PhoneCalendarHeldPayload,
  type PhoneCalendarStatusPayload,
  type PhoneContactPickedPayload,
} from "./events.ts";

/** 同步范围里原来至少有这么多条、这次交来 0 条：当成手机这一下没读到，先不删（比这少的照常删） */
export const PHONE_CALENDAR_HOLD_MIN = 20;
/** 连着交来 0 条到这么多次，或者从头一次起过了这么久（至少交来两次）：在待办里问一次手机上是不是真的清空了 */
export const PHONE_CALENDAR_ASK_TIMES = 3;
export const PHONE_CALENDAR_ASK_AFTER_MS = 24 * 60 * 60_000;
/** 问用户的那种待办 */
export const PHONE_CALENDAR_EMPTY_NOTICE: NoticeType = "phone_calendar_empty";
/** 那条待办没回、这一段就过去了时系统替用户记的处理结果（按字认） */
const VOIDED = "已作废"; // @i18n-ignore fixed：事项的处理结果按字认

/** 一条日程的开始在不在 [from, to)（毫秒）里 */
const startsIn = (event: PhoneCalendarEvent, from: number, to: number) => {
  const start = Date.parse(event.start);
  return start >= from && start < to;
};

/**
 * 手机交来 0 条日程的那一段（体检读，414）：这一段头一次交来 0 条的时刻、连着几次、原来有几条；kept 是先留着没删（425 的做法），
 * 不是的是跟着删了
 */
export interface PhoneCalendarEmpty {
  since: string;
  times: number;
  count: number;
  kept: boolean;
}

/**
 * 交来 0 条、一下删了不少于这么多条，体检才提示（414）：日程本来就几条、真的删光了的不算。425 合并后同样的门槛是 PHONE_CALENDAR_HOLD_MIN
 * （不少于它的不再删，这里就记不到了），到时这一段记法可以去掉
 */
export const PHONE_CALENDAR_DROP_MIN = 20;

export interface PhoneServiceOptions {
  store: EventStore;
  now: () => string;
  /** 个人档案收候选、合成候选核对卡（内核的，KERNEL.personalFiles） */
  personalFiles: Pick<PersonalFilesForMemory, "addCandidates" | "composeCandidates">;
  /** 待办（内核的，KERNEL.inbox）：手机日历连着交来 0 条时问用户 */
  inbox: Pick<InboxService, "buildAdd" | "buildUpdate" | "get">;
  /** 日历插件在不在（不在时"手机 · 日历"写明同步来的日程暂时看不到） */
  calendarOn: () => boolean;
  /** 现在（毫秒，守护进程的时钟；照片、位置按它分"今天以前"） */
  nowMs: () => number;
  /** 数据目录（插件自己的存储在它下面的 phone/） */
  dataDir: string;
  log: (line: string) => void;
}

export interface PhoneService extends PhoneMediaService {
  /** 通讯录选人交来的几个人 */
  receiveContacts(push: PhoneContactsPush): DataSourcePushOutcome;
  /** 手机日历交来的（一次同步，或者授权的状况） */
  receiveCalendar(push: PhoneCalendarPush): DataSourcePushOutcome;
  /** "手机 · 日历"的连接状态 */
  calendarStatus(): DataSourceStatus;
  /** 日历插件按月取的：[from, to) 里的日程（没连着时没有） */
  calendarEvents(range: { from: Date; to: Date }): DataSourceCalendarEvent[];
  /** 现在有几条日程 */
  calendarCount(): number;
  /** 在数据源页断开了"手机 · 日历" */
  unlinkCalendar(): void;
  /** 手机交来 0 条、日程先留着没删的那一段（体检看它）；没有是 undefined */
  calendarHeld(): PhoneCalendarHeld | undefined;
  /** 用户在待办里回了手机上的日程是不是真的清空了：cleared 为真是清空了（删掉留着的），否则接着留着 */
  answerCalendarEmpty(itemId: string, cleared: boolean): void;
  /** 手机最近交来 0 条、一下删了不少日程的那一段（只在内存里，重启就没；手机又交来日程、断开了就过去了）：体检读（414） */
  calendarEmpty(): PhoneCalendarEmpty | undefined;
  /** 挑过的人（数据源详情的"已获取的"）：后挑的在前 */
  contactsStored(query: DataSourceStoredQuery): DataSourceStoredResult;
  /** 手机日历现在的日程（数据源详情的"已获取的"）：开始时间晚的在前 */
  calendarStored(query: DataSourceStoredQuery): DataSourceStoredResult;
}

/** 电话去掉空白、横线、括号（"138-0000 1111" 存成 "13800001111"）；+ 留着 */
// @i18n-ignore-next data：认通讯录里写的全角括号
const cleanPhone = (raw: string) => raw.replace(/[\s\-()（）]/g, "");

/** 通讯录里的生日：没有年份的写法（"--03-02"）去掉前面的横线，剩下的照抄（档案认得出"1962-03-02""03-02"） */
const cleanBirthday = (raw: string) => raw.trim().replace(/^-+/, "");

/** 规范化一个联系人：去掉首尾空白、空的、重复的 */
function cleanContact(c: PhoneContact): PhoneContact {
  const phones = [...new Set(c.phones.map(cleanPhone).filter((p) => p !== ""))];
  const addresses = [...new Set(c.addresses.map((a) => a.replace(/\s+/g, " ").trim()).filter((a) => a !== ""))];
  const birthday = c.birthday === undefined ? "" : cleanBirthday(c.birthday);
  return { name: c.name.trim(), phones, ...(birthday === "" ? {} : { birthday }), addresses };
}

/** 一条日程的协议时间认不认得出 */
const validTime = (iso: string) => !Number.isNaN(Date.parse(iso));

export function createPhoneService(options: PhoneServiceOptions): PhoneService {
  const { store, now, personalFiles, inbox, log } = options;
  /** 手机交来 0 条、一下删了不少的那一段（体检读；只在内存里） */
  let emptied: PhoneCalendarEmpty | undefined;
  /** 交来一次日历之后记一下：0 条、一下删了不少的开始一段，这一段里再交来 0 条接着数；交来了日程这一段就过去了 */
  const noteCalendarSize = (total: number, removed: number) => {
    if (total > 0) emptied = undefined;
    else if (emptied) emptied = { ...emptied, times: emptied.times + 1, count: emptied.count + removed };
    else if (removed >= PHONE_CALENDAR_DROP_MIN) emptied = { since: now(), times: 1, count: removed, kept: false };
  };

  const receiveContacts = (push: PhoneContactsPush): DataSourcePushOutcome => {
    const contacts = push.contacts.map(cleanContact).filter((c) => c.name !== "");
    if (contacts.length === 0) throw new RequestRejected("bad_params", t("phone.contacts.empty"));
    const at = now();
    store.appendBatch(
      contacts.map(
        (contact): NewEvent => ({
          channel: PHONE_CHANNEL,
          type: PHONE_CONTACT_PICKED,
          payload: { id: `pc-${randomUUID().slice(0, 8)}`, at, ...(push.device === undefined ? {} : { device: push.device }), contact } satisfies PhoneContactPickedPayload,
        }),
      ),
    );
    // 交给档案候选：电话取第一个（档案里一个人一个电话）、住址取第一个
    const inputs: CandidateInput[] = contacts.map((c) => ({
      name: c.name,
      materialIds: [],
      heard: [],
      fields: [
        ...(c.phones[0] === undefined ? [] : [{ field: "phone", value: c.phones[0] }]),
        ...(c.birthday === undefined ? [] : [{ field: "birthday", value: c.birthday }]),
        ...(c.addresses[0] === undefined ? [] : [{ field: "address", value: c.addresses[0] }]),
      ],
      dataSource: PHONE_CONTACTS_SOURCE,
    }));
    personalFiles.addCandidates("contacts", inputs);
    const cardId = personalFiles.composeCandidates();
    const names = contacts.map((c) => c.name);
    log(`手机：通讯录挑了 ${contacts.length} 个人，候选核对卡 ${cardId ?? "（没有要核对的）"}`);
    const reply: PhoneContactsReply = { names, ...(cardId === undefined ? {} : { cardId }) };
    return { added: contacts.length, summary: t("phone.contacts.synced", { count: contacts.length, names: formatList(names) }), reply };
  };

  const statusEvent = (status: Omit<PhoneCalendarStatusPayload, "at">): NewEvent => ({ channel: PHONE_CHANNEL, type: PHONE_CALENDAR_STATUS, payload: { at: now(), ...status } satisfies PhoneCalendarStatusPayload });
  const appendStatus = (status: Omit<PhoneCalendarStatusPayload, "at">) => store.append(statusEvent(status));
  const removeEvent = (key: string): NewEvent => ({ channel: PHONE_CHANNEL, type: PHONE_CALENDAR_EVENT, payload: { op: "remove", key } satisfies PhoneCalendarEventPayload });
  /** 交来 0 条先没删的这一段（不给是这一段过去了） */
  const heldEvent = (held?: PhoneCalendarHeld): NewEvent => ({ channel: PHONE_CHANNEL, type: PHONE_CALENDAR_HELD, payload: { at: now(), ...(held === undefined ? {} : { held }) } satisfies PhoneCalendarHeldPayload });

  /** 这一段过去了：记下；问用户的那条还没回的记成作废（再点旧按钮回 note） */
  const endHeld = (held: PhoneCalendarHeld, note: string): NewEvent[] => {
    const item = held.itemId === undefined ? undefined : inbox.get(held.itemId);
    const voided = item?.kind === "notice" && item.handled === undefined && !item.deleted ? [inbox.buildUpdate(item, { handled: VOIDED, handledAt: now(), handledNote: note, read: true }).event] : [];
    return [heldEvent(), ...voided];
  };

  /** 用户在待办里已经选了"清空了，删掉"（插件停着时选的，监听没收到：下一次交来时照删） */
  const confirmedCleared = (held: PhoneCalendarHeld | undefined): boolean => {
    const item = held?.itemId === undefined ? undefined : inbox.get(held.itemId);
    return item?.kind === "notice" && item.handled === PHONE_CALENDAR_EMPTY_ACTIONS.clear;
  };

  /**
   * 交来 0 条、范围里留着 count 条：先不删，记下这一段（连着第几次、从什么时候起）；连着 PHONE_CALENDAR_ASK_TIMES 次，或者
   * 从头一次起过了 PHONE_CALENDAR_ASK_AFTER_MS，在待办里问一次（一段只问一次）。events 是要一起写的（连接状况变了的那一条）
   */
  const holdEmpty = (window: { from: string; to: string }, count: number, events: NewEvent[]): DataSourcePushOutcome => {
    const at = now();
    const before = calendarHeld(store);
    const since = before?.since ?? at;
    const times = (before?.times ?? 0) + 1;
    let itemId = before?.itemId;
    if (itemId === undefined && (times >= PHONE_CALENDAR_ASK_TIMES || Date.parse(at) - Date.parse(since) >= PHONE_CALENDAR_ASK_AFTER_MS)) {
      const { clear, keep } = PHONE_CALENDAR_EMPTY_ACTIONS;
      const { item, event } = inbox.buildAdd({
        kind: "notice",
        notice: PHONE_CALENDAR_EMPTY_NOTICE,
        title: t("phone.calendar.empty.title"),
        body: t("phone.calendar.empty.body", { times, count, clear: inboxActionText(clear), keep: inboxActionText(keep) }),
        source: t("phone.calendar.title"),
        urgency: "non_blocking",
        actions: [clear, keep],
      });
      itemId = item.id;
      events.push(event);
    }
    events.push(heldEvent({ since, times, count, from: window.from, to: window.to, ...(itemId === undefined ? {} : { itemId }) }));
    store.appendBatch(events);
    log(`手机：手机日历交来 0 条，范围里原有 ${count} 条，当成这一下没读到、先不删（连着第 ${times} 次${itemId === before?.itemId ? "" : "，在待办里问了是不是真的清空了"}）`);
    return { added: 0, summary: t("phone.calendar.held", { count }) };
  };

  const receiveCalendar = (push: PhoneCalendarPush): DataSourcePushOutcome => {
    const status = calendarStatus(store);
    const linked = status?.linked === true;
    if (push.state !== "granted") {
      // 没连着时不收状况（App 里点"连上"却没给授权的，App 自己说）
      if (!linked) throw new RequestRejected("not_allowed", t("phone.calendar.notLinked"));
      const reason = push.reason?.trim() || undefined;
      if (status?.state !== push.state || status.reason !== reason) {
        appendStatus({ linked: true, ...(push.device === undefined ? (status?.device === undefined ? {} : { device: status.device }) : { device: push.device }), state: push.state, ...(reason === undefined ? {} : { reason }) });
      }
      log(`手机：手机日历读不了（${push.state}${reason === undefined ? "" : `：${reason}`}）`);
      return { added: 0, summary: t(`phone.calendar.lost.${push.state}`) };
    }
    if (!linked && push.link !== true) throw new RequestRejected("not_allowed", t("phone.calendar.notLinked"));
    if (!validTime(push.from) || !validTime(push.to)) throw new RequestRejected("bad_params", t("phone.calendar.badWindow"));
    const bad = push.events.find((e) => !validTime(e.start) || (e.end !== undefined && !validTime(e.end)));
    if (bad) throw new RequestRejected("bad_params", t("phone.calendar.badTime", { key: bad.key }));
    const from = Date.parse(push.from);
    const to = Date.parse(push.to);
    const current = currentCalendar(store);
    const incoming = new Map<string, PhoneCalendarEvent>(push.events.map((e) => [e.key, e]));
    const events: NewEvent[] = [];
    if (!linked || status?.state !== "granted" || (push.device !== undefined && status.device !== push.device)) {
      events.push(statusEvent({ linked: true, ...(push.device === undefined ? {} : { device: push.device }), state: "granted" }));
    }
    // 交来 0 条：范围里原来不少、或者已经在"先没删"的这一段里，当成这一下没读到；用户在待办里确认过清空了的照删
    const held = calendarHeld(store);
    const inWindow = [...current.values()].filter(({ event }) => startsIn(event, from, to)).length;
    if (incoming.size === 0 && (held !== undefined || inWindow >= PHONE_CALENDAR_HOLD_MIN) && !confirmedCleared(held)) {
      return holdEmpty({ from: push.from, to: push.to }, inWindow, events);
    }
    let added = 0;
    let changed = 0;
    let removed = 0;
    const put = (event: PhoneCalendarEvent): NewEvent => ({
      channel: PHONE_CHANNEL,
      type: PHONE_CALENDAR_EVENT,
      payload: { op: "put", key: event.key, event, ...(push.device === undefined ? {} : { device: push.device }) } satisfies PhoneCalendarEventPayload,
    });
    for (const event of incoming.values()) {
      const before = current.get(event.key);
      if (!before) {
        added += 1;
        events.push(put(event));
      } else if (JSON.stringify(before.event) !== JSON.stringify(event)) {
        changed += 1;
        events.push(put(event));
      }
    }
    // 范围里没交的：手机上删了
    for (const [key, { event }] of current) {
      if (incoming.has(key) || !startsIn(event, from, to)) continue;
      removed += 1;
      events.push(removeEvent(key));
    }
    // 先没删的那一段过去了：手机又交来了日程（或者用户确认过清空了）
    if (held !== undefined) events.push(...endHeld(held, t("phone.calendar.empty.voidedBack")));
    if (events.length > 0) store.appendBatch(events);
    if (held !== undefined) log(`手机：手机日历先前连着 ${held.times} 次交来 0 条、没删，这次交来 ${incoming.size} 条，接着照常同步`);
    noteCalendarSize(incoming.size, removed);
    log(`手机：手机日历交来 ${incoming.size} 条（新 ${added}、改 ${changed}、删 ${removed}）`);
    return { added: added + changed, summary: t("phone.calendar.synced", { total: incoming.size, added, changed, removed }) };
  };

  return {
    ...createPhoneMediaService({ store, nowMs: options.nowMs, dataDir: options.dataDir, log }),
    receiveContacts,
    receiveCalendar,
    calendarStatus() {
      const status = calendarStatus(store);
      if (!status?.linked) return { connection: "not_connected" };
      const account = status.device === undefined ? {} : { account: status.device };
      if (status.state !== undefined && status.state !== "granted") {
        const reason = status.reason === undefined ? "" : t("phone.calendar.reason", { reason: status.reason });
        return { connection: "error", problem: t(`phone.calendar.problem.${status.state}`, { reason }), ...account, ...(status.state === "unavailable" ? {} : { needsAuth: true }) };
      }
      if (!options.calendarOn()) return { connection: "error", problem: t("phone.calendar.calendarOff"), ...account };
      return { connection: "connected", ...account };
    },
    calendarEvents({ from, to }) {
      if (!calendarStatus(store)?.linked) return [];
      const fromMs = from.getTime();
      const toMs = to.getTime();
      const out: DataSourceCalendarEvent[] = [];
      for (const { event } of currentCalendar(store).values()) {
        const start = Date.parse(event.start);
        const end = event.end === undefined ? start : Date.parse(event.end);
        // 和 [from, to) 有交叠（一个时刻的看开始在不在里面）
        if (!(start < toMs && (end > fromMs || (end === start && start >= fromMs)))) continue;
        out.push({
          id: event.key,
          title: event.title,
          at: event.start,
          ...(event.end === undefined ? {} : { end: event.end }),
          allDay: event.allDay,
          ...(event.location === undefined || event.location === "" ? {} : { location: event.location }),
          ...(event.calendar === undefined || event.calendar === "" ? {} : { calendar: event.calendar }),
        });
      }
      return out;
    },
    calendarCount: () => currentCalendar(store).size,
    contactsStored(query) {
      const picked = livePayloads<PhoneContactPickedPayload>(store, PHONE_CONTACT_PICKED).toReversed();
      const items = picked.slice(query.offset, query.offset + query.limit).map(({ id, at, contact }) => {
        const subtitle = [...contact.phones, ...(contact.birthday === undefined ? [] : [contact.birthday]), ...contact.addresses].join(" · ");
        return { id, title: contact.name, ...(subtitle === "" ? {} : { subtitle }), time: at };
      });
      return { total: picked.length, items };
    },
    calendarStored(query) {
      const events = [...currentCalendar(store).values()].map(({ event }) => event).toSorted((a, b) => Date.parse(b.start) - Date.parse(a.start));
      const items = events.slice(query.offset, query.offset + query.limit).map((event) => {
        const subtitle = [event.calendar, event.location].filter((s) => s !== undefined && s !== "").join(" · ");
        return {
          id: event.key,
          title: event.title,
          ...(subtitle === "" ? {} : { subtitle }),
          time: event.start,
          ...(event.allDay ? { allDay: true as const } : event.end === undefined ? {} : { end: event.end }),
        };
      });
      return { total: events.length, items };
    },
    unlinkCalendar() {
      emptied = undefined;
      const events: NewEvent[] = [];
      if (calendarStatus(store)?.linked) events.push(statusEvent({ linked: false }));
      const held = calendarHeld(store);
      if (held !== undefined) events.push(...endHeld(held, t("phone.calendar.empty.voidedUnlinked")));
      if (events.length > 0) store.appendBatch(events);
    },
    calendarHeld: () => calendarHeld(store),
    answerCalendarEmpty(itemId, cleared) {
      const held = calendarHeld(store);
      // 这一段已经过去了（手机又交来了、断开了）：那条已经作废，不再动
      if (held === undefined || held.itemId !== itemId) return;
      if (!cleared) {
        log(`手机：用户说手机上的日程没清空，先前的 ${held.count} 条接着留着，等手机下次读到`);
        return;
      }
      const from = Date.parse(held.from);
      const to = Date.parse(held.to);
      const removes = [...currentCalendar(store)].filter(([, { event }]) => startsIn(event, from, to)).map(([key]) => removeEvent(key));
      store.appendBatch([...removes, heldEvent()]);
      log(`手机：用户确认手机上的日程清空了，删掉 ${removes.length} 条`);
    },
    calendarEmpty: () => emptied,
  };
}
