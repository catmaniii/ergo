// 日历（35 号票，规格第 19 节"日历"、第 21 节"工作日历"）：按月给出每一天的日历条目——工作日判定和原因（工作日历服务）、
// 当天的简单提醒（提醒模块的 calendar：时间表展开、这段时间的触发记录）、当天的定时作业（定时作业模块的 calendar：时间表展开、
// 这段时间的运行记录、作业的状态）。这里只把三样按天合起来、给每一次定状况；时间规则和工作日判定都是共享协议包的纯函数，
// 由各自的模块按当前的工作日历展开，这里不另算。
//
// - 从建的那一刻起：提醒从建的时候（改过时间表的，从最后一次改的时候）起展开，作业从登记的时候起展开，之前的日子上没有。
//   之前真响过、真跑过的照样列出（触发记录、运行记录对不上现在的时间表时，按它们自己的时刻单独列出）。
// - 每一次的状况（名字见协议包的 calendar.ts）：
//   - 提醒：有触发记录的是已触发（晚了的带着晚了几分钟）或错过；没有的，还没到点、或者到点了正等着响是待触发，过了点是没响。
//   - 作业：有运行记录的是这次运行的状态；没有的，还没到点、或者到点了正等着触发：运营中的是预计，暂停着的是已暂停；过了点是跳过。
//   - 已取消的提醒、作业不出现（它们各自的 calendar 就不给）。
// - asOf：算的时候任务看板、工作日历两个频道最后一条事件的序号。整个计算是一次同步调用，读到的就是这两个序号时的样子；
//   前端收到序号更大的提醒、作业或工作日历事件，就知道手里这份旧了。
import {
  type CalendarDay,
  type CalendarJobEntry,
  type CalendarMonthView,
  type CalendarReminderEntry,
  CHANNELS,
  type JobRun,
  localDate,
  parseMonthKey,
} from "@ergou/protocol";
import { RequestRejected } from "../errors.ts";
import type { EventStore } from "../events/event-store.ts";
import type { ReminderCalendarEntry, ReminderService } from "../reminders/reminders.ts";
import type { JobCalendarEntry, ScheduledJobs } from "../scheduled-jobs/index.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { WorkdayCalendarService } from "../workday/index.ts";

export interface CalendarService {
  /** 某个月（YYYY-MM）每一天的日历条目；月份写法不对抛 RequestRejected（bad_params） */
  month(month: string): CalendarMonthView;
}

export interface CalendarOptions {
  store: Pick<EventStore, "lastSeq">;
  workdayCalendar: Pick<WorkdayCalendarService, "current">;
  reminders: Pick<ReminderService, "calendar">;
  scheduledJobs: Pick<ScheduledJobs, "calendar">;
  clock: Pick<Clock, "now">;
}

const ms = (iso: string) => Date.parse(iso);

/** 按时刻排，同一时刻按名字 */
const byTime = <T extends { at: string }>(name: (x: T) => string) => (a: T, b: T) => ms(a.at) - ms(b.at) || name(a).localeCompare(name(b));

/** 一条提醒在这段时间里的每一次 */
function reminderEntries({ reminder, since, occurrences, firings }: ReminderCalendarEntry, now: number): CalendarReminderEntry[] {
  const base = { reminderId: reminder.id, text: reminder.text, schedule: reminder.schedule };
  const unmatched = new Map(firings.map((f) => [ms(f.dueAt), f]));
  const entries: CalendarReminderEntry[] = [];
  const fired = (f: (typeof firings)[number]): CalendarReminderEntry => ({ ...base, at: f.dueAt, status: f.change, ...(f.lateMinutes === undefined ? {} : { lateMinutes: f.lateMinutes }) });
  for (const at of occurrences) {
    const t = ms(at);
    const firing = unmatched.get(t);
    if (firing) {
      unmatched.delete(t);
      entries.push(fired(firing));
      continue;
    }
    // 现在的时间表生效之前的不算
    if (t <= ms(since)) continue;
    const waiting = reminder.status === "pending" && (t > now || (reminder.nextAt !== undefined && t >= ms(reminder.nextAt)));
    entries.push({ ...base, at, status: waiting ? "upcoming" : "skipped" });
  }
  return [...entries, ...[...unmatched.values()].map(fired)];
}

/** 一个作业在这段时间里的每一次 */
function jobEntries({ job, occurrences, runs }: JobCalendarEntry, now: number): CalendarJobEntry[] {
  const base = { jobId: job.id, title: job.title, schedule: job.schedule, ...(job.projectId === undefined ? {} : { projectId: job.projectId }), ...(job.projectName === undefined ? {} : { projectName: job.projectName }) };
  // 同一个触发时间按理只有一次运行；万一有几次，按先后一一对上
  const unmatched = new Map<number, JobRun[]>();
  for (const run of runs) unmatched.set(ms(run.dueAt), [...(unmatched.get(ms(run.dueAt)) ?? []), run]);
  const ran = (run: JobRun): CalendarJobEntry => ({ ...base, at: run.dueAt, status: run.state, run });
  const entries: CalendarJobEntry[] = [];
  for (const at of occurrences) {
    const t = ms(at);
    const run = unmatched.get(t)?.shift();
    if (run) {
      entries.push(ran(run));
      continue;
    }
    // 登记之前的不算
    if (t <= ms(job.createdAt)) continue;
    const waiting = t > now || (job.nextAt !== undefined && t >= ms(job.nextAt));
    entries.push({ ...base, at, status: !waiting ? "skipped" : job.state === "paused" ? "paused" : "expected" });
  }
  return [...entries, ...[...unmatched.values()].flat().map(ran)];
}

export function createCalendarService(options: CalendarOptions): CalendarService {
  const { store, workdayCalendar, reminders, scheduledJobs, clock } = options;
  return {
    month(month) {
      let year: number;
      let mon: number;
      try {
        ({ year, month: mon } = parseMonthKey(month));
      } catch (err) {
        throw new RequestRejected("bad_params", err instanceof Error ? err.message : String(err));
      }
      const from = new Date(year, mon - 1, 1);
      const to = new Date(year, mon, 1);
      const now = clock.now();
      const calendar = workdayCalendar.current();
      const days = new Map<string, CalendarDay>(calendar.month(year, mon).map((verdict) => [verdict.date, { date: verdict.date, verdict, reminders: [], jobs: [] }]));
      const dayOf = (at: string) => days.get(localDate(new Date(at)));
      for (const entry of reminders.calendar(from, to)) for (const r of reminderEntries(entry, now)) dayOf(r.at)?.reminders.push(r);
      for (const entry of scheduledJobs.calendar(from, to)) for (const j of jobEntries(entry, now)) dayOf(j.at)?.jobs.push(j);
      for (const day of days.values()) {
        day.reminders.sort(byTime((r) => r.text));
        day.jobs.sort(byTime((j) => j.title));
      }
      return {
        month,
        days: [...days.values()],
        missing: calendar.missing(year),
        asOf: { board: store.lastSeq(CHANNELS.board), workdayCalendar: store.lastSeq(CHANNELS.workdayCalendar) },
      };
    },
  };
}
