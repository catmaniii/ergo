// 任务详情（纯函数，13 号票）：阶段抽屉里各阶段的样子、详情页上能对任务做的控制。
// - 阶段：执行中的状态、验收方式和结果来自任务（看板频道上的 task 事件，Task.stages.list），交付件、模式、授权、
//   时序规则、预算来自计划卡上的计划（确认的那份是勾掉、收窄之后的）；还没开始执行时按计划列出、都是未开始
//   （initialStages，和守护进程建阶段用的同一份）；一个阶段的授权和时序规则是它自己的加所属阶段组的（stagePolicies）；
// - 控制：能做什么只看共享协议包的 availableTaskActions（"谁能改"表推出，守护进程按同一份再判一次），
//   这里只决定按钮怎么摆：由我验收的阶段各一对"验收通过 / 退回"，返工按阶段各一个。
import {
  type AcceptanceMethod,
  availableTaskActions,
  type GrantInfo,
  grantText,
  initialStages,
  type PlanCardPayload,
  type StageState,
  stagePolicies,
  type Task,
  type TaskAction,
  type TaskWaitReason,
  temporalRuleText,
} from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

/** 阶段抽屉里的一个阶段 */
export interface StageView {
  stageId: string;
  title: string;
  /** 第几阶段（1 起） */
  n: number;
  state: StageState;
  waitReason?: TaskWaitReason;
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
  budget?: { tokens: number; toolCalls: number };
}

/** 任务的计划卡负载（还没收到时没有） */
function planCardOf(state: UiState, task: Task): PlanCardPayload | undefined {
  const card = task.planCardId ? state.cards[task.planCardId]?.card : undefined;
  return card?.type === "plan" ? (card.payload as PlanCardPayload) : undefined;
}

/** 任务的各阶段：执行中的状态和验收结果，加上计划里写的 */
export function taskStages(state: UiState, taskId: string): StageView[] {
  const task = state.tasks[taskId];
  if (!task) return [];
  const card = planCardOf(state, task);
  const plan = card?.plan;
  const grantInfo: Readonly<Record<string, GrantInfo>> = card?.grantInfo ?? {};
  const list = task.stages?.list ?? (plan ? initialStages(plan) : []);
  return list.map((s, i) => {
    const planned = plan?.stages.find((p) => p.stageId === s.stageId);
    const policies = plan ? stagePolicies(plan, s.stageId) : [];
    return {
      stageId: s.stageId,
      title: s.title,
      n: i + 1,
      state: s.state,
      ...(s.waitReason === undefined ? {} : { waitReason: s.waitReason }),
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
      ...(planned ? { budget: { tokens: planned.budget.tokens, toolCalls: planned.budget.toolCalls } } : {}),
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
  if (can.has("resume")) out.push({ action: "resume", label: task.state === "paused" ? "继续" : "继续执行" });
  if (can.has("retry")) out.push({ action: "retry", label: "重试" });
  if (can.has("rework")) for (const s of list) out.push({ action: "rework", label: `返工第 ${list.indexOf(s) + 1} 阶段`, stageId: s.stageId });
  if (can.has("cancel")) out.push({ action: "cancel", label: "取消任务" });
  return out;
}

/** 维护者会话还收不收用户的话（已完成、已取消、已归档的不再收，要返工用"返工"） */
export function taskAcceptsMessages(task: Task): boolean {
  return availableTaskActions(task, "user").includes("message");
}
