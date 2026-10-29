// 流程的一轮收尾和步骤推断（59 号票，纯函数）：
// - 收尾前看一眼计划，还有步骤既没做也没说跳过，就提醒维护者一次（补上，或用 report_step 说明跳过），
//   不去打扰用户；每轮只提醒一次，避免来回拉扯；这一轮没做任何事（纯问答）不提醒；
// - 推断步骤的状态：开始一个新步骤时，别的还报着"在做"的算做完；一轮做完时，还报着"在做"的、
//   执行过却没报的算做完（都标上 inferred）。推断从严（评审意见，用户 2026-10-09 定）：推断成做完的只有真执行过的步骤
//   ——有对上这一步、执行成功的调用（plan_call_committed）；报着"在做"却没执行过的照旧是"在做"（被拒、出错、被引回的调用
//   都不算执行过），要么接着做，要么维护者自己用 report_step 报做完或跳过。
// 执行控制器（execution.ts）在维护者一轮结束时用它们：二狗的流程以步骤都做完或说明跳过为完成，推断出来的也算。
// 153 号票：维护者报某一步开始了（report_step in_progress）时在它的会话频道上记一条步骤开始的记号（stepStartEvent），
// 含这次调用的那条回复之前是"撤回到步骤「…」开始前"。
import { randomUUID } from "node:crypto";
import { type ConversationId, EVENT_TYPES, type StageStartEventPayload, t, type TaskStep, WORKFLOW_STAGE_ID, type WorkflowPlan } from "@ergo/protocol";
import type { InFlightHostCall } from "../agent-manager/host-tools.ts";
import type { NewEvent } from "../events/event-store.ts";
import { NUDGE_PREFIX, type PlanCorrection, type PlanExecutedCall, type PlanFinding } from "../guard/index.ts";
import { WORKFLOW_TOOL } from "./tool-names.ts";

/**
 * 步骤开始的记号（stage_start 带 stepId）：维护者（agentId）正在调用的 report_step 就是 via（after: false：回到含这次调用的那条回复之前）。
 * 不在它的这次调用里的（不该有）不记。taskId：这个流程（定时、事件触发的流程每次运行里的也记在流程名下）
 */
export function stepStartEvent(
  conversation: ConversationId,
  taskId: string,
  agentId: string,
  step: Pick<TaskStep, "stepId" | "title">,
  call: InFlightHostCall | undefined,
  time: string,
): NewEvent | undefined {
  if (call?.agentId !== agentId || call.toolName !== WORKFLOW_TOOL.reportStep) return undefined;
  const payload: StageStartEventPayload = {
    id: `ss-${randomUUID()}`,
    conversation,
    taskId,
    stageId: WORKFLOW_STAGE_ID,
    stepId: step.stepId,
    title: step.title,
    via: { call: call.toolCallId, tool: call.toolName, after: false },
    time,
  };
  return { channel: conversation, type: EVENT_TYPES.stageStart, payload };
}

/** 真执行过的步骤：有对上它、执行成功的调用（plan_call_committed 里记的那一步） */
export function executedSteps(history: readonly PlanExecutedCall[]): Set<string> {
  return new Set(history.map((c) => c.step).filter((s): s is string => s !== null));
}

/** 维护者报某一步开始了：别的还报着"在做"、真执行过（executed：有对上它、执行成功的调用）的步骤算做完（推断） */
export function stepsOnStart(list: readonly TaskStep[], stepId: string, executed: ReadonlySet<string>): TaskStep[] {
  return list.map((s) => (s.stepId !== stepId && s.state === "in_progress" && executed.has(s.stepId) ? { ...s, state: "done", inferred: true } : s));
}

/** 一轮做完了：还报着"在做"的、没报的，真执行过的算做完（推断）；没执行过的不动 */
export function stepsAtFinish(list: readonly TaskStep[], executed: ReadonlySet<string>): TaskStep[] {
  return list.map((s) => ((s.state === "in_progress" || s.state === "pending") && executed.has(s.stepId) ? { ...s, state: "done", inferred: true } : s));
}

/** 收尾提醒：交给维护者的话，和时间线上记的那笔纠偏 */
export function nudgeOf(plan: Pick<WorkflowPlan, "steps">, pending: readonly PlanFinding[]): { text: string; correction: PlanCorrection } {
  const ids = pending.map((f) => f.step).filter((x): x is string => x !== undefined);
  const titleOf = (id: string) => {
    const s = plan.steps.find((x) => x.id === id);
    return s?.title ?? s?.tool ?? "";
  };
  const titles = ids.map((id) => `${id}「${titleOf(id)}」`); // @i18n-ignore model
  // 时间线上那笔按当时的语言写
  const shown = ids.map((id) => t("tasks.workflowPlan.stepRef", { id, title: titleOf(id) })).join(t("protocol.common.listSep"));
  return {
    // @i18n-ignore-next model：交给维护者
    text: `${NUDGE_PREFIX}已授权的计划里还有 ${titles.join("、")} 既没有执行，也没有报告跳过。请继续按计划执行；如果确实不需要做，用 ${WORKFLOW_TOOL.reportStep} 标记 skipped，并在 gist 里说明原因。`,
    correction: { kind: "nudge", findings: [...pending], pending: ids, text: t("tasks.workflowRun.nudged", { steps: shown }) },
  };
}
