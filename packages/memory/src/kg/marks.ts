// 事实上的标记（199 号票，写回知识图谱用）：
// - gap：说的和做的不一样，两条都保留，互相标 gap（05 号调研 L1'：stated 和 revealed 冲突时两条都保留并标 gap）；
// - explained_by：矛盾的两边都能用一条需求、价值断言解释，关联到那条断言。
// 标记存在 kg_marks（当前的样子），每次加上、撤掉都经 MemoryStore.recordRevision 记一条修订（对象是那条事实），起因是推理图谱定根源的那条断言。
import type { MemoryStore } from "../store/store.ts";

export const MARK_KINDS = ["gap", "explained_by"] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

export interface FactMark {
  factId: string;
  kind: MarkKind;
  /** gap：定根源的那条断言；explained_by：那条需求、价值断言 */
  ref: string;
  /** gap：另一边的事实；explained_by：定根源的断言 */
  detail: { with?: string[]; rootClaimId?: string; reason: string };
  active: boolean;
  at: string;
}

export class FactMarks {
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  /** 加一个标记；已经有、内容一样的什么都不做（幂等）。返回是不是新加或改了 */
  put(mark: Omit<FactMark, "active" | "at">, cause: { evidenceId?: string | null; reason: string }): boolean {
    const existing = this.get(mark.factId, mark.kind, mark.ref);
    if (existing?.active && JSON.stringify(existing.detail) === JSON.stringify(mark.detail)) return false;
    const at = this.store.now();
    this.store.db.run(
      `INSERT INTO kg_marks (fact_id, kind, ref, detail, active, at) VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT (fact_id, kind, ref) DO UPDATE SET detail = excluded.detail, active = 1, at = excluded.at`,
      mark.factId,
      mark.kind,
      mark.ref,
      JSON.stringify(mark.detail),
      at,
    );
    this.store.recordRevision("fact", mark.factId, "update", { [`mark:${mark.kind}`]: { from: existing?.active ? existing.detail : null, to: { ref: mark.ref, ...mark.detail } } }, cause);
    return true;
  }

  /** 撤掉一个标记（标记留着、active = 0）；本来就没有的什么都不做 */
  clear(factId: string, kind: MarkKind, ref: string, cause: { evidenceId?: string | null; reason: string }): boolean {
    const existing = this.get(factId, kind, ref);
    if (!existing?.active) return false;
    this.store.db.run("UPDATE kg_marks SET active = 0, at = ? WHERE fact_id = ? AND kind = ? AND ref = ?", this.store.now(), factId, kind, ref);
    this.store.recordRevision("fact", factId, "update", { [`mark:${kind}`]: { from: { ref, ...existing.detail }, to: null } }, cause);
    return true;
  }

  get(factId: string, kind: MarkKind, ref: string): FactMark | undefined {
    const r = this.store.db.get("SELECT * FROM kg_marks WHERE fact_id = ? AND kind = ? AND ref = ?", factId, kind, ref);
    return r && toMark(r);
  }

  /** 一条事实的标记（默认只要还在的） */
  of(factId: string, options: { all?: boolean } = {}): FactMark[] {
    return this.store.db
      .all("SELECT * FROM kg_marks WHERE fact_id = ? ORDER BY rowid", factId)
      .map(toMark)
      .filter((m) => options.all === true || m.active);
  }

  list(filter: { kind?: MarkKind; all?: boolean } = {}): FactMark[] {
    return this.store.db
      .all("SELECT * FROM kg_marks ORDER BY rowid")
      .map(toMark)
      .filter((m) => (filter.kind === undefined || m.kind === filter.kind) && (filter.all === true || m.active));
  }
}

function toMark(r: Record<string, unknown>): FactMark {
  return {
    factId: String(r.fact_id),
    kind: r.kind as MarkKind,
    ref: String(r.ref),
    detail: JSON.parse(String(r.detail)) as FactMark["detail"],
    active: Number(r.active) === 1,
    at: String(r.at),
  };
}
