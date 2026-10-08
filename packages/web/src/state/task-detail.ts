// 任务详情（纯函数，13 号票）：阶段抽屉里各阶段的样子、详情页上能对任务做的控制。
// - 阶段：执行中的状态、验收方式和结果来自任务（看板频道上的 task 事件，Task.stages.list），交付件、模式、授权、
//   时序规则、预算来自计划卡上的计划（确认的那份是勾掉、收窄之后的）；还没开始执行时按计划列出、都是未开始
//   （initialStages，和守护进程建阶段用的同一份）；一个阶段的授权和时序规则是它自己的加所属阶段组的（stagePolicies）；
//   预算用了多少 token（24 号票）来自看板频道上这个任务的用量合计（按调用时的阶段）；
//   计划换过版的（14 号票：计划变更确认、维护者自行调整计划）取看板频道上最新的 task_plan（现在生效的计划和授权说法），
//   去掉、收窄的授权不再显示，新加的阶段有交付件、预算和授权；
// - 停下的阶段带上为什么停（14 号票：阈值、做不了、超预算、计划变更）；
// - 控制：能做什么只看共享协议包的 availableTaskActions（"谁能改"表推出，守护进程按同一份再判一次），
//   这里只决定按钮怎么摆：由我验收的阶段各一对"验收通过 / 退回"，返工按阶段各一个。
import {
  type AcceptanceMethod,
  availableTaskActions,
  type GrantInfo,
  grantText,
  initialStages,
  OVER_BUDGET_ACTIONS,
  type PlanCardPayload,
  type PlanChangeCardPayload,
  type PlanToolkit,
  type StageState,
  type TaskPlanEventPayload,
  stagePolicies,
  type Task,
  type TaskAction,
  type TaskWaitReason,
  temporalRuleText,
} from "./protocol.ts";
import type { UiState } from "./ui-state.ts";
import { stageTokens } from "./usage.ts";

/** 阶段抽屉里的一个阶段 */
export interface StageView {
  stageId: string;
  title: string;
  /** 第几阶段（1 起） */
  n: number;
  state: StageState;
  waitReason?: TaskWaitReason;
  /** 为什么停下 */
  waitNote?: string;
  /** 宣布过几次完成 */
  attempts: number;
  dependsOn: string[];
  deliverables: string[];
  acceptance: Array<{ criterion: string; method: AcceptanceMethod; result?: { passed: boolean; note?: string } }>;
  mode: "steps" | "open";
  steps: string[];
  /** 这个阶段（加上所属阶段组）的授权项、时序规则，写成一句话 */
  grants: string[];
  rules: string[];
  /** 预算，和这个阶段已经用掉的 token（usedTokens，24 号票） */
  budget?: { tokens: number; toolCalls: number; usedTokens: number };
}

/**
 * 任务现在生效的计划和授权说法：换过版的取最新的 task_plan（14 号票），没换过的取计划卡（或确认过的计划变更卡）；还没收到时没有
 */
function effectivePlanOf(state: UiState, task: Task): Pick<PlanCardPayload | PlanChangeCardPayload | TaskPlanEventPayload, "plan" | "grantInfo"> | undefined {
  const revised = state.taskPlans[task.id];
  if (revised) return revised;
  const card = task.planCardId ? state.cards[task.planCardId]?.card : undefined;
  return card?.type === "plan" ? (card.payload as PlanCardPayload) : card?.type === "plan_change" ? (card.payload as PlanChangeCardPayload) : undefined;
}

/** 任务现在生效的计划里的工具包（任务详情的工具包区，27 号票）；计划还没收到时没有 */
export function taskToolkit(state: UiState, taskId: string): PlanToolkit | undefined {
  const task = state.tasks[taskId];
  return task ? effectivePlanOf(state, task)?.plan.toolkit : undefined;
}

/** 任务的各阶段：执行中的状态和验收结果，加上计划里写的 */
export function taskStages(state: UiState, taskId: string): StageView[] {
  const task = state.tasks[taskId];
  if (!task) return [];
  const effective = effectivePlanOf(state, task);
  const plan = effective?.plan;
  const grantInfo: Readonly<Record<string, GrantInfo>> = effective?.grantInfo ?? {};
  const list = task.stages?.list ?? (plan ? initialStages(plan) : []);
  const used = stageTokens(state, taskId);
  return list.map((s, i) => {
    const planned = plan?.stages.find((p) => p.stageId === s.stageId);
    const policies = plan ? stagePolicies(plan, s.stageId) : [];
    return {
      stageId: s.stageId,
      title: s.title,
      n: i + 1,
      state: s.state,
      ...(s.waitReason === undefined ? {} : { waitReason: s.waitReason }),
      ...(s.waitNote === undefined ? {} : { waitNote: s.waitNote }),
      attempts: s.attempts,
      dependsOn: [...s.dependsOn],
      deliverables: planned?.deliverables ?? [],
      acceptance: s.acceptance.map((a) => ({
        criterion: a.criterion,
        method: a.method,
        ...(a.result ? { result: { passed: a.result.passed, ...(a.result.note === undefined ? {} : { note: a.result.note }) } } : {}),
      })),
      mode: planned?.mode ?? "open",
      steps: planned?.steps ?? [],
      grants: policies.flatMap((p) => p.grants.map((g) => `${g.title}：${grantText(g, grantInfo[g.id])}`)),
      rules: policies.flatMap((p) => p.temporalRules.map((r) => `${r.title ?? r.id}：${temporalRuleText(r)}`)),
      ...(planned ? { budget: { tokens: planned.budget.tokens, toolCalls: planned.budget.toolCalls, usedTokens: used[s.stageId] ?? 0 } } : {}),
    };
  });
}

/** 详情页上的一个控制按钮：动作、按钮上的字；返工、验收、退回带上是哪个阶段 */
export interface TaskControl {
  action: TaskAction;
  label: string;
  stageId?: string;
}

/** 这个任务现在能做的控制（用户的） */
export function taskControls(task: Task): TaskControl[] {
  const can = new Set(availableTaskActions(task, "user"));
  const list = task.stages?.list ?? [];
  const out: TaskControl[] = [];
  if (can.has("accept_stage")) {
    for (const s of list.filter((x) => x.state === "waiting" && x.waitReason === "acceptance")) {
      out.push({ action: "accept_stage", label: `第 ${list.indexOf(s) + 1} 阶段验收通过`, stageId: s.stageId }, { action: "return_stage", label: "退回", stageId: s.stageId });
    }
  }
  if (can.has("pause")) out.push({ action: "pause", label: "暂停" });
  // 超预算的"继续"就是追加预算继续（这个阶段重新给一整份预算，14 号票）
  if (can.has("resume")) out.push({ action: "resume", label: task.state === "paused" ? "继续" : task.waitReason === "over_budget" ? OVER_BUDGET_ACTIONS.resume : "继续执行" });
  if (can.has("retry")) out.push({ action: "retry", label: "重试" });
  if (can.has("rework")) for (const s of list) out.push({ action: "rework", label: `返工第 ${list.indexOf(s) + 1} 阶段`, stageId: s.stageId });
  if (can.has("cancel")) out.push({ action: "cancel", label: "取消任务" });
  return out;
}

/** 维护者会话还收不收用户的话（已完成、已取消、已归档的不再收，要返工用"返工"） */
export function taskAcceptsMessages(task: Task): boolean {
  return availableTaskActions(task, "user").includes("message");
}
