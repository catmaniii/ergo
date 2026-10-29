// 定时作业的视图（纯函数，19 号票）：看板频道上 scheduled_job 事件里的作业，作业卡上的样子（运营中 / 已暂停，暂停的原因，
// "最近一次失败"、时间表、下一次、属于哪个项目、名下的 token 总量、每次运行的授权），以及现在能做的动作（暂停、恢复、取消：
// 和守护进程用同一份规则，协议包的 scheduledJobActions）。项目页上列这个项目的作业和状态。98 号票：能改时间的带着现在的时间表。
import {
  canRescheduleJob,
  canRunJobNow,
  grantText,
  jobTriggerText,
  lastTriggerEvent,
  type JobRun,
  lastRunMark,
  type ReminderSchedule,
  type ScheduledJob,
  type ScheduledJobAction,
  scheduledJobActions,
  scheduledJobStatusText,
  t,
  temporalRuleText,
  describeEventTrigger,
  type EventNames,
} from "./protocol.ts";
import { taskOperationsLock } from "./operations-lock.ts";
import type { UiState } from "./ui-state.ts";
import { jobTokenTotal } from "./usage.ts";

export interface ScheduledJobView {
  job: ScheduledJob;
  /** 状态："运营中"、"已暂停"、"已暂停（连续失败 3 次，自动暂停）"、"已暂停（项目已停用）" */
  statusText: string;
  /** 最近一次运行失败了：作业卡上标"最近一次失败"（有一次成功就去掉；最近一次部分完成的标下面那个，不标它） */
  lastFailedText: string | undefined;
  /** 最近一次运行部分完成（176 号票）：作业卡上标"最近一次部分完成"（另一种颜色） */
  lastPartialText: string | undefined;
  /** 时间表："每天 09:00"、"每周一 08:00"……；事件触发的（77 号票）是"事件发生时：本机文件夹 …里新增 *.pdf 文件" */
  scheduleText: string;
  /** 事件触发的（77 号票）：在等什么事件（不带"事件发生时："）；定时触发的没有 */
  waitingFor?: string;
  /** 事件触发的（77 号票）：最近一次触发是什么事件、什么时候；还没触发过的没有 */
  lastTrigger?: { summary: string; at: string };
  /** 现在能做的动作 */
  actions: ScheduledJobAction[];
  /** 能改时间的（98 号票：定时的、没取消的，暂停着的也能改）：现在的时间表，菜单里的"改时间"预填它；事件触发的、已取消的没有 */
  reschedule?: ReminderSchedule;
  /** 能立即运行一次（100 号票：没取消的，定时、事件触发的都能，暂停着的也能） */
  runNow: boolean;
  /** 作业名下的 token 总量（24 号票的账本：看板频道上作业的 token_totals） */
  tokens: number;
  /** 最近一次运行（这次事件里说到的；没运行过没有） */
  lastRun: JobRun | undefined;
  /**
   * 每次运行的授权（随计划卡确认，作业在就一直有效；暂停、取消即收回）：授权项一行一条（主文由协议包的 grantText 生成，
   * 维护者写的标题在前），时序规则一行一条（含用户说过的限制编出的）
   */
  grants: string[];
  rules: string[];
}

/** 作业每次运行的授权写成几行（作业卡、项目页上列出） */
export function jobAuthorizationLines(job: Pick<ScheduledJob, "grants" | "grantInfo" | "temporalRules">): { grants: string[]; rules: string[] } {
  return {
    grants: job.grants.map((g) => t("state.scheduledJobs.grantLine", { title: g.title, text: grantText(g, job.grantInfo[g.id], "job") })),
    rules: job.temporalRules.map((r) => temporalRuleText(r)),
  };
}

/** 看板上的任务、项目编号换成名字（77 号票："在等什么事件"里写任务 t-3「…」） */
export function eventNames(state: UiState): EventNames {
  return {
    task: (taskId) => state.tasks[taskId]?.title,
    project: (projectId) => state.projects[projectId]?.name,
  };
}

/**
 * 141 号票：项目在用时运营方案里的一条（它的任务只能暂停、恢复，operations-lock.ts）只剩暂停、恢复和立即运行一次（不改任务，
 * 用户 2026-10-18 定放回）——看板卡、任务详情、项目页作业行上的按钮都没有取消，也不能改时间（要改请项目维护者改运营方案）
 */
export function scheduledJobView(state: UiState, job: ScheduledJob): ScheduledJobView {
  const locked = job.ownerTaskId !== undefined && taskOperationsLock(state, state.tasks[job.ownerTaskId]) !== undefined;
  const lastRunId = job.lastRun?.runId;
  const lastRun = (lastRunId === undefined ? undefined : state.jobRuns[lastRunId]) ?? job.lastRun;
  const names = eventNames(state);
  const last = job.event ? lastTriggerEvent(lastRun) : undefined;
  const mark = lastRunMark({ lastFailed: job.lastFailed, lastRun });
  return {
    job,
    statusText: scheduledJobStatusText(job),
    lastFailedText: mark && !mark.partial ? mark.text : undefined,
    lastPartialText: mark?.partial ? mark.text : undefined,
    scheduleText: jobTriggerText(job, names),
    ...(job.event ? { waitingFor: describeEventTrigger(job.event, names) } : {}),
    ...(last ? { lastTrigger: { summary: last.summary, at: last.at } } : {}),
    actions: scheduledJobActions(job).filter((a) => !locked || a !== "cancel"),
    ...(job.schedule && canRescheduleJob(job) && !locked ? { reschedule: job.schedule } : {}),
    runNow: canRunJobNow(job),
    tokens: jobTokenTotal(state, job.id),
    lastRun,
    ...jobAuthorizationLines(job),
  };
}

/** 某个作业（没收到过的是 undefined） */
export function selectScheduledJob(state: UiState, jobId: string): ScheduledJobView | undefined {
  const job = state.scheduledJobs[jobId];
  return job && scheduledJobView(state, job);
}

/** 项目页上这个项目的定时作业：没取消的在前，同一类里先登记的在前 */
export function projectScheduledJobs(state: UiState, projectId: string): ScheduledJobView[] {
  return Object.values(state.scheduledJobs)
    .filter((j) => j.projectId === projectId)
    .toSorted((a, b) => Number(a.state === "cancelled") - Number(b.state === "cancelled") || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((j) => scheduledJobView(state, j));
}

/** 某个作业的运行记录（状态层里收到过的），先触发的在前 */
export function jobRuns(state: UiState, jobId: string): JobRun[] {
  return Object.values(state.jobRuns)
    .filter((r) => r.jobId === jobId)
    .toSorted((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.runId.localeCompare(b.runId));
}
