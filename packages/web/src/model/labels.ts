// 界面上的中文标签。用词以 CONTEXT.md 的术语表为准。
import { CHANNELS, type ConversationId, type Disposition, MAINTAINER_CHANNEL_PREFIX, type Urgency } from "../state/index.ts";
import type { ActivityState, ProjectStatus, ScheduledJobSummary, TaskStatus, WaitReason, WorkOrder } from "./types.ts";

/** 处置的中文名：只有共享协议包里一份 */
export { DISPOSITION_LABEL } from "../state/index.ts";

/** 会话的名字（记忆删除卡、设置里删除素材时用）：秘书主线，或者某个维护者 */
export function conversationLabel(conversation: ConversationId | string): string {
  if (conversation === CHANNELS.secretary) return "秘书主线";
  return conversation.startsWith(MAINTAINER_CHANNEL_PREFIX) ? `维护者 ${conversation.slice(MAINTAINER_CHANNEL_PREFIX.length)}` : conversation;
}

/** 工具调用被拦下的原因不是处置时（硬拒绝、按规则退回、守卫判定出错） */
export const BLOCKED_BY_LABEL = { hard_refusal: "硬拒绝", pull_back: "按规则退回", judge_error: "判定出错" } as const;

/** 处置从松到严的顺序：用户只能往严里调 */
export const DISPOSITION_ORDER: Disposition[] = ["do", "do_then_tell", "planned_only", "ask_first", "hand_to_me", "never"];

/** 不比 base 更松的处置 */
export function notLooserThan(base: Disposition): Disposition[] {
  return DISPOSITION_ORDER.slice(DISPOSITION_ORDER.indexOf(base));
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  planning: "规划中",
  awaiting_confirm: "待确认",
  queued: "排队中",
  running: "执行中",
  waiting_for_user: "等我",
  paused: "已暂停",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
  archived: "已归档",
};

/** 验收方式（规格第 8 节） */
export const ACCEPTANCE_METHOD_LABEL = { script: "脚本", review: "评审", user: "由你验收" } as const;

export const WAIT_REASON_LABEL: Record<WaitReason, string> = {
  approval: "审批",
  clarification: "澄清",
  acceptance: "由我验收",
  stuck: "卡住求助",
  over_budget: "超预算",
  interrupted: "中断不确定",
};

export const ACTIVITY_LABEL: Record<ActivityState, string> = {
  sleeping: "休眠",
  working: "干活中",
  waiting_for_user: "等你",
  queued: "排队",
};

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  preparing: "筹备中",
  building: "建设中",
  in_use: "使用中",
  retired: "已停用",
  archived: "已归档",
};

export const URGENCY_LABEL: Record<Urgency, string> = {
  blocking_deadline: "卡住任务 · 有时限",
  blocking: "卡住任务",
  non_blocking: "不卡任务",
};

export const URGENCY_RANK: Record<Urgency, number> = { blocking_deadline: 0, blocking: 1, non_blocking: 2 };

export const WORK_ORDER_STATUS_LABEL: Record<WorkOrder["status"], string> = {
  waiting_for_user: "待你确认",
  queued: "待接",
  in_progress: "进行中",
  clarifying: "等澄清",
  done: "已结束 · 完成",
  returned: "已结束 · 退回",
  unable: "已结束 · 做不了",
};

/** 周几的名字，下标 0 = 周日（和 Date.getDay 一致） */
export const SCHEDULED_JOB_STATUS_LABEL: Record<ScheduledJobSummary["status"], string> = {
  active: "运营中",
  paused: "已暂停",
};

/** 定时作业的状态文字：连续失败 3 次被自动暂停的注明"自动" */
export function scheduledJobStatusLabel(sj: Pick<ScheduledJobSummary, "status" | "autoPaused">): string {
  return sj.status === "paused" && sj.autoPaused ? "已暂停（连续失败 3 次，自动）" : SCHEDULED_JOB_STATUS_LABEL[sj.status];
}

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 周一在前的一周（日历、选周几都按这个顺序排） */
export const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

/** 0 → "周日"；short 时只给"日" */
export function weekdayLabel(d: number, short = false): string {
  const name = WEEKDAY_NAMES[d] ?? "";
  return short ? name.slice(1) : name;
}

/** 12345 → "1.2 万" */
export function tokensLabel(n: number): string {
  if (n >= 10000) return `${Number((n / 10000).toFixed(n >= 1_000_000 ? 0 : 1))} 万`;
  return String(n);
}
