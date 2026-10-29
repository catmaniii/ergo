// 给任务出建议（196 号票）：adviseTask(task, { at, context })，规则版用模板拼。按权威从高到低排（05 号调研 §5.4、§6.0）：
//   ① 这次明说的要求：原样回显，提醒"下面几条都不能推翻它"；
//   ② 硬约束：用户明说的禁忌（明说的"不喜欢、不吃"，原话里带过敏、忌口、绝对不……）；
//   ③ 明确的偏好：用户说的、确认过的偏好和近期状态；
//   ④ 相关的需求和价值观：推断的（带置信度）；猜测单列（330 号票 R5：可以参考、推荐，标明是猜测、把握多少，把握低的留余地）；
//   ⑤ 能用的策略：active 的直接用，proposed 的标"待你确认"。
// 下面几层和①冲突时（明说的要求里有和某条偏好、某条做法相反的说法）照①做，那一条标"这次以你说的为准"——动机只调整"怎么做"，
// 不推翻"做什么"。和②冲突时也照①做，但提醒一句、附一个确认的问题。拿不准时（相关的有还没分出来的竞争假设）附一个能区分的追问：
// 优先用那组现成的判别性追问，没有就问"更接近哪一种"。
import { validAt, toMs } from "../domain/time.ts";
import type { Claim, ClaimTier, Fact } from "../domain/types.ts";
import { canSupportUserClaims } from "../evidence/boundary.ts";
import { contextsCompatible } from "../kg/context.ts";
import type { ClaimIndex } from "./claim-index.ts";
import { cite, isArrangement } from "./concepts.ts";
import type { Domain } from "./domains.ts";
import type { ReasoningGraph } from "./reasoning-graph.ts";
import { basisGone, conflictIn, establishedAt, onGuessAt, strategyApplies, strategyTemplate, strategyText, type StrategyBook } from "./strategies.ts";
import type { UserModelEntry } from "./types.ts";
import { DEFAULT_PER_TIER, type RelevantEntry, type RelevantUncertain, type RelevantUserModel, type RelevantUserModelOptions } from "./value-retrieval.ts";

/** 原话里带这些说法的"不喜欢、不吃"算硬约束（禁忌） */
export const HARD_MARKERS = /过敏|不能吃|不能喝|不能碰|吃不了|忌口|绝对不|千万别|千万不要|一定不要|碰不得|禁忌/;

/** 明说的要求前面带这些是否定（"别排满"） */
const NEG_BEFORE = /(?:别|不要|不用|不想|不必|不|勿|没|甭)[^，。；,;]{0,2}$/;

export interface AdviseOptions extends RelevantUserModelOptions {
  /** 这次明说的要求（结构化给的）；不给就把任务按标点切开，每段一条 */
  requirements?: string[];
}

export interface AdviceItem {
  claimId: string;
  statement: string;
  tier: ClaimTier;
  label: UserModelEntry["label"];
  confidence: Claim["confidence"];
  evidenceIds: string[];
  /** 这次明说的要求里和它相反的那一段：照明说的做 */
  overriddenBy: string | null;
  /** 330 号票（R5）：是猜测（没验证）；④ 里"猜测"那一栏才有 */
  guess?: boolean;
}

export interface StrategyAdvice {
  strategyId: string;
  status: "active" | "proposed";
  /** active 直接用；proposed 待你确认 */
  use: "apply" | "confirm_first";
  when: string;
  actions: { text: string; overriddenBy: string | null }[];
  basisClaimIds: string[];
  text: string;
  /** 330 号票（R6）：建在猜测上 */
  onGuess: boolean;
  /** 330 号票（R6）：依据都不在了（照旧在用，等用户回答"还要不要"） */
  basisGone: boolean;
}

export interface TaskAdvice {
  task: string;
  at: string;
  context: string[];
  domains: Domain[];
  /** ① 这次明说的要求（原样） */
  explicit: { requirements: string[]; note: string };
  /** ② 硬约束 */
  hardConstraints: AdviceItem[];
  /** ③ 用户说的、确认过的偏好和近期状态 */
  preferences: AdviceItem[];
  /** ④ 推断的偏好、状态、需求、价值观 */
  motives: AdviceItem[];
  /** ④ 猜测（和已验证但证据还不够的）：330 号票 R5——可以参考、推荐，标明是猜测，把握低的留余地 */
  uncertain: AdviceItem[];
  /** ⑤ 能用的策略 */
  strategies: StrategyAdvice[];
  /** 拿不准时问一句（能区分的追问；和硬约束冲突时是确认） */
  question: { ask: string; probeId: string | null; about: string[] } | null;
  /** 按上面的顺序拼好的一段 */
  text: string;
  /** 调出来的用户模型（带来路；每层多取了一倍，上面各节再按每层 k 条截） */
  model: RelevantUserModel;
}

export const EXPLICIT_NOTE = "以这些为准：下面的禁忌、偏好、需求、价值观和策略都不能推翻它";

const TIER_LABEL: Record<ClaimTier, string> = { state: "近期状态", preference: "偏好", need: "需求", value: "价值观" };
const LABEL_TEXT: Record<UserModelEntry["label"], string> = { user_stated: "你说的", inferred: "推断的", user_confirmed: "你确认过" };

/** 把任务按标点切成几段要求 */
export function splitRequirements(task: string): string[] {
  return task
    .split(/[，,。；;！!？?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 明说的偏好对应的事实（明说的断言才有） */
function explicitFact(rg: ReasoningGraph, claimId: string): Fact | undefined {
  const factId = rg.registry.explicitFactOf(claimId);
  return factId ? rg.store.getFact(factId) : undefined;
}

const negativeFact = (f: Fact) => (f.predicate === "dislikes" && !f.negated) || (f.predicate === "prefers" && f.negated);

/** "被安排、被排满"一类的常见说法（宾语是这类时，要求里说到这些也算说到了它） */
const ARRANGEMENT_SAYINGS = ["排满", "排得满", "塞满", "安排满", "排一整天", "安排上"];

/** 事实宾语的名字和别名（"被安排"一类的加上常见说法） */
function objectNames(rg: ReasoningGraph, f: Fact): string[] {
  const e = f.object.type === "entity" ? rg.store.getEntity(f.object.id) : undefined;
  const names = f.object.type === "value" ? [f.object.value] : e ? [e.name, ...e.aliases] : [];
  if (names.some((n) => isArrangement(n))) names.push(...ARRANGEMENT_SAYINGS);
  return [...new Set(names.filter((n) => n.length >= 2))];
}

/** 一段要求说到这个名字时是正着说（要）还是反着说（别、不要）；没说到是 null */
function stance(clause: string, names: readonly string[]): "positive" | "negative" | null {
  for (const n of names.toSorted((a, b) => b.length - a.length)) {
    const i = clause.indexOf(n);
    if (i < 0) continue;
    return NEG_BEFORE.test(clause.slice(Math.max(0, i - 4), i)) ? "negative" : "positive";
  }
  return null;
}

/** 明说的偏好和这次的要求相反吗：不喜欢 X 而这次要 X，或者喜欢 X 而这次说别 X */
function opposingClause(rg: ReasoningGraph, claimId: string, requirements: readonly string[]): string | null {
  const f = explicitFact(rg, claimId);
  if (!f || (f.predicate !== "prefers" && f.predicate !== "dislikes")) return null;
  const names = objectNames(rg, f);
  for (const clause of requirements) {
    const s = stance(clause, names);
    if (s === null) continue;
    if ((negativeFact(f) && s === "positive") || (!negativeFact(f) && s === "negative")) return clause;
  }
  return null;
}

/** 硬约束：用户明说（或确认过）的禁忌，在 at 成立、场景对得上的 */
export function hardConstraintClaims(rg: ReasoningGraph, at: string, context: readonly string[]): Claim[] {
  const out: Claim[] = [];
  for (const claim of rg.store.listClaims({ status: "active" })) {
    if (claim.epistemic === "inferred" || !validAt(claim, at)) continue;
    if (claim.context.length > 0 && context.length > 0 && !contextsCompatible(claim.context, context)) continue;
    const f = explicitFact(rg, claim.id);
    if (!f || !negativeFact(f)) continue;
    const hard = f.evidenceIds.some((id) => {
      const e = rg.store.getEvidence(id);
      return e !== undefined && canSupportUserClaims(e) && HARD_MARKERS.test(e.text);
    });
    if (hard) out.push(claim);
  }
  return out;
}

const itemOf = (e: Pick<RelevantEntry, "claimId" | "statement" | "tier" | "label" | "confidence" | "evidenceIds">, overriddenBy: string | null = null): AdviceItem => ({
  claimId: e.claimId,
  statement: e.statement,
  tier: e.tier,
  label: e.label,
  confidence: e.confidence,
  evidenceIds: e.evidenceIds,
  overriddenBy,
});

export interface AdviseDeps {
  rg: ReasoningGraph;
  index: ClaimIndex;
  strategies: StrategyBook;
  relevant: (task: string, options: RelevantUserModelOptions) => Promise<RelevantUserModel>;
}

export async function adviseTask(deps: AdviseDeps, task: string, options: AdviseOptions = {}): Promise<TaskAdvice> {
  const { rg } = deps;
  const store = rg.store;
  const at = options.at ?? store.now();
  const requirements = options.requirements ?? splitRequirements(task);
  const k = options.k ?? DEFAULT_PER_TIER;
  // 多取一倍：硬约束单列以后，明确的偏好不会被它挤掉；每一节再按每层 k 条截
  const model = await deps.relevant(task, { ...options, at, k: k * 2 });
  const context = model.context;
  const perTier = (items: AdviceItem[]) => {
    const count = new Map<ClaimTier, number>();
    return items.filter((i) => {
      const n = count.get(i.tier) ?? 0;
      count.set(i.tier, n + 1);
      return n < k;
    });
  };
  const view = rg.view(at);

  // ⑤ 先编译策略（依据跟着走），挑出和任务对得上的
  deps.strategies.compile();
  const strategyAdvice: StrategyAdvice[] = [];
  const overriddenBasis = new Map<string, string>();
  const candidates = store
    .listStrategies({ status: ["active", "proposed"] })
    // 330 号票（R6）：点过头的照旧用（依据都不在了也不自动停，等用户回答"还要不要"）；没点头的提议要依据还能用
    .filter((s) => (s.status === "active" || s.basisClaimIds.some((id) => establishedAt(store.getClaim(id), at))) && strategyApplies(s, model.domains, task));
  for (const s of candidates.toSorted((a, b) => Number(b.status === "active") - Number(a.status === "active") || (a.id < b.id ? -1 : 1))) {
    const active = s.status === "active" && s.confirmedAt !== null && toMs(s.confirmedAt) <= toMs(at);
    const conflicts = strategyTemplate(s.template)?.conflicts(s) ?? [];
    const actions = s.actions.map((text, i) => ({ text, overriddenBy: requirements.find((clause) => conflictIn(clause, conflicts[i] ?? [])) ?? null }));
    for (const a of actions) if (a.overriddenBy) for (const id of s.basisClaimIds) if (!overriddenBasis.has(id)) overriddenBasis.set(id, a.overriddenBy);
    strategyAdvice.push({
      strategyId: s.id,
      status: active ? "active" : "proposed",
      use: active ? "apply" : "confirm_first",
      when: s.when,
      actions,
      basisClaimIds: s.basisClaimIds,
      text: strategyText(s),
      onGuess: onGuessAt(store, s, at),
      basisGone: basisGone(store, s),
    });
  }
  // 明说的要求推翻了一条做法，也就推翻了它依据的需求、价值，和推出它们的下层断言（"重视周末的自主安排"）
  const queue = [...overriddenBasis.keys()];
  for (let i = 0; i < queue.length && i < 200; i++) {
    const clause = overriddenBasis.get(queue[i]!)!;
    for (const inf of store.inferencesOf(queue[i]!)) {
      for (const premise of inf.premiseIds) {
        if (overriddenBasis.has(premise) || !store.getClaim(premise)) continue;
        overriddenBasis.set(premise, clause);
        queue.push(premise);
      }
    }
  }

  // ② 硬约束
  const hard = hardConstraintClaims(rg, at, context);
  const hardIds = new Set(hard.map((c) => c.id));
  const hardItems = hard.map((c) => {
    const evidenceIds = store.linksOf(c.id).flatMap((l) => (l.polarity === "supports" ? rg.evidenceOfTarget(l.target, view) : []));
    return itemOf({ claimId: c.id, statement: c.statement, tier: c.tier, label: c.epistemic === "explicit" ? "user_stated" : "user_confirmed", confidence: c.confidence, evidenceIds: [...new Set(evidenceIds)] }, opposingClause(rg, c.id, requirements));
  });

  // ③ 明确的偏好、④ 推断的和需求、价值观
  const preferences: AdviceItem[] = [];
  const motives: AdviceItem[] = [];
  for (const e of [...model.state, ...model.preferences]) {
    if (hardIds.has(e.claimId)) continue;
    if (e.label === "inferred") motives.push(itemOf(e, overriddenBasis.get(e.claimId) ?? null));
    else preferences.push(itemOf(e, opposingClause(rg, e.claimId, requirements) ?? overriddenBasis.get(e.claimId) ?? null));
  }
  for (const e of [...model.needs, ...model.values]) motives.push(itemOf(e, overriddenBasis.get(e.claimId) ?? null));
  const uncertainEntries = model.uncertain.filter((u, i) => model.uncertain.slice(0, i).filter((x) => x.tier === u.tier).length < k);
  const uncertain = uncertainEntries.map((u) => ({ ...itemOf(u), guess: u.status === "contested" }));

  const question = pickQuestion(rg, hardItems, uncertainEntries);
  const advice: TaskAdvice = {
    task,
    at,
    context,
    domains: model.domains,
    explicit: { requirements, note: EXPLICIT_NOTE },
    hardConstraints: hardItems,
    preferences: perTier(preferences),
    motives: perTier(motives),
    uncertain,
    strategies: strategyAdvice,
    question,
    text: "",
    model,
  };
  advice.text = renderAdvice(advice);
  return advice;
}

/** 拿不准时问一句：和硬约束冲突 → 确认；相关的有还没分出来的竞争假设 → 那组的判别性追问（没有就问更接近哪一种） */
function pickQuestion(rg: ReasoningGraph, hard: readonly AdviceItem[], uncertain: readonly RelevantUncertain[]): TaskAdvice["question"] {
  const clash = hard.find((h) => h.overriddenBy !== null);
  if (clash) return { ask: `你说过${clash.statement.replace(/^用户/, "")}，这次「${clash.overriddenBy}」，确定吗？`, probeId: null, about: [clash.claimId] };
  const contested = uncertain.find((u) => u.reason === "contested") ?? uncertain[0];
  if (!contested) return null;
  const member = rg.registry.memberOf(contested.claimId);
  const probes = (member ? rg.registry.probesOf(member.groupKey) : [])
    .map((p) => rg.store.getProbe(p.probeId))
    .filter((p) => p !== undefined && p.discriminates.includes(contested.claimId))
    .toSorted((a, b) => Number(a!.outcome === "found") - Number(b!.outcome === "found"));
  const probe = probes[0];
  if (probe) return { ask: probe.ask, probeId: probe.id, about: probe.discriminates };
  const rival = contested.competitors[0];
  if (rival) return { ask: `这次更接近「${contested.statement}」，还是「${rival.statement}」？`, probeId: null, about: [contested.claimId, rival.claimId] };
  return { ask: `「${contested.statement}」——这样理解对吗？`, probeId: null, about: [contested.claimId] };
}

const line = (i: AdviceItem, withConfidence: boolean) =>
  `${i.statement}（${TIER_LABEL[i.tier]}，${LABEL_TEXT[i.label]}${withConfidence ? `，置信度 ${i.confidence}` : ""}）${cite(i.evidenceIds)}${i.overriddenBy ? `——这次你说了「${i.overriddenBy}」，以你说的为准` : ""}`;

/** 按权威顺序拼成一段 */
export function renderAdvice(a: Pick<TaskAdvice, "explicit" | "hardConstraints" | "preferences" | "motives" | "uncertain" | "strategies" | "question">): string {
  const parts: string[] = [];
  parts.push(`① 你这次明说的要求：${a.explicit.requirements.map((r) => `「${r}」`).join("、")}。${a.explicit.note}。`);
  parts.push(
    a.hardConstraints.length > 0
      ? `② 硬约束（你明说过的禁忌）：${a.hardConstraints.map((h) => `${h.statement}${cite(h.evidenceIds)}${h.overriddenBy ? `——和这次的「${h.overriddenBy}」冲突，先确认` : ""}`).join("；")}。`
      : "② 硬约束：没有相关的。",
  );
  parts.push(a.preferences.length > 0 ? `③ 你明确说过的：${a.preferences.map((p) => line(p, false)).join("；")}。` : "③ 你明确说过的偏好：没有相关的。");
  const motive = a.motives.length > 0 ? `④ 相关的需求和价值观（推断的，仅作参考）：${a.motives.map((m) => line(m, true)).join("；")}。` : "④ 相关的需求和价值观：没有成立的。";
  const unsure =
    a.uncertain.length > 0
      ? `猜测（可以参考、推荐，说清是猜测，把握低的留余地）：${a.uncertain.map((u) => `${u.statement}（${TIER_LABEL[u.tier]}，${u.guess ? "猜测" : "已验证、证据还不够"}，把握 ${u.confidence}）`).join("；")}。`
      : "";
  parts.push(motive + unsure);
  if (a.strategies.length === 0) parts.push("⑤ 能用的策略：没有。");
  else {
    const render = (s: StrategyAdvice) => {
      const kept = s.actions.filter((x) => !x.overriddenBy).map((x) => x.text);
      const dropped = s.actions.filter((x) => x.overriddenBy).map((x) => `「${x.text}」这次不用（你明说了「${x.overriddenBy}」）`);
      const marks = [s.onGuess ? "建在猜测上" : "", s.basisGone ? "理由没了，等你说还要不要" : ""].filter((x) => x);
      return `${s.when}：${[...kept, ...dropped].join("；")}${marks.length > 0 ? `（${marks.join("；")}）` : ""}`;
    };
    const apply = a.strategies.filter((s) => s.use === "apply").map(render);
    const confirm = a.strategies.filter((s) => s.use === "confirm_first").map(render);
    parts.push(`⑤ 能用的策略：${[apply.length > 0 ? `直接用——${apply.join("；")}` : "", confirm.length > 0 ? `待你确认——${confirm.join("；")}` : ""].filter((x) => x).join("。")}。`);
  }
  if (a.question) parts.push(`想先问一句：${a.question.ask}`);
  return parts.join("\n");
}

