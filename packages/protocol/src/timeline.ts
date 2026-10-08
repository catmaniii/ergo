// 时间线（规格术语"时间线"，25 号票）：任务或维护者会话按时间排列的记录，能缩放到要点层和全局层。
// 会话里的消息之外，时间线上还有几种"记录"：会话频道上的 timeline_record 事件，每条一种 kind——
// - deviation：偏离（14 号票产生：阈值超了这一支停下找用户、催促、用量超过预算让维护者说明进展、累计被拒暂停任务；
//   授权内放行的调用本身是工具调用记录上的 withinGrant，不另记）；
// - plan_change / plan_revision：计划变更（用户确认或拒绝了维护者提交的）、自行调整计划（维护者自己改的，不扩大授权），14 号票产生；
// - scope_change / out_of_scope：范围审视的结果，范围变更 / 越界（18 号票产生）；
// - write_back_missing：项目维护者的一段没写回项目档案就结束了；own_judgement：工单的提问卡被关掉，维护者按自己的理解接着做（16 号票）。
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
  // 16 号票：项目维护者的一段没写回项目档案就结束了（重置维护者、催了还没写回）
  write_back_missing: { label: "没写回档案", gist: true, severity: "notice" },
  // 16 号票：用户关掉了工单的提问卡，维护者按自己的理解接着做
  own_judgement: { label: "按自己的理解接着做", gist: true, severity: "info" },
  plan_change: { label: "计划变更", gist: true, severity: "info" },
  plan_revision: { label: "自行调整计划", gist: true, severity: "info" },
  // 18 号票：项目维护者的一段工单的工作没做范围审视就结束了（重置维护者时）
  scope_review_missing: { label: "没做范围审视", gist: true, severity: "notice" },
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
