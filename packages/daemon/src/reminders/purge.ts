// 简单提醒的彻底删除改写（302 号票）：以前提醒的事件没有素材来源采它们、彻底删除碰不到，没登记改写函数；
// 个人档案里的生日、纪念日建的每年提醒（283）内容写着"3 月 2 日是妈妈的生日"，彻底删除档案里的那个字段（删整个人）时，
// 档案按留痕找到它建过的提醒，把这条提醒的事件交给彻底删除改写（personal-files 的 purgeTargets）。
// - 提醒的事件：内容换成删除标记，时间表、事件条件、下一次和最近一次响的时间、最近一次的事件都去掉（编号、状态、提醒卡、建和改的时刻留着）；
// - 连带（related）：同一条提醒的别的版本（按提醒卡认：编号会重用，卡片编号不会）、提醒卡的每个版本（卡片类型的 purge 一样去掉内容和时间；
//   改写函数表连带出来的卡追加改写后的新版本，开着的页面跟着换）、待我处理里它的通知（到点的、错过的：标题、正文换成删除标记）。
// 由数据契约登记（插件停用也登记：停用期间彻底删除档案里的字段照样改写它的提醒事件）。
import { CHANNELS, type CardEventPayload, EVENT_TYPES, type InboxItemEventPayload, isDeletedEventPayload, PURGED_TEXT, type Reminder, type ReminderCardPayload, type ReminderEventPayload } from "@ergo/protocol";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import type { PurgeRewriter } from "../events/purge.ts";

/** 一条提醒彻底删除后的样子：内容换成删除标记，时间、条件去掉 */
export function purgedReminder({ schedule: _schedule, event: _event, nextAt: _nextAt, lastFiredAt: _lastFiredAt, lastEvent: _lastEvent, ...rest }: Reminder): Reminder {
  return { ...rest, text: PURGED_TEXT };
}

/** 提醒卡彻底删除后的样子（卡片类型的 purge）：同上 */
export function purgedReminderCard({ schedule: _schedule, event: _event, nextAt: _nextAt, lastFiredAt: _lastFiredAt, ...rest }: ReminderCardPayload): ReminderCardPayload {
  return { ...rest, text: PURGED_TEXT };
}

/** 还不是"已删除"标记的事件 */
const live = (e: StoredEvent) => !isDeletedEventPayload(e.payload);

/** 这张提醒卡对应的提醒的事件、卡的每个版本、待我处理里它的事项（"已删除"标记跳过） */
function traceOfCard(store: EventStore, cardId: string): StoredEvent[] {
  return [
    ...store.mentioning(EVENT_TYPES.reminder, cardId).filter((e) => live(e) && e.channel === CHANNELS.board && (e.payload as ReminderEventPayload).reminder.cardId === cardId),
    ...store.mentioning(EVENT_TYPES.card, cardId).filter((e) => live(e) && e.channel === CHANNELS.cards && (e.payload as CardEventPayload).card.id === cardId),
    ...store.mentioning(EVENT_TYPES.inboxItem, cardId).filter((e) => live(e) && (e.payload as InboxItemEventPayload).item.cardId === cardId),
  ];
}

export const reminderPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.reminder,
  rewrite(event) {
    const payload = event.payload as ReminderEventPayload;
    return { ...payload, reminder: purgedReminder(payload.reminder) } satisfies ReminderEventPayload;
  },
  related(event, store) {
    return traceOfCard(store, (event.payload as ReminderEventPayload).reminder.cardId).filter((e) => e.globalSeq !== event.globalSeq);
  },
};
