// 项目模块在事件日志里的事件（规格第 4、11 节）。
// - 项目列表频道（projects，前端订阅）：project 事件 = 项目的最新状态 + 这次的变化 + 谁改的（负载 ProjectEventPayload 在共享协议包）；
// - 守护进程内部的 charters 频道（前端不订阅）：维护者交出的立项书、用户在立项书卡上的确认，125 号票起还有立项要求变更的提出和
//   用户的确认、拒绝。立项书是业务状态，存在这里，不在 pi 会话里（项目档案里的 charter.md 是它的投影）；前端看到的是立项书卡、
//   立项要求变更卡（由代码从结构化的立项书生成）。
// - 守护进程内部的 standards 频道（前端不订阅，261 号票）：本项目的规范改写的提出和用户的确认、拒绝（见文件末尾）；262 号票起还有规范上线的那一条
//   （补齐规范文档的卡给哪几个项目出）。
import { type Charter, type CharterChangeItem, EVENT_TYPES, type PlanToolkit, type StandardChangeItem, type StandardUpgrade, type VerifiedUserWords } from "@ergo/protocol";

export const CHARTERS_CHANNEL = "charters";

export const CHARTER_EVENTS = {
  /** 维护者交出了一版立项书（同一事务建立项书卡、放进待我处理、旧的那张过期） */
  submitted: "charter_submitted",
  /** 用户在立项书卡上确认（和卡片更新同一事务）；"用户对产出的反应"素材的来源，事件类型登记在共享协议包 */
  decided: EVENT_TYPES.charterDecided,
  /** 立项书确认之后维护者提了立项要求变更（125 号票，同一事务出"立项要求变更"卡、放进待我处理） */
  changeProposed: "charter_change_proposed",
  /** 用户在"立项要求变更"卡上确认或拒绝（和卡片更新同一事务）；确认的立项书改写，"审批决定"素材的来源 */
  changeDecided: EVENT_TYPES.charterChangeDecided,
} as const;

export interface CharterSubmittedPayload {
  projectId: string;
  /** 第几版立项书 */
  revision: number;
  charter: Charter;
  /** 维护者提议的工具包（开发类默认带 bash，已补上） */
  toolkit: PlanToolkit;
  cardId: string;
  maintainerId: string;
  time: string;
}

export interface CharterDecidedPayload {
  projectId: string;
  projectName: string;
  revision: number;
  cardId: string;
  /** 确认并开工（start），还是只确认、稍后开工（later） */
  decision: "start" | "later";
  charter: Charter;
  toolkit: PlanToolkit;
  /** 开工时建出的首个建设任务 */
  buildTaskId?: string;
  /** 用户确认时附的说明（用户自己的话） */
  note?: string;
  by: "user";
  time: string;
}

/** 维护者提的立项要求变更（125 号票）：改之前、改之后的整份立项书，逐条的改动，引用、运行时核实过的用户原话 */
export interface CharterChangeProposedPayload {
  projectId: string;
  /** 这个项目的第几次立项要求变更 */
  revision: number;
  cardId: string;
  maintainerId: string;
  why: string;
  before: Charter;
  after: Charter;
  changes: CharterChangeItem[];
  userWords: VerifiedUserWords[];
  time: string;
}

/** 用户在"立项要求变更"卡上确认（confirmed）或拒绝：确认的从此立项书是 after，拒绝的不变 */
export interface CharterChangeDecidedPayload {
  projectId: string;
  projectName: string;
  revision: number;
  cardId: string;
  confirmed: boolean;
  why: string;
  before: Charter;
  after: Charter;
  changes: CharterChangeItem[];
  userWords: VerifiedUserWords[];
  /** 提出的时间 */
  proposedAt: string;
  /** 用户在卡上写的话 */
  note?: string;
  by: "user";
  time: string;
}

// ───────────────────────── 本项目的规范改写（261 号票） ─────────────────────────
// 守护进程内部的 standards 频道（前端不订阅）：维护者提的规范改写（不要某一份、某一份换写法、多一份、恢复照默认、跟新版规范）和用户在
// "规范改写"卡上的确认、拒绝。本项目的规范改写是要用户确认的业务状态，存在这里（项目档案里的 standard-overrides.md 是它的投影，维护者
// 改了不算数）；跟新版规范的，项目上记着的版本（Project.standardVersion）在确认的同一事务里由 standard_changed 的 project 事件换掉。

export const STANDARDS_CHANNEL = "standards";

export const STANDARD_EVENTS = {
  /** 维护者提了规范改写（同一事务出"规范改写"卡、放进待我处理） */
  changeProposed: "standard_change_proposed",
  /** 用户在"规范改写"卡上确认或拒绝（和卡片更新同一事务）；确认的改写生效，"审批决定"素材的来源 */
  changeDecided: EVENT_TYPES.standardChangeDecided,
  /**
   * 规范上线了（262 号票）：守护进程第一次带着补齐规范文档这一版起来时记一次（只记一次），写明那时规范上线之前建的项目（没有版本的）。
   * 补齐规范文档的卡只给这几个项目出（之后建的项目都有版本）
   */
  backfillLaunched: "standard_backfill_launched",
} as const;

/** 维护者提的规范改写：逐处的变化（同一份改写前后）、跟新版规范，引用、运行时核实过的用户原话 */
export interface StandardChangeProposedPayload {
  projectId: string;
  /** 这个项目的第几次规范改写 */
  revision: number;
  cardId: string;
  maintainerId: string;
  why: string;
  items: StandardChangeItem[];
  upgrade?: StandardUpgrade;
  userWords: VerifiedUserWords[];
  time: string;
}

/** 用户在"规范改写"卡上确认（confirmed）或拒绝：确认的从此按改过的规范算，拒绝的不变 */
export interface StandardChangeDecidedPayload {
  projectId: string;
  projectName: string;
  revision: number;
  cardId: string;
  confirmed: boolean;
  why: string;
  items: StandardChangeItem[];
  upgrade?: StandardUpgrade;
  userWords: VerifiedUserWords[];
  /** 提出的时间 */
  proposedAt: string;
  /** 用户在卡上写的话 */
  note?: string;
  by: "user";
  time: string;
}

/** 规范上线了（262 号票）：那时规范上线之前建的项目（没有版本、没删掉的），按项目列表的先后；那时框架里最新的规范版本 */
export interface StandardBackfillLaunchedPayload {
  projects: string[];
  version: string;
  time: string;
}
