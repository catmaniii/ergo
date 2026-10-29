// 时间线（规格术语"时间线"，25 号票）：任务或维护者会话按时间排列的记录，能缩放到要点层和全局层。
// 会话里的消息之外，时间线上还有几种"记录"：会话频道上的 timeline_record 事件，每条一种 kind——
// - deviation：偏离（14 号票产生：阈值超了这一支停下找用户、催促、用量超过预算让维护者说明进展、累计被拒暂停任务；
//   授权内放行的调用本身是工具调用记录上的 withinGrant，不另记）；
// - plan_change / plan_revision：计划变更（用户确认或拒绝了维护者提交的）、自行调整计划（维护者自己改的，不扩大授权），14 号票产生；
// - scope_change / out_of_scope：范围审视的结果，范围变更 / 越界（18 号票产生）；
// - write_back_missing：项目维护者的一段没写回项目档案就结束了；own_judgement：工单的提问卡被关掉，维护者按自己的理解接着做（16 号票）；
// - work_order：涉及多个项目的任务里工单的建出、派出、待你确认、确认或拒绝、回执（17 号票，记在任务维护者的会话里）。
// - reopen：你从长程任务的某个阶段重做（返工）了（84 号票：阶段重开的记录，"你从「…」重做（连带后面的……）"；
//   重开之前那几轮在界面上标已废弃，阶段详情里算一次"撤回"状况）。
// - compaction：会话在这里压缩过一次（114 号票：秘书、维护者的会话，自动和手动的都记）。
// - auto_acceptance：阶段改成自动验收（112 号票）：升级前确认的计划里原定由你验收的标准改由评审验收，在等你验收的交给评审。
// - charter_change：立项要求变更（125 号票）：你在卡上确认或拒绝了维护者提的立项要求变更（目标、范围、首版）。
// - standard_change：规范改写（261 号票）：你在卡上确认或拒绝了维护者提的本项目的规范改写、跟新版规范。
// - standard_backfill：补齐规范文档（262 号票）：规范上线之前建的项目，你在"补齐规范文档"卡上选了补齐（建了任务交给维护者补）或不补。
// - operations：运营方案（130 号票）：你确认了运营方案、它生效了（每一条建成了哪个内部任务、哪条没生效），或者拒绝了运营方案变更。
// - stopped：你停止了这一轮（144 号票：秘书、维护者回复时点了输入框旁的"停止"）。
// - mcp：MCP 登记变了（239 号票：你在"MCP 登记变更"卡上批准或拒绝了维护者提的加、改、删，自检结果一并记着）。
// - mcp_call：秘书带参调了一次登记过的 MCP 工具（240 号票）；project_op：秘书调了一次运营中的项目的接口（260 号票，project_ops）。
// 守护进程追加记录用 conversation/messages.ts 的 buildTimelineRecord（和 buildMessage 一样带上归属）。
// 后面的票加新的 kind 只往 TIMELINE_RECORD_KIND_INFO 里加一行（中文名、要不要进要点层、严重度；界面按严重度取样式）；
// 前端不认识的 kind 只在完整视图里按 summary 显示一行。
// 快速动作的执行（操作记录，会话频道上的 quick_action_executed，21 号票）也显示在时间线上，不在这里定义。
import { type Static, Type } from "typebox";
import { t } from "./i18n/runtime.ts";
import { MessageScope } from "./schema.ts";

/** 记录的严重度：一般（照常记一笔，比如范围变更）、留意（偏离计划）、警示（越界） */
export const TIMELINE_RECORD_SEVERITIES = ["info", "notice", "alert"] as const;
export type TimelineRecordSeverity = (typeof TIMELINE_RECORD_SEVERITIES)[number];

/** 每种记录的名字（跟着当前语言，取值时现查）、是不是要点（要点层只留要点，全局层的色块上标出要点）、严重度 */
export const TIMELINE_RECORD_KIND_INFO = {
  deviation: {
    get label() {
      return t("protocol.timeline.kind.deviation");
    },
    gist: true,
    severity: "notice",
  },
  scope_change: {
    get label() {
      return t("protocol.timeline.kind.scopeChange");
    },
    gist: true,
    severity: "info",
  },
  out_of_scope: {
    get label() {
      return t("protocol.timeline.kind.outOfScope");
    },
    gist: true,
    severity: "alert",
  },
  // 16 号票：项目维护者的一段没写回项目档案就结束了（重置维护者、催了还没写回）
  write_back_missing: {
    get label() {
      return t("protocol.timeline.kind.writeBackMissing");
    },
    gist: true,
    severity: "notice",
  },
  // 16 号票：用户关掉了工单的提问卡，维护者按自己的理解接着做
  own_judgement: {
    get label() {
      return t("protocol.timeline.kind.ownJudgement");
    },
    gist: true,
    severity: "info",
  },
  plan_change: {
    get label() {
      return t("protocol.timeline.kind.planChange");
    },
    gist: true,
    severity: "info",
  },
  plan_revision: {
    get label() {
      return t("protocol.timeline.kind.planRevision");
    },
    gist: true,
    severity: "info",
  },
  // 18 号票：项目维护者的一段工单的工作没做范围审视就结束了（重置维护者时）
  scope_review_missing: {
    get label() {
      return t("protocol.timeline.kind.scopeReviewMissing");
    },
    gist: true,
    severity: "notice",
  },
  // 27 号票：工具包变了（维护者增减 skill、用户直接改、批准了"工具包变更"卡）
  toolkit: {
    get label() {
      return t("protocol.timeline.kind.toolkit");
    },
    gist: true,
    severity: "info",
  },
  // 17 号票：涉及多个项目的任务里工单的往来——建出、派出、待你确认、你确认或拒绝、回执（agent 之间只通过工单往来，全部记在任务时间线上）
  work_order: {
    get label() {
      return t("protocol.timeline.kind.workOrder");
    },
    gist: true,
    severity: "info",
  },
  // 84 号票：你从某个阶段重做（返工）了
  reopen: {
    get label() {
      return t("protocol.timeline.kind.reopen");
    },
    gist: true,
    severity: "info",
  },
  // 274 号票：从某个阶段重做之后，范围外已经验收过的阶段按各自的验收标准再核一遍，有没过的（"重开之后复验没过"）
  reverify: {
    get label() {
      return t("protocol.timeline.kind.reverify");
    },
    gist: true,
    severity: "notice",
  },
  // 114 号票：会话在这里压缩过一次（自动：用量快到窗口、上下文溢出；手动：⚙ 里的"现在压缩"）
  compaction: {
    get label() {
      return t("protocol.timeline.kind.compaction");
    },
    gist: false,
    severity: "info",
  },
  // 112 号票：阶段改成自动验收——计划里原定由你验收的标准改由评审验收（升级前确认的计划），在等你验收的交给评审
  auto_acceptance: {
    get label() {
      return t("protocol.timeline.kind.autoAcceptance");
    },
    gist: true,
    severity: "info",
  },
  // 125 号票：立项要求变更（你在"立项要求变更"卡上确认或拒绝了维护者提的改动），记在项目维护者的会话里
  charter_change: {
    get label() {
      return t("protocol.timeline.kind.charterChange");
    },
    gist: true,
    severity: "info",
  },
  // 261 号票：规范改写（你在"规范改写"卡上确认或拒绝了维护者提的本项目的规范改写、跟新版规范），记在项目维护者的会话里
  standard_change: {
    get label() {
      return t("protocol.timeline.kind.standardChange");
    },
    gist: true,
    severity: "info",
  },
  // 262 号票：补齐规范文档（规范上线之前建的项目，你在"补齐规范文档"卡上选了补齐或不补），记在项目维护者的会话里
  standard_backfill: {
    get label() {
      return t("protocol.timeline.kind.standardBackfill");
    },
    gist: true,
    severity: "info",
  },
  // 130 号票：运营方案已生效（你在"首版做完了"卡上确认并转入使用、在"运营方案变更"卡上确认），或者你拒绝了运营方案变更
  operations: {
    get label() {
      return t("protocol.timeline.kind.operations");
    },
    gist: true,
    severity: "info",
  },
  // 144 号票：你点了输入框旁的"停止"，这一轮停下了（已经说出来的留着，标"已停止"）
  stopped: {
    get label() {
      return t("protocol.timeline.kind.stopped");
    },
    gist: false,
    severity: "info",
  },
  // 239 号票：MCP 登记变了（你在"MCP 登记变更"卡上批准或拒绝了维护者提的加、改、删，自检结果也在这里）
  mcp: {
    get label() {
      return t("protocol.timeline.kind.mcp");
    },
    gist: true,
    severity: "info",
  },
  // 240 号票：秘书用登记过的 MCP 做了一次带参调用（只读直接做的、出了卡等你确认的、你批准、拒绝或者被底线拦下的）
  mcp_call: {
    get label() {
      return t("protocol.timeline.kind.mcpCall");
    },
    gist: true,
    severity: "info",
  },
  // 260 号票：秘书经 project_ops 调了一次运营中的项目的接口（二狗在本机代调项目服务的调用口；调到了、没做成的都记）
  project_op: {
    get label() {
      return t("protocol.timeline.kind.projectOp");
    },
    gist: true,
    severity: "info",
  },
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
  /**
   * 这条记录已经替它说清楚了的那条交给 agent 的通知（消息 id，84 号票：重做记录后面交给维护者"接着做"的那句），界面上不再重复显示
   * （重开后交给维护者的那句也不显示）
   */
  noticeId: Type.Optional(Type.String()),
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
