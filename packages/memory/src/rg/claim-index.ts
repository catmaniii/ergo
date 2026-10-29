// 结论的索引（196 号票）：断言的陈述建关键词（FTS5 trigram）和向量索引，照事实精炼陈述那一套（第 4.2、6 节）；
// 另记每条断言的适用领域（rg/domains.ts）。都是从断言推出来的簿记（claim_fts、claim_vectors、claim_index 三张表），不进修订日志。
//
// 怎么跟着断言走：不改存储写断言的路径（和 192 号票并行，接线只加不改），而是用的时候先同步——sync() 把现有断言和索引对一遍：
// - 撤回的断言从关键词、向量索引里删掉（和撤回的事实一样）；别的状态都留着，查的时候再按状态、有效期过滤；
// - 陈述变了（往上抽的断言随新观察改写）：关键词表换掉、旧向量作废，等 indexVectors 补算；
// - 领域每次重算（依据会变），变了才写。
// 断言只有几十到几百条，每次全量对一遍代价很小。
import type { Embedder } from "../embedding/embedder.ts";
import { keywordRank, type KeywordIndex, type Scored } from "../retrieval/keyword.ts";
import { queryTerms } from "../retrieval/terms.ts";
import { vectorRank, type VectorIndex } from "../retrieval/vector.ts";
import type { MemoryStore } from "../store/store.ts";
import { claimDomains, type Domain } from "./domains.ts";

// keyword.ts、vector.ts 的索引类型只列了证据和事实两张表；SQL 只用表名和 id 列名，断言的表照同样的形状建（store/schema.ts）。
// 不去改那两个文件的类型（192 号票在改检索），这里转一下。
const CLAIM_KEYWORDS = { table: "claim_fts", idColumn: "claim_id" } as unknown as KeywordIndex;
const CLAIM_VECTORS = { table: "claim_vectors", idColumn: "claim_id" } as unknown as VectorIndex;

const VECTOR_BATCH = 16;

export interface ClaimIndexReport {
  /** 这次重建了关键词索引的断言（新的、陈述变了的） */
  reindexed: string[];
  /** 从索引里删掉的（撤回了） */
  removed: string[];
  /** 领域变了的 */
  domainsChanged: string[];
}

export interface ClaimVectorReport {
  model: string | null;
  claims: number;
  skipped?: string;
}

export class ClaimIndex {
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  private get db() {
    return this.store.db;
  }

  /** 把索引和现有断言对一遍（见文件开头）；幂等 */
  sync(): ClaimIndexReport {
    return this.store.transaction(() => {
      const report: ClaimIndexReport = { reindexed: [], removed: [], domainsChanged: [] };
      const indexed = new Map(this.db.all<{ claim_id: string; statement: string; domains: string }>("SELECT claim_id, statement, domains FROM claim_index").map((r) => [r.claim_id, r]));
      const memo = new Map<string, Domain[]>();
      for (const claim of this.store.listClaims()) {
        const row = indexed.get(claim.id);
        if (claim.status === "retracted") {
          if (row) {
            this.db.run("DELETE FROM claim_fts WHERE claim_id = ?", claim.id);
            this.db.run("DELETE FROM claim_vectors WHERE claim_id = ?", claim.id);
            this.db.run("DELETE FROM claim_index WHERE claim_id = ?", claim.id);
            report.removed.push(claim.id);
          }
          continue;
        }
        const domains = JSON.stringify(claimDomains(this.store, claim, memo));
        if (!row || row.statement !== claim.statement) {
          this.db.run("DELETE FROM claim_fts WHERE claim_id = ?", claim.id);
          this.db.run("INSERT INTO claim_fts (claim_id, body) VALUES (?, ?)", claim.id, claim.statement);
          this.db.run("DELETE FROM claim_vectors WHERE claim_id = ?", claim.id);
          this.db.run(
            "INSERT INTO claim_index (claim_id, statement, domains) VALUES (?, ?, ?) ON CONFLICT (claim_id) DO UPDATE SET statement = excluded.statement, domains = excluded.domains",
            claim.id,
            claim.statement,
            domains,
          );
          report.reindexed.push(claim.id);
          if (!row || row.domains !== domains) report.domainsChanged.push(claim.id);
        } else if (row.domains !== domains) {
          this.db.run("UPDATE claim_index SET domains = ? WHERE claim_id = ?", domains, claim.id);
          report.domainsChanged.push(claim.id);
        }
      }
      return report;
    });
  }

  /** 给还没有向量的断言陈述补算向量（文档角色）；没有向量函数、模型不在时跳过 */
  async indexVectors(embedder: Embedder | undefined): Promise<ClaimVectorReport> {
    if (!embedder) return { model: null, claims: 0, skipped: "没有向量函数（打开引擎时没给 embedder）" };
    if (!embedder.available()) return { model: embedder.model, claims: 0, skipped: embedder.unavailableHint() };
    const model = embedder.model;
    const pending = this.db.all<{ claim_id: string; statement: string }>(
      "SELECT i.claim_id, i.statement FROM claim_index i WHERE NOT EXISTS (SELECT 1 FROM claim_vectors v WHERE v.claim_id = i.claim_id AND v.model = ?) ORDER BY i.claim_id",
      model,
    );
    let claims = 0;
    for (let i = 0; i < pending.length; i += VECTOR_BATCH) {
      const batch = pending.slice(i, i + VECTOR_BATCH);
      const vectors = await embedder.embedDocuments(batch.map((r) => r.statement));
      batch.forEach((r, j) => {
        // 算的时候陈述变了、撤回了的不写
        const now = this.db.get<{ statement: string }>("SELECT statement FROM claim_index WHERE claim_id = ?", r.claim_id);
        if (now?.statement !== r.statement) return;
        const v = vectors[j]!;
        this.db.run(
          "INSERT INTO claim_vectors (claim_id, model, dims, vector) VALUES (?, ?, ?, ?) ON CONFLICT (claim_id, model) DO UPDATE SET dims = excluded.dims, vector = excluded.vector",
          r.claim_id,
          model,
          v.length,
          new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
        );
        claims += 1;
      });
    }
    return { model, claims };
  }

  /** 任务文字按关键词搜断言陈述（3 字词 FTS5 bm25，2 字词子串扫描，同 retrieval/keyword.ts） */
  keywordRank(task: string, allowed: (claimId: string) => boolean = () => true): Scored[] {
    return keywordRank(this.db, CLAIM_KEYWORDS, queryTerms(task), allowed);
  }

  /** 查询向量和断言陈述的向量算余弦（同一个模型算的） */
  vectorRank(model: string, query: Float32Array, allowed: (claimId: string) => boolean = () => true): Scored[] {
    return vectorRank(this.db, CLAIM_VECTORS, model, query, allowed);
  }

  /** 一条断言的适用领域（同步过的；没同步过、撤回了的是空的） */
  domainsOf(claimId: string): Domain[] {
    const row = this.db.get<{ domains: string }>("SELECT domains FROM claim_index WHERE claim_id = ?", claimId);
    return row ? (JSON.parse(row.domains) as Domain[]) : [];
  }

  /** 索引里全部断言的领域 */
  allDomains(): Map<string, Domain[]> {
    return new Map(this.db.all<{ claim_id: string; domains: string }>("SELECT claim_id, domains FROM claim_index ORDER BY claim_id").map((r) => [r.claim_id, JSON.parse(r.domains) as Domain[]]));
  }

  getClaimVector(claimId: string, model: string): Float32Array | undefined {
    const row = this.db.get<{ vector: Uint8Array }>("SELECT vector FROM claim_vectors WHERE claim_id = ? AND model = ?", claimId, model);
    return row && new Float32Array(row.vector.slice().buffer);
  }
}
