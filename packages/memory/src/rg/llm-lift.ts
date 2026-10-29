// 模型版往上抽（201 号票）：LlmReasoner.lift 用的请求、解析、门槛和"已有的组照旧"。
//
// - 门槛由代码判，不交给模型判（照 195 的规则版，rg/lift.ts 的常数）：两种以上不同的场合、需求层两个以上月份（价值层三个）、
//   支持背后至少 3 条证据。判两次：
//   1. 问模型之前：这一层全部能往上抽的断言合起来都不够，就不问（省预算）；
//   2. 模型交回的每一组：按它自己挑的那几条下层断言再判一次，不够的丢掉（记进 dropped）。
//   主题不再限于规则版的三类，由模型归纳（哪几条说的是同一件事），所以没法在问之前按主题分好组，只能先判全体、再判每组。
// - 模型交回结构化的组：主题、下层断言 id、至少两条上位解释；每条写支持和反证的样子（expects）、关联（事实 id）、适用领域、
//   一个能把它和另一条区分开的追问。伪造的断言 id、事实 id、不认得的领域、不合格的字段写入前丢掉，记进 dropped（stage = lift）。
//   下层断言的支持事实对每条都是弱支持（观察）；决定性只给用户明说的事实，别的降成强。
// - 状态、置信度、传播走同一套（scoring.ts、reasoning-graph.ts），这里只交草稿。
// - 已有的组（上次模型建的）：下次整理不重复问模型——下层断言还够门槛就照存下来的样子原样交回（不然 reflect 会当它不成立而撤回），
//   不够了就不交，由 reflect 撤回留墓碑。只有还没被已有的组用上的下层断言出现时才再问模型。
// - 218 号票：输出上限按这一批的下层断言条数估（LIFT_OUTPUT_PER_PREMISE，2000 到 8000），不再写死 2000；还没被用上的下层断言
//   超过 LIFT_BATCH_PREMISES 条时分批（liftBatches）：每批的断言写全，别的断言只写一行摘要（可以一起归进组），前面几批出的组列成
//   "已经有的组"；截断、解析不了的照 llm/robust.ts 救回、对半切小重试。没过门槛的组写明是哪一条没过（场景、月份、证据条数），
//   计数进 reflect 的统计（ReflectReport.stats.lift）。门槛的数不改。
// - 221 号票：提示词明说每一组自己也要跨两种以上互相不重叠的场景（两边的标签谁也包含不了谁才算两种，标签互相包含的不算），
//   只落一种场景的几条不要归组、场景不够宁可少给组。
// - 223 号票：门槛的"两种场合"改成按维度看不同（rg/lift.ts 的 scenesDiffer：有一个双方都写了标签的维度上标签不同就算不同，
//   「家里、休闲」和「家里、工作」算两种），不再要求所有维度都不重叠；老严格判定只用来统计（LiftGateStats.passedStrict /
//   passedLoose），不卡门槛。门槛的数和提示词不改。
// - 229 号票：再收窄成只看"方面（domain）"维度（方面标签集合不同才算两种；只差日型、出行不算），老严格判定照旧只做统计。
import { addDays, localDate, toMs } from "../domain/time.ts";
import { CLAIM_TIERS, LINK_WEIGHTS, type Claim, type ClaimTier, type Fact, type LinkWeight } from "../domain/types.ts";
import type { ChatRequest } from "../llm/chat.ts";
import { chunkEvenly } from "../llm/robust.ts";
import { isStringArray } from "../llm/json.ts";
import { DOMAINS, type Domain } from "./domains.ts";
import { countLiftGatePass, hasDisjointScenes, LIFT_MIN_EVIDENCE, LIFT_MIN_EVIDENCE_HARD, LIFT_MIN_PERIODS, type LiftParams } from "./lift.ts";
import { modelPredictionText, predictionDerivation } from "./predictions.ts";
import type { DroppedOutput, HypothesisDraft, HypothesisGroupDraft, LiftGateReason, LiftGateStats, LiftInput, LiftLevel, RgView, TargetLink } from "./types.ts";

const DOMAIN_LIST = DOMAINS.join("、");

export const LIFT_SYSTEM_NEED = `你是记忆系统的推理器，从一个人已经成立的偏好、近期状态里往上抽一层：找跨场景、跨时期都成立的稳定需求。规则：
- 下层断言都已经成立；每行一条，带 claim_id、陈述、场景、时间、证据和事实（fact_id）；
- 每一组自己也要过门槛：两种以上互相不重叠的场景、两个以上月份、至少 3 条证据。场景"互相不重叠"= 两边的场景标签谁也包含不了谁才算两种（「出差」和「家里」算，「家里、周末」和「家里」不算）；只落一种场景的几条不要归成一组，即使说的是同一件事；场景不够时宁可少给组，不要为了让条数够把别的场景的断言拉进来充数；
- 把说的是同一件事、又跨了场景的下层断言归成一组：premise_ids 只能用给你的 claim_id；covered 为 true 的已经在别的组里，可以再用，但不要重复已有的组；给一个短主题名 theme；
- 每组至少两条互相竞争的上位解释：一条是稳定需求（tier = need），别的是另外的解释（比如只是这阵子的状态 state、只是对这几样事本身的偏好 preference）；
- 每条解释写：statement；predicts（一条两周内可以被这件事验证的预测：什么场合、预期看到什么；不超过 30 个字，写不出就留空）；derivation（预测是不是必然推得出：只有 statement 本身说的是"每次、从不、一定"这种全称、predicts 是其中具体的一次时写 deductive，倾向、大概会的一律写 defeasible，拿不准写 defeasible）；expects（supports：看到什么算支持；refutes：看到什么算反证）；supports、refutes 列出支持、反驳它的事实（target 是 fact_id，weight 是 weak | strong | decisive，decisive 只给用户自己明说的）；
  domains（适用领域，只能从 ${DOMAIN_LIST} 里选）；probe（一个能把它和另一条区分开的追问：against 是另一条在 hypotheses 里的序号，从 0 起；ask 问具体发生的事，不问动机；queries 是去记忆里检索用的 2 到 6 个短语）；
- 不编造 id；先后不等于原因；凑不出就少给，不要硬凑；
- 输出要紧凑：每组 2 到 3 条解释；supports、refutes 各最多 4 条、只列最有力的；statement、expects 各不超过 40 个字，predicts 不超过 30 个字，rationale 不超过 20 个字；不要缩进换行。
只输出 JSON：{"groups": [{"theme": "...", "premise_ids": [claim_id...], "description": "...", "hypotheses": [{"tier": "need", "statement": "...", "predicts": "...", "derivation": "defeasible", "expects": {"supports": "...", "refutes": "..."}, "supports": [{"target": fact_id, "weight": "strong", "rationale": "..."}], "refutes": [], "domains": [], "probe": {"against": 1, "ask": "...", "queries": ["..."]}}]}]}`;

export const LIFT_SYSTEM_VALUE = `你是记忆系统的推理器，从一个人已经成立的稳定需求里再往上抽一层：找长期的价值取向。规则：
- 下层是已经成立的需求；每行一条，带 claim_id、陈述、场景、时间、证据和事实（fact_id）；
- 每一组自己也要过门槛：两种以上互相不重叠的场景、三个以上月份、至少 3 条证据。场景"互相不重叠"= 两边的场景标签谁也包含不了谁才算两种（「出差」和「家里」算，「家里、周末」和「家里」不算）；只落一种场景的几条不要归成一组，即使说的是同一件事；场景不够时宁可少给组，不要为了让条数够把别的场景的断言拉进来充数；
- 把说的是同一件事、又跨了场景的需求归成一组（premise_ids 只能用给你的 claim_id），给一个短主题名 theme；
- 每组至少两条互相竞争的解释：长期看重（tier = value），和"只是现阶段的需要"（tier = need）；证据前后跨不到 180 天的，不要给"长期看重"强支持；
- 每条解释写：statement；predicts（一条两周内可以被这件事验证的预测：什么场合、预期看到什么；不超过 30 个字，写不出就留空）；derivation（只有 statement 本身是"每次、从不、一定"这种全称、predicts 是其中具体的一次时写 deductive，别的一律 defeasible）；expects（supports、refutes：看到什么算支持、反证）；supports、refutes 列出支持、反驳它的事实（target 是 fact_id，weight 是 weak | strong | decisive，decisive 只给用户自己明说的）；
  domains（只能从 ${DOMAIN_LIST} 里选）；probe（against 是另一条在 hypotheses 里的序号，从 0 起；ask 问具体发生的事；queries 是 2 到 6 个检索短语）；
- 不编造 id；凑不出就少给；
- 输出要紧凑：supports、refutes 各最多 4 条、只列最有力的；statement、expects 各不超过 40 个字，predicts 不超过 30 个字，rationale 不超过 20 个字；不要缩进换行。
只输出 JSON：{"groups": [{"theme": "...", "premise_ids": [claim_id...], "description": "...", "hypotheses": [{"tier": "value", "statement": "...", "predicts": "...", "derivation": "defeasible", "expects": {"supports": "...", "refutes": "..."}, "supports": [], "refutes": [], "domains": [], "probe": {"against": 1, "ask": "...", "queries": []}}]}]}`;

/** 每层允许的上位解释的层 */
const TIERS: Readonly<Record<LiftLevel, readonly ClaimTier[]>> = { need: ["need", "state", "preference"], value: ["value", "need"] };
const STATE_DAYS = 14;
/** 主题名最多几个字（进组的 key） */
const THEME_MAX = 24;
/** 218 号票：一条下层断言估多少输出 token（一组 3、4 条断言，两三条解释带支持、反证、追问，约 900 token） */
export const LIFT_OUTPUT_PER_PREMISE = 250;
/** 一批最多几条要归纳的下层断言（估的输出约 4000 token，上限放到估的 1.8 倍，不超过 8000） */
export const LIFT_BATCH_PREMISES = 16;
/** 输出上限：按这一批的条数估的 1.8 倍，2000 到 8000（DeepSeek 对话接口的输出上限是 8K） */
export const liftMaxTokens = (premises: number): number => Math.min(8000, Math.max(2000, Math.ceil(premises * LIFT_OUTPUT_PER_PREMISE * 1.8)));

/** 模型版往上抽的组的参数：规则版的 LiftParams 加上模型写的每条的领域、支持和反证的样子、追问 */
export interface ModelLiftParams extends LiftParams {
  model: {
    hypotheses: { template: string; domains: Domain[]; expects: { supports: string; refutes: string } }[];
    probes: { template: string; against: string; ask: string; queries: string[] }[];
  };
}

/** 已有的一组（模型版建的），给"照旧交回"和"不要重复"用 */
export interface ExistingLiftGroup {
  key: string;
  description: string;
  params: Partial<ModelLiftParams>;
  premiseIds: string[];
  members: { claim: Claim; template: string; links: TargetLink[] }[];
}

export interface LiftThreshold {
  /** 结构门槛过了（两种场合 + 至少两条证据）：可以出结论；软门槛不过的标 provisional */
  ok: boolean;
  /**
   * 256 号票：结构门槛过了、只是月份不够或者证据不到 3 条——照样出结论，但标"临时"，
   * 置信度由 scoring 的 confidenceCap 按"证据薄、不跨时期、不跨场景"压到 low，跨度够了重抽 + rescore 自己升上去
   */
  provisional: boolean;
  /** 差在哪（全过时是空串） */
  reason: string;
  /** 哪几条没过（硬的 + 软的，给人看的） */
  failed: LiftGateReason[];
  /** 过不了就出不了的（结构性的：两种场合、至少两条证据） */
  hardFailed: LiftGateReason[];
  /** 只影响"标不标临时"的（月份够不够、证据到不到 3 条） */
  softFailed: LiftGateReason[];
  /** 有没有两种不同的场合（229 号票起按 scenesDiffer 只看方面维度判不同；老严格判定在 LiftGateStats 里另记） */
  disjoint: boolean;
  scenes: string[][];
  months: number;
  evidenceIds: string[];
  first: string | null;
  last: string | null;
  spanDays: number;
}

/** 几条输入的场景：去重，被别的场景包含的不单列（同规则版） */
export function mergeScenes(inputs: readonly LiftInput[]): string[][] {
  const keys = new Map<string, string[]>();
  for (const s of inputs.flatMap((p) => p.scenes)) if (s.length > 0) keys.set(s.toSorted().join("+"), s);
  return [...keys.values()].filter((s, _, all) => !all.some((t) => t !== s && t.length > s.length && s.every((tag) => t.includes(tag))));
}

/**
 * 门槛（195 的规则版条件，由代码判）分两种（256 号票）：
 * - 结构性的（过不了就不出）：两种以上不同的场合（223 号票起按维度看不同）、至少 LIFT_MIN_EVIDENCE_HARD 条证据；
 * - 时期性的（过不了就先出、标临时）：够数的月份、至少 LIFT_MIN_EVIDENCE 条证据。跨不够时间的结论照样有价值
 *   （"多次回避社交场合"三周就能看出苗头），只是不能说成"长期需求"——置信度那套（confidenceCap）本来就是干这个的
 */
export function liftThreshold(level: LiftLevel, premises: readonly LiftInput[], view: RgView): LiftThreshold {
  const scenes = mergeScenes(premises);
  const evidenceIds = [...new Set(premises.flatMap((p) => p.supportEvidenceIds))];
  const times = evidenceIds
    .map((id) => view.evidence(id))
    .filter((e) => e !== undefined)
    .map((e) => e.eventTime ?? e.observedAt)
    .toSorted((a, b) => toMs(a) - toMs(b));
  const months = new Set(times.map((t) => localDate(t).slice(0, 7))).size;
  const hard: string[] = [];
  const soft: string[] = [];
  const hardFailed: LiftGateReason[] = [];
  const softFailed: LiftGateReason[] = [];
  const disjoint = hasDisjointScenes(scenes);
  if (!disjoint) {
    hardFailed.push("场景不够");
    hard.push(`场景不够：要两种以上不同的场合（只看方面维度：方面标签不同才算两种，只差日型、出行不算；现在 ${scenes.length} 种）`);
  }
  if (evidenceIds.length < LIFT_MIN_EVIDENCE_HARD) {
    hardFailed.push("证据条数不够");
    hard.push(`证据条数不够：至少 ${LIFT_MIN_EVIDENCE_HARD} 条（现在 ${evidenceIds.length} 条）；一条证据推不出长期的结论`);
  } else if (evidenceIds.length < LIFT_MIN_EVIDENCE) {
    softFailed.push("证据条数不够");
    soft.push(`证据条数不够：要 ${LIFT_MIN_EVIDENCE} 条以上才算站得住（现在 ${evidenceIds.length} 条），先当临时结论`);
  }
  if (months < LIFT_MIN_PERIODS[level]) {
    softFailed.push("月份不够");
    soft.push(`月份不够：要 ${LIFT_MIN_PERIODS[level]} 个以上（现在 ${months} 个），先当临时结论`);
  }
  const ok = hard.length === 0;
  const provisional = ok && soft.length > 0;
  const first = times[0] ?? null;
  const last = times.at(-1) ?? null;
  return {
    ok,
    provisional,
    reason: [...hard, ...soft].join("；"),
    failed: [...hardFailed, ...softFailed],
    hardFailed,
    softFailed,
    disjoint,
    scenes,
    months,
    evidenceIds,
    first,
    last,
    spanDays: first && last ? Math.round((toMs(last) - toMs(first)) / 86_400_000) : 0,
  };
}

const day = (t: string | null) => (t ? localDate(t) : "?");
const PROVISIONAL_SUFFIX = /（临时结论：.*?）$/;

/**
 * 临时结论的说法（256 号票）：描述后面挂一句"临时"，软门槛过了就摘掉（重复整理不会越挂越多）。
 * 同一段话也是那条推断的 rationale（写进库里，详情里看得到为什么先标临时）
 */
export function provisionalNote(description: string, t: LiftThreshold): string {
  const base = description.replace(PROVISIONAL_SUFFIX, "").trim();
  return t.provisional ? `${base}（临时结论：${t.softFailed.join("、")}）` : base;
}

/** 给模型看的一条下层断言 */
function premiseLine(input: LiftInput, view: RgView, covered: boolean): string {
  const evidence = input.supportEvidenceIds
    .map((id) => view.evidence(id))
    .filter((e) => e !== undefined)
    .map((e) => ({ evidence_id: e.id, time: day(e.eventTime ?? e.observedAt), text: e.text }));
  const times = evidence.map((e) => e.time).toSorted();
  const facts = [
    ...input.supports.map((f) => ({ f, role: "supports" })),
    ...input.refutes.map((f) => ({ f, role: "refutes" })),
  ].map(({ f, role }) => ({ fact_id: f.id, role, statement: f.statement, assertion: f.assertion }));
  return JSON.stringify({
    claim_id: input.claim.id,
    tier: input.claim.tier,
    label: input.claim.epistemic === "explicit" ? "用户说的" : input.claim.epistemic === "user_confirmed" ? "用户确认过" : "推断的",
    statement: input.claim.statement,
    confidence: input.claim.confidence,
    scenes: input.scenes,
    time_span: times.length > 0 ? `${times[0]} 到 ${times.at(-1)}` : "?",
    covered,
    evidence,
    facts,
  });
}

/** 给模型看的一条别的批的下层断言：一行摘要（分批时；可以一起归进组，事实不列） */
function briefPremiseLine(input: LiftInput, view: RgView, covered: boolean): string {
  const times = input.supportEvidenceIds
    .map((id) => view.evidence(id))
    .filter((e) => e !== undefined)
    .map((e) => day(e.eventTime ?? e.observedAt))
    .toSorted();
  return JSON.stringify({ claim_id: input.claim.id, tier: input.claim.tier, statement: input.claim.statement, scenes: input.scenes, time_span: times.length > 0 ? `${times[0]} 到 ${times.at(-1)}` : "?", covered });
}

/** 问模型之前判这一层：没有还没被用上的下层断言，或者全体合起来都不够门槛，就不问（返回原因；问的话是 undefined） */
export function liftNotAskedReason(level: LiftLevel, inputs: readonly LiftInput[], view: RgView, covered: ReadonlySet<string> = new Set()): string | undefined {
  if (!inputs.some((i) => !covered.has(i.claim.id))) return "没有新的下层断言";
  const t = liftThreshold(level, inputs, view);
  return t.ok ? undefined : t.failed.join("+");
}

/**
 * 218 号票：还没被已有的组用上的下层断言分批——不超过 LIFT_BATCH_PREMISES 条是一批，多了按陈述排（说同一件事的挨在一起）、
 * 切成一样大的几批
 */
export function liftBatches(inputs: readonly LiftInput[], covered: ReadonlySet<string> = new Set()): LiftInput[][] {
  const fresh = inputs.filter((i) => !covered.has(i.claim.id));
  if (fresh.length <= LIFT_BATCH_PREMISES) return fresh.length > 0 ? [fresh] : [];
  return chunkEvenly(
    fresh.toSorted((a, b) => a.claim.statement.localeCompare(b.claim.statement, "zh")),
    LIFT_BATCH_PREMISES,
  );
}

/** 前面几批交回的组（还没校验）：主题和下层断言，列进"已经有的组" */
function priorLine(raw: unknown): string | undefined {
  const g = (raw ?? {}) as Record<string, unknown>;
  const ids = isStringArray(g.premise_ids) ? g.premise_ids : [];
  return ids.length > 0 ? `- 主题「${str(g.theme) || str(g.description) || "未命名"}」：${ids.join("、")}` : undefined;
}

/**
 * 往上抽的请求：没有还没被已有的组用上的下层断言、或者这一层全部输入合起来都不够门槛，返回 undefined（不问模型）。
 * covered 是已有的、这次照旧交回的组用上的下层断言。218 号票：batch 给了是分批问的一批——focus 是这批要归纳的（写全），
 * 别的输入只写一行摘要；prior 是前面几批交回的组。不给（或者这批就是全部还没用上的）时全部输入写全
 */
export function liftRequest(
  level: LiftLevel,
  inputs: readonly LiftInput[],
  view: RgView,
  existing: readonly ExistingLiftGroup[] = [],
  covered: ReadonlySet<string> = new Set(),
  batch?: { focus: readonly LiftInput[]; prior?: readonly unknown[] },
): ChatRequest | undefined {
  if (liftNotAskedReason(level, inputs, view, covered) !== undefined) return undefined;
  const t = liftThreshold(level, inputs, view);
  const groups = [...existing.map((g) => `- 主题「${g.params.label ?? g.key}」：${g.premiseIds.join("、")}`), ...(batch?.prior ?? []).map(priorLine).filter((l): l is string => l !== undefined)];
  const focus = new Set((batch?.focus ?? inputs.filter((i) => !covered.has(i.claim.id))).map((i) => i.claim.id));
  const whole = inputs.every((i) => covered.has(i.claim.id) || focus.has(i.claim.id));
  const lines = whole
    ? [`下层断言：`, ...inputs.map((i) => premiseLine(i, view, covered.has(i.claim.id)))]
    : [
        `这一批要归纳的下层断言（每组至少要有一条是这一批的）：`,
        ...inputs.filter((i) => focus.has(i.claim.id)).map((i) => premiseLine(i, view, covered.has(i.claim.id))),
        `别的下层断言（只有摘要；可以一起归进组的 premise_ids，不用单独为它们出组）：`,
        ...inputs.filter((i) => !focus.has(i.claim.id)).map((i) => briefPremiseLine(i, view, covered.has(i.claim.id))),
      ];
  return {
    purpose: "lift",
    system: level === "need" ? LIFT_SYSTEM_NEED : LIFT_SYSTEM_VALUE,
    user: [
      `现在：${view.at}`,
      `层：${level === "need" ? "需求层（从偏好、近期状态往上抽）" : "价值层（从需求往上抽）"}`,
      `整体：${inputs.length} 条下层断言，${t.scenes.length} 种场景，${t.months} 个月，${t.evidenceIds.length} 条证据，${day(t.first)} 到 ${day(t.last)}（跨 ${t.spanDays} 天）`,
      `已经有的组（不要重复）：`,
      groups.join("\n") || "（没有）",
      ...lines,
    ].join("\n"),
    maxTokens: liftMaxTokens(focus.size),
  };
}

/** 已有的组照旧交回：它挑的下层断言还在输入里、还够门槛的才交；返回交回的组和它们用上的下层断言 */
export function reemitLiftGroups(level: LiftLevel, inputs: readonly LiftInput[], view: RgView, existing: readonly ExistingLiftGroup[]): { drafts: HypothesisGroupDraft[]; covered: Set<string> } {
  const byId = new Map(inputs.map((i) => [i.claim.id, i]));
  const drafts: HypothesisGroupDraft[] = [];
  const covered = new Set<string>();
  for (const g of existing) {
    const premises = g.premiseIds.map((id) => byId.get(id)).filter((p): p is LiftInput => p !== undefined);
    const t = liftThreshold(level, premises, view);
    if (!t.ok || g.members.length < 2) continue;
    const observed = observationsOf(premises, view);
    const hypotheses: HypothesisDraft[] = g.members.map((m) => {
      const links = [...m.links];
      for (const [id, { fact, input }] of observed) if (!links.some((l) => l.target === id)) links.push(observationLink(fact, input));
      return {
        template: m.template,
        tier: m.claim.tier,
        statement: m.claim.statement,
        context: [],
        validFrom: t.first,
        validTo: m.claim.tier === "state" && t.last ? addDays(t.last, STATE_DAYS) : null,
        method: "induction",
        // 226 号票：上次写的预测照旧带着，不要因为重新整理一次就丢（330 号票：推法也带着）
        predicts: m.claim.predicts[0]?.claim,
        predictsDerivation: m.claim.predicts[0]?.derivation,
        links,
      };
    });
    const premiseIds = premises.map((p) => p.claim.id);
    drafts.push({
      key: g.key,
      pattern: `lift:${level}`,
      params: {
        ...g.params,
        scenes: t.scenes,
        premiseIds,
        periods: t.months,
        first: t.first,
        last: t.last,
        spanDays: t.spanDays,
        count: premises.length,
        // 256 号票：这一夜还够不够时期门槛（够了的临时的标就摘掉，置信度由 rescore 自己升）
        ...(t.provisional ? { provisional: true, provisionalWhy: t.softFailed.join("、") } : { provisional: false }),
      } as unknown as Record<string, unknown>,
      description: provisionalNote(g.description, t),
      observationIds: premiseIds,
      hypotheses,
      provisional: t.provisional,
    });
    for (const id of premiseIds) covered.add(id);
  }
  return { drafts, covered };
}

/** 下层断言的支持事实（能当依据的）：对每条上位解释都是弱支持 */
function observationsOf(premises: readonly LiftInput[], view: RgView): Map<string, { fact: Fact; input: LiftInput }> {
  const out = new Map<string, { fact: Fact; input: LiftInput }>();
  for (const p of premises) for (const f of p.supports) if (!out.has(f.id) && view.usableFact(f)) out.set(f.id, { fact: f, input: p });
  return out;
}

const observationLink = (fact: Fact, input: LiftInput): TargetLink => ({ target: fact.id, polarity: "supports", weight: "weak", rationale: `观察（${input.claim.statement}）：${fact.statement}` });

const weightOf = (v: unknown): LinkWeight | undefined => ((LINK_WEIGHTS as readonly unknown[]).includes(v) ? (v as LinkWeight) : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export interface ParseLiftOptions {
  /** 已有的组的 key（同主题不重复建） */
  existingKeys: ReadonlySet<string>;
  /** 价值层：下层需求所在那组的主题（同一个主题的需求和价值编进同一条策略） */
  themeOfGroup?: (groupKey: string) => string | undefined;
  dropped: DroppedOutput[];
  /** 218 号票：门槛判法的结果、写入前丢掉的组记在这里 */
  gate?: LiftGateStats;
}

/** 解析、校验模型交回的往上抽的组（见文件开头）；不合格的丢掉、记进 dropped */
export function parseLiftOutput(level: LiftLevel, parsed: Record<string, unknown>, inputs: readonly LiftInput[], view: RgView, options: ParseLiftOptions): HypothesisGroupDraft[] {
  const byId = new Map(inputs.map((i) => [i.claim.id, i]));
  const out: HypothesisGroupDraft[] = [];
  const usedKeys = new Set(options.existingKeys);
  for (const raw of Array.isArray(parsed.groups) ? parsed.groups : []) {
    const g = (raw ?? {}) as Record<string, unknown>;
    const drop = (reason: string, item: unknown = raw) => options.dropped.push({ stage: "lift", reason, item });
    const reject = (reason: string, item: unknown = raw) => {
      drop(reason, item);
      const gate = options.gate;
      const key = reason.split("：")[0]!;
      if (gate) gate.rejected[key] = (gate.rejected[key] ?? 0) + 1;
    };
    const premiseIds = [
      ...new Set(
        (isStringArray(g.premise_ids) ? g.premise_ids : []).filter((id) => {
          if (byId.has(id)) return true;
          drop(`伪造的或不在输入里的下层断言 id：${id}`, id);
          return false;
        }),
      ),
    ];
    if (premiseIds.length === 0) {
      reject("没有能用的下层断言");
      continue;
    }
    const premises = premiseIds.map((id) => byId.get(id)!);
    const t = liftThreshold(level, premises, view);
    if (!t.ok) {
      drop(`没过门槛：${t.reason}`);
      const gate = options.gate;
      if (gate) {
        gate.failed++;
        for (const r of t.failed) gate.byReason[r] = (gate.byReason[r] ?? 0) + 1;
        gate.failures.push({ level, reasons: t.failed, premises: premises.length, disjointScenes: t.disjoint, scenes: t.scenes.length, months: t.months, evidence: t.evidenceIds.length, spanDays: t.spanDays });
      }
      continue;
    }
    if (options.gate) {
      if (t.provisional) {
        // 256 号票：结构门槛过了、时期不够的照样出结论，只是标成临时的（不进 passed，免得和 229 的口径混在一起）
        options.gate.provisional++;
        for (const r of t.softFailed) options.gate.provisionalByReason[r] = (options.gate.provisionalByReason[r] ?? 0) + 1;
      } else {
        countLiftGatePass(options.gate, t.scenes);
      }
    }
    const observed = observationsOf(premises, view);
    const candidates = new Map<string, Fact>();
    for (const p of premises) for (const f of [...p.supports, ...p.refutes]) if (view.usableFact(f)) candidates.set(f.id, f);

    const kept: { index: number; draft: HypothesisDraft; domains: Domain[]; expects: { supports: string; refutes: string }; probe: unknown }[] = [];
    const rawHypotheses = Array.isArray(g.hypotheses) ? g.hypotheses : [];
    rawHypotheses.forEach((rawH, index) => {
      const h = (rawH ?? {}) as Record<string, unknown>;
      const statement = str(h.statement);
      if (!(CLAIM_TIERS as readonly unknown[]).includes(h.tier) || !TIERS[level].includes(h.tier as ClaimTier) || statement.length === 0) {
        reject(`上位解释的层或陈述不合格：${level} 层只能是 ${TIERS[level].join("、")}`, rawH);
        return;
      }
      if (kept.some((k) => k.draft.statement === statement)) {
        drop("重复的上位解释", rawH);
        return;
      }
      const tier = h.tier as ClaimTier;
      const links: TargetLink[] = [];
      for (const [polarity, list] of [
        ["supports", h.supports],
        ["refutes", h.refutes],
      ] as const) {
        for (const item of Array.isArray(list) ? list : []) {
          const l = (item ?? {}) as Record<string, unknown>;
          const fact = typeof l.target === "string" ? candidates.get(l.target) : undefined;
          let weight = weightOf(l.weight);
          if (!fact) {
            drop(`伪造的或不能当依据的目标 id：${String(l.target)}`, item);
            continue;
          }
          if (!weight) {
            drop(`多重不认得：${String(l.weight)}`, item);
            continue;
          }
          if (weight === "decisive" && fact.assertion !== "user_stated") weight = "strong";
          if (links.some((x) => x.target === fact.id && x.polarity === polarity)) continue;
          links.push({ target: fact.id, polarity, weight, rationale: str(l.rationale) || `模型：${polarity === "supports" ? "支持" : "反证"}` });
        }
      }
      for (const [id, { fact, input }] of observed) if (!links.some((l) => l.target === id)) links.push(observationLink(fact, input));
      const domains: Domain[] = [];
      for (const d of isStringArray(h.domains) ? h.domains : []) {
        if ((DOMAINS as readonly string[]).includes(d)) {
          if (!domains.includes(d as Domain)) domains.push(d as Domain);
        } else {
          drop(`不认得的领域：${d}`, d);
          if (options.gate) options.gate.rejected["领域不认得"] = (options.gate.rejected["领域不认得"] ?? 0) + 1;
        }
      }
      const expectsRaw = (h.expects ?? {}) as Record<string, unknown>;
      let template = `model:${statement.slice(0, 40)}`;
      if (kept.some((k) => k.draft.template === template)) template = `${template}#${index}`;
      kept.push({
        index,
        draft: {
          template,
          tier,
          statement,
          context: [],
          validFrom: t.first,
          validTo: tier === "state" && t.last ? addDays(t.last, STATE_DAYS) : null,
          method: "induction",
          predicts: modelPredictionText(h.predicts),
          // 330 号票：模型说是演绎、结论又真有全称说法才认 deductive（ADR-0032）
          predictsDerivation: predictionDerivation(statement, h.derivation),
          links,
        },
        domains,
        expects: { supports: str(expectsRaw.supports), refutes: str(expectsRaw.refutes) },
        probe: h.probe,
      });
    });
    if (kept.length < 2) {
      reject("上位解释不到两条");
      continue;
    }
    // 追问：against 指的是模型原来的序号，换成留下来的那条的模板
    const probes: ModelLiftParams["model"]["probes"] = [];
    for (const k of kept) {
      if (k.probe === undefined || k.probe === null) continue;
      const p = (k.probe ?? {}) as Record<string, unknown>;
      const against = kept.find((x) => x.index === p.against && x !== k);
      const ask = str(p.ask);
      const queries = (isStringArray(p.queries) ? p.queries : []).map((q) => q.trim()).filter((q) => q.length > 0);
      if (!against || ask.length === 0 || queries.length === 0) {
        drop("追问不合格（against 不是另一条留下来的解释，或者没有问法、检索短语）", k.probe);
        continue;
      }
      probes.push({ template: k.draft.template, against: against.draft.template, ask, queries: queries.slice(0, 6) });
    }
    const label = (str(g.theme) || str(g.description) || "未命名").slice(0, THEME_MAX);
    let key = `lift:${level}|model:${label}`;
    if (options.existingKeys.has(key)) {
      reject(`和已有的组重复：主题「${label}」`);
      continue;
    }
    for (let n = 2; usedKeys.has(key); n++) key = `lift:${level}|model:${label}#${n}`;
    usedKeys.add(key);
    const premiseThemes = level === "value" ? [...new Set(premises.map((p) => (p.groupKey ? options.themeOfGroup?.(p.groupKey) : undefined)))] : [];
    const theme = premiseThemes.length === 1 && premiseThemes[0] ? premiseThemes[0] : `model:${label}`;
    const activities = new Map<string, { id: string; name: string }>();
    for (const a of premises.flatMap((p) => p.activities)) activities.set(a.id, a);
    const params: ModelLiftParams = {
      daytype: null,
      domain: null,
      activities: [...activities.values()],
      first: t.first!,
      last: t.last!,
      spanDays: t.spanDays,
      count: premises.length,
      workTagged: false,
      level,
      theme,
      label,
      scenes: t.scenes,
      premiseIds,
      periods: t.months,
      model: { hypotheses: kept.map((k) => ({ template: k.draft.template, domains: k.domains, expects: k.expects })), probes },
    };
    out.push({
      key,
      pattern: `lift:${level}`,
      params: {
        ...params,
        ...(t.provisional ? { provisional: true, provisionalWhy: t.softFailed.join("、") } : {}),
      } as unknown as Record<string, unknown>,
      description: provisionalNote(
        str(g.description) || `${label}：在 ${t.scenes.length} 种场景、${t.months} 个月里都成立（${premises.length} 条断言，模型归纳）`,
        t,
      ),
      observationIds: premiseIds,
      hypotheses: kept.map((k) => k.draft),
      provisional: t.provisional,
    });
  }
  return out;
}
