// 定时作业的视图（纯函数，19 号票）：看板频道上 scheduled_job 事件里的作业，作业卡上的样子（运营中 / 已暂停，暂停的原因，
// "最近一次失败"、时间表、下一次、属于哪个项目、名下的 token 总量、每次运行的授权），以及现在能做的动作（暂停、恢复、取消：
// 和守护进程用同一份规则，协议包的 scheduledJobActions）。项目页上列这个项目的作业和状态。
import {
  grantText,
  jobTriggerText,
  lastTriggerEvent,
  type JobRun,
  LAST_RUN_FAILED_LABEL,
  type ScheduledJob,
  type ScheduledJobAction,
  scheduledJobActions,
  scheduledJobStatusText,
  temporalRuleText,
  describeEventTrigger,
  type EventNames,
} from "./protocol.ts";
import type { UiState } from "./ui-state.ts";
import { jobTokenTotal } from "./usage.ts";

export interface ScheduledJobView {
  job: ScheduledJob;
  /** 状态："运营中"、"已暂停"、"已暂停（连续失败 3 次，自动暂停）"、"已暂停（项目已停用）" */
  statusText: string;
  /** 最近一次运行失败了：作业卡上标"最近一次失败"（有一次成功就去掉） */
  lastFailedText: string | undefined;
  /** 时间表："每天 09:00"、"每周一 08:00"……；事件触发的（77 号票）是"事件发生时：本机文件夹 …里新增 *.pdf 文件" */
  scheduleText: string;
  /** 事件触发的（77 号票）：在等什么事件（不带"事件发生时："）；定时触发的没有 */
  waitingFor?: string;
  /** 事件触发的（77 号票）：最近一次触发是什么事件、什么时候；还没触发过的没有 */
  lastTrigger?: { summary: string; at: string };
  /** 现在能做的动作 */
  actions: ScheduledJobAction[];
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
    grants: job.grants.map((g) => `${g.title}：${grantText(g, job.grantInfo[g.id], "job")}`),
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

export function scheduledJobView(state: UiState, job: ScheduledJob): ScheduledJobView {
  const lastRunId = job.lastRun?.runId;
  const lastRun = (lastRunId === undefined ? undefined : state.jobRuns[lastRunId]) ?? job.lastRun;
  const names = eventNames(state);
  const last = job.event ? lastTriggerEvent(lastRun) : undefined;
  return {
    job,
    statusText: scheduledJobStatusText(job),
    lastFailedText: job.lastFailed ? LAST_RUN_FAILED_LABEL : undefined,
    scheduleText: jobTriggerText(job, names),
    ...(job.event ? { waitingFor: describeEventTrigger(job.event, names) } : {}),
    ...(last ? { lastTrigger: { summary: last.summary, at: last.at } } : {}),
    actions: scheduledJobActions(job),
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
