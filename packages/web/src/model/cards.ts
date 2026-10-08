// 第一阶段 14 种卡片的负载形状（规格第 5 节）。
// 卡片类型注册表（schema、版本、纯文本降级）在守护进程（cards/registry.ts）；登记了的卡，负载的 schema 在共享协议包里
// （06 号票：简单提醒卡 ReminderCardPayload；07 号票：审批卡 ApprovalCardPayload；10 号票：配对请求卡 PairingCardPayload；
// 12 号票：计划卡 PlanCardPayload、提问卡 QuestionsCardPayload、"建议发起任务"卡 SuggestTaskCardPayload；
// 21 号票：快速动作卡 QuickActionCardPayload、记忆删除卡 MemoryDeleteCardPayload；
// 15 号票："建议立项"卡 SuggestProjectCardPayload、立项书卡 CharterCardPayload）。
// 其余的先按规格写原型要显示的字段，由各自的票登记时换成协议包里的。
import type {
  ApprovalCardPayload,
  Card,
  CardAction,
  CardType,
  CharterCardPayload,
  PairingCardPayload,
  PlanCardPayload,
  QuestionsCardPayload,
  SuggestProjectCardPayload,
  SuggestTaskCardPayload,
} from "../state/index.ts";

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

/** 卡片动作处理完以后显示的结果文字 */
export const CARD_ACTION_LABEL: Record<CardAction, string> = {
  confirm: "已确认",
  reject: "已打回",
  approve: "已批准",
  deny: "已拒绝",
  answer: "已回答",
  ack: "知道了",
  execute: "已执行",
  cancel: "已取消",
  start_task: "已发起任务",
  kickoff: "已立项",
  dismiss: "不用了",
  save: "已保存",
  cancel_reminder: "提醒已取消",
  confirm_start: "已确认并开工",
  confirm_later: "已确认，稍后开工",
  dispatch: "已确认派出",
  return: "已退回",
  parallel: "同意并行",
  sequential: "不并行，按顺序做",
  delete: "已删除",
};

/** 卡片的处理结果写成一句话："已确认：勾掉 1 项授权" */
export function outcomeLabel(card: Card): string {
  if (!card.outcome) return card.status === "expired" ? "已过期" : card.status === "dismissed" ? "已关闭" : "";
  const label = CARD_ACTION_LABEL[card.outcome.action];
  return card.outcome.note ? `${label}：${card.outcome.note}` : label;
}

/** 计划确认卡（12 号票登记，负载的 schema 在共享协议包） */
export type PlanPayload = PlanCardPayload;

/** 审批卡：守卫判定"先问我"的一次调用（07 号票登记，负载的 schema 在共享协议包） */
export type ApprovalPayload = ApprovalCardPayload;

/** 提问卡：成批问题，每题带推荐（12 号票登记，负载的 schema 在共享协议包） */
export type QuestionsPayload = QuestionsCardPayload;

/** 进度卡 */
export interface ProgressPayload {
  task: string;
  stage: string;
  done: string[];
  next: string;
  tokens: number;
}

/** "建议发起任务"卡（12 号票登记，负载的 schema 在共享协议包） */
export type SuggestTaskPayload = SuggestTaskCardPayload;

/** "建议立项"卡：名字和一句话目标，立项后带上项目编号（15 号票登记，负载的 schema 在共享协议包） */
export type SuggestProjectPayload = SuggestProjectCardPayload;

/** 立项书卡：立项书（含项目类型、外部工作目录绑定）和提议的工具包（15 号票登记，负载的 schema 在共享协议包） */
export type CharterPayload = CharterCardPayload;

/** 工单卡（计划外的工单要你确认） */
export interface WorkOrderPayload {
  id: string;
  project: string;
  from: string;
  title: string;
  acceptance: string[];
}

/**
 * 计划变更的种类：扩大授权、加能力、加项目、改目标或验收（规格第 8 节）；
 * 工具包变更是计划变更的一种，只用于维护者不在任务里时要加能力（规格第 21 节）。
 */
export type PlanChangeKind = "grant" | "capability" | "project" | "goal" | "toolkit";

export const PLAN_CHANGE_KIND_LABEL: Record<PlanChangeKind, string> = {
  grant: "扩大授权",
  capability: "加能力",
  project: "加项目",
  goal: "改目标或验收",
  toolkit: "工具包变更",
};

/** 计划变更卡（含工具包变更） */
export interface PlanChangePayload {
  kind: PlanChangeKind;
  /** 计划变更属于哪个任务；工具包变更没有任务，写项目 */
  scope: string;
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

/** 配对请求卡（schema 在共享协议包） */
export type PairingPayload = PairingCardPayload;
