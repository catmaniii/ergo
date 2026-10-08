// 日历（35 号票，规格第 19 节"日历"、第 21 节"工作日历"）：主导航的日历页按月看，每天是上班还是休息（个人工作日历），
// 当天有哪些简单提醒、哪些定时作业。守护进程按月给出每一天的日历条目（GET /api/calendar?month=YYYY-MM，响应是
// calendar-schema.ts 的 CalendarMonthView）：提醒和作业的时间表按当前的工作日历展开到当天（时间规则是 reminder-schedule.ts 的
// occurrencesBetween，和到点触发同一套，前端不另算），已经到点的带上这一次的结果。
// 这里是名字、说法和纯函数（不引用 TypeBox）。
import { pad2 } from "./local-date.ts";
import { JOB_RUN_STATE_LABEL, JOB_RUN_STATES } from "./scheduled-jobs.ts";

/** 月份的写法 YYYY-MM 的 pattern */
export const MONTH_KEY_PATTERN = "^[0-9]{4}-[0-9]{2}$";

/** 年、月（1–12）→ YYYY-MM */
export function monthKey(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${pad2(month)}`;
}

/** 拆开 YYYY-MM；写法不对、月份不在 1–12 时抛错 */
export function parseMonthKey(key: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  const [year, month] = m ? [Number(m[1]), Number(m[2])] : [NaN, NaN];
  if (!m || month < 1 || month > 12) throw new Error(`月份的写法不对：${key}（写 YYYY-MM）`);
  return { year, month };
}

/** 往前、往后挪几个月 */
export function shiftMonthKey(key: string, delta: number): string {
  const { year, month } = parseMonthKey(key);
  const m = month - 1 + delta;
  return monthKey(year + Math.floor(m / 12), (((m % 12) + 12) % 12) + 1);
}

/**
 * 日历上一次提醒的状况：已触发；错过（晚了太久没有照发，改放进了待我处理）；没响（过了点却没有响：停机期间错过几次只按最近一次
 * 处理，前面那几次就没响）；待触发（还没到点，或者到点了正等着响）
 */
export const CALENDAR_REMINDER_STATUSES = ["fired", "missed", "skipped", "upcoming"] as const;
export type CalendarReminderStatus = (typeof CALENDAR_REMINDER_STATUSES)[number];

export const CALENDAR_REMINDER_STATUS_LABEL: Readonly<Record<CalendarReminderStatus, string>> = { fired: "已触发", missed: "错过", skipped: "没响", upcoming: "待触发" };

/**
 * 日历上一次定时作业的状况。有运行记录的就是这次运行的状态（排队、运行中、成功、失败、中断、没运行）；没有运行记录的：
 * 预计（运营中的作业还没到点，或者到点了正等着触发）、已暂停（作业暂停着，到点不会跑，不算预计）、
 * 跳过（过了点却没有运行：停机期间错过几次只补跑最近一次、上一次还没跑完这一次跳过、那时作业暂停着……）
 */
export const CALENDAR_JOB_STATUSES = ["expected", "paused", "skipped", ...JOB_RUN_STATES] as const;
export type CalendarJobStatus = (typeof CALENDAR_JOB_STATUSES)[number];

export const CALENDAR_JOB_STATUS_LABEL: Readonly<Record<CalendarJobStatus, string>> = { expected: "预计", paused: "已暂停", skipped: "跳过", ...JOB_RUN_STATE_LABEL };

/** 日历格子上的小标记要的数：当天几条提醒、几次定时作业（已暂停、不会跑的不算）、有没有失败的作业 */
export interface CalendarDayCounts {
  reminders: number;
  jobs: number;
  failedJobs: number;
}

/** 一天的小标记：提醒数、作业数（已暂停的不算：它们不算预计，到点也不会跑）、失败的作业数 */
export function calendarDayCounts(day: { reminders: readonly unknown[]; jobs: readonly { status: CalendarJobStatus }[] }): CalendarDayCounts {
  return {
    reminders: day.reminders.length,
    jobs: day.jobs.filter((j) => j.status !== "paused").length,
    failedJobs: day.jobs.filter((j) => j.status === "failed").length,
  };
}

/** 年月选择里的年份：今年前后各几年 */
export const CALENDAR_YEAR_SPAN = 5;

/** 年月选择里能选的年份：今年前后各 CALENDAR_YEAR_SPAN 年；正在看的年份不在里面时也带上 */
export function calendarYearOptions(thisYear: number, viewing: number): number[] {
  const years = Array.from({ length: CALENDAR_YEAR_SPAN * 2 + 1 }, (_, i) => thisYear - CALENDAR_YEAR_SPAN + i);
  return years.includes(viewing) ? years : [...years, viewing].toSorted((a, b) => a - b);
}
