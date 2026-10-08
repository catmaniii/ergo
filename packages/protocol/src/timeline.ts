// 时间线（规格术语"时间线"，25 号票）：任务或维护者会话按时间排列的记录，能缩放到要点层和全局层。
// 会话里的消息之外，时间线上还有几种"记录"：会话频道上的 timeline_record 事件，每条一种 kind——
// - deviation：偏离（14 号票产生：计划外但在授权范围内的调用只记一笔摘要……）；
// - scope_change / out_of_scope：范围审视的结果，范围变更 / 越界（18 号票产生）。
// 守护进程追加记录用 conversation/messages.ts 的 buildTimelineRecord（和 buildMessage 一样带上归属）。
// 后面的票加新的 kind 只往 TIMELINE_RECORD_KIND_INFO 里加一行（中文名、要不要进要点层、严重度；界面按严重度取样式）；
// 前端不认识的 kind 只在完整视图里按 summary 显示一行。
// 快速动作的执行（操作记录，会话频道上的 quick_action_executed，21 号票）也显示在时间线上，不在这里定义。
import { type Static, Type } from "typebox";
import { MessageScope } from "./schema.ts";

/** 记录的严重度：一般（照常记一笔，比如范围变更）、留意（偏离计划）、警示（越界） */
export const TIMELINE_RECORD_SEVERITIES = ["info", "notice", "alert"] as const;
export type TimelineRecordSeverity = (typeof TIMELINE_RECORD_SEVERITIES)[number];

/** 每种记录的中文名、是不是要点（要点层只留要点，全局层的色块上标出要点）、严重度 */
export const TIMELINE_RECORD_KIND_INFO = {
  deviation: { label: "偏离", gist: true, severity: "notice" },
  scope_change: { label: "范围变更", gist: true, severity: "info" },
  out_of_scope: { label: "越界", gist: true, severity: "alert" },
} as const satisfies Readonly<Record<string, { label: string; gist: boolean; severity: TimelineRecordSeverity }>>;

export type TimelineRecordKind = keyof typeof TIMELINE_RECORD_KIND_INFO;
export const TIMELINE_RECORD_KINDS = Object.keys(TIMELINE_RECORD_KIND_INFO) as TimelineRecordKind[];

/** 时间线上的一条记录 */
export const TimelineRecord = Type.Object({
  id: Type.String({ minLength: 1 }),
  /** 记录的种类（TIMELINE_RECORD_KIND_INFO 的键；新的前端可能还不认识的种类照样收） */
  kind: Type.String({ minLength: 1 }),
  /** 一句话（给人看的摘要，界面和要点层显示它） */
  summary: Type.String(),
  /** 详细说明（可选，展开时显示） */
  detail: Type.Optional(Type.String()),
  /** 什么时候（带时区偏移的 ISO 时间） */
  time: Type.String(),
  /** 属于哪张工单（项目维护者的工单段里的） */
  workOrderId: Type.Optional(Type.String()),
});
export type TimelineRecord = Static<typeof TimelineRecord>;

/**
 * `timeline_record` 事件（会话频道，落盘）：时间线上的一条记录。和消息一样摊开带着归属（MessageScope：任务、项目、
 * 属于任务的带上当时的阶段——全局层按它聚色块）
 */
export const TimelineRecordEventPayload = Type.Object({
  record: TimelineRecord,
  ...MessageScope.properties,
});
export type TimelineRecordEventPayload = Static<typeof TimelineRecordEventPayload>;

/** 认不认识这种记录 */
export function isTimelineRecordKind(kind: string): kind is TimelineRecordKind {
  return Object.hasOwn(TIMELINE_RECORD_KIND_INFO, kind);
}
