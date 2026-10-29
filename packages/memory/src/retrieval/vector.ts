// 向量这一路（原话的 evidence_vectors、精炼陈述的 fact_vectors 各一份）：查询向量和每条文档向量算余弦，暴力扫（PoC 只有几百条），
// 只看同一个模型算的向量（换了模型要先 indexVectors 重算）。时间、场景、来源等级由调用的人给的 allowed 过滤。
import { cosine } from "../embedding/embedder.ts";
import type { Database } from "../store/sqlite.ts";
import type { Scored } from "./keyword.ts";

export interface VectorIndex {
  table: "evidence_vectors" | "fact_vectors";
  idColumn: "evidence_id" | "fact_id";
}

export const EVIDENCE_VECTORS: VectorIndex = { table: "evidence_vectors", idColumn: "evidence_id" };
export const FACT_VECTORS: VectorIndex = { table: "fact_vectors", idColumn: "fact_id" };

/** 余弦从高到低（同分按 id） */
export function vectorRank(db: Database, index: VectorIndex, model: string, query: Float32Array, allowed: (id: string) => boolean): Scored[] {
  const rows = db.all<{ id: string; vector: Uint8Array }>(`SELECT ${index.idColumn} AS id, vector FROM ${index.table} WHERE model = ?`, model);
  const out: Scored[] = [];
  for (const row of rows) {
    if (!allowed(row.id)) continue;
    // 拷一份：SQLite 给的缓冲区不保证按 4 字节对齐
    const v = new Float32Array(row.vector.slice().buffer);
    out.push({ id: row.id, score: cosine(query, v) });
  }
  return out.toSorted((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
