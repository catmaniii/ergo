// "手机"插件的服务（299 号票）：收手机上的二狗 App 交来的（经内核的数据源 push，查过 schema），写插件自己的事件（events.ts）。
// - 通讯录选人：挑的几个人写成 phone_contact_picked，交给个人档案的候选（origin contacts：不用提到几次就上卡，电话、住址也收），
//   当场合成候选核对卡（还没处理的那张接着往里加），交回卡的编号让网页领着去核对；
// - 手机日历：连着（用户在 App 里点了"连上手机日历"）时收同步范围里的全部日程，和现在的样子比出增量（新、改、删）写成
//   phone_calendar_event；没授权、撤回了、读不了的记下状况和原因（数据源页写明）；日历插件按月取时给 [from, to) 里的日程。
// 数据源页的"共几条"：通讯录是挑过几个人（按记录数），日历是现在有几条日程（count）。
// 300 号票：照片的时间地点、位置在 photos-location.ts（插件自己的存储、按天整理成摘要），这里合进同一个服务。
import { randomUUID } from "node:crypto";
import {
  formatList,
  type PhoneCalendarEvent,
  type PhoneCalendarPush,
  type PhoneContact,
  type PhoneContactsPush,
  type PhoneContactsReply,
  PHONE_CONTACTS_SOURCE,
  t,
} from "@ergo/protocol";
import type { DataSourceCalendarEvent, DataSourcePushOutcome, DataSourceStatus } from "../data-sources/api.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { CandidateInput, PersonalFilesForMemory } from "../personal-files/index.ts";
import { createPhoneMediaService, type PhoneMediaService } from "./photos-location.ts";
import {
  calendarStatus,
  currentCalendar,
  PHONE_CALENDAR_EVENT,
  PHONE_CALENDAR_STATUS,
  PHONE_CHANNEL,
  PHONE_CONTACT_PICKED,
  type PhoneCalendarEventPayload,
  type PhoneCalendarStatusPayload,
  type PhoneContactPickedPayload,
} from "./events.ts";

export interface PhoneServiceOptions {
  store: EventStore;
  now: () => string;
  /** 个人档案收候选、合成候选核对卡（内核的，KERNEL.personalFiles） */
  personalFiles: Pick<PersonalFilesForMemory, "addCandidates" | "composeCandidates">;
  /** 日历插件在不在（不在时"手机 · 日历"写明同步来的日程暂时看不到） */
  calendarOn: () => boolean;
  /** 现在（毫秒，守护进程的时钟；300 号票的照片、位置按它分"今天以前"） */
  nowMs: () => number;
  /** 数据目录（300 号票：插件自己的存储在它下面的 phone/） */
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
  const { store, now, personalFiles, log } = options;

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

  const appendStatus = (status: Omit<PhoneCalendarStatusPayload, "at">) =>
    store.append({ channel: PHONE_CHANNEL, type: PHONE_CALENDAR_STATUS, payload: { at: now(), ...status } satisfies PhoneCalendarStatusPayload });

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
      events.push({ channel: PHONE_CHANNEL, type: PHONE_CALENDAR_STATUS, payload: { at: now(), linked: true, ...(push.device === undefined ? {} : { device: push.device }), state: "granted" } satisfies PhoneCalendarStatusPayload });
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
      if (incoming.has(key)) continue;
      const start = Date.parse(event.start);
      if (start < from || start >= to) continue;
      removed += 1;
      events.push({ channel: PHONE_CHANNEL, type: PHONE_CALENDAR_EVENT, payload: { op: "remove", key } satisfies PhoneCalendarEventPayload });
    }
    if (events.length > 0) store.appendBatch(events);
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
        return { connection: "error", problem: t(`phone.calendar.problem.${status.state}`, { reason }), ...account };
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
    unlinkCalendar() {
      if (calendarStatus(store)?.linked) appendStatus({ linked: false });
    },
  };
}
