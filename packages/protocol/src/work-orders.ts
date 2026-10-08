// 工单与维护者会话分段（规格第 11、12 节，16 号票）的名字：工单的状态、结局、来源、种类、项目页工单流水线的三栏，
// 维护者会话分段的种类和状态。只有常量和纯函数，不引用 TypeBox（Web 只用这些）。schema 在 work-order-schema.ts。
//
// 工单：交给某个项目维护者的一份工作。派单器把它放进收件项目维护者的工单队列，一次只做一件、先来先做：
//   等阶段开始（多项目任务计划内的）/ 待你确认（只有计划外的工单）→ 待接 → 进行中 ⇄ 等澄清 → 已结束（完成、退回、做不了；
//   计划外工单被用户拒绝的记"没派出"）。
// 来源：用户发起的单项目任务（16 号票）；别的任务的维护者派来的部分（17 号票：涉及多个项目的任务）；定时作业的一次运行（19）。
// 单项目任务的维护者要做两件事，各是一张工单：起草计划（plan），用户确认计划后执行（execute）；
// 打回计划后重新起草、失败后重试、完成后返工，各是一张新的工单。
// 涉及多个项目的任务（17 号票）：计划里每个项目的一行改动在用户确认计划时建成一张发往那个项目的工单（change，带自己的验收标准，
// 写明所属任务和阶段），先"等阶段开始"，所属阶段开始时才派出、进入项目维护者的队列；任务维护者执行中另派的，计划里有这一行的
// （同一阶段、同一项目）直接派出，没有的是计划外的工单，"待你确认"，用户确认后才派出。
import type { JobRunWorkOrder, WorkOrder } from "./work-order-schema.ts";

/**
 * 工单的状态：待你确认（计划外的工单，用户确认后才派出，17 号票）、等阶段开始（涉及多个项目的任务确认计划时建出、还没派出，17 号票）、
 * 待接（在收件维护者的队列里）、进行中、等澄清（维护者在等派单方回答）、已结束。
 * 待你确认、等阶段开始的还没派出：不在项目的工单流水线上，只在任务详情的工单列表里
 */
export const WORK_ORDER_STATES = ["awaiting_confirm", "planned", "pending", "in_progress", "clarifying", "ended"] as const;
export type WorkOrderState = (typeof WORK_ORDER_STATES)[number];

export const WORK_ORDER_STATE_LABEL: Readonly<Record<WorkOrderState, string>> = {
  awaiting_confirm: "待你确认",
  planned: "等阶段开始",
  pending: "待接",
  in_progress: "进行中",
  clarifying: "等澄清",
  ended: "已结束",
};

/** 还没派出的工单（待你确认、等阶段开始）：不在收件维护者的队列里 */
export function isUndispatchedWorkOrder(workOrder: { state: WorkOrderState }): boolean {
  return workOrder.state === "awaiting_confirm" || workOrder.state === "planned";
}

/**
 * 已结束的工单怎么结束的：完成、退回（发给已归档项目的、任务被取消了；17 号票起也有项目维护者退回会伤害自己项目的改动，必须附理由）、
 * 做不了（任务失败；17 号票起也有项目维护者说做不了的）、没派出（计划外的工单，用户拒绝了，17 号票）
 */
export const WORK_ORDER_OUTCOMES = ["done", "returned", "unable", "declined"] as const;
export type WorkOrderOutcome = (typeof WORK_ORDER_OUTCOMES)[number];

export const WORK_ORDER_OUTCOME_LABEL: Readonly<Record<WorkOrderOutcome, string>> = { done: "完成", returned: "退回", unable: "做不了", declined: "没派出" };

/** 工单从哪来（派单方）：用户发起的单项目任务（16 号票）、涉及多个项目的任务的维护者（17 号票）、定时作业的一次运行（19 号票） */
export const WORK_ORDER_SOURCES = ["user_task", "task_maintainer", "scheduled_job"] as const;
export type WorkOrderSource = (typeof WORK_ORDER_SOURCES)[number];

/** 派单方的说法（流水线上的"来源"） */
export const WORK_ORDER_SOURCE_LABEL: Readonly<Record<WorkOrderSource, string>> = { user_task: "你", task_maintainer: "任务维护者", scheduled_job: "定时作业" };

/**
 * 工单要做的事：起草计划、执行（用户确认计划之后）；改动（17 号票：涉及多个项目的任务里，这个项目要做的那一部分，
 * 完成或退回时交回执给派单的任务维护者）；定时作业的一次运行（19 号票：属于项目的作业到点，交给项目维护者做作业定义里
 * "每次要做的事"；不属于任何任务，工单上记着作业和这次运行）
 */
export const WORK_ORDER_KINDS = ["plan", "execute", "change", "run"] as const;
export type WorkOrderKind = (typeof WORK_ORDER_KINDS)[number];

export const WORK_ORDER_KIND_LABEL: Readonly<Record<WorkOrderKind, string>> = { plan: "起草计划", execute: "执行", change: "改动", run: "定时作业" };

/**
 * 项目列表频道上 work_order 事件的"这次是什么变化"：建出（16 号票的直接进了收件维护者的队列；17 号票的计划内工单先等阶段开始、
 * 计划外的先待你确认）、派出（17 号票：等阶段开始、待你确认的进了收件维护者的队列）、内容改了（还在排队时任务书改了版；
 * 17 号票：项目维护者交了回执、任务维护者把项目维护者的问题转问了用户）、开始（维护者接了）、转等澄清、澄清有了回答（回到进行中）、
 * 结束（带结局）
 */
export const WORK_ORDER_CHANGES = ["created", "dispatched", "updated", "started", "clarifying", "answered", "ended"] as const;
export type WorkOrderChange = (typeof WORK_ORDER_CHANGES)[number];

/** 定时作业的一次运行的工单（19 号票）：按来源认 */
export function isJobRunWorkOrder(workOrder: WorkOrder): workOrder is JobRunWorkOrder {
  return workOrder.source === "scheduled_job";
}

/** 这张工单属于哪个任务：定时作业的一次运行不属于任务（undefined） */
export function workOrderTaskId(workOrder: WorkOrder): string | undefined {
  return isJobRunWorkOrder(workOrder) ? undefined : workOrder.taskId;
}

/** 维护者手上的工单（同一项目同一时刻最多一张）：进行中或等澄清 */
export function isActiveWorkOrder(workOrder: { state: WorkOrderState }): boolean {
  return workOrder.state === "in_progress" || workOrder.state === "clarifying";
}

/** 项目页上工单流水线的三栏：排队中（待接）、进行中（含等澄清）、已结束 */
export const WORK_ORDER_LANES = ["queued", "active", "ended"] as const;
export type WorkOrderLane = (typeof WORK_ORDER_LANES)[number];

export const WORK_ORDER_LANE_LABEL: Readonly<Record<WorkOrderLane, string>> = { queued: "排队中", active: "进行中", ended: "已结束" };

/**
 * 工单在项目的流水线上的哪一栏。还没派出的（待你确认、等阶段开始，17 号票）不在流水线上（undefined）：前置阶段没验收时，
 * 后面阶段的工单不出现在项目的工单流水线里；计划外的工单用户确认之前也不进项目维护者的队列。
 * 没派出就结束了的（你拒绝了的、任务结束时还没派出的）同样不在
 */
export function workOrderLane(workOrder: { state: WorkOrderState; source: WorkOrderSource; dispatchedAt?: string | undefined }): WorkOrderLane | undefined {
  if (isUndispatchedWorkOrder(workOrder)) return undefined;
  if (workOrder.state === "pending") return "queued";
  if (workOrder.state !== "ended") return "active";
  // 任务维护者派的工单（17 号票）派出时记下时刻：没有的（没派出就结束了）不在流水线上
  if (workOrder.source === "task_maintainer" && workOrder.dispatchedAt === undefined) return undefined;
  return "ended";
}

/** 工单的状态写成一句（"已结束 · 退回"；那一段没写回项目档案的如实写上："已结束 · 完成 · 重置时这段没写回档案"） */
export function workOrderStatusText(workOrder: { state: WorkOrderState; outcome?: WorkOrderOutcome | undefined; unwritten?: WriteBackGap | undefined }): string {
  const state = WORK_ORDER_STATE_LABEL[workOrder.state];
  if (workOrder.state !== "ended" || !workOrder.outcome) return state;
  return [state, WORK_ORDER_OUTCOME_LABEL[workOrder.outcome], ...(workOrder.unwritten ? [WRITE_BACK_GAP_LABEL[workOrder.unwritten]] : [])].join(" · ");
}

// ───────────────────────── 维护者会话分段 ─────────────────────────

/**
 * 维护者会话的一段（每段一个新的 pi 会话，从固定上下文重新开始）：每张工单一段（工单段）；
 * 维护者手上没有工单时用户直接和它说话（含立项问答）开一段（对话段）
 */
export const SEGMENT_KINDS = ["work_order", "chat"] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

/**
 * 一段的状态：进行中、收尾中（该结束了：等维护者把新的理解写回项目档案、写这一段的摘要；没写回就催它）、已结束。
 * 收尾中的段仍占着维护者：下一张工单等它结束再开始
 */
export const SEGMENT_STATES = ["open", "closing", "closed"] as const;
export type SegmentState = (typeof SEGMENT_STATES)[number];

/**
 * 会话分段的变化：开了一段、记下这一段实际接的会话（第一段对话段接着以前的会话时，子进程报回它接的是哪个）、
 * 维护者写了（改了）这一段的摘要、开始收尾、结束（写回了；催写回到了次数还没写回；重置维护者时直接结束）
 */
export const SEGMENT_CHANGES = ["opened", "session", "summary", "closing", "closed"] as const;
export type SegmentChange = (typeof SEGMENT_CHANGES)[number];

/**
 * 一段没写回项目档案就结束了的原因：重置维护者（写回中途重置的，工单照常算完成）、催写回到了次数还没写回
 * （转为用户拍板：待我处理里一条"卡住求助"，项目的队列接着走）。时间线和项目页如实写出来
 */
export const WRITE_BACK_GAPS = ["reset", "nudged"] as const;
export type WriteBackGap = (typeof WRITE_BACK_GAPS)[number];

export const WRITE_BACK_GAP_LABEL: Readonly<Record<WriteBackGap, string>> = { reset: "重置时这段没写回档案", nudged: "催了还没写回档案" };

/** 催写回到了次数还没写回时，待我处理里那条"卡住求助"（stuck_help）的动作：只是告诉用户（工单照常结束，队列接着走） */
export const WRITE_BACK_HELP_ACK = "知道了";

/** 对话段在分隔线上的说法 */
export const CHAT_SEGMENT_TITLE = "你直接对话";
/** 重置维护者之后的那一段在分隔线上的说法 */
export const RESET_SEGMENT_TITLE = "重置维护者：新开一段会话，只凭项目档案重建理解";
