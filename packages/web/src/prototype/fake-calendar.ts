// 原型用的假日历（35 号票，直接打开构建产物、没有守护进程时）：守护进程按月给出的每一天的日历条目，这里用假连接里的
// 节假日数据和个人设置算工作日判定，几条假的提醒和定时作业（和看板上的假条目同名）用共享协议包的时间规则展开到当天：
// 过了点的算响过、跑过（有一天的账单汇总失败），没到点的是待触发、预计，暂停着的是已暂停。
import {
  type CalendarDay,
  type CalendarJobEntry,
  type CalendarMonthView,
  type CalendarReminderEntry,
  type HolidayYear,
  localDate,
  occurrencesBetween,
  parseMonthKey,
  type ReminderSchedule,
  workdayCalendar,
  type WorkdaySettings,
} from "../state/index.ts";
import { nowIso } from "../util/time.ts";

const FAKE_REMINDERS: { id: string; text: string; schedule: ReminderSchedule }[] = [
  { id: "r-rent", text: "交房租", schedule: { kind: "monthly", time: "09:00", days: [8] } },
  { id: "r-weekly", text: "准备周会材料", schedule: { kind: "weekly", time: "17:30", weekdays: [1, 2, 3, 4, 5] } },
  { id: "r-run", text: "跑步", schedule: { kind: "weekly", time: "19:00", weekdays: [1, 3, 5] } },
];

/** 定时触发的任务的每一次（76 号票：带着任务的点开去任务详情；fake-conversations.ts 里的「每天早上出早报」）和还没迁移的旧作业 */
const FAKE_JOBS: { id: string; title: string; schedule: ReminderSchedule; taskId?: string; projectId?: string; projectName?: string; paused?: boolean }[] = [
  { id: "sj-daily-bills", title: "每天 21:00 汇总当天账单", schedule: { kind: "daily", time: "21:00" }, projectId: "p-ledger", projectName: "记账本" },
  { id: "j-brief", title: "每天早上出早报", schedule: { kind: "workdays", time: "08:00" }, taskId: "t-brief" },
  { id: "sj-monthly", title: "每月 1 号出月报", schedule: { kind: "monthly", time: "09:00", days: [1] }, projectId: "p-ledger", projectName: "记账本", paused: true },
];

/** 假的一个月：asOf 是假连接里两个频道的序号 */
export function fakeCalendarMonth(month: string, holidays: readonly HolidayYear[], settings: WorkdaySettings, asOf: CalendarMonthView["asOf"]): CalendarMonthView {
  const { year, month: m } = parseMonthKey(month);
  const calendar = workdayCalendar(holidays, settings);
  const context = { calendar };
  const from = new Date(year, m - 1, 1);
  const to = new Date(year, m, 1);
  const now = Date.now();
  const days = new Map<string, CalendarDay>(calendar.month(year, m).map((verdict) => [verdict.date, { date: verdict.date, verdict, reminders: [], jobs: [] }]));
  for (const r of FAKE_REMINDERS) {
    for (const at of occurrencesBetween(r.schedule, from, to, context)) {
      const entry: CalendarReminderEntry = { reminderId: r.id, text: r.text, schedule: r.schedule, at: nowIso(at), status: at.getTime() <= now ? "fired" : "upcoming" };
      days.get(localDate(at))?.reminders.push(entry);
    }
  }
  for (const j of FAKE_JOBS) {
    for (const at of occurrencesBetween(j.schedule, from, to, context)) {
      const due = nowIso(at);
      const base = { jobId: j.id, ...(j.taskId ? { taskId: j.taskId } : {}), title: j.title, schedule: j.schedule, ...(j.projectId ? { projectId: j.projectId, projectName: j.projectName } : {}), at: due };
      const past = at.getTime() <= now;
      // 账单汇总每月 6 号失败一次
      const failed = past && j.id === "sj-daily-bills" && at.getDate() === 6;
      const entry: CalendarJobEntry = past
        ? {
            ...base,
            status: failed ? "failed" : "done",
            run: { runId: `${j.id}-${localDate(at)}`, jobId: j.id, trigger: "scheduled", dueAt: due, state: failed ? "failed" : "done", queuedAt: due, ...(failed ? { reason: "银行导出的账单格式变了" } : {}) },
          }
        : { ...base, status: j.paused ? "paused" : "expected" };
      days.get(localDate(at))?.jobs.push(entry);
    }
  }
  for (const day of days.values()) {
    day.reminders.sort((a, b) => a.at.localeCompare(b.at));
    day.jobs.sort((a, b) => a.at.localeCompare(b.at));
  }
  return { month, days: [...days.values()], missing: calendar.missing(year), asOf };
}
