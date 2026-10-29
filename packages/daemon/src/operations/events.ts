// 运营方案（130 号票）在事件日志里的事件：守护进程内部的 operations 频道（前端不订阅；前端看到的是"首版做完了"卡上的那一节、
// "运营方案变更"卡和项目上现在生效的运营方案 Project.operations）。
// - operations_proposed：维护者交了一份运营方案（逐条校验过的每一条、流程那几条审查修补后推出的执行用的计划、引用的用户原话）。
//   建设期间交的（mode: build）等建设任务做完出现在"首版做完了"卡上（卡已经出了就同一事务更新卡）；使用中、已停用的项目交的
//   （mode: change）同一事务出"运营方案变更"卡；
// - operations_decided：用户在卡上确认、拒绝了（和卡片更新同一事务）。确认的同一事务里每一条生效（建成项目的内部任务……），项目上
//   现在生效的运营方案跟着换（项目列表频道的 project 事件：转入使用的那一条、或者 operations_changed）。"审批决定"素材的来源。
import { EVENT_TYPES, type OperationItem, type OperationResult, type Plan, type VerifiedUserWords } from "@ergo/protocol";

export const OPERATIONS_CHANNEL = "operations";

export const OPERATIONS_EVENTS = {
  proposed: "operations_proposed",
  decided: EVENT_TYPES.operationsDecided,
} as const;

/** 维护者交的一份运营方案 */
export interface OperationsProposedPayload {
  projectId: string;
  /** 这个项目的第几份（交上来就算，被拒的、被新的一份顶掉的也占号） */
  revision: number;
  /** 建设期间交的（出现在"首版做完了"卡上）、使用中或已停用时交的（出"运营方案变更"卡） */
  mode: "build" | "change";
  maintainerId: string;
  why: string;
  items: OperationItem[];
  /** 流程的那几条：审查修补后推出的、执行用的计划（这一条的 key → 计划），确认时建成它的内部流程 */
  executions: Record<string, Plan>;
  userWords: VerifiedUserWords[];
  /** 使用中交的：它的"运营方案变更"卡 */
  cardId?: string;
  time: string;
}

/** 用户在卡上确认（confirmed）或拒绝了一份运营方案 */
export interface OperationsDecidedPayload {
  projectId: string;
  projectName: string;
  revision: number;
  /** 在"首版做完了"卡（build_done）、"转入使用"确认卡（go_live，259 号票）上确认并转入使用的，还是"运营方案变更"卡上的（change） */
  via: "build_done" | "go_live" | "change";
  cardId: string;
  confirmed: boolean;
  /** 确认的：每一条的结局（建成的内部任务、没生效的原因……）；拒绝的是空的 */
  results: OperationResult[];
  /** 方案里每一条一句（素材里的说法）："日报（每天 08:00，普通任务）、……" */
  summary: string;
  /** 用户在卡上写的话 */
  note?: string;
  by: "user";
  time: string;
}
