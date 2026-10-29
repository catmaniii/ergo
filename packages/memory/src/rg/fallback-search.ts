// 追问检索的临时实现：③ 号票（190）的 search() 还没合进来时，推理图谱用它顶上（188 已有的关键词表和邻接查询）。
// 形状和 search() 一样（retrieval/types.ts 的 Hit），三路：
// - evidence_keyword：原话的关键词（3 个字及以上走 FTS5 trigram，更短的退回子串扫描，同二狗的做法）；
// - fact_keyword：精炼陈述的关键词，命中的事实经 evidenceIds 回到原话；
// - graph：查询里认出的实体，取它的事实（在 at 成立的），事实的证据加进来；
// 按 RRF（k = 60）融合。没有向量。③ 合进来以后 ReasoningGraph.baseSearch 自动改走 search(mode = hybrid_kg)，这个文件只在 search 报"还没做"时用。
import { USER_ENTITY_ID } from "../domain/ids.ts";
import { toMs, validAt } from "../domain/time.ts";
import type { Evidence } from "../domain/types.ts";
import { CONTEXT_KEYWORDS, contextsCompatible } from "../kg/context.ts";
import { DEFAULT_LEXICON, lexiconIndex, type Lexicon } from "../kg/lexicon.ts";
import type { Hit, SearchChannel, SearchOptions } from "../retrieval/types.ts";
import { HELD_STATUSES, type MemoryStore } from "../store/store.ts";

export const FALLBACK_RRF_K = 60;
const DEFAULT_LIMIT = 10;
/** 查询短于这个长度就整个当一个词；更长的从里面认词 */
const WHOLE_TERM_CHARS = 6;

export type FallbackSearchOptions = Omit<SearchOptions, "mode">;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const ftsPhrase = (s: string) => `"${s.replaceAll('"', '""')}"`;

/** 查询里的词：按空白和顿号切开；短的整个算一个词，长的从里面认词表、实体名、场景词、状态词 */
export function fallbackQueryTerms(query: string, store: MemoryStore, lexicon: Lexicon = DEFAULT_LEXICON): string[] {
  const terms = new Set<string>();
  const vocabulary = [
    ...lexiconIndex(lexicon).map((t) => t.term),
    ...store.listEntities().flatMap((e) => (e.id === USER_ENTITY_ID ? [] : [e.name, ...e.aliases])),
    ...Object.values(CONTEXT_KEYWORDS).flat(),
    ...Object.values(lexicon.states).flat(),
  ].filter((t) => t.length >= 2);
  for (const part of query.split(/[\s,，、;；|/？?。！!]+/).map((p) => p.trim()).filter((p) => p.length > 0)) {
    if (part.length <= WHOLE_TERM_CHARS) {
      terms.add(part);
      continue;
    }
    for (const t of vocabulary) if (part.includes(t)) terms.add(t);
  }
  return [...terms];
}

/** 一路的结果：证据 id → 分数（命中的词数），和经过的事实 */
interface Channel {
  scores: Map<string, number>;
  via: Map<string, Set<string>>;
}

function newChannel(): Channel {
  return { scores: new Map(), via: new Map() };
}

function bump(c: Channel, evidenceId: string, by = 1, factId?: string): void {
  c.scores.set(evidenceId, (c.scores.get(evidenceId) ?? 0) + by);
  if (factId) {
    const set = c.via.get(evidenceId) ?? new Set<string>();
    set.add(factId);
    c.via.set(evidenceId, set);
  }
}

export function fallbackSearch(store: MemoryStore, query: string, options: FallbackSearchOptions = {}, lexicon: Lexicon = DEFAULT_LEXICON): Hit[] {
  const terms = fallbackQueryTerms(query, store, lexicon);
  const channels: Partial<Record<SearchChannel, Channel>> = { evidence_keyword: newChannel(), fact_keyword: newChannel(), graph: newChannel() };
  const factUsable = (f: { status: string; validFrom: string | null; validTo: string | null }) =>
    (HELD_STATUSES as readonly string[]).includes(f.status) && (options.at === undefined || validAt(f, options.at));

  for (const term of terms) {
    // 原话
    const evidenceIds =
      term.length >= 3
        ? store.db.all<{ evidence_id: string }>("SELECT evidence_id FROM evidence_fts WHERE evidence_fts MATCH ?", ftsPhrase(term)).map((r) => r.evidence_id)
        : store.db.all<{ id: string }>("SELECT id FROM evidence WHERE status != 'forgotten' AND text LIKE ? ESCAPE '\\'", `%${escapeLike(term)}%`).map((r) => r.id);
    for (const id of new Set(evidenceIds)) bump(channels.evidence_keyword!, id);
    // 精炼陈述
    const factIds =
      term.length >= 3
        ? store.db.all<{ fact_id: string }>("SELECT fact_id FROM fact_fts WHERE fact_fts MATCH ?", ftsPhrase(term)).map((r) => r.fact_id)
        : store.db.all<{ id: string }>("SELECT id FROM facts WHERE status != 'retracted' AND statement LIKE ? ESCAPE '\\'", `%${escapeLike(term)}%`).map((r) => r.id);
    for (const factId of new Set(factIds)) {
      const fact = store.getFact(factId);
      if (!fact || !factUsable(fact)) continue;
      for (const ev of fact.evidenceIds) bump(channels.fact_keyword!, ev, 1, fact.id);
    }
    // 图：认出的实体 → 它的事实 → 证据
    const entity = store.findEntityByName(term);
    if (entity && entity.id !== USER_ENTITY_ID) {
      for (const fact of store.factsTouching(entity.id)) {
        if (!factUsable(fact)) continue;
        for (const ev of fact.evidenceIds) bump(channels.graph!, ev, 1, fact.id);
      }
    }
  }

  // 过滤：没被忘掉、那时已经知道、场景和发生时间对得上
  const keep = (e: Evidence | undefined): e is Evidence => {
    if (!e || e.status === "forgotten") return false;
    if (options.at !== undefined && toMs(e.observedAt) > toMs(options.at)) return false;
    if (options.context !== undefined && options.context.length > 0 && !contextsCompatible(e.context, options.context)) return false;
    if (options.eventRange) {
      const t = e.eventTime ?? e.observedAt;
      if (toMs(t) < toMs(options.eventRange[0]) || toMs(t) > toMs(options.eventRange[1])) return false;
    }
    return true;
  };

  const fused = new Map<string, Hit>();
  for (const [name, channel] of Object.entries(channels) as [SearchChannel, Channel][]) {
    const ranked = [...channel.scores.entries()].filter(([id]) => keep(store.getEvidence(id))).toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    ranked.forEach(([id, score], i) => {
      const evidence = store.getEvidence(id)!;
      const hit = fused.get(id) ?? { evidenceId: id, sourceLevel: evidence.sourceLevel, channels: {}, fused: 0, via: { factIds: [], probeIds: [] } };
      hit.channels[name] = { rank: i + 1, score };
      hit.fused += 1 / (FALLBACK_RRF_K + i + 1);
      for (const f of channel.via.get(id) ?? []) if (!hit.via.factIds.includes(f)) hit.via.factIds.push(f);
      fused.set(id, hit);
    });
  }
  return [...fused.values()].toSorted((a, b) => b.fused - a.fused || a.evidenceId.localeCompare(b.evidenceId)).slice(0, options.limit ?? DEFAULT_LIMIT);
}
