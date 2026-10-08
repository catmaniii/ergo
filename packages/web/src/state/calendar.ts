// 日历（纯函数，35 号票）：主导航的日历页。
// - 守护进程按月给出每一天的日历条目（HTTP，CalendarMonthView：工作日判定和原因、当天的提醒、当天的定时作业）。页面取回的一个月
//   作为 calendar_month 输入并进状态层；提醒、作业的变化是任务看板频道上的事件，工作日历的变化是工作日历频道上的事件——
//   收到序号比手里这份记着的（asOf）大的这些事件，这份就旧了（calendarMonthOf 的 stale），页面重新取。
//   重复规则、工作日判定都在守护进程那边按共享协议包的纯函数展开，这里不另算。
// - 格子上的样子（calendarCells）：上班或休息、原因的短词、手动标记、当天几条提醒、几次定时作业（已暂停的不算）、有没有失败的作业；
// - 某一天的详情（calendarDayDetail）：工作日判定和原因、节假日、缺数据的提示、当天的提醒（时间、内容、触发没有）、
//   当天的定时作业（几点、属于哪个项目、这一次的结果或预计）；点作业去它在看板或项目页上的位置（jobPlace）。
// - 年月选择（calendarYearChoices）：今年前后若干年，缺节假日数据的年份标出来（工作日历频道上的节假日数据）。
import {
  CALENDAR_JOB_STATUS_LABEL,
  CALENDAR_REMINDER_STATUS_LABEL,
  type CalendarJobEntry,
  type CalendarJobStatus,
  type CalendarMonthView,
  type CalendarReminderEntry,
  type CalendarReminderStatus,
  calendarDayCounts,
  calendarYearOptions,
  clockLabel,
  dayReasonLabel,
  dayShortLabel,
  describeDuration,
  describeLocalDate,
  describeSchedule,
  HOLIDAY_REGION_LABEL,
  isManualDay,
  isRepeating,
  JOB_RUN_TRIGGER_LABEL,
  missingHolidayDataText,
  parseLocalDate,
} from "./protocol.ts";
import type { UiState } from "./ui-state.ts";
import { workdayCalendarOf } from "./workday.ts";

/** 状态层里的日历：取回的每个月（键是 YYYY-MM），和最近一条会让日历变的事件的序号（任务看板上的提醒和作业、工作日历） */
export interface CalendarState {
  readonly months: Readonly<Record<string, CalendarMonthView>>;
  readonly changedAt: { readonly board: number; readonly workdayCalendar: number };
}

export const initialCalendarState: CalendarState = { months: {}, changedAt: { board: 0, workdayCalendar: 0 } };

/** 某个月的日历：取回的那一份（还没取过是 undefined），和它是不是旧了（还没取过也算旧：要去取） */
export interface CalendarMonthState {
  view: CalendarMonthView | undefined;
  stale: boolean;
}

export function calendarMonthOf(state: UiState, month: string): CalendarMonthState {
  const view = state.calendar.months[month];
  const { board, workdayCalendar } = state.calendar.changedAt;
  return { view, stale: view === undefined || view.asOf.board < board || view.asOf.workdayCalendar < workdayCalendar };
}

/** 日历格子 */
export interface CalendarCell {
  date: string;
  /** 几号 */
  day: number;
  workday: boolean;
  /** 手动标记的（上班或休息） */
  manual: boolean;
  /** 原因的短词：工作日、新加坡、国内、补班、规则、手动、假期的名字、周末 */
  short: string;
  /** 悬停和读屏的完整说法："10 月 8 日 上班 · 新加坡工作日、国内工作日 · 2 条提醒 · 1 次定时作业" */
  label: string;
  reminders: number;
  jobs: number;
  /** 当天失败的作业有几次（格子上标出来） */
  failedJobs: number;
}

export function calendarCells(view: CalendarMonthView): CalendarCell[] {
  return view.days.map((d) => {
    const counts = calendarDayCounts(d);
    const { month, day } = parseLocalDate(d.date);
    const parts = [
      `${month} 月 ${day} 日 ${d.verdict.workday ? "上班" : "休息"} · ${d.verdict.reasons.map(dayReasonLabel).join("、")}`,
      ...(counts.reminders > 0 ? [`${counts.reminders} 条提醒`] : []),
      ...(counts.jobs > 0 ? [`${counts.jobs} 次定时作业`] : []),
      ...(counts.failedJobs > 0 ? [`${counts.failedJobs} 次失败`] : []),
    ];
    return { date: d.date, day, workday: d.verdict.workday, manual: isManualDay(d.verdict), short: dayShortLabel(d.verdict), label: parts.join(" · "), ...counts };
  });
}

/** 详情里的一条提醒 */
export interface CalendarReminderRow {
  key: string;
  /** 几点：09:30 */
  time: string;
  text: string;
  status: CalendarReminderStatus;
  /** "已触发"、"已触发 · 晚了 20 分钟"、"错过 · 晚了 2 小时 20 分钟，放在了待我处理"、"没响"、"待触发" */
  statusText: string;
  /** 重复的写时间表（每天 07:00、按我的工作日 09:30）；一次性的没有 */
  repeat: string | undefined;
}

/** 详情里的一次定时作业 */
export interface CalendarJobRow {
  key: string;
  jobId: string;
  time: string;
  title: string;
  /** "项目「资讯站」"或"不属于项目" */
  project: string;
  projectId: string | undefined;
  status: CalendarJobStatus;
  /** "预计 09:00 运行"、"成功"、"失败：新闻源打不开"、"开机补跑（错过 3 次）· 成功"、"已暂停"、"跳过" */
  statusText: string;
  failed: boolean;
  /** 时间表：每天 09:00 */
  schedule: string;
}

/** 某一天的详情 */
export interface CalendarDayDetail {
  date: string;
  /** 2026 年 10 月 8 日（周四） */
  title: string;
  workday: boolean;
  manual: boolean;
  /** 上班或休息的原因："新加坡工作日"、"国内假期：国庆节"、"手动标记休息"…… */
  reasons: string[];
  /** 当天两边的节假日："国内：国庆节" */
  holidays: string[];
  /** 这一年缺节假日数据时的提示 */
  missing: string | undefined;
  reminders: CalendarReminderRow[];
  jobs: CalendarJobRow[];
}

function reminderRow(r: CalendarReminderEntry): CalendarReminderRow {
  const label = CALENDAR_REMINDER_STATUS_LABEL[r.status];
  const late = r.lateMinutes ? ` · 晚了 ${describeDuration(r.lateMinutes)}` : "";
  const statusText = r.status === "missed" ? `${label}${late}，放在了待我处理` : `${label}${late}`;
  return { key: `${r.reminderId}@${r.at}`, time: clockLabel(r.at), text: r.text, status: r.status, statusText, repeat: isRepeating(r.schedule) ? describeSchedule(r.schedule) : undefined };
}

function jobStatusText(j: CalendarJobEntry): string {
  if (j.status === "expected") return `预计 ${clockLabel(j.at)} 运行`;
  const label = CALENDAR_JOB_STATUS_LABEL[j.status];
  const run = j.run;
  if (!run) return label;
  const catchUp = run.trigger === "catch_up" ? `${JOB_RUN_TRIGGER_LABEL.catch_up}${run.missed ? `（错过 ${run.missed} 次）` : ""} · ` : "";
  // 失败、中断、没运行写上原因
  const reason = run.reason && (run.state === "failed" || run.state === "interrupted" || run.state === "dropped") ? `：${run.reason}` : "";
  return `${catchUp}${label}${reason}`;
}

function jobRow(j: CalendarJobEntry): CalendarJobRow {
  return {
    key: `${j.jobId}@${j.at}`,
    jobId: j.jobId,
    time: clockLabel(j.at),
    title: j.title,
    project: j.projectId === undefined ? "不属于项目" : `项目「${j.projectName ?? j.projectId}」`,
    projectId: j.projectId,
    status: j.status,
    statusText: jobStatusText(j),
    failed: j.status === "failed",
    schedule: describeSchedule(j.schedule),
  };
}

/** 某一天的详情；这个月里没有这一天时是 undefined */
export function calendarDayDetail(view: CalendarMonthView, date: string): CalendarDayDetail | undefined {
  const d = view.days.find((x) => x.date === date);
  if (!d) return undefined;
  const { verdict } = d;
  return {
    date,
    title: describeLocalDate(date),
    workday: verdict.workday,
    manual: isManualDay(verdict),
    reasons: verdict.reasons.map(dayReasonLabel),
    holidays: verdict.holidays.map((h) => `${HOLIDAY_REGION_LABEL[h.region]}：${h.name}`),
    missing: verdict.missing.length > 0 ? missingHolidayDataText(parseLocalDate(date).year, verdict.missing) : undefined,
    reminders: d.reminders.map(reminderRow),
    jobs: d.jobs.map(jobRow),
  };
}

/** 点一次作业去哪：属于项目的去项目页上它那一行，不属于项目的去看板上它的作业卡 */
export type JobPlace = { kind: "project"; projectId: string; jobId: string } | { kind: "board"; jobId: string };

export function jobPlace(row: Pick<CalendarJobRow, "jobId" | "projectId">): JobPlace {
  return row.projectId === undefined ? { kind: "board", jobId: row.jobId } : { kind: "project", projectId: row.projectId, jobId: row.jobId };
}

/** 年月选择里的一个年份：缺节假日数据的写明缺哪边 */
export interface CalendarYearChoice {
  year: number;
  /** "缺 2027 年国内节假日数据"；不缺、或者还没收到节假日数据时没有 */
  missing: string | undefined;
}

/** 年月选择里的年份：今年前后若干年（正在看的年份不在里面时也带上），缺节假日数据的标出来 */
export function calendarYearChoices(state: UiState, thisYear: number, viewing: number): CalendarYearChoice[] {
  const calendar = workdayCalendarOf(state);
  return calendarYearOptions(thisYear, viewing).map((year) => {
    const missing = calendar?.missing(year) ?? [];
    return { year, missing: missing.length > 0 ? missingHolidayDataText(year, missing) : undefined };
  });
}
