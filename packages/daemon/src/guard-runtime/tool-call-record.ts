// 聊天里的工具调用记录（规格第 5、9 节）：不论结果，每次工具调用在 tool_call_end 时往会话里追加一条工具调用 part——
// 工具名、参数摘要、命中的关注类别、判定、是否授权内、是否通用 bash、结果，以及做了什么性质的事（只看、动手、删改，54 号票，
// guard/nature.ts；守卫判定出错的没有）、要动的是对外的事还是本机的敏感权限（外 / 权，93 号票，同一个文件的 toolCallMark）、
// 任务的 agent 超出授权先不管直接做的（beyondGrant，101 号票）；子代理里的调用带上调用它的那次调用（parentCallId，288 号票）。
// 写进事件日志之前过一遍 CallPrivacy（read-secrets.ts）：读了密钥文件的不记结果，读过的密钥值换成"（密钥）"。
import { t } from "@ergo/protocol";
import type { ConversationId, MemoryRecall, MessagePart } from "@ergo/protocol";
import { appendMessage, type MessageScope } from "../conversation/messages.ts";
import type { EventStore } from "../events/event-store.ts";
import { type GuardInput, type GuardJudgement, TOOL, toolCallMark, toolNature, type ToolRegistry } from "../guard/index.ts";
import { WIRE_DISPOSITION } from "../guard-wire/dispositions.ts";
import type { AgentReport } from "../runtime/index.ts";
import { type CategoryTitles, categoryTitle, resultSummary, summarizeArgs } from "./describe.ts";
import type { ExecutionRecord } from "./events.ts";
import type { PlanChecked } from "./plan-check.ts";
import { type CallPrivacy, secretFileResult } from "./read-secrets.ts";

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
  settings: CategoryTitles[];
  /** allowed：放行了；waiting：在等审批；denied：用户拒绝；suspended：等审批超时；blocked：别的原因拦下；aborted：等的时候回合中止 */
  outcome: "allowed" | "waiting" | "denied" | "suspended" | "blocked" | "aborted";
  /** 被拦下的原因不是处置时：硬拒绝、按规则退回、判定出错；流程里按计划引回、计划检查拦下（59 号票） */
  blockedBy?: ToolCallPart["blockedBy"];
  /** 流程执行时和计划比对的结论（59 号票，plan-check.ts） */
  plan?: PlanChecked;
  /** 真的用上了的自动纠偏（60 号票）：按计划改回参数后执行了（rewrite）、引回前置步骤没执行（redirect）；硬拒绝优先时没有 */
  corrected?: "rewrite" | "redirect";
  approvalId?: string;
  /** 用户拒绝时附带的说明 */
  note?: string;
  /** 这次调用的记录带上的归属：判定那一刻取的（任务里含当时的阶段，25 号票） */
  scope: MessageScope;
  /** 放行、开始执行的有副作用的调用：记下的执行记录（23 号票，executions.ts） */
  execution?: ExecutionRecord;
  /** 收到判定请求的时间（协议时间）：完整内容里的 startedAt（53 号票） */
  startedAt?: string;
  /** 流程里计划检查要问的（计划外会改东西的、超出步骤写的对象），任务的 agent 超出授权先不管放行了（101 号票） */
  beyondGrant?: true;
  /**
   * 守卫拦下时给用户看的原因（173 号票）：交回 agent 的原因在中文下写，用户的语言不是中文时这里另存一份用户的语言的，
   * 工具调用记录的结果摘要用它。用户的语言是中文时不给（摘要照旧取 agent 收到的结果）
   */
  userReason?: string;
  /** 调用记忆的结构化部分（187 号票：检索素材、读素材执行完交回的）：记在工具调用 part 的 recall 上 */
  recall?: MemoryRecall;
  /**
   * 运行时自己的工具名和模型给的原样参数（288 号票，宿主协议 23 的 guard_request.native：Claude Code 的 Bash、Read……）：toolName、args 是
   * 映射到守卫工具登记表之后的（判定、聊天里的记录按它），完整内容里存原样的。pi 的调用没有
   */
  native?: { toolName: string; args: unknown };
}

export function newCallState(report: Extract<AgentReport, { type: "guard_request" }>, scope: MessageScope = {}, startedAt?: string): CallState {
  return {
    toolCallId: report.toolCallId,
    toolName: report.toolName,
    args: report.args,
    outcome: "blocked",
    settings: [],
    scope,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(report.native === undefined ? {} : { native: report.native }),
  };
}

/**
 * 往会话里追加这次调用的记录，带上判定时取的归属（tools：这个会话的工具注册表，参数摘要按登记打码；privacy：读了密钥文件的不记结果，
 * 读过的密钥值擦掉，见 read-secrets.ts）
 */
export function appendToolCallRecord(store: EventStore, conversation: ConversationId, state: CallState, end: ToolCallEnd, tools: ToolRegistry, privacy?: CallPrivacy): void {
  appendMessage(store, { conversation, speaker: "agent", parts: [toolCallPart(state, end, tools, privacy)] }, state.scope);
}

/** 这次调用的结局（工具调用 part 和完整内容里的 outcome）：放行执行了的看有没有出错，用户拒绝的是 denied，别的都是被拦下 */
export function callOutcome(state: CallState, end: ToolCallEnd): ToolCallPart["outcome"] {
  return state.outcome === "allowed" ? (end.isError ? "error" : "done") : state.outcome === "denied" ? "denied" : "blocked";
}

/** 聊天里的一条工具调用 part（tools：这个会话的工具注册表，工具自己声明了参数要打码的，参数摘要先擦掉密钥类的值） */
export function toolCallPart(state: CallState, end: ToolCallEnd, tools: ToolRegistry, privacy?: CallPrivacy): ToolCallPart {
  const j = state.judgement;
  const outcome = callOutcome(state, end);
  const shown = (s: string) => (privacy ? privacy.text(s) : s);
  const summary = summaryOf(state, end, privacy?.readsSecretFile === true);
  // 读了密钥文件、放行执行了的（结果摘要不记内容的那种）：带上标记，界面加 🔒（67 号票）
  const readsSecretFile = state.outcome === "allowed" && privacy?.readsSecretFile === true;
  return {
    type: "tool_call",
    callId: state.toolCallId,
    tool: state.toolName,
    argsSummary: shown(summarizeArgs(tools, state.toolName, state.args)),
    categoryTitles: (j?.categories ?? []).map((id) => categoryTitle(id, state.settings)),
    // 类别的 id（173 号票：名字按记下时的语言写，界面、撤回认类别看 id）：命中了才带
    ...(j && j.categories.length > 0 ? { categories: [...j.categories] } : {}),
    // 判定出错时没有处置
    ...(j ? { disposition: WIRE_DISPOSITION[j.disposition] } : {}),
    ...(state.blockedBy === undefined ? {} : { blockedBy: state.blockedBy }),
    withinGrant: j?.withinGrant ?? false,
    genericBash: j?.genericShell ?? state.toolName === TOOL.bash,
    outcome,
    ...(summary === "" ? {} : { resultSummary: shown(summary) }),
    ...(state.input && j ? { nature: toolNature(state.input, j) } : {}),
    // 要动的是对外的事还是本机的敏感权限（93 号票）：命中了关注类别的才有
    ...markOf(state.input, j),
    ...(readsSecretFile ? { readsSecretFile: true } : {}),
    ...(state.plan ? { plan: planOfCall(state) } : {}),
    ...(beyondGrant(state) ? { beyondGrant: true } : {}),
    // 为什么查、查了什么也过一遍隐私处理（和参数摘要一样）
    ...(state.recall ? { recall: recallShown(state.recall, shown) } : {}),
    // 子代理里的调用（288 号票：Claude Code 的 Agent 工具派出去的）：挂在调用它的那次调用下面
    ...(end.parentToolCallId === undefined ? {} : { parentCallId: end.parentToolCallId }),
  };
}

/** 调用记忆的结构化部分写进记录的样子：为什么查、查了什么经过隐私处理；命中只有编号、种类、时间这些，原样 */
function recallShown(recall: MemoryRecall, shown: (s: string) => string): MemoryRecall {
  return {
    ...recall,
    ...(recall.why === undefined ? {} : { why: shown(recall.why) }),
    ...(recall.query === undefined ? {} : { query: shown(recall.query) }),
  };
}

/** 任务的 agent 超出授权、先不管直接做了（101 号票）：放行执行了，守卫的依据里有记 beyondGrant 的，或者流程的计划检查要问的被放过了 */
function beyondGrant(state: CallState): boolean {
  if (state.outcome !== "allowed") return false;
  return state.beyondGrant === true || (state.judgement?.findings.some((f) => f.kind !== "hard_refusal" && f.kind !== "pull_back" && f.beyondGrant === true) ?? false);
}

/** 工具调用 part 的 mark（93 号票：外 / 权）；判定出错、没命中关注类别的没有 */
function markOf(input: GuardInput | undefined, j: GuardJudgement | undefined): { mark?: ToolCallPart["mark"] } {
  const mark = input && j ? toolCallMark(input, j) : undefined;
  return mark === undefined ? {} : { mark };
}

/**
 * 流程里这次调用和计划比对的结果（60 号票：每次调用记下对上的步骤、是否计划外、判定、修回）：
 * 算在哪一步、计划里没有这个工具的步骤、查出的问题里没被放行的那几种的类别、真的用上了的自动纠偏
 */
function planOfCall(state: CallState): NonNullable<ToolCallPart["plan"]> {
  const assessment = state.plan!.outcome.assessment;
  const findings = [...new Set((assessment.findings ?? []).filter((f) => f.verdict !== "allow").map((f) => f.kind))];
  return {
    ...(assessment.stepId === undefined ? {} : { stepId: assessment.stepId }),
    ...(assessment.offPlan ? { offPlan: true as const } : {}),
    ...(findings.length > 0 ? { findings } : {}),
    ...(state.corrected ? { correction: state.corrected } : {}),
  };
}

/** 结果摘要；放行执行了、读的是密钥文件的，不记文件内容 */
function summaryOf(state: CallState, end: ToolCallEnd, readsSecretFile: boolean): string {
  if (state.blockedBy === "judge_error") return t("guardRuntime.record.judgeError");
  if (state.outcome === "denied") return state.note ? t("guardRuntime.record.deniedNote", { note: state.note }) : t("guardRuntime.record.denied");
  if (state.outcome === "suspended") return t("guardRuntime.record.suspended");
  if (state.outcome === "aborted") return t("guardRuntime.record.aborted");
  if (state.outcome === "blocked" && state.userReason !== undefined) return resultSummary(state.userReason);
  if (state.outcome === "allowed" && readsSecretFile) return secretFileResult();
  return resultSummary(end.resultText);
}
