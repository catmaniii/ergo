// 页面用的领域形状：任务看板、项目、待我处理、设置。
// 这些频道和事件的正式形状由各自的票定（看板 12、项目 15/16、设置 10/21/26/27/29），
// 本票按规格先写一份给原型用；接真数据时换成共享协议包里的类型（待我处理事项 06 号票起用协议包的 InboxItem）。
import type { Disposition, ReminderSchedule } from "../state/index.ts";

/** 任务状态（规格第 8 节） */
export type TaskStatus =
  | "planning"
  | "awaiting_confirm"
  | "queued"
  | "running"
  | "waiting_for_user"
  | "paused"
  | "done"
  | "failed"
  | "cancelled"
  | "archived";

/** 任务转"等我"的原因 */
export type WaitReason = "approval" | "clarification" | "acceptance" | "stuck" | "over_budget" | "interrupted";

/** agent 的活动状态：休眠、干活中、等你、排队 */
export type ActivityState = "sleeping" | "working" | "waiting_for_user" | "queued";

/** 看板上的一张卡：任务、简单提醒或定时作业 */
export type BoardEntry = TaskSummary | ReminderSummary | ScheduledJobSummary;

export interface TaskSummary {
  kind: "task";
  id: string;
  title: string;
  status: TaskStatus;
  waitReason?: WaitReason;
  /** 第 N/M 阶段；还没有计划时没有 */
  stage?: { current: number; total: number };
  activity: ActivityState;
  /** 活动状态的补充（"干活中：跑测试"、"排队：等项目「记账本」"） */
  activityNote?: string;
  /** token 总量（看板上的 token 总量在 24 号票接真数据；真任务还没有这一项） */
  tokens?: number;
  projects: string[];
  updatedAt: string;
  /** 已完成时的补充，比如"已转为项目" */
  endNote?: string;
}

export interface ReminderSummary {
  kind: "reminder";
  id: string;
  title: string;
  /** 一次性：待触发 → 已触发；重复的：一直待触发 */
  status: "pending" | "fired";
  nextAt: string;
  schedule: ReminderSchedule;
}

export interface ScheduledJobSummary {
  kind: "scheduled_job";
  id: string;
  title: string;
  status: "active" | "paused";
  schedule: string;
  project?: string;
  lastRun?: { at: string; ok: boolean };
  /** 连续失败 3 次被自动暂停 */
  autoPaused?: boolean;
}

/** 项目状态（规格第 11 节） */
export type ProjectStatus = "preparing" | "building" | "in_use" | "retired" | "archived";

export interface ProjectSummary {
  id: string;
  name: string;
  goal: string;
  status: ProjectStatus;
  activity: ActivityState;
  activityNote?: string;
  /** 进行中的任务数 */
  activeTasks: number;
  /** 立项书已确认（筹备中时才有意义） */
  charterConfirmed?: boolean;
  /** 归档前的状态：取消归档时回到它 */
  archivedFrom?: ProjectStatus;
}

/** 工单（规格第 12 节） */
export interface WorkOrder {
  id: string;
  title: string;
  project: string;
  from: string;
  status: "waiting_for_user" | "queued" | "in_progress" | "clarifying" | "done" | "returned" | "unable";
  updatedAt: string;
}

/** 范围记录：范围变更或越界 */
export interface ScopeRecord {
  id: string;
  kind: "change" | "overreach";
  text: string;
  at: string;
  workOrder?: string;
}

/** 工具包：skill、MCP、bash 开关、联网开关 */
export interface Toolkit {
  skills: string[];
  mcps: string[];
  bash: boolean;
  network: boolean;
}

/** 阶段（规格第 8 节"计划"） */
export interface Stage {
  id: string;
  title: string;
  status: "pending" | "running" | "waiting" | "accepted" | "failed" | "stopped";
  deliverable: string;
  acceptance: { text: string; method: "script" | "review" | "user"; result?: "pass" | "fail" }[];
  mode: "steps" | "open";
  after: string[];
  grants: string[];
  rules: string[];
  budget: { tokens: number; usedTokens: number; toolCalls: number; usedToolCalls: number };
  group?: string;
  incident?: boolean;
}

/** 归档清单（通知类事项"归档清单"的 data）：每一项可选归档、继续改（返工）、先留着 */
export interface ArchiveListData {
  archiveList: { task: string; endedAt: string; choice?: "archive" | "rework" | "keep" }[];
}

/** 关注类别 */
export interface WatchCategory {
  id: string;
  name: string;
  builtin: boolean;
  /** 对话里、任务里的处置；对话里不适用时为 undefined（比如计划外工单） */
  chat?: Disposition;
  task: Disposition;
  /** 内置类别的默认值：只能往严里调 */
  defaults?: { chat?: Disposition; task: Disposition };
  /** 用户自定义类别的确定规则 */
  rule?: { kind: "tool" | "path" | "recipient" | "amount"; value: string };
}

/** skill 库里的一项 */
export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  origin: "framework" | "imported";
  /** 被哪些项目或任务的工具包用到 */
  usedBy: string[];
}

/** token 用量（消耗页） */
export interface UsageRecord {
  day: string;
  agent: string;
  /** 秘书单列为系统开销 */
  system?: boolean;
  inputCached: number;
  inputUncached: number;
  output: number;
}
