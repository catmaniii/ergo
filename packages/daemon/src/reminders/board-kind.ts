// @i18n-ignore-file model：看板的文字只给秘书（模型）看（174 号票）
// 看板上的"简单提醒"那一种（22 号票；126 号票起由提醒插件登记进看板种类表，停用时撤掉）：
// 看板频道上的 reminder 事件，现在的全部来自派生视图 reminders；每一项写明时间、下一次什么时候响，事件发生时提醒的写最近一次是什么事件。
import { boardGroupOfReminder, describeTime, EVENT_TYPES, jobTriggerText, type Reminder, type ReminderEventPayload, REMINDER_STATUS_LABEL } from "@ergo/protocol";
import type { BoardEntry } from "../board/board.ts";
import { boardKind } from "../board/kinds.ts";
import { oneLine } from "../util/text.ts";
import { listReminders } from "./views.ts";

export function reminderEntry(reminder: Reminder): BoardEntry {
  const detail = [
    jobTriggerText(reminder),
    reminder.nextAt ? `下一次 ${describeTime(new Date(reminder.nextAt))}` : undefined,
    // 事件发生时提醒的（77 号票）：最近一次是什么事件
    reminder.event && reminder.lastEvent && reminder.lastFiredAt ? `最近一次：${reminder.lastEvent}（${describeTime(new Date(reminder.lastFiredAt))}）` : undefined,
  ].filter((x) => x !== undefined);
  return {
    key: `reminder:${reminder.id}`,
    name: `提醒 ${reminder.id}「${oneLine(reminder.text, 60)}」`,
    // 归档了的（185 号票）写"已触发 · 已归档"：秘书看到的变化是"已触发 → 已触发 · 已归档"；删了的不上看板（变化里写"→ 已删除"）
    status: reminder.archived && reminder.status !== "deleted" ? `${REMINDER_STATUS_LABEL[reminder.status]} · 已归档` : REMINDER_STATUS_LABEL[reminder.status],
    group: boardGroupOfReminder(reminder),
    detail: detail.join("；"),
  };
}

/** 排在任务（10）和定时触发的任务（30）之间 */
export const reminderBoardKind = boardKind<Reminder>({
  label: "简单提醒",
  order: 20,
  describes: "每个简单提醒（时间、下一次什么时候响）",
  eventType: EVENT_TYPES.reminder,
  fromEvent: (payload) => (payload as ReminderEventPayload).reminder,
  list: (db) => listReminders(db),
  toEntry: reminderEntry,
});
