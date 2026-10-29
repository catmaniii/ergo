// 日历（35 号票）的 schema：守护进程按月给出的每一天的日历条目（GET /api/calendar?month=YYYY-MM 的响应）。
// 名字、说法和纯函数在 calendar.ts。
// 299 号票加了外部日历（CalendarExternalEntry）：数据源交给日历插件显示的日程（手机日历；297 号票的 Google 日历同样），只读、不进素材。
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

/** 日历上定时触发的任务的一次（35 号票时叫定时作业）：时间表展开到这一天的那一次，跑过的带着这次的运行记录 */
export const CalendarJobEntry = Type.Object({
  jobId: Type.String(),
  /** 属于哪个定时触发的任务（76 号票：日历上点它打开任务详情）；没迁移的定时作业没有 */
  taskId: Type.Optional(Type.String()),
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

/**
 * 日历上外部日历的一条日程（299 号票）：数据源（手机日历、Google 日历……）交给日历插件显示的，只读、不进记忆素材。
 * 跨几天的每天各列一次（at 是这条日程本来的开始，不是这一天）
 */
export const CalendarExternalEntry = Type.Object({
  /** 哪个数据源（id）和它给人看的名字（"手机 · 日历"：标出来自哪里） */
  source: Type.String(),
  sourceTitle: Type.String(),
  /** 数据源里的哪个日历（手机里的日历账户名；没有不写） */
  calendar: Type.Optional(Type.String()),
  /** 数据源给的编号（同一条日程的同一次不变） */
  id: Type.String(),
  title: Type.String(),
  /** 开始、结束（协议时间；没有结束的是一个时刻） */
  at: Type.String(),
  end: Type.Optional(Type.String()),
  /** 全天的 */
  allDay: Type.Boolean(),
  location: Type.Optional(Type.String()),
});
export type CalendarExternalEntry = Static<typeof CalendarExternalEntry>;

/** 日历上的一天：上班还是休息及原因，当天的提醒和定时作业（都按时刻排好）；299 号票起还有外部日历的日程（有才带） */
export const CalendarDay = Type.Object({
  date: LocalDate,
  verdict: DayVerdict,
  reminders: Type.Array(CalendarReminderEntry),
  jobs: Type.Array(CalendarJobEntry),
  external: Type.Optional(Type.Array(CalendarExternalEntry)),
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
   * 工作日历的变化是工作日历频道上的事件：前端收到序号更大的这些事件，就知道手里这份旧了，重新取。
   * 306 号票起还有 external：外部日程（数据源交来的）的版本——不是事件序号，是守护进程内存里只增不减的数（毫秒时间起步，
   * 重启后照样比以前的大）；工作日历频道上的临时事件 external_calendar 带着新的版本，比这份记着的大就旧了
   */
  asOf: Type.Object({ board: Type.Integer({ minimum: 0 }), workdayCalendar: Type.Integer({ minimum: 0 }), external: Type.Integer({ minimum: 0 }) }),
});
export type CalendarMonthView = Static<typeof CalendarMonthView>;

/** 外部日程变了（工作日历频道的临时事件 external_calendar，306 号票）：新的版本，和 CalendarMonthView.asOf.external 比 */
export interface ExternalCalendarEventPayload {
  version: number;
}
