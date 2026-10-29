// Google 插件的网页这一半（297 号票，ADR-0027 的网页插槽；守护进程那一半是 packages/daemon/src/google/plugin.ts）。
// 插件名和守护进程的一样（google）：守护进程报它在运行就装，停用了、移除了就停。登记的：
// - 设置 · 数据源里 Google · 日历下面那一块（dataSources 插槽，键是数据源 id google-calendar）：订阅的几个日历、加一个私密 iCal 地址、
//   删一个日历（GoogleCalendarPanel.tsx）；
// - 298 号票：Google · Gmail 下面那一块（键 google-gmail）：填 Gmail 地址和应用专用密码、测试连接、怎么生成应用专用密码（GoogleGmailPanel.tsx）；
// - 301 号票：Google · 联系人下面那一块（键 google-contacts）：进候选的是谁、怎么从 Google 联系人导出 vCard（GoogleContactsPanel.tsx）；
//   导出的文件放进同一页的导入文件夹，候选核对卡是档案那一侧的（候选卡片自己画）。
// 日历里的 Google 日程不是这个插件画的：守护进程把它交给日历插件当外部日历（日历页自己画），这里不碰日历插槽。
// 停用时：数据源页上那几行写"Google插件没启用"、这几块不画（核心按 owns 认得）。
import { t } from "../../state/index.ts";
import type { WebPluginDefinition } from "../api.ts";
import { GoogleCalendarPanel } from "./GoogleCalendarPanel.tsx";
import { GoogleContactsPanel } from "./GoogleContactsPanel.tsx";
import { GoogleGmailPanel } from "./GoogleGmailPanel.tsx";

/** 日历订阅、Gmail 这两个数据源的 id（和守护进程的一样） */
const GOOGLE_CALENDAR_SOURCE = "google-calendar";
const GOOGLE_GMAIL_SOURCE = "google-gmail";
/** 联系人导入这个数据源的 id（和守护进程的一样） */
const GOOGLE_CONTACTS_SOURCE = "google-contacts";

export const googleWebPlugin: WebPluginDefinition = {
  name: "google",
  get title() {
    return t("ui.plugins.google.title");
  },
  owns: { dataSources: [GOOGLE_CALENDAR_SOURCE, GOOGLE_GMAIL_SOURCE, GOOGLE_CONTACTS_SOURCE] },
  // 设置 · 插件里列的网页上的栏目（211 号票）
  get brings() {
    return [t("ui.plugins.google.brings.calendar"), t("ui.plugins.google.brings.gmail"), t("ui.plugins.google.brings.contacts")];
  },
  setup(ctx) {
    ctx.register("dataSources", { id: GOOGLE_CALENDAR_SOURCE, Panel: GoogleCalendarPanel });
    ctx.register("dataSources", { id: GOOGLE_GMAIL_SOURCE, Panel: GoogleGmailPanel });
    ctx.register("dataSources", { id: GOOGLE_CONTACTS_SOURCE, Panel: GoogleContactsPanel });
  },
};
