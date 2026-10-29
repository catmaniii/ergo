// 日历插件对外的接口（213 号票，ADR-0027）：内核和别的插件只从这里拿日历的东西——服务名（经插件宿主按名字取：插件没启用时
// service 取到 undefined，active 回"日历插件没启用"）和它的类型；不 import 日历的别的文件（test/calendar/boundary.test.ts 检查，例外写在那里）。
import { serviceKey } from "../plugins/host.ts";
import type { CalendarService } from "./calendar.ts";

export type { CalendarService } from "./calendar.ts";

/** 日历插件提供的服务：按月给出每一天的日历条目（网关的 GET /api/calendar） */
export const CALENDAR = serviceKey<CalendarService>("calendar");
