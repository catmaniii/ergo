// 项目列表和项目页的视图（纯函数，15 号票）：项目列表频道上的项目，带上进行中的任务数（看板频道上未结束、涉及它的任务，
// 按项目编号认：同名的项目删掉之后再立，旧任务不算到新项目头上）、
// 维护者的活动状态，以及项目页上现在能做的动作（按协议包的 projectActions：守护进程按同一份校验）。
// 16 号票：项目还有正在做或排队的工单时不能归档（放弃、归档的按钮不能点，写明先完成或取消哪几个任务）；
// 重置维护者是单独的入口（不在项目状态动作里），已归档的不能。
// 64 号票：项目页的"内部任务"一栏（projectInternalTasks：项目内部任务不上全局看板，在这里列出状态和进度）。
import {
  archiveBlockedText,
  canResetMaintainer,
  type Project,
  type ProjectAction,
  projectActions,
  type ProjectState,
  availableTaskActions,
  isInternalTo,
  type Task,
  TASK_KIND_LABEL,
  taskKind,
  type TaskState,
  UNFINISHED_TASK_STATES,
} from "./protocol.ts";
import { taskStatusText } from "./board.ts";
import { type AgentActivity, agentActivity, type UiState } from "./ui-state.ts";
import { taskTokenTotal } from "./usage.ts";
import { type BoardProgress, taskBoardProgress } from "./workflow-view.ts";

export interface ProjectView {
  project: Project;
  /** 进行中的任务数：涉及这个项目、还没结束的任务 */
  activeTasks: number;
  /** 维护者的活动状态和说明（干活中在做什么、等你批准什么，25 号票；没收到过是休眠） */
  activity: AgentActivity;
  /** 首个建设任务现在的状态 */
  buildTaskState: TaskState | undefined;
  /** 项目页上现在能做的项目状态动作（开工、停用、归档……；重置维护者不在这里） */
  actions: ProjectAction[];
  /** 现在能不能重置维护者（16 号票：项目页上单独的入口；已归档的不能） */
  canResetMaintainer: boolean;
  /** 不能归档的原因（16 号票）：还有正在做或排队的工单时，写明先完成或取消哪几个任务；能归档时没有 */
  archiveBlocked: string | undefined;
}

/** 列表里的先后：使用中、建设中、筹备中、已停用、已归档 */
const STATE_ORDER: readonly ProjectState[] = ["in_use", "building", "preparing", "retired", "archived"];

/** 涉及这个项目（按编号）、还没结束的任务数 */
export function projectActiveTasks(state: UiState, projectId: string): number {
  return Object.values(state.tasks).filter((t) => UNFINISHED_TASK_STATES.includes(t.state) && (t.projectIds ?? []).includes(projectId)).length;
}

function viewOf(state: UiState, project: Project): ProjectView {
  const buildTaskState = project.buildTaskId === undefined ? undefined : state.tasks[project.buildTaskId]?.state;
  const open = Object.values(state.workOrders).filter((w) => w.projectId === project.id && w.state !== "ended");
  return {
    project,
    activeTasks: projectActiveTasks(state, project.id),
    activity: agentActivity(state, project.maintainerId),
    buildTaskState,
    actions: projectActions(project, buildTaskState),
    canResetMaintainer: canResetMaintainer(project),
    archiveBlocked: open.length > 0 ? archiveBlockedText(open) : undefined,
  };
}

/** 项目列表：按状态排，同一状态里先建的在前 */
export function projectViews(state: UiState): ProjectView[] {
  return Object.values(state.projects)
    .toSorted((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.createdAt.localeCompare(b.createdAt))
    .map((p) => viewOf(state, p));
}

/** 某个项目（删掉的、没收到过的是 undefined） */
export function selectProject(state: UiState, projectId: string): ProjectView | undefined {
  const project = state.projects[projectId];
  return project && viewOf(state, project);
}

/** 项目页"内部任务"一栏里的一个（64 号票） */
export interface InternalTaskView {
  task: Task;
  /** 流程、长程任务 */
  kindLabel: string;
  /** 状态写明原因（和看板、任务详情同一份 taskStatusText） */
  status: string;
  /** 进度：和看板卡同一份（taskBoardProgress：流程是做完的步数、长程任务是已验收的阶段数，计划授权之前是"尚无计划"） */
  progress: BoardProgress | undefined;
  /** 这个任务名下的 token 总量 */
  tokens: number;
  /** 能不能在项目页上归档（结束了的，用户手动归档：64 号票，和全局任务一样只有用户能归档） */
  archivable: boolean;
}

function internalTaskView(state: UiState, task: Task): InternalTaskView {
  return {
    task,
    kindLabel: TASK_KIND_LABEL[taskKind(task)],
    status: taskStatusText(task),
    progress: taskBoardProgress(state, task),
    tokens: taskTokenTotal(state, task.id),
    archivable: availableTaskActions(task, "user").includes("archive"),
  };
}

/** 项目页"内部任务"一栏的三组 */
export interface ProjectInternalTasks {
  /** 没结束的 */
  open: InternalTaskView[];
  /** 结束了、还没归档的（每个有"归档"） */
  ended: InternalTaskView[];
  /** 归档了的：收起来 */
  archived: InternalTaskView[];
}

/**
 * 项目页的"内部任务"一栏（64 号票）：这个项目的内部任务（由项目的维护者执行的，不上全局看板），没结束的、结束了的、
 * 归档了的三组，各自新近有变化的在前。项目删掉了（不在项目列表里）就没有
 */
export function projectInternalTasks(state: UiState, projectId: string): ProjectInternalTasks {
  if (!state.projects[projectId]) return { open: [], ended: [], archived: [] };
  const mine = Object.values(state.tasks)
    .filter((t) => isInternalTo(t, projectId))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((t) => internalTaskView(state, t));
  return {
    open: mine.filter((v) => UNFINISHED_TASK_STATES.includes(v.task.state)),
    ended: mine.filter((v) => !UNFINISHED_TASK_STATES.includes(v.task.state) && v.task.state !== "archived"),
    archived: mine.filter((v) => v.task.state === "archived"),
  };
}

/** "发起任务"时能选的项目：没归档的（守护进程同样核对） */
export function selectableProjectNames(state: UiState): string[] {
  return projectViews(state)
    .filter((v) => v.project.state !== "archived")
    .map((v) => v.project.name);
}

/**
 * 这个项目还在立项（立项书没确认，64 号票）：只涉及它的任务是它的内部任务，确认立项书之前不能发起（守护进程同样核对）。
 * "发起任务"时只选了它，对话框说明原因、不让发起
 */
export function stillChartering(state: UiState, name: string): boolean {
  return projectViews(state).some((v) => v.project.name === name && !v.project.charterConfirmed);
}
