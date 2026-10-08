// 工单和维护者会话分段的 schema（规格第 11、12 节，16 号票），用 TypeBox 定义，守护进程和 Web 共用生成的类型。
// - 项目列表频道上的 work_order 事件：工单的最新状态（WorkOrder）。项目页的工单流水线、看板上任务卡的"等项目 X"都从它来；
//   工单不在看板上单独占卡；
// - 维护者会话频道上的 segment 事件：会话分段的最新状态（MaintainerSegment）。界面上的分段线是同一事务里追加的一条
//   带工单分隔 part（work_order_divider）的消息，segment 事件给守护进程自己（固定上下文里的"上一段摘要"、
//   接哪个会话）和想看分段细节的前端。
// - 工单卡（work_order，17 号票）：计划外的工单"待你确认"，用户确认派出或拒绝。
// 工单按来源分成几支（WorkOrder 是它们的联合，按 source 区分）：用户发起的单项目任务（16 号票，起草计划、执行）、
// 涉及多个项目的任务的维护者派来的改动（17 号票，带所属阶段、验收标准、回执）；定时作业的一次运行由 19 号票加一支。
// 名字（状态、结局、来源、种类、流水线三栏）在 work-orders.ts。
import { type Static, Type } from "typebox";
import { TASK_ACTORS } from "./tasks.ts";
import { SEGMENT_CHANGES, SEGMENT_KINDS, SEGMENT_STATES, WORK_ORDER_CHANGES, WORK_ORDER_OUTCOMES, WORK_ORDER_STATES, WRITE_BACK_GAPS } from "./work-orders.ts";

const WorkOrderStateSchema = Type.Enum(WORK_ORDER_STATES);

/** 每张工单都有的 */
const workOrderCommon = {
  /** 工单号：wo-1、wo-2…… */
  id: Type.String(),
  /** 收件项目和它的维护者 */
  projectId: Type.String(),
  maintainerId: Type.String(),
  /** 所属任务 */
  taskId: Type.String(),
  taskTitle: Type.String(),
  /** 流水线上的说法（"起草计划：给记账本加周报"） */
  title: Type.String(),
  state: WorkOrderStateSchema,
  /** 已结束的：完成、退回、做不了、没派出 */
  outcome: Type.Optional(Type.Enum(WORK_ORDER_OUTCOMES)),
  /** 退回、做不了的原因（发给已归档项目的、任务取消了、任务失败的原因；17 号票起也有项目维护者写的理由） */
  reason: Type.Optional(Type.String()),
  /**
   * 等澄清时：在等哪张提问卡的回答（16 号票：用户发起的单项目任务直接问用户；17 号票：任务维护者答不了、转问用户的那张，
   * 用户回答后经任务维护者交回）
   */
  questionsCardId: Type.Optional(Type.String()),
  /** 结束了、但那一段没写回项目档案（重置维护者、催了还没写回）：项目页如实写出来 */
  unwritten: Type.Optional(Type.Enum(WRITE_BACK_GAPS)),
  createdAt: Type.String(),
  startedAt: Type.Optional(Type.String()),
  endedAt: Type.Optional(Type.String()),
  updatedAt: Type.String(),
};

/** 用户发起的单项目任务的工单（16 号票）：起草计划、执行，派出即进收件维护者的队列 */
export const UserTaskWorkOrder = Type.Object({
  ...workOrderCommon,
  source: Type.Literal("user_task"),
  kind: Type.Union([Type.Literal("plan"), Type.Literal("execute")]),
  /**
   * 工单的内容：交给维护者的话（任务书、打回计划的意见、首个建设任务的交代）。工单开始时作为这一段固定上下文里的
   * "这次的工单"交给维护者；执行的工单没有（计划、当前阶段和授权由重注入块给）
   */
  instructions: Type.Optional(Type.String()),
});
export type UserTaskWorkOrder = Static<typeof UserTaskWorkOrder>;

/**
 * 涉及多个项目的任务的维护者派来的改动（17 号票）：计划内的在确认计划时建出、所属阶段开始时派出；计划外的待你确认，
 * 确认后派出。项目维护者做完交回执，回执交给派单的任务维护者
 */
export const TaskMaintainerWorkOrder = Type.Object({
  ...workOrderCommon,
  source: Type.Literal("task_maintainer"),
  kind: Type.Literal("change"),
  /** 要做的改动（交给项目维护者的话） */
  instructions: Type.String(),
  /** 所属阶段：这个阶段开始时派出，回执到齐后任务维护者跑这个阶段的验收 */
  stageId: Type.String(),
  /** 这张工单自己的验收标准 */
  acceptance: Type.Array(Type.String()),
  /** 计划内（计划里有这个阶段这个项目的一行，随计划一次确认）；false 是计划外的，要用户确认 */
  planned: Type.Boolean(),
  /** 待你确认的计划外工单：它的工单卡 */
  cardId: Type.Optional(Type.String()),
  /** 等澄清时项目维护者问的（问题交给派单的任务维护者，不直接出给用户） */
  question: Type.Optional(Type.String()),
  /** 回执：项目维护者完成或退回（做不了）时交回的说明；退回、做不了的理由在 reason */
  receipt: Type.Optional(Type.String()),
  /** 派出（进了收件维护者的队列）的时刻：建出和派出分开，等阶段开始、待你确认的派出时才有 */
  dispatchedAt: Type.Optional(Type.String()),
});
export type TaskMaintainerWorkOrder = Static<typeof TaskMaintainerWorkOrder>;

/** 一张工单（work_order 事件里是它的最新状态）：按来源（source）区分的几支 */
export const WorkOrder = Type.Union([UserTaskWorkOrder, TaskMaintainerWorkOrder]);
export type WorkOrder = Static<typeof WorkOrder>;

/**
 * 工单卡（work_order，17 号票）：执行中任务维护者派出计划外的工单时命中"计划外工单"类别（任务里默认先问我），
 * 工单待你确认，待我处理出现这张卡。"确认派出"（dispatch）之后工单才进入项目维护者的队列，"拒绝"（deny）则不派
 */
export const WorkOrderCardPayload = Type.Object({
  workOrderId: Type.String(),
  taskId: Type.String(),
  taskTitle: Type.String(),
  /** 收件项目 */
  projectId: Type.String(),
  projectName: Type.String(),
  /** 所属阶段 */
  stageId: Type.String(),
  stageTitle: Type.String(),
  title: Type.String(),
  /** 要做的事（交给项目维护者的话） */
  instructions: Type.String(),
  acceptance: Type.Array(Type.String()),
  /** 命中的关注类别（显示用的名字："计划外工单"） */
  categories: Type.Array(Type.String()),
});
export type WorkOrderCardPayload = Static<typeof WorkOrderCardPayload>;

/** 工单卡上的两个动作：确认派出、拒绝 */
export const WORK_ORDER_CARD_ACTIONS = ["dispatch", "deny"] as const;
export type WorkOrderDecision = (typeof WORK_ORDER_CARD_ACTIONS)[number];

/** `work_order` 事件（项目列表频道）：工单的最新状态，这次是什么变化、从哪个状态来（派出时为 null）、谁改的 */
export const WorkOrderEventPayload = Type.Object({
  workOrder: WorkOrder,
  change: Type.Enum(WORK_ORDER_CHANGES),
  from: Type.Union([WorkOrderStateSchema, Type.Null()]),
  by: Type.Enum(TASK_ACTORS),
});
export type WorkOrderEventPayload = Static<typeof WorkOrderEventPayload>;

/** 维护者会话的一段（segment 事件里是它的最新状态） */
export const MaintainerSegment = Type.Object({
  /** 段号：<维护者 id>-s<n>（同一个维护者从 1 往下排） */
  segmentId: Type.String(),
  maintainerId: Type.String(),
  projectId: Type.String(),
  kind: Type.Enum(SEGMENT_KINDS),
  /** 工单段：哪张工单、所属任务 */
  workOrderId: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.String()),
  /**
   * 这一段的会话（会话区里这个维护者目录下的一个会话的名字，文件怎么存由运行时定）：拉起时按它打开，接哪个会话由它明确指定。
   * 新的一段就是段号；第一段对话段接着以前的会话时，子进程报回它接的那个，记成那个的名字
   */
  session: Type.String(),
  /**
   * 这个维护者的第一段、而且是对话段：这个名字的会话还没有时，接着它以前的会话（任务转为项目时原任务的、16 号票之前的立项问答）；
   * 接的是哪个由子进程报回，记成 session
   */
  continueEarlier: Type.Optional(Type.Boolean()),
  /** 重置维护者开的段：上下文只来自项目档案，没有上一段的摘要 */
  reset: Type.Boolean(),
  state: Type.Enum(SEGMENT_STATES),
  /** 这一段开始时进展文档（progress.md）的内容哈希：结束时没变就催维护者写回 */
  progressHash: Type.String(),
  /** 维护者写的这一段的摘要：下一段固定上下文里的"上一段摘要" */
  summary: Type.Optional(Type.String()),
  /** 没写回项目档案就结束了：重置维护者、催了还没写回 */
  unwritten: Type.Optional(Type.Enum(WRITE_BACK_GAPS)),
  /** 收尾中、已结束的工单段：工单以什么结局结束（写回之后才真正结束） */
  outcome: Type.Optional(Type.Enum(WORK_ORDER_OUTCOMES)),
  reason: Type.Optional(Type.String()),
  openedAt: Type.String(),
  closedAt: Type.Optional(Type.String()),
});
export type MaintainerSegment = Static<typeof MaintainerSegment>;

/** `segment` 事件（维护者会话频道）：一段的最新状态和这次的变化 */
export const SegmentEventPayload = Type.Object({ segment: MaintainerSegment, change: Type.Enum(SEGMENT_CHANGES) });
export type SegmentEventPayload = Static<typeof SegmentEventPayload>;
