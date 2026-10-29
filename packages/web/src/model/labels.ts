// 界面上的标签。用词以 CONTEXT.md 的术语表为准。169 号票起按当前语言（tTable 取值时现查，语言文件的 model.labels.*）。
import { activeLanguage, DEFAULT_LANGUAGE, formatNumber, t, TASK_WAIT_REASON_LABEL, tTable, type Urgency, URGENCY_LABEL as PROTOCOL_URGENCY_LABEL } from "../state/index.ts";
import type { ActivityState, ScheduledJobSummary, TaskStatus, WaitReason, WorkOrder } from "./types.ts";

/** 处置的中文名：只有共享协议包里一份 */
export { DISPOSITION_LABEL } from "../state/index.ts";

/** 工具调用被拦下的原因不是处置时（硬拒绝、按规则退回、守卫判定出错）：只有共享协议包里一份 */
export { TOOL_CALL_BLOCK_LABEL as BLOCKED_BY_LABEL } from "../state/index.ts";

export const TASK_STATUS_LABEL: Readonly<Record<TaskStatus, string>> = tTable({
  planning: "model.labels.taskStatus.planning",
  awaiting_confirm: "model.labels.taskStatus.awaitingConfirm",
  scheduled: "model.labels.taskStatus.scheduled",
  queued: "model.labels.taskStatus.queued",
  running: "model.labels.taskStatus.running",
  waiting_for_user: "model.labels.taskStatus.waitingForUser",
  paused: "model.labels.taskStatus.paused",
  operating: "model.labels.taskStatus.operating",
  done: "model.labels.taskStatus.done",
  failed: "model.labels.taskStatus.failed",
  cancelled: "model.labels.taskStatus.cancelled",
  archived: "model.labels.taskStatus.archived",
});

/** 验收方式（规格第 8 节） */
export const ACCEPTANCE_METHOD_LABEL = tTable({ script: "model.labels.acceptance.script", review: "model.labels.acceptance.review", user: "model.labels.acceptance.user" });

/** 等我的原因的中文名：只有共享协议包里一份 */
export const WAIT_REASON_LABEL: Readonly<Record<WaitReason, string>> = TASK_WAIT_REASON_LABEL;

export const ACTIVITY_LABEL: Readonly<Record<ActivityState, string>> = tTable({
  sleeping: "model.labels.activity.sleeping",
  working: "model.labels.activity.working",
  waiting_for_user: "model.labels.activity.waitingForUser",
  queued: "model.labels.activity.queued",
});

/** 紧急度的中文名：只有共享协议包里一份（排序按 URGENCIES 的先后，见 compareInboxItems） */
export const URGENCY_LABEL: Readonly<Record<Urgency, string>> = PROTOCOL_URGENCY_LABEL;

export const WORK_ORDER_STATUS_LABEL: Readonly<Record<WorkOrder["status"], string>> = tTable({
  waiting_for_user: "model.labels.workOrder.waitingForUser",
  queued: "model.labels.workOrder.queued",
  in_progress: "model.labels.workOrder.inProgress",
  clarifying: "model.labels.workOrder.clarifying",
  done: "model.labels.workOrder.done",
  returned: "model.labels.workOrder.returned",
  unable: "model.labels.workOrder.unable",
});

/** 定时作业的状态 */
export const SCHEDULED_JOB_STATUS_LABEL: Readonly<Record<ScheduledJobSummary["status"], string>> = tTable({
  active: "model.labels.scheduledJob.active",
  paused: "model.labels.scheduledJob.paused",
});

/** 定时作业的状态文字：连续失败 3 次被自动暂停的注明"自动" */
export function scheduledJobStatusLabel(sj: Pick<ScheduledJobSummary, "status" | "autoPaused">): string {
  return sj.status === "paused" && sj.autoPaused ? t("model.labels.scheduledJob.autoPaused") : SCHEDULED_JOB_STATUS_LABEL[sj.status];
}

/** 周一在前的一周（日历、选周几都按这个顺序排） */
export const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

/** 周几的名字，下标 0 = 周日（和 Date.getDay 一致）：0 → "周日"；short 时只给"日"（英文 Sun / Su） */
export function weekdayLabel(d: number, short = false): string {
  if (d < 0 || d > 6 || !Number.isInteger(d)) return "";
  return t(short ? `model.labels.weekdayShort.${d}` : `model.labels.weekday.${d}`);
}

/** 12345 → "1.2 万"（英文这类按千、百万缩写：12K、1.2M） */
export function tokensLabel(n: number): string {
  // "万"是中文的数法：别的语言按 Intl 的缩写（1.2K、12K、1.2M）
  if (activeLanguage() !== DEFAULT_LANGUAGE) return n >= 1000 ? formatNumber(n, { notation: "compact" }) : String(n);
  if (n >= 10000) return t("model.labels.tenThousand", { n: Number((n / 10000).toFixed(n >= 1_000_000 ? 0 : 1)) });
  return String(n);
}

/**
 * 用了多少 token（任务卡、任务详情顶上、项目页的内部任务）："12.3 万 token"，英文"12K tokens"（175 号票：英文分单复数）。
 * 311 号票：给了其中缓存命中的（账本的 cacheHit，pi 和 Claude Code 都有）就单写出来——"124 万 token（其中缓存命中 104 万）"，说法照消耗页
 */
export function tokensText(n: number, cacheHit = 0): string {
  if (cacheHit > 0) return t("model.labels.tokensWithCache", { n: tokensLabel(n), hit: tokensLabel(cacheHit), count: n });
  return t("model.labels.tokens", { n: tokensLabel(n), count: n });
}
