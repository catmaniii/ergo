// 触发登记（76 号票；19 号票时叫定时作业）和归档清单的 schema（规格第 8、13 节），用 TypeBox 定义，守护进程和 Web 共用生成的类型。
// - 任务看板频道上的 scheduled_job 事件：触发登记的最新状态（ScheduledJob），这次的变化，和这次说到的那一次运行（JobRun）。
//   看板运营中分组里定时触发的任务卡（时间表、下一次、最近一次运行）、项目页、日历、任务详情按运行分段都从它来；运行记录按 runId 留最新的；
// - 看板上的 scheduled_job_action 请求：暂停、恢复、取消；reschedule_job 请求：改时间表（98 号票）；
// - 归档清单卡（archive_list）：每周一次，把结束超过 7 天、还没归档的任务汇总成一张卡，每项选归档、继续改、先留着。
// 名字（状态、变化、动作、选择）在 scheduled-jobs.ts。
import { type Static, Type } from "typebox";
import { EventTrigger } from "./event-source-schema.ts";
import { ReminderSchedule } from "./reminder-schedule.ts";
import { ProjectInternal } from "./schema.ts";
import { ARCHIVE_CHOICES, JOB_PAUSE_REASONS, JOB_RUN_STATES, JOB_RUN_TRIGGERS, SCHEDULED_JOB_ACTIONS, SCHEDULED_JOB_CHANGES, SCHEDULED_JOB_STATES } from "./scheduled-jobs.ts";
import { GrantInfo, PlanGrant, PlanTemporalRule, TaskStep } from "./task-schema.ts";
import { TASK_ACTORS, TASK_END_KINDS, TASK_STATES } from "./tasks.ts";

/**
 * 触发底座收到的一次触发（76 号票）：从哪来（时间到了是 time；77 号票的事件来源用登记表里的编号：ergou、folder）、什么时候、
 * 一句给人和 agent 看的说明；77 号票：哪一种事件（来源登记的事件编号，时间到了的没有）、事件里的值（键是来源登记的字段的键，
 * 流程步骤参数里的占位按它代入，交给 agent 时按字段的中文名写成结构化的输入）。一次运行处理一批：最先那一次，加上排队合并进来的
 */
export const TriggerEvent = Type.Object({
  source: Type.String({ minLength: 1 }),
  event: Type.Optional(Type.String()),
  /** 触发的时刻（定时的是时间表上的那一刻；事件的是事件发生的时刻） */
  at: Type.String(),
  summary: Type.String(),
  data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type TriggerEvent = Static<typeof TriggerEvent>;

/** 一次运行（运行记录）：触发时间、怎么触发的、这一批触发、结局 */
export const JobRun = Type.Object({
  /** 运行号：<作业 id>-r<n> */
  runId: Type.String(),
  jobId: Type.String(),
  trigger: Type.Enum(JOB_RUN_TRIGGERS),
  /** 触发时间：时间表上的那一刻（开机补跑的是停机期间错过的最近一次） */
  dueAt: Type.String(),
  /** 开机补跑时停机期间错过了几次（错过几次都只补跑这一次） */
  missed: Type.Optional(Type.Integer({ minimum: 1 })),
  /**
   * 这次运行处理的一批触发（76 号票）：最先那一次，加上它还排着、或者上一次还没跑完时又来的（排队合并，先后照来的顺序）。
   * 76 号票之前的运行没有（只有 dueAt 那一次到点）
   */
  events: Type.Optional(Type.Array(TriggerEvent)),
  state: Type.Enum(JOB_RUN_STATES),
  queuedAt: Type.String(),
  startedAt: Type.Optional(Type.String()),
  endedAt: Type.Optional(Type.String()),
  /** 失败、中断、没运行的原因（维护者报的、出错的、审批等不到被拦下的、工单退回的、停机打断的、排着时作业暂停了的……） */
  reason: Type.Optional(Type.String()),
  /**
   * 这次运行最后说的话（76 号票：一两句，压成一行截短）：后面的运行知道前几次的结果——属于项目的每次运行是一张新工单、新会话，
   * 工单里带着前几次的结局和它
   */
  summary: Type.Optional(Type.String()),
  /** 属于项目的作业：这次运行是哪张工单 */
  workOrderId: Type.Optional(Type.String()),
  /**
   * 定时触发的流程（76 号票）：这次运行里各步的状态（agent 用 report_step 汇报的，运行结束时执行过却没报的推断成做完；
   * 每次运行从头算，任务详情按运行分段时显示"做完 N/M 步"）
   */
  steps: Type.Optional(Type.Array(TaskStep)),
});
export type JobRun = Static<typeof JobRun>;

/** 一份触发登记（scheduled_job 事件里是它的最新状态；19 号票时叫定时作业，76 号票起都属于一个定时触发的任务） */
export const ScheduledJob = Type.Object({
  /** 作业编号：j-1、j-2…… */
  id: Type.String(),
  title: Type.String(),
  /** 定时触发的：时间表（事件触发的没有） */
  schedule: Type.Optional(ReminderSchedule),
  /** 事件触发的（77 号票）：哪个事件来源、哪几种事件、过滤条件（和任务的触发方式一样）；定时触发的没有 */
  event: Type.Optional(EventTrigger),
  /** 每次要做的事 */
  each: Type.String(),
  /** 属于哪个项目（不属于项目的没有） */
  projectId: Type.Optional(Type.String()),
  projectName: Type.Optional(Type.String()),
  /** 执行的维护者：属于项目的是项目的维护者，不属于项目的是作业自己的维护者（jm-<n>） */
  maintainerId: Type.String(),
  /**
   * 授权所在的任务：76 号票起登记的就是它属于的那个定时触发的任务（流程的授权在它确认的计划里）；
   * 76 号票之前的是建它的长程任务（计划里带着它的定义，每次运行的工具包、本任务的关注类别取自那份计划）
   */
  taskId: Type.String(),
  taskTitle: Type.String(),
  /**
   * 属于哪个定时触发的任务（76 号票）：看板上、任务详情里显示的是这个任务。76 号票起登记的就是 taskId；
   * 之前的定时作业迁移时（scheduled_job 的 migrated）补上迁移出的那个普通任务。没有的是还没迁移（或者迁移前就取消了）的
   */
  ownerTaskId: Type.Optional(Type.String()),
  /**
   * 项目内部任务的计划里定的作业（64 号票）：跟着任务只在项目内部看得到——不上全局看板的"运营中"，在项目页的定时作业里；
   * 要用户处理的照常进待我处理（标着项目内部）
   */
  internal: Type.Optional(ProjectInternal),
  /**
   * 每次运行的授权（随计划卡一起确认的，用户勾掉、收窄之后的样子）：授权项在作业在的时候一直有效，不按 7 天续期；
   * 暂停、取消作业即收回。超出的照常先问用户
   */
  grants: Type.Array(PlanGrant),
  /** 每次运行都检查的时序规则：作业自己的，加上计划里用户的限制编译出的 */
  temporalRules: Type.Array(PlanTemporalRule),
  /** 每项授权在守卫眼里的样子（确认计划时的；作业卡上写"执行时仍会问"之类） */
  grantInfo: Type.Record(Type.String(), GrantInfo),
  state: Type.Enum(SCHEDULED_JOB_STATES),
  /** 已暂停的：为什么暂停 */
  pausedBy: Type.Optional(Type.Enum(JOB_PAUSE_REASONS)),
  /** 下一次到点的时间（定时触发、运营中的才有） */
  nextAt: Type.Optional(Type.String()),
  /** 最近的一次运行（可能还在排队、运行中） */
  lastRun: Type.Optional(JobRun),
  /** 最近结束的一次运行失败了：作业卡上标"最近一次失败" */
  lastFailed: Type.Boolean(),
  /** 连续失败了几次（有一次成功就清零；到了配置的次数（默认 3）自动暂停，用户恢复时也清零） */
  consecutiveFailures: Type.Integer({ minimum: 0 }),
  /** 一共运行过几次（含正在运行的） */
  runCount: Type.Integer({ minimum: 0 }),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type ScheduledJob = Static<typeof ScheduledJob>;

/** `scheduled_job` 事件（任务看板频道）：作业的最新状态、这次是什么变化、谁改的，以及这次说到的运行（运行的变化都带着它） */
export const ScheduledJobEventPayload = Type.Object({
  job: ScheduledJob,
  change: Type.Enum(SCHEDULED_JOB_CHANGES),
  by: Type.Enum(TASK_ACTORS),
  run: Type.Optional(JobRun),
});
export type ScheduledJobEventPayload = Static<typeof ScheduledJobEventPayload>;

/** 看板上对定时触发的任务的动作（scheduled_job_action）：暂停、恢复、取消（取消时任务随之取消） */
export const ScheduledJobActionParams = Type.Object({ jobId: Type.String({ minLength: 1 }), action: Type.Enum(SCHEDULED_JOB_ACTIONS) });
export type ScheduledJobActionParams = Static<typeof ScheduledJobActionParams>;

export const ScheduledJobActionResult = Type.Object({ jobId: Type.String(), state: Type.Enum(SCHEDULED_JOB_STATES) });
export type ScheduledJobActionResult = Static<typeof ScheduledJobActionResult>;

/**
 * 改时间表（98 号票，reschedule_job）：定时触发的、没取消的触发登记换一份时间表（和简单提醒同一个 ReminderSchedule：重复的，
 * 或者某个时间做一次——那个时间要在将来）。任务、会话、运行记录都不变，下一次按新的现算；暂停着的改完照旧暂停
 */
export const RescheduleJobParams = Type.Object({ jobId: Type.String({ minLength: 1 }), schedule: ReminderSchedule });
export type RescheduleJobParams = Static<typeof RescheduleJobParams>;

/** 改完的样子：状态（照旧）、新的时间表、下一次（暂停着的、某个时间做一次已经做过的没有） */
export const RescheduleJobResult = Type.Object({ jobId: Type.String(), state: Type.Enum(SCHEDULED_JOB_STATES), schedule: ReminderSchedule, nextAt: Type.Optional(Type.String()) });
export type RescheduleJobResult = Static<typeof RescheduleJobResult>;

// ───────────────────────── 归档清单 ─────────────────────────

/** 归档清单上的一项：一个结束超过 7 天、还没归档的任务，能选什么、选了什么 */
export const ArchiveListItem = Type.Object({
  taskId: Type.String(),
  title: Type.String(),
  /** 建清单时任务的状态：已完成、失败、已取消 */
  state: Type.Enum(TASK_STATES),
  endKind: Type.Optional(Type.Enum(TASK_END_KINDS)),
  /** 结束的时间 */
  endedAt: Type.String(),
  /** 这一项能选的（已取消的、转为项目结束的回不到执行中：只有归档和先留着） */
  choices: Type.Array(Type.Enum(ARCHIVE_CHOICES)),
  /** 选了什么（还没选的没有） */
  decision: Type.Optional(Type.Enum(ARCHIVE_CHOICES)),
  decidedAt: Type.Optional(Type.String()),
});
export type ArchiveListItem = Static<typeof ArchiveListItem>;

/** 归档清单卡（archive_list）的负载：每一项都选了之后卡片算处理完 */
export const ArchiveListCardPayload = Type.Object({
  items: Type.Array(ArchiveListItem, { minItems: 1 }),
  /** 结束超过几天的任务进了清单 */
  afterDays: Type.Integer({ minimum: 1 }),
  /** 结束早于这一刻的任务进了清单 */
  cutoff: Type.String(),
});
export type ArchiveListCardPayload = Static<typeof ArchiveListCardPayload>;

/** 归档清单卡的动作 decide 的输入：对其中一项的选择；继续改已完成的任务时可以指明从哪个阶段返工（不写是最后一个阶段），可附一句话交给维护者 */
export const ArchiveListDecideInput = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  choice: Type.Enum(ARCHIVE_CHOICES),
  stageId: Type.Optional(Type.String({ minLength: 1 })),
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});
export type ArchiveListDecideInput = Static<typeof ArchiveListDecideInput>;
