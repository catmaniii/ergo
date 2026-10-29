// 218 号票：一次建库的统计——推理每一步的模型调用（调用、截断、解析不了、救回、恢复、放弃，llm/robust.ts）、
// 往上抽门槛的判法结果（没过的按哪一条没过计数），加上当前库的样子（结论数、组数、各层几条、策略几条）。
// reflect 的报告带一份（ReflectReport.stats），评测建库时把抽事实、整理（扰动的库再整理一次）的合起来记进 EngineStat。
import { CLAIM_TIERS, type ClaimTier } from "../domain/types.ts";
import type { MemoryEngine } from "../engine.ts";
import { addStageStats, type StageCallStats, type StageName } from "../llm/robust.ts";
import type { LiftGateStats, ReasoningStats, ReflectStep, ReflectStepEvent } from "./types.ts";

export const emptyLiftGateStats = (): LiftGateStats => ({
  passed: 0,
  passedStrict: 0,
  passedLoose: 0,
  provisional: 0,
  provisionalByReason: {},
  failed: 0,
  byReason: {},
  failures: [],
  notAsked: {},
  rejected: {},
});
export const emptyReasoningStats = (): ReasoningStats => ({ steps: {}, lift: emptyLiftGateStats() });

const addCounts = (into: Record<string, number>, from: Readonly<Record<string, number | undefined>>) => {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + (n ?? 0);
};

/** 把 from 加进 into（建库时抽事实、整理、扰动以后再整理的合起来） */
export function addReasoningStats(into: ReasoningStats, from: ReasoningStats | undefined): ReasoningStats {
  if (!from) return into;
  addStageStats(into.steps, from.steps);
  into.lift.passed += from.lift.passed;
  into.lift.passedStrict += from.lift.passedStrict;
  into.lift.passedLoose += from.lift.passedLoose;
  into.lift.provisional += from.lift.provisional;
  addCounts(into.lift.provisionalByReason as Record<string, number>, from.lift.provisionalByReason);
  into.lift.failed += from.lift.failed;
  addCounts(into.lift.byReason as Record<string, number>, from.lift.byReason);
  into.lift.failures.push(...from.lift.failures);
  addCounts(into.lift.notAsked, from.lift.notAsked);
  addCounts(into.lift.rejected, from.lift.rejected);
  return into;
}

/** 当前库的样子 */
export interface StoreShape {
  /** 当前的结论（不算撤回、被取代的） */
  claims: number;
  /** 还成立的组 */
  groups: number;
  /** 当前的结论各层几条 */
  tiers: Record<ClaimTier, number>;
  /** 交互策略（不算撤回的） */
  strategies: number;
}

export function storeShape(engine: MemoryEngine): StoreShape {
  const current = engine.store.listClaims().filter((c) => c.status !== "retracted" && c.status !== "superseded");
  const tiers = Object.fromEntries(CLAIM_TIERS.map((t) => [t, current.filter((c) => c.tier === t).length])) as Record<ClaimTier, number>;
  return {
    claims: current.length,
    groups: engine.rg.registry.listGroups({ live: true }).length,
    tiers,
    strategies: engine.store.listStrategies({ status: ["proposed", "active", "paused"] }).length,
  };
}

const STEP_ORDER: readonly StageName[] = ["extract", "propose", "probes", "judge", "lift", "strategies"];

/** 237 号票：整理每一步的说法（建库进度、卡住时看停在哪一步） */
export const REFLECT_STEP_LABELS: Readonly<Record<ReflectStep, string>> = {
  extract: "抽事实",
  propose: "出假设",
  probes: "出追问",
  judge: "判证据",
  replies: "判顺口问的回答",
  joint: "对比模式和矛盾根源",
  lift: "往上抽",
  writeback: "写回知识图谱",
  questions: "出问题",
  review: "对抗复核",
  prediction: "预测账本",
  strategies: "编策略",
};

/** 237 号票：一步的开始、结束写成一行进度（前面带时间戳由调用方加） */
export function formatStepEvent(event: ReflectStepEvent): string {
  return `${REFLECT_STEP_LABELS[event.step]}${event.phase === "start" ? "…" : " 做完"}${event.detail ? `：${event.detail}` : ""}`;
}

/** 一步的统计写成一小段：调用 n（截断 a、解析不了 b、空 c；救回 d 条、重试 e 次、恢复 f、放弃 g、没问 h） */
export function formatStep(s: StageCallStats): string {
  const extra = [
    s.truncated ? `截断 ${s.truncated}` : "",
    s.unparsed ? `解析不了 ${s.unparsed}` : "",
    s.empty ? `空 ${s.empty}` : "",
    s.salvaged ? `救回 ${s.salvaged} 条` : "",
    s.retries ? `重试 ${s.retries} 次` : "",
    s.recovered ? `恢复 ${s.recovered}` : "",
    s.lost ? `放弃 ${s.lost}` : "",
    s.unasked ? `没问 ${s.unasked}` : "",
    s.unchanged ? `没变化没再问 ${s.unchanged} 条` : "",
  ].filter(Boolean);
  return `${s.calls}${s.batches ? `（${s.batches} 批）` : ""}${extra.length > 0 ? `［${extra.join("、")}］` : ""}`;
}

/** 建库日志的一行：每一步的调用、往上抽门槛、当前库的样子 */
export function formatBuildStats(stats: ReasoningStats | undefined, shape: StoreShape | undefined): string {
  const parts: string[] = [];
  if (shape) parts.push(`当前 ${shape.claims} 条结论、${shape.groups} 组（状态 ${shape.tiers.state}、偏好 ${shape.tiers.preference}、需求 ${shape.tiers.need}、价值观 ${shape.tiers.value}；策略 ${shape.strategies}）`);
  if (stats) {
    const steps = STEP_ORDER.filter((s) => stats.steps[s]).map((s) => `${s} ${formatStep(stats.steps[s]!)}`);
    if (steps.length > 0) parts.push(`调用：${steps.join("；")}`);
    const l = stats.lift;
    if (l.passed + l.failed + l.provisional > 0) {
      const reasons = Object.entries(l.byReason).map(([k, n]) => `${k} ${n}`);
      const prelim = Object.entries(l.provisionalByReason).map(([k, n]) => `${k} ${n}`);
      parts.push(
        `往上抽的组过门槛 ${l.passed}、没过 ${l.failed}${reasons.length > 0 ? `（${reasons.join("、")}）` : ""}` +
          (l.provisional > 0 ? `、先出临时结论 ${l.provisional}${prelim.length > 0 ? `（${prelim.join("、")}）` : ""}` : ""),
      );
    }
  }
  return parts.join("；");
}
