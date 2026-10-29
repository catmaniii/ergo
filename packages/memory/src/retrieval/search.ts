// 混合检索（第 6 节）：vector（A 组）、hybrid（B 组）、hybrid_kg（C 组）三种模式；hybrid_kg_rg（D 组）由引擎交给 ④ 号票的推理图谱。
//
// 每种模式都能选搜哪一层（layers）：原话（证据）、精炼陈述（事实的 statement），或两层。命中精炼陈述的经事实的 evidenceIds 回到原话，
// 结果按证据去重。各路：
//   evidence_keyword / fact_keyword：关键词（keyword.ts：3 字词 FTS5 bm25，2 字词子串扫描）；
//   evidence_vector / fact_vector：余弦（vector.ts）；
//   graph：图扩展（expand.ts，只有 C 组）。
// - A 组只用向量两路，融合分是余弦（两层都搜时一条证据取两层里高的那个），不做 RRF；
// - B、C 组各路（每路最多取前 DEPTH 条）用 RRF（k = 60）融合。两层都搜时精炼陈述那两路权重 0.5、原话两路 1.0（194 号票：
//   精炼陈述是从原话派生的，可能漏、可能错，不能压过原话）；图扩展那一路 1.0（它是 C 组要量的东西）。
// 过滤（调用的人给了才过滤，A 组也一样；评测里 A 组不给）：
// - 来源等级、证据状态（被忘掉的不要，被纠正的留着、命中里标 corrected）：所有路；
// - 发生时间范围：原话两路按证据的，精炼陈述和图扩展按事实的；
// - 有效期 at：只管事实（精炼陈述、图扩展），原话没有有效期；
// - 场景（194 号票）：默认 soft，对不上的不扔、只往后排——每一路照常排，场景对不上的命中这一路给它的票乘 contextPenalty（默认 0.5）；
//   contextMode = "strict" 是 190 的硬过滤。原话两路看证据的标签，精炼陈述看给它名次的那条事实的场景（按分句定，比证据的标签准），
//   图扩展看带出它的事实（都对不上才算对不上）。没写场景的照常。
import type { Evidence, Fact } from "../domain/types.ts";
import { toMs, validAt } from "../domain/time.ts";
import type { Embedder } from "../embedding/embedder.ts";
import { contextsCompatible } from "../kg/context.ts";
import type { KnowledgeGraph } from "../kg/graph.ts";
import { HELD_STATUSES } from "../store/store.ts";
import { graphRank, recognizeEntities } from "./expand.ts";
import { EVIDENCE_KEYWORDS, FACT_KEYWORDS, keywordRank, type Scored } from "./keyword.ts";
import { compareFused, fuseRrf, type Fused, type RankedList } from "./rrf.ts";
import { queryTerms } from "./terms.ts";
import type { ContextMode, Hit, SearchChannel, SearchOptions } from "./types.ts";
import { EVIDENCE_VECTORS, FACT_VECTORS, vectorRank } from "./vector.ts";

/** 每一路最多取前几条进融合 */
export const DEPTH = 50;
export const DEFAULT_LIMIT = 10;
/** 两层都搜时精炼陈述那两路的 RRF 权重（原话两路 1.0）。194 号票按原则定，不对着题调；模型版抽取覆盖率上去以后再评 */
export const DEFAULT_STATEMENT_WEIGHT = 0.5;
/** 场景默认往后排，不扔（194 号票） */
export const DEFAULT_CONTEXT_MODE: ContextMode = "soft";
/** soft 时场景对不上的命中乘的系数：打对折，一条对不上的要在两路里都排到前面，才抵得上一条对得上、只在一路排前面的 */
export const DEFAULT_CONTEXT_PENALTY = 0.5;

type Ranked = Scored & { offContext?: boolean };

export class Retriever {
  private readonly kg: KnowledgeGraph;
  private readonly embedder: Embedder | undefined;

  constructor(kg: KnowledgeGraph, embedder?: Embedder) {
    this.kg = kg;
    this.embedder = embedder;
  }

  async search(query: string, options: SearchOptions): Promise<Hit[]> {
    const { mode } = options;
    if (mode === "hybrid_kg_rg") throw new Error("hybrid_kg_rg 由引擎交给推理图谱（MemoryEngine.search）");
    const layers = options.layers ?? "both";
    const useEvidence = layers !== "statement";
    const useFacts = layers !== "evidence";
    const limit = options.limit ?? DEFAULT_LIMIT;
    const store = this.kg.store;
    const db = store.db;

    const vectorsOn = this.embedder !== undefined && this.embedder.available();
    if (mode === "vector" && !vectorsOn) throw new Error(`vector 模式要向量函数：${this.embedder ? this.embedder.unavailableHint() : "打开引擎时没给 embedder"}`);

    // ---- 过滤 ----
    const evidenceCache = new Map<string, Evidence | undefined>();
    const evidence = (id: string) => {
      if (!evidenceCache.has(id)) evidenceCache.set(id, store.getEvidence(id));
      return evidenceCache.get(id);
    };
    const factCache = new Map<string, Fact | undefined>();
    const fact = (id: string) => {
      if (!factCache.has(id)) factCache.set(id, store.getFact(id));
      return factCache.get(id);
    };
    const range = options.eventRange ? ([toMs(options.eventRange[0]), toMs(options.eventRange[1])] as const) : undefined;
    const inRange = (t: string | null) => range === undefined || (t !== null && toMs(t) >= range[0] && toMs(t) < range[1]);
    const levels = options.sourceLevels ? new Set(options.sourceLevels) : undefined;
    const context = options.context;
    const strict = (options.contextMode ?? DEFAULT_CONTEXT_MODE) === "strict";
    const penalty = options.contextPenalty ?? DEFAULT_CONTEXT_PENALTY;
    /** 场景对得上（没给场景、没写场景的都算对得上） */
    const sceneOk = (tags: readonly string[]) => context === undefined || contextsCompatible(tags, context);
    /** 证据本身能不能出现（所有路） */
    const evidenceBase = (id: string) => {
      const e = evidence(id);
      return e !== undefined && e.status !== "forgotten" && (levels === undefined || levels.has(e.sourceLevel));
    };
    /** 原话两路：再看证据的发生时间；strict 时还要场景对得上 */
    const evidenceOk = (id: string) => {
      if (!evidenceBase(id)) return false;
      const e = evidence(id)!;
      return inRange(e.eventTime) && (!strict || sceneOk(e.context));
    };
    const factUsable = (f: Fact) => HELD_STATUSES.includes(f.status) && (options.at === undefined || validAt(f, options.at)) && inRange(f.eventTime) && (!strict || sceneOk(f.context));
    const factOk = (id: string) => {
      const f = fact(id);
      return f !== undefined && factUsable(f);
    };
    /** soft：原话那两路按证据的标签标出对不上的（strict 时对不上的已经滤掉了） */
    const markEvidence = (items: Scored[]): Ranked[] => items.map((item) => (sceneOk(evidence(item.id)!.context) ? item : { ...item, offContext: true }));

    // ---- 各路 ----
    const lists: RankedList[] = [];
    const via = new Map<string, { factIds: Set<string>; entityIds: Set<string> }>();
    const viaOf = (ev: string) => {
      let v = via.get(ev);
      if (!v) via.set(ev, (v = { factIds: new Set(), entityIds: new Set() }));
      return v;
    };
    /**
     * 精炼陈述的命中换成原话：按事实的名次，每条事实的证据依次排进来（去重），记下经过的事实。
     * 场景对不对得上看给它名次的那条事实（第一次带出它的）。
     */
    const toEvidence = (facts: Scored[]): Ranked[] => {
      const out: Ranked[] = [];
      const seen = new Set<string>();
      for (const item of facts) {
        const f = fact(item.id)!;
        const off = !sceneOk(f.context);
        for (const ev of f.evidenceIds) {
          if (!evidenceBase(ev)) continue;
          viaOf(ev).factIds.add(item.id);
          if (seen.has(ev)) continue;
          seen.add(ev);
          out.push(off ? { id: ev, score: item.score, offContext: true } : { id: ev, score: item.score });
        }
      }
      return out;
    };

    if (vectorsOn) {
      const [q] = await this.embedder!.embedQueries([query]);
      const model = this.embedder!.model;
      if (useEvidence) lists.push({ channel: "evidence_vector", items: markEvidence(vectorRank(db, EVIDENCE_VECTORS, model, q!, evidenceOk).slice(0, DEPTH)) });
      if (useFacts) lists.push({ channel: "fact_vector", items: toEvidence(vectorRank(db, FACT_VECTORS, model, q!, factOk).slice(0, DEPTH)) });
    }
    if (mode !== "vector") {
      const terms = queryTerms(query);
      if (useEvidence) lists.push({ channel: "evidence_keyword", items: markEvidence(keywordRank(db, EVIDENCE_KEYWORDS, terms, evidenceOk).slice(0, DEPTH)) });
      if (useFacts) lists.push({ channel: "fact_keyword", items: toEvidence(keywordRank(db, FACT_KEYWORDS, terms, factOk).slice(0, DEPTH)) });
    }
    if (mode === "hybrid_kg") {
      const entities = recognizeEntities(query, this.kg);
      // soft 时走图不按场景挡（第二跳也能经过别的场景的事实），带出来以后再看场景
      const graph = graphRank(this.kg, entities, { at: options.at, context: strict ? context : undefined }, factUsable, evidenceBase);
      for (const [ev, v] of graph.via) {
        const mine = viaOf(ev);
        for (const f of v.factIds) mine.factIds.add(f);
        for (const e of v.entityIds) mine.entityIds.add(e);
      }
      const items: Ranked[] = graph.items.slice(0, DEPTH).map((item) => ([...graph.via.get(item.id)!.factIds].some((f) => sceneOk(fact(f)!.context)) ? item : { ...item, offContext: true }));
      lists.push({ channel: "graph", items });
    }

    // ---- 融合 ----
    const statementWeight = layers === "both" ? (options.statementWeight ?? DEFAULT_STATEMENT_WEIGHT) : 1;
    const fused =
      mode === "vector"
        ? maxCosine(lists, penalty)
        : fuseRrf(lists, { weights: { fact_keyword: statementWeight, fact_vector: statementWeight }, offContextFactor: penalty });
    return fused.slice(0, limit).map((f) => {
      const e = evidence(f.id)!;
      const v = via.get(f.id);
      return {
        evidenceId: f.id,
        sourceLevel: e.sourceLevel,
        status: e.status,
        channels: f.channels,
        fused: f.fused,
        via: { factIds: v ? [...v.factIds] : [], probeIds: [], entityIds: v ? [...v.entityIds] : [] },
      };
    });
  }
}

/** A 组：不做 RRF，一条证据的分是它在各路里最高的余弦（场景对不上的那一路先乘系数） */
function maxCosine(lists: readonly RankedList[], penalty: number): Fused[] {
  const out = new Map<string, Fused>();
  for (const list of lists) {
    list.items.forEach((item, i) => {
      const f = out.get(item.id) ?? { id: item.id, fused: -Infinity, channels: {} };
      // 往后排：正的余弦乘系数，负的除以系数（都是变小）
      const score = !item.offContext ? item.score : item.score >= 0 ? item.score * penalty : item.score / penalty;
      f.fused = Math.max(f.fused, score);
      f.channels[list.channel as SearchChannel] = item.offContext ? { rank: i + 1, score: item.score, offContext: true } : { rank: i + 1, score: item.score };
      out.set(item.id, f);
    });
  }
  return [...out.values()].toSorted(compareFused);
}
