// 守卫接入运行时后的事件（规格第 4、9 节）：都在事件日志里一个守护进程内部的频道 `guard` 上，前端不订阅它。
// 前端看到的是这些事件的另一面：聊天里的工具调用 part、审批卡、待我处理事项。
// - 审批表（approvals/views.ts）由 approval_* 事件归并：先写库（approval_requested）再建审批卡、通知前端；
// - 审批决定（approval_decided）是"审批决定"素材的来源（08 号票采集）；挂起（approval_suspended）给 13 号票把任务转等我；
// - 效果日志（effect-log.ts）由 effect_recorded 归并，只有执行成功的调用才有。
import { type ConversationId, EVENT_TYPES } from "@ergou/protocol";
import type { EffectRecord } from "../guard/index.ts";

export const GUARD_CHANNEL = "guard";

export const GUARD_EVENTS = {
  /** 判定为"先问我"：一条新的审批（和审批卡、待我处理事项、聊天里的卡片引用同一事务，排在最前） */
  approvalRequested: "approval_requested",
  /** 用户在审批卡上批准或拒绝（和卡片更新同一事务）；"审批决定"素材的来源，事件类型登记在共享协议包的 EVENT_TYPES */
  approvalDecided: EVENT_TYPES.approvalDecided,
  /** 子进程里等审批的那次调用超时（默认 5 分钟），以"已提交审批，等待用户"拦下；审批仍待处理 */
  approvalSuspended: "approval_suspended",
  /** 事后批准的审批是一条按调用指纹匹配的一次性授权；同样的调用重试时放行一次，用掉 */
  approvalConsumed: "approval_consumed",
  /** 执行成功的调用追加进效果日志 */
  effectRecorded: "effect_recorded",
  /**
   * 任务里一次对外调用被判"永不"（13 号票）：记下它的对象（收件人、推送的远端和分支……）。
   * 同一任务里之后针对同一对象的调用至少按"先问我"（规格第 9 节"永不"）
   */
  neverRecorded: "never_recorded",
  /**
   * 放行、开始执行的一次有副作用的调用（23 号票，规格第 17 节）：注册表里没标"只读或幂等"的（bash 拆出的伪工具有一个不是的
   * 也算）。还没结束时守护进程被杀（或子进程意外退出），就是说不清做没做完的调用（executions.ts）
   */
  toolCallStarted: "tool_call_started",
  /**
   * 它结束了，成功还是失败、结果摘要（成功的和效果日志同一事务追加，所以"还在执行"的一定没有成功记录）。
   * pi 并行执行一批调用、全部结束才把结果写进会话：这之间被杀，重新拉起时按它补"已经做完了，不要重做"
   */
  toolCallFinished: "tool_call_finished",
  /** 这个 agent 做完了的调用，结果都已经写进会话了（之后它又出了一条助手消息、或者这一轮结束了）：不用再记着 */
  toolCallsSettled: "tool_calls_settled",
  /**
   * 它被中断了（守护进程重启时、子进程意外退出时还没结束）：任务里的让任务转等我（原因"中断：不确定 X 是否已执行"），
   * 不属于任务的同一事务放一条待我处理事项（不卡任务）。运行时不自动重做
   */
  toolCallInterrupted: "tool_call_interrupted",
} as const;

export interface NeverRecordedPayload {
  taskId: string;
  objects: string[];
  tool: string;
  time: string;
}

/**
 * 一次工具调用从哪儿来：哪个 agent、哪个会话、哪个任务的哪个阶段、哪个会话段，卡片和事项上写的来源。
 * 审批记录、"交给我做"事项、审批决定和挂起事件都带它；13 号票接任务时往这里加字段。
 */
export interface CallOrigin {
  agentId: string;
  /** 调用所在的会话：工具调用 part、审批卡引用、给 agent 的通知都追加在这里；任务里由 13 号票定 */
  conversation: ConversationId | null;
  /** 调用所属的任务和阶段；对话里为 null */
  taskId: string | null;
  stageId: string | null;
  /** 会话段（不属于任务的调用）：效果日志和时序规则按它划范围 */
  segmentId?: string;
  /** 审批卡、"交给我做"事项上的来源："秘书对话"，任务里写任务和阶段 */
  source: string;
}

/** 审批表里的一条（审批请求时的样子） */
export interface ApprovalRecord {
  approvalId: string;
  /** 审批卡 */
  cardId: string;
  origin: CallOrigin;
  /** 子进程里的这次工具调用 */
  toolCallId: string;
  /** 模型调用的工具和它给的参数（原样） */
  tool: string;
  args: unknown;
  toolTitle: string;
  argsSummary: string;
  /** 调用指纹：同一个 agent、同一个任务的同一个阶段里一模一样的调用（工具、参数、工作目录）才算同一个 */
  fingerprint: string;
  /** 命中的关注类别 id；事后批准的一次性授权只放行命中的类别都在这里面的重试 */
  categories: string[];
  /** 守卫给的说明 */
  reason: string;
  /** 请求时间（协议时间） */
  requestedAt: string;
}

export interface ApprovalRequestedPayload {
  approval: ApprovalRecord;
}

/** 审批决定：批准、拒绝；收窄（只放行一部分）先留出形状，由计划卡、计划变更这些确认（12、14）用 */
export type ApprovalDecision = "approved" | "denied" | "narrowed";

export interface ApprovalDecidedPayload {
  approvalId: string;
  decision: ApprovalDecision;
  /** 收窄成什么（decision 为 narrowed 时）；本票不产生 */
  narrowing?: { summary: string };
  /** 用户附带的说明（拒绝的理由） */
  note?: string;
  /**
   * 决定时子进程里那次调用还在等：批准就接着执行、拒绝就拦下，不留授权。
   * 为 false 时（已经挂起，或 agent 已不在等）批准记成一条按调用指纹匹配的一次性授权，运行时告诉 agent 可以重试
   */
  resumed: boolean;
  /** 做决定的是用户 */
  by: "user";
  time: string;
  /** 素材要用的上下文：调用从哪儿来、哪张审批卡、要做什么（工具、中文名、参数摘要）、命中了哪些类别（id） */
  origin: CallOrigin;
  cardId: string;
  tool: string;
  toolTitle: string;
  argsSummary: string;
  categories: string[];
}

/** 挂起：调用从哪儿来（任务和阶段，对话里为 null），13 号票据此让任务这一支转等我（原因"审批"） */
export interface ApprovalSuspendedPayload {
  approvalId: string;
  origin: CallOrigin;
  toolCallId: string;
  time: string;
}

export interface ApprovalConsumedPayload {
  approvalId: string;
  /** 用掉它的那次调用 */
  toolCallId: string;
  time: string;
}

export interface EffectRecordedPayload {
  records: EffectRecord[];
}

/** 一次正在执行的有副作用的调用（23 号票）：从哪儿来、调用的工具、给人看的调用摘要（写进事件日志之前擦过读过的密钥值） */
export interface ExecutionRecord {
  toolCallId: string;
  origin: CallOrigin;
  tool: string;
  toolTitle: string;
  /** 规范化后的调用摘要：工具的中文名加参数摘要，比如"通用 bash「sleep 30」"（"中断：不确定 X 是否已执行"里的 X） */
  call: string;
  /** 开始执行的时间（协议时间） */
  startedAt: string;
}

export interface ToolCallStartedPayload {
  execution: ExecutionRecord;
}

export interface ToolCallFinishedPayload {
  toolCallId: string;
  agentId: string;
  time: string;
  /** 成功了没有 */
  ok: boolean;
  /** 结果摘要（和会话里工具调用记录的一样，擦过读过的密钥值）；没有输出时为空 */
  result: string;
}

export interface ToolCallsSettledPayload {
  agentId: string;
  toolCallIds: string[];
  time: string;
}

export interface ToolCallInterruptedPayload {
  execution: ExecutionRecord;
  time: string;
}
