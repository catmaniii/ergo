// 第一阶段 14 种卡片的负载形状（规格第 5 节）。
// 卡片类型注册表（schema、版本、纯文本降级）在守护进程（cards/registry.ts）；登记了的卡，负载的 schema 在共享协议包里
// （06 号票：简单提醒卡 ReminderCardPayload；07 号票：审批卡 ApprovalCardPayload；10 号票：配对请求卡 PairingCardPayload；
// 12 号票：计划卡 PlanCardPayload、提问卡 QuestionsCardPayload、"建议发起任务"卡 SuggestTaskCardPayload；
// 21 号票：快速动作卡 QuickActionCardPayload、记忆删除卡 MemoryDeleteCardPayload；
// 15 号票："建议立项"卡 SuggestProjectCardPayload、立项书卡 CharterCardPayload；13 号票：进度卡 ProgressCardPayload；
// 112 号票："首版做完了"卡 BuildDoneCardPayload；130 号票："运营方案变更"卡 OperationsChangeCardPayload（"首版做完了"卡上多一节运营方案）；
// 20 号票：并行确认卡 ParallelCardPayload；17 号票：工单卡 WorkOrderCardPayload；19 号票：归档清单卡 ArchiveListCardPayload）。
// 其余的先按规格写原型要显示的字段，由各自的票登记时换成协议包里的。
import type {
  ApprovalCardPayload,
  BuildDoneCardPayload,
  Card,
  CardAction,
  CardType,
  CharterCardPayload,
  CharterChangeCardPayload,
  StandardBackfillCardPayload,
  StandardChangeCardPayload,
  GoLiveCardPayload,
  PairingCardPayload,
  ParallelCardPayload,
  PlanCardPayload,
  ProgressCardPayload,
  QuestionsCardPayload,
  RuntimeQuestionCardPayload,
  SuggestProjectCardPayload,
  SuggestTaskCardPayload,
  WorkOrderCardPayload,
} from "../state/index.ts";
import { t, tTable } from "../state/index.ts";

export const CARD_TYPE_LABEL: Readonly<Record<CardType, string>> = tTable({
  plan: "model.cards.type.plan",
  approval: "model.cards.type.approval",
  questions: "model.cards.type.questions",
  progress: "model.cards.type.progress",
  quick_action: "model.cards.type.quickAction",
  suggest_task: "model.cards.type.suggestTask",
  suggest_project: "model.cards.type.suggestProject",
  reminder: "model.cards.type.reminder",
  charter: "model.cards.type.charter",
  work_order: "model.cards.type.workOrder",
  plan_change: "model.cards.type.planChange",
  parallel: "model.cards.type.parallel",
  memory_delete: "model.cards.type.memoryDelete",
  pairing: "model.cards.type.pairing",
  toolkit_change: "model.cards.type.toolkitChange",
  mcp_change: "model.cards.type.mcpChange",
  workflow_plan: "model.cards.type.workflowPlan",
  archive_list: "model.cards.type.archiveList",
  build_done: "model.cards.type.buildDone",
  go_live: "model.cards.type.goLive",
  charter_change: "model.cards.type.charterChange",
  standard_change: "model.cards.type.standardChange",
  standard_backfill: "model.cards.type.standardBackfill",
  operations_change: "model.cards.type.operationsChange",
  service_entry: "model.cards.type.serviceEntry",
  browse_pick: "model.cards.type.browsePick",
  personal_file: "model.cards.type.personalFile",
  personal_file_suggest: "model.cards.type.personalFileSuggest",
  interview: "model.cards.type.interview",
  interview_files: "model.cards.type.interviewFiles",
  runtime_question: "model.cards.type.runtimeQuestion",
});

/** 卡片动作处理完以后显示的结果文字 */
export const CARD_ACTION_LABEL: Readonly<Record<CardAction, string>> = tTable({
  confirm: "model.cards.action.confirm",
  reject: "model.cards.action.reject",
  approve: "model.cards.action.approve",
  deny: "model.cards.action.deny",
  answer: "model.cards.action.answer",
  ack: "model.cards.action.ack",
  execute: "model.cards.action.execute",
  cancel: "model.cards.action.cancel",
  start_task: "model.cards.action.startTask",
  start_workflow: "model.cards.action.startWorkflow",
  kickoff: "model.cards.action.kickoff",
  dismiss: "model.cards.action.dismiss",
  save: "model.cards.action.save",
  cancel_reminder: "model.cards.action.cancelReminder",
  confirm_start: "model.cards.action.confirmStart",
  confirm_later: "model.cards.action.confirmLater",
  dispatch: "model.cards.action.dispatch",
  return: "model.cards.action.return",
  parallel: "model.cards.action.parallel",
  sequential: "model.cards.action.sequential",
  delete: "model.cards.action.delete",
  decide: "model.cards.action.decide",
  put_in_use: "model.cards.action.putInUse",
  keep_building: "model.cards.action.keepBuilding",
  abandon: "model.cards.action.abandon",
  start: "model.cards.action.start",
  later: "model.cards.action.later",
  decline: "model.cards.action.decline",
});

/** 卡片的处理结果写成一句话："已确认：勾掉 1 项授权"；系统让它作废的写作废的说明（84 号票：重做之后"已经重做过，这张卡作废了"） */
export function outcomeLabel(card: Card): string {
  if (!card.outcome) return card.status === "expired" ? (card.expiredNote ?? t("model.cards.expired")) : card.status === "dismissed" ? t("model.cards.dismissed") : "";
  const label = CARD_ACTION_LABEL[card.outcome.action];
  return card.outcome.note ? t("model.cards.outcomeWithNote", { label, note: card.outcome.note }) : label;
}

/** 计划确认卡（12 号票登记，负载的 schema 在共享协议包） */
export type PlanPayload = PlanCardPayload;

/** 审批卡：守卫判定"先问我"的一次调用（07 号票登记，负载的 schema 在共享协议包） */
export type ApprovalPayload = ApprovalCardPayload;

/** 提问卡：成批问题，每题带推荐（12 号票登记，负载的 schema 在共享协议包） */
export type QuestionsPayload = QuestionsCardPayload;

/** 运行时的提问卡：Claude Code 自己要问你的选择题、退出计划模式的批准（288 号票登记，负载的 schema 在共享协议包） */
export type RuntimeQuestionPayload = RuntimeQuestionCardPayload;

/** 进度卡（13 号票登记，负载的 schema 在共享协议包）：维护者报告进展，或者一个阶段的验收结论 */
export type ProgressPayload = ProgressCardPayload;

/** "建议发起任务"卡（12 号票登记，负载的 schema 在共享协议包） */
export type SuggestTaskPayload = SuggestTaskCardPayload;

/** "建议立项"卡：名字和一句话目标，立项后带上项目编号（15 号票登记，负载的 schema 在共享协议包） */
export type SuggestProjectPayload = SuggestProjectCardPayload;

/** 立项书卡：立项书（含项目类型、外部工作目录绑定）和提议的工具包（15 号票登记，负载的 schema 在共享协议包） */
export type CharterPayload = CharterCardPayload;

/** 立项要求变更卡：立项书确认之后改目标、范围、首版，逐条对照新旧、附核实过的你的原话（125 号票登记，负载的 schema 在共享协议包） */
export type CharterChangePayload = CharterChangeCardPayload;

/** 规范改写卡：本项目的规范改写、跟新版规范，逐处对照、附核实过的你的原话（261 号票登记，负载的 schema 在共享协议包） */
export type StandardChangePayload = StandardChangeCardPayload;

/** 补齐规范文档卡：规范上线之前建的项目缺哪几份，你选补齐才建任务交给维护者补（262 号票登记，负载的 schema 在共享协议包） */
export type StandardBackfillPayload = StandardBackfillCardPayload;

/** "首版做完了"卡：项目的建设任务做完了，做成了什么、你选转入使用 / 继续建设 / 放弃并归档（112 号票登记，负载的 schema 在共享协议包） */
export type BuildDonePayload = BuildDoneCardPayload;
/** "转入使用"确认卡（259 号票） */
export type GoLivePayload = GoLiveCardPayload;

/** 工单卡：计划外的工单要你确认（17 号票登记，负载的 schema 在共享协议包） */
export type WorkOrderPayload = WorkOrderCardPayload;

/** 并行确认卡：维护者提议派子 agent 同时做的几个阶段（或几步），各做什么、在哪个目录里做（20 号票登记，负载的 schema 在共享协议包） */
export type ParallelPayload = ParallelCardPayload;

/** 配对请求卡（schema 在共享协议包） */
export type PairingPayload = PairingCardPayload;
