// 关键词这一路（原话的 evidence_fts、精炼陈述的 fact_fts 各一份）：
// - 3 个字的词走 FTS5 trigram 索引，用 bm25() 打分（FTS5 给的是越小越相关，这里取负数，越大越相关），几个词之间是 OR；
// - 2 个字的词、说人状态的单字（192 号票：忙、累……）trigram 查不了，照二狗的做法退回子串扫描：扫一遍索引里的正文，用和 FTS5 bm25() 同一个公式
//   （k1 = 1.2、b = 0.75，idf 为负时取 1e-6）按出现次数、文档长度打分，所以两部分的分数量纲一样，可以直接加；
// - 被忘掉的证据、撤回的事实本来就不在索引里（store.ts 维护）。时间、场景、来源等级由调用的人给的 allowed 过滤。
import type { Database } from "../store/sqlite.ts";
import type { QueryTerms } from "./terms.ts";

const K1 = 1.2;
const B = 0.75;

export interface KeywordIndex {
  table: "evidence_fts" | "fact_fts";
  idColumn: "evidence_id" | "fact_id";
}

export const EVIDENCE_KEYWORDS: KeywordIndex = { table: "evidence_fts", idColumn: "evidence_id" };
export const FACT_KEYWORDS: KeywordIndex = { table: "fact_fts", idColumn: "fact_id" };

export interface Scored {
  id: string;
  score: number;
}

function occurrences(text: string, term: string): number {
  let n = 0;
  for (let i = text.indexOf(term); i >= 0; i = text.indexOf(term, i + term.length)) n += 1;
  return n;
}

const byScore = (a: Scored, b: Scored) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 按关键词给索引里的文档打分，分数大于 0 的从高到低（同分按 id） */
export function keywordRank(db: Database, index: KeywordIndex, terms: QueryTerms, allowed: (id: string) => boolean): Scored[] {
  const scores = new Map<string, number>();
  const add = (id: string, s: number) => scores.set(id, (scores.get(id) ?? 0) + s);

  if (terms.fts.length > 0) {
    const match = terms.fts.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
    const rows = db.all<{ id: string; s: number }>(`SELECT ${index.idColumn} AS id, bm25(${index.table}) AS s FROM ${index.table} WHERE ${index.table} MATCH ?`, match);
    for (const row of rows) if (allowed(row.id)) add(row.id, -row.s);
  }

  const scanned = [...terms.short, ...terms.single];
  if (scanned.length > 0) {
    const docs = db.all<{ id: string; body: string }>(`SELECT ${index.idColumn} AS id, body FROM ${index.table}`).map((d) => ({ id: d.id, body: d.body.toLowerCase(), len: Array.from(d.body).length }));
    const n = docs.length;
    const avg = n === 0 ? 1 : docs.reduce((s, d) => s + d.len, 0) / n || 1;
    for (const term of scanned) {
      const tfs = docs.map((d) => occurrences(d.body, term));
      const df = tfs.filter((tf) => tf > 0).length;
      if (df === 0) continue;
      let idf = Math.log((n - df + 0.5) / (df + 0.5));
      if (idf <= 0) idf = 1e-6;
      docs.forEach((d, i) => {
        const tf = tfs[i]!;
        if (tf === 0 || !allowed(d.id)) return;
        add(d.id, (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.len) / avg)));
      });
    }
  }

  return [...scores.entries()]
    .filter(([, s]) => s > 0)
    .map(([id, score]) => ({ id, score }))
    .toSorted(byScore);
}
