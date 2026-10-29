// 生日、纪念日的每年提醒（283 号票，用户 2026-10-25 定）：档案里的生日、纪念日字段（isAnnualField）确认以后，问一句"每年提前几天提醒"
// （默认 3 天，核对卡上勾、候选核对卡上勾、档案页上开），开了就在提醒插件里建一条每年的提醒（282 号票的 yearly）；
// 字段改了提醒跟着改（日子、称呼），字段删了（忘掉、彻底删除、删整个人）、值撤销到没有了提醒跟着删。
// - 设置记在档案的事件里（reminder_set / reminder_cleared，视图 personal_reminders），提醒本身在提醒插件里（reminder_linked 记着是哪一条）：
//   提醒插件停用时设置照样记着（档案页写"提醒插件没启用"），守护进程下次起来时补建（reconcile）；
// - 提醒哪天响：生日往前数 N 天（monthDayBefore，按平年数：3 月 2 日提前 3 天是 2 月 27 日），那天 09:00；值是农历、认不出日子的
//   没法建（档案页写明），之前建的那条删掉，值改回认得出的日子再建；
// - 用户在看板上取消、删掉了那条提醒：当他关掉了，档案里的设置跟着清掉，不再重建。
// 提醒插件只经它的公开接口取（reminders/api.ts 的 REMINDERS，组合根交来一个 AnnualReminderPort）。
// 302 号票：彻底删除生日、纪念日（删整个人）时，由它建过的每条提醒在事件记录里的内容、时间也要改写（"彻底删除"承诺事件库里不留原值）：
// purgeTargets 按留痕（reminder_linked）找到建过的每条提醒，交出建它的那条提醒事件（看板频道上的 reminder，协议包的形状），
// 改写由提醒插件登记的改写函数做（reminders/purge.ts：连带同一条提醒的别的版本、提醒卡、待我处理里它的通知）。
import {
  ANNUAL_REMINDER_TIME,
  CHANNELS,
  EVENT_TYPES,
  isAnnualField,
  type MonthDay,
  monthDayBefore,
  monthDayOf,
  type PersonalAnnualView,
  type ReminderEventPayload,
  type ReminderSchedule,
  repeatSchedule,
  t,
} from "@ergo/protocol";
import type { EventStore, NewEvent, StoredEvent } from "../events/event-store.ts";
import { PERSONAL_FILE_EVENT, PERSONAL_FILES_CHANNEL, type PersonalFileChange, personalFileEvent, type PersonalFileTrail } from "./events.ts";
import { remindersOf, type StoredReminder } from "./view.ts";

/** 提醒插件里的一条提醒（只看用得上的） */
export interface AnnualReminderInfo {
  status: string;
  text: string;
  schedule?: ReminderSchedule;
  nextAt?: string;
}

/** 组合根交来的提醒插件（插件没启用时是 undefined） */
export interface AnnualReminderPort {
  create(input: { text: string; schedule: ReminderSchedule }): { id: string };
  update(id: string, input: { text: string; schedule: ReminderSchedule }): void;
  remove(id: string): void;
  get(id: string): AnnualReminderInfo | undefined;
}

/** 还要接着管的提醒状态（一直待触发；取消了、删了的当用户关掉了） */
const LIVE = "pending";

/** 每年提醒的时间表：那天往前数 daysBefore 天的 09:00，每年 */
export function annualSchedule(date: MonthDay, daysBefore: number): ReminderSchedule {
  const at = monthDayBefore(date, daysBefore);
  const built = repeatSchedule({ kind: "yearly", month: at.month, day: at.day }, ANNUAL_REMINDER_TIME);
  if ("error" in built) throw new Error(built.error); // 认出来的日子都是日历上有的，拼不出是编程错误
  return built.schedule;
}

/** 提醒的内容："3 月 2 日是妈妈的生日（还有 3 天）"；当天的"今天是妈妈的生日（3 月 2 日）" */
export function annualReminderText(who: { self: boolean; name: string | undefined }, label: string, date: MonthDay, daysBefore: number): string {
  const whose = who.self || who.name === undefined ? t("personalFiles.annual.yours") : t("personalFiles.annual.whose", { name: who.name });
  const day = t("personalFiles.annual.date", { month: date.month, day: date.day });
  return daysBefore > 0 ? t("personalFiles.annual.text", { date: day, whose, label, count: daysBefore }) : t("personalFiles.annual.textToday", { date: day, whose, label });
}

const sameSchedule = (a: ReminderSchedule | undefined, b: ReminderSchedule) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);

export interface AnnualRemindersOptions {
  store: EventStore;
  /** 提醒插件（没启用是 undefined） */
  port: () => AnnualReminderPort | undefined;
  /** 一个字段现在的值 */
  valueOf(personId: string, field: string): string | undefined;
  /** 提醒里怎么称呼这个人：本人写"你"，别人写称呼 */
  whoOf(personId: string): { self: boolean; name: string | undefined };
  /** 字段叫什么（"生日""结婚纪念日"） */
  labelOf(personId: string, field: string): string;
  log: (line: string) => void;
}

export interface AnnualReminders {
  /** 档案页上这个字段的每年提醒（不是生日、纪念日这类字段是 undefined） */
  view(personId: string, field: string, value: string | undefined): PersonalAnnualView | undefined;
  /** 一个人每个开着的设置 */
  settings(personId: string): StoredReminder[];
  /** 开（改提前几天）或关的事件（还没追加：和别的写一起进同一批） */
  setEvents(personId: string, field: string, daysBefore: number | null, trail: PersonalFileTrail): NewEvent[];
  /** 落盘以后让提醒插件里的提醒跟上：建、改日子和内容、值没了就删（只看这几个字段；不给是这个人全部开着的） */
  sync(personId: string, fields?: readonly string[]): void;
  /** 删了字段、删了整个人以后：删掉原来对应的那几条提醒（删之前的设置由调用方先取） */
  removeReminders(before: readonly StoredReminder[]): void;
  /** 守护进程起来时对一遍：提醒插件停用期间开的补建，看板上取消、删掉了的清掉设置 */
  reconcile(): void;
  /**
   * 302：彻底删除这个人（field 不给）或这个字段时，由它建过的每条提醒（留痕里记着的，连已经删了、取消了的）——交出建它的那条提醒事件，
   * 改写函数连带这条提醒的别的版本、提醒卡、通知。提醒编号会重用（提醒插件连数据删过以后从头排），按建它那条事件上的提醒卡认
   */
  purgeTargets(personId: string, field?: string): StoredEvent[];
}

export function createAnnualReminders(options: AnnualRemindersOptions): AnnualReminders {
  const { store, port, log } = options;
  const reader = store.reader;
  const settingOf = (personId: string, field: string) => remindersOf(reader, personId).find((r) => r.field === field);

  const WHAT = { remove: "删提醒", update: "改提醒", create: "建提醒", sync: "对提醒" } as const; // @i18n-ignore log：只进日志
  const safely = (what: keyof typeof WHAT, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      log(`个人档案的每年提醒：${WHAT[what]}没成（${err instanceof Error ? err.message : String(err)}）`);
    }
  };

  const syncOne = (setting: StoredReminder) => {
    const reminders = port();
    if (!reminders) return;
    const { personId, field } = setting;
    const value = options.valueOf(personId, field);
    const existing = setting.reminderId === undefined ? undefined : reminders.get(setting.reminderId);
    // 看板上取消、删掉了（或者那条提醒没了）：当用户关掉了，不再重建
    if (setting.reminderId !== undefined && existing?.status !== LIVE) {
      store.append(personalFileEvent({ change: "reminder_cleared", personId, field }));
      return;
    }
    // 值没了（撤销到空）：设置清掉，提醒删掉
    if (value === undefined) {
      if (setting.reminderId !== undefined) safely("remove", () => reminders.remove(setting.reminderId!));
      store.append(personalFileEvent({ change: "reminder_cleared", personId, field }));
      return;
    }
    const date = monthDayOf(value);
    // 农历、认不出日子：之前那条删掉，设置留着（改回认得出的日子再建）
    if (date === undefined) {
      if (setting.reminderId !== undefined) {
        safely("remove", () => reminders.remove(setting.reminderId!));
        store.append(personalFileEvent({ change: "reminder_linked", personId, field }));
      }
      return;
    }
    const text = annualReminderText(options.whoOf(personId), options.labelOf(personId, field), date, setting.daysBefore);
    const schedule = annualSchedule(date, setting.daysBefore);
    if (setting.reminderId !== undefined && existing) {
      if (existing.text !== text || !sameSchedule(existing.schedule, schedule)) safely("update", () => reminders.update(setting.reminderId!, { text, schedule }));
      return;
    }
    safely("create", () => {
      const created = reminders.create({ text, schedule });
      store.append(personalFileEvent({ change: "reminder_linked", personId, field, reminderId: created.id }));
    });
  };

  return {
    view(personId, field, value) {
      if (!isAnnualField(field)) return undefined;
      const date = value === undefined ? undefined : monthDayOf(value);
      const setting = settingOf(personId, field);
      const reminders = port();
      const info = setting?.reminderId === undefined ? undefined : reminders?.get(setting.reminderId);
      const blocked: PersonalAnnualView["blocked"] = value !== undefined && date === undefined ? "not_gregorian" : reminders === undefined ? "reminders_off" : undefined;
      return {
        ...(date === undefined ? {} : { monthDay: date }),
        ...(setting === undefined ? {} : { daysBefore: setting.daysBefore }),
        ...(info?.status === LIVE && info.nextAt !== undefined ? { nextAt: info.nextAt } : {}),
        ...(blocked === undefined ? {} : { blocked }),
      };
    },
    settings: (personId) => remindersOf(reader, personId),
    setEvents(personId, field, daysBefore, trail) {
      const current = settingOf(personId, field);
      if (daysBefore === null) return current === undefined ? [] : [personalFileEvent({ change: "reminder_cleared", personId, field, trail })];
      if (current?.daysBefore === daysBefore) return [];
      return [personalFileEvent({ change: "reminder_set", personId, field, daysBefore, trail })];
    },
    sync(personId, fields) {
      for (const setting of remindersOf(reader, personId)) {
        if (fields !== undefined && !fields.includes(setting.field)) continue;
        safely("sync", () => syncOne(setting));
      }
    },
    removeReminders(before) {
      const reminders = port();
      if (!reminders) return;
      for (const setting of before) {
        if (setting.reminderId === undefined) continue;
        const info = reminders.get(setting.reminderId);
        if (info === undefined || info.status === "deleted") continue;
        safely("remove", () => reminders.remove(setting.reminderId!));
      }
    },
    reconcile() {
      if (!port()) return;
      for (const setting of remindersOf(reader)) safely("sync", () => syncOne(setting));
    },
    purgeTargets(personId, field) {
      const links = store.read(PERSONAL_FILES_CHANNEL, 0, PERSONAL_FILE_EVENT).filter((e) => {
        const change = e.payload as PersonalFileChange;
        return change.change === "reminder_linked" && change.reminderId !== undefined && change.personId === personId && (field === undefined || change.field === field);
      });
      if (links.length === 0) return [];
      const reminders = store.read(CHANNELS.board, 0, EVENT_TYPES.reminder);
      const out = new Map<number, StoredEvent>();
      for (const link of links) {
        const id = (link.payload as Extract<PersonalFileChange, { change: "reminder_linked" }>).reminderId;
        // 建它的那条：链接之前这个编号最后一条事件（建好马上记链接）
        const created = reminders.findLast((e) => e.globalSeq < link.globalSeq && (e.payload as Partial<ReminderEventPayload>).reminder?.id === id);
        if (created) out.set(created.globalSeq, created);
      }
      return [...out.values()];
    },
  };
}
