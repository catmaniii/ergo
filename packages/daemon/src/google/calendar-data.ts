// Google · 日历在数据源详情里给人看的：
// - 已获取的（stored）：同步来的事件，一个 VEVENT 一条，按第一次的开始时间新的在前（重复的标"重复"，取消的标"取消了"）；说明点开看；
// - 现在能查到的（live）：现拉几个私密地址，未来一段时间的日程（重复的展开），近的在前。只读：什么都不写，拉不到的那个日历写明原因，
//   同步来的那份不混进来（这里看的就是"现在拉得到什么"）；一个都没拉到的抛错，页面上写原因。
import { type DataSourceDataItem, nowIso, t } from "@ergo/protocol";
import type { DataSourceContext, DataSourceLiveAnswer, DataSourceLiveContext, DataSourceStoredQuery, DataSourceStoredResult } from "../data-sources/api.ts";
import { type CalendarOccurrence, type GoogleCalendarService, startOfDate } from "./calendar-feeds.ts";
import { eventSpan } from "./recurrence.ts";

/** 现查看未来几天 */
export const CALENDAR_LIVE_DAYS = 30;
/** 现查最多列几条（每天都有的重复事件别把页面撑爆） */
export const CALENDAR_LIVE_MAX = 100;

const DAY_MS = 86_400_000;
const SEPARATOR = " · ";
/** 哪个日历 · 地点 */
const subtitleOf = (calendar: string, location: string | undefined) => [calendar, location].filter((s) => s !== undefined && s !== "").join(SEPARATOR);
const titleOf = (summary: string) => (summary.trim() === "" ? t("google.calendar.data.untitled") : summary);

export function calendarStored(service: GoogleCalendarService, query: DataSourceStoredQuery): DataSourceStoredResult {
  const rows = [...service.feeds().values()].flatMap((feed, index) => {
    const name = service.nameOf(feed, index);
    return [...feed.items].flatMap(([key, event]) => {
      const span = eventSpan(event, feed.timeZone);
      if (!span) return [];
      const labels = [...(event.rrule === undefined ? [] : [t("google.calendar.data.repeats")]), ...(event.status === "cancelled" ? [t("google.calendar.data.cancelled")] : [])];
      const item: DataSourceDataItem = {
        id: `${feed.id}:${key}`,
        title: titleOf(event.summary),
        subtitle: subtitleOf(name, event.location),
        time: nowIso(new Date(span.start)),
        ...(span.allDay ? { allDay: true as const } : span.end === undefined ? {} : { end: nowIso(new Date(span.end)) }),
        ...(event.description ? { body: event.description } : {}),
        ...(labels.length === 0 ? {} : { labels }),
      };
      return [{ at: span.start, item }];
    });
  });
  const sorted = rows.toSorted((a, b) => b.at - a.at);
  return { total: sorted.length, items: sorted.slice(query.offset, query.offset + query.limit).map((r) => r.item) };
}

/** 展开出的一次 → 一条 */
function occurrenceItem({ feed, name, occurrence: o }: CalendarOccurrence): DataSourceDataItem {
  return {
    id: `${feed.id}:${o.key}`,
    title: titleOf(o.event.summary),
    subtitle: subtitleOf(name, o.event.location),
    time: nowIso(o.allDay ? startOfDate(o.startDate!) : new Date(o.start)),
    ...(o.allDay ? { allDay: true as const } : { end: nowIso(new Date(o.end)) }),
    ...(o.event.description ? { body: o.event.description } : {}),
  };
}

export async function calendarLive(service: GoogleCalendarService, ctx: DataSourceContext & Pick<DataSourceLiveContext, "signal">): Promise<DataSourceLiveAnswer> {
  const from = startOfDate(service.today());
  const to = new Date(from.getTime() + CALENDAR_LIVE_DAYS * DAY_MS);
  const { occurrences, failed, configured } = await service.live(ctx, from, to, ctx.signal);
  const notes = failed.map((f) => t("google.calendar.feedFailed", { name: f.name, reason: f.reason }));
  // 一个都没拉到：这回查不成（同步来的在"已获取的"里看）
  if (configured > 0 && failed.length === configured) throw new Error(notes.join(t("google.calendar.problemSep")));
  // 拉不到的那几个，service.live 是拿同步来的顶上的；这里只给真拉到的
  const lost = new Set(failed.map((f) => f.id));
  const fresh = occurrences.filter((o) => !lost.has(o.feed.id));
  return {
    scope: t("google.calendar.data.liveScope", { days: CALENDAR_LIVE_DAYS }),
    total: fresh.length,
    items: fresh.slice(0, CALENDAR_LIVE_MAX).map(occurrenceItem),
    notes,
  };
}
