// 简单提醒卡（卡片类型注册表里的 reminder）：显示时间或重复规则和内容，有"改"和"取消"。
// - 改（save）：输入是新的时间或重复规则（可以连内容一起改）；提醒跟着改，卡片仍待处理（还能再改、再取消）；
// - 取消（cancel_reminder）：提醒取消，卡片已处理；
// - 一次性提醒到点后卡片变成已过期（界面上写"已触发"），不能再改；重复提醒到点后卡片仍待处理，负载里是下一次的时间。
import { type ReminderCardPayload as Payload, ReminderCardPayload, type ReminderEditInput as EditInput, ReminderEditInput } from "@ergou/protocol";
import { defineCardType } from "../cards/registry.ts";
import { RequestRejected } from "../errors.ts";
import type { ReminderService } from "./reminders.ts";
import { describeSchedule, describeTime, ReminderInputError } from "./schedule.ts";

/** 纯文本降级版本：简单提醒：交报告 · 10 月 8 日（周四）09:00 */
export function reminderCardText(p: Payload): string {
  const when = describeSchedule(p.schedule);
  const tail =
    p.status === "fired" ? " · 已触发" : p.status === "cancelled" ? " · 已取消" : p.schedule.kind !== "once" && p.nextAt ? `（下一次 ${describeTime(new Date(p.nextAt))}）` : "";
  return `简单提醒：${p.text} · ${when}${tail}`;
}

/** 提醒模块说时间不对，换成前端协议的错误 */
function asRejection<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    if (err instanceof ReminderInputError) throw new RequestRejected("bad_params", err.message);
    throw err;
  }
}

/** 提醒卡的类型定义：动作要改提醒，所以由提醒模块提供 */
export function reminderCardType(reminders: ReminderService) {
  return defineCardType({
    type: "reminder",
    version: 1,
    payload: ReminderCardPayload,
    actions: {
      save: {
        input: ReminderEditInput,
        run: ({ payload, input }) => {
          const edit = input as EditInput;
          const reminder = asRejection(() => reminders.prepareUpdate(payload.reminderId, { schedule: edit.schedule, ...(edit.text === undefined ? {} : { text: edit.text }) }));
          return { status: "pending", payload: reminders.cardPayload(reminder), events: [reminders.event(reminder, "updated", "user")] };
        },
      },
      cancel_reminder: {
        run: ({ payload }) => {
          const reminder = asRejection(() => reminders.prepareCancel(payload.reminderId));
          return { status: "handled", payload: reminders.cardPayload(reminder), events: [reminders.event(reminder, "cancelled", "user")] };
        },
      },
    },
    toText: reminderCardText,
  });
}
