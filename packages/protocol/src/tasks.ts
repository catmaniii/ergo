// 任务（规格第 8 节）的名字：任务状态、谁改的、看板分组、计划里的枚举。
// 只有常量和纯函数，不引用 TypeBox（Web 只用这些常量和类型）。schema 在 task-schema.ts，计划的纯函数在 plan.ts，
// 活动状态在 activity.ts。"谁能改"表（状态迁移的校验）在守护进程的任务模块里（tasks/state-machine.ts）。
import type { ReminderStatus } from "./schema.ts";

/**
 * 任务状态：规划中 → 待确认 → 排队中 → 执行中 → 已完成 →（用户手动）已归档；执行中 ⇄ 等我 / 已暂停；
 * 执行中 → 失败 →（重试）执行中；已完成 → 返工 → 执行中；任何未结束的状态 → 已取消。
 */
export const TASK_STATES = ["planning", "awaiting_confirm", "queued", "running", "waiting_for_user", "paused", "done", "failed", "cancelled", "archived"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_STATE_LABEL: Readonly<Record<TaskState, string>> = {
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

/** 结束了的状态（不再推进；"任何未结束的状态 → 已取消"里的"结束"） */
export const ENDED_TASK_STATES: readonly TaskState[] = ["done", "failed", "cancelled", "archived"];

/** 未结束的状态：都能取消、转为项目 */
export const UNFINISHED_TASK_STATES: readonly TaskState[] = TASK_STATES.filter((s) => !ENDED_TASK_STATES.includes(s));

/** 已完成的任务是怎么结束的（不写是做完了）：转为项目（15 号票），显示成"已完成 · 已转为项目" */
export const TASK_END_KINDS = ["converted_to_project"] as const;
export type TaskEndKind = (typeof TASK_END_KINDS)[number];

export const TASK_END_KIND_LABEL: Readonly<Record<TaskEndKind, string>> = { converted_to_project: "已转为项目" };

/** 谁改的（规格第 8 节"谁能改"表的四行） */
export const TASK_ACTORS = ["user", "secretary", "maintainer", "system"] as const;
export type TaskActor = (typeof TASK_ACTORS)[number];

export const TASK_ACTOR_LABEL: Readonly<Record<TaskActor, string>> = { user: "用户", secretary: "秘书", maintainer: "维护者", system: "系统" };

/**
 * 任务从哪条路发起：用户点"发起任务"按钮、用户点了秘书给的"建议发起任务"卡、用户在消息里要秘书去做（秘书直接建任务卡）。
 * 三条路发起的任务都由用户发起（秘书只是按用户的要求建卡）
 */
export const TASK_ORIGINS = ["button", "suggestion", "request"] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

/**
 * 任务看板事件里"这次是什么变化"。12 号票：建出、维护者提交计划、用户确认计划、用户打回计划，以及转为项目（15 号票用）；
 * 13 号票起往后加（开始执行、转等我、暂停、完成……）
 */
export const TASK_CHANGES = ["created", "plan_submitted", "plan_confirmed", "plan_rejected", "converted_to_project"] as const;
export type TaskChange = (typeof TASK_CHANGES)[number];

// ───────────────────────── 看板分组 ─────────────────────────

/** 看板的五组（规格第 8 节）：等我、进行中、运营中、最近结束、已归档 */
export const BOARD_GROUPS = ["waiting", "active", "ops", "ended", "archived"] as const;
export type BoardGroup = (typeof BOARD_GROUPS)[number];

export const BOARD_GROUP_LABEL: Readonly<Record<BoardGroup, { title: string; sub: string }>> = {
  waiting: { title: "等我", sub: "等我、待确认" },
  active: { title: "进行中", sub: "规划中、排队中、执行中、已暂停" },
  ops: { title: "运营中", sub: "简单提醒、定时作业" },
  ended: { title: "最近结束", sub: "已完成、失败、已取消" },
  archived: { title: "已归档", sub: "" },
};

/** 任务状态 → 看板分组（守护进程和 Web 只用这一份） */
export const BOARD_GROUP_OF_TASK_STATE: Readonly<Record<TaskState, BoardGroup>> = {
  waiting_for_user: "waiting",
  awaiting_confirm: "waiting",
  planning: "active",
  queued: "active",
  running: "active",
  paused: "active",
  done: "ended",
  failed: "ended",
  cancelled: "ended",
  archived: "archived",
};

/**
 * 简单提醒在看板上的分组：待触发的在"运营中"（显示"运营中 · 待触发"），已触发的一次性提醒在"最近结束"；
 * 已取消的不上看板（undefined）
 */
export function boardGroupOfReminder(status: ReminderStatus): BoardGroup | undefined {
  if (status === "pending") return "ops";
  if (status === "fired") return "ended";
  return undefined;
}

// ───────────────────────── 计划 ─────────────────────────

/** 验收方式：系统检查（脚本）、独立评审（评审子 agent）、由用户验收 */
export const ACCEPTANCE_METHODS = ["script", "review", "user"] as const;
export type AcceptanceMethod = (typeof ACCEPTANCE_METHODS)[number];

export const ACCEPTANCE_METHOD_LABEL: Readonly<Record<AcceptanceMethod, string>> = { script: "脚本", review: "评审", user: "用户" };

/** 阶段的模式：定步（附步骤）、开放 */
export const STAGE_MODES = ["steps", "open"] as const;
export type StageMode = (typeof STAGE_MODES)[number];

/** 阶段、阶段组、授权项、提问的 id 的写法：字母数字开头，字母数字、点、下划线、连字符 */
export const PLAN_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";
