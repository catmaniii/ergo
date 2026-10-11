// 任务模块在事件日志里的事件（规格第 4、8 节）。
// - 任务看板频道（board，前端订阅）：task 事件 = 任务的最新状态 + 这次的变化 + 谁改的（负载 TaskEventPayload 在共享协议包）；
// - 守护进程内部的 tasks 频道（前端不订阅）：任务书、维护者提交的计划、用户对计划的决定。计划是业务状态，存在这里，
//   不在 pi 会话里；前端看到的是计划卡（由代码从结构化计划生成）。
//   14 号票加了：维护者提交的计划变更（用户在计划变更卡上的决定也是 plan_decided）、维护者自行调整的计划、
//   授权项续期的决定、每个阶段的用量（预算计数）。
import { EVENT_TYPES, type GrantInfo, type Plan, type PlanChangeItem, type PlanGrant, type PlanWatchCategory, type TaskBrief, type WorkflowPlan } from "@ergou/protocol";
import type { GrantTime } from "./plan.ts";

export type { TaskBrief };

export const TASKS_CHANNEL = "tasks";

export const TASK_EVENTS = {
  /** 秘书写了（或改了）任务书：运行时同一事务把它交给执行的维护者 */
  briefWritten: "task_brief",
  /** 执行的维护者提交了一版计划（同一事务建计划卡、放进待我处理、任务转待确认） */
  planSubmitted: "plan_submitted",
  /** 用户在计划卡上确认或打回（和卡片更新同一事务）；"审批决定"素材的来源，事件类型登记在共享协议包 */
  planDecided: EVENT_TYPES.planDecided,
  /**
   * 用户对产出的反应（13 号票）："由我验收"的阶段验收通过或退回、对已完成的任务要求返工（和任务的变化同一事务）；
   * "用户对产出的反应"素材的来源，事件类型登记在共享协议包
   */
  outputReaction: EVENT_TYPES.outputReaction,
  /** 维护者在执行中提交了计划变更（14 号票；同一事务建计划变更卡、放进待我处理、受影响的阶段停下等确认） */
  planChangeProposed: "plan_change_proposed",
  /** 维护者自行调整了计划（拆阶段、调顺序这类不扩大授权的，14 号票）：新的一版直接生效 */
  planRevised: "plan_revised",
  /** 用户在"授权到期续期"事项上续期或不续（14 号票）；"审批决定"素材的来源，事件类型登记在共享协议包 */
  grantRenewalDecided: EVENT_TYPES.grantRenewalDecided,
  /** 一个阶段又调用了几次工具（14 号票的预算计数；token 不在这里记，取自 token 账本） */
  budgetUsed: "budget_used",
  /** 用户让超预算的阶段接着做：这个阶段从现在的用量起再给一整份预算（记下账本里这时的 token 数作起算点） */
  budgetReset: "budget_reset",
  /** 这个阶段的用量超出了预算，运行时已经让维护者说明进展（只说一次） */
  budgetWarned: "budget_warned",
} as const;

/** 守卫眼里的一项授权（阶段组的授权项写成"授权项 id@阶段 id"）的授予时间和到期时间：GrantTime 写进事件的样子（协议时间） */
export type GrantTimes = Record<string, Record<keyof GrantTime, string>>;

export interface PlanChangeProposedPayload {
  taskId: string;
  /** 这次提的那一版计划（接着计划的版本往下排） */
  planId: string;
  revision: number;
  /** 基于哪一版确认的计划 */
  basePlanId: string;
  /** 变更后的整份计划（还没确认） */
  plan: Plan;
  /** 相对当前计划新增或改动的部分 */
  changes: PlanChangeItem[];
  /** 停下等确认的阶段 */
  affectedStages: string[];
  why: string;
  /** 计划变更卡 */
  cardId: string;
  maintainerId: string;
  time: string;
}

export interface PlanRevisedPayload {
  taskId: string;
  planId: string;
  revision: number;
  basePlanId: string;
  plan: Plan;
  changes: PlanChangeItem[];
  why: string;
  /** 调整之后每项授权的授予时间、到期时间（原样留着的照旧） */
  grantTimes: GrantTimes;
  maintainerId: string;
  time: string;
}

export interface GrantRenewalDecidedPayload {
  taskId: string;
  taskTitle: string;
  /** 续期的是哪一版确认的计划里的授权项 */
  planId: string;
  /** 待我处理里的续期事项 */
  itemId: string;
  decision: "renewed" | "declined";
  /** 每一项：守卫的授权项 id、给用户看的一句话、原来的到期时间、续期后的到期时间（不续时没有） */
  grants: { grantId: string; title: string; before: string; after?: string }[];
  /** 续期后这一版计划里全部授权项的授予时间和到期时间（续期时才有） */
  grantTimes?: GrantTimes;
  by: "user";
  time: string;
}

export interface BudgetUsedPayload {
  taskId: string;
  stageId: string;
  toolCalls: number;
  time: string;
}

export interface BudgetMarkPayload {
  taskId: string;
  stageId: string;
  time: string;
}

/** 再给一整份预算：工具调用次数从现在的起算，token 从账本里这个阶段这时的数起算 */
export interface BudgetResetPayload extends BudgetMarkPayload {
  baseTokens: number;
}

/** 用户对产出的反应：验收通过（accepted）、退回（returned）、要求返工（rework） */
export type OutputReaction = "accepted" | "returned" | "rework";

export interface OutputReactionPayload {
  taskId: string;
  taskTitle: string;
  stageId: string;
  stageTitle: string;
  reaction: OutputReaction;
  /** 用户附的话（退回、返工的原因）：用户自己的话 */
  note?: string;
  /** 重开了哪些阶段（返工时：指定的阶段和它的全部下游里开始过的） */
  reopened?: string[];
  /** 退回写了原因时，这次的结论卡（84 号票：原因也记在卡上由你验收的那几条的备注里，彻底删除这条反应时连带改写） */
  cardId?: string;
  /** 返工时会话里那条重做记录（84 号票：记录里引着你说的话，彻底删除这条反应时连带改写） */
  recordId?: string;
  by: "user";
  time: string;
}

export interface TaskBriefPayload {
  taskId: string;
  brief: TaskBrief;
  /** 第几版任务书（秘书改了就加 1） */
  revision: number;
  time: string;
}

export interface PlanSubmittedPayload {
  taskId: string;
  planId: string;
  /** 第几版计划（打回后重新提交加 1） */
  revision: number;
  /** 检查过、补全了的计划（全局关注类别的名字由运行时补上）；流程是由流程计划推出的、交给执行控制器的那份（58 号票） */
  plan: Plan;
  /** 流程的计划（58 号票）：审查修补之后、交给用户授权的步骤和条件；长程任务没有 */
  workflow?: WorkflowPlan;
  /** 流程的这一版审查没让它交给用户授权（58 号票）：退回维护者补充、判定不可执行；任务还在规划中 */
  refused?: "needs_replan" | "blocked";
  /** 由它生成的计划卡（流程是流程计划卡） */
  cardId: string;
  /** 起草它的维护者 */
  maintainerId: string;
  time: string;
}

/**
 * 确认、打回（拒绝）；returned 是审查判定不可执行的流程计划卡上的"让维护者改"（58 号票）；voided 是从某个阶段重做时
 * 还没确认的计划变更随之作废（84 号票，系统记的，不算你拒绝、不是素材）
 */
export type PlanDecision = "confirmed" | "rejected" | "returned" | "voided";

export interface PlanDecidedPayload {
  taskId: string;
  taskTitle: string;
  planId: string;
  revision: number;
  cardId: string;
  decision: PlanDecision;
  /** 确认的那份计划（勾掉、收窄之后）；打回时没有 */
  plan?: Plan;
  /** 流程的计划（58 号票）：确认的那份，或被拒绝的那份 */
  workflow?: WorkflowPlan;
  /** 流程计划卡上授权时逐项勾了的确认事项（58 号票） */
  confirmations?: string[];
  /** 确认时勾掉的授权项（原样，和计划卡负载里的同名同形） */
  removedGrants: PlanGrant[];
  /** 确认时收窄了的授权项 id（收窄后的样子在 plan 里） */
  narrowedGrants: string[];
  /** 每项授权在守卫眼里的样子（素材里的说法和计划卡上一样，由它生成） */
  grantInfo: Record<string, GrantInfo>;
  /** 确认时改了假设栏：改之前和改之后 */
  assumptions?: { before: string[]; after: string[] };
  /** 确认时在卡上给这个任务加的关注类别（确定的规则和处置，用户自己写的；26 号票） */
  addedCategories?: PlanWatchCategory[];
  /** 打回的意见（用户自己的话）；计划变更卡上拒绝时写的话 */
  note?: string;
  /**
   * 计划变更卡上的决定（14 号票）：维护者为什么要改、改了什么（相对哪一版确认的计划）。没有就是计划卡上的决定
   */
  change?: { why: string; changes: PlanChangeItem[]; basePlanId: string };
  /** 确认之后每项授权的授予时间、到期时间（计划变更：原样留着的照旧、新加的从这次确认起算；没有就按确认时刻算） */
  grantTimes?: GrantTimes;
  /** 做决定的是用户；重做时作废的（voided）是系统 */
  by: "user" | "system";
  time: string;
}
