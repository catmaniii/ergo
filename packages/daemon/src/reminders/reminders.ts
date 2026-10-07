// 简单提醒（规格第 7、8、13 节）：到点只发一条通知、不需要 agent 干活。秘书负责建、改、取消（工具在 tools.ts），
// 用户也能在提醒卡上改、取消（卡片动作，卡片类型在 card.ts）。
// - 状态：一次性的 待触发 → 已触发；重复的（每天、每周几、每月几号）一直待触发；任何时候可以取消。
// - 每条提醒有一张提醒卡；提醒变了，卡片跟着变（同一事务）。
// - 存储：任务看板频道上的 reminder 事件（最新状态 + 这次的变化 + 谁做的），派生视图 reminders（views.ts）。
// - 到点：调度器（时钟可注入）直接通知前端，不拉起任何 agent：待我处理里放一条置顶的提醒事项、推一条临时的 notify。
//   提醒、卡片、待我处理事项在同一事务里一起变。
// - 调度：启动时把待触发的提醒登记进调度器；之后每条 reminder 事件（不论是秘书、用户还是到点引起的）都按它的新状态重新登记。
//   所以守护进程正常重启后，还没到点的提醒照常触发。错过的触发怎么补（60 分钟内照发、更晚的进待我处理）在 19 号票。
import {
  type Card,
  CHANNELS,
  EVENT_TYPES,
  nowIso,
  type Reminder,
  type ReminderCardPayload,
  type ReminderEventPayload,
  type ReminderSchedule,
  type Speaker,
} from "@ergou/protocol";
import type { CardService } from "../cards/cards.ts";
import { newCardId } from "../cards/cards.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { describeSchedule, describeTime, nextOccurrence, ReminderInputError } from "./schedule.ts";
import { countReminders, getReminder, listReminders } from "./views.ts";

export interface ReminderChange {
  text?: string;
  schedule?: ReminderSchedule;
}

export interface ReminderService {
  /** 建一条提醒（连同它的提醒卡）；时间不对时抛 ReminderInputError */
  create(input: { text: string; schedule: ReminderSchedule }, by: Speaker): { reminder: Reminder; card: Card };
  /** 改时间或内容（秘书按用户的话改）；提醒卡跟着变 */
  update(reminderId: string, change: ReminderChange, by: Speaker): { reminder: Reminder; card: Card };
  /** 取消（秘书按用户的话取消）；提醒卡变成已处理 */
  cancel(reminderId: string, by: Speaker): { reminder: Reminder; card: Card };
  /** 改了之后提醒的样子（不追加）：提醒卡上的"改"用它，卡片由卡片动作自己更新 */
  prepareUpdate(reminderId: string, change: ReminderChange): Reminder;
  /** 取消之后提醒的样子（不追加） */
  prepareCancel(reminderId: string): Reminder;
  /** 提醒的 reminder 事件 */
  event(reminder: Reminder, change: ReminderEventPayload["change"], by: Speaker): NewEvent;
  /** 提醒卡的负载 */
  cardPayload(reminder: Reminder): ReminderCardPayload;
  get(reminderId: string): Reminder | undefined;
  /** 待触发的提醒（给秘书看，比如它给错了编号时） */
  pending(): Reminder[];
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
}

const schedulerKey = (reminderId: string) => `reminder:${reminderId}`;

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
function reminderEvent(reminder: Reminder, change: ReminderEventPayload["change"], by: Speaker): NewEvent {
  const payload: ReminderEventPayload = { reminder, change, by };
  return { channel: CHANNELS.board, type: EVENT_TYPES.reminder, payload };
}

/** 规则下一次响的时间；已经过了（一次性的时刻已过）就说明错在哪 */
function nextAtOf(schedule: ReminderSchedule, now: Date): string {
  if (schedule.kind === "once" && Number.isNaN(new Date(schedule.at).getTime())) throw new ReminderInputError(`时间写法不对：${schedule.at}`);
  const next = nextOccurrence(schedule, now);
  if (!next) throw new ReminderInputError(`这个时间已经过去了：${describeSchedule(schedule, now)}（现在是 ${describeTime(now)}）`);
  return nowIso(next);
}

export function createReminderService(options: ReminderServiceOptions): ReminderService {
  const { store, cards, inbox, scheduler, clock } = options;
  const cardPayload = cardPayloadOf;
  const event = reminderEvent;
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

  const prepareUpdate = (reminderId: string, change: ReminderChange): Reminder => {
    const current = pendingReminder(reminderId);
    const text = change.text?.trim() || current.text;
    const schedule = change.schedule ?? current.schedule;
    const nextAt = nextAtOf(schedule, nowDate());
    return { ...current, text, schedule, nextAt, updatedAt: nowIso(nowDate()) };
  };

  const prepareCancel = (reminderId: string): Reminder => {
    const { nextAt: _dropped, ...current } = pendingReminder(reminderId);
    return { ...current, status: "cancelled", updatedAt: nowIso(nowDate()) };
  };

  /** 提醒变了，提醒卡跟着变的那条 card 事件 */
  const cardUpdate = (reminder: Reminder, change: Parameters<CardService["buildUpdate"]>[1] = {}) =>
    cards.buildUpdate(reminder.cardId, { payload: cardPayload(reminder), ...change });

  /** 到点 */
  const fire = (reminderId: string) => {
    const reminder = getReminder(store.reader, reminderId);
    const now = nowDate();
    // 已经取消、或者改到了更晚（调度器里的旧计时器）：不响
    if (!reminder || reminder.status !== "pending" || reminder.nextAt === undefined || new Date(reminder.nextAt).getTime() > now.getTime()) return;
    const once = reminder.schedule.kind === "once";
    const firedAt = nowIso(now);
    const next = once ? undefined : nextOccurrence(reminder.schedule, now);
    const { nextAt: _previous, ...rest } = reminder;
    const fired: Reminder = { ...rest, status: once ? "fired" : "pending", ...(next ? { nextAt: nowIso(next) } : {}), lastFiredAt: firedAt, updatedAt: firedAt };
    const card = cardUpdate(fired, once ? { status: "expired" } : {});
    const item = inbox.buildAdd({
      kind: "notice",
      notice: "reminder_due",
      title: `提醒：${reminder.text}`,
      body: once ? `${describeTime(new Date(reminder.nextAt))} 的提醒。` : `${describeSchedule(reminder.schedule)} 的提醒。`,
      source: "简单提醒",
      urgency: "non_blocking",
      pinned: true,
      actions: ["知道了"],
      cardId: reminder.cardId,
    });
    store.appendBatch([event(fired, "fired", "system"), card.event, item.event]);
    inbox.alert(item.item);
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
      const nextAt = nextAtOf(input.schedule, now);
      // 提醒的编号接着往下排（r-1、r-2……）：短，秘书好引用
      const reminder: Reminder = {
        id: `r-${countReminders(store.reader) + 1}`,
        text,
        schedule: input.schedule,
        status: "pending",
        nextAt,
        cardId: newCardId(),
        createdAt: nowIso(now),
        updatedAt: nowIso(now),
      };
      const card = cards.buildCreate({ id: reminder.cardId, type: "reminder", payload: cardPayload(reminder) });
      store.appendBatch([event(reminder, "created", by), card.event]);
      return { reminder, card: card.card };
    },
    update(reminderId, change, by) {
      const reminder = prepareUpdate(reminderId, change);
      const card = cardUpdate(reminder);
      store.appendBatch([event(reminder, "updated", by), card.event]);
      return { reminder, card: card.card };
    },
    cancel(reminderId, by) {
      const reminder = prepareCancel(reminderId);
      const note = by === "agent" ? "秘书按你的话取消了" : undefined;
      const card = cardUpdate(reminder, { status: "handled", outcome: { action: "cancel_reminder", ...(note === undefined ? {} : { note }) } });
      store.appendBatch([event(reminder, "cancelled", by), card.event]);
      return { reminder, card: card.card };
    },
    prepareUpdate,
    prepareCancel,
    event,
    cardPayload,
    get: (reminderId) => getReminder(store.reader, reminderId),
    pending: () => listReminders(store.reader, "pending"),
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
