// 一个真任务在看板卡片、对话框标题栏上要的东西（13、24、25、60、76 号票陆续加的，368 号票从 TasksPage 挪出来：看板和对话框都用）。
import { TASK_STATUS_LABEL, WAIT_REASON_LABEL } from "../model/labels.ts";
import type { TaskSummary } from "../model/types.ts";
import {
  activityNote,
  type AgentActivity,
  isTriggered,
  lastRunText,
  remoteBadgeOf,
  type ScheduledJobView,
  t,
  type Task,
  TASK_END_KIND_LABEL,
  taskKind,
  taskObservedLine,
  taskStageAt,
  taskStatusText,
  userDecidesWait,
} from "../state/index.ts";

/**
 * 定时、事件触发的任务（76、77 号票）在卡上、详情上的那几样：触发登记的状态、时间表（事件触发的是在等什么事件）、下一次、
 * 最近一次运行和最近一次触发、能做的动作
 */
function triggerSummary(view: ScheduledJobView): NonNullable<TaskSummary["trigger"]> {
  const last = lastRunText(view.lastRun);
  return {
    jobId: view.job.id,
    active: view.job.state === "active",
    statusLine: view.statusText,
    schedule: view.scheduleText,
    ...(view.waitingFor ? { waitingFor: view.waitingFor } : {}),
    ...(view.lastTrigger ? { lastTrigger: view.lastTrigger } : {}),
    ...(view.job.nextAt ? { nextAt: view.job.nextAt } : {}),
    ...(last ? { lastRun: last } : {}),
    actions: view.actions,
    ...(view.reschedule ? { reschedule: view.reschedule } : {}),
    ...(view.runNow ? { runNow: true } : {}),
  };
}

/** 一个真任务在看板卡片、任务详情状态行上要的东西 */
export interface TaskSummarySource {
  readonly task: Task;
  /** 负责人的活动状态 */
  readonly activity: AgentActivity;
  /** 这个任务名下的 token 总量（账本） */
  readonly tokens: number;
  /** 其中缓存命中的（311 号票） */
  readonly cacheHit?: number | undefined;
  /** 它的工单还排着时，排在哪个项目后面 */
  readonly waitingForProject?: string | undefined;
  /** 定时触发的任务的触发登记（76 号票） */
  readonly trigger?: ScheduledJobView | undefined;
  /** 看板卡上的进度（taskBoardProgress） */
  readonly progress?: TaskSummary["progress"] | undefined;
}

/**
 * 真任务在看板卡片上的样子："第 N/M 阶段"的 M 取自计划，N 在开始执行后才有（13 号票），之前写 0（任务详情的状态行用）；
 * token 总量来自账本（24 号票）；负责人的活动状态连同说明（干活中在做什么、等你批准什么，25 号票）；
 * 它的工单还排着（项目的负责人正忙）时标排队、"等项目 X"（16 号票：这时负责人的活动状态是别的工单的）；
 * 进度条（60 号票）流程是做完的步数、长程任务是已验收的阶段数
 */
export function taskSummary({ task, activity, tokens, cacheHit, waitingForProject, trigger, progress }: TaskSummarySource): TaskSummary {
  const note = waitingForProject ? t("pages.tasks.waitingForProject", { project: waitingForProject }) : activityNote(activity);
  const timed = isTriggered(task);
  return {
    kind: "task",
    id: task.id,
    title: task.title,
    status: task.state,
    taskKind: taskKind(task),
    ...(task.runtime === undefined ? {} : { runtime: task.runtime }),
    ...(task.workdir === undefined ? {} : { workdir: task.workdir }),
    ...(remoteBadgeOf(task.takeover) ? { remote: remoteBadgeOf(task.takeover)! } : {}),
    activity: waitingForProject ? "queued" : activity.state,
    ...(note === undefined ? {} : { activityNote: note }),
    projects: task.projects,
    updatedAt: task.updatedAt,
    tokens,
    // 311 号票：其中缓存命中的单写（"124 万 token（其中缓存命中 104 万）"）
    ...(cacheHit ? { cacheHitTokens: cacheHit } : {}),
    ...(task.waitReason ? { waitReason: task.waitReason } : {}),
    // 等我的原因说明（卡住求助、超预算写的原因，被杀后的"中断：不确定 X 是否已执行"，23 号票）：看板的卡上也看得到
    ...(task.state === "waiting_for_user" && userDecidesWait(task) && task.waitNote ? { waitNote: task.waitNote } : {}),
    // 状态写明原因（等我等什么、系统暂停为什么）：状态层的 taskStatusText
    statusLine: taskStatusText(task),
    // 长程任务是第 N/M 阶段（任务详情的状态行）；流程没有阶段，进度在进度条（progress）
    // 91 号票：按依赖图的阶段号（并行的算一个阶段）
    ...(!timed && taskKind(task) !== "workflow" && task.stages ? { stage: taskStageAt(task)! } : {}),
    // 转为项目的任务以"已完成 · 已转为项目"结束
    ...(task.endKind ? { endNote: TASK_END_KIND_LABEL[task.endKind] } : {}),
    // 定时触发的任务（76 号票）：运营中时状态写触发的（运营中、已暂停及原因）
    ...(trigger ? { trigger: triggerSummary(trigger) } : {}),
    ...(trigger && task.state === "operating" ? { statusLine: trigger.statusText } : {}),
    ...(progress ? { progress } : {}),
    // 274 号票：最近一次交上来的阶段系统查到的结果
    ...observedOf(task),
  };
}

/** 看板卡上"系统查到的结果"那一行（274 号票）：长程任务、有阶段交上来过的才有 */
function observedOf(task: Task): { observed?: TaskSummary["observed"] } {
  const observed = taskKind(task) === "long_running" ? taskObservedLine(task) : undefined;
  return observed ? { observed } : {};
}

/** 会话交给了官方 App、任务因此停着（292 号票）：状态那一行已经写明，卡上不再另标 */
export const remoteInStatus = (ts: TaskSummary) => ts.remote !== undefined && ts.status === "waiting_for_user" && ts.waitReason === "runtime_off";

export function statusText(ts: TaskSummary): string {
  // 292 号票：会话交给了官方 App 而停着的，写"在官方 App 里"（不写"运行时没启用"）
  if (remoteInStatus(ts)) return t("pages.tasks.status.waiting", { reason: ts.remote!.label });
  if (ts.statusLine) return ts.statusLine;
  if (ts.status === "waiting_for_user" && ts.waitReason) return t("pages.tasks.status.waiting", { reason: WAIT_REASON_LABEL[ts.waitReason] });
  if (ts.status === "awaiting_confirm") return t("pages.tasks.status.awaitingConfirm");
  if (ts.status === "done" && ts.endNote) return t("pages.tasks.status.done", { note: ts.endNote });
  return TASK_STATUS_LABEL[ts.status];
}
