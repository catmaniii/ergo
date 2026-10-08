// 项目列表和项目页的视图（纯函数，15 号票）：项目列表频道上的项目，带上进行中的任务数（看板频道上未结束、涉及它的任务，
// 按项目编号认：同名的项目删掉之后再立，旧任务不算到新项目头上）、
// 维护者的活动状态，以及项目页上现在能做的动作（按协议包的 projectActions：守护进程按同一份校验）。
// 16 号票：项目还有正在做或排队的工单时不能归档（放弃、归档的按钮不能点，写明先完成或取消哪几个任务）；
// 重置维护者是单独的入口（不在项目状态动作里），已归档的不能。
import {
  archiveBlockedText,
  canResetMaintainer,
  type Project,
  type ProjectAction,
  projectActions,
  type ProjectState,
  type TaskState,
  UNFINISHED_TASK_STATES,
} from "./protocol.ts";
import { type AgentActivity, agentActivity, type UiState } from "./ui-state.ts";

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

/** "发起任务"时能选的项目：没归档的（守护进程同样核对） */
export function selectableProjectNames(state: UiState): string[] {
  return projectViews(state)
    .filter((v) => v.project.state !== "archived")
    .map((v) => v.project.name);
}
