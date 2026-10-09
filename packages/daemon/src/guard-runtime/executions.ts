// 有副作用的调用的执行记录（23 号票，规格第 17 节"被杀后的恢复"、第 21 节"只读或幂等"）。
// 守护进程被杀时 Job 对象把 agent 子进程连同它们起的进程一起结束，正在执行的工具调用说不清做没做完。按工具注册表分：
// - 只读或幂等的：不记在这里。重新拉起时会话文件里补一条"被中断"的工具结果（runtime 的 INTERRUPTED_TOOL_RESULT），
//   由模型决定要不要重做；
// - 由执行控制器负责恢复的（注册表的 recoveredByController，比如"宣布阶段完成"）：也不记，控制器重启后自己处理；
// - 其余的都按有副作用算（没登记、没标的一律算；bash 拆出的伪工具有一个不是只读或幂等的也算）：放行、开始执行时
//   记 tool_call_started，结束时记 tool_call_finished（成功还是失败、结果摘要；成功的和效果日志同一事务）。
//   还在执行时守护进程被杀（重启时，recovery/）或子进程意外退出（守卫接入看到它退出），记 tool_call_interrupted：
//   任务里的由执行控制器让任务转等我（原因"中断：不确定 X 是否已执行"，待我处理里一条卡着任务的"中断不确定"），
//   不属于任务的（秘书会话）同一事务在待我处理里放一条同样写法、不卡任务的事项；运行时不自动重做。
// pi 并行执行一批工具调用，全部结束才把结果写进会话文件：同一批里先做完的调用，结果还没写进去时被杀，重新拉起时
// 也要补——按结束记录补"已经做完了（结果……），不要重做"或"失败了"，不能当成说不清做没做完。所以结束的记录留到
// 这个 agent 又出了一条助手消息、或者这一轮结束（结果都写进会话了），守卫接入记 tool_calls_settled 才删掉。
// 派生视图 tool_executions：还在执行的、结束了结果还没写进会话的、被中断的（给重新拉起时补会话文件、用户回答时取调用摘要用）。
import { INTERRUPTED_ACK, type InterruptedNoticeData, PURGED_TEXT } from "@ergou/protocol";
import { listApprovals } from "../approvals/views.ts";
import type { DerivedView, EventStore, NewEvent, StoredEvent } from "../events/event-store.ts";
import type { PurgeRewriter } from "../events/purge.ts";
import { type GuardJudgement, isReadOnlyOrIdempotentCall, type ToolRegistry } from "../guard/index.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { INTERRUPTED_PREFIX, type InterruptedToolResult } from "../runtime/index.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { oneLine } from "../util/text.ts";
import { approvalSuspendedResult } from "./approval-waits.ts";
import { summarizeArgs, toolTitle } from "./describe.ts";
import {
  type ExecutionRecord,
  GUARD_CHANNEL,
  GUARD_EVENTS,
  type ToolCallFinishedPayload,
  type ToolCallInterruptedPayload,
  type ToolCallsSettledPayload,
  type ToolCallStartedPayload,
} from "./events.ts";

/** 执行记录的状态：还在执行、做完了（成功 / 失败，结果还没写进会话）、被中断了 */
type ExecutionState = "running" | "done" | "failed" | "interrupted";

export const executionsView: DerivedView = {
  name: "tool_executions",
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_executions (
        tool_call_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        state TEXT NOT NULL,
        record TEXT NOT NULL,
        result TEXT,
        global_seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tool_executions_by_agent ON tool_executions (agent_id, state);
    `),
  clear: (db) => db.exec("DELETE FROM tool_executions"),
  apply(db, event) {
    if (event.channel !== GUARD_CHANNEL) return;
    switch (event.type) {
      case GUARD_EVENTS.toolCallStarted: {
        const { execution } = event.payload as ToolCallStartedPayload;
        db.run(
          "INSERT OR REPLACE INTO tool_executions (tool_call_id, agent_id, state, record, result, global_seq) VALUES (?, ?, 'running', ?, NULL, ?)",
          execution.toolCallId,
          execution.origin.agentId,
          JSON.stringify(execution),
          event.globalSeq,
        );
        return;
      }
      case GUARD_EVENTS.toolCallFinished: {
        const p = event.payload as ToolCallFinishedPayload;
        db.run("UPDATE tool_executions SET state = ?, result = ? WHERE tool_call_id = ?", p.ok ? "done" : "failed", p.result, p.toolCallId);
        return;
      }
      case GUARD_EVENTS.toolCallInterrupted: {
        const { execution } = event.payload as ToolCallInterruptedPayload;
        db.run("UPDATE tool_executions SET state = 'interrupted', record = ? WHERE tool_call_id = ?", JSON.stringify(execution), execution.toolCallId);
        return;
      }
      case GUARD_EVENTS.toolCallsSettled: {
        const p = event.payload as ToolCallsSettledPayload;
        for (const id of p.toolCallIds) db.run("DELETE FROM tool_executions WHERE tool_call_id = ? AND state IN ('done', 'failed')", id);
        return;
      }
    }
  },
};

interface ExecutionRow {
  tool_call_id: string;
  state: ExecutionState;
  record: string;
  result: string | null;
}

function rowsOf(db: ReadonlyDatabase, states: readonly ExecutionState[], agentId?: string): ExecutionRow[] {
  const marks = states.map(() => "?").join(", ");
  return agentId === undefined
    ? db.all<ExecutionRow>(`SELECT tool_call_id, state, record, result FROM tool_executions WHERE state IN (${marks}) ORDER BY global_seq`, ...states)
    : db.all<ExecutionRow>(`SELECT tool_call_id, state, record, result FROM tool_executions WHERE state IN (${marks}) AND agent_id = ? ORDER BY global_seq`, ...states, agentId);
}

/** 还在执行（还没结束）的有副作用的调用；守护进程刚起来时就是被杀时正在执行的 */
export function runningExecutions(db: ReadonlyDatabase, agentId?: string): ExecutionRecord[] {
  return rowsOf(db, ["running"], agentId).map((row) => JSON.parse(row.record) as ExecutionRecord);
}

/**
 * 这个 agent 说不清做没做完的调用：还在执行的（守护进程刚起来、还没记中断的，或者子进程刚退出）和已经记成中断的。
 * 20 号票的子 agent 被打断、随任务停下时，交回维护者的说明里写明这些调用等用户确认、不要重做
 */
export function uncertainExecutions(db: ReadonlyDatabase, agentId: string): ExecutionRecord[] {
  return rowsOf(db, ["running", "interrupted"], agentId).map((row) => JSON.parse(row.record) as ExecutionRecord);
}

/** 这个 agent 做完了、结果可能还没写进会话的调用 id（它又出了一条助手消息、这一轮结束时记 tool_calls_settled） */
export function unsettledExecutions(db: ReadonlyDatabase, agentId: string): string[] {
  return rowsOf(db, ["done", "failed"], agentId).map((row) => row.tool_call_id);
}

/** 一次有副作用的调用的执行记录（还在视图里的：没结束、结果还没写进会话、被中断的） */
export function executionOf(db: ReadonlyDatabase, toolCallId: string): ExecutionRecord | undefined {
  const row = db.get<{ record: string }>("SELECT record FROM tool_executions WHERE tool_call_id = ?", toolCallId);
  return row && (JSON.parse(row.record) as ExecutionRecord);
}

const recoveredByController = (tools: ToolRegistry, name: string) => Object.hasOwn(tools, name) && tools[name]!.recoveredByController === true;

/** 要不要记执行记录：只读或幂等的、由执行控制器负责恢复的不记，其余都记 */
export function needsExecutionRecord(tools: ToolRegistry, toolName: string, judgement: GuardJudgement | undefined): boolean {
  return !isReadOnlyOrIdempotentCall(tools, toolName, judgement) && !recoveredByController(tools, toolName);
}

/** 规范化后的调用摘要（"中断：不确定 X 是否已执行"里的 X）：工具的中文名加参数摘要，和审批卡上的写法一样 */
export function callText(tools: ToolRegistry, toolName: string, args: unknown): string {
  return `${toolTitle(tools, toolName)}「${summarizeArgs(toolName, args)}」`;
}

/** "中断：不确定 X 是否已执行"（任务等我的原因、待我处理事项的标题） */
export function interruptionNote(call: string): string {
  return `中断：不确定${call}是否已执行`;
}

/** 被中断的有副作用的调用在会话文件里补上的结果（给模型看） */
export function uncertainToolResult(call: string): string {
  return `${INTERRUPTED_PREFIX}不确定${call}是否已执行。已经在待我处理里请用户确认，不要自己重做，也不要换个写法再做一遍；等用户告诉你做没做。`;
}

/** 同一批里已经做完、结果还没写进会话的调用补上的结果 */
function finishedToolResult(call: string, ok: boolean, result: string | null): InterruptedToolResult {
  const said = result ? `，结果：${result}` : "";
  return ok
    ? { text: `这次调用已经执行完了（${call}${said}）。守护进程（或 agent 子进程）重启时结果还没写进会话；不要重做，接着往下做。`, isError: false }
    : { text: `这次调用执行失败了（${call}${said}）。守护进程（或 agent 子进程）重启时结果还没写进会话。`, isError: true };
}

/**
 * 一次被中断的调用要追加的事件：tool_call_interrupted；不属于任务的（秘书会话）同一事务在待我处理里放一条
 * "中断不确定"（不卡任务，动作"知道了"）。任务里的由执行控制器看到 tool_call_interrupted 后处理（任务转等我，卡着任务的事项）
 */
export function interruptionEvents(inbox: InboxService, execution: ExecutionRecord, time: string): NewEvent[] {
  const payload: ToolCallInterruptedPayload = { execution, time };
  const events: NewEvent[] = [{ channel: GUARD_CHANNEL, type: GUARD_EVENTS.toolCallInterrupted, payload }];
  if (execution.origin.taskId === null) {
    const note = interruptionNote(execution.call);
    const data: InterruptedNoticeData = { toolCallId: execution.toolCallId, agentId: execution.origin.agentId, taskId: null };
    events.push(
      inbox.buildAdd({
        kind: "notice",
        notice: "interrupted",
        title: oneLine(note, 60),
        body: `${execution.origin.source}里正在执行${execution.call}时，守护进程（或 agent 子进程）重启了，说不清它做没做完。运行时不会自动重做；需要的话你自己去看看，再告诉它。`,
        source: execution.origin.source,
        urgency: "non_blocking",
        actions: [INTERRUPTED_ACK],
        data: { ...data },
      }).event,
    );
  }
  return events;
}

/** 等审批时被中断（守护进程被杀、子进程意外退出）的调用补上的结果：没有执行，审批卡还在，决定了会收到通知 */
export function approvalInterruptedResult(approval: { toolTitle: string; argsSummary: string }): string {
  return `${approvalSuspendedResult(approval, "守护进程（或 agent 子进程）重启时这次调用还在等用户批准，没有执行")}用户拒绝了你也会收到通知。`;
}

/**
 * 重新拉起一个 agent、接着会话时，它最后一个回合里还没有结果的工具调用补上的结果（工具调用 id → 结果，交给 agent 管家）：
 * - 等审批的（还待处理的审批，和事后批准了、还没用掉的一次性授权——拉起之前用户可能已经批准了）：没有执行，审批卡还在，
 *   批准后原样重试；
 * - 有副作用的：做完了的（同一批里先做完、结果还没写进会话）按结束记录补"已经执行完了，不要重做"或"失败了"；
 *   被中断的、还在执行的（守护进程刚起来、还没记中断的）补"不确定是否已执行，不要自己重做"。
 * 只读或幂等的不在这里，子进程用默认的那句。会话文件里已经有结果的调用，子进程不会再补，所以多给了也没关系
 */
export function interruptedToolResults(db: ReadonlyDatabase, agentId: string): Record<string, InterruptedToolResult> {
  const results: Record<string, InterruptedToolResult> = {};
  const approvals = [...listApprovals(db, "pending"), ...listApprovals(db, "approved").filter((a) => !a.resumed && !a.consumed)];
  for (const approval of approvals) {
    if (approval.origin.agentId === agentId) results[approval.toolCallId] = { text: approvalInterruptedResult(approval), isError: true };
  }
  for (const row of rowsOf(db, ["running", "interrupted", "done", "failed"], agentId)) {
    const { call } = JSON.parse(row.record) as ExecutionRecord;
    results[row.tool_call_id] =
      row.state === "done" || row.state === "failed" ? finishedToolResult(call, row.state === "done", row.result) : { text: uncertainToolResult(call), isError: true };
  }
  return results;
}

/**
 * 彻底删除（21 号票）、删除项目（15 号票）：执行记录里的调用摘要、结果摘要（参数、输出里可能有原话）换成删除标记，
 * 调用 id、来源、工具、成功与否、时间不变（派生视图照样知道哪次调用还在执行、被中断了）
 */
export const executionPurges: readonly PurgeRewriter[] = [
  {
    eventType: GUARD_EVENTS.toolCallStarted,
    rewrite(event) {
      const { execution } = event.payload as ToolCallStartedPayload;
      return { execution: { ...execution, call: PURGED_TEXT } } satisfies ToolCallStartedPayload;
    },
  },
  {
    eventType: GUARD_EVENTS.toolCallFinished,
    rewrite(event) {
      const p = event.payload as ToolCallFinishedPayload;
      return { ...p, result: p.result === "" ? "" : PURGED_TEXT } satisfies ToolCallFinishedPayload;
    },
  },
  {
    eventType: GUARD_EVENTS.toolCallInterrupted,
    rewrite(event) {
      const p = event.payload as ToolCallInterruptedPayload;
      return { ...p, execution: { ...p.execution, call: PURGED_TEXT } } satisfies ToolCallInterruptedPayload;
    },
  },
];

/** 带调用摘要、结果摘要的执行记录事件 */
const EXECUTION_TEXT_EVENTS = [GUARD_EVENTS.toolCallStarted, GUARD_EVENTS.toolCallFinished, GUARD_EVENTS.toolCallInterrupted] as const;

/** 执行记录事件说的是哪次调用、哪个 agent 的 */
function executionKey(event: StoredEvent): { toolCallId: string; agentId: string } {
  if (event.type === GUARD_EVENTS.toolCallFinished) return event.payload as ToolCallFinishedPayload;
  const { execution } = event.payload as ToolCallStartedPayload;
  return { toolCallId: execution.toolCallId, agentId: execution.origin.agentId };
}

/** 这次调用的执行记录事件（彻底删除时连同别处同样的调用摘要一起改写，见 memory/purge.ts） */
export function executionEventsOfCall(store: EventStore, toolCallId: string): StoredEvent[] {
  return EXECUTION_TEXT_EVENTS.flatMap((type) => store.mentioning(type, toolCallId).filter((e) => e.channel === GUARD_CHANNEL && executionKey(e).toolCallId === toolCallId));
}

/** 这个 agent 的执行记录事件（删除项目时改写维护者的） */
export function executionEventsOfAgent(store: EventStore, agentId: string): StoredEvent[] {
  return EXECUTION_TEXT_EVENTS.flatMap((type) => store.read(GUARD_CHANNEL, 0, type).filter((e) => executionKey(e).agentId === agentId));
}
