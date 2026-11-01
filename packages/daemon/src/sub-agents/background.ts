// 负责人背后的 agent（"应该可以有地方实时查看背后有哪几个 agent 在运行，在做什么，进展如何。已经完成的 subagent 的
// 对话历史可以查看，但无法再唤起"）：并行派出去的子 agent、评审子 agent 的列表和只读对话，给网页现取（GET /api/agents/<id>/background、…/transcript）。
// - 视图 background_agents：sub_agents 频道上的事件归并成每个 agent 一行（属于谁、派去做什么、什么时候拉起和结束）和它的一条条话；
//   表是新建的（老库升上来）时从事件日志补一遍，以前跑的子 agent 一样有一行，只是没有"说的话"；
// - 一行上的工具调用次数、最近一步来自工具调用的完整内容（tool_call_details，每次经守卫的调用都有，评审的也在），用量来自账本（token_ledger），
//   都按 agent id 现查；以前的评审没有事件，从账本认出来（有什么显示什么）；
// - 任务删了（连带项目删了的内部任务）：一行不再给，只读对话回没有。收到的指令、说的话随删除换成删除标记（material-source.ts）；
// - 有变化（这几样事件追加了）时在背后的 agent 频道上推一条临时事件，同一个负责人最多每 BACKGROUND_AGENTS_PUSH_MS 一条，网页收到后重新取。
// 这里只读不写（评审那一半的写在 reviewRecorder）：不改派发和审批，也不碰负责人会话里的工具调用记录。
import {
  BACKGROUND_AGENTS_PUSH_MS,
  type BackgroundAgentEntry,
  type BackgroundAgentRow,
  type BackgroundAgentState,
  type BackgroundAgentStep,
  type BackgroundAgentsEventPayload,
  type BackgroundAgentTranscript,
  CHANNELS,
  EVENT_TYPES,
  type EventFrame,
  type LedgerRole,
  type Task,
  type ToolCallDetail,
} from "@ergo/protocol";
import type { DerivedView, EventStore, StoredEvent } from "../events/event-store.ts";
import { BUILTIN_TOOL_REGISTRY } from "../guard/index.ts";
import { getMessage } from "../conversation/views.ts";
import { resultSummary, summarizeArgs } from "../guard-runtime/describe.ts";
import { detailEventAt, TOOL_CALL_DETAIL_EVENT, TOOL_CALLS_CHANNEL } from "../guard-runtime/tool-call-details.ts";
import { LEDGER_CHANNEL, TOKEN_USAGE_EVENT, type TokenUsagePayload } from "../ledger/entry.ts";
import type { Database, ReadonlyDatabase } from "../storage/sqlite.ts";
import type { ReviewRecorder } from "../tasks/review.ts";
import { createKeyedThrottle } from "../util/throttle.ts";
import { oneLine } from "../util/text.ts";
import {
  type AgentSaidPayload,
  type ParallelDecidedPayload,
  type ParallelProposedPayload,
  type ReviewFinishedPayload,
  type ReviewStartedPayload,
  SUB_AGENT_EVENTS,
  type SubAgentFinishedPayload,
  type SubAgentOutcome,
  SUB_AGENTS_CHANNEL,
  type SubAgentStartedPayload,
} from "./events.ts";

/** 派去做什么那一句（工作说明的第一行）最多这么长 */
const BRIEF_MAX = 80;

const TABLES = `
  CREATE TABLE IF NOT EXISTS background_agents (
    agent_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    maintainer_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    stage_id TEXT,
    stage_title TEXT,
    step TEXT,
    instructions TEXT,
    status TEXT NOT NULL,
    outcome TEXT,
    started_at TEXT,
    ended_at TEXT,
    message_id TEXT,
    global_seq INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS background_agents_by_maintainer ON background_agents (maintainer_id, global_seq);
  CREATE TABLE IF NOT EXISTS background_agent_lines (
    global_seq INTEGER PRIMARY KEY,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    time TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS background_agent_lines_by_agent ON background_agent_lines (agent_id, global_seq);
`;

export const backgroundAgentsView: DerivedView = {
  name: "background_agents",
  // 老库升上来时表是新建的：从事件日志补回来（以前的子 agent 也要有一行）
  create: (db) => {
    const fresh = db.all<{ name: string }>("PRAGMA table_info(background_agents)").length === 0;
    db.exec(TABLES);
    return fresh ? "refill" : undefined;
  },
  channels: [SUB_AGENTS_CHANNEL],
  clear: (db) => db.exec("DELETE FROM background_agents; DELETE FROM background_agent_lines"),
  apply(db, event) {
    if (event.channel === SUB_AGENTS_CHANNEL) applyEvent(db, event);
  },
};

function applyEvent(db: Database, event: StoredEvent): void {
  switch (event.type) {
    case SUB_AGENT_EVENTS.parallelProposed: {
      const p = event.payload as ParallelProposedPayload;
      for (const a of p.agents) {
        db.run(
          "INSERT OR IGNORE INTO background_agents (agent_id, kind, maintainer_id, task_id, stage_id, stage_title, step, instructions, status, global_seq) VALUES (?, 'sub_agent', ?, ?, ?, ?, ?, ?, 'proposed', ?)",
          a.agentId,
          p.maintainerId,
          p.taskId,
          a.stageId,
          a.stageTitle,
          a.step ?? null,
          a.instructions,
          event.globalSeq,
        );
      }
      return;
    }
    case SUB_AGENT_EVENTS.parallelDecided: {
      const p = event.payload as ParallelDecidedPayload;
      // 哪几个是这次提议的：决定里写了（提议被别的提议顶掉、过期的不会有决定，它们一直停在 proposed，列表不给）
      for (const a of p.agents) db.run("UPDATE background_agents SET status = ? WHERE agent_id = ? AND status = 'proposed'", p.decision === "parallel" ? "confirmed" : "declined", a.agentId);
      return;
    }
    case SUB_AGENT_EVENTS.subAgentStarted: {
      const p = event.payload as SubAgentStartedPayload;
      db.run("UPDATE background_agents SET status = 'running', started_at = ? WHERE agent_id = ?", p.time, p.agentId);
      return;
    }
    case SUB_AGENT_EVENTS.subAgentFinished: {
      const p = event.payload as SubAgentFinishedPayload;
      db.run("UPDATE background_agents SET status = 'finished', outcome = ?, ended_at = ?, message_id = ? WHERE agent_id = ?", p.outcome, p.time, p.messageId, p.agentId);
      return;
    }
    case SUB_AGENT_EVENTS.reviewStarted: {
      const p = event.payload as ReviewStartedPayload;
      // 同一个 id 再跑一次（守护进程重启后重新评审）：算新的一次
      db.run(
        `INSERT INTO background_agents (agent_id, kind, maintainer_id, task_id, stage_id, stage_title, status, started_at, global_seq) VALUES (?, 'reviewer', ?, ?, ?, ?, 'running', ?, ?)
         ON CONFLICT (agent_id) DO UPDATE SET status = 'running', outcome = NULL, stage_title = excluded.stage_title, started_at = excluded.started_at, ended_at = NULL`,
        p.agentId,
        p.maintainerId,
        p.taskId,
        p.stageId,
        p.stageTitle,
        p.time,
        event.globalSeq,
      );
      return;
    }
    case SUB_AGENT_EVENTS.reviewFinished: {
      const p = event.payload as ReviewFinishedPayload;
      db.run("UPDATE background_agents SET status = 'finished', outcome = ?, ended_at = ? WHERE agent_id = ?", p.outcome, p.time, p.agentId);
      return;
    }
    case SUB_AGENT_EVENTS.agentSaid: {
      const p = event.payload as AgentSaidPayload;
      db.run("INSERT INTO background_agent_lines (global_seq, agent_id, kind, text, time) VALUES (?, ?, ?, ?, ?)", event.globalSeq, p.agentId, p.kind, p.text, p.time);
      return;
    }
    default:
      return;
  }
}

/** 视图里的一行 */
interface AgentRecord {
  agent_id: string;
  kind: BackgroundAgentRow["kind"];
  maintainer_id: string;
  task_id: string;
  stage_id: string | null;
  stage_title: string | null;
  step: string | null;
  instructions: string | null;
  status: string;
  outcome: SubAgentOutcome | null;
  started_at: string | null;
  ended_at: string | null;
  message_id: string | null;
}

/** 视图里算数的：拉起过、用户同意了的（提议了没同意、不同意的不算背后的 agent） */
const LISTED = "status IN ('confirmed', 'running', 'finished')";

function stateOf(r: Pick<AgentRecord, "status" | "outcome">): BackgroundAgentState {
  if (r.status !== "finished") return "running";
  if (r.outcome === "done") return "done";
  return r.outcome === "error" ? "failed" : "stopped";
}

/** 工作说明的第一行 */
function briefOf(instructions: string | null): string | undefined {
  const first = instructions?.split("\n").find((line) => line.trim() !== "");
  return first === undefined ? undefined : oneLine(first, BRIEF_MAX);
}

/** 一次调用的完整内容说成工具调用记录上的那种摘要（清掉了的、删掉了的照它们剩下的算） */
function stepOf(detail: ToolCallDetail): BackgroundAgentStep {
  return { tool: detail.tool, argsSummary: summarizeArgs(BUILTIN_TOOL_REGISTRY, detail.tool, detail.args), at: detail.endedAt ?? detail.startedAt ?? "" };
}

function callCount(db: ReadonlyDatabase, agentId: string): { calls: number; last: number | undefined } {
  const row = db.get<{ calls: number; last: number | null }>("SELECT COUNT(*) AS calls, MAX(global_seq) AS last FROM tool_call_details WHERE agent_id = ?", agentId);
  return { calls: Number(row?.calls ?? 0), last: row?.last === null || row?.last === undefined ? undefined : Number(row.last) };
}

function tokensOf(db: ReadonlyDatabase, agentId: string): { tokens: number; cacheHitTokens: number } {
  const row = db.get<{ hit: number | null; miss: number | null; output: number | null }>("SELECT SUM(cache_hit) AS hit, SUM(cache_miss) AS miss, SUM(output) AS output FROM token_ledger WHERE agent_id = ?", agentId);
  const hit = Number(row?.hit ?? 0);
  return { tokens: hit + Number(row?.miss ?? 0) + Number(row?.output ?? 0), cacheHitTokens: hit };
}

export interface BackgroundAgentsOptions {
  store: EventStore;
  tasks: { get(taskId: string): Task | undefined; list(): readonly Task[] };
  /** 推一条临时事件 */
  publish: (frame: EventFrame) => void;
  log: (line: string) => void;
}

export interface BackgroundAgents {
  /** 这个负责人背后的 agent：运行中的在前，再按拉起的先后新的在前 */
  list(maintainerId: string): BackgroundAgentRow[];
  /** 背后的一个 agent 的只读对话；不是背后的 agent、任务删掉了的没有 */
  transcript(agentId: string): BackgroundAgentTranscript | undefined;
  /** 接上事件：有变化就推一条 */
  start(): void;
  stop(): void;
}

export function createBackgroundAgents(options: BackgroundAgentsOptions): BackgroundAgents {
  const { store, tasks, publish, log } = options;
  const db = store.reader;

  /** 视图里的一行加上现查的几样，说成给网页的一行；任务删了的没有 */
  const rowOf = (r: AgentRecord, withStep: boolean): BackgroundAgentRow | undefined => {
    const task = tasks.get(r.task_id);
    if (!task) return undefined;
    const state = stateOf(r);
    const { calls, last } = callCount(db, r.agent_id);
    const detail = withStep && state === "running" && last !== undefined ? (detailEventAt(store, last)?.payload as ToolCallDetail | undefined) : undefined;
    const brief = briefOf(r.instructions);
    return {
      agentId: r.agent_id,
      kind: r.kind,
      taskId: r.task_id,
      taskTitle: task.title,
      ...(r.stage_id === null ? {} : { stageId: r.stage_id }),
      ...(r.stage_title === null ? {} : { stageTitle: r.stage_title }),
      ...(r.step === null ? {} : { step: r.step }),
      ...(brief === undefined ? {} : { brief }),
      state,
      ...(r.outcome === null ? {} : { outcome: r.outcome }),
      ...(r.started_at === null ? {} : { startedAt: r.started_at }),
      ...(r.ended_at === null ? {} : { endedAt: r.ended_at }),
      toolCalls: calls,
      ...(detail ? { lastStep: stepOf(detail) } : {}),
      ...tokensOf(db, r.agent_id),
    };
  };

  /** 以前的评审：没有事件，账本里有它的用量。有什么显示什么（算做完了：它早就不在了） */
  const legacyReviews = (maintainerId: string, known: ReadonlySet<string>): BackgroundAgentRow[] =>
    tasks
      .list()
      .filter((task) => task.maintainerId === maintainerId)
      .flatMap((task) =>
        db
          .all<{ agent_id: string; stage_id: string | null; first: string; last: string }>(
            "SELECT agent_id, MIN(stage_id) AS stage_id, MIN(time) AS first, MAX(time) AS last FROM token_ledger WHERE owner_kind = 'task' AND owner_id = ? AND role = ? GROUP BY agent_id ORDER BY MIN(global_seq)",
            task.id,
            "reviewer" satisfies LedgerRole,
          )
          .filter((r) => !known.has(r.agent_id))
          .map((r): BackgroundAgentRow => ({
            agentId: r.agent_id,
            kind: "reviewer",
            taskId: task.id,
            taskTitle: task.title,
            ...(r.stage_id === null ? {} : { stageId: r.stage_id }),
            state: "done",
            startedAt: r.first,
            endedAt: r.last,
            toolCalls: callCount(db, r.agent_id).calls,
            ...tokensOf(db, r.agent_id),
          })),
      );

  const list: BackgroundAgents["list"] = (maintainerId) => {
    const records = db.all<AgentRecord>(`SELECT * FROM background_agents WHERE maintainer_id = ? AND ${LISTED} ORDER BY global_seq DESC`, maintainerId);
    const rows = records.flatMap((r) => rowOf(r, true) ?? []);
    const legacy = legacyReviews(maintainerId, new Set(records.map((r) => r.agent_id))).toReversed();
    const all = [...rows, ...legacy];
    return [...all.filter((r) => r.state === "running"), ...all.filter((r) => r.state !== "running")];
  };

  const transcript: BackgroundAgents["transcript"] = (agentId) => {
    const record = db.get<AgentRecord>(`SELECT * FROM background_agents WHERE agent_id = ? AND ${LISTED}`, agentId);
    const agent = record ? rowOf(record, true) : legacyReviewRow(agentId);
    if (!agent) return undefined;
    const lines = db.all<{ global_seq: number; kind: "input" | "said"; text: string; time: string }>("SELECT global_seq, kind, text, time FROM background_agent_lines WHERE agent_id = ? ORDER BY global_seq", agentId);
    const calls = db.all<{ global_seq: number }>("SELECT global_seq FROM tool_call_details WHERE agent_id = ? ORDER BY global_seq", agentId);
    const entries: Array<{ seq: number; entry: BackgroundAgentEntry }> = [
      ...lines.map((l) => ({ seq: Number(l.global_seq), entry: { kind: l.kind, text: l.text, at: l.time } satisfies BackgroundAgentEntry })),
      ...calls.flatMap((c) => {
        const detail = detailEventAt(store, Number(c.global_seq))?.payload as ToolCallDetail | undefined;
        if (!detail) return [];
        const entry: BackgroundAgentEntry = { kind: "tool_call", callId: detail.callId, tool: detail.tool, argsSummary: summarizeArgs(BUILTIN_TOOL_REGISTRY, detail.tool, detail.args), outcome: detail.outcome, resultSummary: resultSummary(detail.result), at: detail.endedAt ?? detail.startedAt ?? "" };
        return [{ seq: Number(c.global_seq), entry }];
      }),
    ];
    // 交回负责人的结果：结束时进了负责人的会话的那条消息（评审的结论是它 submit_review 那次工具调用，不另有）
    const message = record?.message_id ? getMessage(db, record.message_id) : undefined;
    const result = message?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
    return {
      agent,
      ...(record?.instructions ? { instructions: record.instructions } : {}),
      entries: [...entries.toSorted((a, b) => a.seq - b.seq).map((e) => e.entry), ...(result ? [{ kind: "result" as const, text: result, at: agent.endedAt ?? message?.time ?? "" }] : [])],
      saidRecorded: lines.length > 0,
    };
  };

  /** 老的评审（没有事件）的一行：从账本认出来 */
  const legacyReviewRow = (agentId: string): BackgroundAgentRow | undefined => {
    const owner = db.get<{ owner_id: string | null }>("SELECT owner_id FROM token_ledger WHERE agent_id = ? AND owner_kind = 'task' AND role = ? LIMIT 1", agentId, "reviewer" satisfies LedgerRole);
    const task = owner?.owner_id ? tasks.get(owner.owner_id) : undefined;
    return task ? legacyReviews(task.maintainerId, new Set()).find((r) => r.agentId === agentId) : undefined;
  };

  /** 这个 agent 是谁背后的（不是背后的 agent 没有） */
  const maintainerOf = (agentId: string): string | undefined => db.get<{ maintainer_id: string }>("SELECT maintainer_id FROM background_agents WHERE agent_id = ?", agentId)?.maintainer_id;

  /** 这条事件动到了哪个负责人背后的 agent */
  const touched = (event: StoredEvent): string | undefined => {
    if (event.channel === SUB_AGENTS_CHANNEL) {
      const p = event.payload as { agentId?: string; agents?: ReadonlyArray<{ agentId: string }> };
      const agentId = p.agentId ?? p.agents?.[0]?.agentId;
      return agentId === undefined ? undefined : maintainerOf(agentId);
    }
    if (event.channel === TOOL_CALLS_CHANNEL && event.type === TOOL_CALL_DETAIL_EVENT) return maintainerOf((event.payload as ToolCallDetail).agentId);
    if (event.channel === LEDGER_CHANNEL && event.type === TOKEN_USAGE_EVENT) return maintainerOf((event.payload as TokenUsagePayload).agentId);
    return undefined;
  };

  const throttle = createKeyedThrottle<string>({
    intervalMs: BACKGROUND_AGENTS_PUSH_MS,
    flush(maintainerId) {
      const payload: BackgroundAgentsEventPayload = { maintainerId };
      publish({ channel: CHANNELS.backgroundAgents, seq: store.lastSeq(CHANNELS.backgroundAgents), type: EVENT_TYPES.backgroundAgents, payload });
      return true;
    },
  });
  let unsubscribe: (() => void) | undefined;

  return {
    list,
    transcript,
    start() {
      unsubscribe = store.onAppend((event) => {
        try {
          const maintainerId = touched(event);
          if (maintainerId !== undefined) throttle.schedule(maintainerId);
        } catch (err) {
          log(`背后的 agent 处理事件 ${event.type} 出错：${err instanceof Error ? err.message : String(err)}`);
        }
      });
    },
    stop() {
      unsubscribe?.();
      throttle.close();
    },
  };
}

/** 记下一次评审（tasks/review.ts 的 record）：拉起、结束、收到的输入、说的话。记不下不影响评审 */
export function reviewRecorder({ store, tasks, log }: { store: EventStore; tasks: { get(taskId: string): Task | undefined }; log: (line: string) => void }): ReviewRecorder {
  const append = (type: string, payload: unknown) => {
    try {
      store.append({ channel: SUB_AGENTS_CHANNEL, type, payload });
    } catch (err) {
      log(`记评审 ${type} 出错：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return {
    started(agentId, input) {
      const maintainerId = tasks.get(input.taskId)?.maintainerId;
      if (maintainerId === undefined) return;
      append(SUB_AGENT_EVENTS.reviewStarted, { agentId, taskId: input.taskId, stageId: input.stageId, stageTitle: input.stageTitle, maintainerId, time: store.now() } satisfies ReviewStartedPayload);
    },
    line(agentId, taskId, { kind, text }) {
      append(SUB_AGENT_EVENTS.agentSaid, { agentId, taskId, kind, text, time: store.now() } satisfies AgentSaidPayload);
    },
    finished(agentId, taskId, outcome) {
      append(SUB_AGENT_EVENTS.reviewFinished, { agentId, taskId, outcome, time: store.now() } satisfies ReviewFinishedPayload);
    },
  };
}
