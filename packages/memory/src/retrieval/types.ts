// 检索的接口形状（第 6 节）。188 号票定形状，190 号票（③）实现 vector / hybrid / hybrid_kg 三种模式（search.ts），
// hybrid_kg_rg（D 组）留接口 ReasoningRetrieval，由 ④ 号票的推理图谱填。
import type { EvidenceStatus, SourceLevel } from "../domain/types.ts";

/** 四组消融：A 只用向量、B 关键词加向量融合、C 再加事实图谱扩展、D 再加推理图谱 */
export const SEARCH_MODES = ["vector", "hybrid", "hybrid_kg", "hybrid_kg_rg"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/**
 * 场景怎么用（194 号票）：soft（默认）场景对不上的不扔、只往后排（每一路给它的票乘 contextPenalty）；strict 是 190 的硬过滤，对不上的直接不要。
 * 理由：场景标签常常不全，直接扔会把别的场景里的反证也扔掉，和推理图谱"主动找反证"的目标相反。
 */
export const CONTEXT_MODES = ["soft", "strict"] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];

/** 搜哪一层：只搜原话（证据）/ 只搜精炼陈述（事实的 statement，命中后经 evidenceIds 回到原话）/ 两层都搜（用户 2026-10-20 提） */
export const SEARCH_LAYERS = ["evidence", "statement", "both"] as const;
export type SearchLayers = (typeof SEARCH_LAYERS)[number];

export interface SearchOptions {
  mode: SearchMode;
  /**
   * 有效期：只要在这个时间成立的事实（validFrom ≤ at < validTo，状态是成立过的），管精炼陈述和图扩展两路。
   * 原话没有有效期，不按它过滤（"以前喜欢"那条原话问"现在"时照样能找到，只是没有事实那两路给它加分）。不填 = 不按有效期过滤。
   */
  at?: string;
  /** 发生时间 [起, 止)：原话按证据的发生时间，事实按事实的发生时间；不知道发生时间的不要 */
  eventRange?: [string, string];
  /**
   * 场景：和它重叠（kg/context.ts 的 contextsCompatible）或者不限场景（没写场景）的原话、事实算对得上。
   * 对不上的怎么办看 contextMode：soft（默认）往后排，strict 不要。
   */
  context?: string[];
  /** 场景对不上的：soft（默认，194 号票）只往后排；strict 直接不要（190 的做法） */
  contextMode?: ContextMode;
  /** soft 时场景对不上的命中，这一路给它的票（RRF 分；A 组是余弦）乘的系数，默认 0.5 */
  contextPenalty?: number;
  /**
   * 两层都搜时，精炼陈述那两路（fact_keyword、fact_vector）在 RRF 里的权重，默认 0.5（原话两路 1.0，194 号票）。
   * 精炼陈述是从原话派生的，可能漏、可能错，不能压过原话。只搜一层时不管；A 组不做 RRF，也不管。
   */
  statementWeight?: number;
  /** 搜哪一层，默认两层 */
  layers?: SearchLayers;
  /** 只要这些来源等级的证据；不填 = 都要（命中里带着来源等级，"只有本人能当依据"由用的人判） */
  sourceLevels?: SourceLevel[];
  /** 结果条数，默认 10 */
  limit?: number;
}

/** 每路的名次和分数（原话、精炼陈述各有关键词和向量两路；graph 是事实图谱扩展；probe 留给 ④ 号票的追问） */
export type SearchChannel = "evidence_keyword" | "evidence_vector" | "fact_keyword" | "fact_vector" | "graph" | "probe";

export interface ChannelScore {
  /** 这一路里的名次，从 1 起 */
  rank: number;
  /** 这一路自己的分：关键词是 bm25（越大越相关），向量是余弦，图扩展是实体命中的权重 */
  score: number;
  /** 场景对不上、这一路给它的票打了折（soft 场景模式，194 号票）；对得上的不写 */
  offContext?: true;
}

export interface Hit {
  /** 命中的原话；命中精炼陈述的经事实的 evidenceIds 回到原话，按证据去重 */
  evidenceId: string;
  sourceLevel: SourceLevel;
  /** 证据的状态：active 或 corrected（被纠正的原文留着当记录；被忘掉的不会出现）。检索总会填 */
  status?: EvidenceStatus;
  channels: Partial<Record<SearchChannel, ChannelScore>>;
  /** 融合分：B、C 组是 RRF（各路 权重 / (60 + 名次) 加起来，场景对不上的那一路再乘系数），A 组是余弦（对不上的乘系数） */
  fused: number;
  /** 经过哪些事实、哪些追问、问题里认出的哪些实体找到的（entityIds 检索总会填） */
  via: { factIds: string[]; probeIds: string[]; entityIds?: string[] };
}

/** C 组（hybrid_kg）的检索，给 D 组在上面加东西用；其余选项照传 */
export type BaseSearch = (query: string, options: Omit<SearchOptions, "mode">) => Promise<Hit[]>;

/**
 * D 组（hybrid_kg_rg，第 6 节）：④ 号票的推理图谱实现。拿到 C 组的检索函数，问题命中已有假设时把支持和反证一起带上，
 * "为什么"类问题跑判别性追问做第二轮检索（命中记在 probe 这一路、via.probeIds），最多两轮，没有新证据就停。
 * 接到引擎上：MemoryEngine.open({ reasoningRetrieval }) 或 engine.setReasoningRetrieval()。没接时 hybrid_kg_rg 退回引擎自带的推理图谱
 * （engine.search 走 ReasoningGraph.search，rg/rg-search.ts），不抛错。
 */
export interface ReasoningRetrieval {
  search(query: string, options: SearchOptions, base: BaseSearch): Promise<Hit[]>;
}
