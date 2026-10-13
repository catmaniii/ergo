// token 账本的派生视图（规格第 4 节：token 账本在 ergou.db 里，随事件在同一事务里更新，可从事件日志重建）：
// 每次模型调用一行（ledger 频道上的 token_usage 事件）。合计都只从这里出（SQL 聚合）：看板上推的合计在记账前算，
// 把还没落盘的那一条作为一行并进来一起聚合（ownerTotals 的 pending），和落盘之后再查的结果一样。
import type { LedgerOwner, LedgerPurpose, LedgerRole, TokenAgentRow, TokenCounts, TokenStageRow, TokenTotalsEventPayload } from "@ergou/protocol";
import type { DerivedView } from "../events/event-store.ts";
import type { ReadonlyDatabase, SqlValue } from "../storage/sqlite.ts";
import { LEDGER_CHANNEL, type LedgerEntry, TOKEN_USAGE_EVENT, type TokenUsagePayload } from "./entry.ts";

export const ledgerView: DerivedView = {
  name: "token_ledger",
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS token_ledger (
        global_seq INTEGER PRIMARY KEY,
        time TEXT NOT NULL,
        day TEXT NOT NULL,
        owner_kind TEXT,
        owner_id TEXT,
        stage_id TEXT,
        purpose TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL,
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        cache_hit INTEGER NOT NULL,
        cache_miss INTEGER NOT NULL,
        output INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS token_ledger_by_owner ON token_ledger (owner_kind, owner_id, stage_id);
      CREATE INDEX IF NOT EXISTS token_ledger_by_day ON token_ledger (day);
      CREATE INDEX IF NOT EXISTS token_ledger_by_agent ON token_ledger (agent_id, global_seq);
    `),
  clear: (db) => db.exec("DELETE FROM token_ledger"),
  apply(db, event) {
    if (event.channel !== LEDGER_CHANNEL || event.type !== TOKEN_USAGE_EVENT) return;
    const p = event.payload as TokenUsagePayload;
    db.run(
      `INSERT INTO token_ledger (global_seq, time, day, owner_kind, owner_id, stage_id, purpose, agent_id, role, session_id, model, cache_hit, cache_miss, output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.globalSeq,
      p.time,
      dayOf(p.time),
      p.owner?.kind ?? null,
      p.owner?.id ?? null,
      p.stageId ?? null,
      p.purpose,
      p.agentId,
      p.role,
      p.sessionId,
      p.model,
      p.tokens.cacheHit,
      p.tokens.cacheMiss,
      p.tokens.output,
    );
  },
};

/** 协议时间（带时区偏移的本地 ISO 时间）落在哪一天：本地日期 YYYY-MM-DD */
export function dayOf(time: string): string {
  return time.slice(0, 10);
}

interface EntryRow {
  global_seq: number;
  time: string;
  owner_kind: LedgerOwner["kind"] | null;
  owner_id: string | null;
  stage_id: string | null;
  purpose: LedgerPurpose;
  agent_id: string;
  role: LedgerRole;
  session_id: string;
  model: string;
  cache_hit: number;
  cache_miss: number;
  output: number;
}

function toEntry(r: EntryRow): LedgerEntry {
  return {
    seq: Number(r.global_seq),
    time: r.time,
    owner: r.owner_kind === null || r.owner_id === null ? null : { kind: r.owner_kind, id: r.owner_id },
    ...(r.stage_id === null ? {} : { stageId: r.stage_id }),
    purpose: r.purpose,
    agentId: r.agent_id,
    role: r.role,
    sessionId: r.session_id,
    model: r.model,
    tokens: { cacheHit: Number(r.cache_hit), cacheMiss: Number(r.cache_miss), output: Number(r.output) },
  };
}

/** 账本里的条目，按记账的先后；给了 owner 只要记在它名下的（null 是不在任何名下的：系统开销和未归属） */
export function listEntries(db: ReadonlyDatabase, owner?: LedgerOwner | null): LedgerEntry[] {
  const where = owner === undefined ? "" : owner === null ? "WHERE owner_kind IS NULL" : "WHERE owner_kind = ? AND owner_id = ?";
  const params: SqlValue[] = owner ? [owner.kind, owner.id] : [];
  return db.all<EntryRow>(`SELECT * FROM token_ledger ${where} ORDER BY global_seq`, ...params).map(toEntry);
}

/**
 * 某个 agent 最近的一条（114 号票：⚙ 里的上下文用量、上次压缩）：只看这几种用途、全局序号大于 afterSeq 的（这段会话里的）；没有是 undefined
 */
export function lastEntryOf(db: ReadonlyDatabase, agentId: string, purposes: readonly LedgerPurpose[], afterSeq = 0): LedgerEntry | undefined {
  if (purposes.length === 0) return undefined;
  const row = db.get<EntryRow>(
    `SELECT * FROM token_ledger WHERE agent_id = ? AND global_seq > ? AND purpose IN (${purposes.map(() => "?").join(", ")}) ORDER BY global_seq DESC LIMIT 1`,
    agentId,
    afterSeq,
    ...purposes,
  );
  return row && toEntry(row);
}

/** 账本里的某一条（seq 是事件的全局序号） */
export function entryAt(db: ReadonlyDatabase, seq: number): LedgerEntry | undefined {
  const row = db.get<EntryRow>("SELECT * FROM token_ledger WHERE global_seq = ?", seq);
  return row && toEntry(row);
}

const SUMS = "SUM(cache_hit) AS cache_hit, SUM(cache_miss) AS cache_miss, SUM(output) AS output, COUNT(*) AS calls";

interface SumRow {
  cache_hit: number | null;
  cache_miss: number | null;
  output: number | null;
  calls: number;
}

export function tokensOf(r: SumRow): TokenCounts {
  return { cacheHit: Number(r.cache_hit ?? 0), cacheMiss: Number(r.cache_miss ?? 0), output: Number(r.output ?? 0) };
}

/** 还没落盘的那一条排在所有已落盘的之后 */
const PENDING_SEQ = Number.MAX_SAFE_INTEGER;

/**
 * 某个名下的合计（总量、按 agent（用途不同的各一行）、按阶段），就是看板上 token_totals 的负载；还没有用量是 undefined。
 * 给了 pending（正要记的这一条），把它当作一行一起聚合
 */
export function ownerTotals(db: ReadonlyDatabase, owner: LedgerOwner, pending?: TokenUsagePayload): TokenTotalsEventPayload | undefined {
  const rows = `WITH rows AS (
      SELECT global_seq AS seq, agent_id, role, purpose, stage_id, cache_hit, cache_miss, output, time FROM token_ledger WHERE owner_kind = ? AND owner_id = ?
      UNION ALL SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ?
    )`;
  const params: SqlValue[] = pending
    ? [owner.kind, owner.id, PENDING_SEQ, pending.agentId, pending.role, pending.purpose, pending.stageId ?? null, pending.tokens.cacheHit, pending.tokens.cacheMiss, pending.tokens.output, pending.time, 1]
    : [owner.kind, owner.id, PENDING_SEQ, "", "", "", null, 0, 0, 0, "", 0];
  const total = db.get<SumRow>(`${rows} SELECT ${SUMS} FROM rows`, ...params);
  if (!total || Number(total.calls) === 0) return undefined;
  const byAgent: TokenAgentRow[] = db
    .all<SumRow & { agent_id: string; role: LedgerRole; purpose: LedgerPurpose }>(`${rows} SELECT agent_id, role, purpose, ${SUMS} FROM rows GROUP BY agent_id, role, purpose ORDER BY MIN(seq)`, ...params)
    .map((r) => ({ agentId: r.agent_id, role: r.role, purpose: r.purpose, tokens: tokensOf(r), calls: Number(r.calls) }));
  const byStage: TokenStageRow[] = db
    .all<SumRow & { stage_id: string; budget: number | null }>(
      `${rows} SELECT stage_id, ${SUMS}, SUM(CASE WHEN ${BUDGET_ROWS} THEN cache_hit + cache_miss + output ELSE 0 END) AS budget
       FROM rows WHERE stage_id IS NOT NULL GROUP BY stage_id ORDER BY MIN(seq)`,
      ...params,
    )
    .map((r) => ({ stageId: r.stage_id, tokens: tokensOf(r), calls: Number(r.calls), budgetTokens: Number(r.budget ?? 0) }));
  const last = db.get<{ time: string }>(`${rows} SELECT time FROM rows ORDER BY seq DESC LIMIT 1`, ...params);
  return { owner, tokens: tokensOf(total), calls: Number(total.calls), byAgent, byStage, time: last?.time ?? "" };
}

/** 算进阶段预算的调用：不是评审子 agent 的、不是范围审视的（压缩算：那是干活的 agent 自己的上下文开销） */
const BUDGET_ROWS = "role <> 'reviewer' AND purpose <> 'scope_review'";

/**
 * 任务的某个阶段用掉的 token（命中 + 未命中 + 输出）。budget 为真时只算进预算的部分（BUDGET_ROWS，14 号票的预算比较用），
 * 和看板上 byStage 的 budgetTokens 一样
 */
export function stageTokenSum(db: ReadonlyDatabase, taskId: string, stageId: string, budget: boolean): number {
  const filter = budget ? `AND ${BUDGET_ROWS}` : "";
  const row = db.get<{ total: number | null }>(
    `SELECT SUM(cache_hit + cache_miss + output) AS total FROM token_ledger WHERE owner_kind = 'task' AND owner_id = ? AND stage_id = ? ${filter}`,
    taskId,
    stageId,
  );
  return Number(row?.total ?? 0);
}

/**
 * 范围里（含两头的日期）按天、agent、模型、记账时间分的合计；owned 是有归属的（没有归属的按角色分系统开销、未归属）。
 * 按记账时间分开（94 号票）：自带价格表分高峰、空闲时段，每一笔按它的时间算价
 */
export function rangeRows(
  db: ReadonlyDatabase,
  from: string,
  to: string,
): Array<SumRow & { day: string; time: string; agent_id: string; role: LedgerRole; owned: number; model: string }> {
  return db.all(
    `SELECT day, time, agent_id, role, (owner_kind IS NOT NULL) AS owned, model, ${SUMS} FROM token_ledger WHERE day >= ? AND day <= ?
     GROUP BY day, agent_id, role, owned, model, time ORDER BY day, MIN(global_seq)`,
    from,
    to,
  );
}
