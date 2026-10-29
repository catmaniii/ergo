// 相关门槛（202 号票）：假设、断言、检索结果要和问题相关到一定程度才拿来用；对不上就当没有，不硬挑一组。
//
// 一条检索结果算"命中"（hitSupported）——检索这一层总会给满 limit 条，排在前面不等于相关：
// - 原话或它在 at 成立的事实的精炼陈述里有问题的话题词（question.ts 的 topicTerms：去掉"喜欢、是不是、为什么"这类问法里的词）；
// - 或者事实图谱扩展那一路带来的（问题里认出了实体）、推理图谱那一路带来的（经过已经过了门槛的假设）；
// - 或者向量那一路的余弦超过这个问题的向量门槛（205 号票）：问题和自带背景语料（background.ts，200 条和谁都无关的日常短句）的
//   余弦分布的第 95 百分位——比随便一句闲聊更像才算挨着。门槛跟着向量模型和问题走，不用固定的数（202 用的 0.5 在 bge-m3 上
//   分不开相关不相关：字面对不上的也在 0.46–0.54）；没有向量函数时向量那一路不算命中。
//   206 号票加第二道：还要在这个人自己库里的记录里排得靠前——问题和库里全部证据（没忘掉、at 以前知道的）的余弦取第 90 百分位，
//   超过它、或者进了前 3（库小时第 90 百分位就是最高那一两条，进前 3 也算）。205 那道量的是"是不是在说自己"（背景是客观短句，
//   本人记录天然更像），这一道量的才是"是不是在说这件事"。两道都跟着模型和数据走，不对着答案调。
//
// 一条断言过门槛（gateClaims）：196 号票的三条路（往上走、结论索引、领域）里至少一条命中、名次在前几名（RelevanceGate，可配）：
// - 往上走：这条路是从检索结果出发的，名次看挂着它的检索结果——只算命中的（上面那条），至少有一条排在检索的前 hitRank 名
//   （默认 5，就是检索那条路回答里会说的条数）。不再按断言之间排名次：一组假设挂着好几条观察，分数总比只挂在第 1 条原话上的
//   明说断言高，按断言排会把后者挤掉；
// - 结论索引：断言陈述里有话题词，或者向量那一路的余弦超过这个问题的向量门槛（196 的结论索引本身只收余弦到 0.5 的，所以实际是
//   两个里大的那个）；按两路 RRF 分排，同分并列，名次到 topN；
// - 领域：领域那条路自己的排法（对上的领域多的、断言更专一的在前），名次到 topN。
// 往上走、结论索引命中的是"直接说到这件事的"（direct）；只有领域命中的是"同一方面的"——回答里只当背景列出，不靠它下结论
// （领域那条路本来是给任务调出"这方面适用的"断言用的，同一方面不等于回答了这个问题）。
import { toMs } from "../domain/time.ts";
import type { Claim } from "../domain/types.ts";
import type { Hit } from "../retrieval/types.ts";
import { EVIDENCE_VECTORS, vectorRank } from "../retrieval/vector.ts";
import { BACKGROUND_PERCENTILE, backgroundThreshold, percentile } from "./background.ts";
import { topicTerms } from "./question.ts";
import type { ReasoningGraph } from "./reasoning-graph.ts";
import type { GroupView, RgView } from "./types.ts";
import { ROUTES, type RelevantUserModel, type RelevantUserModelOptions, type RouteName, type RouteTrace } from "./value-retrieval.ts";

export interface RelevanceGate {
  /** 哪几条路算（默认三条都算） */
  routes: readonly RouteName[];
  /** 在一条路里排前几名才算（默认 3） */
  topN: number;
  /** 往上走：挂着它的、命中的检索结果至少有一条排在前几名（默认 5，检索那条路回答里会说的条数） */
  hitRank: number;
  /** 向量门槛取问题和背景语料余弦分布的第几百分位（默认 0.95，205 号票） */
  vectorPercentile: number;
  /** 第二道：问题和这个人自己库里全部证据的余弦取第几百分位（默认 0.9，206 号票） */
  ownPercentile: number;
  /** 第二道：库小时进了前几也算（默认 3） */
  ownTopK: number;
}

export const DEFAULT_RELEVANCE_GATE: RelevanceGate = { routes: ROUTES, topN: 3, hitRank: 5, vectorPercentile: BACKGROUND_PERCENTILE, ownPercentile: 0.9, ownTopK: 3 };

/** 第二道门槛（206 号票）：问题和自己库里全部证据的余弦分布 */
export interface OwnLibraryThreshold {
  /** 第 ownPercentile 百分位（最近名次法） */
  percentile: number;
  /** 第 ownTopK 高的那个余弦（库不到 ownTopK 条时是最低的那个） */
  kth: number;
  /** 算进来的证据条数 */
  size: number;
}

/** 一个问题的两道向量门槛（206 号票）：background 是 205 的背景语料那道，own 是自己库那道 */
export interface VectorGate {
  background: number | null;
  own: OwnLibraryThreshold | null;
}

/**
 * 余弦过不过向量门槛：两道都要过——超过背景那道，并且超过自己库的第 90 百分位、或者进了前 3（不低于第 3 高的那个）。
 * 没有向量函数、库里没有向量时不算。只给一个数时（205 的写法）超过它就算；null 不算。
 */
export function vectorPasses(gate: VectorGate | number | null, cos: number): boolean {
  if (gate === null) return false;
  if (typeof gate === "number") return cos > gate;
  if (gate.background === null || gate.own === null) return false;
  if (!(cos > gate.background)) return false;
  return cos > gate.own.percentile || cos >= gate.own.kth;
}

export function resolveGate(...overrides: (Partial<RelevanceGate> | undefined)[]): RelevanceGate {
  return Object.assign({}, DEFAULT_RELEVANCE_GATE, ...overrides.filter((o) => o !== undefined)) as RelevanceGate;
}

/**
 * 一条检索结果和问题挨不挨着（见文件开头）。topic 是问题的话题词；vector 是这个问题的向量门槛（questionVectorGate 的两道，
 * 或者 205 的一个数），余弦过了才算（vectorPasses），null 时向量那一路不算
 */
export function hitSupported(hit: Hit, topic: readonly string[], view: RgView, vector: VectorGate | number | null): boolean {
  const c = hit.channels;
  if (c.graph || c.probe) return true;
  const cos = Math.max(c.evidence_vector?.score ?? -1, c.fact_vector?.score ?? -1);
  if (vectorPasses(vector, cos)) return true;
  if (topic.length === 0) return false;
  const texts = [view.evidence(hit.evidenceId)?.text ?? "", ...view.factsOfEvidence(hit.evidenceId).map((f) => f.statement)];
  return texts.some((t) => topic.some((w) => t.includes(w)));
}

/**
 * 一条过了门槛的断言：经过哪几条路、名次多少（往上走是挂着它的命中的检索结果最好排第几）；
 * direct 是往上走或结论索引命中的（直接说到这件事），否则只是领域对上（同一方面）
 */
export interface GatedClaim {
  claimId: string;
  via: { route: RouteName; rank: number }[];
  direct: boolean;
}

/** 同分并列的名次：比它分高的有几条，加一 */
function competitionRanks(scores: Map<string, number>): Map<string, number> {
  const values = [...scores.values()];
  return new Map([...scores.entries()].map(([id, s]) => [id, 1 + values.filter((v) => v > s + 1e-12).length]));
}

/**
 * 按门槛筛 relevantUserModel 找到的断言（model.fused 的顺序）。base 是往上走那条路用的检索结果（交给 relevantUserModel 的 hits），
 * supported 判每条检索结果算不算命中；minCosine 是这个问题的向量门槛（两道或一个数，结论索引的向量那一路要过它，null 时不算）。
 */
export function gateClaims(
  model: RelevantUserModel,
  base: readonly Hit[],
  supported: (hit: Hit) => boolean,
  topic: readonly string[],
  statementOf: (claimId: string) => string,
  gate: RelevanceGate = DEFAULT_RELEVANCE_GATE,
  minCosine: VectorGate | number | null = null,
): GatedClaim[] {
  const routes = new Set(gate.routes);
  const rankOf = new Map(base.map((h, i) => [h.evidenceId, i + 1]));
  const ok = new Set(base.filter(supported).map((h) => h.evidenceId));
  const traceOf = (id: string, route: RouteName): RouteTrace | undefined => model.traces[id]?.find((t) => t.route === route);
  const passed = new Map<string, GatedClaim["via"]>();
  const pass = (id: string, route: RouteName, rank: number) => passed.set(id, [...(passed.get(id) ?? []), { route, rank }]);

  if (routes.has("upward")) {
    for (const id of model.fused) {
      const ranks = (traceOf(id, "upward")?.hitEvidenceIds ?? []).filter((ev) => ok.has(ev) && rankOf.has(ev)).map((ev) => rankOf.get(ev)!);
      if (ranks.length === 0) continue;
      const best = Math.min(...ranks);
      if (best <= gate.hitRank) pass(id, "upward", best);
    }
  }
  if (routes.has("index")) {
    const scores = new Map<string, number>();
    for (const id of model.fused) {
      const t = traceOf(id, "index");
      if (!t) continue;
      const statement = statementOf(id);
      const vector = t.channels?.vector;
      if ((vector && vectorPasses(minCosine, vector.score)) || topic.some((w) => statement.includes(w))) scores.set(id, t.score);
    }
    for (const [id, rank] of competitionRanks(scores)) if (rank <= gate.topN) pass(id, "index", rank);
  }
  if (routes.has("domain")) {
    for (const id of model.fused) {
      const t = traceOf(id, "domain");
      if (t && t.rank <= gate.topN) pass(id, "domain", t.rank);
    }
  }
  return model.fused.filter((id) => passed.has(id)).map((id) => {
    const via = passed.get(id)!.toSorted((a, b) => ROUTES.indexOf(a.route) - ROUTES.indexOf(b.route));
    return { claimId: id, via, direct: via.some((v) => v.route !== "domain") };
  });
}

/** 一个问题的相关断言：调 relevantUserModel（往上走用给的 base），再按门槛筛 */
export interface QuestionRelevance {
  model: RelevantUserModel;
  /** 问题的话题词 */
  topic: string[];
  /** 过了门槛的，按三条路合并的顺序 */
  gated: GatedClaim[];
  /** base 里算命中的检索结果 */
  supportedHitIds: string[];
  /** 背景语料那道向量门槛（205；和 vectorGate.background 一样）；没有向量函数时是 null */
  vectorThreshold: number | null;
  /** 两道向量门槛（206 号票） */
  vectorGate: VectorGate;
}

/**
 * 第二道门槛（206 号票）：问题（查询角色）和这个人自己库里全部证据的余弦——没忘掉的、给了 at 时 at 以前知道的，
 * 用引擎的向量函数这个模型算好的证据向量——取第 p 百分位和第 topK 高的。没有向量函数、库里没有这个模型的向量时是 null。
 */
export async function ownLibraryThreshold(rg: ReasoningGraph, question: string, at?: string, p?: number, topK?: number): Promise<OwnLibraryThreshold | null> {
  const cfg = resolveGate(rg.relevanceGate);
  const embedder = rg.embedder();
  if (!embedder || !embedder.available()) return null;
  const [q] = await embedder.embedQueries([question]);
  if (!q) return null;
  const store = rg.store;
  const allowed = (id: string) => {
    const e = store.getEvidence(id);
    return e !== undefined && e.status !== "forgotten" && (at === undefined || toMs(e.observedAt) <= toMs(at));
  };
  const values = vectorRank(store.db, EVIDENCE_VECTORS, embedder.model, q, allowed).map((s) => s.score);
  if (values.length === 0) return null;
  const k = topK ?? cfg.ownTopK;
  return { percentile: percentile(values, p ?? cfg.ownPercentile), kth: values[Math.min(k, values.length) - 1]!, size: values.length };
}

/** 这个问题的两道向量门槛（206 号票）：背景语料那道（205）和自己库那道 */
export async function questionVectorGate(rg: ReasoningGraph, question: string, at?: string, gate?: Partial<RelevanceGate>): Promise<VectorGate> {
  const cfg = resolveGate(rg.relevanceGate, gate);
  const background = await backgroundThreshold(rg.embedder(), question, cfg.vectorPercentile);
  const own = background === null ? null : await ownLibraryThreshold(rg, question, at, cfg.ownPercentile, cfg.ownTopK);
  return { background, own };
}

/**
 * 明说优先（205）收紧（206 号票）：那句明说的话要和挑到的那组说的是同一件事，三条满足一条就算——
 * observations：它的支持证据和那组的观察是同一批证据（"最近周末想好好休息"和"这周六的聚会我就不去了"是同一句话）；
 * topic：它的陈述里有问题的话题词；
 * relevance：它自己的陈述过了相关门槛（结论索引那条路命中），不只是往上走挂在一条命中的原话上进来的。
 * via 是它过门槛时经过的路（GatedClaim.via）。
 */
export function explicitSameMatter(
  rg: ReasoningGraph,
  claim: Claim,
  group: GroupView,
  topic: readonly string[],
  via: readonly { route: RouteName; rank: number }[],
): { same: boolean; by: "observations" | "topic" | "relevance" | null } {
  const store = rg.store;
  const observationEvidence = new Set(group.observationIds.flatMap((id) => store.getFact(id)?.evidenceIds ?? []));
  const own = new Set<string>();
  for (const l of store.linksOf(claim.id)) {
    if (l.polarity !== "supports") continue;
    if (group.observationIds.includes(l.target)) return { same: true, by: "observations" };
    const fact = store.getFact(l.target);
    for (const id of fact ? fact.evidenceIds : [l.target]) own.add(id);
  }
  if ([...own].some((id) => observationEvidence.has(id))) return { same: true, by: "observations" };
  if (topic.some((w) => claim.statement.includes(w))) return { same: true, by: "topic" };
  if (via.some((v) => v.route === "index")) return { same: true, by: "relevance" };
  return { same: false, by: null };
}

export async function relevantForQuestion(
  rg: ReasoningGraph,
  question: string,
  options: Pick<RelevantUserModelOptions, "at" | "context" | "k"> & { gate?: Partial<RelevanceGate> },
  base: readonly Hit[],
): Promise<QuestionRelevance> {
  const at = options.at ?? rg.store.now();
  const view = rg.view(at);
  const topic = topicTerms(question);
  const gate = resolveGate(rg.relevanceGate, options.gate);
  const model = await rg.relevantUserModel(question, { at, context: options.context, k: options.k, hits: base });
  const vectorGate = await questionVectorGate(rg, question, options.at, gate);
  const supported = (h: Hit) => hitSupported(h, topic, view, vectorGate);
  const gated = gateClaims(model, base, supported, topic, (id) => rg.store.getClaim(id)?.statement ?? "", gate, vectorGate);
  return { model, topic, gated, supportedHitIds: base.filter(supported).map((h) => h.evidenceId), vectorThreshold: vectorGate.background, vectorGate };
}

