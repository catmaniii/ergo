// 范围记录（规格第 10 节，18 号票）的名字和纯函数。只有常量和纯函数，不引用 TypeBox（Web 只用这些）。schema 在 scope-record-schema.ts。
//
// 范围审视是软约束（和守卫是两道独立的闸）：维护者做了范围外的事会被发现、记下来，但不会被卡死。审视在维护者自己的子进程里
// 另开一次模型调用，对照立项书、任务计划和用户给过的授权（包括用户在会话里直接说的话），两个时点：压缩会话时、每张工单结束时。
// - 范围变更：用户授权过的范围外工作，写进项目档案的范围记录（不属于项目的任务：写进任务自己的产出区）；
// - 越界：没授权的，同样记下来，另在待我处理放一条不推送的通知（不卡任务，照常算未读）。维护者不被暂停。
// 范围记录以守护进程保存的为准：项目列表频道（项目维护者的）、任务看板频道（不属于项目的任务的）上的 scope_record 事件；
// 维护者会话频道上同一事务另有一条 timeline_record（种类 scope_change / out_of_scope），供时间线标出。

import { CHANNELS } from "./constants.ts";
import { tTable } from "./i18n/runtime.ts";

/** 范围记录的种类：范围变更（用户授权过的范围外工作）、越界（没授权的）。和时间线记录的种类同名 */
export const SCOPE_RECORD_KINDS = ["scope_change", "out_of_scope"] as const;
export type ScopeRecordKind = (typeof SCOPE_RECORD_KINDS)[number];

export const SCOPE_RECORD_KIND_LABEL: Readonly<Record<ScopeRecordKind, string>> = tTable({
  scope_change: "protocol.scopeRecords.kind.scopeChange",
  out_of_scope: "protocol.scopeRecords.kind.outOfScope",
});

/** 这条记录是哪次审视的：压缩会话时、工单结束时 */
export const SCOPE_REVIEW_TRIGGERS = ["compaction", "work_order_end"] as const;
export type ScopeReviewTrigger = (typeof SCOPE_REVIEW_TRIGGERS)[number];

export const SCOPE_REVIEW_TRIGGER_LABEL: Readonly<Record<ScopeReviewTrigger, string>> = tTable({
  compaction: "protocol.scopeRecords.trigger.compaction",
  work_order_end: "protocol.scopeRecords.trigger.workOrderEnd",
});

/** 越界通知（待我处理里的 out_of_scope）的动作：只是告诉用户（维护者照常继续，不卡任务） */
export const OUT_OF_SCOPE_ACK = "知道了"; // @i18n-ignore fixed：事项的动作按字认

/** 一条范围记录落在哪个频道：项目维护者的在项目列表频道，不属于项目的任务的在任务看板频道（守护进程、Web 共用） */
export function scopeRecordChannel(record: { projectId?: string | undefined }): string {
  return record.projectId === undefined ? CHANNELS.board : CHANNELS.projects;
}
