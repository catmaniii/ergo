// 日历（35 号票，规格第 19 节"日历"、第 21 节"工作日历"）：按月给出每一天的日历条目——工作日判定和原因（工作日历服务）、
// 当天的简单提醒（提醒模块的 calendar：时间表展开、这段时间的触发记录）、当天的定时作业（定时作业模块的 calendar：时间表展开、
// 这段时间的运行记录、作业的状态）。这里只把三样按天合起来、给每一次定状况；时间规则和工作日判定都是共享协议包的纯函数，
// 由各自的模块按当前的工作日历展开，这里不另算。
//
// - 从建的那一刻起：提醒从建的时候（改过时间表的，从最后一次改的时候）起展开，作业从登记的时候（用户改过时间表的，从最后一次改的时候，
//   98 号票）起展开，之前的日子上没有。
//   之前真响过、真跑过的照样列出（触发记录、运行记录对不上现在的时间表时，按它们自己的时刻单独列出）。
// - 每一次的状况（名字见协议包的 calendar.ts）：
//   - 提醒：有触发记录的是已触发（晚了的带着晚了几分钟）或错过；没有的，还没到点、或者到点了正等着响是待触发，过了点是没响。
//   - 作业：有运行记录的是这次运行的状态；没有的，还没到点、或者到点了正等着触发：运营中的是预计，暂停着的是已暂停；过了点是跳过。
//   - 已取消的提醒、作业不出现（它们各自的 calendar 就不给）。
// - asOf：算的时候任务看板、工作日历两个频道最后一条事件的序号。整个计算是一次同步调用，读到的就是这两个序号时的样子；
//   前端收到序号更大的提醒、作业或工作日历事件，就知道手里这份旧了。
// - 126 号票起提醒是插件：提醒的服务经插件宿主按名字现取（reminders/api.ts 的 REMINDERS），提醒插件没启用时每天的提醒都是空的，
//   工作日判定和定时作业照常。
// - 213 号票起日历自己也是插件（calendar/plugin.ts）：这里的服务由日历插件装配时建，提醒是它的可选依赖（wants），每次现取；
//   网关的 GET /api/calendar 经插件宿主按服务名 CALENDAR（calendar/api.ts）现取，日历插件没启用时回"日历插件没启用"。
//   日历只是合起来看的视图，不拥有数据：工作日历、工作日判定、定时作业都是内核的。
// - 299 号票起还有外部日历：数据源（手机日历；297 号票的 Google 日历同样）交来的日程，经内核现取（KERNEL.externalCalendars），
//   按天放进 external（跨几天的每天各一次，按开始排）；没有外部日程的一天不带这一项。只读、不进素材。外部日程的变化不在这两个频道上：
//   306 号票起 asOf 多了 external（外部日程的版本，内核现取），数据源那边一变工作日历频道上推临时事件 external_calendar 带新的版本，
//   开着的日历页不用换月就重新取。
import {
  type CalendarDay,
  type CalendarExternalEntry,
  type CalendarJobEntry,
  type CalendarMonthView,
  type CalendarReminderEntry,
  CHANNELS,
  type JobRun,
  localDate,
  parseMonthKey,
  runEvents,
  TIME_TRIGGER_SOURCE,
} from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";
import type { EventStore } from "../events/event-store.ts";
import type { ReminderCalendarEntry, ReminderService } from "../reminders/api.ts";
import type { JobCalendarEntry, ScheduledJobs } from "../scheduled-jobs/index.ts";
import type { ExternalCalendars } from "../plugins/kernel.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { WorkdayCalendarService } from "../workday/index.ts";

export interface CalendarService {
  /** 某个月（YYYY-MM）每一天的日历条目；月份写法不对抛 RequestRejected（bad_params） */
  month(month: string): CalendarMonthView;
}

export interface CalendarOptions {
  store: Pick<EventStore, "lastSeq">;
  workdayCalendar: Pick<WorkdayCalendarService, "current">;
  /** 提醒插件提供的服务（可选依赖：每次现取，提醒插件没启用时是 undefined，每天的提醒是空的） */
  reminders: () => Pick<ReminderService, "calendar"> | undefined;
  scheduledJobs: Pick<ScheduledJobs, "calendar">;
  clock: Pick<Clock, "now">;
  /** 外部日历（299 号票）：数据源交来的日程和它的版本（306 号票） */
  external: Pick<ExternalCalendars, "events" | "version">;
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

/** 一次运行处理的那几次到点（76 号票：排队合并了几次的，每一次都算这次运行的；之前的运行只有 dueAt 那一次） */
const runTimes = (run: JobRun): string[] => runEvents(run).filter((e) => e.source === TIME_TRIGGER_SOURCE).map((e) => e.at);

/** 一个定时触发的任务在这段时间里的每一次 */
function jobEntries({ job, since, occurrences, runs }: JobCalendarEntry, now: number): CalendarJobEntry[] {
  const base = {
    jobId: job.id,
    ...(job.ownerTaskId === undefined ? {} : { taskId: job.ownerTaskId }),
    title: job.title,
    schedule: job.schedule,
    ...(job.projectId === undefined ? {} : { projectId: job.projectId }),
    ...(job.projectName === undefined ? {} : { projectName: job.projectName }),
  };
  // 同一个触发时间按理只有一次运行；万一有几次，按先后一一对上。排队合并进来的那几次到点，算处理它们的那次运行的
  const unmatched = new Map<number, JobRun[]>();
  for (const run of runs) for (const at of runTimes(run)) unmatched.set(ms(at), [...(unmatched.get(ms(at)) ?? []), run]);
  const used = new Set<string>();
  const ran = (run: JobRun, at = run.dueAt): CalendarJobEntry => ({ ...base, at, status: run.state, run });
  const entries: CalendarJobEntry[] = [];
  for (const at of occurrences) {
    const t = ms(at);
    const run = unmatched.get(t)?.shift();
    if (run) {
      used.add(run.runId);
      entries.push(ran(run, at));
      continue;
    }
    // 现在的时间表生效之前（登记之前、用户最后一次改时间表之前）的不算
    if (t <= ms(since)) continue;
    const waiting = t > now || (job.nextAt !== undefined && t >= ms(job.nextAt));
    entries.push({ ...base, at, status: !waiting ? "skipped" : job.state === "paused" ? "paused" : "expected" });
  }
  // 对不上现在的时间表的运行（时间表改过、开机补跑的……）按它自己的触发时间单独列出，每次运行只列一次
  const leftover = [...new Map([...unmatched.values()].flat().filter((r) => !used.has(r.runId)).map((r) => [r.runId, r])).values()];
  return [...entries, ...leftover.map((r) => ran(r))];
}

/** 一条外部日程落在哪几天（本地日期）：开始那天到结束前一刻那天；没有结束的只有开始那天。最多算 62 天 */
function externalDays(entry: CalendarExternalEntry): string[] {
  const start = new Date(entry.at);
  if (Number.isNaN(start.getTime())) return [];
  const endMs = entry.end === undefined ? Number.NaN : Date.parse(entry.end);
  const last = Number.isNaN(endMs) || endMs <= start.getTime() ? start : new Date(endMs - 1);
  const days: string[] = [];
  for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d <= last && days.length < 62; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push(localDate(d));
  return days;
}

export function createCalendarService(options: CalendarOptions): CalendarService {
  const { store, workdayCalendar, reminders, scheduledJobs, clock, external } = options;
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
      for (const entry of reminders()?.calendar(from, to) ?? []) for (const r of reminderEntries(entry, now)) dayOf(r.at)?.reminders.push(r);
      for (const entry of scheduledJobs.calendar(from, to)) for (const j of jobEntries(entry, now)) dayOf(j.at)?.jobs.push(j);
      // 外部日程的版本先取（下面现取的日程不会比它旧）
      const externalVersion = external.version();
      for (const entry of external.events(from, to)) {
        for (const date of externalDays(entry)) {
          const day = days.get(date);
          if (day) (day.external ??= []).push(entry);
        }
      }
      for (const day of days.values()) {
        day.reminders.sort(byTime((r) => r.text));
        day.jobs.sort(byTime((j) => j.title));
        day.external?.sort(byTime((e) => e.title));
      }
      return {
        month,
        days: [...days.values()],
        missing: calendar.missing(year),
        asOf: { board: store.lastSeq(CHANNELS.board), workdayCalendar: store.lastSeq(CHANNELS.workdayCalendar), external: externalVersion },
      };
    },
  };
}
