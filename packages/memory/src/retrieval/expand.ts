// 图扩展（C 组，第 6 节）：从问题里认出实体（名字和别名），沿事实图谱走一跳到两跳，事实的证据加入候选。
// - 认实体：问题里包含某个实体的名字或别名（2 个字以上，不分大小写）就算；一个名字被另一个更长的名字盖住时（"朋友"在"见朋友"里）只算长的；
//   用户本人（我、本人）不算，几乎每条事实都连着他。
// - 走图用 KnowledgeGraph.neighbors（188 号票），走到用户本人就停、不往外扩；只走在 at 成立、场景对得上的事实。
// - 分数照 Mem0 的实体加权：碰到认出的实体的事实（一跳）每条记 1，经过别的实体再走一步的（两跳）记 0.5，
//   一条证据的分是它所在事实的分加起来；这一路和别的路一起 RRF。
import { USER_ENTITY_ID } from "../domain/ids.ts";
import type { Entity, Fact } from "../domain/types.ts";
import type { KnowledgeGraph } from "../kg/graph.ts";
import type { Scored } from "./keyword.ts";

export const HOP_WEIGHTS: Readonly<Record<1 | 2, number>> = { 1: 1, 2: 0.5 };

/** 问题里认出的实体（按实体建的先后） */
export function recognizeEntities(query: string, kg: KnowledgeGraph): Entity[] {
  const q = query.toLowerCase();
  const matches: { entity: Entity; name: string }[] = [];
  for (const entity of kg.store.listEntities()) {
    if (entity.id === USER_ENTITY_ID) continue;
    const names = [entity.name, ...entity.aliases].map((n) => n.trim().toLowerCase()).filter((n) => Array.from(n).length >= 2 && q.includes(n));
    if (names.length === 0) continue;
    matches.push({ entity, name: names.toSorted((a, b) => b.length - a.length)[0]! });
  }
  return matches.filter((m) => !matches.some((o) => o.entity.id !== m.entity.id && o.name.length > m.name.length && o.name.includes(m.name))).map((m) => m.entity);
}

export interface GraphRanking {
  items: Scored[];
  /** 证据 → 经过的事实、认出的实体 */
  via: Map<string, { factIds: Set<string>; entityIds: Set<string> }>;
}

/**
 * 从认出的实体走一跳、两跳。factOk：事实能不能用（状态、有效期、场景、发生时间）；evidenceOk：证据能不能用（没被忘掉、来源等级）。
 * at、context 也交给 neighbors，走第二跳时只经过能用的事实。
 */
export function graphRank(
  kg: KnowledgeGraph,
  entities: readonly Entity[],
  options: { at?: string; context?: readonly string[] },
  factOk: (f: Fact) => boolean,
  evidenceOk: (id: string) => boolean,
): GraphRanking {
  const scores = new Map<string, number>();
  const via = new Map<string, { factIds: Set<string>; entityIds: Set<string> }>();
  for (const entity of entities) {
    const hood = kg.neighbors(entity.id, 2, { at: options.at, context: options.context, stopAt: [USER_ENTITY_ID] });
    for (const fact of hood.facts) {
      if (!factOk(fact)) continue;
      const touches = fact.subjectId === entity.id || (fact.object.type === "entity" && fact.object.id === entity.id);
      const weight = HOP_WEIGHTS[touches ? 1 : 2];
      for (const ev of fact.evidenceIds) {
        if (!evidenceOk(ev)) continue;
        scores.set(ev, (scores.get(ev) ?? 0) + weight);
        const v = via.get(ev) ?? { factIds: new Set<string>(), entityIds: new Set<string>() };
        v.factIds.add(fact.id);
        v.entityIds.add(entity.id);
        via.set(ev, v);
      }
    }
  }
  const items = [...scores.entries()].map(([id, score]) => ({ id, score })).toSorted((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { items, via };
}
