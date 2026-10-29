// 提醒插件对外的接口（126 号票，ADR-0027）：内核和别的插件只从这里拿提醒的东西——服务名（经插件宿主按名字取，
// 插件没启用时取到 undefined）和它的类型；不 import 提醒的别的文件（test/reminders/boundary.test.ts 检查，例外写在那里）。
import { serviceKey } from "../plugins/host.ts";
import type { ReminderService } from "./reminders.ts";

export type { NewReminder, ReminderCalendarEntry, ReminderEdit, ReminderFiring, ReminderService } from "./reminders.ts";

/** 提醒插件提供的服务：建、改、取消、到点、日历上的展开 */
export const REMINDERS = serviceKey<ReminderService>("reminders");
