// 审批表（规格第 4、9 节）：ergo.db 的派生视图，由 guard 频道上的 approval_* 事件归并。读取函数只拿只读连接。
// 一条审批：待处理 → 批准 / 拒绝；等的那次调用超时后标"已挂起"（仍待处理）。
// 事后批准的（决定时没有调用在等）是一条按调用指纹匹配的一次性授权：同样的调用重试、命中的关注类别都在当初批准过的类别里时
// 放行一次，标"已用掉"。
import type { DerivedView } from "../events/event-store.ts";
import {
  type ApprovalConsumedPayload,
  type ApprovalDecidedPayload,
  type ApprovalRecord,
  type ApprovalRequestedPayload,
  type ApprovalSuspendedPayload,
  GUARD_CHANNEL,
  GUARD_EVENTS,
} from "../guard-runtime/events.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";

export type ApprovalStatus = "pending" | "approved" | "denied";

/** 审批表里的一条：请求时的记录，加上后来的状态 */
export interface Approval extends ApprovalRecord {
  status: ApprovalStatus;
  /** 等的那次调用超时，以"已提交审批，等待用户"拦下过 */
  suspended: boolean;
  /** 决定时那次调用还在等，直接接着执行或拦下了 */
  resumed: boolean;
  /** 事后批准的一次性授权已经用掉 */
  consumed: boolean;
  decidedAt?: string;
  note?: string;
}

export const approvalsView: DerivedView = {
  name: "approvals",
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        task_id TEXT,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        suspended INTEGER NOT NULL,
        resumed INTEGER NOT NULL,
        consumed INTEGER NOT NULL,
        decided_at TEXT,
        note TEXT,
        record TEXT NOT NULL,
        global_seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS approvals_by_fingerprint ON approvals (agent_id, fingerprint, status);
      CREATE INDEX IF NOT EXISTS approvals_by_card ON approvals (card_id);
    `),
  clear: (db) => db.exec("DELETE FROM approvals"),
  apply(db, event) {
    if (event.channel !== GUARD_CHANNEL) return;
    switch (event.type) {
      case GUARD_EVENTS.approvalRequested: {
        const { approval } = event.payload as ApprovalRequestedPayload;
        db.run(
          `INSERT INTO approvals (approval_id, card_id, agent_id, task_id, fingerprint, status, suspended, resumed, consumed, record, global_seq)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, 0, ?, ?)`,
          approval.approvalId,
          approval.cardId,
          approval.origin.agentId,
          approval.origin.taskId,
          approval.fingerprint,
          JSON.stringify(approval),
          event.globalSeq,
        );
        return;
      }
      case GUARD_EVENTS.approvalDecided: {
        const p = event.payload as ApprovalDecidedPayload;
        const status: ApprovalStatus = p.decision === "denied" ? "denied" : "approved";
        db.run(
          "UPDATE approvals SET status = ?, resumed = ?, consumed = ?, decided_at = ?, note = ? WHERE approval_id = ?",
          status,
          p.resumed ? 1 : 0,
          p.resumed ? 1 : 0,
          p.time,
          p.note ?? null,
          p.approvalId,
        );
        return;
      }
      case GUARD_EVENTS.approvalSuspended:
        db.run("UPDATE approvals SET suspended = 1 WHERE approval_id = ?", (event.payload as ApprovalSuspendedPayload).approvalId);
        return;
      case GUARD_EVENTS.approvalConsumed:
        db.run("UPDATE approvals SET consumed = 1 WHERE approval_id = ?", (event.payload as ApprovalConsumedPayload).approvalId);
        return;
    }
  },
};

interface ApprovalRow {
  status: ApprovalStatus;
  suspended: number;
  resumed: number;
  consumed: number;
  decided_at: string | null;
  note: string | null;
  record: string;
}

const COLUMNS = "status, suspended, resumed, consumed, decided_at, note, record";

function toApproval(row: ApprovalRow): Approval {
  return {
    ...(JSON.parse(row.record) as ApprovalRecord),
    status: row.status,
    suspended: Number(row.suspended) === 1,
    resumed: Number(row.resumed) === 1,
    consumed: Number(row.consumed) === 1,
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
    ...(row.note === null ? {} : { note: row.note }),
  };
}

export function getApproval(db: ReadonlyDatabase, approvalId: string): Approval | undefined {
  const row = db.get<ApprovalRow>(`SELECT ${COLUMNS} FROM approvals WHERE approval_id = ?`, approvalId);
  return row && toApproval(row);
}

/** 全部审批，先来的在前（可按状态筛） */
export function listApprovals(db: ReadonlyDatabase, status?: ApprovalStatus): Approval[] {
  const rows =
    status === undefined
      ? db.all<ApprovalRow>(`SELECT ${COLUMNS} FROM approvals ORDER BY global_seq`)
      : db.all<ApprovalRow>(`SELECT ${COLUMNS} FROM approvals WHERE status = ? ORDER BY global_seq`, status);
  return rows.map(toApproval);
}

/**
 * 还没用掉的一次性授权：同一个 agent、同样的调用指纹、事后批准的，并且 categories（这次判定命中的关注类别 id）
 * 都在它当初批准过的类别里（符合的最早那条）
 */
export function findOneTimeGrant(db: ReadonlyDatabase, agentId: string, fingerprint: string, categories: readonly string[]): Approval | undefined {
  const rows = db.all<ApprovalRow>(
    `SELECT ${COLUMNS} FROM approvals WHERE agent_id = ? AND fingerprint = ? AND status = 'approved' AND resumed = 0 AND consumed = 0 ORDER BY global_seq`,
    agentId,
    fingerprint,
  );
  return rows.map(toApproval).find((grant) => categories.every((c) => grant.categories.includes(c)));
}
