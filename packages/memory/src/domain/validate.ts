// 校验：每种对象一个 problemsOfX（返回问题清单，空的就是合格）；存储写入前用 assertValid 抛错。
// 只查一条对象自己说得清的规则（枚举、前缀、时间、状态和配套字段、置信上限的静态部分）；
// 要看别的对象才知道的（证据数够不够升 medium）由 confidenceCap 给 ④ 号票的推理用。
import { idKind, isIdOf } from "./ids.ts";
import { addDays, compareTime, isZonedIso } from "./time.ts";
import {
  ASSERTIONS,
  CLAIM_KINDS,
  CLAIM_STATUSES,
  CLAIM_TIERS,
  CONFIDENCES,
  ENTITY_TYPES,
  EPISTEMIC_STATUSES,
  EVIDENCE_KINDS,
  EVIDENCE_STATUSES,
  FACT_STATUSES,
  INFERENCE_STATUSES,
  LINK_POLARITIES,
  LINK_WEIGHTS,
  METHODS,
  MODES,
  PREDICATES,
  PREDICTION_OUTCOMES,
  PREDICTION_STATUSES,
  DERIVATIONS,
  PROBE_OUTCOMES,
  SOURCE_LEVELS,
  STRATEGY_STATUSES,
  type Claim,
  type ClaimTier,
  type Confidence,
  type Entity,
  type EpistemicStatus,
  type Evidence,
  type Fact,
  type Inference,
  type Link,
  type ObjectType,
  type PredictionRecord,
  type Probe,
  type Strategy,
} from "./types.ts";

export class ValidationError extends Error {
  readonly problems: string[];
  constructor(what: string, problems: string[]) {
    super(`${what} 不合格：${problems.join("；")}`);
    this.name = "ValidationError";
    this.problems = problems;
  }
}

/** 近期状态不写到期时间时默认 14 天（第 5 节） */
export const STATE_DEFAULT_DAYS = 14;

export function defaultStateValidTo(validFrom: string): string {
  return addDays(validFrom, STATE_DEFAULT_DAYS);
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function confidenceAtMost(value: Confidence, cap: Confidence): boolean {
  return CONFIDENCE_RANK[value] <= CONFIDENCE_RANK[cap];
}

/**
 * 置信上限（第 4.3 节，按层和证据厚薄封顶：越往深层推，要的证据越多）：
 * - state、preference：用户明说或确认过的可以 high，推断的最多 medium；
 * - need、value：最多 medium；只有一两条支持证据，或者证据不到两个时间段、两种场景（给了才看）时最多 low。用户确认过也一样——
 *   用户的话在"怎么为他服务"上是权威，在"他为什么这样"上只是一条证据。
 */
export function confidenceCap(input: { tier: ClaimTier; epistemic: EpistemicStatus; supportCount: number; periods?: number; contexts?: number }): Confidence {
  if (input.tier === "need" || input.tier === "value") {
    const thin = input.supportCount <= 2 || (input.periods !== undefined && input.periods < 2) || (input.contexts !== undefined && input.contexts < 2);
    return thin ? "low" : "medium";
  }
  return input.epistemic === "inferred" ? "medium" : "high";
}

// ---------- 小工具 ----------

type Problems = string[];

function oneOf<T extends string>(problems: Problems, field: string, value: unknown, allowed: readonly T[]): void {
  if (!allowed.includes(value as T)) problems.push(`${field} 是 ${JSON.stringify(value)}，应为 ${allowed.join(" | ")}`);
}

function time(problems: Problems, field: string, value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  if (!isZonedIso(value)) problems.push(`${field} 应为带时区的 ISO 时间${nullable ? "或 null" : ""}，现在是 ${JSON.stringify(value)}`);
}

function text(problems: Problems, field: string, value: unknown, allowEmpty = false): void {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) problems.push(`${field} 应为${allowEmpty ? "" : "非空"}字符串`);
}

function tags(problems: Problems, field: string, value: unknown): void {
  if (!Array.isArray(value) || value.some((t) => typeof t !== "string" || t.trim().length === 0)) problems.push(`${field} 应为非空字符串的数组`);
}

function ids(problems: Problems, field: string, value: unknown, kinds: readonly string[], minimum = 0): void {
  if (!Array.isArray(value)) {
    problems.push(`${field} 应为数组`);
    return;
  }
  if (value.length < minimum) problems.push(`${field} 至少要 ${minimum} 条`);
  const bad = value.filter((id) => typeof id !== "string" || !kinds.includes(idKind(id) ?? ""));
  if (bad.length > 0) problems.push(`${field} 里 ${bad.join("、")} 不是 ${kinds.join(" / ")} 的 id`);
}

function prefixed(problems: Problems, field: string, value: unknown, kind: Parameters<typeof isIdOf>[0], nullable = false): void {
  if (nullable && value === null) return;
  if (!isIdOf(kind, value)) problems.push(`${field} 应为 ${kind} 的 id${nullable ? "或 null" : ""}，现在是 ${JSON.stringify(value)}`);
}

function validityOrder(problems: Problems, validFrom: string | null, validTo: string | null): void {
  if (validFrom !== null && validTo !== null && isZonedIso(validFrom) && isZonedIso(validTo) && compareTime(validTo, validFrom) < 0) {
    problems.push(`validTo（${validTo}）早于 validFrom（${validFrom}）`);
  }
}

// ---------- 各种对象 ----------

export function problemsOfEvidence(e: Evidence): Problems {
  const p: Problems = [];
  prefixed(p, "id", e.id, "evidence");
  oneOf(p, "sourceLevel", e.sourceLevel, SOURCE_LEVELS);
  oneOf(p, "mode", e.mode, MODES);
  oneOf(p, "kind", e.kind, EVIDENCE_KINDS);
  oneOf(p, "status", e.status, EVIDENCE_STATUSES);
  text(p, "text", e.text, true);
  if (e.status === "active" && typeof e.text === "string" && e.text.trim().length === 0) p.push("有效的证据 text 不能空");
  tags(p, "context", e.context);
  time(p, "eventTime", e.eventTime, true);
  time(p, "observedAt", e.observedAt);
  if (e.sourceRef !== null && typeof e.sourceRef !== "string") p.push("sourceRef 应为字符串或 null");
  text(p, "contentHash", e.contentHash);
  return p;
}

export function problemsOfEntity(e: Entity): Problems {
  const p: Problems = [];
  prefixed(p, "id", e.id, "entity");
  oneOf(p, "type", e.type, ENTITY_TYPES);
  text(p, "name", e.name);
  tags(p, "aliases", e.aliases);
  return p;
}

export function problemsOfFact(f: Fact): Problems {
  const p: Problems = [];
  prefixed(p, "id", f.id, "fact");
  prefixed(p, "subjectId", f.subjectId, "entity");
  oneOf(p, "predicate", f.predicate, PREDICATES);
  if (f.object?.type === "entity") prefixed(p, "object.id", f.object.id, "entity");
  else if (f.object?.type === "value") text(p, "object.value", f.object.value);
  else p.push("object 应为 { type: entity, id } 或 { type: value, value }");
  if (typeof f.negated !== "boolean") p.push("negated 应为布尔值");
  text(p, "statement", f.statement);
  oneOf(p, "assertion", f.assertion, ASSERTIONS);
  tags(p, "context", f.context);
  ids(p, "evidenceIds", f.evidenceIds, ["evidence"], 1);
  time(p, "eventTime", f.eventTime, true);
  time(p, "observedAt", f.observedAt);
  time(p, "validFrom", f.validFrom, true);
  time(p, "validTo", f.validTo, true);
  validityOrder(p, f.validFrom, f.validTo);
  oneOf(p, "status", f.status, FACT_STATUSES);
  prefixed(p, "supersededBy", f.supersededBy, "fact", true);
  prefixed(p, "retractedBy", f.retractedBy, "evidence", true);
  ids(p, "contestedWith", f.contestedWith, ["fact"]);
  if (f.status === "superseded" && (f.supersededBy === null || f.validTo === null)) p.push("superseded 的事实要有 supersededBy 和 validTo");
  if ((f.status === "corrected" || f.status === "retracted") && f.retractedBy === null) p.push(`${f.status} 的事实要有 retractedBy`);
  if (f.status === "contested" && f.contestedWith.length === 0) p.push("contested 的事实要有 contestedWith");
  if (!/^(rule|model):.+/.test(f.extractedBy ?? "")) p.push("extractedBy 应写 rule:<版本> 或 model:<名>");
  return p;
}

export function problemsOfClaim(c: Claim): Problems {
  const p: Problems = [];
  prefixed(p, "id", c.id, "claim");
  oneOf(p, "tier", c.tier, CLAIM_TIERS);
  text(p, "statement", c.statement);
  oneOf(p, "kind", c.kind, CLAIM_KINDS);
  oneOf(p, "epistemic", c.epistemic, EPISTEMIC_STATUSES);
  oneOf(p, "method", c.method, METHODS);
  oneOf(p, "status", c.status, CLAIM_STATUSES);
  oneOf(p, "confidence", c.confidence, CONFIDENCES);
  tags(p, "context", c.context);
  time(p, "validFrom", c.validFrom, true);
  time(p, "validTo", c.validTo, true);
  validityOrder(p, c.validFrom, c.validTo);
  time(p, "inferredAt", c.inferredAt);
  time(p, "reviewedAt", c.reviewedAt, true);
  if (c.retractedBy !== null && !["evidence", "fact", "claim"].includes(idKind(c.retractedBy) ?? "")) p.push("retractedBy 应为证据、事实或断言的 id 或 null");
  if (c.supersededBy !== null && !isIdOf("claim", c.supersededBy)) p.push("supersededBy 应为断言 id 或 null");
  ids(p, "competesWith", c.competesWith, ["claim"]);
  if (!Array.isArray(c.predicts)) p.push("predicts 应为数组");
  else
    c.predicts.forEach((pred, i) => {
      text(p, `predicts[${i}].claim`, pred?.claim);
      oneOf(p, `predicts[${i}].outcome`, pred?.outcome, PREDICTION_OUTCOMES);
      ids(p, `predicts[${i}].evidenceIds`, pred?.evidenceIds, ["evidence"]);
      if (pred?.derivation !== undefined) oneOf(p, `predicts[${i}].derivation`, pred.derivation, DERIVATIONS);
    });

  // 推法和认知状态对得上：明说的用 explicit，用户确认的用 user_confirmation，推断的用演绎、归纳、溯因
  const methodOk =
    (c.epistemic === "explicit" && c.method === "explicit") ||
    (c.epistemic === "user_confirmed" && c.method === "user_confirmation") ||
    (c.epistemic === "inferred" && (c.method === "deduction" || c.method === "induction" || c.method === "abduction"));
  if (!methodOk) p.push(`method ${c.method} 和 epistemic ${c.epistemic} 对不上`);

  // 置信上限的静态部分：need、value 最多 medium、只能从推断起（kind hypothesis）。
  // 329 号票：kind 只说来源（建号时定、不改），不再表达"已证实"——已验证是状态 active，推断出来的也能已验证（ADR-0032）
  if (c.tier === "need" || c.tier === "value") {
    if (!confidenceAtMost(c.confidence, "medium")) p.push(`${c.tier} 的 confidence 最多 medium`);
    if (c.kind !== "hypothesis") p.push(`${c.tier} 的 kind 只能是 hypothesis（只能从推断起）`);
  }
  if (typeof c.needsReview !== "boolean") p.push("needsReview 应为布尔值");
  if (c.epistemic === "inferred" && !confidenceAtMost(c.confidence, "medium")) p.push("推断出来的 confidence 最多 medium");
  if (c.tier === "state" && c.validTo === null) p.push("state 必须有 validTo（默认 14 天，defaultStateValidTo）");
  if (c.status === "retracted" && c.retractedBy === null) p.push("retracted 的断言要有 retractedBy");
  if (c.status === "superseded" && c.supersededBy === null) p.push("superseded 的断言要有 supersededBy");
  return p;
}

export function problemsOfLink(l: Link): Problems {
  const p: Problems = [];
  prefixed(p, "claimId", l.claimId, "claim");
  if (!isIdOf("evidence", l.target) && !isIdOf("fact", l.target)) p.push(`target 应为证据或事实的 id，现在是 ${JSON.stringify(l.target)}`);
  oneOf(p, "polarity", l.polarity, LINK_POLARITIES);
  text(p, "rationale", l.rationale, true);
  if (l.weight !== undefined) oneOf(p, "weight", l.weight, LINK_WEIGHTS);
  return p;
}

export function problemsOfInference(i: Inference): Problems {
  const p: Problems = [];
  prefixed(p, "id", i.id, "inference");
  prefixed(p, "conclusionClaimId", i.conclusionClaimId, "claim");
  ids(p, "premiseIds", i.premiseIds, ["fact", "claim", "evidence"], 1);
  oneOf(p, "method", i.method, METHODS);
  text(p, "rationale", i.rationale, true);
  if (!/^(rule|model):.+/.test(i.by ?? "")) p.push("by 应写 rule:<版本> 或 model:<名>");
  oneOf(p, "status", i.status, INFERENCE_STATUSES);
  time(p, "createdAt", i.createdAt);
  return p;
}

export function problemsOfProbe(pr: Probe): Problems {
  const p: Problems = [];
  prefixed(p, "id", pr.id, "probe");
  ids(p, "discriminates", pr.discriminates, ["claim", "fact"], 2);
  text(p, "ask", pr.ask);
  if (!Array.isArray(pr.queries) || pr.queries.some((q) => typeof q !== "string")) p.push("queries 应为字符串数组");
  if (pr.ifFound !== null && !(Array.isArray(pr.discriminates) && pr.discriminates.includes(pr.ifFound))) p.push("ifFound 应为 discriminates 里的一条或 null");
  oneOf(p, "outcome", pr.outcome, PROBE_OUTCOMES);
  ids(p, "foundEvidenceIds", pr.foundEvidenceIds, ["evidence"]);
  time(p, "createdAt", pr.createdAt);
  return p;
}

/** 交互策略（196 号票）：active 的要有用户确认的证据 */
export function problemsOfStrategy(st: Strategy): Problems {
  const p: Problems = [];
  prefixed(p, "id", st.id, "strategy");
  text(p, "key", st.key);
  text(p, "template", st.template);
  const trigger = st.trigger as Partial<Strategy["trigger"]> | undefined;
  tags(p, "trigger.domains", trigger?.domains);
  if (!Array.isArray(trigger?.scenes) || trigger.scenes.some((s) => !Array.isArray(s) || s.some((t) => typeof t !== "string"))) p.push("trigger.scenes 应为字符串数组的数组");
  if (!Array.isArray(trigger?.activities) || trigger.activities.some((a) => typeof a?.id !== "string" || typeof a?.name !== "string")) p.push("trigger.activities 应为 { id, name } 的数组");
  text(p, "when", st.when);
  if (!Array.isArray(st.actions) || st.actions.length === 0 || st.actions.some((a) => typeof a !== "string" || a.trim().length === 0)) p.push("actions 应为非空字符串的数组，至少一条");
  ids(p, "basisClaimIds", st.basisClaimIds, ["claim"], 1);
  oneOf(p, "status", st.status, STRATEGY_STATUSES);
  prefixed(p, "confirmedBy", st.confirmedBy, "evidence", true);
  time(p, "confirmedAt", st.confirmedAt, true);
  time(p, "createdAt", st.createdAt);
  if (st.status === "active" && st.confirmedBy === null) p.push("active 的策略要有用户确认的证据（confirmedBy）");
  if ((st.confirmedBy === null) !== (st.confirmedAt === null)) p.push("confirmedBy 和 confirmedAt 要么都有、要么都没有");
  return p;
}

/** 预测账本（226 号票）：开着的没有判定时间；判了（hit / miss / unclear）的要有判定时间 */
export function problemsOfPrediction(prediction: PredictionRecord): Problems {
  const p: Problems = [];
  prefixed(p, "id", prediction.id, "prediction");
  prefixed(p, "claimId", prediction.claimId, "claim");
  // 330 号票：预测节点的来源（至少一条，第一条就是 claimId）、推法、墓碑
  ids(p, "premiseIds", prediction.premiseIds, ["claim"], 1);
  if (!Array.isArray(prediction.premiseIds) || prediction.premiseIds[0] !== prediction.claimId) p.push("premiseIds 的第一条应是 claimId");
  oneOf(p, "derivation", prediction.derivation, DERIVATIONS);
  if ((prediction.status === "miss" || prediction.status === "void") !== (prediction.retractedBy !== null)) p.push("落空、作废的预测要有 retractedBy，别的不该有");
  text(p, "predicts", prediction.predicts);
  time(p, "madeAt", prediction.madeAt);
  time(p, "dueAt", prediction.dueAt, true);
  oneOf(p, "status", prediction.status, PREDICTION_STATUSES);
  prefixed(p, "evidenceId", prediction.evidenceId, "evidence", true);
  time(p, "judgedAt", prediction.judgedAt, true);
  text(p, "note", prediction.note, true);
  if (prediction.status !== "open" && prediction.status !== "void" && prediction.judgedAt === null) p.push(`${prediction.status} 的预测要有 judgedAt`);
  if (prediction.status === "open" && prediction.judgedAt !== null) p.push("开着的预测不该有 judgedAt");
  return p;
}

type Checked = {
  evidence: Evidence;
  entity: Entity;
  fact: Fact;
  claim: Claim;
  link: Link;
  inference: Inference;
  probe: Probe;
  strategy: Strategy;
  prediction: PredictionRecord;
};

const CHECKERS: { [K in ObjectType]: (o: Checked[K]) => Problems } = {
  evidence: problemsOfEvidence,
  entity: problemsOfEntity,
  fact: problemsOfFact,
  claim: problemsOfClaim,
  link: problemsOfLink,
  inference: problemsOfInference,
  probe: problemsOfProbe,
  strategy: problemsOfStrategy,
  prediction: problemsOfPrediction,
};

/** 不合格就抛 ValidationError（写明是哪种对象、哪个 id） */
export function assertValid<K extends ObjectType>(type: K, value: Checked[K]): void {
  const problems = CHECKERS[type](value);
  if (problems.length === 0) return;
  const id = "id" in value ? (value as { id: string }).id : `${(value as Link).claimId} → ${(value as Link).target}`;
  throw new ValidationError(`${type} ${id}`, problems);
}
