// 简单提醒卡（卡片类型注册表里的 reminder）：显示时间或重复规则和内容，有"改"和"取消"。
// - 改（save）：输入是新的时间或重复规则（可以连内容一起改）；提醒跟着改，卡片仍待处理（还能再改、再取消）；
// - 取消（cancel_reminder）：提醒取消，卡片已处理；
// - 一次性提醒到点后卡片变成已过期（界面上写"已触发"），不能再改；重复提醒到点后卡片仍待处理，负载里是下一次的时间。
// - 185 号票：归档、删除不是卡片动作（卡片动作只收待处理的卡，已触发、已取消的提醒卡已经不是），走 reminder_action；
//   归档了负载里写 archived，删了状态是 deleted、卡片作废（再点旧按钮回"提醒已经删了"）。
// 动作的结果由提醒模块给出（editFromCard / cancelFromCard）；时间不对时它抛的 ReminderInputError 就是 bad_params。
// 事件发生时提醒的（77 号票）：卡上写在等什么事件；改了时间就改成到点提醒。
// 126 号票起这张卡是提醒插件的数据契约：插件停用也照样登记（卡片改写后的新版本、彻底删除照常），提醒模块在动作里现取，
// 插件没启用时取的那一下就回"提醒插件没启用"（not_allowed）。302 号票：彻底删除时内容换成删除标记、时间和条件去掉（purge.ts）。
import { describeTime, isRepeating, jobTriggerText, ReminderCardPayload, ReminderEditInput, t } from "@ergo/protocol";
import { defineCardType } from "../cards/registry.ts";
import { purgedReminderCard } from "./purge.ts";
import type { ReminderService } from "./reminders.ts";

/** 纯文本降级版本：简单提醒：交报告 · 10 月 8 日（周四）09:00（· 已触发 · 已归档；删了的只写 · 已删除） */
export function reminderCardText(p: ReminderCardPayload): string {
  const status =
    p.status === "deleted"
      ? t("reminders.card.deleted")
      : p.status === "fired"
        ? t("reminders.card.fired")
        : p.status === "cancelled"
          ? t("reminders.card.cancelled")
          : p.schedule && isRepeating(p.schedule) && p.nextAt
            ? t("reminders.card.next", { at: describeTime(new Date(p.nextAt)) })
            : "";
  const tail = p.archived && p.status !== "deleted" ? `${status}${t("reminders.card.archived")}` : status;
  return t("reminders.card.text", { text: p.text, when: jobTriggerText(p), tail });
}

/** 提醒卡的类型定义：动作要改提醒，所以由提醒模块提供结果（reminders 现取：插件没启用时抛"提醒插件没启用"） */
export function reminderCardType(reminders: () => Pick<ReminderService, "editFromCard" | "cancelFromCard">) {
  return defineCardType({
    type: "reminder",
    // 2：时间表多了"按我的工作日"（29 号票）；3：能归档（archived）、删除（状态 deleted），185 号票；4：时间表多了每年某月某日（282 号票）
    version: 4,
    payload: ReminderCardPayload,
    actions: {
      save: { input: ReminderEditInput, run: ({ payload, input }) => reminders().editFromCard(payload.reminderId, input) },
      cancel_reminder: { input: undefined, run: ({ payload }) => reminders().cancelFromCard(payload.reminderId) },
    },
    toText: reminderCardText,
    purge: purgedReminderCard,
  });
}
