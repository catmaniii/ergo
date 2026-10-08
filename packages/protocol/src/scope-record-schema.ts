// 范围记录的 schema（规格第 10 节，18 号票），用 TypeBox 定义，守护进程和 Web 共用生成的类型。名字在 scope-records.ts。
// - 项目列表频道上的 scope_record 事件：项目维护者的一条范围记录（简版项目页的"范围记录"一节）；
// - 任务看板频道上的 scope_record 事件：不属于项目的任务（任务自己的维护者）的一条范围记录（任务详情里显示）。
//   落在哪个频道由 scopeRecordChannel 定（scope-records.ts）。
import { type Static, Type } from "typebox";
import { SCOPE_RECORD_KINDS, SCOPE_REVIEW_TRIGGERS } from "./scope-records.ts";

/** 一段工作属于谁（范围记录、越界通知上都带着）：哪个维护者；项目维护者的有项目；属于任务的有任务，做工单时还有工单 */
export const ScopeOwnership = Type.Object({
  /** 哪个维护者的工作 */
  maintainerId: Type.String(),
  /** 项目维护者的：属于哪个项目 */
  projectId: Type.Optional(Type.String()),
  /** 任务自己的维护者的，或者项目维护者做这个任务的工单时 */
  taskId: Type.Optional(Type.String()),
  workOrderId: Type.Optional(Type.String()),
});
export type ScopeOwnership = Static<typeof ScopeOwnership>;

/** 一条范围记录 */
export const ScopeRecord = Type.Object({
  /** sr-<uuid> */
  id: Type.String(),
  /** 范围变更 / 越界 */
  kind: Type.Enum(SCOPE_RECORD_KINDS),
  /** 一句话 */
  summary: Type.String(),
  /** 说明 */
  detail: Type.Optional(Type.String()),
  /** 依据：范围变更是用户的哪句话、哪项授权 */
  basis: Type.Optional(Type.String()),
  /** 哪次审视的：压缩会话时、工单结束时 */
  trigger: Type.Enum(SCOPE_REVIEW_TRIGGERS),
  ...ScopeOwnership.properties,
  /** 什么时候记的（带时区偏移的 ISO 时间） */
  time: Type.String(),
});
export type ScopeRecord = Static<typeof ScopeRecord>;

/**
 * 审视时看到的用户原话从哪来：用户在维护者会话里的消息（对照物里的、会话里交给维护者的输入）、用户在审批卡上批准的审批。
 * 彻底删除其中一条时，这条范围记录里的文字（摘要、说明、依据）一起换成删除标记
 */
export const ScopeSources = Type.Object({
  messageIds: Type.Array(Type.String()),
  approvalIds: Type.Array(Type.String()),
});
export type ScopeSources = Static<typeof ScopeSources>;

/**
 * `scope_record` 事件（项目列表频道或任务看板频道，落盘）：一条范围记录。彻底删除改写过的记录另追加一条改写后的
 * （同一个 id，开着的页面、项目档案里的文件据此换掉）
 */
export const ScopeRecordEventPayload = Type.Object({ record: ScopeRecord, sources: ScopeSources });
export type ScopeRecordEventPayload = Static<typeof ScopeRecordEventPayload>;

/** 越界通知（待我处理里的 out_of_scope）的数据：哪条范围记录，属于谁 */
export type OutOfScopeNoticeData = ScopeOwnership & { recordId: string };
