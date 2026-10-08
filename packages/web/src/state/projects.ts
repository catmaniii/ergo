// 项目列表和项目页的视图（纯函数，15 号票）：项目列表频道上的项目，带上进行中的任务数（看板频道上未结束、涉及它的任务，
// 按项目编号认：同名的项目删掉之后再立，旧任务不算到新项目头上）、
// 维护者的活动状态，以及项目页上现在能做的动作（按协议包的 projectActions：守护进程按同一份校验）。
import {
  type ActivityState,
  type Project,
  type ProjectAction,
  projectActions,
  type ProjectState,
  type TaskState,
  UNFINISHED_TASK_STATES,
} from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

export interface ProjectView {
  project: Project;
  /** 进行中的任务数：涉及这个项目、还没结束的任务 */
  activeTasks: number;
  /** 维护者的活动状态（没收到过就是 undefined） */
  activity: ActivityState | undefined;
  /** 首个建设任务现在的状态 */
  buildTaskState: TaskState | undefined;
  /** 项目页上现在能做的动作 */
  actions: ProjectAction[];
}

/** 列表里的先后：使用中、建设中、筹备中、已停用、已归档 */
const STATE_ORDER: readonly ProjectState[] = ["in_use", "building", "preparing", "retired", "archived"];

/** 涉及这个项目（按编号）、还没结束的任务数 */
export function projectActiveTasks(state: UiState, projectId: string): number {
  return Object.values(state.tasks).filter((t) => UNFINISHED_TASK_STATES.includes(t.state) && (t.projectIds ?? []).includes(projectId)).length;
}

function viewOf(state: UiState, project: Project): ProjectView {
  const buildTaskState = project.buildTaskId === undefined ? undefined : state.tasks[project.buildTaskId]?.state;
  return {
    project,
    activeTasks: projectActiveTasks(state, project.id),
    activity: state.activity[project.maintainerId]?.state,
    buildTaskState,
    actions: projectActions(project, buildTaskState),
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
