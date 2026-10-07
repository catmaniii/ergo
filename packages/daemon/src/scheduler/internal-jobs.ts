// 内部作业（规格第 13 节）：守护进程自己按时间表做的事——每晚备份、每周校验最新快照、每天清理临时区，
// 以后还有归档清单（19）、回避信号计时（08）、授权到期提醒（14）。挂在调度器上，不用 Windows 计划任务。
//
// 时间表用简单提醒的那一套时间规则（共享协议包 reminder-schedule.ts 的 ReminderSchedule 和 nextOccurrence），
// 时间规则只在那一个模块里。
//
// 错过的开机后补一次：每个作业上一次开始跑的时间记在事件日志里（内部频道 internal 上的 internal_job 事件，不推给前端），
// 守护进程启动时看"上一次之后的下一次"过没过点（nextDue）：过了就马上补跑一次，没过就登记到那个时刻。
// 停机期间错过好几次也只补一次（跑完之后的下一次从跑完的那一刻往后算）；补完再重启不会再补。
// 第一次见到某个作业时只记下"从现在起算"，不马上跑（新的数据目录不会一启动就备份）。
//
// 作业的 run 是异步的。跑完（成功或失败都算跑过；失败由作业自己报告）记一次，再登记下一次。
// 守护进程停止时中止信号（AbortSignal）置位，作业因此中止（抛 AbortError）的不算跑过，下次启动照常补。
import { nextOccurrence, nowIso, type ReminderSchedule } from "@ergou/protocol";
import type { DerivedView, EventStore } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import type { Clock } from "./clock.ts";
import type { Scheduler } from "./scheduler.ts";

/** 内部频道：只在事件日志里，不在前端协议里，前端订阅不到 */
export const INTERNAL_CHANNEL = "internal";
export const INTERNAL_JOB_EVENT = "internal_job";

/** 一个内部作业的状态（internal_job 事件的负载就是它的最新状态） */
export interface InternalJobState {
  job: string;
  /** 第一次见到这个作业的时间：还没跑过时从这里算下一次 */
  since: string;
  /** 上一次开始跑的时间 */
  lastRunAt?: string;
}

/** 这次为什么跑：到点了，还是启动时补错过的 */
export type JobTrigger = "scheduled" | "catch_up";

export interface InternalJob {
  /** 作业名（也是调度器里的 key 的一部分），比如 backup */
  name: string;
  /** 时间表：和简单提醒同一种（每天、每周几……） */
  schedule: ReminderSchedule;
  /** 跑一次；signal 在守护进程停止时置位，作业要尽快停下（抛 AbortError） */
  run(trigger: JobTrigger, signal: AbortSignal): Promise<unknown>;
}

export interface InternalJobs {
  /** 登记一个作业：错过了就马上补跑一次，否则登记到下一次 */
  register(job: InternalJob): void;
  state(name: string): InternalJobState | undefined;
  /** 正在跑的作业都跑完（连同记下"跑过了"） */
  whenIdle(): Promise<void>;
  /** 中止正在跑的作业、取消计时器，等它们停下 */
  stop(): Promise<void>;
}

export interface InternalJobsOptions {
  store: EventStore;
  scheduler: Scheduler;
  clock: Clock;
  log: (line: string) => void;
}

/**
 * 错过了没有：上一次（还没跑过就是开始算的那一刻）之后的下一次，不晚于 now 就是错过了——启动时马上补一次；
 * 错过好几次也只算这一次。没有下一次（一次性的已经过了）是 undefined。纯函数，19 号票的定时作业也直接用它。
 */
export function nextDue(schedule: ReminderSchedule, last: Date, now: Date): { at: Date; missed: boolean } | undefined {
  const at = nextOccurrence(schedule, last);
  return at && { at, missed: at.getTime() <= now.getTime() };
}

export const internalJobsView: DerivedView = {
  name: "internal_jobs",
  create: (db) => db.exec("CREATE TABLE IF NOT EXISTS internal_jobs (job TEXT PRIMARY KEY, state TEXT NOT NULL)"),
  clear: (db) => db.exec("DELETE FROM internal_jobs"),
  apply(db, event) {
    if (event.channel !== INTERNAL_CHANNEL || event.type !== INTERNAL_JOB_EVENT) return;
    const state = event.payload as InternalJobState;
    db.run("INSERT INTO internal_jobs (job, state) VALUES (?, ?) ON CONFLICT (job) DO UPDATE SET state = excluded.state", state.job, JSON.stringify(state));
  },
};

const iso = (ms: number) => nowIso(new Date(ms));
/** 调度器里的 key */
const keyOf = (job: InternalJob) => `internal:${job.name}`;
const describe = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));
const isAbort = (err: unknown) => err instanceof Error && err.name === "AbortError";

function getJobState(db: ReadonlyDatabase, job: string): InternalJobState | undefined {
  const row = db.get<{ state: string }>("SELECT state FROM internal_jobs WHERE job = ?", job);
  return row && (JSON.parse(row.state) as InternalJobState);
}

export function createInternalJobs(options: InternalJobsOptions): InternalJobs {
  const { store, scheduler, clock, log } = options;
  const controller = new AbortController();
  const running = new Set<Promise<void>>();
  const keys = new Set<string>();

  const record = (state: InternalJobState) => store.append({ channel: INTERNAL_CHANNEL, type: INTERNAL_JOB_EVENT, payload: state });

  /** 从 after 起算下一次：已经过了点就马上跑，没过就登记到那个时刻 */
  const arm = (job: InternalJob, after: number) => {
    if (controller.signal.aborted) return;
    const due = nextDue(job.schedule, new Date(after), new Date(clock.now()));
    if (!due) return;
    if (due.missed) runJob(job, "catch_up");
    else scheduler.schedule(keyOf(job), due.at.getTime(), () => runJob(job, "scheduled"));
  };

  const runJob = (job: InternalJob, trigger: JobTrigger) => {
    if (controller.signal.aborted) return;
    const startedAt = clock.now();
    const run = (async () => {
      try {
        await job.run(trigger, controller.signal);
      } catch (err) {
        // 守护进程停止时被中止的不算跑过（也不再登记下一次）
        if (controller.signal.aborted || isAbort(err)) return;
        log(`内部作业 ${job.name} 出错：${describe(err)}`);
      }
      try {
        const state = getJobState(store.reader, job.name);
        record({ job: job.name, since: state?.since ?? iso(startedAt), lastRunAt: iso(startedAt) });
      } catch (err) {
        log(`内部作业 ${job.name} 跑完了，但没记下来：${describe(err)}`);
      }
      // 下一次从跑完的那一刻往后算：睡了很久醒来也只跑这一次
      arm(job, Math.max(startedAt, clock.now()));
    })();
    running.add(run);
    void run.finally(() => running.delete(run));
  };

  return {
    register(job) {
      keys.add(keyOf(job));
      const state = getJobState(store.reader, job.name);
      if (state) {
        arm(job, Date.parse(state.lastRunAt ?? state.since));
        return;
      }
      const now = clock.now();
      record({ job: job.name, since: iso(now) });
      arm(job, now);
    },
    state: (name) => getJobState(store.reader, name),
    async whenIdle() {
      while (running.size > 0) await Promise.allSettled(running);
    },
    async stop() {
      controller.abort();
      for (const key of keys) scheduler.cancel(key);
      while (running.size > 0) await Promise.allSettled(running);
    },
  };
}
