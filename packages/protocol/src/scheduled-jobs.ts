// 触发登记（76 号票，ADR 0025；19 号票时叫"定时作业"，事件和类型的名字照旧是 scheduled_job，事件日志不改写）的名字和纯函数：
// 登记的状态、为什么暂停、运行记录的状态和触发方式、看板分组、用户在看板上能做的动作、卡上的说法；以及每周归档清单（规格第 8 节）每一项的选择。
// 只有常量和纯函数，不引用 TypeBox（Web 只用这些）。schema 在 scheduled-job-schema.ts。
//
// ADR 0025 起不再有单独的"定时作业"：它就是"定时触发的普通任务或流程"。定时（以后还有事件）触发的任务登记好了（Task.state 是运营中）
// 就有一份触发登记（ScheduledJob，ownerTaskId 是这个任务）：时间表、下一次、每一次运行的记录、运营中还是暂停、连续失败几次。
// 每被触发一次是一次运行（JobRun）；上一次还没跑完又被触发：排队合并，等它结束再跑一次，期间来的触发合成一批（JobRun.events）交给它。
// 属于项目的任务每次运行是交给项目维护者的一张工单；不属于项目的由任务自己的 agent 做，各次运行接着同一段会话。
// 状态：运营中 ⇄ 已暂停（用户在看板上切换；连续失败到了次数自动暂停；项目停用、归档时暂停，重新启用、取消归档时恢复），
// 用户可以取消（任务随之取消）。76 号票之前长程任务计划里登记的定时作业迁移成定时触发的普通任务（新事件建出任务，原来的事件不动），
// 它们每次运行的授权（随计划卡确认的）照旧：任务在运营就一直有效（不按 7 天续期），暂停、取消即收回。
import { followLocale, t, tTable } from "./i18n/runtime.ts";
import type { BoardGroup } from "./tasks.ts";

/** 作业的状态：运营中、已暂停、已取消（不上看板） */
export const SCHEDULED_JOB_STATES = ["active", "paused", "cancelled"] as const;
export type ScheduledJobState = (typeof SCHEDULED_JOB_STATES)[number];

export const SCHEDULED_JOB_STATE_LABEL: Readonly<Record<ScheduledJobState, string>> = tTable({
  active: "protocol.scheduledJobs.state.active",
  paused: "protocol.scheduledJobs.state.paused",
  cancelled: "protocol.scheduledJobs.state.cancelled",
});

/**
 * 为什么暂停：用户在看板上暂停的、连续失败到了次数自动暂停的、项目停用或归档时随之暂停的。
 * 项目重新启用、取消归档时只恢复因此暂停的（之前就暂停了的保持暂停）
 */
export const JOB_PAUSE_REASONS = ["user", "failures", "project_retired", "project_archived"] as const;
export type JobPauseReason = (typeof JOB_PAUSE_REASONS)[number];

/** 暂停原因的说法（连续失败几次自动暂停是守护进程的配置 scheduledJobs.jobFailures，默认 3；作业卡上的次数取作业的 consecutiveFailures） */
export const JOB_PAUSE_REASON_LABEL: Readonly<Record<JobPauseReason, string>> = tTable({
  user: "protocol.scheduledJobs.pause.user",
  failures: "protocol.scheduledJobs.pause.failures",
  project_retired: "protocol.scheduledJobs.pause.projectRetired",
  project_archived: "protocol.scheduledJobs.pause.projectArchived",
});

/**
 * 一次运行的状态：排队（等全局执行名额；属于项目的作业是交给项目维护者的一张工单，在项目的队列里排着，排着时不占名额）、
 * 运行中（真正开始了，占着一个名额）、成功、失败（维护者报了做不了、这一轮出错或被中止、审批等不到被拦下……）、
 * 中断（守护进程停机时正做到一半：不重做，也不算进连续失败）、没运行（还排着时作业暂停、取消了，一并丢掉：不算进连续失败）、
 * 已撤回（155 号票，用户 2026-10-18 定：正在运行时你撤回了会话、切换了分支，这次运行到此为止——不算失败，不算进连续失败，
 * 不触发连续失败自动暂停，也不改"最近一次失败"）、部分完成（176 号票，用户 2026-10-19 定：有一步等不到批准被拦下、或者交给你亲手做，
 * 别的维护者做完了——既不算成功也不算失败，和中断一样不算进连续失败、也不清零，不触发自动暂停，不改"最近一次失败"）
 */
export const JOB_RUN_STATES = ["queued", "running", "done", "failed", "interrupted", "dropped", "rolled_back", "partial"] as const;
export type JobRunState = (typeof JOB_RUN_STATES)[number];

/** 运行状态的 key（日历的状况表接着用，calendar.ts） */
export const JOB_RUN_STATE_KEYS: Readonly<Record<JobRunState, string>> = {
  queued: "protocol.scheduledJobs.run.queued",
  running: "protocol.scheduledJobs.run.running",
  done: "protocol.scheduledJobs.run.done",
  failed: "protocol.scheduledJobs.run.failed",
  interrupted: "protocol.scheduledJobs.run.interrupted",
  dropped: "protocol.scheduledJobs.run.dropped",
  rolled_back: "protocol.scheduledJobs.run.rolledBack",
  partial: "protocol.scheduledJobs.run.partial",
};

export const JOB_RUN_STATE_LABEL: Readonly<Record<JobRunState, string>> = tTable(JOB_RUN_STATE_KEYS);

/**
 * 这次运行为什么开始：到点了，守护进程启动时补跑停机期间错过的（错过几次都只补跑一次），还是事件推送过来（77 号票接事件来源），
 * 还是用户让它立即运行一次（100 号票：任务操作菜单里的"立即运行一次"、秘书照用户说的；不改时间表、不算错过补发）。
 * 合进来的触发（排队合并）记在运行的 events 里，这里只记最先那一次
 */
export const JOB_RUN_TRIGGERS = ["scheduled", "catch_up", "event", "manual"] as const;
export type JobRunTrigger = (typeof JOB_RUN_TRIGGERS)[number];

export const JOB_RUN_TRIGGER_LABEL: Readonly<Record<JobRunTrigger, string>> = tTable({
  scheduled: "protocol.scheduledJobs.trigger.scheduled",
  catch_up: "protocol.scheduledJobs.trigger.catchUp",
  event: "protocol.scheduledJobs.trigger.event",
  manual: "protocol.scheduledJobs.trigger.manual",
});

/**
 * 触发底座收到的事件从哪来（76 号票）：时间到了（定时）也是一种事件；77 号票的事件来源（二狗内部事件、本机文件夹变化……）
 * 用自己的编号接在同一个口子上（scheduled-jobs/ 的 fire）
 */
export const TIME_TRIGGER_SOURCE = "time";

/** 用户让它立即运行一次（100 号票）的那次触发的来源：不是时间到了，也不是事件来源推来的事件（不带事件的值） */
export const MANUAL_TRIGGER_SOURCE = "manual";

/**
 * 看板频道上 scheduled_job 事件的"这次是什么变化"：登记（76 号票起是定时触发的任务登记好了；之前是确认计划后）、暂停、恢复、取消、
 * 到点（一次运行进了队列，下一次的时间跟着往后算）、运行开始、运行结束（成功或失败；连续失败到了次数时同一事务自动暂停）、
 * 下一次的时间重算了（"按我的工作日"的时间表在工作日历变了之后，系统做的；98 号票起也是用户改了时间表，用户做的）；
 * 76 号票：迁移（以前的定时作业有了它的定时触发的普通任务）、
 * 合并（上一次还没跑完、又来了触发：并进还排着的那一次）、一次运行里汇报了一步（定时触发的流程的 report_step）
 */
export const SCHEDULED_JOB_CHANGES = ["registered", "paused", "resumed", "cancelled", "triggered", "run_started", "run_finished", "rescheduled", "migrated", "merged", "run_step"] as const;
export type ScheduledJobChange = (typeof SCHEDULED_JOB_CHANGES)[number];

/** 用户在看板上对定时触发的任务的动作（scheduled_job_action 请求）：暂停、恢复、取消（任务随之取消） */
export const SCHEDULED_JOB_ACTIONS = ["pause", "resume", "cancel"] as const;
export type ScheduledJobAction = (typeof SCHEDULED_JOB_ACTIONS)[number];

export const SCHEDULED_JOB_ACTION_LABEL: Readonly<Record<ScheduledJobAction, string>> = tTable({
  pause: "protocol.scheduledJobs.action.pause",
  resume: "protocol.scheduledJobs.action.resume",
  cancel: "protocol.scheduledJobs.action.cancel",
});

/** 现在能对作业做的动作：运营中的能暂停、取消；已暂停的能恢复、取消；已取消的什么都不能做 */
export function scheduledJobActions(job: { state: ScheduledJobState }): ScheduledJobAction[] {
  if (job.state === "active") return ["pause", "cancel"];
  if (job.state === "paused") return ["resume", "cancel"];
  return [];
}

/**
 * 能不能改时间表（98 号票，reschedule_job）：定时触发的（有时间表）、没取消的——暂停着的也能改（改完照旧暂停）；
 * 事件触发的没有时间表，改不了
 */
export function canRescheduleJob(job: { state: ScheduledJobState; schedule?: unknown }): boolean {
  return job.state !== "cancelled" && job.schedule !== undefined;
}

/**
 * 能不能立即运行一次（100 号票，run_job_now）：没取消的——定时、事件触发的都能；暂停着的也能（跑一次照旧暂停，不恢复）。
 * 上一次还没跑完的另由守护进程拒绝并说明（看运行记录，这里不看）
 */
export function canRunJobNow(job: { state: ScheduledJobState }): boolean {
  return job.state !== "cancelled";
}

/** 触发登记在看板上的分组：运营中、已暂停的都在"运营中"组（卡上写状态）；已取消的不上看板（76 号票起看板上是它的任务） */
export function boardGroupOfScheduledJob(state: ScheduledJobState): BoardGroup | undefined {
  return state === "cancelled" ? undefined : "ops";
}

/** 作业卡上的状态："运营中"、"已暂停（连续失败 3 次，自动暂停）"、"已暂停（项目已停用）"；用户自己暂停的只写"已暂停" */
export function scheduledJobStatusText(job: { state: ScheduledJobState; pausedBy?: JobPauseReason | undefined; consecutiveFailures?: number | undefined }): string {
  const label = SCHEDULED_JOB_STATE_LABEL[job.state];
  if (job.state !== "paused" || !job.pausedBy || job.pausedBy === "user") return label;
  if (job.pausedBy === "failures" && job.consecutiveFailures) {
    return t("protocol.scheduledJobs.status.autoPaused", { label, failures: job.consecutiveFailures, count: job.consecutiveFailures });
  }
  return t("protocol.scheduledJobs.status.paused", { label, reason: JOB_PAUSE_REASON_LABEL[job.pausedBy] });
}

/** 运行中你撤回了会话、切换了分支（155 号票）：这次运行记"已撤回"时写的原因 */
export const JOB_RUN_ROLLED_BACK_REASON = tTable({
  rollback: "protocol.scheduledJobs.rolledBack.rollback",
  switch: "protocol.scheduledJobs.rolledBack.switch",
});

/** 作业卡上"最近一次失败"的标记（跟着当前语言，followLocale） */
export let LAST_RUN_FAILED_LABEL = "";
/** 作业卡上"最近一次部分完成"的标记（176 号票） */
export let LAST_RUN_PARTIAL_LABEL = "";

/**
 * 卡上标的最近一次的结局（项目页作业行、还没迁移的作业卡、秘书的查看板）：最近一次是部分完成的标"最近一次部分完成"（176 号票，
 * 它比"最近一次失败"新：那一次不改 lastFailed，照旧标失败就说反了）；不然最近一次算数的失败了标"最近一次失败"；都不是不标
 */
export function lastRunMark(job: { lastFailed: boolean; lastRun?: { state: JobRunState } | undefined }): { text: string; partial: boolean } | undefined {
  if (job.lastRun?.state === "partial") return { text: LAST_RUN_PARTIAL_LABEL, partial: true };
  return job.lastFailed ? { text: LAST_RUN_FAILED_LABEL, partial: false } : undefined;
}

/**
 * "定时触发的任务被自动暂停"事项（待我处理里的通知 scheduled_job_auto_paused）的两个动作。事项的动作按这几个字认
 * （存进事件、点了按字找处理的），不跟着语言变（172 号票）
 */
export const JOB_AUTO_PAUSED_ACTIONS = { resume: "恢复", keep: "保持暂停" } as const; // @i18n-ignore fixed：事项的动作按字认

/** "定时触发的任务被自动暂停"事项的结构化数据：哪个触发登记 */
export interface JobAutoPausedNoticeData {
  jobId: string;
}

/** 属于项目的定时触发的任务每次运行的工单要做的事（流水线上的说法："定时触发：每天早上出简报"；跟着当前语言，followLocale） */
export let JOB_RUN_WORK_ORDER_LABEL = "";

followLocale(() => {
  LAST_RUN_FAILED_LABEL = t("protocol.scheduledJobs.lastRunFailed");
  LAST_RUN_PARTIAL_LABEL = t("protocol.scheduledJobs.lastRunPartial");
  JOB_RUN_WORK_ORDER_LABEL = t("protocol.scheduledJobs.workOrderLabel");
});

// ───────────────────────── 归档清单（规格第 8 节） ─────────────────────────
// 任务结束多少天之后进归档清单是守护进程的配置 tasks.thresholds.archiveAfterDays（默认 7），清单卡的负载里带着（afterDays）。

/**
 * 归档清单上每一项的选择：归档（任务变为已归档）、继续改（已完成的走返工、失败的走重试，回到执行中）、先留着（任务不变）。
 * 已取消的任务在状态机里回不到执行中，只有"归档"和"先留着"
 */
export const ARCHIVE_CHOICES = ["archive", "continue", "keep"] as const;
export type ArchiveChoice = (typeof ARCHIVE_CHOICES)[number];

export const ARCHIVE_CHOICE_LABEL: Readonly<Record<ArchiveChoice, string>> = tTable({
  archive: "protocol.scheduledJobs.archive.archive",
  continue: "protocol.scheduledJobs.archive.continue",
  keep: "protocol.scheduledJobs.archive.keep",
});
