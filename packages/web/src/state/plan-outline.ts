// 聊天里计划卡的阶段提纲（93 号票，照搬 AgentSense bedf5a5 web/src/ui/milestone.tsx 的 PlanOutline、MarkLegend、MilestonePlanCard 里
// 算 status / changed / was / removed 的那几行）：计划卡、计划变更卡一直列着各阶段，按阶段号分组——这一阶段只有一个的写在"第 N 阶段"
// 那一行，几个并行的写"可并行 · N 个"、下面逐个列出；每一项是标题、新 / 改的小签、要你留意的小标记（权、外、问）、不是没开始的写状态、
// 计划变更去掉的划掉写"已去掉"。点一项就地展开它的要点（ui/cards/PlanOutline.tsx），左边图上那一阶段高亮。
// 纯函数：写什么由这里算，样子在 ui/cards/PlanOutline.tsx。
import { type Card, type Plan, type PlanCardPayload, type PlanChangeCardPayload, planStageCodes, stageNumbers, stagePolicies } from "./protocol.ts";
import { changedStages, changeStageGraph, type GraphLook, graphLook, type GraphNodeState, type StageGraph, stageGraphNodes, stageJson } from "./stage-graph.ts";
import { type StageMarks, stageMarks } from "./task-detail.ts";
import type { UiState } from "./ui-state.ts";

/** 提纲里的一项：一个阶段 */
export interface OutlineItem {
  readonly id: string;
  readonly title: string;
  /** 编号（"1a"，计划里存的；展开的要点头上写） */
  readonly code: string;
  /** 计划变更里新加的、改过的 */
  readonly mark?: "新" | "改" | undefined;
  /** 计划变更去掉的：划掉、点不开 */
  readonly gone: boolean;
  /** 要你留意的几样（去掉的没有） */
  readonly marks?: StageMarks | undefined;
  /** 现在的状态（这份计划在执行时才有；没开始的不写） */
  readonly look?: GraphLook | undefined;
}

/** 提纲里的一个阶段号：一项或几项并行的 */
export interface OutlineStage {
  /** 第几阶段 */
  readonly no: number;
  readonly items: readonly OutlineItem[];
  /** 还在计划里的几个（"可并行 · N 个"，只有一个时不写） */
  readonly live: number;
}

/** 图例（AgentSense MarkLegend）：这份计划里出现了的那几样，"权""外"后面写是哪几种动作（工具的中文名） */
export interface OutlineLegend {
  readonly perm: readonly string[] | undefined;
  readonly out: readonly string[] | undefined;
  readonly ask: boolean;
}

export interface PlanOutlineView {
  readonly stages: readonly OutlineStage[];
  readonly legend: OutlineLegend;
}

/** 这个任务的某一版计划（计划卡、计划变更卡、看板上推来的现在生效的那份里找） */
export function planOfId(state: UiState, taskId: string, planId: string): Plan | undefined {
  const revised = state.taskPlans[taskId];
  if (revised?.planId === planId) return revised.plan;
  for (const { card } of Object.values(state.cards)) {
    if (card.type !== "plan" && card.type !== "plan_change") continue;
    const p = card.payload as PlanCardPayload | PlanChangeCardPayload;
    if (p.taskId === taskId && p.planId === planId) return p.plan;
  }
  return undefined;
}

/** 这个任务现在生效的那份计划的编号（换过版的取看板上推来的，没换过的取计划卡上的） */
function effectivePlanId(state: UiState, taskId: string): string | undefined {
  const revised = state.taskPlans[taskId];
  if (revised) return revised.planId;
  const cardId = state.tasks[taskId]?.planCardId;
  const card = cardId === undefined ? undefined : state.cards[cardId]?.card;
  return card?.type === "plan" || card?.type === "plan_change" ? (card.payload as PlanCardPayload | PlanChangeCardPayload).planId : undefined;
}

/** 提纲上的状态（93 号票，用户 2026-10-12 定）：做完的照 AgentSense 写"已验收"，别的照左边依赖图的说法（进行中、等你……） */
function outlineLook(st: GraphNodeState, waitReason: string | undefined): GraphLook {
  const look = graphLook(st, waitReason);
  return st === "accepted" ? { ...look, text: "已验收" } : look;
}

/**
 * 一张计划卡、计划变更卡的提纲（不是这两种卡的没有）。
 * - 状态（AgentSense：这份计划是现在生效的那份时带上执行状态；计划调整还没批的，已有阶段的状态沿用现在的）：计划卡是现在生效的
 *   那份、任务开始执行了才写；计划变更卡写看板上各阶段现在的状态；
 * - 计划变更卡：变更前那份（basePlanId）里没有的标"新"，改过的标"改"（改的是阶段组的授权、规则时组里的阶段都标，和依赖图一样），
 *   变更前有、变更后没有的也列上（已去掉），阶段号和还在的一起排
 */
export function planOutline(state: UiState, card: Card): PlanOutlineView | undefined {
  if (card.type !== "plan" && card.type !== "plan_change") return undefined;
  const payload = card.payload as PlanCardPayload | PlanChangeCardPayload;
  const plan = payload.plan;
  const list = state.tasks[payload.taskId]?.stages?.list;
  const change = card.type === "plan_change" ? (payload as PlanChangeCardPayload) : undefined;
  const live = change !== undefined || effectivePlanId(state, payload.taskId) === payload.planId;
  const status = new Map((live ? (list ?? []) : []).map((s) => [s.stageId, s]));
  const base = change ? planOfId(state, payload.taskId, change.basePlanId) : undefined;
  const touched = change ? changedStages(change) : new Set<string>();
  const had = new Set(base?.stages.map((s) => s.stageId) ?? []);
  const kept = new Set(plan.stages.map((s) => s.stageId));
  const removed = (base?.stages ?? []).filter((s) => !kept.has(s.stageId));
  const all = [
    ...plan.stages.map((s) => ({ id: s.stageId, after: s.dependsOn })),
    ...removed.map((s) => ({ id: s.stageId, after: s.dependsOn.filter((x) => kept.has(x)) })),
  ];
  const no = stageNumbers(all);
  const codes = new Map([...planStageCodes(plan), ...(base ? [...planStageCodes(base)].filter(([id]) => !kept.has(id)) : [])]);
  const items: (OutlineItem & { n: number })[] = [
    ...plan.stages.map((s) => {
      const now = status.get(s.stageId);
      const st = now?.state as GraphNodeState | undefined;
      const mark = change === undefined ? undefined : !had.has(s.stageId) ? "新" : touched.has(s.stageId) || (base && stageJson(base, s.stageId) !== stageJson(plan, s.stageId)) ? "改" : undefined;
      return {
        id: s.stageId,
        title: s.title,
        code: codes.get(s.stageId)!,
        mark,
        gone: false,
        marks: stageMarks(payload, s.stageId, stagePolicies(plan, s.stageId).flatMap((p) => p.grants)),
        look: st && st !== "pending" ? outlineLook(st, now?.waitReason) : undefined,
        n: no.get(s.stageId)!,
      } satisfies OutlineItem & { n: number };
    }),
    ...removed.map((s) => ({ id: s.stageId, title: s.title, code: codes.get(s.stageId)!, gone: true, n: no.get(s.stageId)! })),
  ];
  const stages: OutlineStage[] = [];
  for (const n of [...new Set(items.map((x) => x.n))].toSorted((a, b) => a - b)) {
    const xs = items.filter((x) => x.n === n).map(({ n: _n, ...x }) => x);
    stages.push({ no: n, items: xs, live: xs.filter((x) => !x.gone).length });
  }
  return { stages, legend: outlineLegend(payload, items) };
}

/** 图例：出现了的那几样；"权""外"写是哪几种动作（这几项授权的工具的中文名，AgentSense kindsOf 写权限种类） */
function outlineLegend(payload: PlanCardPayload | PlanChangeCardPayload, items: readonly OutlineItem[]): OutlineLegend {
  const kinds = (key: "perm" | "out") => {
    const marks = items.flatMap((x) => x.marks?.[key] ?? []);
    if (!marks.length) return undefined;
    return [...new Set(marks.flatMap((m) => (m.grantId === undefined ? [] : (payload.grantInfo[m.grantId]?.toolTitle ?? []))))];
  };
  return { perm: kinds("perm"), out: kinds("out"), ask: items.some((x) => (x.marks?.ask.length ?? 0) > 0) };
}

/**
 * 计划详情里的小流程图（93 号票，AgentSense MilestonePlanDetail 的"流程（从上往下，一个阶段一行；同一行的可以同时做）"：
 * planNodes(plan, live, { changed, removed, focus })）：计划变更卡画变更后的那份（新加的标"新"、改过的标"改"、去掉的也画上，
 * 状态照执行中的，和左栏一样）；计划卡画卡上的那份，这份计划在执行时带上状态（还没确认的都是没开始，标出要你留意的）
 */
export function planDetailGraph(state: UiState, card: Card): StageGraph | undefined {
  if (card.type !== "plan" && card.type !== "plan_change") return undefined;
  const payload = card.payload as PlanCardPayload | PlanChangeCardPayload;
  const task = state.tasks[payload.taskId];
  const list = task?.stages?.list ?? [];
  if (card.type === "plan_change") {
    const change = payload as PlanChangeCardPayload;
    return changeStageGraph({ cardId: card.id, payload: change }, planOfId(state, payload.taskId, change.basePlanId), new Map(list.map((s) => [s.stageId, s])), task?.stages?.focus);
  }
  const live = effectivePlanId(state, payload.taskId) === payload.planId;
  const status = new Map((live ? list : []).map((s) => [s.stageId, s]));
  const nodes = payload.plan.stages.map((s) => ({
    id: s.stageId,
    title: s.title,
    after: s.dependsOn,
    code: s.code,
    state: (status.get(s.stageId)?.state ?? "pending") as GraphNodeState,
    waitReason: status.get(s.stageId)?.waitReason,
    marks: stageMarks(payload, s.stageId, stagePolicies(payload.plan, s.stageId).flatMap((p) => p.grants)),
  }));
  // 确认过、在执行的画成带状态的样子（和计划变更一样），还没确认的是计划卡的样子
  return { kind: live && list.length > 0 ? "change" : "plan", cardId: card.id, nodes: stageGraphNodes(nodes), current: live ? task?.stages?.focus : undefined };
}
