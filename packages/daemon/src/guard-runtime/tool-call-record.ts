// 聊天里的工具调用记录（规格第 5、9 节）：不论结果，每次工具调用在 tool_call_end 时往会话里追加一条工具调用 part——
// 工具名、参数摘要、命中的关注类别、判定、是否授权内、是否通用 bash、结果。
import type { ConversationId, MessagePart } from "@ergou/protocol";
import { appendMessage } from "../conversation/messages.ts";
import type { EventStore } from "../events/event-store.ts";
import { type GuardInput, type GuardJudgement, TOOL, type WatchCategorySettings } from "../guard/index.ts";
import type { AgentReport } from "../runtime/index.ts";
import { categoryTitle, resultSummary, summarizeArgs, WIRE_DISPOSITION } from "./describe.ts";

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
export type ToolCallEnd = Extract<AgentReport, { type: "tool_call_end" }>;

/** 一次工具调用从判定到结束 */
export interface CallState {
  toolCallId: string;
  toolName: string;
  args: unknown;
  input?: GuardInput;
  judgement?: GuardJudgement;
  /** 判定用到的关注类别设置（全局的，加上任务计划里的）：类别 id 换成显示用的名字 */
  settings: WatchCategorySettings[];
  /** allowed：放行了；waiting：在等审批；denied：用户拒绝；suspended：等审批超时；blocked：别的原因拦下；aborted：等的时候回合中止 */
  outcome: "allowed" | "waiting" | "denied" | "suspended" | "blocked" | "aborted";
  /** 被拦下的原因不是处置时：硬拒绝、按规则退回、判定出错 */
  blockedBy?: "hard_refusal" | "pull_back" | "judge_error";
  approvalId?: string;
  /** 用户拒绝时附带的说明 */
  note?: string;
}

export function newCallState(report: Extract<AgentReport, { type: "guard_request" }>): CallState {
  return { toolCallId: report.toolCallId, toolName: report.toolName, args: report.args, outcome: "blocked", settings: [] };
}

/** 往会话里追加这次调用的记录 */
export function appendToolCallRecord(store: EventStore, conversation: ConversationId, state: CallState, end: ToolCallEnd): void {
  appendMessage(store, { conversation, speaker: "agent", parts: [toolCallPart(state, end)] });
}

/** 聊天里的一条工具调用 part */
export function toolCallPart(state: CallState, end: ToolCallEnd): ToolCallPart {
  const j = state.judgement;
  const outcome = state.outcome === "allowed" ? (end.isError ? "error" : "done") : state.outcome === "denied" ? "denied" : "blocked";
  return {
    type: "tool_call",
    callId: state.toolCallId,
    tool: state.toolName,
    argsSummary: summarizeArgs(state.toolName, state.args),
    categoryTitles: (j?.categories ?? []).map((id) => categoryTitle(id, state.settings)),
    // 判定出错时没有处置
    ...(j ? { disposition: WIRE_DISPOSITION[j.disposition] } : {}),
    ...(state.blockedBy === undefined ? {} : { blockedBy: state.blockedBy }),
    withinGrant: j?.withinGrant ?? false,
    genericBash: j?.genericShell ?? state.toolName === TOOL.bash,
    outcome,
    ...summaryOf(state, end),
  };
}

function summaryOf(state: CallState, end: ToolCallEnd): { resultSummary?: string } {
  const text =
    state.blockedBy === "judge_error"
      ? "未执行：守卫判定出错"
      : state.outcome === "denied"
        ? `你拒绝了${state.note ? `：${state.note}` : ""}`
        : state.outcome === "suspended"
          ? "已提交审批，等待用户"
          : state.outcome === "aborted"
            ? "等审批时回合中止了"
            : resultSummary(end.resultText);
  return text === "" ? {} : { resultSummary: text };
}
