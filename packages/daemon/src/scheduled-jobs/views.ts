// 触发登记的派生视图（ergo.db，19 号票的定时作业；76 号票起每份属于一个定时触发的任务）：
// - scheduled_jobs：每份触发登记的最新状态（任务看板频道上的 scheduled_job 事件，按编号留最后一条）；
// - job_runs：每一次运行的最新状态（scheduled_job 事件里带着的运行，按运行号留最后一条；排队的先后按第一次出现的序号）。
import { CHANNELS, EVENT_TYPES, type JobRun, type JobRunState, type ScheduledJob, type ScheduledJobEventPayload, type ScheduledJobState } from "@ergo/protocol";
import type { DerivedView } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";

export const scheduledJobsView: DerivedView = {
  name: "scheduled_jobs",
  create(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        project_id TEXT,
        maintainer_id TEXT NOT NULL,
        job TEXT NOT NULL,
        created_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_runs (
        run_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        state TEXT NOT NULL,
        run TEXT NOT NULL,
        created_seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS job_runs_by_state ON job_runs (state, created_seq);
      CREATE INDEX IF NOT EXISTS job_runs_by_job ON job_runs (job_id, created_seq);
    `);
  },
  clear(db) {
    db.exec("DELETE FROM scheduled_jobs; DELETE FROM job_runs;");
  },
  apply(db, event) {
    if (event.channel !== CHANNELS.board || event.type !== EVENT_TYPES.scheduledJob) return;
    const { job, run } = event.payload as ScheduledJobEventPayload;
    db.run(
      `INSERT INTO scheduled_jobs (id, state, project_id, maintainer_id, job, created_seq) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET state = excluded.state, project_id = excluded.project_id, job = excluded.job`,
      job.id,
      job.state,
      job.projectId ?? null,
      job.maintainerId,
      JSON.stringify(job),
      event.globalSeq,
    );
    if (!run) return;
    db.run(
      `INSERT INTO job_runs (run_id, job_id, state, run, created_seq) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (run_id) DO UPDATE SET state = excluded.state, run = excluded.run`,
      run.runId,
      run.jobId,
      run.state,
      JSON.stringify(run),
      event.globalSeq,
    );
  },
};

const parseJob = (row: { job: string }) => JSON.parse(row.job) as ScheduledJob;
const parseRun = (row: { run: string }) => JSON.parse(row.run) as JobRun;

export function getJob(db: ReadonlyDatabase, jobId: string): ScheduledJob | undefined {
  const row = db.get<{ job: string }>("SELECT job FROM scheduled_jobs WHERE id = ?", jobId);
  return row && parseJob(row);
}

/** 作业（某几种状态的；不给就是全部），先登记的在前 */
export function listJobs(db: ReadonlyDatabase, states?: readonly ScheduledJobState[]): ScheduledJob[] {
  if (!states) return db.all<{ job: string }>("SELECT job FROM scheduled_jobs ORDER BY created_seq").map(parseJob);
  const marks = states.map(() => "?").join(", ");
  return db.all<{ job: string }>(`SELECT job FROM scheduled_jobs WHERE state IN (${marks}) ORDER BY created_seq`, ...states).map(parseJob);
}

/** 一个定时触发的任务的触发登记（76 号票：ownerTaskId 是它的那一份；任务只有一份） */
export function jobOfTask(db: ReadonlyDatabase, taskId: string): ScheduledJob | undefined {
  const row = db.get<{ job: string }>("SELECT job FROM scheduled_jobs WHERE json_extract(job, '$.ownerTaskId') = ? ORDER BY created_seq LIMIT 1", taskId);
  return row && parseJob(row);
}

/** 某个项目的作业，先登记的在前 */
export function jobsOfProject(db: ReadonlyDatabase, projectId: string): ScheduledJob[] {
  return db.all<{ job: string }>("SELECT job FROM scheduled_jobs WHERE project_id = ? ORDER BY created_seq", projectId).map(parseJob);
}

/** 登记过多少个作业（新作业的编号接着往下排） */
export function countJobs(db: ReadonlyDatabase): number {
  return Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM scheduled_jobs")?.n ?? 0);
}

export function getRun(db: ReadonlyDatabase, runId: string): JobRun | undefined {
  const row = db.get<{ run: string }>("SELECT run FROM job_runs WHERE run_id = ?", runId);
  return row && parseRun(row);
}

/** 处于这些状态的运行，先进队列的在前 */
export function runsIn(db: ReadonlyDatabase, states: readonly JobRunState[]): JobRun[] {
  const marks = states.map(() => "?").join(", ");
  return db.all<{ run: string }>(`SELECT run FROM job_runs WHERE state IN (${marks}) ORDER BY created_seq`, ...states).map(parseRun);
}

/**
 * 不属于项目的正在做的运行有几次（作业自己的维护者、定时触发的任务自己的 agent）：它们占着全局执行名额（tasks/slots.ts 数名额用）。
 * 属于项目的运行（带工单号的）按进行中的运行工单数（工单开始和占名额在同一事务里），这里不数
 */
export function countRunningOwnRuns(db: ReadonlyDatabase): number {
  return Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_runs WHERE state = 'running' AND json_extract(run, '$.workOrderId') IS NULL")?.n ?? 0);
}

/** 某个作业的运行，先触发的在前 */
export function runsOfJob(db: ReadonlyDatabase, jobId: string): JobRun[] {
  return db.all<{ run: string }>("SELECT run FROM job_runs WHERE job_id = ? ORDER BY created_seq", jobId).map(parseRun);
}
