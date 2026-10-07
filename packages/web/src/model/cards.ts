// 第一阶段 14 种卡片的负载形状（规格第 5 节）。
// 卡片类型注册表（schema、版本、纯文本降级）是 06 号票的事；本票先按规格写原型要显示的字段。
import type { RepeatRule, Toolkit } from "./types.ts";

export type CardType =
  | "plan"
  | "approval"
  | "questions"
  | "progress"
  | "quick_action"
  | "suggest_task"
  | "suggest_project"
  | "reminder"
  | "charter"
  | "work_order"
  | "plan_change"
  | "parallel"
  | "memory_delete"
  | "pairing";

export const CARD_TYPE_LABEL: Record<CardType, string> = {
  plan: "计划确认",
  approval: "审批",
  questions: "提问",
  progress: "进度",
  quick_action: "快速动作",
  suggest_task: "建议发起任务",
  suggest_project: "建议立项",
  reminder: "简单提醒",
  charter: "立项书",
  work_order: "工单",
  plan_change: "计划变更",
  parallel: "并行确认",
  memory_delete: "记忆删除",
  pairing: "配对请求",
};

/** 计划确认卡 */
export interface PlanPayload {
  task: string;
  goal: string;
  assumptions: string[];
  stages: {
    id: string;
    title: string;
    deliverable: string;
    acceptance: { text: string; method: "script" | "review" | "user" }[];
    mode: "steps" | "open";
    after: string[];
    budgetTokens: number;
  }[];
  /** 逐行列出的授权项；每行可勾掉或收窄 */
  grants: { id: string; stage: string; text: string; narrowTo?: string[] }[];
  /** 涉及的项目和每个项目的改动（确认后变成工单） */
  projects: { name: string; changes: string[] }[];
  toolkit: Toolkit;
  /** 全局要提醒的关注类别（默认带上，删不掉） */
  globalCategories: string[];
  /** 本任务可以再加的关注类别 */
  addableCategories: string[];
  /** 由对话里说的限制编译出的时序规则或授权收窄 */
  compiledRules: { text: string; from: string }[];
  /** 授权后还会在几处停下来 */
  stops: number;
  tokenEstimate: number;
}

/** 审批卡：守卫判定"先问我"的一次调用 */
export interface ApprovalPayload {
  task?: string;
  stage?: string;
  tool: string;
  argsSummary: string;
  categories: string[];
  reason: string;
}

/** 提问卡：成批问题，每题带推荐 */
export interface QuestionsPayload {
  intro: string;
  questions: { id: string; text: string; options: string[]; recommended: number }[];
}

/** 进度卡 */
export interface ProgressPayload {
  task: string;
  stage: string;
  done: string[];
  next: string;
  tokens: number;
}

/** 快速动作卡 */
export interface QuickActionPayload {
  action: string;
  target: string;
  detail?: string;
  /** 用户这一轮明确点了对象和内容：只展示规范化后的动作，不再确认 */
  explicit?: boolean;
}

/** "建议发起任务"卡 */
export interface SuggestTaskPayload {
  title: string;
  why: string;
}

/** "建议立项"卡：名字和一句话目标 */
export interface SuggestProjectPayload {
  name: string;
  goal: string;
}

/** 简单提醒卡 */
export interface ReminderPayload {
  text: string;
  time: string;
  repeat: RepeatRule;
}

/** 立项书卡 */
export interface CharterPayload {
  project: string;
  kind: "dev" | "other";
  goal: string;
  scope: string[];
  firstVersion: string;
  workdir: string;
  toolkit: Toolkit;
}

/** 工单卡（计划外的工单要你确认） */
export interface WorkOrderPayload {
  id: string;
  project: string;
  from: string;
  title: string;
  acceptance: string[];
}

/** 计划变更卡（含工具包变更） */
export interface PlanChangePayload {
  kind: "toolkit" | "grant" | "project" | "goal";
  task: string;
  summary: string;
  before: string;
  after: string;
  affectedStages: string[];
  reason: string;
}

/** 并行确认卡 */
export interface ParallelPayload {
  task: string;
  stage: string;
  subagents: { name: string; work: string }[];
  worktrees: boolean;
}

/** 记忆删除卡 */
export interface MemoryDeletePayload {
  command: string;
  matches: { id: string; text: string; at: string; source: string }[];
}

/** 配对请求卡 */
export interface PairingPayload {
  requestId: string;
  deviceName: string;
  shortCode: string;
  fingerprint: string;
  from: string;
  expiresAt: string;
}
