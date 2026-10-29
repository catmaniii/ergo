// 项目的"运营概况"和项目页最上面的"现在"（140 号票，纯函数）。
// - 运营概况（projectOperationsSummary）：项目卡、项目头里的"现在"（项目页和维护者会话页左栏）用同一个组件（ui/operations-summary.tsx），
//   数据只有这一份。内容是服务入口（"打开「X」"、在线圆点，前面一张首页的缩略图）和定时任务（项目的内部任务里定时的、事件触发的：
//   收起时一行"2 个定时任务：每天 08:00 日报、每周日 18:00 周报"，展开每条一行：名字、时间表、下次、上次和结果、运营中还是已暂停）。
//   只有使用中的项目有；停用、归档了的照样列，整块标"已停用""已归档"（服务撤下了也列、缩略图灰着）。没有服务的不列入口，
//   没有定时任务的不列那一行，两样都没有就没有（undefined）。257 号票：使用中、有在 LSM 上的服务的，服务那一块前面一行开关——
//   现在怎么样（在线、已关闭、启动中、关闭中、失败……）和"启动""关闭"两个按钮能不能点（协议包的 projectPower）。
// - 现在（projectNow）：按项目状态挑最要紧的事——筹备中是立项书到哪一步了、要你做什么；建设中是建设任务的进度、正在做的工单、
//   卡住的工单（等你、失败、被拦、超时没动，写原因）、最近一句进展；使用中是运营概况和最近几次运行（失败的醒目）；
//   已停用、已归档是一句话说清停了什么、怎么重新启用。数据都是现有的视图：定时任务的下次、上次和结果在看板频道的触发登记、运行记录里。
import {
  ENDED_TASK_STATES,
  isInternalTo,
  JOB_RUN_STATE_LABEL,
  jobTriggerText,
  type JobRun,
  type Project,
  type ProjectPowerView,
  projectPower,
  type ProjectServiceView,
  type ScheduledJob,
  scheduledJobStatusText,
  serviceShown,
  t,
  type Task,
  TASK_PAUSE_REASON_LABEL,
  TASK_WAIT_REASON_LABEL,
  UNFINISHED_TASK_STATES,
  type WorkOrder,
  workOrderStatusText,
  tTable,
  workOrderTaskId,
} from "./protocol.ts";
import { taskStatusText } from "./board.ts";
import { type ServiceEntryView, serviceEntryView } from "./project-services.ts";
import { eventNames } from "./scheduled-jobs.ts";
import { agentActivity, type UiState } from "./ui-state.ts";
import { type BoardProgress, projectRowProgress } from "./workflow-view.ts";

// ───────────────────────── 运营概况 ─────────────────────────

/** 运营概况里的一个服务 */
export interface SummaryService {
  view: ProjectServiceView;
  /** 入口的样子（"打开「X」"、在线圆点的颜色、点了能不能打开） */
  entry: ServiceEntryView;
  /**
   * 首页的缩略图：截过的给截图时间（shot）；上线了、有网页却还没有图的（还没截、截不成）不显示图，只悄悄取一次（probe：守护进程把取图的
   * 请求当"有人在看"，补截一张）；没有网页、没上线的没有
   */
  thumbnail?: { kind: "shot"; at: string } | { kind: "probe" };
  /** 缩略图灰掉时标的字："不在线"、"已停用"、"已归档"；在线的没有 */
  dim?: string;
}

/** 运营概况里的一条定时任务（项目的内部任务里定时的、事件触发的，就是一份触发登记） */
export interface SummaryTimedTask {
  jobId: string;
  /** 它的任务（点了进任务整页）；还没迁移的老作业没有 */
  taskId?: string;
  /** 名字：运营方案里这一条的名字（短），不是运营方案建的用任务的标题 */
  name: string;
  /** 时间表："每天 08:00"；事件触发的"事件发生时：本机文件夹 … 里新增 *.md 文件" */
  scheduleText: string;
  /** 收起时那一行里的一项："每天 08:00 日报"、"事件触发 新书摘入库"，你暂停了的后面加"（已暂停）" */
  brief: string;
  /** 下次（定时的、运营中的才有） */
  nextAt?: string;
  /** 上次：什么时候、结果（成功、失败……）；失败标红，部分完成（176 号票）另一种颜色 */
  last?: { at: string; text: string; failed: boolean; partial?: boolean };
  /** 运营中、已暂停（写原因）、已停用 / 已归档（项目停了） */
  status: "active" | "paused" | "stopped";
  statusText: string;
}

export interface OperationsSummary {
  services: SummaryService[];
  timed: SummaryTimedTask[];
  /** 收起时的那一行："2 个定时任务：每天 08:00 日报、每周日 18:00 周报"；没有定时任务的没有 */
  line?: string;
  /** 停用、归档了的项目：整块标"已停用""已归档" */
  stopped?: string;
  /** 257：服务全部启动、全部关闭的那一行（使用中、有在 LSM 上的服务的才有） */
  power?: ProjectPowerView;
}

/** 运营概况只有这几种状态的项目有：使用中的，和停用、归档了的（照样列，标出来） */
const SUMMARY_STATES: readonly Project["state"][] = ["in_use", "retired", "archived"];

/** 停了的项目整块标的字 */
const STOPPED_LABEL: Partial<Record<Project["state"], string>> = tTable({ retired: "state.projectNow.stopped.retired", archived: "state.projectNow.stopped.archived" });

/** 这个项目的定时任务（内部任务里定时的、事件触发的触发登记）：没取消的，先登记的在前 */
export function projectTimedJobs(state: Pick<UiState, "scheduledJobs">, projectId: string): ScheduledJob[] {
  return Object.values(state.scheduledJobs)
    .filter((j) => isInternalTo(j, projectId) && j.state !== "cancelled")
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** 一次运行的时刻：结束的按结束，开始了的按开始，还排着的按排进来的时候 */
const runAt = (run: JobRun) => run.endedAt ?? run.startedAt ?? run.queuedAt;

/** 一份触发登记的名字：运营方案里对应那一条的名字，不然是它的任务的标题，再不然是登记上的标题 */
function timedName(state: UiState, project: Project, job: ScheduledJob): string {
  const taskId = job.ownerTaskId ?? job.taskId;
  const item = project.operations?.items.find((i) => i.taskId !== undefined && i.taskId === taskId);
  return item?.name ?? state.tasks[taskId]?.title ?? job.title;
}

function timedTask(state: UiState, project: Project, job: ScheduledJob): SummaryTimedTask {
  const name = timedName(state, project, job);
  const scheduleText = jobTriggerText(job, eventNames(state));
  const lastRun = (job.lastRun && state.jobRuns[job.lastRun.runId]) ?? job.lastRun;
  const stopped = STOPPED_LABEL[project.state];
  const status = stopped ? "stopped" : job.state === "active" ? "active" : "paused";
  const statusText = stopped ?? scheduledJobStatusText(job);
  return {
    jobId: job.id,
    ...(job.ownerTaskId ? { taskId: job.ownerTaskId } : {}),
    name,
    scheduleText,
    brief: t(status === "paused" ? "state.projectNow.briefPaused" : "state.projectNow.brief", { when: job.event ? t("state.projectNow.onEvent") : scheduleText, name }),
    ...(job.nextAt && status === "active" ? { nextAt: job.nextAt } : {}),
    ...(lastRun ? { last: { at: runAt(lastRun), text: JOB_RUN_STATE_LABEL[lastRun.state], failed: lastRun.state === "failed", ...(lastRun.state === "partial" ? { partial: true } : {}) } } : {}),
    status,
    statusText,
  };
}

/** 收起时的一行："2 个定时任务：……"；有事件触发的写"定时、事件触发的任务"，只有事件触发的写"事件触发的任务" */
function timedLine(jobs: readonly ScheduledJob[], timed: readonly SummaryTimedTask[]): string {
  const events = jobs.filter((j) => j.event).length;
  const key = events === 0 ? "state.projectNow.line.timed" : events === jobs.length ? "state.projectNow.line.event" : "state.projectNow.line.mixed";
  return t(key, { count: timed.length, list: timed.map((x) => x.brief).join(t("state.projectNow.listSep")) });
}

function summaryService(view: ProjectServiceView, stopped: string | undefined): SummaryService {
  const entry = serviceEntryView(view);
  const web = view.url !== undefined;
  const thumbnail = web && view.thumbnailAt !== undefined ? ({ kind: "shot", at: view.thumbnailAt } as const) : web && view.rollout === "live" ? ({ kind: "probe" } as const) : undefined;
  // 257：你关着的标"已关闭"（不是挂了）
  const dim = stopped ?? (view.paused ? t("state.projectNow.paused") : view.rollout === "live" && view.status === "online" ? undefined : t("state.projectNow.offline"));
  return { view, entry, ...(thumbnail ? { thumbnail } : {}), ...(dim ? { dim } : {}) };
}

/**
 * 项目的运营概况：使用中的项目的服务（撤下了的不算）和定时任务；停用、归档了的照样列（服务撤下了也列），整块标出来。
 * 别的状态的项目、两样都没有的是 undefined
 */
export function projectOperationsSummary(state: UiState, projectId: string): OperationsSummary | undefined {
  const project = state.projects[projectId];
  if (!project || !SUMMARY_STATES.includes(project.state)) return undefined;
  const stopped = STOPPED_LABEL[project.state];
  const services = state.projectServices.filter((v) => v.projectId === projectId && (stopped !== undefined || serviceShown(v))).map((v) => summaryService(v, stopped));
  const jobs = projectTimedJobs(state, projectId);
  const timed = jobs.map((j) => timedTask(state, project, j));
  if (services.length === 0 && timed.length === 0) return undefined;
  const power = projectPower(project.state, state.projectServices.filter((v) => v.projectId === projectId));
  return { services, timed, ...(timed.length > 0 ? { line: timedLine(jobs, timed) } : {}), ...(stopped ? { stopped } : {}), ...(power ? { power } : {}) };
}

// ───────────────────────── 现在 ─────────────────────────

/** 最近几次运行里的一次 */
export interface RecentRun {
  runId: string;
  jobId: string;
  /** 哪条任务（点了进任务整页） */
  taskId?: string;
  name: string;
  at: string;
  /** "成功"、"失败"、"运行中"…… */
  text: string;
  failed: boolean;
  /** 失败、中断、没运行的原因 */
  reason?: string;
}

/** "现在"里列几次最近的运行 */
export const RECENT_RUNS_SHOWN = 5;

/** 这个项目的定时任务最近几次运行（新的在前，最多 limit 次） */
export function projectRecentRuns(state: UiState, projectId: string, limit = RECENT_RUNS_SHOWN): RecentRun[] {
  const project = state.projects[projectId];
  if (!project) return [];
  const jobs = new Map(projectTimedJobs(state, projectId).map((j) => [j.id, j]));
  const runs = new Map<string, JobRun>();
  for (const job of jobs.values()) if (job.lastRun) runs.set(job.lastRun.runId, job.lastRun);
  for (const run of Object.values(state.jobRuns)) if (jobs.has(run.jobId)) runs.set(run.runId, run);
  return [...runs.values()]
    .toSorted((a, b) => runAt(b).localeCompare(runAt(a)) || b.runId.localeCompare(a.runId, undefined, { numeric: true }))
    .slice(0, limit)
    .map((run) => {
      const job = jobs.get(run.jobId)!;
      return {
        runId: run.runId,
        jobId: run.jobId,
        ...(job.ownerTaskId ? { taskId: job.ownerTaskId } : {}),
        name: timedName(state, project, job),
        at: runAt(run),
        text: JOB_RUN_STATE_LABEL[run.state],
        failed: run.state === "failed",
        ...(run.reason ? { reason: run.reason } : {}),
      };
    });
}

/** 卡住的工单（建设中）：等你、失败、被拦、超时没动 */
export type StuckKind = "waiting" | "failed" | "blocked" | "stale";

export const STUCK_LABEL: Readonly<Record<StuckKind, string>> = tTable({
  waiting: "state.projectNow.stuck.waiting",
  failed: "state.projectNow.stuck.failed",
  blocked: "state.projectNow.stuck.blocked",
  stale: "state.projectNow.stuck.stale",
});

export interface NowStuck {
  key: string;
  kind: StuckKind;
  /** 卡在哪：任务、工单的名字 */
  title: string;
  /** 点了去这个任务的整页 */
  taskId?: string;
  /** 为什么卡住 */
  reason: string;
}

/** 正在做的工单 */
export interface NowWorkOrder {
  id: string;
  title: string;
  taskId?: string;
  status: string;
}

/** 进行中的工单多久没有动静（维护者也没在干活）算"超时没动" */
export const STALE_WORK_ORDER_MS = 30 * 60_000;

export type ProjectNow =
  | {
      kind: "preparing";
      /** 起草中（立项问答）、你打回了在改、等你确认、已确认等你开工 */
      step: "drafting" | "revising" | "awaiting_confirm" | "confirmed";
      text: string;
      /** 要你做的：和维护者交流、去确认立项书、开工 */
      action?: "chat" | "charter" | "start_build";
    }
  | {
      kind: "building";
      /** 建设任务：状态和进度 */
      build?: { taskId: string; title: string; status: string; progress?: BoardProgress };
      doing: NowWorkOrder[];
      stuck: NowStuck[];
      /** 最近一句进展：最近验收的阶段的那一两句 */
      latest?: string;
      /** "首版做完了"卡还等你确认：卡的编号（"现在"里直接放这张卡） */
      buildDoneCardId?: string;
      /** "转入使用"确认卡还等你确认（259 号票：你在项目页点的、维护者提的、秘书代办的）：卡的编号（"现在"里直接放这张卡） */
      goLiveCardId?: string;
    }
  | { kind: "in_use"; summary?: OperationsSummary; runs: RecentRun[] }
  | { kind: "stopped"; state: "retired" | "archived"; text: string; how: string; summary?: OperationsSummary };

/** 筹备中：立项书到哪一步了 */
function preparingNow(state: UiState, project: Project): ProjectNow {
  if (project.charterConfirmed) return { kind: "preparing", step: "confirmed", text: t("state.projectNow.preparing.confirmed"), action: "start_build" };
  if (project.charterCardId === undefined) return { kind: "preparing", step: "drafting", text: t("state.projectNow.preparing.drafting"), action: "chat" };
  const card = state.cards[project.charterCardId]?.card;
  if (!card || card.status === "pending") return { kind: "preparing", step: "awaiting_confirm", text: t("state.projectNow.preparing.awaitingConfirm"), action: "charter" };
  return { kind: "preparing", step: "revising", text: t("state.projectNow.preparing.revising"), action: "chat" };
}

/** 原因后面接上补充说明（有的话） */
const note = (base: string, extra?: string) => (extra ? t("state.projectNow.withNote", { base, extra }) : base);

/** 一个任务卡住了没有：等你（除了审批）、被拦（等你批准、累计被拒暂停了）、失败（写原因） */
function taskStuck(task: Task): Omit<NowStuck, "key" | "title" | "taskId"> | undefined {
  if (task.state === "waiting_for_user" && task.waitReason === "approval") return { kind: "blocked", reason: note(t("state.projectNow.reason.blocked"), task.waitNote) };
  if (task.state === "waiting_for_user")
    return { kind: "waiting", reason: note(task.waitReason ? t("state.projectNow.reason.waitingFor", { reason: TASK_WAIT_REASON_LABEL[task.waitReason] }) : t("state.projectNow.reason.waiting"), task.waitNote) };
  if (task.state === "paused" && task.pauseReason) return { kind: "blocked", reason: t("state.projectNow.reason.paused", { reason: TASK_PAUSE_REASON_LABEL[task.pauseReason] }) };
  if (task.state === "failed") return { kind: "failed", reason: task.failReason ?? t("state.projectNow.reason.failed") };
  return undefined;
}

/** 建设中：卡住的（按任务、工单各认一遍，同一个任务只列一次） */
function stuckOf(state: UiState, project: Project, nowMs: number): NowStuck[] {
  const out: NowStuck[] = [];
  const listed = new Set<string>();
  const tasks = Object.values(state.tasks).filter(
    (x) => x.id === project.buildTaskId || (isInternalTo(x, project.id) && (UNFINISHED_TASK_STATES.includes(x.state) || x.state === "failed")),
  );
  for (const task of tasks.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const stuck = taskStuck(task);
    if (!stuck) continue;
    listed.add(task.id);
    out.push({ key: `task:${task.id}`, title: task.title, taskId: task.id, ...stuck });
  }
  const sleeping = agentActivity(state, project.maintainerId).state === "sleeping";
  const orders = Object.values(state.workOrders)
    .filter((w) => w.projectId === project.id)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const w of orders) {
    const taskId = workOrderTaskId(w);
    if (taskId !== undefined && listed.has(taskId)) continue;
    const stuck = orderStuck(state, w, sleeping, nowMs);
    if (!stuck) continue;
    if (taskId !== undefined) listed.add(taskId);
    out.push({ key: `wo:${w.id}`, title: w.title, ...(taskId === undefined ? {} : { taskId }), ...stuck });
  }
  return out;
}

/** 一张工单卡住了没有：等你回答提问、等你确认派出、做不了 / 退回了而任务还没结束、进行中却很久没动静（维护者也没在干活） */
function orderStuck(state: UiState, w: WorkOrder, sleeping: boolean, nowMs: number): Omit<NowStuck, "key" | "title" | "taskId"> | undefined {
  if (w.state === "clarifying") return { kind: "waiting", reason: t("state.projectNow.reason.clarifying") };
  if (w.state === "awaiting_confirm") return { kind: "waiting", reason: t("state.projectNow.reason.awaitingConfirm") };
  if (w.state === "ended" && (w.outcome === "unable" || w.outcome === "returned")) {
    const taskId = workOrderTaskId(w);
    const task = taskId === undefined ? undefined : state.tasks[taskId];
    if (!task || ENDED_TASK_STATES.includes(task.state)) return undefined;
    return { kind: "failed", reason: w.reason ?? workOrderStatusText(w) };
  }
  if (w.state === "in_progress" && sleeping) {
    const idle = nowMs - Date.parse(w.updatedAt);
    if (idle >= STALE_WORK_ORDER_MS) return { kind: "stale", reason: t("state.projectNow.reason.stale", { count: Math.floor(idle / 60_000) }) };
  }
  return undefined;
}

/** 建设中：最近一句进展（最近验收的那个阶段宣布完成时写的那一两句） */
function latestOf(task: Task | undefined): string | undefined {
  const accepted = (task?.stages?.list ?? []).filter((s) => s.state === "accepted" && s.summary);
  const last = accepted.at(-1);
  return last ? t("state.projectNow.latest", { title: last.title, summary: last.summary }) : undefined;
}

function buildingNow(state: UiState, project: Project, nowMs: number): ProjectNow {
  const task = project.buildTaskId === undefined ? undefined : state.tasks[project.buildTaskId];
  // 311 号票：计划还没授权的只写状态（不再同时写"尚无计划"）
  const progress = task && projectRowProgress(state, task);
  const doing = Object.values(state.workOrders)
    .filter((w) => w.projectId === project.id && w.state === "in_progress")
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((w) => {
      const taskId = workOrderTaskId(w);
      return { id: w.id, title: w.title, ...(taskId === undefined ? {} : { taskId }), status: workOrderStatusText(w) };
    });
  const pendingOf = (type: "build_done" | "go_live") => Object.values(state.cards).find((c) => c.card.type === type && c.card.status === "pending" && (c.card.payload as { projectId?: string }).projectId === project.id);
  const buildDone = pendingOf("build_done");
  const goLive = pendingOf("go_live");
  const latest = latestOf(task);
  return {
    kind: "building",
    ...(task ? { build: { taskId: task.id, title: task.title, status: taskStatusText(task), ...(progress ? { progress } : {}) } } : {}),
    doing,
    stuck: stuckOf(state, project, nowMs),
    ...(latest ? { latest } : {}),
    ...(buildDone ? { buildDoneCardId: buildDone.card.id } : {}),
    ...(goLive ? { goLiveCardId: goLive.card.id } : {}),
  };
}

/** 已停用、已归档：一句话说清停了什么、怎么重新启用 */
function stoppedNow(state: UiState, project: Project & { state: "retired" | "archived" }): ProjectNow {
  const services = state.projectServices.filter((v) => v.projectId === project.id);
  const jobs = projectTimedJobs(state, project.id);
  const titles = services.map((v) => t("state.projectNow.stopped.serviceTitle", { title: v.title })).join(t("state.projectNow.stopped.serviceSep"));
  const what = [
    ...(services.length > 0 ? [t("state.projectNow.stopped.services", { titles })] : []),
    ...(jobs.length > 0 ? [t("state.projectNow.stopped.jobs", { count: jobs.length })] : []),
  ];
  const label = STOPPED_LABEL[project.state]!;
  const text = what.length > 0 ? t("state.projectNow.stopped.text", { label, what: what.join(t("state.projectNow.stopped.whatSep")) }) : t("state.projectNow.stopped.nothing", { label });
  const back = what.length > 0 ? t("state.projectNow.stopped.backRunning") : t("state.projectNow.stopped.backInUse");
  const how = project.state === "retired" ? t("state.projectNow.stopped.howRetired", { back }) : t("state.projectNow.stopped.howArchived");
  const summary = projectOperationsSummary(state, project.id);
  return { kind: "stopped", state: project.state, text, how, ...(summary ? { summary } : {}) };
}

/** 项目页最上面的"现在"：按项目状态挑最要紧的事；nowMs 是现在（判"超时没动"） */
export function projectNow(state: UiState, projectId: string, nowMs: number): ProjectNow | undefined {
  const project = state.projects[projectId];
  if (!project) return undefined;
  switch (project.state) {
    case "preparing":
      return preparingNow(state, project);
    case "building":
      return buildingNow(state, project, nowMs);
    case "in_use": {
      const summary = projectOperationsSummary(state, projectId);
      return { kind: "in_use", ...(summary ? { summary } : {}), runs: projectRecentRuns(state, projectId) };
    }
    case "retired":
    case "archived":
      return stoppedNow(state, { ...project, state: project.state });
  }
}
