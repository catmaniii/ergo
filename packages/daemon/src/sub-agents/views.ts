// 子 agent 的派生视图（20 号票）：sub_agents 频道上的事件归并成每个子 agent 一行——属于哪个任务的哪个阶段、
// 由哪个维护者提议、在哪个目录里干活、走到哪一步（提议了 → 用户同意或不同意 → 拉起 → 结束）。
// 任务执行控制器据此知道哪些阶段有子 agent 在做；24 号票按它把子 agent 的用量归到所属任务（ownerOf）。
import type { DerivedView } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import {
  type ParallelDecidedPayload,
  type ParallelProposedPayload,
  SUB_AGENT_EVENTS,
  type SubAgentFinishedPayload,
  type SubAgentOutcome,
  type SubAgentOwner,
  SUB_AGENTS_CHANNEL,
  type SubAgentStartedPayload,
} from "./events.ts";

/**
 * 一个子 agent 走到哪一步：提议了（proposed）、用户不同意（declined）、用户同意了（confirmed，马上拉起）、
 * 拉起了（running，名额满了时在排队）、结束了（finished）
 */
export type SubAgentStatus = "proposed" | "declined" | "confirmed" | "running" | "finished";

export interface SubAgentRecord extends SubAgentOwner {
  agentId: string;
  /** 提议时的并行确认卡 */
  cardId: string;
  workDir: string;
  status: SubAgentStatus;
  outcome?: SubAgentOutcome;
}

export const subAgentsView: DerivedView = {
  name: "sub_agents",
  create: (db) =>
    db.exec(
      "CREATE TABLE IF NOT EXISTS sub_agents (agent_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, task_id TEXT NOT NULL, stage_id TEXT NOT NULL, maintainer_id TEXT NOT NULL, card_id TEXT NOT NULL, work_dir TEXT NOT NULL, status TEXT NOT NULL, outcome TEXT, global_seq INTEGER NOT NULL)",
    ),
  clear: (db) => db.exec("DELETE FROM sub_agents"),
  apply(db, event) {
    if (event.channel !== SUB_AGENTS_CHANNEL) return;
    switch (event.type) {
      case SUB_AGENT_EVENTS.parallelProposed: {
        const p = event.payload as ParallelProposedPayload;
        for (const a of p.agents) {
          db.run(
            "INSERT INTO sub_agents (agent_id, proposal_id, task_id, stage_id, maintainer_id, card_id, work_dir, status, global_seq) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)",
            a.agentId,
            p.proposalId,
            p.taskId,
            a.stageId,
            p.maintainerId,
            p.cardId,
            a.workDir,
            event.globalSeq,
          );
        }
        return;
      }
      case SUB_AGENT_EVENTS.parallelDecided: {
        const p = event.payload as ParallelDecidedPayload;
        db.run("UPDATE sub_agents SET status = ? WHERE proposal_id = ? AND status = 'proposed'", p.decision === "parallel" ? "confirmed" : "declined", p.proposalId);
        return;
      }
      case SUB_AGENT_EVENTS.subAgentStarted: {
        const p = event.payload as SubAgentStartedPayload;
        db.run("UPDATE sub_agents SET status = 'running' WHERE agent_id = ?", p.agentId);
        return;
      }
      case SUB_AGENT_EVENTS.subAgentFinished: {
        const p = event.payload as SubAgentFinishedPayload;
        db.run("UPDATE sub_agents SET status = 'finished', outcome = ? WHERE agent_id = ?", p.outcome, p.agentId);
        return;
      }
      default:
        return;
    }
  },
};

interface Row {
  agent_id: string;
  proposal_id: string;
  task_id: string;
  stage_id: string;
  maintainer_id: string;
  card_id: string;
  work_dir: string;
  status: SubAgentStatus;
  outcome: SubAgentOutcome | null;
}

const COLUMNS = "agent_id, proposal_id, task_id, stage_id, maintainer_id, card_id, work_dir, status, outcome";

const record = (r: Row): SubAgentRecord => ({
  agentId: r.agent_id,
  proposalId: r.proposal_id,
  taskId: r.task_id,
  stageId: r.stage_id,
  maintainerId: r.maintainer_id,
  cardId: r.card_id,
  workDir: r.work_dir,
  status: r.status,
  ...(r.outcome === null ? {} : { outcome: r.outcome }),
});

/** 一个子 agent（不是子 agent 的 id 没有） */
export function getSubAgent(db: ReadonlyDatabase, agentId: string): SubAgentRecord | undefined {
  const row = db.get<Row>(`SELECT ${COLUMNS} FROM sub_agents WHERE agent_id = ?`, agentId);
  return row ? record(row) : undefined;
}

/** 某次提议的子 agent，按提议里的顺序 */
export function proposalAgents(db: ReadonlyDatabase, proposalId: string): SubAgentRecord[] {
  return db.all<Row>(`SELECT ${COLUMNS} FROM sub_agents WHERE proposal_id = ? ORDER BY global_seq, rowid`, proposalId).map(record);
}

/** 还在做的子 agent（用户同意了、拉起了还没结束的，含排队的）；给了任务就只看这个任务的 */
export function liveSubAgents(db: ReadonlyDatabase, taskId?: string): SubAgentRecord[] {
  const rows =
    taskId === undefined
      ? db.all<Row>(`SELECT ${COLUMNS} FROM sub_agents WHERE status IN ('confirmed', 'running') ORDER BY global_seq, rowid`)
      : db.all<Row>(`SELECT ${COLUMNS} FROM sub_agents WHERE task_id = ? AND status IN ('confirmed', 'running') ORDER BY global_seq, rowid`, taskId);
  return rows.map(record);
}

/** 提议过几个子 agent、几次并行（编号接着往下排） */
export function subAgentCounts(db: ReadonlyDatabase): { agents: number; proposals: number } {
  const row = db.get<{ agents: number; proposals: number }>("SELECT COUNT(*) AS agents, COUNT(DISTINCT proposal_id) AS proposals FROM sub_agents");
  return { agents: row?.agents ?? 0, proposals: row?.proposals ?? 0 };
}

/** 某个任务里还没等到用户决定的提议的并行确认卡 */
export function undecidedProposalCards(db: ReadonlyDatabase, taskId: string): string[] {
  return db.all<{ card_id: string }>("SELECT DISTINCT card_id FROM sub_agents WHERE task_id = ? AND status = 'proposed'", taskId).map((r) => r.card_id);
}
