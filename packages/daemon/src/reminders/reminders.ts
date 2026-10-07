// 简单提醒（规格第 7、8、13 节）：到点只发一条通知、不需要 agent 干活。秘书负责建、改、取消（工具在 tools.ts），
// 用户也能在提醒卡上改、取消（卡片类型在 card.ts，动作的结果由这里给出）。
// - 状态：一次性的 待触发 → 已触发；重复的（每天、每周几、每月几号、按我的工作日）一直待触发；任何时候可以取消。
// - 每条提醒有一张提醒卡；提醒变了，卡片跟着变（同一事务）。
// - 存储：任务看板频道上的 reminder 事件（最新状态 + 这次的变化 + 谁做的），派生视图 reminders（views.ts）。
// - "按我的工作日"（29 号票）：下一次按当时的个人工作日历算（calendar）。日历改了（比如明天标成休息），
//   recalculate 按新日历重算待触发的这类提醒，下一次变了就追加一条 updated（by system），提醒卡跟着变，不用重建提醒。
// - 到点：调度器（时钟可注入）直接通知前端，不拉起任何 agent：待我处理里放一条置顶的提醒事项、推一条临时的 notify。
//   同一个提醒在待我处理里最多一条置顶：新的一次到点时，上一次的置顶事项取消置顶（还没处理的顺手归档）。
// - 晚了才到点（守护进程那时没在运行、机器睡着了）：晚了 60 分钟以内照发，标明晚了多久；更晚的不弹提示，
//   改放进待我处理（错过的提醒）。重复提醒错过多次只按最近一次处理（规格第 13 节）。19 号票把同一套规则扩到定时作业。
// - 调度：启动时把待触发的提醒登记进调度器（已经过了点的马上按上面的规则处理）；之后每条 reminder 事件
//   （不论是秘书、用户还是到点引起的）都按它的新状态重新登记。所以守护进程正常重启后，还没到点的提醒照常触发。
import {
  CHANNELS,
  describeSchedule,
  describeTime,
  EVENT_TYPES,
  isRepeating,
  nextOccurrence,
  type NoticeInboxItem,
  nowIso,
  type Reminder,
  type ReminderCardPayload,
  type ReminderChangeKind,
  type ReminderEventPayload,
  type ReminderSchedule,
  type Speaker,
  type WorkdayCalendar,
} from "@ergou/protocol";
import type { CardChange, CardService } from "../cards/cards.ts";
import { newCardId } from "../cards/cards.ts";
import type { CardActionEffect } from "../cards/registry.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { describeDuration, nextAtOf, ReminderInputError } from "./schedule.ts";
import { countReminders, getReminder, listReminders } from "./views.ts";

/** 晚了这么多分钟以内照发；更晚的改放进待我处理（规格第 13 节） */
export const LATE_LIMIT_MINUTES = 60;

/** 改一条提醒：新的内容、新的时间表（不给的不变） */
export interface ReminderEdit {
  text?: string;
  schedule?: ReminderSchedule;
}

export interface ReminderService {
  /** 建一条提醒（连同它的提醒卡）；时间不对时抛 ReminderInputError */
  create(input: { text: string; schedule: ReminderSchedule }, by: Speaker): { reminder: Reminder; cardId: string };
  /** 秘书按用户的话改时间或内容；提醒卡跟着变 */
  update(reminderId: string, edit: ReminderEdit, by: Speaker): { reminder: Reminder; cardId: string };
  /** 秘书按用户的话取消；提醒卡变成已处理 */
  cancel(reminderId: string, by: Speaker): { reminder: Reminder; cardId: string };
  /** 用户在提醒卡上"改"的结果（卡片动作 save）：卡片仍待处理，负载换成新的，提醒事件随卡片一起追加 */
  editFromCard(reminderId: string, edit: ReminderEdit): CardActionEffect<ReminderCardPayload>;
  /** 用户在提醒卡上"取消提醒"的结果（卡片动作 cancel_reminder）：卡片已处理 */
  cancelFromCard(reminderId: string): CardActionEffect<ReminderCardPayload>;
  get(reminderId: string): Reminder | undefined;
  /** 待触发的提醒（给秘书看，比如它给错了编号时） */
  pending(): Reminder[];
  /** 工作日历变了：按新日历重算"按我的工作日"的提醒的下一次（变了才追加事件） */
  recalculate(): void;
  /** 把待触发的提醒登记进调度器，之后跟着提醒的变化重新登记 */
  start(): void;
  stop(): void;
}

export interface ReminderServiceOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  scheduler: Scheduler;
  clock: Clock;
  /** 当前的个人工作日历（"按我的工作日"的下一次按它算） */
  calendar: () => WorkdayCalendar;
}

const schedulerKey = (reminderId: string) => `reminder:${reminderId}`;
const MINUTE = 60_000;

/** 提醒卡的负载 */
function cardPayloadOf(r: Reminder): ReminderCardPayload {
  return {
    reminderId: r.id,
    text: r.text,
    schedule: r.schedule,
    status: r.status,
    ...(r.nextAt === undefined ? {} : { nextAt: r.nextAt }),
    ...(r.lastFiredAt === undefined ? {} : { lastFiredAt: r.lastFiredAt }),
  };
}

/** 提醒的 reminder 事件 */
function reminderEvent(reminder: Reminder, change: ReminderChangeKind, by: Speaker, lateMinutes?: number): NewEvent {
  const payload: ReminderEventPayload = { reminder, change, by, ...(lateMinutes === undefined ? {} : { lateMinutes }) };
  return { channel: CHANNELS.board, type: EVENT_TYPES.reminder, payload };
}

/** 去掉下一次的时间（已触发、已取消的提醒没有） */
function withoutNextAt(reminder: Reminder): Reminder {
  const { nextAt: _dropped, ...rest } = reminder;
  return rest;
}

/** 从 first 起往后数，最后一个不晚于 now 的触发时刻（重复提醒错过多次只按最近一次） */
function latestDue(schedule: ReminderSchedule, first: Date, now: Date, calendar: WorkdayCalendar): Date {
  let due = first;
  // 上限只是防御：每分钟一次也够看几十天
  for (let i = 0; i < 100_000; i++) {
    const next = nextOccurrence(schedule, due, calendar);
    if (!next || next.getTime() > now.getTime()) break;
    due = next;
  }
  return due;
}

export function createReminderService(options: ReminderServiceOptions): ReminderService {
  const { store, cards, inbox, scheduler, clock, calendar } = options;
  let unsubscribe: (() => void) | undefined;

  const nowDate = () => new Date(clock.now());

  /** 还能改、能取消的提醒；不存在或已经结束时说明原因 */
  const pendingReminder = (reminderId: string): Reminder => {
    const reminder = getReminder(store.reader, reminderId);
    if (!reminder) {
      const list = listReminders(store.reader, "pending")
        .map((r) => `${r.id}「${r.text}」${describeSchedule(r.schedule)}`)
        .join("；");
      throw new ReminderInputError(`没有编号为 ${reminderId} 的提醒。${list ? `现在待触发的提醒：${list}` : "现在没有待触发的提醒"}`);
    }
    if (reminder.status === "fired") throw new ReminderInputError(`提醒 ${reminderId}「${reminder.text}」已经响过了；要再提醒就建一条新的`);
    if (reminder.status === "cancelled") throw new ReminderInputError(`提醒 ${reminderId}「${reminder.text}」已经取消了`);
    return reminder;
  };

  /** 改了之后的提醒（还没追加） */
  const edited = (reminderId: string, edit: ReminderEdit): Reminder => {
    const current = pendingReminder(reminderId);
    const text = edit.text?.trim() || current.text;
    const schedule = edit.schedule ?? current.schedule;
    return { ...current, text, schedule, nextAt: nextAtOf(schedule, nowDate(), calendar()), updatedAt: nowIso(nowDate()) };
  };

  /** 取消之后的提醒（还没追加） */
  const cancelled = (reminderId: string): Reminder => ({ ...withoutNextAt(pendingReminder(reminderId)), status: "cancelled", updatedAt: nowIso(nowDate()) });

  /** 提醒变了，提醒卡跟着变的那条 card 事件 */
  const cardEvent = (reminder: Reminder, change: CardChange = {}): NewEvent => cards.buildUpdate(reminder.cardId, { payload: cardPayloadOf(reminder), ...change }).event;

  /** 这个提醒以前到点时放进待我处理、现在还置顶着的事项：取消置顶，还没处理的顺手归档 */
  const retirePinned = (reminder: Reminder): NewEvent[] =>
    inbox
      .itemsForCard(reminder.cardId)
      .filter((item): item is NoticeInboxItem => item.kind === "notice" && item.notice === "reminder_due" && item.pinned)
      .map((item) => inbox.buildUpdate(item, inbox.isProcessed(item) ? { pinned: false } : { pinned: false, archived: true }).event);

  /** 到点（或者晚了才到点） */
  const fire = (reminderId: string) => {
    const reminder = getReminder(store.reader, reminderId);
    const now = nowDate();
    // 已经取消、或者改到了更晚（调度器里的旧计时器）：不响
    if (!reminder || reminder.status !== "pending" || reminder.nextAt === undefined || new Date(reminder.nextAt).getTime() > now.getTime()) return;
    const due = latestDue(reminder.schedule, new Date(reminder.nextAt), now, calendar());
    const lateMinutes = Math.floor((now.getTime() - due.getTime()) / MINUTE);
    const missed = lateMinutes > LATE_LIMIT_MINUTES;
    const repeating = isRepeating(reminder.schedule);
    const next = repeating ? nextOccurrence(reminder.schedule, now, calendar()) : undefined;
    const at = nowIso(now);
    const after: Reminder = {
      ...withoutNextAt(reminder),
      status: repeating ? "pending" : "fired",
      ...(next ? { nextAt: nowIso(next) } : {}),
      lastFiredAt: nowIso(due),
      updatedAt: at,
    };
    const when = describeTime(due);
    const late = lateMinutes >= 1 ? lateMinutes : undefined;
    const item = missed
      ? inbox.buildAdd({
          kind: "notice",
          notice: "missed_reminder",
          title: `错过的提醒：${reminder.text}`,
          body: `${when} 的提醒没有按时响（那时守护进程没在运行），晚了 ${describeDuration(lateMinutes)}，改放到这里。`,
          source: "简单提醒",
          urgency: "non_blocking",
          actions: ["知道了"],
          cardId: reminder.cardId,
        })
      : inbox.buildAdd({
          kind: "notice",
          notice: "reminder_due",
          title: `提醒：${reminder.text}`,
          body: late === undefined ? `${when} 的提醒。` : `${when} 的提醒，晚了 ${describeDuration(late)}（那时守护进程没在运行）。`,
          source: "简单提醒",
          urgency: "non_blocking",
          pinned: true,
          actions: ["知道了"],
          cardId: reminder.cardId,
        });
    store.appendBatch([
      reminderEvent(after, missed ? "missed" : "fired", "system", late),
      cardEvent(after, repeating ? {} : { status: "expired" }),
      ...retirePinned(reminder),
      item.event,
    ]);
    // 错过的不弹页面提示和浏览器通知，只放进待我处理
    if (!missed) inbox.alert(item.item);
  };

  /** 按提醒的最新状态登记或取消调度 */
  const reschedule = (reminder: Reminder) => {
    if (reminder.status === "pending" && reminder.nextAt !== undefined) {
      scheduler.schedule(schedulerKey(reminder.id), new Date(reminder.nextAt).getTime(), () => fire(reminder.id));
    } else {
      scheduler.cancel(schedulerKey(reminder.id));
    }
  };

  return {
    create(input, by) {
      const text = input.text.trim();
      if (!text) throw new ReminderInputError("提醒的内容是空的");
      const now = nowDate();
      // 提醒的编号接着往下排（r-1、r-2……）：短，秘书好引用
      const reminder: Reminder = {
        id: `r-${countReminders(store.reader) + 1}`,
        text,
        schedule: input.schedule,
        status: "pending",
        nextAt: nextAtOf(input.schedule, now, calendar()),
        cardId: newCardId(),
        createdAt: nowIso(now),
        updatedAt: nowIso(now),
      };
      const card = cards.buildCreate({ id: reminder.cardId, type: "reminder", payload: cardPayloadOf(reminder) });
      store.appendBatch([reminderEvent(reminder, "created", by), card.event]);
      return { reminder, cardId: reminder.cardId };
    },
    update(reminderId, edit, by) {
      const reminder = edited(reminderId, edit);
      store.appendBatch([reminderEvent(reminder, "updated", by), cardEvent(reminder)]);
      return { reminder, cardId: reminder.cardId };
    },
    cancel(reminderId, by) {
      const reminder = cancelled(reminderId);
      const note = by === "agent" ? "秘书按你的话取消了" : undefined;
      store.appendBatch([
        reminderEvent(reminder, "cancelled", by),
        cardEvent(reminder, { status: "handled", outcome: { action: "cancel_reminder", ...(note === undefined ? {} : { note }) } }),
      ]);
      return { reminder, cardId: reminder.cardId };
    },
    editFromCard(reminderId, edit) {
      const reminder = edited(reminderId, edit);
      return { status: "pending", payload: cardPayloadOf(reminder), events: [reminderEvent(reminder, "updated", "user")] };
    },
    cancelFromCard(reminderId) {
      const reminder = cancelled(reminderId);
      return { status: "handled", payload: cardPayloadOf(reminder), events: [reminderEvent(reminder, "cancelled", "user")] };
    },
    get: (reminderId) => getReminder(store.reader, reminderId),
    pending: () => listReminders(store.reader, "pending"),
    recalculate() {
      const now = nowDate();
      for (const reminder of listReminders(store.reader, "pending")) {
        // 只有"按我的工作日"跟着日历变；已经到点、正等着触发的不动（触发时按当时的日历算下一次）
        if (reminder.schedule.kind !== "workdays" || reminder.nextAt === undefined || new Date(reminder.nextAt).getTime() <= now.getTime()) continue;
        const next = nextOccurrence(reminder.schedule, now, calendar());
        const nextAt = next ? nowIso(next) : undefined;
        if (nextAt === reminder.nextAt) continue;
        const after: Reminder = { ...withoutNextAt(reminder), ...(nextAt === undefined ? {} : { nextAt }), updatedAt: nowIso(now) };
        store.appendBatch([reminderEvent(after, "updated", "system"), cardEvent(after)]);
      }
    },
    start() {
      unsubscribe = store.onAppend((e) => {
        if (e.channel === CHANNELS.board && e.type === EVENT_TYPES.reminder) reschedule((e.payload as ReminderEventPayload).reminder);
      });
      for (const reminder of listReminders(store.reader, "pending")) reschedule(reminder);
    },
    stop() {
      unsubscribe?.();
      for (const reminder of listReminders(store.reader, "pending")) scheduler.cancel(schedulerKey(reminder.id));
    },
  };
}
