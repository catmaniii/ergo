// 提醒插件的网页这一半（193 号票，ADR-0027 的网页插槽；守护进程那一半是 packages/daemon/src/reminders/plugin.ts，126 号票）。
// 插件名和守护进程的一样（reminders）：守护进程报它在运行就装，配置 plugins.disabled 里停用了就停。登记的：
// - 卡片类型 reminder 的画法（ReminderCard.tsx：聊天、待办、任务详情里的提醒卡，改时间、取消、归档、删除）；
// - 看板条目 reminder（BoardReminder.tsx：看板上的提醒卡和长按菜单，156、185 号票）；
// - 日历（CalendarReminders.tsx：图例、格子里的小标、点开一天的"提醒"那一节）。
// 停用时：聊天、待办里以前的提醒卡显示"（提醒插件没启用，这条内容暂时看不到）"，看板上连着的几条合成一行占位，日历里没有提醒。
// 发起对话框里的"只提醒我"还在核心（pages/shared.tsx），停用时守护进程回"提醒插件没启用"（126 号票），见 193 号票 Comments。
import { t } from "../../state/index.ts";
import type { WebPluginDefinition } from "../api.ts";
import { ReminderBoardEntry, ReminderBoardScope } from "./BoardReminder.tsx";
import { ReminderDay, ReminderLegend, ReminderMarks } from "./CalendarReminders.tsx";
import { ReminderCard } from "./ReminderCard.tsx";

export const remindersWebPlugin: WebPluginDefinition = {
  name: "reminders",
  get title() {
    return t("ui.plugins.reminders.title");
  },
  owns: { cards: ["reminder"], boardEntries: ["reminder"], calendar: ["reminders"] },
  // 设置 · 插件里列的网页上的栏目（211 号票）
  get brings() {
    return [t("ui.plugins.reminders.brings.board"), t("ui.plugins.reminders.brings.calendar")];
  },
  setup(ctx) {
    ctx.register("cards", { type: "reminder", Card: ReminderCard });
    ctx.register("boardEntries", { kind: "reminder", Scope: ReminderBoardScope, Entry: ReminderBoardEntry });
    ctx.register("calendar", { id: "reminders", order: 10, Legend: ReminderLegend, CellMarks: ReminderMarks, Day: ReminderDay });
  },
};
