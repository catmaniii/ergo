// 守卫接入运行时后的事件（规格第 4、9 节）：都在事件日志里一个守护进程内部的频道 `guard` 上，前端不订阅它。
// 前端看到的是这些事件的另一面：聊天里的工具调用 part、审批卡、待我处理事项。
// - 审批表（approvals/views.ts）由 approval_* 事件归并：先写库（approval_requested）再建审批卡、通知前端；
// - 审批决定（approval_decided）是"审批决定"素材的来源（08 号票采集）；挂起（approval_suspended）给 13 号票把任务转等我；
// - 效果日志（effect-log.ts）由 effect_recorded 归并，只有执行成功的调用才有。
import type { ConversationId } from "@ergou/protocol";
import type { EffectRecord } from "../guard/index.ts";

export const GUARD_CHANNEL = "guard";

export const GUARD_EVENTS = {
  /** 判定为"先问我"：一条新的审批（和审批卡、待我处理事项、聊天里的卡片引用同一事务，排在最前） */
  approvalRequested: "approval_requested",
  /** 用户在审批卡上批准或拒绝（和卡片更新同一事务） */
  approvalDecided: "approval_decided",
  /** 子进程里等审批的那次调用超时（默认 5 分钟），以"已提交审批，等待用户"拦下；审批仍待处理 */
  approvalSuspended: "approval_suspended",
  /** 事后批准的审批是一条按调用指纹匹配的一次性授权；同样的调用重试时放行一次，用掉 */
  approvalConsumed: "approval_consumed",
  /** 执行成功的调用追加进效果日志 */
  effectRecorded: "effect_recorded",
} as const;

/** 审批表里的一条（审批请求时的样子） */
export interface ApprovalRecord {
  approvalId: string;
  /** 审批卡 */
  cardId: string;
  agentId: string;
  /** 对话里：调用所在的会话（审批卡引用、事后批准的通知都追加在这里）；任务里由 13 号票定 */
  conversation: ConversationId | null;
  /** 调用所属的任务和阶段；对话里为 null */
  taskId: string | null;
  stageId: string | null;
  /** 会话段（不属于任务的调用） */
  segmentId?: string;
  /** 子进程里的这次工具调用 */
  toolCallId: string;
  /** 模型调用的工具和它给的参数（原样） */
  tool: string;
  args: unknown;
  toolTitle: string;
  argsSummary: string;
  /** 调用指纹：同一个 agent（同一个任务）里一模一样的调用（工具、参数、工作目录）才算同一个 */
  fingerprint: string;
  /** 命中的关注类别 id */
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
  /** 素材要用的上下文：哪个 agent、哪个会话或任务、要做什么、命中了哪些类别 */
  agentId: string;
  conversation: ConversationId | null;
  taskId: string | null;
  stageId: string | null;
  tool: string;
  argsSummary: string;
  categories: string[];
}

/** 挂起：调用所属的任务和阶段（对话里为 null），13 号票据此让任务这一支转等我（原因"审批"） */
export interface ApprovalSuspendedPayload {
  approvalId: string;
  agentId: string;
  conversation: ConversationId | null;
  taskId: string | null;
  stageId: string | null;
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
