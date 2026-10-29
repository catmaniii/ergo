// Google · 日历这个数据源（297 号票，ADR-0027 的"数据源"贡献点）：写在 Google 插件的数据契约里（插件停用也认得：设置 · 数据源照样列出、
// 写"Google插件没启用"，断开并删照样删得掉）。
// - 两种用法都有、默认都开：按需查（给秘书"查 Google 日历"，现拉）；导入（每 30 分钟拉一次，事件交给日历插件显示，不进素材）；
//   填好地址连上以后马上同步一次；
// - 导入的记录是 Google 插件自己的事件（events.ts）："共几条"由它数（count：按事件的最后一版数，日历的名字那一类不算）；
// - 同步来的日程经 calendar() 交给日历插件当外部日历显示（299 号票定的路：日历按月取时经内核现取）；
// - 要插件在运行才能做的都经 active() 现取插件的服务（calendar-feeds.ts）。
// 不用敏感类别：日历的事件不进素材、不拿来推断（issue 25 第 3 节：直接给日历插件）。
import { t } from "@ergo/protocol";
import type { DataSource } from "../data-sources/api.ts";
import { GOOGLE_CALENDAR_SOURCE, type GoogleCalendarService } from "./calendar-feeds.ts";
import { googleCalendarTool } from "./calendar-tool.ts";
import { GOOGLE_CALENDAR_FEED, GOOGLE_CALENDAR_ITEM, GOOGLE_CHANNEL } from "./events.ts";

/** 定期导入多久一次（分钟）：Google 没说私密地址多久刷新一次（调研 39），日历要看得比较新，又不能拉得太勤 */
export const GOOGLE_CALENDAR_SYNC_MINUTES = 30;

export function googleCalendarSource(active: () => GoogleCalendarService): DataSource {
  return {
    id: GOOGLE_CALENDAR_SOURCE,
    get title() {
      return t("google.calendar.title");
    },
    get summary() {
      return t("google.calendar.summary");
    },
    usages: {
      query: { default: true },
      import: {
        default: true,
        schedule: { kind: "every", minutes: GOOGLE_CALENDAR_SYNC_MINUTES },
        get destination() {
          return t("google.calendar.destination");
        },
        syncOnConnect: true,
      },
    },
    records: [
      { channel: GOOGLE_CHANNEL, type: GOOGLE_CALENDAR_ITEM },
      { channel: GOOGLE_CHANNEL, type: GOOGLE_CALENDAR_FEED },
    ],
    status: (ctx) => active().status(ctx),
    configure: (values, ctx) => active().configure(values, ctx),
    sync: (ctx) => active().sync(ctx),
    // 306：出错（每个地址都连着几次失效）后内核每小时叫一次，拉到了就回到连着
    recheck: (ctx) => active().recheck(ctx),
    disconnect: () => active().disconnect(),
    tools: (ctx) => [googleCalendarTool({ service: active, ctx })],
    count: () => active().count(),
    calendar: (range, ctx) => active().calendarEvents(ctx, range.from, range.to),
  };
}
