// 页面用的领域形状：任务看板、项目、待我处理、设置。
// 这些频道和事件的正式形状由各自的票定（看板 12、项目 15/16、设置 10/21/26/27/29），
// 本票按规格先写一份给原型用；接真数据时换成共享协议包里的类型（待我处理事项 06 号票起用协议包的 InboxItem）。
import type { ReminderSchedule, ScheduledJobAction, TaskKind, TaskWaitReason } from "../state/index.ts";

/** 任务状态（规格第 8 节） */
export type TaskStatus =
  | "planning"
  | "awaiting_confirm"
  | "scheduled"
  | "queued"
  | "running"
  | "waiting_for_user"
  | "paused"
  | "operating"
  | "done"
  | "failed"
  | "cancelled"
  | "archived";

/** 任务转"等我"的原因 */
/** 等我的原因（13 号票起取自共享协议包）：审批、交给我做、由我验收、卡住求助、澄清、超预算、中断不确定 */
export type WaitReason = TaskWaitReason;

/** agent 的活动状态：休眠、干活中、等你、排队 */
export type ActivityState = "sleeping" | "working" | "waiting_for_user" | "queued";

/** 看板上的一张卡：任务、简单提醒或定时作业 */
export type BoardEntry = TaskSummary | ReminderSummary | ScheduledJobSummary;

export interface TaskSummary {
  kind: "task";
  id: string;
  title: string;
  status: TaskStatus;
  /** 任务的种类（58 号票）：流程或长程任务；原型的假条目没有，按长程任务 */
  taskKind?: TaskKind;
  waitReason?: WaitReason;
  /** 等我的原因说明：卡住求助写的原因、被杀后的"中断：不确定 X 是否已执行"（23 号票） */
  waitNote?: string;
  /** 第 N/M 阶段；还没有计划时没有（流程没有阶段，看 steps） */
  stage?: { current: number; total: number };
  /** 流程（58 号票）：做完（含跳过）几步、共几步；还没有计划时没有 */
  steps?: { done: number; total: number };
  activity: ActivityState;
  /** 活动状态的补充（"干活中：跑测试"、"排队：等项目「记账本」"） */
  activityNote?: string;
  /** token 总量（24 号票起来自账本：看板频道上这个任务的 token_totals） */
  tokens?: number;
  projects: string[];
  updatedAt: string;
  /** 已完成时的补充，比如"已转为项目" */
  endNote?: string;
  /** 真任务的状态写法（状态层的 taskStatusText：写明等我、系统暂停的原因）；原型的假条目没有，按上面几项拼 */
  statusLine?: string;
  /** 定时触发的任务（76 号票）：它的触发登记（状态、时间表、下一次、最近一次运行、能做的动作） */
  trigger?: {
    jobId: string;
    /** 触发登记在运营（没暂停） */
    active: boolean;
    statusLine: string;
    schedule: string;
    nextAt?: string;
    lastRun?: { text: string; ok: boolean };
    actions: ScheduledJobAction[];
  };
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
  /** 作业名下的 token 总量（24 号票：看板频道上作业的 token_totals） */
  tokens?: number;
  /** 真作业（19 号票）的状态写法（状态层的 scheduledJobStatusText：写明暂停的原因）；原型的假条目没有 */
  statusLine?: string;
  /** 真作业下一次什么时候运行（已暂停的没有） */
  nextAt?: string;
  /** 真作业现在能做的动作（暂停、恢复、取消）；原型的假条目没有 */
  actions?: ScheduledJobAction[];
  /** 真作业每次运行的授权（授权项、时序规则各一行一条）；原型的假条目没有 */
  authorization?: { grants: string[]; rules: string[] };
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
  status: "pending" | "running" | "accepting" | "waiting" | "accepted" | "failed" | "stopped";
  deliverable: string;
  acceptance: { text: string; method: "script" | "review" | "user"; result?: "pass" | "fail"; note?: string }[];
  mode: "steps" | "open";
  after: string[];
  grants: string[];
  rules: string[];
  /** 预算；用了多少 token（usedTokens）24 号票起来自账本，工具调用次数（usedToolCalls）在 14 号票 */
  budget: { tokens: number; usedTokens?: number; toolCalls: number; usedToolCalls?: number };
  /** 宣布过几次完成（真任务才有） */
  attempts?: number;
  /** 在等用户的原因（真任务才有） */
  waitReason?: WaitReason;
  /** 为什么停下（真任务才有，14 号票：阈值、做不了、超预算、计划变更） */
  waitNote?: string;
  group?: string;
  incident?: boolean;
}

/** 归档清单（通知类事项"归档清单"的 data）：每一项可选归档、继续改（返工）、先留着 */
export interface ArchiveListData {
  archiveList: { task: string; endedAt: string; choice?: "archive" | "rework" | "keep" }[];
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
