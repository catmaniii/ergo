// 工单与维护者会话分段（规格第 11、12 节，16 号票）的名字：工单的状态、结局、来源、种类、项目页工单流水线的三栏，
// 维护者会话分段的种类和状态。只有常量和纯函数，不引用 TypeBox（Web 只用这些）。schema 在 work-order-schema.ts。
//
// 工单：交给某个项目维护者的一份工作。派单器把它放进收件项目维护者的工单队列，一次只做一件、先来先做：
//   待接 → 进行中 ⇄ 等澄清 → 已结束（完成、退回、做不了）；"待你确认"（计划外的工单）在 17 号票。
// 本票的来源只有"用户发起的单项目任务"（17：别的任务的维护者派来的部分；19：定时作业的一次运行）。
// 单项目任务的维护者要做两件事，各是一张工单：起草计划（plan），用户确认计划后执行（execute）；
// 打回计划后重新起草、失败后重试、完成后返工，各是一张新的工单。

/** 工单的状态：待接（在收件维护者的队列里）、进行中、等澄清（维护者在等派单方回答）、已结束 */
export const WORK_ORDER_STATES = ["pending", "in_progress", "clarifying", "ended"] as const;
export type WorkOrderState = (typeof WORK_ORDER_STATES)[number];

export const WORK_ORDER_STATE_LABEL: Readonly<Record<WorkOrderState, string>> = { pending: "待接", in_progress: "进行中", clarifying: "等澄清", ended: "已结束" };

/** 已结束的工单怎么结束的：完成、退回（发给已归档项目的、任务被取消了）、做不了（任务失败） */
export const WORK_ORDER_OUTCOMES = ["done", "returned", "unable"] as const;
export type WorkOrderOutcome = (typeof WORK_ORDER_OUTCOMES)[number];

export const WORK_ORDER_OUTCOME_LABEL: Readonly<Record<WorkOrderOutcome, string>> = { done: "完成", returned: "退回", unable: "做不了" };

/** 工单从哪来（派单方）：本票只有用户发起的单项目任务 */
export const WORK_ORDER_SOURCES = ["user_task"] as const;
export type WorkOrderSource = (typeof WORK_ORDER_SOURCES)[number];

/** 派单方的说法（流水线上的"来源"） */
export const WORK_ORDER_SOURCE_LABEL: Readonly<Record<WorkOrderSource, string>> = { user_task: "你" };

/** 工单要做的事：起草计划、执行（用户确认计划之后） */
export const WORK_ORDER_KINDS = ["plan", "execute"] as const;
export type WorkOrderKind = (typeof WORK_ORDER_KINDS)[number];

export const WORK_ORDER_KIND_LABEL: Readonly<Record<WorkOrderKind, string>> = { plan: "起草计划", execute: "执行" };

/**
 * 项目列表频道上 work_order 事件的"这次是什么变化"：派出（进了收件维护者的队列）、内容改了（还在排队时任务书改了版）、
 * 开始（维护者接了）、转等澄清、澄清有了回答（回到进行中）、结束（带结局）
 */
export const WORK_ORDER_CHANGES = ["created", "updated", "started", "clarifying", "answered", "ended"] as const;
export type WorkOrderChange = (typeof WORK_ORDER_CHANGES)[number];

/** 维护者手上的工单（同一项目同一时刻最多一张）：进行中或等澄清 */
export function isActiveWorkOrder(workOrder: { state: WorkOrderState }): boolean {
  return workOrder.state === "in_progress" || workOrder.state === "clarifying";
}

/** 项目页上工单流水线的三栏：排队中（待接）、进行中（含等澄清）、已结束 */
export const WORK_ORDER_LANES = ["queued", "active", "ended"] as const;
export type WorkOrderLane = (typeof WORK_ORDER_LANES)[number];

export const WORK_ORDER_LANE_LABEL: Readonly<Record<WorkOrderLane, string>> = { queued: "排队中", active: "进行中", ended: "已结束" };

export function workOrderLane(workOrder: { state: WorkOrderState }): WorkOrderLane {
  if (workOrder.state === "pending") return "queued";
  return workOrder.state === "ended" ? "ended" : "active";
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
