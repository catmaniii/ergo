// 日历插件（213 号票，ADR-0027；用户 2026-10-20："把内置浏览器和网页工具，日历和语音这三个拆成插件，其他都不拆"）：主导航的日历
// （35 号票）在守护进程这一侧的部分，组合根只在插件清单里列它。网页那一半是 packages/web/src/plugins/calendar/（同名，一起启停）。
// - 装配：提供日历的服务（calendar.ts：按天合起工作日判定、当天的提醒、当天定时作业的每一次）。网关的 GET /api/calendar 经插件宿主
//   按服务名 CALENDAR 现取（PluginHost.active），插件没启用时回"日历插件没启用"（插件没启用的现有说法）。
// - 依赖：内核的事件存储（两个频道的序号 asOf）、个人工作日历、定时作业在日历上的展开（KERNEL.scheduledJobs）、时钟；
//   提醒是可选依赖（wants）：提醒插件在就排在它后面装、每次现取它的 calendar；提醒停用时日历照常显示工作日和定时作业，只是没有提醒那一栏，
//   提醒停了也不连带停日历（设置 · 插件里提醒的"谁要用它"、停用时一起停的都没有日历）。
// - 不拥有数据：日历只是合起来看的视图，没有派生视图、事件、卡片、改写函数、素材来源，没有数据契约——211 号票的"连数据删"对它是空的，
//   设置里移除时不出那个勾选。工作日历服务、工作日判定（设置 · 工作日规则、协议包的纯函数）、定时作业本身都是内核的，不跟着它停。
// - 没有给 agent 的工具、上下文块，系统提示里不讲日历；没有 start/stop（不挂计时器、不订阅）。
// - 299 号票：外部日历（数据源交来的日程：手机日历……）经内核的 KERNEL.externalCalendars 现取，按天放进日历；日历插件停用时看不到，
//   数据源那边照常收（"手机 · 日历"写明日历插件没启用）。
import { t } from "@ergo/protocol";
import type { PluginDefinition } from "../plugins/host.ts";
import { KERNEL } from "../plugins/kernel.ts";
import { REMINDERS } from "../reminders/api.ts";
import { CALENDAR } from "./api.ts";
import { createCalendarService } from "./calendar.ts";

export const calendarPlugin: PluginDefinition = {
  name: "calendar",
  get title() {
    return t("calendar.plugin.title");
  },
  get summary() {
    return t("calendar.plugin.summary");
  },
  needs: [KERNEL.store, KERNEL.workdayCalendar, KERNEL.scheduledJobs, KERNEL.clock, KERNEL.externalCalendars],
  wants: [REMINDERS],
  provides: [CALENDAR],
  setup(ctx) {
    ctx.provide(
      CALENDAR,
      createCalendarService({
        store: ctx.use(KERNEL.store),
        workdayCalendar: ctx.use(KERNEL.workdayCalendar),
        scheduledJobs: ctx.use(KERNEL.scheduledJobs),
        clock: ctx.use(KERNEL.clock),
        external: ctx.use(KERNEL.externalCalendars),
        // 可选依赖：现取（提醒插件没装、运行中停了是 undefined）
        reminders: () => ctx.optional(REMINDERS),
      }),
    );
  },
};
