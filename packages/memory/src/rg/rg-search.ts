// search(mode = hybrid_kg_rg)：第 6 节 D 组 = C 组（hybrid_kg）加推理图谱。
// - 第一轮：hybrid_kg 的结果；问题过了相关门槛的断言（202 号票，rg/relevance.ts：196 号票的三条路里至少一条命中、名次在前几名），
//   里面直接说到这件事的（往上走、结论索引命中的）取最相关的几条（成立的和还拿不准的），把它们的支持证据和反证一起带上；
//   只是领域对上的（同一方面）不算真命中，不带；
// - "为什么"类问题再跑这些假设那几组的判别性追问做第二轮检索（只检索、不写图谱），最多两轮，没有新证据就停。
// 一条都没过门槛时就是 C 组的结果（同样的顺序），不硬挑一组塞证据。
// 推理图谱带来的命中都记在 probe 这一路：via.probeIds 是经过的追问，claimIds 是经过的假设。
import { toMs } from "../domain/time.ts";
import type { Claim } from "../domain/types.ts";
import { contextsCompatible } from "../kg/context.ts";
import { compareFused } from "../retrieval/rrf.ts";
import type { Hit, SearchOptions } from "../retrieval/types.ts";
import { FALLBACK_RRF_K } from "./fallback-search.ts";
import { isWhyQuestion } from "./question.ts";
import type { ReasoningGraph } from "./reasoning-graph.ts";
import { relevantForQuestion, type GatedClaim } from "./relevance.ts";

/** D 组的命中：多记一项经过哪些假设 */
export type RgHit = Hit & { via: Hit["via"] & { claimIds?: string[] } };

/** D 组最多带几条断言的证据 */
export const RG_SEARCH_MAX_CLAIMS = 4;

/**
 * 过了门槛的断言里，D 组带证据的那几条：直接说到这件事的（往上走、结论索引命中的；只是领域对上、同一方面的不算"真命中"），
 * 按三条路合并的顺序，最多 RG_SEARCH_MAX_CLAIMS 条
 */
export function claimsForSearch(rg: ReasoningGraph, gated: readonly GatedClaim[]): Claim[] {
  return gated
    .filter((g) => g.direct)
    .map((g) => rg.store.getClaim(g.claimId))
    .filter((c): c is Claim => c !== undefined)
    .slice(0, RG_SEARCH_MAX_CLAIMS);
}

export async function searchWithReasoning(rg: ReasoningGraph, query: string, options: SearchOptions): Promise<RgHit[]> {
  const at = options.at ?? rg.store.now();
  const limit = options.limit ?? 10;
  const { mode: _mode, ...rest } = options;
  const base = await rg.baseSearch(query, { ...rest, limit: limit * 2 });
  const { gated } = await relevantForQuestion(rg, query, { at, context: options.context }, base);
  return expandWithClaims(rg, query, options, base, claimsForSearch(rg, gated));
}

/**
 * 在 C 组的结果（base，按名次）上加这几条断言的支持证据和反证，"为什么"类再跑它们那几组的追问。
 * claims 是空的时就是 base 的前 limit 条（和 C 组一样）。回答层（answer.ts）算过门槛以后直接调它，不再算一遍。
 */
export async function expandWithClaims(rg: ReasoningGraph, query: string, options: SearchOptions, base: readonly Hit[], claims: readonly Claim[]): Promise<RgHit[]> {
  const at = options.at ?? rg.store.now();
  const limit = options.limit ?? 10;
  if (claims.length === 0) return base.slice(0, limit).map(plain);
  const view = rg.view(at);
  const fused = new Map<string, RgHit>(base.map((h) => [h.evidenceId, plain(h)]));
  const keep = (id: string) => {
    const e = rg.store.getEvidence(id);
    if (!e || e.status === "forgotten") return false;
    if (options.at !== undefined && toMs(e.observedAt) > toMs(options.at)) return false;
    return !options.context || options.context.length === 0 || contextsCompatible(e.context, options.context);
  };

  // 第一轮：命中的假设的支持证据和反证
  const ranked: { evidenceId: string; claimId: string; factId: string | null }[] = [];
  for (const claim of claims) {
    const links = rg.store.linksOf(claim.id).filter((l) => l.polarity !== "context");
    for (const link of [...links.filter((l) => l.polarity === "supports"), ...links.filter((l) => l.polarity === "refutes")]) {
      const fact = rg.store.getFact(link.target);
      for (const ev of rg.evidenceOfTarget(link.target, view)) ranked.push({ evidenceId: ev, claimId: claim.id, factId: fact ? fact.id : null });
    }
  }
  let rank = 0;
  const seen = new Set<string>();
  for (const r of ranked) {
    if (!keep(r.evidenceId)) continue;
    const hit = fused.get(r.evidenceId) ?? newHit(rg, r.evidenceId);
    if (!hit) continue;
    if (!seen.has(r.evidenceId)) {
      seen.add(r.evidenceId);
      rank += 1;
      hit.channels.probe = { rank, score: 1 };
      hit.fused += 1 / (FALLBACK_RRF_K + rank);
    }
    if (!hit.via.claimIds!.includes(r.claimId)) hit.via.claimIds!.push(r.claimId);
    if (r.factId && !hit.via.factIds.includes(r.factId)) hit.via.factIds.push(r.factId);
    fused.set(r.evidenceId, hit);
  }

  // 第二轮："为什么"类跑这些假设那几组的追问（只检索），没有新证据就停
  if (isWhyQuestion(query)) {
    const groups = new Set(claims.map((c) => rg.registry.memberOf(c.id)?.groupKey).filter((k): k is string => k !== undefined));
    for (const key of groups) {
      for (const { probeId } of rg.registry.probesOf(key)) {
        const probe = rg.store.getProbe(probeId);
        if (!probe) continue;
        for (const h of await rg.probeSearch(probe.queries, at, probeId)) {
          if (!keep(h.evidenceId) || seen.has(h.evidenceId)) {
            const existing = fused.get(h.evidenceId);
            if (existing && !existing.via.probeIds.includes(probeId)) existing.via.probeIds.push(probeId);
            continue;
          }
          seen.add(h.evidenceId);
          rank += 1;
          const hit = fused.get(h.evidenceId) ?? newHit(rg, h.evidenceId);
          if (!hit) continue;
          hit.channels.probe = { rank, score: h.fused };
          hit.fused += 1 / (FALLBACK_RRF_K + rank);
          if (!hit.via.probeIds.includes(probeId)) hit.via.probeIds.push(probeId);
          fused.set(h.evidenceId, hit);
        }
      }
    }
  }
  return [...fused.values()].toSorted((a, b) => compareFused({ ...a, id: a.evidenceId }, { ...b, id: b.evidenceId })).slice(0, limit);
}

/** C 组的一条命中抄一份当 D 组的（还没经过假设） */
const plain = (h: Hit): RgHit => ({ ...h, channels: { ...h.channels }, via: { ...h.via, factIds: [...h.via.factIds], probeIds: [...h.via.probeIds], claimIds: [] } });

function newHit(rg: ReasoningGraph, evidenceId: string): RgHit | undefined {
  const e = rg.store.getEvidence(evidenceId);
  return e ? { evidenceId, sourceLevel: e.sourceLevel, channels: {}, fused: 0, via: { factIds: [], probeIds: [], claimIds: [] } } : undefined;
}
