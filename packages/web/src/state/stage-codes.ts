// 一个长程任务各阶段的编号（91 号票：界面上写"第 N 阶段"的地方——阶段详情、待办和聊天里的进度卡、时间线、工单、任务详情的按钮——
// 都按依赖图的编号写，并行的写 4a、4b，和左边的计划图一致；编号的算法在协议包 plan.ts 的 stageCodes）。
// 单独一个小模块（只靠协议包和状态的形状），时间线、工单这些底层的状态模块也能用，不绕回依赖图那一层。
import { type PlanCardPayload, type PlanChangeCardPayload, planStageCodes, stageCodes, stageNumbers, type Task } from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

/**
 * 这个任务各阶段的编号：执行中按看板上的阶段列表（计划调整过的就是调整后的）；还没开始执行的按换过版的计划、计划卡；都没有是空的
 */
export function taskStageCodes(state: UiState, taskId: string): Map<string, string> {
  const task = state.tasks[taskId];
  const list = task?.stages?.list;
  if (list) return stageCodes(list.map((s) => ({ id: s.stageId, after: s.dependsOn })));
  const revised = state.taskPlans[taskId]?.plan;
  if (revised) return planStageCodes(revised);
  const card = task?.planCardId ? state.cards[task.planCardId]?.card : undefined;
  if (card?.type === "plan" || card?.type === "plan_change") return planStageCodes((card.payload as PlanCardPayload | PlanChangeCardPayload).plan);
  return new Map();
}

/** "第 4a 阶段"：这个任务里认得这个阶段就按编号写，认不出（任务没收到、阶段已经去掉）用给的后备（不给就写"阶段 s9"） */
export function stageLabelIn(state: UiState, taskId: string | undefined, stageId: string, fallback?: string): string {
  const code = taskId === undefined ? undefined : taskStageCodes(state, taskId).get(stageId);
  return code !== undefined ? `第 ${code} 阶段` : (fallback ?? `阶段 ${stageId}`);
}

/**
 * 任务详情状态行的"第 N/M 阶段"（91 号票）：维护者正在做的那一阶段的阶段号 / 一共几个阶段号，都按依赖图（并行的算一个，看板上的
 * current、total 是计划里的第几个、共几个）；还没开始执行（没有阶段列表）的照看板上的。不是长程任务、没有阶段的没有
 */
export function taskStageAt(task: Pick<Task, "stages">): { current: number; total: number } | undefined {
  const stages = task.stages;
  if (!stages) return undefined;
  const list = stages.list;
  if (!list?.length) return { current: stages.current ?? 0, total: stages.total };
  const no = stageNumbers(list.map((s) => ({ id: s.stageId, after: s.dependsOn })));
  const at = list.find((s) => s.stageId === stages.focus) ?? (stages.current === undefined ? undefined : list[stages.current - 1]);
  return { current: at ? no.get(at.stageId)! : 0, total: Math.max(...no.values()) };
}
