// 界面上的中文标签。用词以 CONTEXT.md 的术语表为准。
import type { Disposition, Urgency } from "../state/index.ts";
import type { ActivityState, ProjectStatus, RepeatRule, TaskStatus, WaitReason, WorkOrder } from "./types.ts";

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  do: "直接做只记录",
  do_then_tell: "做完告诉我",
  planned_only: "计划里列了才做",
  ask_first: "先问我",
  hand_to_me: "交给我做",
  never: "永不",
};

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
  waiting_me: "等我",
  paused: "已暂停",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
  archived: "已归档",
};

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
  waiting_you: "等你",
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
  awaiting_you: "待你确认",
  queued: "待接",
  in_progress: "进行中",
  clarifying: "等澄清",
  done: "已结束 · 完成",
  returned: "已结束 · 退回",
  unable: "已结束 · 做不了",
};

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function weekdayLabel(d: number): string {
  return WEEKDAY[d] ?? "";
}

export function repeatLabel(r: RepeatRule): string {
  switch (r.kind) {
    case "once":
      return "一次性";
    case "daily":
      return "每天";
    case "weekly":
      return `每周${r.weekdays.map((d) => weekdayLabel(d).slice(1)).join("、")}`;
    case "monthly":
      return `每月 ${r.days.join("、")} 号`;
    case "workdays":
      return "按我的工作日";
  }
}

/** 12345 → "1.2 万" */
export function tokensLabel(n: number): string {
  if (n >= 10000) return `${Number((n / 10000).toFixed(n >= 1_000_000 ? 0 : 1))} 万`;
  return String(n);
}

/** ISO 时间 → "10-07 09:12" */
export function timeLabel(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : iso;
}

/** ISO 时间 → "09:12" */
export function clockLabel(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : iso;
}

const pad2 = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");

/** 现在的本地时间，带时区偏移的 ISO 格式（和服务端事件里的时间同一种写法） */
export function nowIso(): string {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? "+" : "-"}${pad2(off / 60)}:${pad2(off % 60)}`;
}
