// 日历（35 号票）的 schema：守护进程按月给出的每一天的日历条目（GET /api/calendar?month=YYYY-MM 的响应）。
// 名字、说法和纯函数在 calendar.ts。
import { type Static, Type } from "typebox";
import { CALENDAR_JOB_STATUSES, CALENDAR_REMINDER_STATUSES, MONTH_KEY_PATTERN } from "./calendar.ts";
import { ReminderSchedule } from "./reminder-schedule.ts";
import { JobRun } from "./scheduled-job-schema.ts";
import { DayVerdict, HOLIDAY_REGIONS, LocalDate } from "./workday-calendar.ts";

/** 日历上的一次简单提醒：一次性的那一次，或者重复的展开到这一天的那一次 */
export const CalendarReminderEntry = Type.Object({
  reminderId: Type.String(),
  text: Type.String(),
  schedule: ReminderSchedule,
  /** 这一次该响的时刻（协议时间） */
  at: Type.String(),
  status: Type.Enum(CALENDAR_REMINDER_STATUSES),
  /** 晚了才响的（守护进程那时没在运行）：晚了几分钟 */
  lateMinutes: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type CalendarReminderEntry = Static<typeof CalendarReminderEntry>;

/** 日历上的一次定时作业：时间表展开到这一天的那一次，跑过的带着这次的运行记录 */
export const CalendarJobEntry = Type.Object({
  jobId: Type.String(),
  title: Type.String(),
  schedule: ReminderSchedule,
  /** 属于哪个项目（不属于项目的没有：由作业自己的维护者执行） */
  projectId: Type.Optional(Type.String()),
  projectName: Type.Optional(Type.String()),
  /** 这一次该跑的时刻：时间表上的那一刻（有运行记录的就是它的触发时间） */
  at: Type.String(),
  status: Type.Enum(CALENDAR_JOB_STATUSES),
  /** 这一次的运行记录（还没跑、跳过的没有） */
  run: Type.Optional(JobRun),
});
export type CalendarJobEntry = Static<typeof CalendarJobEntry>;

/** 日历上的一天：上班还是休息及原因，当天的提醒和定时作业（都按时刻排好） */
export const CalendarDay = Type.Object({
  date: LocalDate,
  verdict: DayVerdict,
  reminders: Type.Array(CalendarReminderEntry),
  jobs: Type.Array(CalendarJobEntry),
});
export type CalendarDay = Static<typeof CalendarDay>;

/** 一个月的日历（GET /api/calendar?month=YYYY-MM） */
export const CalendarMonthView = Type.Object({
  month: Type.String({ pattern: MONTH_KEY_PATTERN }),
  days: Type.Array(CalendarDay),
  /** 这一年缺哪边的节假日数据（缺的那边按周一到周五算） */
  missing: Type.Array(Type.Enum(HOLIDAY_REGIONS)),
  /**
   * 算这份日历时任务看板、工作日历两个频道最后一条事件的序号。提醒、定时作业的变化都是任务看板频道上的事件，
   * 工作日历的变化是工作日历频道上的事件：前端收到序号更大的这些事件，就知道手里这份旧了，重新取
   */
  asOf: Type.Object({ board: Type.Integer({ minimum: 0 }), workdayCalendar: Type.Integer({ minimum: 0 }) }),
});
export type CalendarMonthView = Static<typeof CalendarMonthView>;
