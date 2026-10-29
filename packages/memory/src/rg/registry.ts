// 推理图谱的账本（rg_* 表，store/schema.ts）：竞争假设分组、组里的断言和模板、追问出自哪个模板、明说的事实对应哪条断言、
// 哪条证据被哪个推理实现整理过、模型版问过哪条观察和下层断言（272 号票，没变化就不再问）。这些是从断言、事实推出来的簿记，不进修订日志（断言、关联、推断、追问本身的改动都进）。
import type { MemoryStore } from "../store/store.ts";

export interface GroupRecord {
  key: string;
  pattern: string;
  params: Record<string, unknown>;
  description: string;
  observationIds: string[];
  /** 观察模式还成立；不成立了（观察被撤回到不够两条）是 false，组里的断言留成猜测（Q2，没有推翻者不撤） */
  live: boolean;
  by: string;
  createdAt: string;
}

const parse = <T>(v: unknown): T => JSON.parse(String(v)) as T;

function toGroup(r: Record<string, unknown>): GroupRecord {
  return {
    key: String(r.key),
    pattern: String(r.pattern),
    params: parse<Record<string, unknown>>(r.params),
    description: String(r.description),
    observationIds: parse<string[]>(r.observation_ids),
    live: Number(r.live) === 1,
    by: String(r.by),
    createdAt: String(r.created_at),
  };
}

export class RgRegistry {
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  private get db() {
    return this.store.db;
  }

  // ---------- 分组 ----------

  getGroup(key: string): GroupRecord | undefined {
    const row = this.db.get("SELECT * FROM rg_groups WHERE key = ?", key);
    return row && toGroup(row);
  }

  listGroups(filter: { live?: boolean } = {}): GroupRecord[] {
    const rows = filter.live === undefined ? this.db.all("SELECT * FROM rg_groups ORDER BY rowid") : this.db.all("SELECT * FROM rg_groups WHERE live = ? ORDER BY rowid", filter.live ? 1 : 0);
    return rows.map(toGroup);
  }

  /** 新建或更新一组（参数、说明、观察会随新证据变） */
  putGroup(g: Omit<GroupRecord, "createdAt"> & { createdAt?: string }): GroupRecord {
    const existing = this.getGroup(g.key);
    const createdAt = existing?.createdAt ?? g.createdAt ?? this.store.now();
    this.db.run(
      `INSERT INTO rg_groups (key, pattern, params, description, observation_ids, live, by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET pattern = excluded.pattern, params = excluded.params, description = excluded.description,
         observation_ids = excluded.observation_ids, live = excluded.live, by = excluded.by`,
      g.key,
      g.pattern,
      JSON.stringify(g.params),
      g.description,
      JSON.stringify(g.observationIds),
      g.live ? 1 : 0,
      g.by,
      createdAt,
    );
    return { ...g, createdAt };
  }

  setGroupLive(key: string, live: boolean): void {
    this.db.run("UPDATE rg_groups SET live = ? WHERE key = ?", live ? 1 : 0, key);
  }

  // ---------- 组里的断言 ----------

  addMember(claimId: string, groupKey: string, template: string): void {
    this.db.run("INSERT OR IGNORE INTO rg_members (claim_id, group_key, template) VALUES (?, ?, ?)", claimId, groupKey, template);
  }

  /** 329 号票：撤了的结论重新推出来时（新建一条），旧的那条移出这一组（留墓碑，组里只认新的） */
  removeMember(claimId: string): void {
    this.db.run("DELETE FROM rg_members WHERE claim_id = ?", claimId);
  }

  members(groupKey: string): { claimId: string; template: string }[] {
    return this.db.all("SELECT claim_id, template FROM rg_members WHERE group_key = ? ORDER BY rowid", groupKey).map((r) => ({ claimId: String(r.claim_id), template: String(r.template) }));
  }

  memberOf(claimId: string): { groupKey: string; template: string } | undefined {
    const row = this.db.get<{ group_key: string; template: string }>("SELECT group_key, template FROM rg_members WHERE claim_id = ?", claimId);
    return row && { groupKey: row.group_key, template: row.template };
  }

  // ---------- 追问 ----------

  addProbe(probeId: string, groupKey: string, template: string): void {
    this.db.run("INSERT OR IGNORE INTO rg_probes (probe_id, group_key, template) VALUES (?, ?, ?)", probeId, groupKey, template);
  }

  probesOf(groupKey: string): { probeId: string; template: string }[] {
    return this.db.all("SELECT probe_id, template FROM rg_probes WHERE group_key = ? ORDER BY rowid", groupKey).map((r) => ({ probeId: String(r.probe_id), template: String(r.template) }));
  }

  groupOfProbe(probeId: string): string | undefined {
    return this.db.get<{ group_key: string }>("SELECT group_key FROM rg_probes WHERE probe_id = ?", probeId)?.group_key;
  }

  // ---------- 明说的事实 → 断言 ----------

  explicitClaimOf(factId: string): string | undefined {
    return this.db.get<{ claim_id: string }>("SELECT claim_id FROM rg_explicit WHERE fact_id = ?", factId)?.claim_id;
  }

  explicitFactOf(claimId: string): string | undefined {
    return this.db.get<{ fact_id: string }>("SELECT fact_id FROM rg_explicit WHERE claim_id = ?", claimId)?.fact_id;
  }

  addExplicit(factId: string, claimId: string): void {
    this.db.run("INSERT OR IGNORE INTO rg_explicit (fact_id, claim_id) VALUES (?, ?)", factId, claimId);
  }

  listExplicit(): { factId: string; claimId: string }[] {
    return this.db.all("SELECT fact_id, claim_id FROM rg_explicit ORDER BY rowid").map((r) => ({ factId: String(r.fact_id), claimId: String(r.claim_id) }));
  }

  // ---------- 整理到哪了 ----------

  isReflected(evidenceId: string, reasoner: string): boolean {
    return this.db.get("SELECT 1 AS found FROM rg_reflected WHERE evidence_id = ? AND reasoner = ?", evidenceId, reasoner) !== undefined;
  }

  markReflected(evidenceId: string, reasoner: string): void {
    this.db.run("INSERT OR IGNORE INTO rg_reflected (evidence_id, reasoner, at) VALUES (?, ?, ?)", evidenceId, reasoner, this.store.now());
  }

  // ---------- 问过的（272 号票） ----------

  /** 这一步、这个推理实现上次问到这条时它的签名；没问过是 undefined */
  askedSignature(step: string, reasoner: string, subject: string): string | undefined {
    return this.db.get<{ signature: string }>("SELECT signature FROM rg_asked WHERE step = ? AND reasoner = ? AND subject = ?", step, reasoner, subject)?.signature;
  }

  /** 记下这次问到了这条（签名换成这次的） */
  markAsked(step: string, reasoner: string, subject: string, signature: string): void {
    this.db.run(
      "INSERT INTO rg_asked (step, reasoner, subject, signature, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (step, reasoner, subject) DO UPDATE SET signature = excluded.signature, at = excluded.at",
      step,
      reasoner,
      subject,
      signature,
      this.store.now(),
    );
  }
}
