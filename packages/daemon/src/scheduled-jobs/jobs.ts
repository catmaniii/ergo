// 触发底座（76 号票，ADR 0025；19 号票时叫定时作业，ADR-0017 的运行机制照旧复用）：定时（77 号票起还有事件）触发的任务的
// 触发登记、触发、排队合并、名额、运行和结局、失败和自动暂停、用户的暂停恢复取消、项目停用归档和恢复、守护进程启动时补跑错过的、
// 每次运行的授权，以及以前的定时作业迁移成定时触发的普通任务。状态全在事件日志里（任务看板频道上的 scheduled_job 事件，
// 派生视图 views.ts），这里只管编排；说法在 texts.ts，幂等键在 keys.ts。
//
// - 登记：定时触发的任务登记好了（Task.state 是运营中：普通任务建出就是，流程在计划卡上授权之后是）就登记一份触发登记（j-<n>，
//   ownerTaskId 是这个任务），进入运营中。执行的就是任务的执行者：属于项目的（项目内部任务）由项目的维护者在一张工单里做，
//   不属于项目的由任务自己的 agent（tm-<n>，maintainers/）做——各次运行接着同一段会话，后面的运行知道前几次的情况。
//   项目已停用、已归档时登记成已暂停。
// - 触发（fire）：每被触发一次是一次运行。时间到了也是一种事件（source 是 time，调度器到点时进来）；77 号票的事件来源接在同一个口子上
//   （event-sources/ 的分发按订阅调 fire，去重键由来源给）。事件触发的任务的登记没有时间表，写在等什么事件（ScheduledJob.event）。
//   上一次还没跑完又被触发：排队合并——还有排着、没开始的那一次就并进它（属于项目的工单还排着时，工单的内容一起换成合并后的）；
//   正在跑、没有排着的，新起一次排着，等正在跑的结束再开始。不并行，不丢：期间来的都在这一批里交给它（JobRun.events）。
// - 名额：每次运行真正开始时占一个全局执行名额（tasks/slots.ts，和执行中的任务共用），满了排队，名额空出后才开始：
//   - 属于项目的：同一事务里派一张来源为"定时触发"的工单（work-orders.ts 的 dispatchRun），在项目的队列里排着（不占名额），
//     排到了、又有名额才开始（工单开始时这次运行开始；项目的维护者一次只做一张，同一个任务的两次运行自然一前一后）；
//     工单结束时这次运行结束（完成是成功，退回、做不了是失败）；
//   - 不属于项目的：同一个任务上一次还在跑时不开始；有名额时交给执行它的 agent 一条带着任务和登记身份的通知（会话里先画一条运行的分段线），
//     它处理完这一轮就结束。
//   这一轮正常结束是成功；agent 用 fail_job_run 报了原因的、这一轮出错或被中止的、有一步等不到批准被拦下或交给用户亲手做的是失败；
//   守护进程停机打断的记为中断（不重做，不算进连续失败）。定时触发的流程一轮要收工时还有步骤没做，提醒一次（照 59 号票）再算结局。
// - 授权：普通任务的每次运行按普通对话那一套判（守卫看不到计划，受对话审批的开关管）；流程授权一次（计划卡），之后每次运行都按步骤核对
//   （guardTask：带着授权的会话段，每次运行一段——授权项的次数、时序规则、和计划逐步比对的历史都只看这一次），任务在运营就一直有效，
//   暂停、取消即收回；迁移来的定时作业照旧按随计划卡确认的授权（作业的授权项、时序规则、建它的任务的关注类别）。
//   事件触发的流程（77 号票）：这次运行照的步骤是一批里每个事件各一遍、参数里的占位代入这个事件的值（tasks/workflow-events.ts），
//   守卫按代入后的步骤逐步核对，授权项按执行它的维护者现取真实路径、由代入后的步骤推出（tasks/workflow-plan.ts 的 boundRunWorkflow）。
// - 失败：记一条失败的运行记录，卡上标"最近一次失败"；连续失败到配置的次数（scheduledJobs.jobFailures）自动转为已暂停，
//   同一事务里待我处理放一条"定时触发的任务被自动暂停"（动作：恢复、保持暂停）；中间有一次成功就重新计数。
// - 用户在看板上（或任务详情里）暂停、恢复、取消（scheduled_job_action，任务的 task_action 也落到这里）：暂停、取消时排着的运行一并丢掉
//   （属于项目的退回它的工单）；取消时任务同一事务取消。任务被取消、结束了（任务详情里取消、删除项目……）触发登记随之取消。
//   项目停用、归档时运营中的暂停，重新启用、取消归档时只恢复因此暂停的；这些都不改项目状态。
// - 用户改时间表（reschedule_job，98 号票）：只换时间表、重算下一次，任务、会话、运行记录不动；暂停着的照旧暂停。
//   改成某个时间做一次的：那一次运行做成了（没有下一次），任务算完成、触发登记随之结束（照 76 号票"到点做一次、做完即完成"）。
// - 迁移（不改写事件日志，ADR 0025）：76 号票之前长程任务计划里登记的定时作业（没取消的），各建出一个定时触发的普通任务
//   （新的 task 事件，origin 是 migrated，执行的 agent、会话、运行记录、授权都沿用：维护者照旧是作业自己的 jm-<n> 或项目的维护者），
//   同一事务追加一条 scheduled_job 的 migrated（ownerTaskId 指向它）。原来的事件一条不动。
// - 错过的触发（规格第 13、17 节）：守护进程启动时（23 号票的恢复做完之后），过了点的运营中登记不管错过几次只补跑一次
//   （运行记录写明错过了几次），下一次从现在往后算；补完再重启不会再补（下一次的时间和这次运行同一事务落盘）。
import { randomUUID } from "node:crypto";
import {
  canRescheduleJob,
  CHANNELS,
  dependsOnWorkdayCalendar,
  emptyToolkit,
  EVENT_TYPES,
  type InboxItemEventPayload,
  type GrantInfo,
  internalMark,
  isDeletedEventPayload,
  isJobRunWorkOrder,
  isLegacyJob,
  isRepeating,
  isTriggered,
  onceAt,
  JOB_AUTO_PAUSED_ACTIONS,
  type JobAutoPausedNoticeData,
  type JobPauseReason,
  type JobRun,
  type JobRunTrigger,
  type JobRunWorkOrder,
  latestOccurrence,
  MAINTAINER_CHANNEL_PREFIX,
  maintainerChannel,
  type MessageScope,
  nextOccurrence,
  nowIso,
  occurrencesBetween,
  type Project,
  type ProjectEventPayload,
  type ReminderSchedule,
  type ReportedStepState,
  repeatRuleOf,
  repeatSchedule,
  type RescheduleJobParams,
  type RescheduleJobResult,
  runEvents,
  type ScheduleContext,
  type ScheduledJob,
  type ScheduledJobAction,
  type ScheduledJobActionParams,
  type ScheduledJobActionResult,
  type ScheduledJobChange,
  type ScheduledJobEventPayload,
  SCHEDULED_JOB_ACTION_LABEL,
  scheduledJobActions,
  SETTLED_STEP_STATES,
  type Task,
  type TaskActor,
  type TaskEventPayload,
  taskKind,
  taskProjectScope,
  type TaskStep,
  TIME_TRIGGER_SOURCE,
  timeTriggerSummary,
  type TriggerEvent,
  type TurnEndEventPayload,
  WORKFLOW_STAGE_ID,
  type WorkOrderEventPayload,
  type WorkflowStepView,
  ENDED_TASK_STATES,
  type Plan,
  type PlanGrant,
} from "@ergou/protocol";
import { getApproval } from "../approvals/views.ts";
import { buildAgentNotice, buildMessage } from "../conversation/messages.ts";
import { getMessage, inputOf, recentMessagesOf } from "../conversation/views.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { type GuardTask, type GuardTaskContext, planPending } from "../guard/index.ts";
import { type ApprovalSuspendedPayload, GUARD_CHANNEL, GUARD_EVENTS } from "../guard-runtime/events.ts";
import { planHistory } from "../guard-runtime/plan-check.ts";
import type { HandOverData } from "../hand-over/hand-over.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { JobRunAssembly } from "../maintainers/assembly.ts";
import type { ProjectService } from "../projects/projects.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { JOB_RUN_STAGE, toGuardJobPlan, toGuardPlan } from "../tasks/plan.ts";
import type { ExecutionSlots } from "../tasks/slots.ts";
import type { TaskService } from "../tasks/tasks.ts";
import type { StoredPlan } from "../tasks/views.ts";
import { boundRunWorkflow, guardWorkflow } from "../tasks/workflow-plan.ts";
import { eventShellEnv, runWorkflowSteps } from "../tasks/workflow-events.ts";
import { executedSteps, stepsAtFinish, stepsOnStart } from "../tasks/workflow-run.ts";
import { plainResult } from "../tasks/plain.ts";
import { oneLine } from "../util/text.ts";
import type { WorkOrders } from "../work-orders/work-orders.ts";
import { jobKeys } from "./keys.ts";
import {
  batchSplitLog,
  autoPausedNotice,
  blockedReason,
  droppedReason,
  INTERRUPTED_REASON,
  jobSource,
  legacyPlanJobsNote,
  legacyPlanJobSummary,
  migratedSummary,
  onceMissedNote,
  PROJECT_GONE_REASON,
  projectBlocksResume,
  refusal,
  runDividerTitle,
  runInstructions,
  RUN_SUMMARY_MAX,
  runPendingNudge,
  runStepsLeftReason,
  turnFailure,
  WORK_ORDER_NOT_DONE,
} from "./texts.ts";
import { failJobRunTool, runPlanChangeRefusalTool, runReportStepTool } from "./tools.ts";
import { legacyPlanJobs } from "./legacy-plan.ts";
import { countJobs, getJob, getRun, jobOfTask, jobsOfProject, listJobs, runsIn, runsOfJob } from "./views.ts";

/** 作业自己的维护者（76 号票之前登记的、不属于项目的定时作业，j-<n> 的是 jm-<n>；迁移成普通任务后照旧由它做） */
export function jobMaintainerId(jobId: string): string {
  return `jm-${jobId.replace(/^j-/, "")}`;
}

/** 是不是作业自己的维护者（jm-<n>）：由作业维护者模块（maintainers.ts）接，任务的维护者模块不接 */
export function isJobMaintainerId(maintainerId: string): boolean {
  return /^jm-\d+$/.test(maintainerId);
}

/** 定时触发的流程每次运行和计划比对时用的计划编号：每次运行一份，计划检查的历史（plan_call_committed）、修过几次都只看这一次 */
export const runPlanId = (planId: string, runId: string) => `${planId}@${runId}`;

/** 交给 agent 的一次运行的内容里列前几次运行的结果：最多几次 */
const PREVIOUS_RUNS_SHOWN = 3;

export interface ScheduledJobsOptions {
  store: EventStore;
  tasks: TaskService;
  projects: ProjectService;
  /** 派单器里触发底座要用的那几样：派一张运行工单、合并时换掉还排着的工单的内容、这次的活做完了让这一段收尾、暂停取消时退回排着的工单 */
  workOrders: Pick<WorkOrders, "dispatchRun" | "updateRun" | "finishRun" | "dropRun" | "get" | "currentWorkOrder">;
  inbox: InboxService;
  scheduler: Scheduler;
  clock: Clock;
  now: () => string;
  /** 算下一次时要的东西：当前的个人工作日历（"按我的工作日"的时间表按它算） */
  scheduleContext: () => ScheduleContext;
  /** 全局执行名额（tasks/slots.ts）：不属于项目的那边排队的运行，有名额才开始 */
  slots: Pick<ExecutionSlots, "hasSlot" | "onFreed">;
  /** 连续失败几次自动暂停（配置 scheduledJobs.jobFailures） */
  failureLimit: number;
  /**
   * 事件触发的任务一次运行最多照多少步（77 号票，配置 eventSources.maxRunSteps）：一批事件数 × 流程的步骤数（普通任务每个事件算一步）。
   * 排着的那一次到了上限，再来的事件另起一次排着（一次接一次跑）。不给是不限
   */
  maxRunSteps?: number | undefined;
  log: (line: string) => void;
}

export interface ScheduledJobs {
  /** 接上事件（登记、运行的结局、项目停用归档）：要在维护者开始接输入之前（它们被杀后标中断时这里要看到） */
  attach(): void;
  /** 23 号票的恢复做完之后：补登记、迁移以前的定时作业，对一遍重启前在跑的运行，登记到点的计时器，补跑停机期间错过的，排着的按名额开始 */
  start(): void;
  stop(): void;
  get(jobId: string): ScheduledJob | undefined;
  list(): ScheduledJob[];
  /** 某个项目的（项目页） */
  ofProject(projectId: string): ScheduledJob[];
  /** 一个定时触发的任务的触发登记（还没登记好的是 undefined） */
  ofTask(taskId: string): ScheduledJob | undefined;
  /**
   * 触发底座的口子（76 号票）：这个任务被触发了一次（77 号票的事件来源接在这里；时间到了由调度器自己进来）。
   * 没在跑的起一次运行；上一次还没跑完的排队合并（并进还排着的那一次，或者新起一次等正在跑的结束）。
   * 任务没登记好、暂停着、取消了的不运行（ignored，写明原因）。幂等键由事件来源给（同一个事件重发只收一次）；
   * 不给的每次都算一个新事件（jobKeys.fire 各取各的，排队合并期间来的几次不会撞成一次）
   */
  fire(taskId: string, event: TriggerEvent, idempotencyKey?: string): FireOutcome;
  /** 用户在看板上的动作：同一个幂等键重发拿到同一个结果 */
  act(params: ScheduledJobActionParams, idempotencyKey: string): ScheduledJobActionResult;
  /**
   * 用户改时间表（98 号票）：只换时间表、重算下一次；同一个幂等键重发拿到同一个结果。没有的、事件触发的、已取消的，
   * 某个时间做一次的时间已过的抛 RequestRejected
   */
  reschedule(params: RescheduleJobParams, idempotencyKey: string): RescheduleJobResult;
  /** 用户对定时触发的任务的暂停、恢复、取消（任务详情里的 task_action 落到这里）；不是定时触发的任务抛 RequestRejected */
  actOnTask(taskId: string, action: ScheduledJobAction, idempotencyKey: string): { taskId: string; state: Task["state"] };
  /** 执行它的 agent 报这次运行失败（fail_job_run）：记下原因，这一轮结束时这次运行记为失败 */
  reportFailure(maintainerId: string, reason: string): { runId: string };
  /** 定时触发的流程：这次运行里汇报某一步的状态（report_step）；不在流程的运行里、步骤不在计划里的抛 RequestRejected */
  reportStep(maintainerId: string, report: { stepId: string; state: ReportedStepState; gist?: string }): { done: number; total: number };
  /** 一次运行要的装配（作业自己的维护者、任务自己的 agent、项目维护者的运行工单段）：工具包、工具、来源、守卫看到的授权 */
  runAssembly(jobId: string, maintainerId: string): JobRunAssembly | undefined;
  /** 守卫看到的这份触发登记现在这次运行的授权（runAssembly 的 guardTask 就是它；测试也直接看） */
  guardTask(jobId: string, ctx?: GuardTaskContext): GuardTask | null;
  /**
   * 升级前交了、升级后才确认的长程任务计划里还写着定时作业（76 号票，主会话定：不悄悄丢掉）：照以前定时作业的迁移办法建成定时触发的
   * 普通任务。给出要和确认计划同一事务追加的事件，和卡上的说明（"计划里的定时作业已改成定时任务「X」"）；计划里没有的给空的
   */
  legacyPlanConfirmed(task: Task, stored: StoredPlan, grantInfo: Record<string, GrantInfo>): { events: NewEvent[]; note?: string };
  /** 现在正在运行的那一次（运行号） */
  currentRun(jobId: string): string | undefined;
  /** 一次运行交给执行它的 agent 的那条通知的消息 id（还没交的是 undefined）：换模型只在一次运行的开头换（83 号票） */
  runNoticeId(runId: string): string | undefined;
  /** 个人工作日历变了：跟着它变的按新的工作日历重算下一次 */
  rearm(): void;
  /**
   * 日历上定时触发的任务（35 号票用）：[from, to) 之间每个没取消的触发登记的时间表展开（按当前的个人工作日历，"按我的工作日"的照它；
   * 已暂停的也展开，看 state、pausedBy 标出来），和这段时间里到点的运行记录（按触发时间）
   */
  calendar(from: Date, to: Date): JobCalendarEntry[];
}

/** 触发一次的结果：起了一次运行、并进了还排着的那一次、没运行（原因） */
export type FireOutcome = { outcome: "queued"; runId: string } | { outcome: "merged"; runId: string } | { outcome: "ignored"; reason: string };

/** 日历上的一个定时触发的任务：触发登记（状态、暂停的原因都在上面）、这段时间里该触发的时刻、这段时间里的运行记录 */
export interface JobCalendarEntry {
  /** 定时触发的（事件触发的不上日历） */
  job: ScheduledJob & { schedule: ReminderSchedule };
  /** 现在的时间表从哪一刻起生效：登记的时候，或者用户最后一次改时间表的时候（98 号票）；之前的只列真跑过的 */
  since: string;
  /** 时间表在这段时间里的每一次（协议时间），先到的在前 */
  occurrences: string[];
  /** 触发时间落在这段时间里的运行，先触发的在前 */
  runs: JobRun[];
}

/** 一次运行怎么结束的：成功、失败；中断（停机打断）、没运行（排着时暂停、取消了）不算进连续失败 */
type RunEnd = { state: "done" } | { state: "failed" | "interrupted" | "dropped"; reason: string };

const errorText = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));
const schedulerKey = (jobId: string) => `job:${jobId}`;

/** 去掉下一次的时间（已暂停、已取消的没有） */
function withoutNextAt(job: ScheduledJob): ScheduledJob {
  const { nextAt: _n, ...rest } = job;
  return rest;
}

/** 去掉暂停的原因（恢复、取消时） */
function withoutPause(job: ScheduledJob): ScheduledJob {
  const { pausedBy: _p, ...rest } = job;
  return rest;
}

export function jobEvent(job: ScheduledJob, change: ScheduledJobChange, by: TaskActor, run?: JobRun, idempotencyKey?: string): NewEvent {
  const payload: ScheduledJobEventPayload = { job, change, by, ...(run ? { run } : {}) };
  return { channel: CHANNELS.board, type: EVENT_TYPES.scheduledJob, payload, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) };
}

/** 项目停用、归档了：登记成、或者转为因此暂停 */
const projectPause = (project: Pick<Project, "state"> | undefined): JobPauseReason | undefined =>
  project?.state === "retired" ? "project_retired" : project?.state === "archived" ? "project_archived" : undefined;

/**
 * 流程这次运行要照的步骤：事件触发的（77 号票）一批里每个事件各走一遍、参数里的占位代入这个事件的值；定时触发的就是授权的那份计划的步骤
 */
const runSteps = (job: ScheduledJob, stored: StoredPlan, run: JobRun | undefined): WorkflowStepView[] =>
  job.event && run ? runWorkflowSteps(stored.workflow!.steps, runEvents(run)) : stored.workflow!.steps;

/** 事件触发的任务一次运行最多几个事件：一次运行最多照的步数 ÷ 每个事件的步数（流程的步骤数；普通任务算一步），至少一个 */
const eventsPerRun = (maxRunSteps: number | undefined, stepsPerEvent: number): number =>
  maxRunSteps === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(maxRunSteps / Math.max(1, stepsPerEvent)));

/** 换掉执行用的计划里的授权项（事件触发的流程每次运行由代入后的步骤推出，77 号票） */
const withGrants = (plan: Plan, grants: readonly PlanGrant[]): Plan => ({ ...plan, stages: plan.stages.map((st) => ({ ...st, policy: { ...st.policy, grants: [...grants] } })) });

/** 改时间（98 号票）的结果：状态（照旧）、新的时间表、下一次 */
const rescheduleResult = (job: ScheduledJob): RescheduleJobResult => ({ jobId: job.id, state: job.state, schedule: job.schedule!, ...(job.nextAt === undefined ? {} : { nextAt: job.nextAt }) });

/** 某个时间做一次的任务（等时间）的计时器 */
const onceSchedulerKey = (taskId: string) => `task-once:${taskId}`;

/** 这条调用的归属里是哪份触发登记（运行的通知、运行工单段里的消息都带着它） */
const jobOfScope = (scope: MessageScope | undefined) => scope?.scheduledJobId;

export function createScheduledJobs(options: ScheduledJobsOptions): ScheduledJobs {
  const { store, tasks, projects, workOrders, inbox, scheduler, clock, now, scheduleContext, log } = options;
  const unsubscribes: Array<() => void> = [];
  /** 这一轮里没做成的运行（运行号 → 原因）：agent 用 fail_job_run 报的、等不到批准被拦下的、交给用户亲手做的。重启后这一轮反正算中断 */
  const notDone = new Map<string, string>();
  /** 定时触发的流程：这一次运行已经提醒过一次还有步骤没做（重启后这次反正算中断） */
  const nudged = new Set<string>();
  /**
   * 这次运行最后说的那一两句（运行号 → 话）：收工那一轮结束时记下，运行结束时存进运行记录（属于项目的要等工单写回后才结束）。
   * 重启后没了的，这次运行记录里就没有
   */
  const summaries = new Map<string, string>();
  /**
   * 事件触发的流程这次运行代入了事件的值之后的步骤和授权项（运行号 → 按哪个 agent 算的、算出来的）：每次判定都现算太费（要取真实路径），
   * 这次运行结束时扔掉；重启后再算一遍（同一批事件，结果一样）
   */
  const bindings = new Map<string, { agent: string; steps: WorkflowStepView[]; grants: PlanGrant[] }>();
  let fillQueued = false;
  let stopped = false;
  let started = false;

  const nowDate = () => new Date(clock.now());
  /** 下一次到点的时间；事件触发的（没有时间表）没有 */
  const next = (schedule: ReminderSchedule | undefined, after: Date) => {
    const at = schedule && nextOccurrence(schedule, after, scheduleContext());
    return at ? nowIso(at) : undefined;
  };
  /** 还没结束的运行（排队、运行中） */
  const outstanding = (jobId: string) => runsOfJob(store.reader, jobId).filter((r) => r.state === "queued" || r.state === "running");
  /** 正在运行的那一次 */
  const runningRunOf = (jobId: string) => runsOfJob(store.reader, jobId).find((r) => r.state === "running");
  /** 属于哪个定时触发的任务（还没迁移的没有） */
  const ownerOf = (job: ScheduledJob): Task | undefined => (job.ownerTaskId === undefined ? undefined : tasks.get(job.ownerTaskId));
  /** 定时触发的流程（76 号票起登记的）：授权的那份计划 */
  const workflowOf = (job: ScheduledJob): StoredPlan | undefined => {
    if (isLegacyJob(job)) return undefined;
    const task = ownerOf(job);
    if (!task || taskKind(task) !== "workflow") return undefined;
    const stored = tasks.confirmedPlan(task.id);
    return stored?.workflow ? stored : undefined;
  };

  // ───────────────────────── 登记、迁移 ─────────────────────────

  /**
   * 定时触发的任务登记好了（运营中）：登记一份触发登记（按任务只登记一次），由任务的执行者做：属于项目的是项目的维护者
   * （每次运行一张工单），不属于项目的是任务自己的 agent。项目已停用、已归档时登记成已暂停
   */
  const registerTrigger = (task: Task) => {
    if (task.state !== "operating" || !task.trigger) return;
    // 定时触发的（重复的时间表）、事件触发的（77 号票：等事件来源推来）
    const schedule = task.trigger.kind === "schedule" && isRepeating(task.trigger.schedule) ? task.trigger.schedule : undefined;
    const event = task.trigger.kind === "event" ? task.trigger : undefined;
    if (!schedule && !event) return;
    if (jobOfTask(store.reader, task.id)) return;
    const key = jobKeys.registerTask(task.id);
    if (store.eventByIdempotencyKey(key)) return;
    const project = task.internal ? projects.get(task.internal.projectId) : undefined;
    const pausedBy = projectPause(project);
    const nextAt = pausedBy ? undefined : next(schedule, nowDate());
    const time = now();
    const id = `j-${countJobs(store.reader) + 1}`;
    const job: ScheduledJob = {
      id,
      title: task.title,
      ...(schedule ? { schedule } : {}),
      ...(event ? { event } : {}),
      each: task.summary,
      ...(project ? { projectId: project.id, projectName: project.name } : {}),
      maintainerId: task.maintainerId,
      taskId: task.id,
      taskTitle: task.title,
      ownerTaskId: task.id,
      ...internalMark(task.internal),
      // 普通任务不授权（按普通对话判）；流程的授权在它确认的计划里（每次运行现取，暂停、取消即收回）
      grants: [],
      temporalRules: [],
      grantInfo: {},
      state: pausedBy ? "paused" : "active",
      ...(pausedBy ? { pausedBy } : {}),
      ...(nextAt === undefined ? {} : { nextAt }),
      lastFailed: false,
      consecutiveFailures: 0,
      runCount: 0,
      createdAt: time,
      updatedAt: time,
    };
    // 用户发起（对话框里定时、计划卡上授权）才登记，算用户做的
    store.append(jobEvent(job, "registered", "user", undefined, key));
  };

  /**
   * 升级前交了、升级后才确认的长程任务计划里的定时作业（主会话定，不悄悄丢掉）：照以前定时作业的迁移办法——每个定义登记成一份以前那样的
   * 定时作业（属于项目的由项目的维护者做，不属于的由作业自己的维护者 jm-<n> 做；每次运行的授权照计划卡上的，连同用户的限制编出的规则），
   * 同一事务建出它的定时触发的普通任务（ownerTaskId 指向它）。给出要和确认计划同一事务追加的事件，和卡上的说明
   */
  const legacyPlanConfirmed = (task: Task, stored: StoredPlan, cardInfo: Record<string, GrantInfo>): { events: NewEvent[]; note?: string } => {
    const defs = legacyPlanJobs(stored.plan);
    // 属于项目的作业只来自单项目任务（和 19 号票登记时一样）
    const project = taskProjectScope(task) === "single" ? projects.projectOf(task) : undefined;
    const pausedBy = projectPause(project);
    const limitRules = (stored.plan.userLimits ?? []).flatMap((l) => l.temporalRules);
    const time = now();
    const events: NewEvent[] = [];
    const titles: string[] = [];
    let n = countJobs(store.reader);
    defs.forEach((def, i) => {
      if (store.eventByIdempotencyKey(jobKeys.legacyPlanJob(stored.planId, i))) return;
      n += 1;
      const id = `j-${n}`;
      const policy = def.policy ?? { grants: [], temporalRules: [] };
      const maintainerId = project ? project.maintainerId : jobMaintainerId(id);
      const nextAt = pausedBy ? undefined : next(def.schedule, nowDate());
      const job: ScheduledJob = {
        id,
        title: def.title,
        schedule: def.schedule,
        each: def.each,
        ...(project ? { projectId: project.id, projectName: project.name } : {}),
        maintainerId,
        taskId: task.id,
        taskTitle: task.title,
        ...internalMark(task.internal),
        grants: policy.grants,
        temporalRules: [...policy.temporalRules, ...limitRules],
        grantInfo: Object.fromEntries(policy.grants.flatMap((g) => (cardInfo[g.id] ? [[g.id, cardInfo[g.id]!]] : []))),
        state: pausedBy ? "paused" : "active",
        ...(pausedBy ? { pausedBy } : {}),
        ...(nextAt === undefined ? {} : { nextAt }),
        lastFailed: false,
        consecutiveFailures: 0,
        runCount: 0,
        createdAt: time,
        updatedAt: time,
      };
      const built = tasks.buildMigrated(
        { title: job.title, summary: legacyPlanJobSummary(job), schedule: def.schedule, maintainerId, project: project && { id: project.id, name: project.name }, internal: task.internal },
        titles.length,
      );
      titles.push(built.task.title);
      // 用户确认计划才登记，算用户做的
      events.push({ ...built.event, idempotencyKey: jobKeys.legacyPlanJob(stored.planId, i) }, jobEvent({ ...job, ownerTaskId: built.task.id }, "registered", "user", undefined, jobKeys.legacyPlanJobLink(stored.planId, i)));
    });
    return titles.length === 0 ? { events } : { events, note: legacyPlanJobsNote(titles) };
  };

  /**
   * 76 号票之前的定时作业（没有它的任务、还没取消）迁移成定时触发的普通任务（ADR 0025：不改写事件日志）：
   * 新的 task 事件建出任务（执行的 agent、会话、授权、运行记录照旧），同一事务一条 scheduled_job 的 migrated 指向它
   */
  const migrateLegacy = () => {
    for (const job of listJobs(store.reader)) {
      if (job.ownerTaskId !== undefined || job.state === "cancelled") continue;
      try {
        if (!job.schedule) continue;
        const built = tasks.buildMigrated({ title: job.title, summary: migratedSummary(job), schedule: job.schedule, maintainerId: job.maintainerId, project: job.projectId === undefined ? undefined : { id: job.projectId, name: job.projectName ?? job.projectId }, internal: job.internal });
        const linked: ScheduledJob = { ...job, ownerTaskId: built.task.id, updatedAt: now() };
        store.appendBatch([{ ...built.event, idempotencyKey: jobKeys.migrate(job.id) }, jobEvent(linked, "migrated", "system", undefined, jobKeys.migrateLink(job.id))]);
        log(`定时作业 ${job.id}「${job.title}」迁移成定时触发的普通任务 ${built.task.id}`);
      } catch (err) {
        log(`定时作业 ${job.id} 迁移出错：${errorText(err)}`);
      }
    }
  };

  // ───────────────────────── 某个时间做一次 ─────────────────────────

  /**
   * 某个时间做一次（用户 2026-10-10 定）：时间到了也是一条事件——等时间的任务到点进排队，之后和现在做一次的一样（执行控制器、派单器照常：
   * 有名额就开始，做完即完成）。等时间时登记计时器，离开等时间（到点、取消）就撤掉；那个时间已经过了的（授权计划时已经过了点）马上进排队
   */
  const armOnce = (task: Task) => {
    if (stopped || !started) return;
    const at = onceAt(task);
    if (task.state !== "scheduled" || at === undefined) return scheduler.cancel(onceSchedulerKey(task.id));
    if (Date.parse(at) <= clock.now()) return onceDue(task.id, false);
    scheduler.schedule(onceSchedulerKey(task.id), Date.parse(at), () => onceDue(task.id, false));
  };

  /** 到点了：从等时间进排队（系统）。守护进程停着时错过的（开机补做，和 ADR 0017 一样只补一次），会话里记一句原定什么时候 */
  const onceDue = (taskId: string, missed: boolean) => {
    const task = tasks.get(taskId);
    const at = task && onceAt(task);
    if (!task || task.state !== "scheduled" || at === undefined || store.eventByIdempotencyKey(jobKeys.onceDue(taskId))) return;
    const moved = tasks.buildChange(task, { ...task, state: "queued" }, { by: "system", change: "time_due" }, jobKeys.onceDue(taskId));
    const scope = { taskId, ...(task.internal ? { projectId: task.internal.projectId } : {}), idempotencyKey: jobKeys.onceMissedNote(taskId) };
    const note = missed ? [buildMessage({ conversation: maintainerChannel(task.maintainerId), speaker: "system", parts: [{ type: "text", text: onceMissedNote(at) }] }, scope).event] : [];
    store.appendBatch([moved.event, ...note]);
    log(`任务 ${taskId} 定在 ${at} 做一次：${missed ? "停机期间错过了，开机补做" : "到点了"}，进排队`);
  };

  // ───────────────────────── 计时器和触发 ─────────────────────────

  /** 按最新状态登记或取消到点的计时器 */
  const arm = (job: ScheduledJob) => {
    if (stopped || !started) return;
    if (job.state === "active" && job.nextAt !== undefined) scheduler.schedule(schedulerKey(job.id), Date.parse(job.nextAt), () => timeUp(job.id, "scheduled"));
    else scheduler.cancel(schedulerKey(job.id));
  };

  /**
   * 到点（或者启动时补跑错过的）：时间到了也是一种事件，进触发底座（enqueue）；下一次的时间往后算，和这次触发同一事务。
   * 错过几次都只这一次（运行记录写明错过了几次）
   */
  const timeUp = (jobId: string, kind: JobRunTrigger) => {
    const job = getJob(store.reader, jobId);
    const at = nowDate();
    if (!job?.schedule || job.state !== "active" || job.nextAt === undefined || Date.parse(job.nextAt) > at.getTime()) return;
    const { due, count } = latestOccurrence(job.schedule, new Date(job.nextAt), at, scheduleContext());
    const nextAt = next(job.schedule, at);
    const moved: ScheduledJob = { ...withoutNextAt(job), ...(nextAt === undefined ? {} : { nextAt }), updatedAt: now() };
    const missed = kind === "catch_up" ? count : undefined;
    const event: TriggerEvent = { source: TIME_TRIGGER_SOURCE, at: nowIso(due), summary: timeTriggerSummary(kind, due, missed) };
    enqueue(moved, event, { trigger: kind, ...(missed === undefined ? {} : { missed }) }, jobKeys.trigger(job.id, nowIso(due)));
  };

  /**
   * 触发底座：这一次触发进来。还有排着、没开始的那一次就并进它（排队合并）；否则新起一次排着——正在跑的那次结束之后才开始
   * （不属于项目的由 fill 按任务一次一个地开始；属于项目的工单在项目的队列里排在正在跑的那张后面）。job 是这次要落盘的样子
   * （到点时下一次的时间已经往后算了）
   */
  const enqueue = (job: ScheduledJob, event: TriggerEvent, init: { trigger: JobRunTrigger; missed?: number }, key: string): FireOutcome => {
    const pending = outstanding(job.id);
    // 事件触发的（77 号票）：排着的那一次到了上限（一批事件数 × 步骤数），再来的另起一次排着
    const perRun = job.event ? eventsPerRun(options.maxRunSteps, workflowOf(job)?.workflow?.steps.length ?? 1) : Number.POSITIVE_INFINITY;
    const last = pending.findLast((r) => r.state === "queued");
    const queued = last && runEvents(last).length < perRun ? last : undefined;
    if (last && !queued) log(batchSplitLog(job.id, `${job.id}-r${job.runCount + 1}`, perRun));
    if (queued) {
      const merged: JobRun = { ...queued, events: [...runEvents(queued), event] };
      const after: ScheduledJob = { ...job, ...(job.lastRun?.runId === queued.runId ? { lastRun: merged } : {}) };
      // 属于项目、工单还排着：工单的内容换成合并后的这一批
      const updated = merged.workOrderId === undefined ? [] : workOrders.updateRun(merged.workOrderId, instructionsOf(after, merged), jobKeys.mergedWorkOrder(key));
      store.appendBatch([jobEvent(after, "merged", "system", merged, key), ...updated]);
      log(`${job.id} 又被触发了一次，上一次还没跑完：并进排着的 ${queued.runId}（这一批 ${merged.events!.length} 次）`);
      return { outcome: "merged", runId: queued.runId };
    }
    const run: JobRun = {
      runId: `${job.id}-r${job.runCount + 1}`,
      jobId: job.id,
      trigger: init.trigger,
      dueAt: event.at,
      ...(init.missed === undefined ? {} : { missed: init.missed }),
      events: [event],
      state: "queued",
      queuedAt: now(),
    };
    const counted: ScheduledJob = { ...job, lastRun: run, runCount: job.runCount + 1 };
    const project = job.projectId === undefined ? undefined : projects.get(job.projectId);
    if (job.projectId !== undefined && !project) {
      store.append(jobEvent(counted, "triggered", "system", run, key));
      finish(run, { state: "failed", reason: PROJECT_GONE_REASON });
      return { outcome: "queued", runId: run.runId };
    }
    // 属于项目的：这次运行的工单马上派出、在项目的队列里排着（维护者空着、又有名额就同一事务开始；上一次的工单还在做就排在它后面）
    const dispatched = project ? workOrders.dispatchRun({ job: counted, run, project, instructions: instructionsOf(counted, run), key: jobKeys.runWorkOrder(run.runId) }) : undefined;
    const placed: JobRun = dispatched ? { ...run, workOrderId: dispatched.workOrder.id } : run;
    store.appendBatch([jobEvent({ ...counted, lastRun: placed }, "triggered", "system", placed, key), ...(dispatched?.events ?? [])]);
    if (pending.length > 0) log(`${job.id} 被触发时上一次还在跑：这一次（${run.runId}）排着，等它结束再跑`);
    if (!dispatched) scheduleFill();
    return { outcome: "queued", runId: run.runId };
  };

  /** 交给 agent 的一次运行的内容：任务、流程授权的计划、前几次运行的结果 */
  const instructionsOf = (job: ScheduledJob, run: JobRun): string => {
    const previous = runsOfJob(store.reader, job.id)
      .filter((r) => r.runId !== run.runId && (r.state === "done" || r.state === "failed" || r.state === "interrupted"))
      .slice(-PREVIOUS_RUNS_SHOWN);
    const stored = workflowOf(job);
    return runInstructions({ job, run, failureLimit: options.failureLimit, task: ownerOf(job), workflow: stored?.workflow, ...(stored ? { steps: runSteps(job, stored, run) } : {}), previous });
  };

  // ───────────────────────── 名额和运行 ─────────────────────────

  /** 名额空出来时，不属于项目的那边先进队列的运行开始（同一个任务上一次还在跑的不开始；属于项目的由派单器按项目的队列和名额开始） */
  function fill(): void {
    fillQueued = false;
    if (stopped) return;
    for (const run of runsIn(store.reader, ["queued"])) {
      const job = getJob(store.reader, run.jobId);
      if (!job || job.projectId !== undefined) continue;
      if (runningRunOf(job.id)) continue;
      // 每开始一次，名额现数一次（运行开始和占名额在同一事务里）
      if (!options.slots.hasSlot()) return;
      try {
        startOwnRun(run);
      } catch (err) {
        log(`运行 ${run.runId} 开始时出错：${errorText(err)}`);
      }
    }
  }

  function scheduleFill(): void {
    if (fillQueued || stopped) return;
    fillQueued = true;
    queueMicrotask(fill);
  }

  /** 一次运行交给 agent 的那条通知的消息 id（还没交的是 undefined；重启后对账、换模型只在一次运行的开头换都用它） */
  const runNoticeId = (runId: string): string | undefined =>
    (store.eventByIdempotencyKey(jobKeys.runNotice(runId))?.payload as { message?: { id: string } } | undefined)?.message?.id;

  /**
   * 不属于项目的一次运行开始：会话里先画一条这次运行的分段线（任务详情按运行分段），再交给执行它的 agent 一条带着任务和登记身份的通知
   * （用量记在任务名下），和这次运行开始同一事务
   */
  const startOwnRun = (run: JobRun) => {
    const job = getJob(store.reader, run.jobId);
    if (!job) return;
    if (job.state !== "active") return finish(run, { state: "dropped", reason: droppedReason(job) });
    const running: JobRun = { ...run, state: "running", startedAt: now() };
    const conversation = maintainerChannel(job.maintainerId);
    const scope: MessageScope = { scheduledJobId: job.id, ...(job.ownerTaskId === undefined ? {} : { taskId: job.ownerTaskId }) };
    const divider = buildMessage(
      { conversation, speaker: "system", parts: [{ type: "run_divider", jobId: job.id, runId: run.runId, title: runDividerTitle(run) }] },
      { ...scope, idempotencyKey: jobKeys.runDivider(run.runId) },
    );
    const notice = buildAgentNotice(conversation, instructionsOf(job, run), jobKeys.runNotice(run.runId), scope);
    store.appendBatch([jobEvent({ ...job, ...(job.lastRun?.runId === run.runId ? { lastRun: running } : {}), updatedAt: running.startedAt! }, "run_started", "system", running, jobKeys.runStart(run.runId)), divider.event, notice.event]);
  };

  /** 属于项目的：这次运行的工单开始了（排到了、有名额），这次运行开始 */
  const onRunWorkOrderStarted = (wo: JobRunWorkOrder) => {
    const run = getRun(store.reader, wo.runId);
    const job = run && getJob(store.reader, run.jobId);
    if (!run || !job || run.state !== "queued") return;
    const running: JobRun = { ...run, state: "running", startedAt: wo.startedAt ?? now(), workOrderId: wo.id };
    store.append(jobEvent({ ...job, ...(job.lastRun?.runId === run.runId ? { lastRun: running } : {}), updatedAt: now() }, "run_started", "system", running, jobKeys.runStart(run.runId)));
  };

  /**
   * 一次运行结束：成功清零连续失败，算数的失败加一；运营中的连续失败到了次数自动暂停，同一事务里待我处理放一条事项。
   * 中断、排着时被丢掉的不算进连续失败，也不改"最近一次失败"。不属于项目的：结束之后名额空出来（slots 叫 fill），排着的下一次开始
   */
  function finish(run: JobRun, end: RunEnd): void {
    const job = getJob(store.reader, run.jobId);
    const latest = getRun(store.reader, run.runId) ?? run;
    if (!job || (latest.state !== "queued" && latest.state !== "running")) return;
    const time = now();
    const steps = finalSteps(job, latest);
    const summary = summaries.get(run.runId);
    const ended: JobRun = {
      ...latest,
      state: end.state,
      endedAt: time,
      ...(end.state === "done" ? {} : { reason: end.reason }),
      ...(summary === undefined ? {} : { summary }),
      ...(steps ? { steps } : {}),
    };
    const counted = end.state === "done" || end.state === "failed";
    const failures = end.state === "done" ? 0 : counted ? job.consecutiveFailures + 1 : job.consecutiveFailures;
    let after: ScheduledJob = {
      ...job,
      ...(job.lastRun?.runId === run.runId ? { lastRun: ended } : {}),
      ...(counted ? { lastFailed: end.state === "failed" } : {}),
      consecutiveFailures: failures,
      updatedAt: time,
    };
    const events: NewEvent[] = [];
    let alert: ReturnType<InboxService["buildAdd"]>["item"] | undefined;
    if (end.state === "failed" && failures >= options.failureLimit && job.state === "active") {
      after = paused(after, "failures");
      const recent = [...runsOfJob(store.reader, job.id).filter((r) => r.state === "failed" && r.runId !== run.runId), ended].slice(-failures);
      const notice = autoPausedNotice(after, recent);
      const data: JobAutoPausedNoticeData = { jobId: job.id };
      const item = inbox.buildAdd({
        kind: "notice",
        notice: "scheduled_job_auto_paused",
        title: notice.title,
        body: notice.body,
        source: jobSource(job),
        ...internalMark(job.internal),
        urgency: "non_blocking",
        actions: [JOB_AUTO_PAUSED_ACTIONS.resume, JOB_AUTO_PAUSED_ACTIONS.keep],
        data,
      });
      events.push(item.event);
      alert = item.item;
      // 自动暂停时排着的那一次一并丢掉
      events.push(...dropQueued(after, run.runId));
    }
    // 改成某个时间做一次的（98 号票）：那一次做成了，任务算完成
    if (!alert) events.push(...onceCompleted(after, ended));
    store.appendBatch([jobEvent(after, "run_finished", "system", ended, jobKeys.runEnd(run.runId)), ...events]);
    notDone.delete(run.runId);
    nudged.delete(run.runId);
    summaries.delete(run.runId);
    bindings.delete(run.runId);
    if (alert) inbox.alert(alert);
    if (job.projectId === undefined) scheduleFill();
  }

  /**
   * 改成某个时间做一次的（98 号票）：这次运行做成了时间表上那一次（到点的时刻就是那一刻）、没有下一次、没有别的还没结束的运行——
   * 照 76 号票"到点做一次、做完即完成"，触发登记结束（系统取消，排在前面：任务结束时不再取消一遍），任务从运营中算完成。
   * 没做成的（失败、中断）不算：任务还在运营中，用户能再改时间或取消
   */
  const onceCompleted = (job: ScheduledJob, ended: JobRun): NewEvent[] => {
    const { schedule } = job;
    if (ended.state !== "done" || schedule?.kind !== "once" || job.nextAt !== undefined || job.state === "cancelled") return [];
    if (!runEvents(ended).some((e) => e.source === TIME_TRIGGER_SOURCE && Date.parse(e.at) === Date.parse(schedule.at))) return [];
    if (outstanding(job.id).some((r) => r.runId !== ended.runId)) return [];
    const task = ownerOf(job);
    if (!task || task.state !== "operating") return [];
    const closed: ScheduledJob = { ...withoutPause(withoutNextAt(job)), state: "cancelled", updatedAt: now() };
    return [jobEvent(closed, "cancelled", "system"), tasks.buildChange(task, { ...task, state: "done" }, { by: "system", change: "completed" }).event];
  };

  /** 定时触发的流程这次运行里各步的样子：汇报过的照汇报的；还报着"在做"的、没报的，真执行过的推断成做完（照 59 号票） */
  const stepsOf = (job: ScheduledJob, run: JobRun): { list: TaskStep[]; executed: Set<string>; stored: StoredPlan } | undefined => {
    const stored = workflowOf(job);
    if (!stored?.workflow) return undefined;
    const list = run.steps ?? runSteps(job, stored, run).map((s): TaskStep => ({ stepId: s.id, title: s.title, state: "pending" }));
    return { list, executed: executedSteps(planHistory(store, job.ownerTaskId!, runPlanId(stored.planId, run.runId))), stored };
  };
  const finalSteps = (job: ScheduledJob, run: JobRun): TaskStep[] | undefined => {
    if (run.state !== "running") return run.steps;
    const current = stepsOf(job, run);
    return current && stepsAtFinish(current.list, current.executed);
  };

  /**
   * 这一轮结束了：这次运行怎么结束的（被打断是中断；出错、中止、报了做不了、有一步没做成是失败；
   * 定时触发的流程收工时还有步骤既没做完也没说明跳过——提醒过一次之后、或者一步都没做——也是失败，照 59 号票的口径不算做完）
   */
  const endOf = (job: ScheduledJob, turn: TurnEndEventPayload, run: JobRun): RunEnd => {
    if (turn.outcome === "interrupted") return { state: "interrupted", reason: INTERRUPTED_REASON };
    const failure = turnFailure(turn) ?? notDone.get(run.runId) ?? stepsLeft(job, run);
    return failure === undefined ? { state: "done" } : { state: "failed", reason: failure };
  };

  /** 定时触发的流程：收工时还有几步既没做完也没说明跳过（执行过却没报的照 59 号票推断成做完）；没有的、不是流程的是 undefined */
  const stepsLeft = (job: ScheduledJob, run: JobRun): string | undefined => {
    const current = stepsOf(job, run);
    if (!current) return undefined;
    const left = stepsAtFinish(current.list, current.executed).filter((s) => !SETTLED_STEP_STATES.includes(s.state));
    if (left.length === 0) return undefined;
    return runStepsLeftReason(left.map((s) => `${s.stepId}「${s.title}」`));
  };

  /**
   * 定时触发的流程（59 号票的收尾提醒）：这一轮正常结束、这次运行做过事（有对上步骤、执行成功的调用）、还有步骤既没执行、
   * 这次运行还没提醒过：提醒一次，这一轮先不算结局（agent 接着做，下一轮结束再算）
   */
  const nudgeIfPending = (job: ScheduledJob, run: JobRun, turn: TurnEndEventPayload): boolean => {
    if (turn.outcome !== "completed" || nudged.has(run.runId) || notDone.has(run.runId)) return false;
    const stored = workflowOf(job);
    if (!stored?.workflow) return false;
    const planId = runPlanId(stored.planId, run.runId);
    const history = planHistory(store, job.ownerTaskId!, planId);
    if (history.length === 0) return false;
    const steps = runSteps(job, stored, run);
    const pending = planPending(guardWorkflow(planId, { ...stored.workflow, steps }, {}), history);
    if (pending.length === 0) return false;
    nudged.add(run.runId);
    const titles = pending.flatMap((f) => {
      const step = steps.find((s) => s.id === f.step);
      return step ? [`${step.id}「${step.title}」`] : [];
    });
    const scope: MessageScope = job.projectId === undefined ? { scheduledJobId: job.id, ...(job.ownerTaskId === undefined ? {} : { taskId: job.ownerTaskId }) } : { projectId: job.projectId, scheduledJobId: job.id };
    store.append(buildAgentNotice(maintainerChannel(job.maintainerId), runPendingNudge(titles), jobKeys.runNudge(run.runId), scope).event);
    return true;
  };

  /**
   * 执行它的 agent 处理完一条输入：是一次运行的通知（系统通知、带着登记身份）就有了这次运行的结局——
   * 不属于项目的直接结束；属于项目的让工单所在的这一段收尾（写回之后工单结束，这次运行随之结束；被打断的马上记中断）
   */
  const onTurnEnd = (maintainerId: string, turn: TurnEndEventPayload) => {
    const input = inputOf(store.reader, turn.inputMessageId);
    const jobId = jobOfScope(input?.scope);
    if (jobId === undefined || getMessage(store.reader, turn.inputMessageId)?.speaker !== "system") return;
    const job = getJob(store.reader, jobId);
    const run = runningRunOf(jobId);
    if (!job || !run || job.maintainerId !== maintainerId) return;
    if (nudgeIfPending(job, run, turn)) return;
    // 这次运行最后说的那一两句（后面的运行、属于项目的下一张工单里带着它）：收工那一轮的；之后催写回之类的不算
    if (!summaries.has(run.runId)) {
      const said = plainResult(recentMessagesOf(store.reader, maintainerChannel(maintainerId), "agent", 5));
      if (said) summaries.set(run.runId, oneLine(said, RUN_SUMMARY_MAX));
    }
    const end = endOf(job, turn, run);
    if (job.projectId === undefined || end.state === "interrupted") finish(run, end);
    if (job.projectId === undefined) return;
    const wo = run.workOrderId === undefined ? undefined : workOrders.get(run.workOrderId);
    // 只认这次运行的工单还是维护者手上这一张时（催写回之类的通知处理完不算）
    if (!wo || workOrders.currentWorkOrder(maintainerId)?.id !== wo.id) return;
    workOrders.finishRun(wo.id, end.state === "done" ? "done" : "unable", end.state === "done" ? undefined : end.reason);
  };

  /** 属于项目的：这次运行的工单结束了，这次运行随之结束（完成是成功，退回、做不了是失败；已经记过结局的不再记） */
  const onRunWorkOrderEnded = (wo: JobRunWorkOrder) => {
    const run = getRun(store.reader, wo.runId);
    if (!run) return;
    finish(run, wo.outcome === "done" ? { state: "done" } : { state: "failed", reason: wo.reason ?? WORK_ORDER_NOT_DONE });
  };

  /** 这一轮里有一步没做成：运行的会话或运行工单段里的调用，等不到批准被拦下、交给用户亲手做 */
  const markNotDone = (scope: MessageScope | undefined, agentId: string, reason: string) => {
    const jobId = jobOfScope(scope);
    const job = jobId === undefined ? undefined : getJob(store.reader, jobId);
    const run = job && job.maintainerId === agentId ? runningRunOf(job.id) : undefined;
    if (run && !notDone.has(run.runId)) notDone.set(run.runId, reason);
  };

  // ───────────────────────── 暂停、恢复、取消 ─────────────────────────

  function paused(job: ScheduledJob, by: JobPauseReason): ScheduledJob {
    return { ...withoutNextAt(job), state: "paused", pausedBy: by, updatedAt: now() };
  }

  /** 恢复：下一次从现在往后算；连续失败重新计数（"最近一次失败"的标记留着，直到下一次运行有了结局） */
  const resumed = (job: ScheduledJob): ScheduledJob => {
    const nextAt = next(job.schedule, nowDate());
    return { ...withoutPause(job), state: "active", ...(nextAt === undefined ? {} : { nextAt }), consecutiveFailures: 0, updatedAt: now() };
  };

  /** 暂停、取消了：排着的运行一并丢掉（不算进连续失败），属于项目的退回它还排着的工单；正在运行的那一次照常做完 */
  const dropQueued = (after: ScheduledJob, except?: string): NewEvent[] =>
    runsOfJob(store.reader, after.id)
      .filter((r) => r.state === "queued" && r.runId !== except)
      .flatMap((r) => {
        const reason = droppedReason(after);
        const ended: JobRun = { ...r, state: "dropped", endedAt: now(), reason };
        const job = after.lastRun?.runId === r.runId ? { ...after, lastRun: ended } : after;
        return [jobEvent(job, "run_finished", "system", ended, jobKeys.runEnd(r.runId)), ...(r.workOrderId === undefined ? [] : workOrders.dropRun(r.workOrderId, reason))];
      });

  /** 暂停（用户、项目停用归档）、取消的事件：登记的变化，连同丢掉排着的运行 */
  const pauseEvents = (job: ScheduledJob, by: JobPauseReason, actor: TaskActor, key?: string): NewEvent[] => {
    const after = paused(job, by);
    return [jobEvent(after, "paused", actor, undefined, key), ...dropQueued(after)];
  };
  const cancelEvents = (job: ScheduledJob, actor: TaskActor, key?: string): NewEvent[] => {
    const after: ScheduledJob = { ...withoutPause(withoutNextAt(job)), state: "cancelled", updatedAt: now() };
    return [jobEvent(after, "cancelled", actor, undefined, key), ...dropQueued(after)];
  };

  /** 取消时任务随之取消（同一事务）：还没结束的才取消 */
  const ownerCancelEvents = (job: ScheduledJob, actor: TaskActor): NewEvent[] => {
    const task = ownerOf(job);
    if (!task || ENDED_TASK_STATES.includes(task.state)) return [];
    return [tasks.buildChange(task, { ...task, state: "cancelled" }, { by: actor, change: "cancelled" }).event];
  };

  /** 恢复：项目停用、归档时恢复不了 */
  const resumeEvents = (job: ScheduledJob, actor: TaskActor, key?: string): NewEvent[] => {
    const blocked = projectBlocksResume(job, job.projectId === undefined ? undefined : projects.get(job.projectId));
    if (blocked) throw new RequestRejected("not_allowed", blocked);
    return [jobEvent(resumed(job), "resumed", actor, undefined, key)];
  };

  /** 用户的动作之后的事件（不能做时抛 RequestRejected） */
  const actEvents = (job: ScheduledJob, action: ScheduledJobAction, key: string): NewEvent[] => {
    if (!scheduledJobActions(job).includes(action)) throw new RequestRejected("not_allowed", refusal.notNow(job, SCHEDULED_JOB_ACTION_LABEL[action]));
    if (action === "pause") return pauseEvents(job, "user", "user", key);
    if (action === "resume") return resumeEvents(job, "user", key);
    return [...cancelEvents(job, "user", key), ...ownerCancelEvents(job, "user")];
  };

  /** 任务结束了（任务详情里取消、删除项目时取消……）：它的触发登记随之取消 */
  const onTaskEnded = (task: Task) => {
    const job = jobOfTask(store.reader, task.id);
    if (!job || job.state === "cancelled") return;
    store.appendBatch(cancelEvents(job, "system"));
  };

  // ───────────────────────── 改时间（98 号票） ─────────────────────────

  /** 交来的时间表规范一下：重复的周几、几号去重排好；某个时间做一次的写成带时区偏移的协议时间（时间认不出、已经过了的抛 RequestRejected） */
  const checkedSchedule = (schedule: ReminderSchedule): ReminderSchedule => {
    if (schedule.kind !== "once") {
      const made = repeatSchedule(repeatRuleOf(schedule)!, schedule.time);
      if ("error" in made) throw new RequestRejected("bad_params", made.error);
      return made.schedule;
    }
    const at = Date.parse(schedule.at);
    if (Number.isNaN(at)) throw new RequestRejected("bad_params", refusal.badTime(schedule.at));
    if (at <= clock.now()) throw new RequestRejected("bad_params", refusal.oncePassed(schedule.at));
    return { kind: "once", at: nowIso(new Date(at)) };
  };

  /**
   * 用户改时间表（任务操作菜单里的"改时间"）：只换时间表、重算下一次——运营中的从现在往后按新的算，暂停着的照旧暂停（没有下一次，
   * 恢复时按新的算）；记一条用户做的 rescheduled。任务、会话、运行记录不动；正在运行、已经排着的那一次照常做，下一次起按新的。
   * 到点的计时器跟着这条 scheduled_job 事件重登（arm）。改成某个时间做一次的：到点运行一次，做成了任务就算完成（onceCompleted）
   */
  const reschedule = (params: RescheduleJobParams, key: string): RescheduleJobResult => {
    const done = store.eventByIdempotencyKey(key);
    if (done) return rescheduleResult((done.payload as ScheduledJobEventPayload).job);
    const job = getJob(store.reader, params.jobId);
    if (!job) throw new RequestRejected("not_found", refusal.notFound(params.jobId));
    if (job.schedule === undefined && job.state !== "cancelled") throw new RequestRejected("not_allowed", refusal.noSchedule(job));
    if (!canRescheduleJob(job)) throw new RequestRejected("not_allowed", refusal.notNow(job, "改时间"));
    const schedule = checkedSchedule(params.schedule);
    const nextAt = job.state === "active" ? next(schedule, nowDate()) : undefined;
    const after: ScheduledJob = { ...withoutNextAt(job), schedule, ...(nextAt === undefined ? {} : { nextAt }), updatedAt: now() };
    store.append(jobEvent(after, "rescheduled", "user", undefined, key));
    log(`${job.id}「${job.title}」改了时间表（用户）：下一次 ${nextAt ?? "没有"}`);
    return rescheduleResult(after);
  };

  // ───────────────────────── 项目停用、归档、恢复、删除 ─────────────────────────

  const onProject = ({ project, change }: ProjectEventPayload) => {
    const jobs = jobsOfProject(store.reader, project.id);
    let events: NewEvent[] = [];
    if (change === "retired" || change === "archived") {
      // 运营中的暂停（之前就暂停了的保持原样）
      events = jobs.filter((j) => j.state === "active").flatMap((j) => pauseEvents(j, change === "retired" ? "project_retired" : "project_archived", "system"));
    } else if (change === "reactivated") {
      events = jobs.filter((j) => j.state === "paused" && j.pausedBy === "project_retired").flatMap((j) => resumeEvents(j, "system"));
    } else if (change === "unarchived") {
      // 回到归档前的状态：回到已停用的，因归档而暂停的改记成因停用而暂停（重新启用时恢复）；回到别的状态的恢复
      const archived = jobs.filter((j) => j.state === "paused" && j.pausedBy === "project_archived");
      events = archived.flatMap((j) => (project.state === "retired" ? [jobEvent(paused(j, "project_retired"), "paused", "system")] : resumeEvents(j, "system")));
    } else if (change === "deleted") {
      events = jobs.filter((j) => j.state !== "cancelled").flatMap((j) => cancelEvents(j, "system"));
    }
    if (events.length > 0) store.appendBatch(events);
  };

  /** "定时触发的任务被自动暂停"事项上点了"恢复" */
  const resumeFromNotice = (data: unknown) => {
    const jobId = (data as Partial<JobAutoPausedNoticeData> | undefined)?.jobId;
    const job = typeof jobId === "string" ? getJob(store.reader, jobId) : undefined;
    // 已经在看板上恢复过、取消了的：什么也不做
    if (!job || job.state !== "paused") return;
    try {
      store.appendBatch(resumeEvents(job, "user"));
    } catch (err) {
      log(`从"自动暂停"的事项恢复 ${job.id} 没做成：${errorText(err)}`);
    }
  };

  // ───────────────────────── 授权和装配 ─────────────────────────

  /** 执行它的 agent 手上正在运行的那一次（属于项目的是它手上这张工单的那一次）；没有抛 RequestRejected */
  const runOfAgent = (maintainerId: string): JobRun => {
    const wo = workOrders.currentWorkOrder(maintainerId);
    const run = runsIn(store.reader, ["running"]).find((r) => {
      const job = getJob(store.reader, r.jobId);
      if (job?.maintainerId !== maintainerId) return false;
      return job.projectId === undefined || (wo !== undefined && isJobRunWorkOrder(wo) && wo.runId === r.runId);
    });
    if (!run) throw new RequestRejected("not_allowed", refusal.noRun);
    return run;
  };

  /** 执行它的 agent 报这次运行失败：记下原因，这一轮结束时这次运行记为失败 */
  const reportFailure = (maintainerId: string, reason: string): { runId: string } => {
    const run = runOfAgent(maintainerId);
    notDone.set(run.runId, reason);
    return { runId: run.runId };
  };

  /**
   * 定时触发的流程：这次运行里汇报某一步（照 58 号票的 report_step；开始一步时，别的还报着"在做"、真执行过的推断成做完）。
   * 只记在这次运行上（每次运行从头算），步骤都做完不提前结束这次运行：这一轮正常结束就算成功
   */
  const reportStep = (maintainerId: string, report: { stepId: string; state: ReportedStepState; gist?: string }) => {
    const run = runOfAgent(maintainerId);
    const job = getJob(store.reader, run.jobId)!;
    const current = stepsOf(job, run);
    if (!current) throw new RequestRejected("not_allowed", refusal.notWorkflowRun);
    if (!current.list.some((s) => s.stepId === report.stepId)) throw new RequestRejected("not_found", refusal.noStep(report.stepId));
    const base = report.state === "in_progress" ? stepsOnStart(current.list, report.stepId, current.executed) : current.list;
    const list = base.map((s): TaskStep => {
      if (s.stepId !== report.stepId) return s;
      const { inferred: _i, gist: _g, ...rest } = s;
      return { ...rest, state: report.state, ...(report.gist ? { gist: report.gist } : {}) };
    });
    const updated: JobRun = { ...run, steps: list };
    store.append(jobEvent({ ...job, ...(job.lastRun?.runId === run.runId ? { lastRun: updated } : {}), updatedAt: now() }, "run_step", "maintainer", updated));
    return { done: list.filter((s) => s.state === "done" || s.state === "skipped").length, total: list.length };
  };

  /**
   * 守卫看到的每次运行的授权（带着授权的会话段，每次运行一段：效果日志、时序规则、授权项的次数、和计划比对的历史都只看这一次）：
   * - 迁移来的定时作业：作业的授权项（运营中一直有效；暂停、取消即收回，不给）、时序规则、建它的任务的关注类别；
   * - 定时触发的流程：授权的那份计划（任务在运营就一直有效，暂停、取消即收回），每次调用和计划逐步比对（计划编号按这次运行分开）；
   * - 定时触发的普通任务：不给（null，按普通对话判）
   */
  const guardTask = (jobId: string, ctx?: GuardTaskContext): GuardTask | null => {
    const job = getJob(store.reader, jobId);
    if (!job) return null;
    if (isLegacyJob(job)) {
      const plan = tasks.confirmedPlan(job.taskId)?.plan;
      return {
        taskId: job.id,
        plan: toGuardJobPlan({ grants: job.state === "active" ? job.grants : [], temporalRules: job.temporalRules, watchCategories: plan?.watchCategories ?? [], grantedAt: Date.parse(job.createdAt) }),
        currentStageId: JOB_RUN_STAGE,
        segmentScoped: true,
      };
    }
    const stored = workflowOf(job);
    if (!stored?.workflow) return null;
    const run = runningRunOf(job.id);
    const confirmedAt = stored.decidedAt ? Date.parse(stored.decidedAt) : Date.parse(job.createdAt);
    // 事件触发的流程（77 号票）：这次运行代入了事件的值的步骤和由它推出的授权项
    const bound = job.event ? boundOf(job, stored, run, ctx) : undefined;
    const plan = toGuardPlan(bound ? withGrants(stored.plan, bound.grants) : stored.plan, { confirmedAt });
    const grants = job.state === "active" ? plan.grants.map((g) => ({ ...g, expiresAt: Number.POSITIVE_INFINITY })) : [];
    const planId = runPlanId(stored.planId, run?.runId ?? job.id);
    const workflow = guardWorkflow(planId, { ...stored.workflow, steps: bound?.steps ?? stored.workflow.steps }, {});
    return { taskId: job.ownerTaskId!, plan: { ...plan, grants, workflow }, currentStageId: WORKFLOW_STAGE_ID, segmentScoped: true };
  };

  /**
   * 事件触发的流程这次运行代入了事件的值的步骤和授权项（77 号票）：按发起调用的 agent 现取真实路径、推出授权项，同一次运行、同一个 agent 只算一次。
   * 不给 ctx 的（只要归属的地方）只代入、不推授权
   */
  const boundOf = (job: ScheduledJob, stored: StoredPlan, run: JobRun | undefined, ctx: GuardTaskContext | undefined): { steps: WorkflowStepView[]; grants: PlanGrant[] } => {
    const steps = runSteps(job, stored, run);
    if (!run || !ctx) return { steps, grants: [] };
    const cached = bindings.get(run.runId);
    if (cached && cached.agent === ctx.agent.agentId) return cached;
    const bound = { agent: ctx.agent.agentId, ...boundRunWorkflow(steps, ctx) };
    bindings.set(run.runId, bound);
    return bound;
  };

  /**
   * 一次运行的装配：工具包（迁移来的是建它的任务的计划里的；流程是授权的计划里的；普通任务不给——任务自己的 agent 用普通任务的那一份，
   * 项目的维护者用项目的）、"报告这次运行失败"、来源、守卫看到的授权
   */
  const runAssembly = (jobId: string, maintainerId: string): JobRunAssembly | undefined => {
    const job = getJob(store.reader, jobId);
    if (!job) return undefined;
    const legacy = isLegacyJob(job);
    const workflow = workflowOf(job);
    const toolkit = legacy ? (tasks.confirmedPlan(job.taskId)?.plan.toolkit ?? emptyToolkit()) : workflow?.plan.toolkit;
    const fail = failJobRunTool({ reportFailure }, maintainerId, options.failureLimit);
    return {
      ...(toolkit ? { toolkit } : {}),
      // 定时触发的流程：照 58 号票汇报每一步（这次运行里的），执行中不能改步骤
      tools: workflow ? [runReportStepTool({ reportStep }, maintainerId), fail, runPlanChangeRefusalTool()] : [fail],
      source: jobSource(job),
      ...internalMark(job.internal),
      guardTask: (ctx?: GuardTaskContext) => guardTask(jobId, ctx),
      ...runShellEnv(job, workflow),
    };
  };

  /** 事件触发的流程这次运行 bash 的环境变量（77 号票）：这一批事件的值，命令里只引用变量 */
  const runShellEnv = (job: ScheduledJob, workflow: StoredPlan | undefined): { shellEnv?: Record<string, string> } => {
    const run = job.event && workflow?.workflow ? runningRunOf(job.id) : undefined;
    return run ? { shellEnv: eventShellEnv(runEvents(run)) } : {};
  };

  // ───────────────────────── 启动时 ─────────────────────────

  /**
   * 重启前在跑的运行对一遍：属于项目的看工单（已经结束的随之结束）；不属于项目的看交给它的通知处理完了没有
   * （处理到一半被打断的，执行它的 agent 的会话开始时标成中断，这里的订阅收得到）
   */
  const reconcile = () => {
    for (const run of runsIn(store.reader, ["queued", "running"])) {
      const job = getJob(store.reader, run.jobId);
      if (!job) continue;
      if (job.projectId !== undefined) {
        const wo = run.workOrderId === undefined ? undefined : workOrders.get(run.workOrderId);
        if (!wo || !isJobRunWorkOrder(wo)) finish(run, { state: "failed", reason: PROJECT_GONE_REASON });
        else if (wo.state === "ended") onRunWorkOrderEnded(wo);
        else if (wo.state !== "pending") onRunWorkOrderStarted(wo);
        continue;
      }
      if (run.state !== "running") continue;
      const noticeId = runNoticeId(run.runId);
      if (noticeId === undefined || inputOf(store.reader, noticeId)?.status !== "done") continue;
      const turn = store
        .read(maintainerChannel(job.maintainerId), 0, EVENT_TYPES.turnEnd)
        .map((e) => e.payload as TurnEndEventPayload)
        .findLast((t) => t.inputMessageId === noticeId);
      if (turn) onTurnEnd(job.maintainerId, turn);
    }
  };

  const onEvent = (event: { channel: string; type: string; payload: unknown }) => {
    if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.scheduledJob) return arm((event.payload as ScheduledJobEventPayload).job);
    if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.task) {
      const { task, from } = event.payload as TaskEventPayload;
      // 某个时间做一次的（等时间）：登记或撤掉计时器
      if (onceAt(task) !== undefined) return armOnce(task);
      if (!isTriggered(task)) return;
      if (task.state === "operating") registerTrigger(task);
      else if (from !== task.state && ENDED_TASK_STATES.includes(task.state)) onTaskEnded(task);
      return;
    }
    if (event.channel === CHANNELS.projects && event.type === EVENT_TYPES.project) return onProject(event.payload as ProjectEventPayload);
    if (event.channel === CHANNELS.projects && event.type === EVENT_TYPES.workOrder) {
      const { workOrder, change } = event.payload as WorkOrderEventPayload;
      if (!isJobRunWorkOrder(workOrder)) return;
      if (change === "started") onRunWorkOrderStarted(workOrder);
      else if (change === "ended") onRunWorkOrderEnded(workOrder);
      return;
    }
    if (event.channel === GUARD_CHANNEL && event.type === GUARD_EVENTS.approvalSuspended) {
      const { approvalId, origin } = event.payload as ApprovalSuspendedPayload;
      const approval = getApproval(store.reader, approvalId);
      return markNotDone(origin.messageScope, origin.agentId, blockedReason.approval(approval?.toolTitle ?? origin.source, approval?.argsSummary ?? ""));
    }
    if (event.channel === CHANNELS.inbox && event.type === EVENT_TYPES.inboxItem) {
      const { item } = event.payload as InboxItemEventPayload;
      if (item.kind !== "notice" || item.notice !== "hand_over" || item.handled !== undefined) return;
      const data = item.data as HandOverData | undefined;
      if (data?.origin) markNotDone(data.origin.messageScope, data.origin.agentId, blockedReason.handOver(data.toolTitle));
      return;
    }
    if (event.type === EVENT_TYPES.turnEnd && event.channel.startsWith(MAINTAINER_CHANNEL_PREFIX)) {
      onTurnEnd(event.channel.slice(MAINTAINER_CHANNEL_PREFIX.length), event.payload as TurnEndEventPayload);
    }
  };

  /** 定时触发的任务的触发登记，没有时抛 RequestRejected */
  const mustJobOfTask = (taskId: string): ScheduledJob => {
    const job = jobOfTask(store.reader, taskId);
    if (!job) throw new RequestRejected("not_found", refusal.noTrigger(taskId));
    return job;
  };

  return {
    attach() {
      unsubscribes.push(
        store.onAppend((event) => {
          try {
            onEvent(event);
          } catch (err) {
            log(`触发底座处理事件 ${event.type} 出错：${errorText(err)}`);
          }
        }),
        inbox.onNoticeHandled("scheduled_job_auto_paused", JOB_AUTO_PAUSED_ACTIONS.resume, (item) => resumeFromNotice(item.data)),
      );
      // 名额空出来：不属于项目的那边排着的运行看看能不能开始
      options.slots.onFreed(scheduleFill);
    },
    start() {
      started = true;
      // 登记好了（运营中）、还没登记触发的补上（确认之后守护进程马上就停了）；以前的定时作业迁移成定时触发的普通任务
      for (const task of tasks.list()) if (task.state === "operating") registerTrigger(task);
      migrateLegacy();
      reconcile();
      // 过了点的运营中登记：不管错过几次只补跑一次；没过点的登记到那个时刻
      for (const job of listJobs(store.reader, ["active"])) {
        if (job.nextAt !== undefined && Date.parse(job.nextAt) <= clock.now()) timeUp(job.id, "catch_up");
        else arm(job);
      }
      // 某个时间做一次、还在等时间的：停机期间过了那个时间的开机补做一次，没过的登记到那个时间
      for (const task of tasks.list()) {
        const at = onceAt(task);
        if (task.state !== "scheduled" || at === undefined) continue;
        if (Date.parse(at) <= clock.now()) onceDue(task.id, true);
        else armOnce(task);
      }
      fill();
    },
    stop() {
      stopped = true;
      for (const off of unsubscribes.splice(0)) off();
      for (const job of listJobs(store.reader)) scheduler.cancel(schedulerKey(job.id));
      for (const task of tasks.list()) if (task.state === "scheduled") scheduler.cancel(onceSchedulerKey(task.id));
    },
    get: (jobId) => getJob(store.reader, jobId),
    list: () => listJobs(store.reader),
    ofProject: (projectId) => jobsOfProject(store.reader, projectId),
    ofTask: (taskId) => jobOfTask(store.reader, taskId),
    fire(taskId, event, idempotencyKey) {
      if (idempotencyKey !== undefined && store.eventByIdempotencyKey(idempotencyKey)) return { outcome: "ignored", reason: refusal.alreadyFired };
      const job = jobOfTask(store.reader, taskId);
      if (!job) return { outcome: "ignored", reason: refusal.noTrigger(taskId) };
      if (job.state !== "active") return { outcome: "ignored", reason: refusal.notRunning(job) };
      return enqueue({ ...job, updatedAt: now() }, event, { trigger: event.source === TIME_TRIGGER_SOURCE ? "scheduled" : "event" }, idempotencyKey ?? jobKeys.fire(job.id, randomUUID()));
    },
    act(params, idempotencyKey) {
      const done = store.eventByIdempotencyKey(idempotencyKey);
      if (done) {
        const { job } = done.payload as ScheduledJobEventPayload;
        return { jobId: job.id, state: job.state };
      }
      const job = getJob(store.reader, params.jobId);
      if (!job) throw new RequestRejected("not_found", refusal.notFound(params.jobId));
      const events = actEvents(job, params.action, idempotencyKey);
      store.appendBatch(events);
      const after = (events[0]!.payload as ScheduledJobEventPayload).job;
      return { jobId: after.id, state: after.state };
    },
    reschedule,
    actOnTask(taskId, action, idempotencyKey) {
      const job = mustJobOfTask(taskId);
      if (!store.eventByIdempotencyKey(idempotencyKey)) store.appendBatch(actEvents(job, action, idempotencyKey));
      const task = tasks.get(taskId);
      return { taskId, state: task?.state ?? "cancelled" };
    },
    reportFailure,
    reportStep,
    runAssembly,
    guardTask,
    currentRun: (jobId) => runningRunOf(jobId)?.runId,
    runNoticeId,
    legacyPlanConfirmed,
    calendar(from, to) {
      const inRange = (iso: string) => Date.parse(iso) >= from.getTime() && Date.parse(iso) < to.getTime();
      // 用户改时间表（98 号票）只在事件里：按先后走一遍，记下每份最后一次改的时刻（系统按工作日历重算下一次的不算，时间表没变）
      const since = new Map<string, string>();
      for (const event of store.read(CHANNELS.board, 0, EVENT_TYPES.scheduledJob)) {
        if (isDeletedEventPayload(event.payload)) continue;
        const { job, change, by } = event.payload as ScheduledJobEventPayload;
        if (change === "rescheduled" && by === "user") since.set(job.id, job.updatedAt);
      }
      // 事件触发的（77 号票）没有时间表，不上日历
      return listJobs(store.reader, ["active", "paused"])
        .filter((job): job is ScheduledJob & { schedule: ReminderSchedule } => job.schedule !== undefined)
        .map((job) => ({
        job,
        since: since.get(job.id) ?? job.createdAt,
        occurrences: occurrencesBetween(job.schedule, from, to, scheduleContext()).map((d) => nowIso(d)),
        runs: runsOfJob(store.reader, job.id).filter((r) => runEvents(r).some((e) => inRange(e.at))),
      }));
    },
    rearm() {
      const at = nowDate();
      for (const job of listJobs(store.reader, ["active"])) {
        // 不跟着工作日历变的不用动；已经到点、正等着触发的不动（触发时按当时的工作日历算下一次）
        if (!job.schedule || !dependsOnWorkdayCalendar(job.schedule) || job.nextAt === undefined || Date.parse(job.nextAt) <= at.getTime()) continue;
        const nextAt = next(job.schedule, at);
        if (nextAt === job.nextAt) continue;
        store.append(jobEvent({ ...withoutNextAt(job), ...(nextAt === undefined ? {} : { nextAt }), updatedAt: now() }, "rescheduled", "system"));
      }
    },
  };
}

