// 一次运行的触发和登记的来历（76 号票）：守护进程和 Web 共用这一处——
// - 时间到了的这次触发怎么说（timeTriggerSummary）；
// - 一次运行处理的一批触发（runEvents）：76 号票之前的运行没有记，按它自己那一次到点（或开机补跑）补上；其中事件来源推来的
//   （externalEvents：到点的、100 号票用户让它立即运行一次的不算）；
// - 触发登记怎么触发、在等什么（jobTriggerKind、jobTriggerDetail、jobTriggerText、jobTriggerLine）：定时的是时间表，
//   事件触发的（77 号票）是在等什么事件；简单提醒也用这几个；
// - 以前的定时作业（isLegacyJob）：76 号票之前长程任务计划里登记的，属于别的任务（建它的那个长程任务），
//   迁移之后由迁移出来的定时触发的普通任务（ownerTaskId）运行，每次运行照作业的定义和授权跑。
import { describeEventTrigger, type EventNames } from "./event-sources.ts";
import { describeSchedule, describeTime } from "./reminder-schedule.ts";
import type { JobRun, ScheduledJob, TriggerEvent } from "./scheduled-job-schema.ts";
import { MANUAL_TRIGGER_SOURCE, TIME_TRIGGER_SOURCE } from "./scheduled-jobs.ts";

/** 时间到了的这次触发怎么说："10 月 8 日（周四）09:00 到点"、"守护进程停机期间错过了 3 次（最近一次 …），开机补跑一次" */
export function timeTriggerSummary(kind: JobRun["trigger"], due: Date, missed?: number): string {
  const at = describeTime(due);
  if (kind !== "catch_up") return `${at} 到点`;
  return `守护进程停机期间错过了${missed !== undefined && missed > 1 ? ` ${missed} 次（最近一次 ${at}）` : ` ${at} 那次`}，开机补跑一次`;
}

/** 一次运行处理的一批触发（先后照来的顺序）；76 号票之前的运行只有 dueAt 那一次（到点或开机补跑） */
export function runEvents(run: Pick<JobRun, "events" | "dueAt" | "trigger" | "missed">): TriggerEvent[] {
  return run.events ?? [{ source: TIME_TRIGGER_SOURCE, at: run.dueAt, summary: timeTriggerSummary(run.trigger, new Date(run.dueAt), run.missed) }];
}

/** 用户让它立即运行一次（100 号票）的那次触发怎么说："10 月 12 日（周一）10:05 你让它立即运行一次" */
export function manualTriggerSummary(at: Date): string {
  return `${describeTime(at)} 你让它立即运行一次`;
}

/** 是不是事件来源推来的事件（时间到了的、用户让它立即运行一次的都不是：不带事件的值） */
export const isSourceEvent = (e: Pick<TriggerEvent, "source">): boolean => e.source !== TIME_TRIGGER_SOURCE && e.source !== MANUAL_TRIGGER_SOURCE;

/** 一次运行这一批里事件来源推来的事件（77 号票：流程照它们代入值、交给 agent 的结构化输入；到点的、手动的不算） */
export function externalEvents(run: Pick<JobRun, "events" | "dueAt" | "trigger" | "missed">): TriggerEvent[] {
  return runEvents(run).filter(isSourceEvent);
}

/** 76 号票之前长程任务计划里登记的定时作业（还没迁移的，或迁移成了定时触发的普通任务的）：它属于建它的任务，不是运行它的任务 */
export const isLegacyJob = (job: Pick<ScheduledJob, "taskId" | "ownerTaskId">): boolean => job.ownerTaskId !== job.taskId;

/** 怎么触发的："事件触发"（77 号票）或"定时触发"（秘书的看板、交给 agent 的通知、范围审视、看板卡共用） */
export const jobTriggerKind = (job: Pick<ScheduledJob, "event">): "事件触发" | "定时触发" => (job.event ? "事件触发" : "定时触发");

/** 在等什么：事件触发的是在等什么事件（"本机文件夹 …里新增 *.pdf 文件"），定时的是时间表（"每天 09:00"） */
export function jobTriggerDetail(job: Pick<ScheduledJob, "schedule" | "event">, names?: EventNames): string {
  if (job.event) return describeEventTrigger(job.event, names);
  return job.schedule ? describeSchedule(job.schedule) : "";
}

/**
 * 触发登记、简单提醒在等什么（看板卡、任务详情、提醒卡共用）："每天 09:00"；事件触发的（77 号票）"事件发生时：本机文件夹 …里新增 *.pdf 文件"
 */
export function jobTriggerText(job: Pick<ScheduledJob, "schedule" | "event">, names?: EventNames): string {
  return job.event ? `事件发生时：${jobTriggerDetail(job, names)}` : jobTriggerDetail(job, names);
}

/** 带上是哪一种的那一句（交给 agent 的通知、范围审视）："时间表：每天 09:00"、"事件发生时：…" */
export function jobTriggerLine(job: Pick<ScheduledJob, "schedule" | "event">, names?: EventNames): string {
  return job.event ? jobTriggerText(job, names) : `时间表：${jobTriggerDetail(job, names)}`;
}

/** 一次运行最后一个事件（看板卡上的"最近一次触发"）：事件触发的才有（用户让它立即运行一次的那次不算，100 号票） */
export function lastTriggerEvent(run: Pick<JobRun, "events" | "dueAt" | "trigger" | "missed"> | undefined): TriggerEvent | undefined {
  if (!run) return undefined;
  return runEvents(run).findLast(isSourceEvent);
}

