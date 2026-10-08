// 定时作业（规格第 8、13 节，19 号票）的名字和纯函数：作业的状态、为什么暂停、运行记录的状态和触发方式、看板分组、
// 用户在看板上能做的动作、作业卡上的说法；以及每周归档清单（规格第 8 节）每一项的选择。
// 只有常量和纯函数，不引用 TypeBox（Web 只用这些）。schema 在 scheduled-job-schema.ts。
//
// 定时作业通过任务建：计划里带着定义（时间表、每次要做的事、属于哪个项目、每次运行要的授权项和时序规则），用户确认计划后
// 登记、进入运营中。属于项目的作业每次运行是交给项目维护者的一张工单；不属于项目的由作业自己的维护者执行。
// 状态：运营中 ⇄ 已暂停（用户在看板上切换；连续失败到了次数自动暂停；项目停用、归档时暂停，重新启用、取消归档时恢复），
// 用户可以取消（不上看板）。作业的授权在作业在的时候一直有效（不按 7 天续期），暂停、取消即收回。
import type { BoardGroup } from "./tasks.ts";

/** 作业的状态：运营中、已暂停、已取消（不上看板） */
export const SCHEDULED_JOB_STATES = ["active", "paused", "cancelled"] as const;
export type ScheduledJobState = (typeof SCHEDULED_JOB_STATES)[number];

export const SCHEDULED_JOB_STATE_LABEL: Readonly<Record<ScheduledJobState, string>> = { active: "运营中", paused: "已暂停", cancelled: "已取消" };

/**
 * 为什么暂停：用户在看板上暂停的、连续失败到了次数自动暂停的、项目停用或归档时随之暂停的。
 * 项目重新启用、取消归档时只恢复因此暂停的（之前就暂停了的保持暂停）
 */
export const JOB_PAUSE_REASONS = ["user", "failures", "project_retired", "project_archived"] as const;
export type JobPauseReason = (typeof JOB_PAUSE_REASONS)[number];

/** 暂停原因的说法（连续失败几次自动暂停是守护进程的配置 scheduledJobs.jobFailures，默认 3；作业卡上的次数取作业的 consecutiveFailures） */
export const JOB_PAUSE_REASON_LABEL: Readonly<Record<JobPauseReason, string>> = {
  user: "你暂停的",
  failures: "连续失败，自动暂停",
  project_retired: "项目已停用",
  project_archived: "项目已归档",
};

/**
 * 一次运行的状态：排队（等全局执行名额；属于项目的作业是交给项目维护者的一张工单，在项目的队列里排着，排着时不占名额）、
 * 运行中（真正开始了，占着一个名额）、成功、失败（维护者报了做不了、这一轮出错或被中止、审批等不到被拦下……）、
 * 中断（守护进程停机时正做到一半：不重做，也不算进连续失败）、没运行（还排着时作业暂停、取消了，一并丢掉：不算进连续失败）
 */
export const JOB_RUN_STATES = ["queued", "running", "done", "failed", "interrupted", "dropped"] as const;
export type JobRunState = (typeof JOB_RUN_STATES)[number];

export const JOB_RUN_STATE_LABEL: Readonly<Record<JobRunState, string>> = {
  queued: "排队",
  running: "运行中",
  done: "成功",
  failed: "失败",
  interrupted: "中断",
  dropped: "没运行",
};

/** 这次运行为什么开始：到点了，还是守护进程启动时补跑停机期间错过的（错过几次都只补跑一次） */
export const JOB_RUN_TRIGGERS = ["scheduled", "catch_up"] as const;
export type JobRunTrigger = (typeof JOB_RUN_TRIGGERS)[number];

export const JOB_RUN_TRIGGER_LABEL: Readonly<Record<JobRunTrigger, string>> = { scheduled: "到点", catch_up: "开机补跑" };

/**
 * 看板频道上 scheduled_job 事件的"这次是什么变化"：登记（确认计划后）、暂停、恢复、取消、
 * 到点（一次运行进了队列，下一次的时间跟着往后算）、运行开始、运行结束（成功或失败；连续失败到了次数时同一事务自动暂停）、
 * 下一次的时间重算了（"按我的工作日"的时间表在工作日历变了之后）
 */
export const SCHEDULED_JOB_CHANGES = ["registered", "paused", "resumed", "cancelled", "triggered", "run_started", "run_finished", "rescheduled"] as const;
export type ScheduledJobChange = (typeof SCHEDULED_JOB_CHANGES)[number];

/** 用户在看板上对作业的动作（scheduled_job_action 请求）：暂停、恢复、取消 */
export const SCHEDULED_JOB_ACTIONS = ["pause", "resume", "cancel"] as const;
export type ScheduledJobAction = (typeof SCHEDULED_JOB_ACTIONS)[number];

export const SCHEDULED_JOB_ACTION_LABEL: Readonly<Record<ScheduledJobAction, string>> = { pause: "暂停", resume: "恢复", cancel: "取消作业" };

/** 现在能对作业做的动作：运营中的能暂停、取消；已暂停的能恢复、取消；已取消的什么都不能做 */
export function scheduledJobActions(job: { state: ScheduledJobState }): ScheduledJobAction[] {
  if (job.state === "active") return ["pause", "cancel"];
  if (job.state === "paused") return ["resume", "cancel"];
  return [];
}

/** 作业在看板上的分组：运营中、已暂停的都在"运营中"组（卡上写状态）；已取消的不上看板 */
export function boardGroupOfScheduledJob(state: ScheduledJobState): BoardGroup | undefined {
  return state === "cancelled" ? undefined : "ops";
}

/** 作业卡上的状态："运营中"、"已暂停（连续失败 3 次，自动暂停）"、"已暂停（项目已停用）"；用户自己暂停的只写"已暂停" */
export function scheduledJobStatusText(job: { state: ScheduledJobState; pausedBy?: JobPauseReason | undefined; consecutiveFailures?: number | undefined }): string {
  const label = SCHEDULED_JOB_STATE_LABEL[job.state];
  if (job.state !== "paused" || !job.pausedBy || job.pausedBy === "user") return label;
  if (job.pausedBy === "failures" && job.consecutiveFailures) return `${label}（连续失败 ${job.consecutiveFailures} 次，自动暂停）`;
  return `${label}（${JOB_PAUSE_REASON_LABEL[job.pausedBy]}）`;
}

/** 作业卡上"最近一次失败"的标记 */
export const LAST_RUN_FAILED_LABEL = "最近一次失败";

/** "定时作业被自动暂停"事项（待我处理里的通知 scheduled_job_auto_paused）的两个动作 */
export const JOB_AUTO_PAUSED_ACTIONS = { resume: "恢复", keep: "保持暂停" } as const;

/** "定时作业被自动暂停"事项的结构化数据：哪个作业 */
export interface JobAutoPausedNoticeData {
  jobId: string;
}

/** 属于项目的作业每次运行的工单要做的事（流水线上的说法："定时作业：每天早上出简报"） */
export const JOB_RUN_WORK_ORDER_LABEL = "定时作业";

// ───────────────────────── 归档清单（规格第 8 节） ─────────────────────────
// 任务结束多少天之后进归档清单是守护进程的配置 tasks.thresholds.archiveAfterDays（默认 7），清单卡的负载里带着（afterDays）。

/**
 * 归档清单上每一项的选择：归档（任务变为已归档）、继续改（已完成的走返工、失败的走重试，回到执行中）、先留着（任务不变）。
 * 已取消的任务在状态机里回不到执行中，只有"归档"和"先留着"
 */
export const ARCHIVE_CHOICES = ["archive", "continue", "keep"] as const;
export type ArchiveChoice = (typeof ARCHIVE_CHOICES)[number];

export const ARCHIVE_CHOICE_LABEL: Readonly<Record<ArchiveChoice, string>> = { archive: "归档", continue: "继续改", keep: "先留着" };
