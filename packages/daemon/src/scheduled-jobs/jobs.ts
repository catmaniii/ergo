// 定时作业（规格第 8、11、12、13、17 节，19 号票，ADR-0017）：登记、到点、名额、运行和结局、失败和自动暂停、用户的暂停恢复取消、
// 项目停用归档和恢复、守护进程启动时补跑错过的、作业的授权。作业的状态全在事件日志里（任务看板频道上的 scheduled_job 事件，
// 派生视图 views.ts），这里只管编排；说法在 texts.ts，幂等键在 keys.ts。
//
// - 登记：任务的计划里带着定时作业定义，用户确认计划后（看板上任务的 plan_confirmed）每个定义登记成一个作业（j-<n>），进入运营中，
//   连同每次运行的授权（随计划卡确认的授权项，加上作业的和用户的限制编出的时序规则）；一个任务只登记一回（计划变更、自行调整沿用）。
//   属于项目的由项目的维护者执行，不属于项目的由作业自己的维护者（jm-<n>，maintainers.ts）执行。项目已停用、已归档时登记成已暂停。
// - 到点（调度器，时钟可注入）：一次运行进队列（排队），下一次的时间往后算；同一个作业上一次还没跑完的，这一次跳过。
//   每次运行真正开始时占一个全局执行名额（tasks/slots.ts，和执行中的任务共用），满了排队，名额空出后才开始：
//   - 属于项目的：同一事务里派一张来源为"定时作业"的工单（work-orders.ts 的 dispatchRun），在项目的队列里排着（不占名额），
//     排到了、又有名额才开始（工单开始时这次运行开始）；工单结束时这次运行结束（完成是成功，退回、做不了是失败）；
//   - 不属于项目的：有名额时交给作业自己的维护者一条带着作业身份的通知，它处理完这一轮就结束。
//   这一轮正常结束是成功；维护者用 fail_job_run 报了原因的、这一轮出错或被中止的、有一步等不到批准被拦下或交给用户亲手做的是失败；
//   守护进程停机打断的记为中断（不重做，不算进连续失败）。交给维护者的输入带着 scheduledJobId，24 号票的账本据此把用量记在作业名下。
// - 授权（规格"定时作业的授权"）：守卫按作业的授权判（guardTask：带着授权的会话段，每次运行一段），作业在就一直有效、不续期，
//   暂停、取消即收回（不给授权项）；超出的照常先问用户。
// - 失败：记一条失败的运行记录，作业卡标"最近一次失败"；连续失败到配置的次数（scheduledJobs.jobFailures）自动转为已暂停，
//   同一事务里待我处理放一条"定时作业被自动暂停"（动作：恢复、保持暂停）；中间有一次成功就重新计数。
// - 用户在看板上暂停、恢复、取消（scheduled_job_action）；暂停、取消时排着的运行一并丢掉（属于项目的退回它的工单）。
//   项目停用、归档时它运营中的作业暂停，重新启用、取消归档时只恢复因此暂停的；作业的变化从不改项目状态。
// - 错过的触发（规格第 13、17 节）：守护进程启动时（23 号票的恢复做完之后），过了点的运营中作业不管错过几次只补跑一次
//   （运行记录写明错过了几次），下一次从现在往后算；补完再重启不会再补（下一次的时间和这次运行同一事务落盘）。
import {
  CHANNELS,
  dependsOnWorkdayCalendar,
  emptyToolkit,
  EVENT_TYPES,
  type GrantInfo,
  type InboxItemEventPayload,
  isJobRunWorkOrder,
  isRepeating,
  JOB_AUTO_PAUSED_ACTIONS,
  type JobAutoPausedNoticeData,
  type JobPauseReason,
  type JobRun,
  type JobRunTrigger,
  type JobRunWorkOrder,
  jobPolicy,
  latestOccurrence,
  MAINTAINER_CHANNEL_PREFIX,
  maintainerChannel,
  type MessageScope,
  nextOccurrence,
  nowIso,
  occurrencesBetween,
  type PlanCardPayload,
  type Project,
  type ProjectEventPayload,
  type ReminderSchedule,
  type ScheduleContext,
  type ScheduledJob,
  type ScheduledJobAction,
  type ScheduledJobActionParams,
  type ScheduledJobActionResult,
  type ScheduledJobChange,
  type ScheduledJobEventPayload,
  SCHEDULED_JOB_ACTION_LABEL,
  scheduledJobActions,
  type Task,
  type TaskActor,
  type TaskEventPayload,
  type TurnEndEventPayload,
  type WorkOrderEventPayload,
} from "@ergou/protocol";
import { getApproval } from "../approvals/views.ts";
import { getCard } from "../cards/views.ts";
import { buildAgentNotice } from "../conversation/messages.ts";
import { getMessage, inputOf } from "../conversation/views.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { GuardTask } from "../guard/index.ts";
import { type ApprovalSuspendedPayload, GUARD_CHANNEL, GUARD_EVENTS } from "../guard-runtime/events.ts";
import type { HandOverData } from "../hand-over/hand-over.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { JobRunAssembly } from "../maintainers/assembly.ts";
import type { ProjectService } from "../projects/projects.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { JOB_RUN_STAGE, toGuardJobPlan } from "../tasks/plan.ts";
import type { ExecutionSlots } from "../tasks/slots.ts";
import type { TaskService } from "../tasks/tasks.ts";
import type { WorkOrders } from "../work-orders/work-orders.ts";
import { jobKeys } from "./keys.ts";
import { jobProjectOf } from "./plan.ts";
import {
  autoPausedNotice,
  blockedReason,
  droppedReason,
  INTERRUPTED_REASON,
  jobSource,
  PROJECT_GONE_REASON,
  projectBlocksResume,
  refusal,
  runInstructions,
  turnFailure,
  WORK_ORDER_NOT_DONE,
} from "./texts.ts";
import { failJobRunTool } from "./tools.ts";
import { countJobs, getJob, getRun, jobsOfProject, listJobs, runsIn, runsOfJob } from "./views.ts";

/** 作业自己的维护者（不属于项目的作业，j-<n> 的是 jm-<n>） */
export function jobMaintainerId(jobId: string): string {
  return `jm-${jobId.replace(/^j-/, "")}`;
}

export interface ScheduledJobsOptions {
  store: EventStore;
  tasks: TaskService;
  projects: ProjectService;
  /** 派单器里定时作业要用的那几样：派一张运行工单、这次的活做完了让这一段收尾、暂停取消时退回排着的工单 */
  workOrders: Pick<WorkOrders, "dispatchRun" | "finishRun" | "dropRun" | "get" | "currentWorkOrder">;
  inbox: InboxService;
  scheduler: Scheduler;
  clock: Clock;
  now: () => string;
  /** 算下一次时要的东西：当前的个人工作日历（"按我的工作日"的时间表按它算） */
  scheduleContext: () => ScheduleContext;
  /** 全局执行名额（tasks/slots.ts）：作业自己的维护者那边排队的运行，有名额才开始 */
  slots: Pick<ExecutionSlots, "hasSlot" | "onFreed">;
  /** 连续失败几次自动暂停（配置 scheduledJobs.jobFailures） */
  failureLimit: number;
  log: (line: string) => void;
}

export interface ScheduledJobs {
  /** 接上事件（登记、运行的结局、项目停用归档）：要在维护者开始接输入之前（它们被杀后标中断时这里要看到） */
  attach(): void;
  /** 23 号票的恢复做完之后：对一遍重启前在跑的运行，登记到点的计时器，补跑停机期间错过的，排着的按名额开始 */
  start(): void;
  stop(): void;
  get(jobId: string): ScheduledJob | undefined;
  list(): ScheduledJob[];
  /** 某个项目的作业（项目页） */
  ofProject(projectId: string): ScheduledJob[];
  /** 用户在看板上的动作：同一个幂等键重发拿到同一个结果 */
  act(params: ScheduledJobActionParams, idempotencyKey: string): ScheduledJobActionResult;
  /** 维护者报这次运行失败（fail_job_run）：记下原因，这一轮结束时这次运行记为失败 */
  reportFailure(maintainerId: string, reason: string): { runId: string };
  /** 一次运行要的装配（作业自己的维护者、项目维护者的运行工单段）：工具包、工具、来源、守卫看到的作业的授权 */
  runAssembly(jobId: string, maintainerId: string): JobRunAssembly | undefined;
  /** 作业现在正在运行的那一次（运行号） */
  currentRun(jobId: string): string | undefined;
  /** 个人工作日历变了：跟着它变的作业按新的工作日历重算下一次 */
  rearm(): void;
  /**
   * 日历上的定时作业（35 号票用）：[from, to) 之间每个没取消的作业的时间表展开（按当前的个人工作日历，"按我的工作日"的照它；
   * 已暂停的也展开，看作业的 state、pausedBy 标出来），和这段时间里到点的运行记录（按触发时间）
   */
  calendar(from: Date, to: Date): JobCalendarEntry[];
}

/** 日历上的一个定时作业：作业（状态、暂停的原因都在上面）、这段时间里该触发的时刻、这段时间里的运行记录 */
export interface JobCalendarEntry {
  job: ScheduledJob;
  /** 时间表在这段时间里的每一次（协议时间），先到的在前 */
  occurrences: string[];
  /** 触发时间落在这段时间里的运行，先触发的在前 */
  runs: JobRun[];
}

/** 一次运行怎么结束的：成功、失败；中断（停机打断）、没运行（排着时作业暂停、取消了）不算进连续失败 */
type RunEnd = { state: "done" } | { state: "failed" | "interrupted" | "dropped"; reason: string };

const errorText = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));
const schedulerKey = (jobId: string) => `job:${jobId}`;

/** 去掉下一次的时间（已暂停、已取消的作业没有） */
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

/** 项目停用、归档了：作业登记成、或者转为因此暂停 */
const projectPause = (project: Pick<Project, "state"> | undefined): JobPauseReason | undefined =>
  project?.state === "retired" ? "project_retired" : project?.state === "archived" ? "project_archived" : undefined;

/** 这条调用的归属里是哪个作业（作业的会话、运行工单段里的消息都带着作业身份） */
const jobOfScope = (scope: MessageScope | undefined) => scope?.scheduledJobId;

export function createScheduledJobs(options: ScheduledJobsOptions): ScheduledJobs {
  const { store, tasks, projects, workOrders, inbox, scheduler, clock, now, scheduleContext, log } = options;
  const unsubscribes: Array<() => void> = [];
  /** 这一轮里没做成的运行（运行号 → 原因）：维护者用 fail_job_run 报的、等不到批准被拦下的、交给用户亲手做的。重启后这一轮反正算中断 */
  const notDone = new Map<string, string>();
  let fillQueued = false;
  let stopped = false;
  let started = false;

  const nowDate = () => new Date(clock.now());
  const next = (schedule: ReminderSchedule, after: Date) => {
    const at = nextOccurrence(schedule, after, scheduleContext());
    return at && nowIso(at);
  };
  /** 这个作业还没结束的运行（排队、运行中） */
  const outstanding = (jobId: string) => runsOfJob(store.reader, jobId).filter((r) => r.state === "queued" || r.state === "running");
  /** 正在运行的那一次 */
  const runningRunOf = (jobId: string) => runsOfJob(store.reader, jobId).find((r) => r.state === "running");

  // ───────────────────────── 登记 ─────────────────────────

  /**
   * 任务的计划确认了：计划里的每个作业定义登记成一个作业（按计划版本和序号只登记一次），连同每次运行的授权。
   * 一个任务只登记一回：执行中的计划变更、自行调整（14 号票）出的新一版计划沿用原来的定时作业，不再登记
   */
  const register = (task: Task) => {
    const stored = tasks.latestPlan(task.id);
    if (stored?.status !== "confirmed" || stored.plan.scheduledJobs.length === 0) return;
    if (listJobs(store.reader).some((j) => j.taskId === task.id)) return;
    // 属于项目的作业只来自单项目任务（jobProjectOf，和提交计划时的检查同一处判）
    const project = jobProjectOf(task, (t) => projects.projectOf(t));
    const pausedBy = projectPause(project);
    // 每项授权在守卫眼里的样子：计划卡上的（用户加了关注类别之后重算过的）
    const cardInfo = (getCard(store.reader, stored.cardId)?.payload as PlanCardPayload | undefined)?.grantInfo ?? {};
    const limitRules = (stored.plan.userLimits ?? []).flatMap((l) => l.temporalRules);
    let n = countJobs(store.reader);
    const time = now();
    const events: NewEvent[] = [];
    stored.plan.scheduledJobs.forEach((def, i) => {
      const key = jobKeys.register(stored.planId, i);
      if (store.eventByIdempotencyKey(key) || !isRepeating(def.schedule)) return;
      n += 1;
      const id = `j-${n}`;
      const policy = jobPolicy(def);
      const nextAt = pausedBy ? undefined : next(def.schedule, nowDate());
      const grantInfo: Record<string, GrantInfo> = Object.fromEntries(policy.grants.flatMap((g) => (cardInfo[g.id] ? [[g.id, cardInfo[g.id]!]] : [])));
      const job: ScheduledJob = {
        id,
        title: def.title,
        schedule: def.schedule,
        each: def.each,
        ...(project ? { projectId: project.id, projectName: project.name } : {}),
        maintainerId: project ? project.maintainerId : jobMaintainerId(id),
        taskId: task.id,
        taskTitle: task.title,
        grants: policy.grants,
        temporalRules: [...policy.temporalRules, ...limitRules],
        grantInfo,
        state: pausedBy ? "paused" : "active",
        ...(pausedBy ? { pausedBy } : {}),
        ...(nextAt === undefined ? {} : { nextAt }),
        lastFailed: false,
        consecutiveFailures: 0,
        runCount: 0,
        createdAt: time,
        updatedAt: time,
      };
      // 用户确认计划才登记，算用户做的
      events.push(jobEvent(job, "registered", "user", undefined, key));
    });
    if (events.length > 0) store.appendBatch(events);
  };

  // ───────────────────────── 计时器 ─────────────────────────

  /** 按作业的最新状态登记或取消到点的计时器 */
  const arm = (job: ScheduledJob) => {
    if (stopped || !started) return;
    if (job.state === "active" && job.nextAt !== undefined) scheduler.schedule(schedulerKey(job.id), Date.parse(job.nextAt), () => trigger(job.id, "scheduled"));
    else scheduler.cancel(schedulerKey(job.id));
  };

  /**
   * 到点（或者启动时补跑错过的）：一次运行进队列，下一次的时间往后算（同一事务）；同一个作业上一次还没跑完的，这一次跳过
   * （只把下一次往后算）。错过几次都只这一次（运行记录写明错过了几次）。属于项目的同一事务里派出这次运行的工单
   */
  const trigger = (jobId: string, kind: JobRunTrigger) => {
    const job = getJob(store.reader, jobId);
    const at = nowDate();
    if (!job || job.state !== "active" || job.nextAt === undefined || Date.parse(job.nextAt) > at.getTime()) return;
    const { due, count } = latestOccurrence(job.schedule, new Date(job.nextAt), at, scheduleContext());
    const nextAt = next(job.schedule, at);
    const time = now();
    const moved: ScheduledJob = { ...withoutNextAt(job), ...(nextAt === undefined ? {} : { nextAt }), updatedAt: time };
    const key = jobKeys.trigger(job.id, nowIso(due));
    if (outstanding(job.id).length > 0) {
      log(`定时作业 ${job.id} 到点了，但上一次还没跑完：这一次跳过`);
      store.append(jobEvent(moved, "rescheduled", "system", undefined, key));
      return;
    }
    const queued: JobRun = {
      runId: `${job.id}-r${job.runCount + 1}`,
      jobId: job.id,
      trigger: kind,
      dueAt: nowIso(due),
      ...(kind === "catch_up" ? { missed: count } : {}),
      state: "queued",
      queuedAt: time,
    };
    const project = job.projectId === undefined ? undefined : projects.get(job.projectId);
    if (job.projectId !== undefined && !project) {
      store.append(jobEvent({ ...moved, lastRun: queued, runCount: job.runCount + 1 }, "triggered", "system", queued, key));
      finish(queued, { state: "failed", reason: PROJECT_GONE_REASON });
      return;
    }
    // 属于项目的：这次运行的工单马上派出、在项目的队列里排着（维护者空着、又有名额就同一事务开始）
    const dispatched = project ? workOrders.dispatchRun({ job, run: queued, project, instructions: runInstructions(job, queued, options.failureLimit), key: jobKeys.runWorkOrder(queued.runId) }) : undefined;
    const run: JobRun = dispatched ? { ...queued, workOrderId: dispatched.workOrder.id } : queued;
    store.appendBatch([jobEvent({ ...moved, lastRun: run, runCount: job.runCount + 1 }, "triggered", "system", run, key), ...(dispatched?.events ?? [])]);
    if (!dispatched) scheduleFill();
  };

  // ───────────────────────── 名额和运行 ─────────────────────────

  /** 名额空出来时，作业自己的维护者那边先进队列的运行开始（属于项目的由派单器按项目的队列和名额开始） */
  function fill(): void {
    fillQueued = false;
    if (stopped) return;
    for (const run of runsIn(store.reader, ["queued"]).filter((r) => r.workOrderId === undefined)) {
      // 每开始一次，名额现数一次（运行开始和占名额在同一事务里）
      if (!options.slots.hasSlot()) return;
      try {
        startOwnRun(run);
      } catch (err) {
        log(`定时作业的运行 ${run.runId} 开始时出错：${errorText(err)}`);
      }
    }
  }

  function scheduleFill(): void {
    if (fillQueued || stopped) return;
    fillQueued = true;
    queueMicrotask(fill);
  }

  /** 作业自己的维护者的一次运行开始：交给它一条带着作业身份的通知（用量记在作业名下），和这次运行开始同一事务 */
  const startOwnRun = (run: JobRun) => {
    const job = getJob(store.reader, run.jobId);
    if (!job) return;
    if (job.state !== "active") return finish(run, { state: "dropped", reason: droppedReason(job) });
    const running: JobRun = { ...run, state: "running", startedAt: now() };
    const notice = buildAgentNotice(maintainerChannel(job.maintainerId), runInstructions(job, run, options.failureLimit), jobKeys.runNotice(run.runId), { scheduledJobId: job.id });
    store.appendBatch([jobEvent({ ...job, lastRun: running, updatedAt: running.startedAt! }, "run_started", "system", running, jobKeys.runStart(run.runId)), notice.event]);
  };

  /** 属于项目的作业：这次运行的工单开始了（排到了、有名额），这次运行开始 */
  const onRunWorkOrderStarted = (wo: JobRunWorkOrder) => {
    const run = getRun(store.reader, wo.runId);
    const job = run && getJob(store.reader, run.jobId);
    if (!run || !job || run.state !== "queued") return;
    const running: JobRun = { ...run, state: "running", startedAt: wo.startedAt ?? now(), workOrderId: wo.id };
    store.append(jobEvent({ ...job, ...(job.lastRun?.runId === run.runId ? { lastRun: running } : {}), updatedAt: now() }, "run_started", "system", running, jobKeys.runStart(run.runId)));
  };

  /**
   * 一次运行结束：成功清零连续失败，算数的失败加一；运营中的作业连续失败到了次数自动暂停，同一事务里待我处理放一条事项。
   * 中断、排着时被丢掉的不算进连续失败，也不改"最近一次失败"
   */
  function finish(run: JobRun, end: RunEnd): void {
    const job = getJob(store.reader, run.jobId);
    const latest = getRun(store.reader, run.runId) ?? run;
    if (!job || (latest.state !== "queued" && latest.state !== "running")) return;
    const time = now();
    const ended: JobRun = { ...latest, state: end.state, endedAt: time, ...(end.state === "done" ? {} : { reason: end.reason }) };
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
        urgency: "non_blocking",
        actions: [JOB_AUTO_PAUSED_ACTIONS.resume, JOB_AUTO_PAUSED_ACTIONS.keep],
        data,
      });
      events.push(item.event);
      alert = item.item;
    }
    store.appendBatch([jobEvent(after, "run_finished", "system", ended, jobKeys.runEnd(run.runId)), ...events]);
    notDone.delete(run.runId);
    if (alert) inbox.alert(alert);
  }

  /** 这一轮结束了：这次运行怎么结束的（被打断是中断；出错、中止、报了做不了、有一步没做成是失败） */
  const endOf = (turn: TurnEndEventPayload, run: JobRun): RunEnd => {
    if (turn.outcome === "interrupted") return { state: "interrupted", reason: INTERRUPTED_REASON };
    const failure = turnFailure(turn) ?? notDone.get(run.runId);
    return failure === undefined ? { state: "done" } : { state: "failed", reason: failure };
  };

  /**
   * 维护者处理完一条输入：是作业的一次运行的通知（系统通知、带着作业身份）就有了这次运行的结局——
   * 不属于项目的直接结束；属于项目的让工单所在的这一段收尾（写回之后工单结束，这次运行随之结束；被打断的马上记中断）
   */
  const onTurnEnd = (maintainerId: string, turn: TurnEndEventPayload) => {
    const input = inputOf(store.reader, turn.inputMessageId);
    const jobId = jobOfScope(input?.scope);
    if (jobId === undefined || getMessage(store.reader, turn.inputMessageId)?.speaker !== "system") return;
    const job = getJob(store.reader, jobId);
    const run = runningRunOf(jobId);
    if (!job || !run || job.maintainerId !== maintainerId) return;
    const end = endOf(turn, run);
    if (job.projectId === undefined || end.state === "interrupted") finish(run, end);
    if (job.projectId === undefined) return;
    const wo = run.workOrderId === undefined ? undefined : workOrders.get(run.workOrderId);
    // 只认这次运行的工单还是维护者手上这一张时（催写回之类的通知处理完不算）
    if (!wo || workOrders.currentWorkOrder(maintainerId)?.id !== wo.id) return;
    workOrders.finishRun(wo.id, end.state === "done" ? "done" : "unable", end.state === "done" ? undefined : end.reason);
  };

  /** 属于项目的作业：这次运行的工单结束了，这次运行随之结束（完成是成功，退回、做不了是失败；已经记过结局的不再记） */
  const onRunWorkOrderEnded = (wo: JobRunWorkOrder) => {
    const run = getRun(store.reader, wo.runId);
    if (!run) return;
    finish(run, wo.outcome === "done" ? { state: "done" } : { state: "failed", reason: wo.reason ?? WORK_ORDER_NOT_DONE });
  };

  /** 这一轮里有一步没做成：作业的会话或运行工单段里的调用，等不到批准被拦下、交给用户亲手做 */
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

  /** 作业暂停、取消了：排着的运行一并丢掉（不算进连续失败），属于项目的退回它还排着的工单；正在运行的那一次照常做完 */
  const dropQueued = (after: ScheduledJob): NewEvent[] =>
    runsOfJob(store.reader, after.id)
      .filter((r) => r.state === "queued")
      .flatMap((r) => {
        const reason = droppedReason(after);
        const ended: JobRun = { ...r, state: "dropped", endedAt: now(), reason };
        const job = after.lastRun?.runId === r.runId ? { ...after, lastRun: ended } : after;
        return [jobEvent(job, "run_finished", "system", ended, jobKeys.runEnd(r.runId)), ...(r.workOrderId === undefined ? [] : workOrders.dropRun(r.workOrderId, reason))];
      });

  /** 暂停（用户、项目停用归档）、取消的事件：作业的变化，连同丢掉排着的运行 */
  const pauseEvents = (job: ScheduledJob, by: JobPauseReason, actor: TaskActor, key?: string): NewEvent[] => {
    const after = paused(job, by);
    return [jobEvent(after, "paused", actor, undefined, key), ...dropQueued(after)];
  };
  const cancelEvents = (job: ScheduledJob, actor: TaskActor, key?: string): NewEvent[] => {
    const after: ScheduledJob = { ...withoutPause(withoutNextAt(job)), state: "cancelled", updatedAt: now() };
    return [jobEvent(after, "cancelled", actor, undefined, key), ...dropQueued(after)];
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
    return cancelEvents(job, "user", key);
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

  /** "定时作业被自动暂停"事项上点了"恢复" */
  const resumeFromNotice = (data: unknown) => {
    const jobId = (data as Partial<JobAutoPausedNoticeData> | undefined)?.jobId;
    const job = typeof jobId === "string" ? getJob(store.reader, jobId) : undefined;
    // 已经在看板上恢复过、取消了的：什么也不做
    if (!job || job.state !== "paused") return;
    try {
      store.appendBatch(resumeEvents(job, "user"));
    } catch (err) {
      log(`从"定时作业被自动暂停"恢复 ${job.id} 没做成：${errorText(err)}`);
    }
  };

  // ───────────────────────── 授权和装配 ─────────────────────────

  /** 维护者报这次运行失败：它手上正在运行的那一次（属于项目的作业是它手上这张工单的那一次）记下原因 */
  const reportFailure = (maintainerId: string, reason: string): { runId: string } => {
    const wo = workOrders.currentWorkOrder(maintainerId);
    const run = runsIn(store.reader, ["running"]).find((r) => {
      const job = getJob(store.reader, r.jobId);
      if (job?.maintainerId !== maintainerId) return false;
      return job.projectId === undefined || (wo !== undefined && isJobRunWorkOrder(wo) && wo.runId === r.runId);
    });
    if (!run) throw new RequestRejected("not_allowed", refusal.noRun);
    notDone.set(run.runId, reason);
    return { runId: run.runId };
  };

  /**
   * 守卫看到的作业的授权（带着授权的会话段，每次运行一段）：作业的授权项（作业在就一直有效；暂停、取消即收回，不给）、
   * 时序规则、本任务的关注类别（确认的计划里的）
   */
  const guardTask = (jobId: string): GuardTask | null => {
    const job = getJob(store.reader, jobId);
    if (!job) return null;
    const plan = tasks.confirmedPlan(job.taskId)?.plan;
    return {
      taskId: job.id,
      plan: toGuardJobPlan({ grants: job.state === "active" ? job.grants : [], temporalRules: job.temporalRules, watchCategories: plan?.watchCategories ?? [], grantedAt: Date.parse(job.createdAt) }),
      currentStageId: JOB_RUN_STAGE,
      segmentScoped: true,
    };
  };

  // ───────────────────────── 启动时 ─────────────────────────

  /**
   * 重启前在跑的运行对一遍：属于项目的看工单（已经结束的随之结束）；不属于项目的看交给它的通知处理完了没有
   * （处理到一半被打断的，作业自己的维护者的会话开始时标成中断，这里的订阅收得到）
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
      const noticeId = (store.eventByIdempotencyKey(jobKeys.runNotice(run.runId))?.payload as { message?: { id: string } } | undefined)?.message?.id;
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
      const { task, change } = event.payload as TaskEventPayload;
      if (change === "plan_confirmed") register(task);
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

  return {
    attach() {
      unsubscribes.push(
        store.onAppend((event) => {
          try {
            onEvent(event);
          } catch (err) {
            log(`定时作业处理事件 ${event.type} 出错：${errorText(err)}`);
          }
        }),
        inbox.onNoticeHandled("scheduled_job_auto_paused", JOB_AUTO_PAUSED_ACTIONS.resume, (item) => resumeFromNotice(item.data)),
      );
      // 名额空出来：作业自己的维护者那边排着的运行看看能不能开始
      options.slots.onFreed(scheduleFill);
    },
    start() {
      started = true;
      // 计划确认了、作业还没登记（确认之后守护进程马上就停了）、任务还没结束的补上
      for (const task of tasks.list()) if (task.state === "queued" || task.state === "running") register(task);
      reconcile();
      // 过了点的运营中作业：不管错过几次只补跑一次；没过点的登记到那个时刻
      for (const job of listJobs(store.reader, ["active"])) {
        if (job.nextAt !== undefined && Date.parse(job.nextAt) <= clock.now()) trigger(job.id, "catch_up");
        else arm(job);
      }
      fill();
    },
    stop() {
      stopped = true;
      for (const off of unsubscribes.splice(0)) off();
      for (const job of listJobs(store.reader)) scheduler.cancel(schedulerKey(job.id));
    },
    get: (jobId) => getJob(store.reader, jobId),
    list: () => listJobs(store.reader),
    ofProject: (projectId) => jobsOfProject(store.reader, projectId),
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
    reportFailure,
    runAssembly(jobId, maintainerId) {
      const job = getJob(store.reader, jobId);
      if (!job) return undefined;
      return {
        // 作业所在计划的工具包：建它的任务确认的计划里的（属于项目的装配时再和项目的取交集）
        toolkit: tasks.confirmedPlan(job.taskId)?.plan.toolkit ?? emptyToolkit(),
        tools: [failJobRunTool({ reportFailure }, maintainerId, options.failureLimit)],
        source: jobSource(job),
        guardTask: () => guardTask(jobId),
      };
    },
    currentRun: (jobId) => runningRunOf(jobId)?.runId,
    calendar(from, to) {
      const inRange = (iso: string) => Date.parse(iso) >= from.getTime() && Date.parse(iso) < to.getTime();
      return listJobs(store.reader, ["active", "paused"]).map((job) => ({
        job,
        occurrences: occurrencesBetween(job.schedule, from, to, scheduleContext()).map((d) => nowIso(d)),
        runs: runsOfJob(store.reader, job.id).filter((r) => inRange(r.dueAt)),
      }));
    },
    rearm() {
      const at = nowDate();
      for (const job of listJobs(store.reader, ["active"])) {
        // 不跟着工作日历变的不用动；已经到点、正等着触发的不动（触发时按当时的工作日历算下一次）
        if (!dependsOnWorkdayCalendar(job.schedule) || job.nextAt === undefined || Date.parse(job.nextAt) <= at.getTime()) continue;
        const nextAt = next(job.schedule, at);
        if (nextAt === job.nextAt) continue;
        store.append(jobEvent({ ...withoutNextAt(job), ...(nextAt === undefined ? {} : { nextAt }), updatedAt: now() }, "rescheduled", "system"));
      }
    },
  };
}
