// 项目在用时运营方案里的一条只能暂停、恢复（141 号票，纯函数）：规则是协议包的 operationsItemLock（守护进程按同一份拒绝用户的取消、
// 归档），这里按状态层里的项目取出来——任务的菜单（task-menu.ts 的 operationsLock）、看板卡和项目页作业行上的按钮
// （scheduled-jobs.ts）、项目页内部任务一栏的"归档"都看它。
import { operationsItemLock, type Task } from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

/** 只能暂停、恢复时：属于哪个项目（菜单里那行说明点了进它的维护者会话）、那行说明 */
export interface OperationsLock {
  projectId: string;
  note: string;
}

/** 这个任务是不是项目现在生效的运营方案里的一条、项目没归档（只能暂停、恢复）；不是的是 undefined */
export function taskOperationsLock(state: Pick<UiState, "projects">, task: Pick<Task, "id" | "internal"> | undefined): OperationsLock | undefined {
  if (!task?.internal) return undefined;
  const note = operationsItemLock(task, state.projects[task.internal.projectId]);
  return note === undefined ? undefined : { projectId: task.internal.projectId, note };
}
