// Google 插件对外的接口（297 号票，ADR-0027）：内核和别的插件只从这里拿 Google 插件的东西——服务名（经插件宿主按名字取：插件没启用时
// service 取到 undefined，active 回"Google插件没启用"）和它的类型、日历订阅这个数据源的 id；不 import Google 的别的文件
// （test/google/boundary.test.ts 检查，例外写在那里）。
// 一个插件、几个数据源（issue 25：Google 账号里的日历、Gmail、联系人各是一项、各自开关）：297 号票的日历订阅（私密 iCal 地址）、
// 298 号票的 Gmail（应用专用密码 + 只读 IMAP，按需查；可选导入我发出的邮件）、301 号票的联系人（vCard 导入进档案候选），
// 各登记一个数据源。
import { serviceKey } from "../plugins/host.ts";
import type { GoogleCalendarService } from "./calendar-feeds.ts";
import type { GoogleContactsService } from "./contacts.ts";
import type { GmailService } from "./gmail.ts";

export type { GoogleCalendarService } from "./calendar-feeds.ts";
export { GOOGLE_CALENDAR_SOURCE } from "./calendar-feeds.ts";
export type { GmailService } from "./gmail.ts";
export { GOOGLE_GMAIL_SOURCE } from "./gmail.ts";
export type { GoogleContactsService } from "./contacts.ts";
export { GOOGLE_CONTACTS_SOURCE } from "./contacts.ts";

/** Google 插件提供的服务：日历订阅、Gmail、联系人导入 */
export interface GoogleService {
  readonly calendar: GoogleCalendarService;
  readonly gmail: GmailService;
  readonly contacts: GoogleContactsService;
}

export const GOOGLE = serviceKey<GoogleService>("google");
