// 模型版推理（LlmReasoner，id = model:<模型名>）：接口同规则版，DeepSeek 写假设、追问、判定。
// - 提示词要求带证据 id（事实 id、证据 id、断言 id）的结构化 JSON；写入前丢掉伪造的 id（不在给它的那些里）、不合格的字段，
//   记进 dropped（借 Honcho 的做法）；
// - 只有本人的有效证据能当依据：别人转述的给它看，但它交回的关联指向别人转述的，降成背景（context）；
//   决定性（decisive）只给用户自己说的话，别的降成强；
// - 只给新的观察出假设（不是 exhaustive）：已经在某组里的观察不再问；
// - 每次调用先从预算里扣，预算用完就不再调（这一步当没做，留给下次）。
// 状态和置信度不归模型定，由 scoring.ts 按关联统一算。
// 201 号票：往上抽（lift，rg/llm-lift.ts）和编交互策略（writeStrategies，rg/llm-strategies.ts）。往上抽的门槛由代码判；
// 往上抽的组的追问用模型在往上抽时一起写的，不再另问；已有的组要看推理图谱（engine 打开时 attachGraph 接上）。
// 218 号票：出假设分批（新的观察 PROPOSE_BATCH_OBSERVATIONS 条一批，相近的排在一起；每批的观察写全，别的事实只写摘要；
// 一批最多 PROPOSE_MAX_GROUPS 组，估的输出 proposeOutputEstimate 离上限有余量），要求输出紧凑；出假设、往上抽、编策略都走 llm/robust.ts：每批独立，截断、解析不了的救回完整的条目、
// 剩下的对半切小重试（最多两层），每一步记进 dropped 和统计（ctx.stats）。追问、判证据照旧，只记数。
// 272 号票：给了问过的账（ctx.asked，reflect 建）时，出假设的新观察、往上抽没被用上的下层断言问过一次、没变化的不再当这一批问
// （照样作为别的事实、别的下层断言给摘要），问到了的交回账上；不给账（估费用、别的调用方）照旧全问。
import { addDays, compareTime } from "../domain/time.ts";
import { CLAIM_TIERS, LINK_WEIGHTS, type ClaimTier, type Fact, type LinkWeight, type Probe } from "../domain/types.ts";
import { unparsedReason, type ChatModel, type ChatRequest } from "../llm/chat.ts";
import { isStringArray, parseModelJson } from "../llm/json.ts";
import { askInBatches, chunkEvenly, countOutcome, stageStats, type BatchContext } from "../llm/robust.ts";
import type { AskStep, DroppedOutput, GroupView, HypothesisDraft, HypothesisGroupDraft, JudgeHit, LinkDraft, ProbeDraft, ProbeJudgement, Reasoner, ReasonerContext, RgView, TargetLink } from "./types.ts";
import { liftBatches, liftNotAskedReason, liftRequest, parseLiftOutput, reemitLiftGroups, type ExistingLiftGroup, type ModelLiftParams } from "./llm-lift.ts";
import { parseStrategies, STRATEGY_BATCH_BASES, strategyRequest } from "./llm-strategies.ts";
import type { ReasoningGraph } from "./reasoning-graph.ts";
import { observationSignature, premiseSignature } from "./nightly-lanes.ts";
import type { LiftInput, LiftLevel, StrategyBasisInput, WrittenStrategy } from "./types.ts";

/** 218 号票：出假设一组的输出约多少 token（第一次真跑量的：要求紧凑、一批最多 6 组时，一批最多写了 2746 token，约 460 / 组） */
export const PROPOSE_OUTPUT_PER_GROUP = 460;
/** 一批最多出几组：输出最多约 6 × 460 ≈ 2800 token，离 8000 的上限有余量 */
export const PROPOSE_MAX_GROUPS = 6;
/**
 * 一批最多几条新的观察。输出由每批的组数封顶，批的大小看的是另一头：批越多、组越多。第一次真跑一批 16 条时，一个人一百九十来条
 * 观察切成 10 批、出了 43–57 组，追问和判证据把 reflect 的 200 次预算用光，往上抽、编策略一次都没问成；40 条一批时约 5 批、最多 30 组
 */
export const PROPOSE_BATCH_OBSERVATIONS = 40;
/** 一批估的输出 token：约三条观察一组，组数封顶 */
export const proposeOutputEstimate = (observations: number): number => Math.min(PROPOSE_MAX_GROUPS, Math.ceil(observations / 3)) * PROPOSE_OUTPUT_PER_GROUP;

export const PROPOSE_SYSTEM = `你是记忆系统的推理器，给一个人的行为和说法找竞争的解释。规则：
- 只根据给你的事实（每条有 fact_id），不编造；"别人转述"的不能当依据；
- 找"同一类现象"（比如在某类日子里多次拒绝某类活动），每组至少给两条互相竞争的解释（比如不喜欢这类活动 / 重视这类日子的自主安排 / 近期太忙太累 / 不喜欢活动内容）；
- 每条解释：tier 是 state（近期状态，要写 valid_to）、preference（偏好和目标）、need（稳定需求）、value（长期价值取向）之一；
  context 是它适用的场景标签；supports、refutes 列出支持它、反驳它的事实，每条写 target（fact_id）、weight（weak | strong | decisive，decisive 只给用户自己明说的）、rationale；
- 不要把一个场景的偏好推广到别的场景；先后不等于原因；
- 观察分批给你：只为"这一批的观察"出组，每组至少有一条观察是这一批的；"别的事实"只有摘要，可以当支持、反驳，也可以并进组的 observation_ids；"已经有的组"不要重复；
- 输出要紧凑：最多 ${PROPOSE_MAX_GROUPS} 组；每组 2 到 4 条解释；每条的 supports、refutes 各最多 4 条、只列最有力的；description、statement 各不超过 40 个字，rationale 不超过 20 个字；不要缩进换行。
只输出 JSON：{"groups": [{"observation_ids": [fact_id...], "description": "观察到了什么", "hypotheses": [{"tier", "statement", "context": [], "valid_to": ISO 或 null, "supports": [], "refutes": []}]}]}`;

export const PROBES_SYSTEM = `你是记忆系统的推理器，给一组竞争的解释设计判别性追问。规则：
- 每条追问只区分两条解释（discriminates 写它们的 claim_id），写下"找到了算支持哪一条"（if_found，不知道写 null）；
- 两条解释预期一样的问题没有判别力，不要出；问具体发生的事，不问动机（ask）；
- queries 是去记忆里检索用的 2 到 6 个短语。
只输出 JSON：{"probes": [{"discriminates": [claim_id, claim_id], "ask": "...", "queries": ["..."], "if_found": claim_id 或 null}]}`;

export const JUDGE_SYSTEM = `你是记忆系统的推理器，判断检索到的证据对几条竞争解释意味着什么。规则：
- 只用给你的证据（evidence_id）和解释（claim_id），不编造 id；usable 为 false 的（别人转述）不能当依据；
- 每条有用的证据写一条关联：claim_id、evidence_id、polarity（supports | refutes）、weight（weak | strong | decisive，decisive 只给用户自己明说的）、rationale；
- 什么都没找到就 found_evidence_ids 为空（搜不到不等于反驳）。
只输出 JSON：{"found_evidence_ids": [], "if_found": claim_id 或 null, "links": [{"claim_id", "evidence_id", "polarity", "weight", "rationale"}]}`;

const STATE_DAYS = 14;
/**
 * 输出上限（token）。192 号票第一次真跑：48 条证据、49 条事实时 propose 每次都写满 2000 被截断，一组假设都没出来；
 * 放到 8000（DeepSeek 对话接口的输出上限是 8K），追问、判定 800 → 2000
 */
export const PROPOSE_MAX_TOKENS = 8000;
export const PROBE_JUDGE_MAX_TOKENS = 2000;

/** 218：分批时同一类现象挨在一起——按谓词、肯定还是否定、场景、宾语排 */
const kindKey = (f: Fact) => [f.predicate, f.negated ? "1" : "0", f.context.toSorted().join("+"), f.object.type === "entity" ? f.object.id : JSON.stringify(f.object)].join("|");

function weightOf(v: unknown): LinkWeight | undefined {
  return (LINK_WEIGHTS as readonly unknown[]).includes(v) ? (v as LinkWeight) : undefined;
}

export class LlmReasoner implements Reasoner {
  readonly id: string;
  readonly exhaustive = false;
  private readonly model: ChatModel;
  /** 出假设一批最多几条新的观察（默认 PROPOSE_BATCH_OBSERVATIONS；测试可以改小） */
  readonly proposeBatch: number;

  constructor(model: ChatModel, options: { proposeBatch?: number } = {}) {
    this.model = model;
    this.id = `model:${model.name}`;
    this.proposeBatch = options.proposeBatch ?? PROPOSE_BATCH_OBSERVATIONS;
  }

  /** 给模型看的事实：本人能当依据的，带原话 */
  private factLine(f: Fact, view: RgView): string {
    const evidence = f.evidenceIds.map((id) => view.evidence(id)).filter((e) => e !== undefined);
    return JSON.stringify({
      fact_id: f.id,
      statement: f.statement,
      assertion: f.assertion,
      context: f.context,
      evidence: evidence.map((e) => ({ evidence_id: e.id, mode: e.mode, kind: e.kind, text: e.text })),
    });
  }

  /**
   * 218 号票：新的观察（还不在已有的组里）分批。没有新观察、能当依据的不到两条时没有批；不超过 proposeBatch 条是一批；
   * 多了按谓词、肯定还是否定、场景、宾语排（同一类现象挨在一起），切成一样大的几批，每批里照原来的顺序
   */
  proposeBatches(observations: readonly Fact[], ctx: Pick<ReasonerContext, "view" | "existingGroups" | "asked">): Fact[][] {
    const grouped = new Set((ctx.existingGroups ?? []).flatMap((g) => g.observationIds));
    const usable = observations.filter((f) => ctx.view.usableFact(f));
    // 272：问过、没变化的不再当这一批问（还在 usable 里：别的观察的请求里照样给摘要）
    const fresh = usable.filter((f) => !grouped.has(f.id) && !this.unchanged(ctx, "propose", f.id, () => observationSignature(f)));
    if (fresh.length === 0 || usable.length < 2) return [];
    if (fresh.length <= this.proposeBatch) return [fresh];
    const order = new Map(usable.map((f, i) => [f.id, i]));
    const byOrder = (a: Fact, b: Fact) => order.get(a.id)! - order.get(b.id)!;
    return chunkEvenly(fresh.toSorted((a, b) => kindKey(a).localeCompare(kindKey(b)) || byOrder(a, b)), this.proposeBatch).map((b) => b.toSorted(byOrder));
  }

  /** 272 号票：这一条问过、签名没变（不再当这一批问） */
  private unchanged(ctx: Pick<ReasonerContext, "asked">, step: AskStep, subject: string, signature: () => string): boolean {
    if (ctx.asked === undefined) return false;
    const before = ctx.asked.signature(step, subject);
    return before !== undefined && before === signature();
  }

  /** 一批的请求：这一批的观察写全（带原话），别的能当依据的事实只写摘要；已经有的组加上前面几批交回的组（prior） */
  proposeBatchRequest(batch: readonly Fact[], usable: readonly Fact[], ctx: Pick<ReasonerContext, "view" | "existingGroups">, prior: readonly unknown[] = []): ChatRequest {
    const inBatch = new Set(batch.map((f) => f.id));
    const priorLines = prior.flatMap((raw) => {
      const g = (raw ?? {}) as Record<string, unknown>;
      const ids = isStringArray(g.observation_ids) ? g.observation_ids : [];
      return ids.length > 0 ? [`- ${typeof g.description === "string" ? g.description : "（前一批出的组）"}（观察 ${ids.join("、")}）`] : [];
    });
    const existing = [...(ctx.existingGroups ?? []).map((g) => `- ${g.description}（观察 ${g.observationIds.join("、")}）`), ...priorLines];
    const others = usable.filter((f) => !inBatch.has(f.id)).map((f) => JSON.stringify({ fact_id: f.id, statement: f.statement, context: f.context }));
    return {
      purpose: "propose",
      system: PROPOSE_SYSTEM,
      user: [
        `现在：${ctx.view.at}`,
        `已经有的组（不要重复）：`,
        existing.join("\n") || "（没有）",
        `这一批的观察（${batch.length} 条，要你解释的）：`,
        ...batch.map((f) => this.factLine(f, ctx.view)),
        `别的事实（只有摘要；可以当支持、反驳，也可以并进组里）：`,
        others.join("\n") || "（没有）",
      ].join("\n"),
      maxTokens: PROPOSE_MAX_TOKENS,
    };
  }

  /** 出假设要发的请求（一批一个；llm/plan.ts 估费用用）；没有新观察是空的 */
  proposeRequests(observations: readonly Fact[], ctx: Pick<ReasonerContext, "view" | "existingGroups">): ChatRequest[] {
    const usable = observations.filter((f) => ctx.view.usableFact(f));
    return this.proposeBatches(observations, ctx).map((b) => this.proposeBatchRequest(b, usable, ctx));
  }

  async propose(observations: Fact[], ctx: ReasonerContext): Promise<HypothesisGroupDraft[]> {
    const usable = observations.filter((f) => ctx.view.usableFact(f));
    const batches = this.proposeBatches(observations, ctx);
    // 272：没进组、问过又没变化、这次没再问的观察记个数
    if (ctx.asked && ctx.stats) {
      const grouped = new Set((ctx.existingGroups ?? []).flatMap((g) => g.observationIds));
      const skipped = usable.filter((f) => !grouped.has(f.id) && this.unchanged(ctx, "propose", f.id, () => observationSignature(f))).length;
      if (skipped > 0) stageStats(ctx.stats.steps, "propose").unchanged += skipped;
    }
    if (batches.length === 0) return [];
    const { items, settled } = await askInBatches(
      this.model,
      {
        stage: "propose",
        listKey: "groups",
        unitLabel: "条观察",
        unitId: (f: Fact) => f.id,
        request: (units, prior) => this.proposeBatchRequest(units, usable, ctx, prior),
        covers: (item) => {
          const g = (item ?? {}) as Record<string, unknown>;
          return isStringArray(g.observation_ids) ? g.observation_ids : [];
        },
      },
      batches,
      batchContext(ctx),
    );
    // 272：问到了的交回账上（进没进组由 reflect 在这一步做完后看）
    const settledIds = new Set(settled);
    ctx.asked?.settle(
      "propose",
      batches.flat().flatMap((f) => (settledIds.has(f.id) ? [{ subject: f.id, signature: observationSignature(f) }] : [])),
    );
    const usableFacts = new Map(usable.map((f) => [f.id, f]));
    const groups: HypothesisGroupDraft[] = [];
    for (const raw of items) {
      const g = (raw ?? {}) as Record<string, unknown>;
      const drop = (reason: string, item: unknown = raw) => ctx.dropped.push({ stage: "propose", reason, item });
      const observationIds = (isStringArray(g.observation_ids) ? g.observation_ids : []).filter((id) => {
        if (usableFacts.has(id)) return true;
        drop(`伪造的或不能当依据的观察 id：${id}`, id);
        return false;
      });
      if (observationIds.length === 0) {
        drop("没有能当依据的观察");
        continue;
      }
      const lastTime = observationIds.map((id) => usableFacts.get(id)!).map((f) => f.eventTime ?? f.validFrom ?? f.observedAt).toSorted().at(-1)!;
      const hypotheses: HypothesisDraft[] = [];
      for (const rawH of Array.isArray(g.hypotheses) ? g.hypotheses : []) {
        const h = (rawH ?? {}) as Record<string, unknown>;
        if (!(CLAIM_TIERS as readonly unknown[]).includes(h.tier) || typeof h.statement !== "string" || h.statement.trim().length === 0) {
          drop("解释的层或陈述不合格", rawH);
          continue;
        }
        const tier = h.tier as ClaimTier;
        const links = [...this.links(h.supports, "supports", usableFacts, ctx), ...this.links(h.refutes, "refutes", usableFacts, ctx)];
        for (const id of observationIds) if (!links.some((l) => l.target === id)) links.push({ target: id, polarity: "supports", weight: "weak", rationale: `观察：${usableFacts.get(id)!.statement}` });
        const validFrom = usableFacts.get(observationIds[0]!)!.eventTime ?? null;
        let modelTo = typeof h.valid_to === "string" && /T/.test(h.valid_to) ? h.valid_to : null;
        // 204 号票：模型给的截止早于开始时写断言会被校验挡下、整次整理崩掉——不用它，照默认算，记进丢掉的
        if (modelTo && validFrom && compareTime(modelTo, validFrom) < 0) {
          drop(`有效期截止早于开始（${modelTo} < ${validFrom}），照默认算`, rawH);
          modelTo = null;
        }
        const validTo = modelTo ?? (tier === "state" ? addDays(lastTime, STATE_DAYS) : null);
        hypotheses.push({
          template: `model:${h.statement.trim().slice(0, 40)}`,
          tier,
          statement: h.statement.trim(),
          context: isStringArray(h.context) ? h.context.filter((t) => t.trim().length > 0) : [],
          validFrom,
          validTo: tier === "state" ? validTo : null,
          method: "abduction",
          links,
        });
      }
      if (hypotheses.length < 2) {
        drop("竞争的解释不到两条");
        continue;
      }
      const key = `model|${observationIds.toSorted().join("+")}`;
      if (groups.some((x) => x.key === key)) {
        drop("和前一批出的组观察一样，重复");
        continue;
      }
      groups.push({
        key,
        pattern: "model",
        params: {},
        description: typeof g.description === "string" && g.description.trim() ? g.description.trim() : `模型找出的一组（${observationIds.length} 条观察）`,
        observationIds,
        hypotheses,
      });
    }
    return groups;
  }

  /** 模型给的关联：目标得是给它的能当依据的事实；decisive 只给用户明说的 */
  private links(raw: unknown, polarity: "supports" | "refutes", facts: ReadonlyMap<string, Fact>, ctx: ReasonerContext): TargetLink[] {
    const out: TargetLink[] = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      const l = (item ?? {}) as Record<string, unknown>;
      const fact = typeof l.target === "string" ? facts.get(l.target) : undefined;
      let weight = weightOf(l.weight);
      if (!fact || !weight) {
        ctx.dropped.push({ stage: "propose", reason: !fact ? `伪造的或不能当依据的目标 id：${String(l.target)}` : `多重不认得：${String(l.weight)}`, item });
        continue;
      }
      if (weight === "decisive" && fact.assertion !== "user_stated") weight = "strong";
      out.push({ target: fact.id, polarity, weight, rationale: typeof l.rationale === "string" ? l.rationale : "" });
    }
    return out;
  }

  probesRequest(group: GroupView): ChatRequest {
    const members = group.members.filter((m) => m.claim.status !== "retracted").map((m) => JSON.stringify({ claim_id: m.claim.id, tier: m.claim.tier, statement: m.claim.statement }));
    return { purpose: "probes", system: PROBES_SYSTEM, user: `观察：${group.description}\n竞争的解释：\n${members.join("\n")}`, maxTokens: PROBE_JUDGE_MAX_TOKENS };
  }

  async probesFor(group: GroupView, ctx: ReasonerContext): Promise<ProbeDraft[]> {
    // 201 号票：往上抽的组用模型往上抽时一起写的追问（找到了算支持出这条追问的那一条），不再另问
    const written = this.liftProbes(group);
    if (written.length > 0) return written;
    if (!ctx.budget.take()) return [];
    const parsed = await this.ask(this.probesRequest(group), "probes", ctx);
    if (!parsed) return [];
    return (Array.isArray(parsed.probes) ? parsed.probes : []).flatMap((raw, i) => {
      const p = (raw ?? {}) as Record<string, unknown>;
      if (!isStringArray(p.discriminates) || typeof p.ask !== "string" || !isStringArray(p.queries)) {
        ctx.dropped.push({ stage: "probes", reason: "追问的字段不合格", item: raw });
        return [];
      }
      return [{ template: `model:probe:${i}`, discriminates: p.discriminates, ask: p.ask, queries: p.queries.slice(0, 6), ifFound: typeof p.if_found === "string" ? p.if_found : null }];
    });
  }

  judgeRequest(probe: Probe, group: GroupView, hits: readonly JudgeHit[], view: RgView): ChatRequest {
    const members = group.members.filter((m) => probe.discriminates.includes(m.claim.id) || m.claim.status !== "retracted").map((m) => JSON.stringify({ claim_id: m.claim.id, statement: m.claim.statement }));
    const evidence = hits.map((h) => JSON.stringify({ evidence_id: h.evidence.id, usable: view.usableEvidence(h.evidence.id), source_level: h.evidence.sourceLevel, mode: h.evidence.mode, text: h.evidence.text }));
    return {
      purpose: "judge",
      system: JUDGE_SYSTEM,
      user: `追问：${probe.ask}（区分 ${probe.discriminates.join("、")}）\n解释：\n${members.join("\n")}\n检索到的证据：\n${evidence.join("\n")}`,
      maxTokens: PROBE_JUDGE_MAX_TOKENS,
    };
  }

  async judge(probe: Probe, group: GroupView, hits: JudgeHit[], ctx: ReasonerContext): Promise<ProbeJudgement> {
    const none: ProbeJudgement = { outcome: "not_found", foundEvidenceIds: [], ifFound: null, links: [] };
    if (hits.length === 0 || !ctx.budget.take()) return none;
    const parsed = await this.ask(this.judgeRequest(probe, group, hits, ctx.view), "judge", ctx);
    if (!parsed) return none;
    const byId = new Map(hits.map((h) => [h.evidence.id, h.evidence]));
    const members = new Set(group.members.map((m) => m.claim.id));
    const links: LinkDraft[] = [];
    for (const item of Array.isArray(parsed.links) ? parsed.links : []) {
      const l = (item ?? {}) as Record<string, unknown>;
      const evidence = typeof l.evidence_id === "string" ? byId.get(l.evidence_id) : undefined;
      let weight = weightOf(l.weight);
      const ok = evidence && typeof l.claim_id === "string" && members.has(l.claim_id) && (l.polarity === "supports" || l.polarity === "refutes") && weight;
      if (!ok || !evidence || !weight) {
        ctx.dropped.push({ stage: "judge", reason: `伪造的 id 或字段不合格（证据 ${String(l.evidence_id)}、断言 ${String(l.claim_id)}）`, item });
        continue;
      }
      const usable = ctx.view.usableEvidence(evidence.id);
      if (weight === "decisive" && !(usable && evidence.mode === "say")) weight = "strong";
      const rationale = typeof l.rationale === "string" ? l.rationale : "";
      links.push(
        usable
          ? { claimId: l.claim_id as string, target: evidence.id, polarity: l.polarity as "supports" | "refutes", weight, rationale }
          : { claimId: l.claim_id as string, target: evidence.id, polarity: "context", weight: "weak", rationale: `${rationale}（别人转述，只当背景）` },
      );
    }
    const found = (isStringArray(parsed.found_evidence_ids) ? parsed.found_evidence_ids : []).filter((id) => {
      const ok = byId.has(id) && ctx.view.usableEvidence(id);
      if (!ok) ctx.dropped.push({ stage: "judge", reason: `伪造的或不能当依据的证据 id：${id}`, item: id });
      return ok;
    });
    const ifFound = typeof parsed.if_found === "string" && probe.discriminates.includes(parsed.if_found) ? parsed.if_found : null;
    return { outcome: found.length > 0 ? "found" : "not_found", foundEvidenceIds: found, ifFound, links };
  }

  // ---------- 往上抽、编策略（201 号票） ----------

  private graph: ReasoningGraph | undefined;

  /** 接上推理图谱：往上抽要看已有的组（引擎打开时接） */
  attachGraph(graph: ReasoningGraph): void {
    this.graph = graph;
  }

  /** 已有的、模型版建的往上抽的组（这一层、还成立的） */
  existingLiftGroups(level: LiftLevel): ExistingLiftGroup[] {
    const rg = this.graph;
    if (!rg) return [];
    return rg.registry
      .listGroups({ live: true })
      .filter((g) => g.pattern === `lift:${level}` && g.key.startsWith(`lift:${level}|model:`))
      .map((g) => ({
        key: g.key,
        description: g.description,
        params: g.params as Partial<ModelLiftParams>,
        premiseIds: g.observationIds,
        members: rg.registry
          .members(g.key)
          .map((m) => ({ claim: rg.store.getClaim(m.claimId), template: m.template, links: rg.store.linksOf(m.claimId) }))
          .filter((m): m is { claim: NonNullable<typeof m.claim>; template: string; links: typeof m.links } => m.claim !== undefined)
          .map((m) => ({ claim: m.claim, template: m.template, links: m.links.filter((l) => l.polarity !== "context").map((l) => ({ target: l.target, polarity: l.polarity, weight: l.weight, rationale: l.rationale })) })),
      }));
  }

  /** 往上抽要发的请求（一批一个；--dry-run 估费用用）；门槛不过、没有新的下层断言时是空的 */
  liftRequests(level: LiftLevel, inputs: readonly LiftInput[], view: RgView, existing: readonly ExistingLiftGroup[] = [], covered: ReadonlySet<string> = new Set()): ChatRequest[] {
    return liftBatches(inputs, covered).flatMap((focus) => liftRequest(level, inputs, view, existing, covered, { focus }) ?? []);
  }

  /**
   * 往上抽（见 rg/llm-lift.ts）：已有的组还够门槛的照旧交回；还有没被用上的下层断言、而且全体够门槛时才问模型，
   * 模型交回的每组再按门槛判一次。扣 reflect 的预算
   */
  async lift(level: LiftLevel, inputs: LiftInput[], ctx: ReasonerContext): Promise<HypothesisGroupDraft[]> {
    const existing = this.existingLiftGroups(level);
    const { drafts, covered } = reemitLiftGroups(level, inputs, ctx.view, existing);
    const kept = existing.filter((g) => drafts.some((d) => d.key === g.key));
    const notAsked = liftNotAskedReason(level, inputs, ctx.view, covered);
    const gate = ctx.stats?.lift;
    if (notAsked !== undefined) {
      // 218：问之前这一层全体就没过门槛（或者没有新的下层断言），按"层：原因"记数
      if (gate && inputs.length > 0) gate.notAsked[`${level}：${notAsked}`] = (gate.notAsked[`${level}：${notAsked}`] ?? 0) + 1;
      return drafts;
    }
    // 272：没被用上的下层断言里，问过、没变化的不再当这一批问（别的批里照样给摘要，可以一起归组）；都没变就这一层不问
    const step: AskStep = `lift:${level}`;
    const fresh = inputs.filter((i) => !covered.has(i.claim.id));
    const changed = fresh.filter((i) => !this.unchanged(ctx, step, i.claim.id, () => premiseSignature(i)));
    if (ctx.stats && changed.length < fresh.length) stageStats(ctx.stats.steps, "lift").unchanged += fresh.length - changed.length;
    if (changed.length === 0) {
      if (gate) gate.notAsked[`${level}：下层断言没有变化`] = (gate.notAsked[`${level}：下层断言没有变化`] ?? 0) + 1;
      return drafts;
    }
    const batches = liftBatches(changed);
    const { items, asked, settled } = await askInBatches(
      this.model,
      {
        stage: "lift",
        listKey: "groups",
        unitLabel: "条下层断言",
        unitId: (i: LiftInput) => i.claim.id,
        request: (units, prior) => liftRequest(level, inputs, ctx.view, kept, covered, { focus: units, prior }),
        covers: (item) => {
          const g = (item ?? {}) as Record<string, unknown>;
          return isStringArray(g.premise_ids) ? g.premise_ids : [];
        },
      },
      batches,
      batchContext(ctx),
    );
    // 272：问到了的交回账上（进没进组由 reflect 在这一层做完后看）
    const settledIds = new Set(settled);
    ctx.asked?.settle(
      step,
      batches.flat().flatMap((i) => (settledIds.has(i.claim.id) ? [{ subject: i.claim.id, signature: premiseSignature(i) }] : [])),
    );
    if (asked === 0) return drafts;
    const themeOfGroup = (key: string) => {
      const theme = this.graph?.registry.getGroup(key)?.params.theme;
      return typeof theme === "string" ? theme : undefined;
    };
    return [...drafts, ...parseLiftOutput(level, { groups: items }, inputs, ctx.view, { existingKeys: new Set(existing.map((g) => g.key)), themeOfGroup, dropped: ctx.dropped, gate: ctx.stats?.lift })];
  }

  /** 往上抽的组：模型写好的追问换成断言 id */
  private liftProbes(group: GroupView): ProbeDraft[] {
    if (!group.pattern.startsWith("lift:")) return [];
    const probes = (group.params as Partial<ModelLiftParams>).model?.probes ?? [];
    const byTemplate = new Map(group.members.map((m) => [m.template, m.claim.id]));
    return probes.flatMap((p, i) => {
      const a = byTemplate.get(p.template);
      const b = byTemplate.get(p.against);
      return a && b ? [{ template: `model:lift-probe:${i}`, discriminates: [a, b], ask: p.ask, queries: p.queries, ifFound: a }] : [];
    });
  }

  /**
   * 编交互策略（见 rg/llm-strategies.ts）：一次请求写好几个依据（多于 STRATEGY_BATCH_BASES 个分批）；扣 reflect 剩下的预算。
   * 一次都没问成（预算不够）时什么都不交，留给下次
   */
  async writeStrategies(bases: StrategyBasisInput[], ctx: Pick<ReasonerContext, "budget" | "dropped" | "stats">): Promise<WrittenStrategy[]> {
    if (bases.length === 0) return [];
    const { items, asked } = await askInBatches(
      this.model,
      {
        stage: "strategies",
        listKey: "strategies",
        unitLabel: "个依据",
        unitId: (b: StrategyBasisInput) => b.key,
        request: (units) => strategyRequest(units),
        covers: (item) => {
          const key = ((item ?? {}) as Record<string, unknown>).key;
          return typeof key === "string" ? [key] : [];
        },
      },
      chunkEvenly(bases, STRATEGY_BATCH_BASES),
      batchContext(ctx),
    );
    return asked === 0 ? [] : parseStrategies({ strategies: items }, bases, ctx.dropped);
  }

  /** 追问、判证据：一次请求整段解析，解析不了的丢掉（218 号票只记数：调用、截断、解析不了、空回答） */
  private async ask(request: ChatRequest, stage: DroppedOutput["stage"], ctx: Pick<ReasonerContext, "dropped" | "stats">): Promise<Record<string, unknown> | undefined> {
    const response = await this.model.complete(request);
    countOutcome(stageStats(ctx.stats?.steps, stage), response);
    try {
      return parseModelJson(response.content);
    } catch (err) {
      ctx.dropped.push({ stage, reason: unparsedReason(response, request, err) });
      return undefined;
    }
  }
}

/** 分批问模型用的预算、丢掉的输出、统计 */
const batchContext = (ctx: Pick<ReasonerContext, "budget" | "dropped" | "stats">): BatchContext => ({ budget: ctx.budget, dropped: ctx.dropped, stats: ctx.stats?.steps });
