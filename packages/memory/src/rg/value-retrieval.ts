// 为任务调出相关的用户模型（196 号票）：relevantUserModel(task, { at, context, k })。
//
// 需求、价值层的断言（195 号票）挂在偏好断言上、字面又抽象，D 组检索原来的两条路（191 的 relevantClaims，202 号票换成了这里的
// 三条路加相关门槛）——命中的原话、事实直接挂着的断言，问题里的词出现在断言原文里——很难找到它们。这里三条路，用 RRF（k = 60，三条路等权）合并：
// - 往上走（upward）：任务检索（hybrid_kg）→ 命中的原话、事实挂着的断言 → 顺着推断往上（偏好 → 需求 → 价值，inferencesByPremise）。
//   这条路的分数是"有几条命中、排得多靠前"（每条命中 1/名次，同一条命中对一条断言只算一次）；
// - 结论索引（index）：任务文字直接搜断言陈述的关键词（FTS5 trigram + 短词子串扫描）和向量（余弦 ≥ 0.5 才算，照二狗秘书工具的语义门槛），
//   两路先 RRF 成一个名次；
// - 领域（domain）：任务归到领域（rg/domains.ts 的词表），和断言的领域对上；对上的领域多的在前，同样多的断言自己领域少（更专一）的在前。
// 只要在 at 成立的断言（有效期覆盖 at；状态 active，或 superseded 而 at 还在它的有效期里——同用户模型快照）、场景对得上的
// （调用的人没给场景时，任务里明说了周末、工作日、假期的按它算："帮我安排下周六"不调出工作日的偏好）；
// contested 的（猜测）、active 但证据不够（置信度 low 的偏好、需求、价值）的单列在"还拿不准的"里，带真值状态、把握（330 号票 R5：
// 猜测也能用，标明是猜测）；retracted 的不要。330 号票：标着复核的照它的真值状态给，标上 needsReview。
// 每条带来路：哪条路、排第几、经过哪些下层断言（偏好、需求）、哪些命中的原话和事实。默认每层取最相关的 2 条（05 号调研）。
// 202 号票：回答层和 D 组检索拿它判"相关门槛"（rg/relevance.ts）——可以把已经做过的检索结果交进来（hits，往上走不再自己检索），
// 结果里另有三条路合并后的全部断言（fused）和每条的来路（traces），不只每层前 k 条。
import { toMs, validAt } from "../domain/time.ts";
import type { Claim, ClaimStatus, ClaimTier, Confidence } from "../domain/types.ts";
import type { Embedder } from "../embedding/embedder.ts";
import type { Hit } from "../retrieval/types.ts";
import { CONTEXT_DIMENSIONS, contextsCompatible } from "../kg/context.ts";
import { supportEvidence } from "../user-model/snapshot.ts";
import type { ClaimIndex } from "./claim-index.ts";
import { tagsInText, taskDomains, type Domain } from "./domains.ts";
import type { ReasoningGraph } from "./reasoning-graph.ts";
import type { RgView, UncertainEntry, UserModelEntry } from "./types.ts";

export type RouteName = "upward" | "index" | "domain";
export const ROUTES: readonly RouteName[] = ["upward", "index", "domain"];

/** 每层默认取几条（05 号调研：每条指令只注入最相关的两条） */
export const DEFAULT_PER_TIER = 2;
/** 往上走那条路取任务检索的前几条命中 */
export const UPWARD_HITS = 20;
/** 结论索引的向量那一路：余弦到这个数才算相关（照二狗秘书工具的语义门槛 0.5） */
export const CLAIM_VECTOR_MIN_COSINE = 0.5;
/** 三条路合并的 RRF k */
export const ROUTE_RRF_K = 60;

export interface RelevantUserModelOptions {
  /** 默认现在 */
  at?: string;
  /** 场景；不给时按任务里明说的日子（周末、工作日、假期）算，没说就不限 */
  context?: string[];
  /** 每层取几条，默认 2 */
  k?: number;
  /** 走哪几条路，默认三条都走（评测、消融看各条路的得失） */
  routes?: readonly RouteName[];
  /** 已经做过的任务检索（hybrid_kg，按名次）：给了就拿它当往上走的起点，不再自己检索（202 号票：回答、D 组检索和相关门槛用同一份） */
  hits?: readonly Hit[];
}

/** 一条断言是怎么被找到的 */
export interface RouteTrace {
  route: RouteName;
  /** 在这条路里排第几（1 起） */
  rank: number;
  /** 这条路给它的分数：往上走是命中的 1/名次之和；结论索引是两路 RRF 分；领域是对上几个 */
  score: number;
  /** 往上走：命中的原话（按名次） */
  hitEvidenceIds?: string[];
  /** 往上走：经过的事实 */
  factIds?: string[];
  /** 往上走：经过的下层断言（偏好、状态、需求，从下往上） */
  viaClaimIds?: string[];
  /** 结论索引：关键词、向量各排第几 */
  channels?: { keyword?: { rank: number; score: number }; vector?: { rank: number; score: number } };
  /** 领域：对上的领域 */
  domains?: Domain[];
}

export interface RelevantEntry extends UserModelEntry {
  status: ClaimStatus;
  domains: Domain[];
  /** 三条路的 RRF 分 */
  score: number;
  routes: RouteTrace[];
}

export interface RelevantUncertain extends UncertainEntry {
  label: UserModelEntry["label"];
  confidence: Confidence;
  domains: Domain[];
  score: number;
  routes: RouteTrace[];
}

export interface RelevantUserModel {
  task: string;
  at: string;
  context: string[];
  /** 场景是调用的人给的、从任务里认出来的，还是没有 */
  contextFrom: "given" | "task" | "none";
  /** 任务归到的领域 */
  domains: Domain[];
  state: RelevantEntry[];
  preferences: RelevantEntry[];
  needs: RelevantEntry[];
  values: RelevantEntry[];
  /** 还拿不准的（contested 猜测、已验证但证据不够），每层最多 k 条；330 号票（R5）：可以照着说、推荐，把握低的留余地 */
  uncertain: RelevantUncertain[];
  /** 每条路自己找到的断言（能用的那些，按这条路的名次）：评测、演示看各条路的得失 */
  routes: Record<RouteName, string[]>;
  /** 三条路合并后的全部断言（能用的那些，按 RRF 分），不按层截（202 号票：相关门槛要看全部） */
  fused: string[];
  /** 上面每条断言的来路（同 entries 里的 routes） */
  traces: Record<string, RouteTrace[]>;
}

const LABEL: Record<Claim["epistemic"], UserModelEntry["label"]> = { explicit: "user_stated", inferred: "inferred", user_confirmed: "user_confirmed" };
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const TIER_RANK: Record<ClaimTier, number> = { state: 0, preference: 1, need: 2, value: 3 };

/** 在 at 成立：有效期覆盖 at；active、contested，或者 superseded 而有到期时间（那时成立）。330 号票：标着复核的照真值状态算 */
export function heldAt(claim: Claim, at: string): boolean {
  if (!validAt(claim, at)) return false;
  if (claim.status === "active" || claim.status === "contested") return true;
  return claim.status === "superseded" && claim.validTo !== null;
}

/** 证据不够：置信度 low 的偏好、需求、价值（近期状态可以是 low，标出来） */
export function isThin(claim: Claim): boolean {
  return claim.confidence === "low" && claim.tier !== "state";
}

interface Reach {
  hits: Map<string, number>;
  facts: Set<string>;
  via: Set<string>;
}

/** 往上走：命中 → 挂着的断言 → 顺着推断往上。返回每条断言的来路 */
async function upwardRoute(
  rg: ReasoningGraph,
  task: string,
  at: string,
  context: readonly string[],
  view: RgView,
  eligible: (c: Claim) => boolean,
  given?: readonly Hit[],
): Promise<Map<string, Reach>> {
  const store = rg.store;
  const hits = given ?? (await rg.baseSearch(task, { at, context: context.length > 0 ? [...context] : undefined, limit: UPWARD_HITS }));
  const reach = new Map<string, Reach>();
  const entry = (id: string) => {
    let r = reach.get(id);
    if (!r) {
      r = { hits: new Map(), facts: new Set(), via: new Set() };
      reach.set(id, r);
    }
    return r;
  };
  hits.forEach((hit, i) => {
    const e = store.getEvidence(hit.evidenceId);
    if (!e || e.status === "forgotten" || toMs(e.observedAt) > toMs(at)) return;
    const weight = 1 / (i + 1);
    const factIds = [...new Set([...hit.via.factIds, ...view.factsOfEvidence(hit.evidenceId).map((f) => f.id)])];
    for (const target of [hit.evidenceId, ...factIds]) {
      for (const link of store.linksTo(target)) {
        if (link.polarity === "context") continue;
        const r = entry(link.claimId);
        r.hits.set(hit.evidenceId, Math.max(r.hits.get(hit.evidenceId) ?? 0, weight));
        if (target !== hit.evidenceId) r.facts.add(target);
      }
    }
  });
  // 顺着推断往上：只从在 at 成立的断言往上走（待复核、撤回的不当路）；推断图是有向无环的，改到不再变为止
  const queue = [...reach.keys()];
  let guard = 0;
  while (queue.length > 0 && guard++ < 10_000) {
    const id = queue.shift()!;
    const claim = store.getClaim(id);
    const from = reach.get(id);
    if (!claim || !from || !eligible(claim)) continue;
    for (const inf of store.inferencesByPremise(id)) {
      if (inf.status === "retracted") continue;
      const to = entry(inf.conclusionClaimId);
      const before = `${to.hits.size}|${to.facts.size}|${to.via.size}`;
      for (const [ev, w] of from.hits) to.hits.set(ev, Math.max(to.hits.get(ev) ?? 0, w));
      for (const f of from.facts) to.facts.add(f);
      for (const v of from.via) to.via.add(v);
      to.via.add(id);
      if (`${to.hits.size}|${to.facts.size}|${to.via.size}` !== before) queue.push(inf.conclusionClaimId);
    }
  }
  return reach;
}

/** 一组 RRF：每条路排好的 id，按名次给 1 / (k + 名次) */
function rrf(lists: readonly (readonly string[])[], k = ROUTE_RRF_K): Map<string, { score: number; best: number }> {
  const out = new Map<string, { score: number; best: number }>();
  for (const list of lists) {
    list.forEach((id, i) => {
      const cur = out.get(id) ?? { score: 0, best: Number.POSITIVE_INFINITY };
      cur.score += 1 / (k + i + 1);
      cur.best = Math.min(cur.best, i + 1);
      out.set(id, cur);
    });
  }
  return out;
}

const byFused = (a: [string, { score: number; best: number }], b: [string, { score: number; best: number }]) =>
  Math.abs(b[1].score - a[1].score) > 1e-12 ? b[1].score - a[1].score : a[1].best - b[1].best || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

export async function relevantUserModel(rg: ReasoningGraph, index: ClaimIndex, embedder: Embedder | undefined, task: string, options: RelevantUserModelOptions = {}): Promise<RelevantUserModel> {
  const store = rg.store;
  const at = options.at ?? store.now();
  const daytypes = CONTEXT_DIMENSIONS.daytype!;
  const fromTask = tagsInText(task).filter((t) => daytypes.includes(t));
  const context = options.context ?? fromTask;
  const contextFrom: RelevantUserModel["contextFrom"] = options.context !== undefined ? "given" : fromTask.length > 0 ? "task" : "none";
  const k = options.k ?? DEFAULT_PER_TIER;
  const routes = new Set(options.routes ?? ROUTES);
  index.sync();
  const view = rg.view(at);
  const domains = taskDomains(task, context);
  const fits = (c: Claim) => c.context.length === 0 || context.length === 0 || contextsCompatible(c.context, context);
  const eligible = (c: Claim) => heldAt(c, at) && fits(c);
  const eligibleId = (id: string) => {
    const c = store.getClaim(id);
    return c !== undefined && eligible(c);
  };
  const traces = new Map<string, RouteTrace[]>();
  const trace = (id: string, t: RouteTrace) => traces.set(id, [...(traces.get(id) ?? []), t]);
  const routeLists: Record<RouteName, string[]> = { upward: [], index: [], domain: [] };

  // ---- 往上走 ----
  if (routes.has("upward")) {
    // 往上走时只要求下层断言在 at 成立，不要求场景对得上：周末的偏好照样是"重视自主安排"的依据
    const reach = await upwardRoute(rg, task, at, context, view, (c) => heldAt(c, at), options.hits);
    const ranked = [...reach.entries()]
      .filter(([id]) => eligibleId(id))
      .map(([id, r]) => ({ id, r, score: [...r.hits.values()].reduce((s, w) => s + w, 0) }))
      .toSorted((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    ranked.forEach(({ id, r, score }, i) => {
      const via = [...r.via]
        .map((v) => store.getClaim(v))
        .filter((c): c is Claim => c !== undefined && heldAt(c, at))
        .toSorted((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || (a.id < b.id ? -1 : 1))
        .map((c) => c.id);
      trace(id, {
        route: "upward",
        rank: i + 1,
        score,
        hitEvidenceIds: [...r.hits.entries()].toSorted((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([ev]) => ev),
        factIds: [...r.facts].toSorted(),
        viaClaimIds: via,
      });
    });
    routeLists.upward = ranked.map((x) => x.id);
  }

  // ---- 结论索引：关键词 + 向量，先合成一个名次 ----
  if (routes.has("index")) {
    const keyword = index.keywordRank(task, eligibleId);
    let vector: { id: string; score: number }[] = [];
    if (embedder?.available()) {
      await index.indexVectors(embedder);
      const [q] = await embedder.embedQueries([task]);
      vector = index.vectorRank(embedder.model, q!, eligibleId).filter((s) => s.score >= CLAIM_VECTOR_MIN_COSINE);
    }
    const fused = [...rrf([keyword.map((s) => s.id), vector.map((s) => s.id)]).entries()].toSorted(byFused);
    fused.forEach(([id, f], i) => {
      const kw = keyword.findIndex((s) => s.id === id);
      const vec = vector.findIndex((s) => s.id === id);
      const channels: NonNullable<RouteTrace["channels"]> = {};
      if (kw >= 0) channels.keyword = { rank: kw + 1, score: keyword[kw]!.score };
      if (vec >= 0) channels.vector = { rank: vec + 1, score: vector[vec]!.score };
      trace(id, { route: "index", rank: i + 1, score: f.score, channels });
    });
    routeLists.index = fused.map(([id]) => id);
  }

  // ---- 领域 ----
  if (routes.has("domain") && domains.length > 0) {
    const ranked = [...index.allDomains().entries()]
      .filter(([id]) => eligibleId(id))
      .map(([id, ds]) => {
        const shared = ds.filter((d) => domains.includes(d));
        const claim = store.getClaim(id)!;
        return { id, shared, focus: ds.length === 0 ? 0 : shared.length / ds.length, claim };
      })
      .filter((x) => x.shared.length > 0)
      .toSorted(
        (a, b) =>
          b.shared.length - a.shared.length ||
          b.focus - a.focus ||
          CONFIDENCE_RANK[b.claim.confidence] - CONFIDENCE_RANK[a.claim.confidence] ||
          Number(b.claim.status === "active") - Number(a.claim.status === "active") ||
          (a.id < b.id ? -1 : 1),
      );
    ranked.forEach(({ id, shared }, i) => trace(id, { route: "domain", rank: i + 1, score: shared.length, domains: shared }));
    routeLists.domain = ranked.map((x) => x.id);
  }

  // ---- 三条路 RRF 合并，分层 ----
  const fused = [...rrf([routeLists.upward, routeLists.index, routeLists.domain]).entries()].toSorted(byFused);
  const model: RelevantUserModel = {
    task,
    at,
    context,
    contextFrom,
    domains,
    state: [],
    preferences: [],
    values: [],
    needs: [],
    uncertain: [],
    routes: routeLists,
    fused: fused.map(([id]) => id),
    traces: Object.fromEntries(fused.map(([id]) => [id, (traces.get(id) ?? []).toSorted((a, b) => ROUTES.indexOf(a.route) - ROUTES.indexOf(b.route))])),
  };
  const uncertainCount: Record<ClaimTier, number> = { state: 0, preference: 0, need: 0, value: 0 };
  const allDomains = index.allDomains();
  for (const [id, f] of fused) {
    const claim = store.getClaim(id)!;
    const routesOf = (traces.get(id) ?? []).toSorted((a, b) => ROUTES.indexOf(a.route) - ROUTES.indexOf(b.route));
    const evidenceIds = supportEvidence(store, id, view);
    const claimDomainList = allDomains.get(id) ?? [];
    if (claim.status === "contested" || (claim.status === "active" && isThin(claim))) {
      if (uncertainCount[claim.tier] >= k) continue;
      uncertainCount[claim.tier] += 1;
      const competitors = claim.competesWith
        .map((cid) => store.getClaim(cid))
        .filter((c): c is Claim => c !== undefined && c.status !== "retracted")
        .map((c) => ({ claimId: c.id, statement: c.statement, status: c.status }));
      model.uncertain.push({
        claimId: id,
        statement: claim.statement,
        tier: claim.tier,
        reason: claim.status === "contested" ? "contested" : "thin",
        status: claim.status,
        competesWith: competitors.map((c) => c.claimId),
        competitors,
        evidenceIds,
        label: LABEL[claim.epistemic],
        confidence: claim.confidence,
        domains: claimDomainList,
        score: f.score,
        routes: routesOf,
        ...(claim.needsReview ? { needsReview: true } : {}),
      });
      continue;
    }
    const bucket = claim.tier === "state" ? model.state : claim.tier === "preference" ? model.preferences : claim.tier === "need" ? model.needs : model.values;
    if (bucket.length >= k) continue;
    const entry: RelevantEntry = {
      claimId: id,
      statement: claim.statement,
      tier: claim.tier,
      label: LABEL[claim.epistemic],
      confidence: claim.confidence,
      evidenceIds,
      context: claim.context,
      validFrom: claim.validFrom,
      validTo: claim.validTo,
      status: claim.status,
      domains: claimDomainList,
      score: f.score,
      routes: routesOf,
    };
    if (claim.tier === "state" && claim.confidence === "low") entry.lowConfidence = true;
    if (claim.needsReview) entry.needsReview = true;
    bucket.push(entry);
  }
  return model;
}
