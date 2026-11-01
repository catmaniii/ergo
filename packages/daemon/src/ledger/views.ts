// token 账本的派生视图（规格第 4 节：token 账本在 ergo.db 里，随事件在同一事务里更新，可从事件日志重建）：
// 每次模型调用一行（ledger 频道上的 token_usage 事件）。合计都只从这里出（SQL 聚合）：看板上推的合计在记账前算，
// 把还没落盘的那一条作为一行并进来一起聚合（ownerTotals 的 pending），和落盘之后再查的结果一样。
import type { LedgerOwner, LedgerPurpose, LedgerRole, TokenAgentRow, TokenCounts, TokenStageRow, TokenTotalsEventPayload, WebCallKind, WebCallService } from "@ergo/protocol";
import type { DerivedView } from "../events/event-store.ts";
import type { ReadonlyDatabase, SqlValue } from "../storage/sqlite.ts";
import { CONTEXT_USAGE_EVENT, type ContextUsagePayload, LEDGER_CHANNEL, type LedgerEntry, TOKEN_USAGE_EVENT, type TokenUsagePayload, WEB_CALL_EVENT, type WebCallPayload } from "./entry.ts";

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
 * 某个 agent 最近的一条（⚙ 里的上下文用量、上次压缩）：只看这几种用途、全局序号大于 afterSeq 的（这段会话里的）；没有是 undefined
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
      `${rows} SELECT stage_id, ${SUMS}, SUM(CASE WHEN ${BUDGET_ROWS} THEN ${BUDGET_TOKENS_SQL} ELSE 0 END) AS budget
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
 * 算预算时命中缓存的 token 按几分之一记。只有这个数按它算（看板上的 budgetTokens、预算比较）：
 * 账本的逐笔记录、消耗页显示的真实 token 和钱不变。上下文 15 万时一次调用实际只花约 ¥0.01，全算进去一两次调用预算就爆了。
 * 不按钱算：自定义模型可能没有单价
 */
export const BUDGET_CACHE_HIT_DIVISOR = 10;

/** 一次调用记进预算的 token：没命中缓存的输入 + 输出 + 命中缓存的十分之一 */
export const budgetTokensOf = (tokens: TokenCounts): number => tokens.cacheMiss + tokens.output + Math.trunc(tokens.cacheHit / BUDGET_CACHE_HIT_DIVISOR);

/** 同一个算法的 SQL（和 budgetTokensOf 一样按行取整，起算点相减才对得上） */
const BUDGET_TOKENS_SQL = `cache_miss + output + CAST(cache_hit AS INTEGER) / ${BUDGET_CACHE_HIT_DIVISOR}`;

/**
 * 任务的某个阶段用掉的 token。budget 为假是真实的（命中 + 未命中 + 输出）；budget 为真是预算用的那个数（budgetTokensOf，
 * 只算进预算的部分 BUDGET_ROWS，预算比较用），和看板上 byStage 的 budgetTokens 一样
 */
export function stageTokenSum(db: ReadonlyDatabase, taskId: string, stageId: string, budget: boolean): number {
  const row = db.get<{ total: number | null }>(
    `SELECT SUM(${budget ? BUDGET_TOKENS_SQL : "cache_hit + cache_miss + output"}) AS total FROM token_ledger WHERE owner_kind = 'task' AND owner_id = ? AND stage_id = ? ${budget ? `AND ${BUDGET_ROWS}` : ""}`,
    taskId,
    stageId,
  );
  return Number(row?.total ?? 0);
}

/** 单次计量看最近多少次调用 */
const METER_RECENT_CALLS = 20;
/** 每次调用除了缓存着的上下文还要记的：没命中的输入加输出（真模型试验里平均 2900 + 720） */
const METER_FRESH_TOKENS = 3_000;
/** 一次调用都还没记过时，假定上下文有这么大 */
const METER_DEFAULT_CONTEXT = 20_000;

/** 这个 agent 最近几次算进预算的调用，最近的在前（单次计量） */
export function recentBudgetCalls(db: ReadonlyDatabase, agentId: string): Array<{ tokens: TokenCounts; model: string; time: string }> {
  return db
    .all<{ cache_hit: number; cache_miss: number; output: number; model: string; time: string }>(
      `SELECT cache_hit, cache_miss, output, model, time FROM token_ledger WHERE agent_id = ? AND ${BUDGET_ROWS} ORDER BY global_seq DESC LIMIT ${METER_RECENT_CALLS}`,
      agentId,
    )
    .map((r) => ({ tokens: { cacheHit: Number(r.cache_hit), cacheMiss: Number(r.cache_miss), output: Number(r.output) }, model: r.model, time: r.time }));
}

/** 上下文有这么大时一次调用大约记多少 */
const meterOfContext = (context: number): number => Math.trunc(context / BUDGET_CACHE_HIT_DIVISOR) + METER_FRESH_TOKENS;

/**
 * 单次计量：一次调用大约记多少 token。最近的实测平均，和按最近一次的上下文大小估的，取大的（上下文只会越来越大，
 * 平均落后于它）；一次都没记过时按假定的上下文估
 */
export function callMeterTokens(recent: readonly TokenCounts[]): number {
  const latest = recent[0];
  if (!latest) return meterOfContext(METER_DEFAULT_CONTEXT);
  const average = recent.reduce((n, t) => n + budgetTokensOf(t), 0) / recent.length;
  return Math.ceil(Math.max(average, meterOfContext(latest.cacheHit + latest.cacheMiss)));
}

/**
 * 范围里（含两头的日期）按天、agent、模型、记账时间分的合计；owned 是有归属的（没有归属的按角色分系统开销、未归属）。
 * 按记账时间分开：自带价格表分高峰、空闲时段，每一笔按它的时间算价
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

/**
 * 按次计费的联网调用：每次成功的 DeepSeek 联网搜索、读网页一行（账本频道上的 web_call 事件），和 token_ledger 分开
 * （没有 token、不进 token 的合计和预算），消耗页的 web 一节从这里聚合。可从事件日志重建
 */
export const webCallsView: DerivedView = {
  name: "web_call_ledger",
  channels: [LEDGER_CHANNEL],
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS web_call_ledger (
        global_seq INTEGER PRIMARY KEY,
        time TEXT NOT NULL,
        day TEXT NOT NULL,
        owner_kind TEXT,
        owner_id TEXT,
        stage_id TEXT,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL,
        service TEXT NOT NULL,
        kind TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS web_call_ledger_by_day ON web_call_ledger (day);
    `),
  clear: (db) => db.exec("DELETE FROM web_call_ledger"),
  apply(db, event) {
    if (event.channel !== LEDGER_CHANNEL || event.type !== WEB_CALL_EVENT) return;
    const p = event.payload as WebCallPayload;
    db.run(
      `INSERT INTO web_call_ledger (global_seq, time, day, owner_kind, owner_id, stage_id, agent_id, role, service, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.globalSeq,
      p.time,
      dayOf(p.time),
      p.owner?.kind ?? null,
      p.owner?.id ?? null,
      p.stageId ?? null,
      p.agentId,
      p.role,
      p.service,
      p.kind,
    );
  },
};

/** 范围里（含两头的日期）按 agent、有没有归属、哪家、哪一种分的联网调用次数 */
export function webCallRows(
  db: ReadonlyDatabase,
  from: string,
  to: string,
): Array<{ agent_id: string; role: LedgerRole; owned: number; service: WebCallService; kind: WebCallKind; calls: number }> {
  return db.all(
    `SELECT agent_id, role, (owner_kind IS NOT NULL) AS owned, service, kind, COUNT(*) AS calls FROM web_call_ledger WHERE day >= ? AND day <= ?
     GROUP BY agent_id, role, owned, service, kind ORDER BY MIN(global_seq)`,
    from,
    to,
  );
}

/**
 * 插件追加在 agent 输入后面的上下文估的 token（记忆简报）：每带一次一行（账本频道上的 context_usage 事件），
 * 和 token_ledger 分开（不进 token 的合计和预算），用量页的"记忆简报"一项从这里聚合。可从事件日志重建
 */
export const contextUsageView: DerivedView = {
  name: "context_usage_ledger",
  channels: [LEDGER_CHANNEL],
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS context_usage_ledger (
        global_seq INTEGER PRIMARY KEY,
        time TEXT NOT NULL,
        day TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens INTEGER NOT NULL,
        chars INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS context_usage_ledger_by_day ON context_usage_ledger (day);
    `),
  clear: (db) => db.exec("DELETE FROM context_usage_ledger"),
  apply(db, event) {
    if (event.channel !== LEDGER_CHANNEL || event.type !== CONTEXT_USAGE_EVENT) return;
    const p = event.payload as ContextUsagePayload;
    db.run(
      `INSERT INTO context_usage_ledger (global_seq, time, day, agent_id, role, kind, model, tokens, chars) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.globalSeq,
      p.time,
      dayOf(p.time),
      p.agentId,
      p.role,
      p.kind,
      p.model,
      p.tokens,
      p.chars,
    );
  },
};

/** 范围里（含两头的日期）某一种上下文按模型、记账时间分的次数和 token（自带价格表按时段算钱，同 rangeRows） */
export function contextUsageRows(db: ReadonlyDatabase, from: string, to: string, kind: string): Array<{ model: string; time: string; count: number; tokens: number }> {
  return db.all(
    `SELECT model, time, COUNT(*) AS count, SUM(tokens) AS tokens FROM context_usage_ledger WHERE day >= ? AND day <= ? AND kind = ?
     GROUP BY model, time ORDER BY MIN(global_seq)`,
    from,
    to,
    kind,
  );
}
