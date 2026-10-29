// 任务详情（纯函数，13 号票）：阶段抽屉里各阶段的样子、详情页上能对任务做的控制。
// - 阶段：执行中的状态、验收方式和结果来自任务（看板频道上的 task 事件，Task.stages.list），交付件、模式、授权、
//   时序规则、预算来自计划卡上的计划（确认的那份是勾掉、收窄之后的）；还没开始执行时按计划列出、都是未开始
//   （initialStages，和守护进程建阶段用的同一份）；一个阶段的授权和时序规则是它自己的加所属阶段组的（stagePolicies）；
//   预算用了多少 token（24 号票）来自看板频道上这个任务的用量合计（按调用时的阶段）；
//   计划换过版的（14 号票：计划变更确认、维护者自行调整计划）取看板频道上最新的 task_plan（现在生效的计划和授权说法），
//   去掉、收窄的授权不再显示，新加的阶段有交付件、预算和授权；
// - 停下的阶段带上为什么停（14 号票：阈值、做不了、超预算、计划变更）；
// - 控制：90 号票起任务详情的按钮收进状态签浮层和"⋯"，菜单项在 task-menu.ts（taskActionItems）；这里留着从某个阶段重做
//   （84 号票：canReopenStage，开始过的阶段就能）和还收不收话；
// - 阶段详情要的（84 号票）：要你留意的"权""外""问"（stageMarks：
//   算授权的授权项按守护进程给的 GrantInfo.outward 分本机、对外；"问"是计划的停点里落在这个阶段上的（协议包的 stageStops）；
//   "敏"要计划里写会用到的敏感数据，在 85 号票），选这种执行方式的理由和初步思路、开始过没有（协议包的 stageStarted）、
//   这一阶段的时序规则原文（点进规则详情）。
import {
  type AcceptanceMethod,
  availableTaskActions,
  type GrantInfo,
  grantAuthorizes,
  grantText,
  planStageCodes,
  stageStarted,
  stageStops,
  initialStages,
  type PlanCardPayload,
  type PlanChangeCardPayload,
  type PlanGrant,
  type PlanTemporalRule,
  type PlanToolkit,
  type StageState,
  type TaskPlanEventPayload,
  stagePolicies,
  t,
  type Task,
  type TaskWaitReason,
  temporalRuleText,
  type StageEdit,
  type StageObservedCounts,
  type VerifiedUserWords,
} from "./protocol.ts";
import type { UiState } from "./ui-state.ts";
import { stageTokens } from "./usage.ts";

/** 阶段抽屉里的一个阶段 */
export interface StageView {
  stageId: string;
  title: string;
  /** 第几阶段（1 起） */
  n: number;
  /** 计划里存的编号（93 号票，"1a"）；之前的计划没有，读的地方按依赖图现算 */
  code?: string;
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
  /** 选这种模式的理由、开放阶段的初步思路（84 号票：计划里写了才有） */
  modeReason?: string;
  roughIdea?: string;
  /** 开始过（"从这里重做"只对开始过的阶段，84 号票） */
  started: boolean;
  /** 要你留意的：本机的授权、对外的动作、会停下来问你的（84 号票） */
  marks: StageMarks;
  /** 这一阶段（加上所属阶段组）的时序规则原文：点一条看它的详情（84 号票） */
  ruleDocs: PlanTemporalRule[];
  /** 最近一次宣布完成时评审输入里运行时核实过的用户原话（125 号票：维护者引用、守护进程核实的；重开后清掉） */
  userWords?: VerifiedUserWords[];
  /** 维护者最近一次宣布完成时写的那一两句（274 号票：阶段详情"系统查到的结果"里和系统查到的摆在一起；重开后清掉） */
  summary?: string;
  /** 最近一次宣布完成时系统从效果日志里汇总的个数（274 号票：阶段框上那一行；重开后清掉） */
  observed?: StageObservedCounts;
}

/** 要你留意的一样里的一条：说法；授权项的还有它的 id 和次数上限（详情里写"已用 N/M"） */
export interface StageMarkItem {
  readonly text: string;
  readonly grantId?: string;
  readonly limit?: number;
}

/**
 * 一个阶段要你留意的几样（"敏"在 85 号票）：
 * - perm 敏感权限（84 号票叫本机授权，93 号票统一叫敏感权限）：算授权的授权项里不对外的（动你电脑里的东西）；只读的授权也算在这里（85 号票再分出去）；
 * - out 对外动作：算授权的授权项里对外的（守护进程给的 GrantInfo.outward，84 号票之前算的授权说法没有它，都算本机）；
 * - ask 会问你：计划的停点里落在这个阶段上的（stageStops：由你验收、落在"先问我""交给我做"类别里的授权、收窄了的）
 */
export interface StageMarks {
  readonly perm: readonly StageMarkItem[];
  readonly out: readonly StageMarkItem[];
  readonly ask: readonly StageMarkItem[];
}

/** 生效的计划（计划卡、确认过的计划变更卡、换过版的 task_plan）：算停点要它的授权说法和收窄过的授权项 */
type EffectivePlan = Pick<PlanCardPayload, "plan" | "grantInfo"> & { narrowedGrants?: readonly string[] | undefined };

/** 一个阶段要你留意的几样（grants 是它和所属阶段组的授权项） */
export function stageMarks(effective: EffectivePlan, stageId: string, grants: readonly PlanGrant[]): StageMarks {
  const { grantInfo } = effective;
  const granted = grants.filter((g) => grantAuthorizes(grantInfo[g.id]));
  const item = (g: PlanGrant): StageMarkItem => ({ text: t("state.taskDetail.grantLine", { title: g.title, text: grantText(g, grantInfo[g.id]) }), grantId: g.id, ...(g.maxUses === undefined ? {} : { limit: g.maxUses }) });
  const outward = (g: PlanGrant) => grantInfo[g.id]?.outward === true;
  return {
    perm: granted.filter((g) => !outward(g)).map(item),
    out: granted.filter(outward).map(item),
    // 91 号票：第几阶段按依赖图的编号写（并行的 4a、4b）
    ask: stageStops(effective, stageId, planStageCodes(effective.plan)).map((s) => ({ text: s.text })),
  };
}

/**
 * 任务现在生效的计划和授权说法：换过版的取最新的 task_plan（14 号票），没换过的取计划卡（或确认过的计划变更卡）；还没收到时没有
 * （91 号票：依赖图画计划变更等你确认时，拿它和变更后的那份比，标出新加、改过、去掉的阶段）
 */
export function effectivePlanOf(state: UiState, task: Task): (Pick<PlanCardPayload | PlanChangeCardPayload | TaskPlanEventPayload, "plan" | "grantInfo"> & { narrowedGrants?: readonly string[] | undefined }) | undefined {
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
      ...((s.code ?? planned?.code) === undefined ? {} : { code: (s.code ?? planned?.code)! }),
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
      grants: policies.flatMap((p) => p.grants.map((g) => t("state.taskDetail.grantLine", { title: g.title, text: grantText(g, grantInfo[g.id]) }))),
      rules: policies.flatMap((p) => p.temporalRules.map((r) => t("state.taskDetail.ruleLine", { title: r.title ?? r.id, text: temporalRuleText(r) }))),
      ...(planned ? { budget: { tokens: planned.budget.tokens, toolCalls: planned.budget.toolCalls, usedTokens: used[s.stageId] ?? 0 } } : {}),
      ...(planned?.modeReason ? { modeReason: planned.modeReason } : {}),
      ...(planned?.roughIdea ? { roughIdea: planned.roughIdea } : {}),
      started: stageStarted(s),
      marks: effective ? stageMarks(effective, s.stageId, policies.flatMap((p) => p.grants)) : { perm: [], out: [], ask: [] },
      ruleDocs: policies.flatMap((p) => p.temporalRules),
      ...(s.userWords && s.userWords.length > 0 ? { userWords: s.userWords } : {}),
      // 274 号票：维护者最近一次宣布完成时写的那一两句（自报）、那时系统从效果日志里汇总的个数
      ...(s.summary ? { summary: s.summary } : {}),
      ...(s.observed ? { observed: s.observed } : {}),
    };
  });
}

/** 对任务做一件事时附带的：哪个阶段、你写的说明，从这里重做时直接改的这一阶段（125 号票，只给 rework） */
export interface TaskActOptions {
  stageId?: string;
  note?: string;
  stageEdit?: StageEdit;
}

/**
 * 现在能从这个阶段重做吗（84 号票，用户 2026-10-11 定：阶段开始过就能重开）："谁能改"表里现在能返工
 * （建好了阶段的长程任务，执行中、等我、暂停、排队、失败、已完成都行），而且这个阶段开始过
 */
export function canReopenStage(task: Task, stageId: string): boolean {
  const stage = task.stages?.list?.find((s) => s.stageId === stageId);
  return stage !== undefined && stageStarted(stage) && availableTaskActions(task, "user").includes("rework");
}

/** 维护者会话还收不收用户的话（已完成、已取消、已归档的不再收，要返工用"返工"） */
export function taskAcceptsMessages(task: Task): boolean {
  return availableTaskActions(task, "user").includes("message");
}
