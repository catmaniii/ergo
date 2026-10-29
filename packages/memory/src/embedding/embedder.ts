// 向量函数的接口：检索（③ 号票）只认它。PoC 有两种实现：假向量（fake.ts，测试和演示）、transformers.js 跑的真模型（transformers.ts，现在是 bge-m3）。
// 查询和文档分开算（调研 22：以后可能换 Qwen3-Embedding 这类查询要加指令前缀、文档不加的模型）；
// 池化方式、前缀是适配器的配置项。bge-m3 两种角色一样。向量表里每条记模型名，换了模型（名字变了）整批重算。

export type EmbedRole = "query" | "document";

export interface Embedder {
  /** 模型名：记在每条向量旁边 */
  readonly model: string;
  /** 模型文件在不在；不在时不算向量（证据入库、关键词索引照常） */
  available(): boolean;
  /** 模型不在时给的提示：在哪、怎么放进去 */
  unavailableHint(): string;
  /** 文档（证据原文、事实的精炼陈述）：建索引时用 */
  embedDocuments(texts: readonly string[]): Promise<Float32Array[]>;
  /** 查询：检索时用 */
  embedQueries(texts: readonly string[]): Promise<Float32Array[]>;
  /** 释放模型 */
  close(): Promise<void>;
}

/** 余弦相似度（归一化过的向量就是点积） */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** L2 归一化（全零的原样返回） */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  if (sum === 0) return v;
  const norm = Math.sqrt(sum);
  return v.map((x) => x / norm);
}
