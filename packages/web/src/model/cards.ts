// 第一阶段 14 种卡片的负载形状。
// 卡片类型注册表（schema、版本、纯文本降级）在守护进程（cards/registry.ts）；登记了的卡，负载的 schema 在共享协议包里
// （简单提醒卡 ReminderCardPayload；审批卡 ApprovalCardPayload；配对请求卡 PairingCardPayload；
// 计划卡 PlanCardPayload、提问卡 QuestionsCardPayload、"建议发起任务"卡 SuggestTaskCardPayload；
// 快速动作卡 QuickActionCardPayload、记忆删除卡 MemoryDeleteCardPayload；
// "建议立项"卡 SuggestProjectCardPayload、立项书卡 CharterCardPayload；进度卡 ProgressCardPayload；
// "首版做完了"卡 BuildDoneCardPayload；"运营方案变更"卡 OperationsChangeCardPayload（"首版做完了"卡上多一节运营方案）；
// 并行确认卡 ParallelCardPayload；工单卡 WorkOrderCardPayload；归档清单卡 ArchiveListCardPayload）。
// 其余的先写原型要显示的字段，由各自的模块登记时换成协议包里的。
import type {
  ApprovalCardPayload,
  BuildDoneCardPayload,
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

// 卡片种类、处理结果的说法放在状态层（对话里收成一行的卡片要用），这里转出去，界面照旧从这里取
export { CARD_ACTION_LABEL, CARD_TYPE_LABEL, outcomeLabel } from "../state/index.ts";

/** 计划确认卡（负载的 schema 在共享协议包） */
export type PlanPayload = PlanCardPayload;

/** 审批卡：守卫判定"先问我"的一次调用（负载的 schema 在共享协议包） */
export type ApprovalPayload = ApprovalCardPayload;

/** 提问卡：成批问题，每题带推荐（负载的 schema 在共享协议包） */
export type QuestionsPayload = QuestionsCardPayload;

/** 运行时的提问卡：Claude Code 自己要问你的选择题、退出计划模式的批准（负载的 schema 在共享协议包） */
export type RuntimeQuestionPayload = RuntimeQuestionCardPayload;

/** 进度卡（负载的 schema 在共享协议包）：负责人报告进展，或者一个阶段的验收结论 */
export type ProgressPayload = ProgressCardPayload;

/** "建议发起任务"卡（负载的 schema 在共享协议包） */
export type SuggestTaskPayload = SuggestTaskCardPayload;

/** "建议立项"卡：名字和一句话目标，立项后带上项目编号（负载的 schema 在共享协议包） */
export type SuggestProjectPayload = SuggestProjectCardPayload;

/** 立项书卡：立项书（含项目类型、外部工作目录绑定）和提议的工具包（负载的 schema 在共享协议包） */
export type CharterPayload = CharterCardPayload;

/** 立项要求变更卡：立项书确认之后改目标、范围、首版，逐条对照新旧、附核实过的你的原话（负载的 schema 在共享协议包） */
export type CharterChangePayload = CharterChangeCardPayload;

/** 规范改写卡：本项目的规范改写、跟新版规范，逐处对照、附核实过的你的原话（负载的 schema 在共享协议包） */
export type StandardChangePayload = StandardChangeCardPayload;

/** 补齐规范文档卡：规范上线之前建的项目缺哪几份，你选补齐才建任务交给负责人补（负载的 schema 在共享协议包） */
export type StandardBackfillPayload = StandardBackfillCardPayload;

/** "首版做完了"卡：项目的建设任务做完了，做成了什么、你选转入使用 / 继续建设 / 放弃并归档（负载的 schema 在共享协议包） */
export type BuildDonePayload = BuildDoneCardPayload;
/** "转入使用"确认卡 */
export type GoLivePayload = GoLiveCardPayload;

/** 工单卡：计划外的工单要你确认（负载的 schema 在共享协议包） */
export type WorkOrderPayload = WorkOrderCardPayload;

/** 并行确认卡：负责人提议派子 agent 同时做的几个阶段（或几步），各做什么、在哪个目录里做（负载的 schema 在共享协议包） */
export type ParallelPayload = ParallelCardPayload;

/** 配对请求卡（schema 在共享协议包） */
export type PairingPayload = PairingCardPayload;
