// 日历插件的网页这一半（213 号票，ADR-0027 的网页插槽；守护进程那一半是 packages/daemon/src/calendar/plugin.ts）。
// 插件名和守护进程的一样（calendar）：守护进程报它在运行就装，停用了、移除了就停。登记的：
// - 页面"日历"（CalendarPage.tsx，35 号票的主导航日历，一行没改）：导航里排在待办、浏览后面，消耗前面（order 60，和原来一样），
//   放不下时收进"更多"；它有自己的地址 #/calendar[/YYYY-MM | /YYYY-MM-DD]（route：地址的拆拼还在核心的路由，导航、"更多"里点了去那里，
//   收进"更多"时也是整页，所以没有 Column）。
// 停用时：导航、"更多"里没有日历，#/calendar 写"日历插件没启用，这一页暂时看不到"；核心里去日历的链接（设置 · 工作日规则里的"日历"、
// 待办里到点的提醒的"去看看"）不出（plugins/react.tsx 的 useRouteAvailable）。设置 · 工作日规则、工作日判定是内核的，照常。
// 日历里的提醒（日历插槽，plugins/slots.ts 的 CalendarSlot）是提醒插件登记的：提醒插件停用时日历照常，只是没有提醒那一栏。
// 日历插槽、日历的状态层（state/calendar.ts）还在核心：插件之间不互相 import，提醒插件经核心的插槽往日历里放东西。
import { t } from "../../state/index.ts";
import type { WebPluginDefinition } from "../api.ts";
import { CalendarSection } from "./CalendarPage.tsx";

/** 日历页的页面 id（导航那一项、data-nav） */
const CALENDAR_PAGE = "calendar";

export const calendarWebPlugin: WebPluginDefinition = {
  name: "calendar",
  get title() {
    return t("ui.plugins.calendar.title");
  },
  owns: { pages: [CALENDAR_PAGE] },
  // 设置 · 插件里列的网页上的页面（211 号票）
  get brings() {
    return [t("ui.plugins.calendar.brings.page")];
  },
  setup(ctx) {
    ctx.register("pages", {
      id: CALENDAR_PAGE,
      order: 60,
      icon: "calendar",
      get navLabel() {
        return t("shell.nav.calendar");
      },
      get title() {
        return t("shell.more.calendar");
      },
      get sub() {
        return t("shell.more.calendarSub");
      },
      route: { tab: "calendar" },
      Section: CalendarSection,
    });
  },
};
