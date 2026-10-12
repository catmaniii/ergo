// 任务执行（规格第 8 节"阶段执行""验收""并发""状态补充"，13 号票）：确认过的任务从排队到完成的控制器。
//
// 执行状态都在任务里（Task.stages.list，每次变化是看板频道上的一条 task 事件），不在 pi 会话里：
// - 全局执行名额（默认 3 个，配置 tasks.maxRunning；和定时作业开始了的运行共用，谁占着在 slots.ts 里数）：名额空出时排在最前的排队中任务开始执行（排队中 → 执行中，系统）；
//   等我、已暂停的不占名额；要恢复执行（继续、一支不用再等了、重试、返工）而名额满了就回到排队中（变化记成 requeued）；
// - 阶段：控制器保管当前阶段（stages.ts 的纯函数）。第一次进入执行中（排队中开始，或者排队时暂停、没开始过就继续了）
//   建好各阶段，开始第一个能开始的阶段；一个阶段验收通过之后，自动开始下一个能开始的阶段；
//   维护者也可以用 start_stage 换去做另一个能开始的阶段（前置阶段没验收的不能开始）；
// - 某一支在等用户（审批挂起、"交给我做"、由我验收）：这一支停下，不依赖它的阶段接着推进，任务仍是执行中、占名额；
//   所有能推进的分支都在等用户时，任务才转等我（写明原因）；用户处理了（批准或拒绝、点"已完成"、验收）这一支接着走，
//   任务在等我的就恢复执行。挂起的审批批准了、可维护者正在做别的阶段时，通知它先切回那个阶段再重试
//   （授权和调用指纹都按阶段，在别的阶段里重试会再问用户）；
// - 验收：维护者调用"宣布阶段完成"（complete_stage）后，脚本方式的标准在工作目录里跑（看退出码和计划里写的期望输出），
//   评审方式的派评审子 agent，都过了还有"由你验收"的就放进待我处理等用户；不通过的把结果交回维护者，阶段不推进；
//   全部阶段验收通过，任务自动完成，叫"任务完成后"的回调（onCompleted；转为项目结束的不叫）；
// - 维护者"报告进展"（进度卡）、"转为等我"（卡住求助，写明原因）、"失败"（必须写原因，待我处理里出"失败后的抉择"）；
// - 用户的控制（task_action）：能不能做看共享协议包的 availableTaskActions（"谁能改"表推出），暂停、继续、取消、失败后重试、
//   从某个阶段重做（返工：按依赖重开指定阶段和全部下游；84 号票起阶段开始过就能，先停稳维护者手头这一轮再重置，卡着的验收、
//   审批、计划变更随之作废，这几个阶段这一轮已经做了的事从效果日志里列出来告诉维护者、不撤回，会话里一条重做记录）、
//   由我验收的验收通过或退回；
//   待我处理里通知的动作走同样的函数。
// - 并行（20 号票）：维护者提议派子 agent 做的阶段先过 checkParallel（任务在执行、阶段在做或能开始、没有子 agent 在做），
//   用户在并行确认卡上同意时，没开始的那几个阶段随卡片更新一起开始（parallelStartEvents），几个阶段同时在做；
//   维护者的当前阶段（守卫看到的、重注入块和看板上的）是它最后一次开始的阶段（任务里的 stages.focus：维护者 start_stage 的、
//   运行时替它开始的，交给子 agent 的不算；stages.ts 的 currentStage），不按计划里的顺序取；
//   有子 agent 在做的阶段（subAgentsOn）维护者不能宣布完成、不能切过去（等结果回来），子 agent 交回结果后维护者用 start_stage 切过去；
//   维护者手头空着（在做的只剩子 agent 的）时，看下一步替它开始一个能开始的阶段（nextStep 的 busy）。
// - 流程（58 号票）：确认的流程计划推出一份只有一个阶段（WORKFLOW_STAGE_ID）的计划（workflow-plan.ts），排队、名额、暂停、
//   审批挂起、催促都照上面走；开始执行时建好各步的状态（Task.steps.list），交给维护者"按计划执行"的说明（含审查修补后的步骤）；
//   维护者用 report_step 自报每一步（reportStep），步骤都做完或说明跳过时这个阶段算完成、流程完成（不逐步验收）。
//   重注入块是流程的那一种（workflow-texts.ts）。执行时和计划逐步比对是 59 号票。
// - 普通任务（75 号票，plain.ts）：没有计划、阶段，排队和名额照上面走（项目内部的同样等项目的维护者空着、派执行的工单）；
//   第一次开始时交给 agent 任务书（用户或助理交代的那段话）；agent 这一轮正常结束、手上没有这个任务的别的输入了就自动完成，
//   助理收到一句结果在对话里转告；出错、被打断的一轮转等我（卡住求助），用户回一句就接着做；做完之后用户接着说
//   （或者运行时交给它一条通知），任务回到执行中（continued）。守卫看不到它（guardTask 是 null）：按普通对话那一套判。
// - 被杀后的恢复（23 号票）：一次有副作用的调用被中断、说不清做没做完（守卫接入记的 tool_call_interrupted）时任务转等我
//   （"中断：不确定 X 是否已执行"），用户在待我处理里说了做没做、或者在任务详情里点"继续"、回话之后接着执行。
// 14 号票（偏离、阈值与计划变更；阈值见 thresholds.ts，无进展的计时在 stall.ts，授权项续期在 grant-renewal.ts，
// 计划的比较在 plan-change.ts）：
// - 阈值：拉回（守卫的 pulled_back）满 3 次后再犯、同一次停滞里催满 3 次仍无进展、验收退回 2 次第 3 次还不过——
//   这一支停下找用户（卡住求助，待我处理里一条事项）；每个阶段按 token（账本里这个阶段干活用掉的）加工具调用次数累计用量，
//   用量超过预算让维护者说明进展，超过预算的 2 倍这一支停下（超预算）。都按 13 号票的规矩落地：别的分支还能推进就只停这一支，
//   都在等才转等我。用户点"继续执行""追加预算继续"（或在卡住求助的任务会话里回话）时这一支接着走，计数清零、预算重给一整份；
// - 无进展：维护者活着、任务在执行中、维护者的当前阶段（20 号票的 focus，不算交给子 agent 的）在做，stallMs（默认 20 分钟）内
//   没有成功的工具调用（效果日志，子 agent 的也算）也没有阶段推进，催一次（维护者正在干活时以插话送达）；有了进展，催促计数清零；
// - 同一任务累计被用户拒绝 5 次（审批、计划变更）：整个任务转已暂停（系统，写明原因）；
// - 计划变更（维护者要扩大授权、加能力、加项目、改目标或验收标准）：出计划变更卡、进待我处理，只有受影响的阶段停下等确认，
//   其余阶段照常推进；同一任务一次只有一张在等。确认后计划和授权项随之更新（新的一版计划，授权项的有效期原样留着的照旧），
//   改了目标或任务的验收标准的任务书也换成新的一版，受影响的阶段恢复，工具包变了维护者按新工具包重新拉起、
//   活着的子 agent 按新的交集重新装配（toolkitChanged → 20 号票的 subAgents.reassemble）；
//   拒绝后受影响的阶段交回维护者在现有授权内重排（自行调整计划），做不到就标做不了；
// - 自行调整计划（拆阶段、调顺序这类不扩大授权的）：直接生效，时间线记一笔；想借这条路扩大授权的被拒；已验收的阶段不能改；
// - 现在生效的计划换了一版（计划变更确认、自行调整）时看板上推一条 task_plan：任务详情的阶段抽屉按它显示；
// - 偏离、阈值的经过，计划变更的结论、自行调整计划在任务的时间线上各记一笔（25 号票的 timeline_record：偏离、计划变更、自行调整计划）。
// - 涉及多个项目的任务（17 号票，multiProject）：任务维护者的工具包固定（不写文件、不跑 bash、不联网，toolkit），阶段里有发往
//   各项目的工单：本阶段的回执全部到齐且都完成，才能宣布阶段完成、跑本阶段的验收（stageGate）；有工单被退回、做不了的，本阶段不通过，
//   任务维护者调整做法时算一次验收退回（countReturn，和脚本、评审的退回同一份计数和阈值）；阶段的交代、重注入块、由我验收的事项、
//   评审的输入里写上本阶段的工单和回执（stageLines），评审子 agent 能只读访问各项目的档案和工作目录（reviewPlaces）。
//   交上来的计划（计划变更、自行调整）里涉及的项目要对得上任务（planProjects，17 号票评审后定）。
// 交给维护者的话都是它会话里的系统通知（带 taskId），维护者模块据此唤起它；什么时候能处理输入看任务的状态（maintainers/）。
// 维护者的工具和给它看的话在 execution-tools.ts（包括这一支为什么停下的说法），这里只返回结构化的结果。
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  type AcceptanceCriterion,
  ACCEPTANCE_VERDICT_LABEL,
  type AcceptanceMethod,
  availableTaskActions,
  BLOCKING_URGENCIES,
  CHANNELS,
  ENDED_TASK_STATES,
  EVENT_TYPES,
  FAILURE_CHOICE_ACTIONS,
  type GrantInfo,
  HAND_OVER_DONE,
  initialStages,
  listStageCodes,
  stageLayerCount,
  withStageCodes,
  INTERRUPTED_ACTIONS,
  type InterruptedNoticeData,
  interruptedNoticeData,
  type InboxItem,
  type InboxOrigin,
  type InboxItemEventPayload,
  MAINTAINER_CHANNEL_PREFIX,
  maintainerChannel,
  type MessageEventPayload,
  type TurnEndEventPayload,
  nowIso,
  OVER_BUDGET_ACTIONS,
  type ParallelCardPayload,
  type Plan,
  type PlanChangeCardPayload,
  type PlanChangeItem,
  type PlanConfirmInput,
  type PlanDraft,
  type PlanToolkit,
  planChangeItemText,
  type ProgressCardPayload,
  sameToolkit,
  capabilityText,
  toolkitAdded,
  withoutCapabilities,
  withCapabilities,
  toolkitRemoved,
  toolkitExpansions,
  STAGE_ACCEPTANCE_ACTIONS,
  STAGE_STATE_LABEL,
  STUCK_HELP_ACTIONS,
  type Task,
  type TaskAction,
  type TaskActionParams,
  type TaskActionResult,
  type TaskActor,
  type TaskBrief,
  type TaskChange,
  type TaskEventPayload,
  type TaskPlanEventPayload,
  type TaskStage,
  type TaskStageAcceptance,
  type TaskStageView,
  type TaskState,
  TASK_STATE_LABEL,
  TASK_WAIT_REASON_LABEL,
  type TaskWaitReason,
  taskKind,
  type TaskStep,
  type TimelineRecordKind,
  SETTLED_STEP_STATES,
  WORKFLOW_STAGE_ID,
  type WorkflowStepState,
  toolkitChangeText,
  type Urgency,
  resumesOnReply,
  taskInboxOrigin,
  userDecidesWait,
  isPlainTask,
  isProjectInternal,
  hasOwnMaintainer,
  canTellSecretary,
  tellSecretaryField,
} from "@ergou/protocol";
import type { CardService } from "../cards/cards.ts";
import type { CardActionEffect } from "../cards/registry.ts";
import { buildAgentNotice, buildMessage, buildTimelineRecord, type MessageScope } from "../conversation/messages.ts";
import { listEffects } from "../guard-runtime/effect-log.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { findTool, type GuardTask, NUDGE_PREFIX, planPending, type ToolRegistry, type WatchCategorySettings } from "../guard/index.ts";
import {
  type ApprovalDecidedPayload,
  type ApprovalSuspendedPayload,
  callInboxOrigin,
  type EffectRecordedPayload,
  type ExecutionRecord,
  GUARD_CHANNEL,
  GUARD_EVENTS,
  type PulledBackPayload,
  type ToolCallInterruptedPayload,
} from "../guard-runtime/events.ts";
import { executionOf, interruptionNote } from "../guard-runtime/executions.ts";
import { planHistory } from "../guard-runtime/plan-check.ts";
import { getMessage, inputOf, pendingInputs, startedInputs } from "../conversation/views.ts";
import type { HandOverData } from "../hand-over/hand-over.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import { oneLine } from "../util/text.ts";
import type { ScriptOutcome } from "./acceptance.ts";
import { contextBlockText } from "./context-block.ts";
import {
  type BudgetMarkPayload,
  type BudgetResetPayload,
  type BudgetUsedPayload,
  type OutputReaction,
  type OutputReactionPayload,
  type PlanChangeProposedPayload,
  type PlanDecidedPayload,
  type PlanRevisedPayload,
  TASK_EVENTS,
  TASKS_CHANNEL,
} from "./events.ts";
import { noticeText, spendText, stageText, stopReasonText } from "./execution-tools.ts";
import { confirmedAtOf, createGrantRenewals, isoTimes } from "./grant-renewal.ts";
import { affectedStages, diffPlan, expanding, grantTimesAfter, mergeDraft, stagesAfter, touchedAcceptedStages } from "./plan-change.ts";
import { checkRevisedPlan, grantInfoOf, planConfirmation, readWatchSettings, toGuardPlan, type ToolkitProblems } from "./plan.ts";
import type { ReviewInput, ReviewResult } from "./review.ts";
import { createStallWatch, nextNudge } from "./stall.ts";
import { allAccepted, currentStage, findStage, missingPrerequisites, nextStep, reopen, reopenScope, stageNow, stagePosition, stageStarted, stageWaiting, taskMessageScope, withStage } from "./stages.ts";
import { stageEffects, taskStageView } from "./stage-view.ts";
import { assertUserCan } from "./state-machine.ts";
import type { TaskService } from "./tasks.ts";
import type { ExecutionSlots } from "./slots.ts";
import { budgetRatio, type StageSpend, type TaskThresholds } from "./thresholds.ts";
import { EXECUTION_TOOL } from "./tool-names.ts";
import type { StoredPlan } from "./views.ts";
import { guardWorkflow } from "./workflow-plan.ts";
import { executedSteps, nudgeOf, stepsAtFinish, stepsOnStart } from "./workflow-run.ts";
import { workflowContextText, workflowNoticeText } from "./workflow-texts.ts";
import { internalPlainDoneNotice, PLAIN_DONE_NOTE, PLAIN_RESUMED_TEXT, plainBriefKey, plainBriefText, plainStuckNote } from "./plain.ts";

/** 已完成的任务（任务完成后的回调拿到的）：任务、任务书、确认的计划、交付件所在的工作目录 */
export interface CompletedTask {
  task: Task;
  brief: TaskBrief | undefined;
  plan: Plan;
  /** 交付件的位置：维护者的工作目录（任务的产出区，数据目录 outputs/<任务 id>） */
  workDir: string;
}

/** 验收怎么跑（脚本、评审子 agent）：daemon.ts 接上真的，测试里也是真的 */
export interface AcceptanceRunner {
  runScript(input: { taskId: string; stageId: string; cwd: string; script: string; expectOutput?: AcceptanceCriterion["expectOutput"]; network: boolean }): Promise<ScriptOutcome>;
  review(input: ReviewInput): Promise<ReviewResult>;
}

/** 维护者对哪个任务做（它只能对它执行的那个任务做） */
export interface MaintainerScope {
  taskId: string;
  maintainerId: string;
}

/** 交给维护者的一个阶段（开始执行、换阶段、阶段变化时）：execution-tools.ts 写成交代、授权、边界 */
export interface StageHandoff {
  stageId: string;
  title: string;
  /** 这一阶段的编号（93 号票：计划里存的，"1a"）、一共几个阶段号（依赖图有几层）：交代里写"第 1a/4 阶段" */
  code: string;
  layers: number;
  plan: Plan;
  /** 每项授权在守卫眼里的样子（和计划卡上的说法一样） */
  grantInfo: Readonly<Record<string, GrantInfo>>;
  /** 维护者的工作目录 */
  cwd: string;
  /** 本阶段的另外几行交代（17 号票：涉及多个项目的任务里本阶段发往各项目的工单） */
  notes?: string[];
  /**
   * 这个阶段之前交过几次、最近一次没通过的标准（84 号票：重做之后开始这个阶段时交代里带上，照 AgentSense 认领时的
   * "之前做过 N 次，最近一次没通过的标准"）；没交过的没有
   */
  history?: { attempts: number; lastFailed: readonly string[] };
}

/** 一条验收标准的结论 */
export interface AcceptanceVerdict {
  criterion: string;
  method: AcceptanceMethod;
  passed: boolean;
  note?: string;
}

/** 一个阶段有了结论之后接下来做什么 */
export type NextUp =
  /** 开始了这个阶段 */
  | { kind: "stage"; stage: StageHandoff }
  /** 全部阶段验收，任务完成 */
  | { kind: "completed" }
  /** 没有别的能推进的阶段，任务转等我 */
  | { kind: "waiting"; reason: TaskWaitReason }
  /** 接着做手头在做的 */
  | { kind: "continue" };

/** 宣布阶段完成的结论 */
export type CompleteStageResult =
  /** 验收期间任务被暂停、取消、结束了：这次验收作废 */
  | { outcome: "void"; state: TaskState }
  /** 没通过：交回维护者，阶段回到进行中 */
  | { outcome: "returned"; stageId: string; judgedBy: AcceptanceMethod; results: AcceptanceVerdict[] }
  /** 没通过、而且退回次数超了阈值（14 号票：退回 2 次、第 3 次还不过）：这一支停下找用户（卡住求助） */
  | { outcome: "stuck"; stageId: string; judgedBy: AcceptanceMethod; results: AcceptanceVerdict[]; attempts: number; next: NextUp }
  /** 能自动判的都过了，还有由用户验收的：放进待我处理，阶段等用户 */
  | { outcome: "awaiting_user"; stageId: string; results: AcceptanceVerdict[]; next: NextUp }
  | { outcome: "accepted"; stageId: string; judgedBy: AcceptanceMethod; results: AcceptanceVerdict[]; next: NextUp };

export interface StartStageResult {
  stage: StageHandoff;
  /** 本来就在做这个阶段 */
  alreadyRunning: boolean;
  /** 放下的那个阶段 */
  setAside?: string;
}

/** 一个阶段的名字（交给维护者的话、待我处理事项里用） */
export interface StageRef {
  stageId: string;
  title: string;
}

/** 维护者提交的计划变更（14 号票）：出了哪张卡、改了什么、哪些阶段停下等确认、接下来做什么 */
export interface PlanChangeProposal {
  cardId: string;
  planId: string;
  changes: PlanChangeItem[];
  affected: StageRef[];
  next: NextUp;
}

/** 维护者自行调整了计划（14 号票）：新的一版、改了什么、接下来做什么 */
export interface PlanRevision {
  planId: string;
  revision: number;
  changes: PlanChangeItem[];
  next: NextUp;
}

/** 维护者把几个阶段标成做不了（14 号票）：待我处理里的事项、接下来做什么 */
export interface InfeasibleResult {
  itemId: string;
  stages: StageRef[];
  next: NextUp;
}

/** 维护者在执行中交来的新计划（计划变更和自行调整） */
export interface PlanDraftInput {
  plan: PlanDraft;
  /** 为什么要改（给用户看） */
  why: string;
}

/** 计划变更另外能改的：任务的目标、任务书里的验收标准（不改就不写），另外要停下的阶段 */
export interface PlanChangeInput extends PlanDraftInput {
  goal?: string;
  acceptanceCriteria?: string[];
  stages?: string[];
}

/**
 * 这一支为什么停下找用户（14 号票）：阈值超了（拉回、催促、验收退回、预算）、维护者标了做不了。
 * 说法由 execution-tools.ts 的 stopReasonText 生成（给维护者的通知、待我处理事项、任务和阶段上的说明共用）
 */
export type BranchStopReason =
  /** 拉回满了阈值后又被拉回：count 是算上这次一共几次 */
  | { kind: "pull_backs"; count: number; tool: string; ruleIds: string[] }
  /** 停滞：每次 minutes 分钟没有进展，催了 nudges 次 */
  | { kind: "stall"; minutes: number; nudges: number }
  /**
   * 验收：算上这次退回了几次；judged 是怎么判的（"脚本检查""评审判定"；涉及多个项目的任务调整做法时是多项目模块给的说法，17 号票）
   */
  | { kind: "acceptance"; returns: number; judged: string }
  /** 用量超过预算的 times 倍 */
  | { kind: "over_budget"; used: StageSpend; budget: StageSpend; times: number }
  /** 维护者标了做不了 */
  | { kind: "infeasible"; reason: string };

export interface TaskExecutionOptions {
  store: EventStore;
  tasks: TaskService;
  cards: CardService;
  inbox: InboxService;
  now: () => string;
  /** 可注入的时钟（无进展的催促、授权项的有效期按它走，14 号票） */
  clock: Clock;
  /** 调度器：无进展的催促、授权项到期前的续期事项挂在它上面（14 号票） */
  scheduler: Scheduler;
  /** 全局执行名额（tasks/slots.ts：执行中的任务和定时作业开始了的运行共用，谁占着只在那里数） */
  slots: ExecutionSlots;
  /** 阈值（14 号票，thresholds.ts 的 DEFAULT_TASK_THRESHOLDS；配置 tasks.thresholds） */
  thresholds: TaskThresholds;
  /** 某个任务的某个阶段干活用掉的 token（24 号票 token 账本的 stageTokens(…, { budget: true })，14 号票的预算比较用它） */
  stageTokens: (taskId: string, stageId: string) => number;
  /** 这个维护者现在有没有在运行的子进程（无进展的判定：维护者活着才算停滞） */
  agentAlive: (agentId: string) => boolean;
  /** 现取全局关注类别设置（26 号票的设置服务）：交给维护者的授权说法要它 */
  watchSettings: () => WatchCategorySettings;
  /** 计划里的授权项、时序规则照这份工具注册表查 */
  planTools: ToolRegistry;
  /** 计划变更、自行调整时工具包里的 skill 要在 skill 库里、MCP 要登记过（27 号票）；不给就不查 */
  toolkitProblems?: ToolkitProblems;
  /** 数据目录的输出区（真实路径）：不属于项目的任务的产出，每个任务一格，也是维护者的工作目录 */
  outputsDir: string;
  /**
   * 认得效果日志里各种工具的注册表（84 号票：阶段详情列"已经做了的事"分本机、对外，授权已用几次按对象范围比）：
   * 框架自带的加登记的 MCP。不给就用 planTools
   */
  effectTools?: () => ToolRegistry;
  /** 用户主目录（agent 的 bash 里 ~ 指的地方）：授权已用几次时解析效果日志里的路径；不给就不认 ~ */
  homeDir?: string;
  /**
   * 停稳维护者手头这一轮（84 号票：从某个阶段重做之前，照 AgentSense 先 abort 再 waitForIdle）：维护者模块拦住执行这个任务的
   * 会话不再开始下一条输入、中止手头这一轮、等它真的结束（最多 timeoutMs；到点还没停的，那一轮之后的调用守卫不放行，交回 reason）。
   * 返回放开的函数（提交了重置再叫）；没有在执行这个任务的维护者会话时 undefined。不给就不停（测试里的执行控制器）
   */
  stopTurn?: (task: Task, how: { timeoutMs: number; reason: string }) => Promise<(() => void) | undefined>;
  /** 停稳最多等多久（毫秒，84 号票）；不给是 REWORK_STOP_TIMEOUT_MS（测试里调短，测到点没停下的那一轮作废） */
  reworkStopTimeoutMs?: number;
  acceptance: AcceptanceRunner;
  /** 有子 agent 在做的阶段（20 号票）：阶段 id → 在做它的子 agent；不给是都没有 */
  subAgentsOn?: (taskId: string) => ReadonlyMap<string, readonly string[]>;
  /**
   * 只涉及一个项目的任务（16 号票：由项目的维护者执行）：属于哪个项目（工作目录、工具包按项目的，消息带上项目），
   * 以及排队的任务现在能不能进入执行中（项目的维护者正忙时不能：留在排队中，看板上"等项目 X"）。不给就都按任务自己的维护者
   */
  projectTasks?: ProjectTasks;
  /** 维护者的工具包变了（14 号票：计划变更确认、自行调整计划之后，事件已经落盘）：活着的子 agent 跟着重新装配（20 号票的 subAgents.reassemble） */
  toolkitChanged?: (taskId: string) => void;
  /** 涉及多个项目的任务（17 号票，派单器在 daemon.ts 里接上）。不给就没有这样的任务 */
  multiProject?: MultiProjectTasks;
  /**
   * 交上来的计划（计划变更、自行调整）里涉及的项目对不对得上任务（17 号票评审后定：单项目任务不能写进别的项目，不涉及项目的任务
   * 不能写项目行，多项目任务每一行写所属阶段和验收标准）：不对的原因；不给就不查
   */
  planProjects?: (task: Task, plan: Plan) => string[];
  log: (line: string) => void;
}

/** 涉及多个项目的任务在执行控制器这里的差异（17 号票） */
export interface MultiProjectTasks {
  /** 涉及多个项目的任务的维护者的工具包（固定为三样，不写文件、不跑 bash、不联网）；不是这样的任务是 undefined */
  toolkit(task: Task): PlanToolkit | undefined;
  /** 宣布阶段完成之前：本阶段的工单回执到齐、都完成了没有；没有时给出原因（不让宣布完成，不算一次） */
  stageGate(task: Task, stageId: string): string | undefined;
  /** 阶段的交代、重注入块、由我验收的事项、评审的输入里另写的几行：本阶段发往各项目的工单和回执 */
  stageLines(task: Task, stageId: string): string[];
  /** 评审子 agent 能只读访问的：本阶段涉及的各项目的档案和工作目录 */
  reviewPlaces(task: Task, stageId: string): { projectRecords: string[]; workingDirs: string[] };
}

/** 项目的任务在执行控制器这里的差异（派单器在 daemon.ts 里接上，16 号票） */
export interface ProjectTasks {
  /** 这个任务由哪个项目的维护者执行：项目编号、项目的工作目录（真实路径）、项目的工具包；任务自己的维护者执行的是 undefined */
  of(task: Task): { projectId: string; workDir: string; toolkit: PlanToolkit | undefined } | undefined;
  /** 排队的任务能不能进入执行中（全局名额另看）；events 和这次变化同一事务追加（工单开始、开一段会话，或者补派的工单） */
  admit(task: Task): { admit: boolean; events: NewEvent[] };
}

/** 两版计划只有工具包不一样 */
function onlyToolkitDiffers(a: Plan, b: Plan): boolean {
  return JSON.stringify({ ...a, toolkit: null }) === JSON.stringify({ ...b, toolkit: null });
}

/**
 * 执行时的工具包（27 号票评审后定，规格第 20 节"工具包的细则"）：项目的任务里，bash、联网、MCP 这些能力取任务授权和项目工具包的
 * 交集（项目工具包里没有的能力，任务授权也放不开）；skill 不是权限，取两者的并集（任务里加的 skill 只记在任务上，不改项目工具包）
 */
export function effectiveToolkit(planned: PlanToolkit, project: PlanToolkit | undefined): PlanToolkit {
  if (!project) return planned;
  return {
    skills: [...project.skills, ...planned.skills.filter((s) => !project.skills.includes(s))],
    mcp: planned.mcp.filter((m) => project.mcp.includes(m)),
    bash: planned.bash && project.bash,
    network: planned.network && project.network,
    // 给秘书发消息（102 号票）：两边都开着才开
    ...tellSecretaryField(canTellSecretary(planned) && canTellSecretary(project)),
  };
}

export interface TaskExecution {
  /** 接上事件：排队的开始执行、审批挂起和"交给我做"让一支停下……；守护进程重启时验收被打断的阶段交回维护者 */
  start(): void;
  stop(): void;
  // ───── 维护者（execution-tools.ts 的工具）：被拒时抛 RequestRejected ─────
  /** 换去做另一个能开始的阶段（前置阶段没验收的不能开始） */
  startStage(scope: MaintainerScope, stageId: string): StartStageResult;
  /** 宣布阶段完成：跑这个阶段的验收 */
  completeStage(scope: MaintainerScope, stageId: string, summary: string): Promise<CompleteStageResult>;
  /** 报告进展：一张进度卡（出现在维护者的会话里） */
  reportProgress(scope: MaintainerScope, text: string): { cardId: string };
  /** 转为等我（卡住求助）：写明原因，待我处理里放一条"卡住求助" */
  waitForUser(scope: MaintainerScope, reason: string): { itemId: string };
  /** 判任务失败：必须写原因，待我处理里放一条"失败后的抉择" */
  fail(scope: MaintainerScope, reason: string): { itemId: string };
  /**
   * 流程的维护者汇报某一步的状态（58 号票，report_step）：步骤都做完或说明跳过时流程完成（completed）。
   * 不是流程、没有这一步的抛 RequestRejected
   */
  reportStep(scope: MaintainerScope, input: { stepId: string; state: Exclude<WorkflowStepState, "pending">; gist?: string }): { done: number; total: number; completed: boolean };
  /**
   * 并行（20 号票）：这几个阶段现在能不能交给子 agent 并行做——任务是这个维护者在执行的、在执行中；每个阶段在计划里、
   * 正在做或能开始（前置阶段都验收了），没有子 agent 已经在做。不能的抛 RequestRejected（说明哪个阶段为什么不行）
   */
  checkParallel(scope: MaintainerScope, stageIds: readonly string[]): void;
  /**
   * 用户同意并行时：再查一遍 checkParallel，没开始的那几个阶段开始（几个阶段同时在做）。
   * 给出要和卡片更新同一事务追加的事件（不追加）
   */
  parallelStartEvents(scope: MaintainerScope, stageIds: readonly string[]): NewEvent[];
  /**
   * 提交计划变更（14 号票）：扩大授权、加能力、加项目、改目标或验收标准。出计划变更卡，只有受影响的阶段停下等确认。
   * 没有扩大的改动（拆阶段、调顺序……）被拒，提示自行调整；goal、acceptanceCriteria 是任务书里新的目标和验收标准（不改就不写），
   * stages 是另外要停下的阶段
   */
  proposePlanChange(scope: MaintainerScope, input: PlanChangeInput): PlanChangeProposal;
  /** 自行调整计划（14 号票）：拆阶段、调顺序这类不扩大授权的，直接生效、时间线记一笔；扩大授权的被拒，提示改走计划变更 */
  revisePlan(scope: MaintainerScope, input: PlanDraftInput): PlanRevision;
  /** 把几个阶段标成做不了（14 号票，计划变更被拒、在现有授权内也重排不了时）：这一支停下找用户 */
  markInfeasible(scope: MaintainerScope, input: { stageIds: string[]; reason: string }): InfeasibleResult;
  /**
   * 改任务的工具包（27 号票）：用户在任务详情里直接改（扩大、减少都直接生效，不出计划变更卡），维护者增减 skill。
   * 现在生效的计划换成新的一版（只改了工具包），时间线记一笔，工具包变了的维护者按新工具包重新装配、子 agent 跟着收窄。
   * 计划还没确认的、已经结束的任务不能改；有计划变更卡在等的先等它有结论。没有改动时什么都不追加
   */
  changeToolkit(input: { taskId: string; toolkit: PlanToolkit; by: "user" | "maintainer"; why: string; idempotencyKey?: string; events?: NewEvent[] }): {
    task: Task;
    before: PlanToolkit;
    after: PlanToolkit;
    changed: boolean;
  };
  /** 账本记下了这个任务的一次用量（14 号票：token 的预算比较；daemon.ts 接在账本的 onRecorded 上） */
  tokensRecorded(taskId: string, stageId: string): void;
  // ───── 用户 ─────
  /** 用户对任务的控制（task_action 请求）：同一个幂等键重发拿到同一个结果 */
  act(params: TaskActionParams, idempotencyKey: string): TaskActionResult | Promise<TaskActionResult>;
  /**
   * 用户对任务的控制，先不落盘（22 号票：任务控制快速动作和快速动作卡、操作记录同一事务追加）：能不能做照样只看
   * availableTaskActions(task, "user")，做不了抛 RequestRejected；返回要追加的事件（第一条任务事件带这个幂等键）、
   * 控制之后的状态，以及落盘之后调用方要叫的 afterCommit（提示用户、把对应的通知记成处理过）
   */
  prepareAct(params: TaskActionParams, idempotencyKey: string): PreparedTaskAct;
  /**
   * 从某个阶段重做，先不落盘（84 号票：归档清单上的"继续"和卡片更新同一事务追加）：和 act 的重做同一条路——先查能不能做，
   * 再停稳维护者手头这一轮，按此刻的任务算出事件。调用方落盘之后叫 afterCommit；release 不管落没落盘都要叫一次（放开维护者的会话，
   * 同一任务的下一次重做才接着）
   */
  prepareReworkAct(params: TaskActionParams, idempotencyKey: string): Promise<PreparedTaskAct & { release(): void }>;
  /** 计划变更卡上的"确认"（可以勾掉、收窄授权项，加本任务的关注类别）：卡片动作的结果（和卡片更新同一事务） */
  confirmPlanChange(payload: PlanChangeCardPayload, input: PlanConfirmInput, idempotencyKey: string): CardActionEffect<PlanChangeCardPayload>;
  /** 计划变更卡上的"拒绝"（可附说明）：受影响的阶段交回维护者在现有授权内重排 */
  rejectPlanChange(payload: PlanChangeCardPayload, note: string | undefined, idempotencyKey: string): CardActionEffect<PlanChangeCardPayload>;
  // ───── 别的模块读 ─────
  /** 守卫看到的任务（计划、当前阶段）；还没开始执行的是 null */
  guardTask(taskId: string): GuardTask | null;
  /** 执行时此刻的工具包（现在生效的计划和项目工具包的交集，27 号票：子 agent 的守卫每次判定现取）；没有确认的计划时没有 */
  toolkitNow(taskId: string): PlanToolkit | undefined;
  /** 重注入块（计划摘要 + 当前阶段 + 授权 + 边界）；还没开始执行的没有 */
  contextBlock(taskId: string): string | undefined;
  /** 维护者的工作目录：任务的产出区；项目的任务是项目的工作目录（16 号票） */
  workDir(taskId: string): string;
  /**
   * 阶段详情从守护进程现取的（84 号票，GET /api/tasks/<任务>/stages/<阶段>）：授权已用几次、从这里重做的范围、这几个阶段这一轮
   * 已经做了的事；没有这个任务、还没建阶段、没有这个阶段的是 undefined
   */
  stageView(taskId: string, stageId: string): TaskStageView | undefined;
  /** 项目空出来了（派单器）：看看排队的任务能不能开始（16 号票） */
  kick(): void;
  /**
   * 一支在等用户回答、确认（16 号票：项目维护者做工单时在等派单方回答；17 号票：任务维护者转问用户、计划外的工单待你确认）：
   * 这一支停下，都在等时任务转等我。不写阶段是维护者手上在做的那个，原因默认"澄清"
   */
  awaitAnswer(taskId: string, waitingOn: string, branch?: { stageId?: string; reason?: TaskWaitReason; what?: string }): void;
  /** 等的回答来了：这一支接着走，任务在等我的恢复执行（名额满了回到排队中） */
  answered(waitingOn: string): void;
  /**
   * 调整做法算一次验收退回（17 号票：涉及多个项目的任务里，本阶段的工单被退回、做不了，任务维护者重新派单或改了计划）：
   * 和脚本、评审的退回同一份计数（14 号票的 returns）和阈值，会话里一条说明（why：为什么不通过、怎么调整的；judged：怎么判的），
   * 返回要和调整同一事务追加的事件（不追加）。退回超了阈值（退回 2 次、第 3 次还不过）时这一支停下找用户（卡住求助，已经落盘）：stuck
   */
  countReturn(scope: MaintainerScope, stageId: string, how: { why: string; judged: string }): { events: NewEvent[]; stuck: boolean };
  /**
   * 登记"任务完成后"的回调：全部阶段验收通过、任务自动完成之后叫（事件已经落盘）；返工后再完成会再叫一次。
   * 转为项目（以"已完成 · 已转为项目"结束）不是做完了，不叫。29 号票的节假日数据导入、15 号票的首个建设任务接在这里。
   * 回调出错只记日志。返回取消登记的函数
   */
  onCompleted(fn: (completed: CompletedTask) => void): () => void;
}

/** 准备好、还没落盘的一个用户控制（prepareAct） */
export interface PreparedTaskAct {
  /** 要在同一事务里追加的事件 */
  events: NewEvent[];
  result: TaskActionResult;
  /** 事件落盘之后叫一次 */
  afterCommit(): void;
}

/** 一次变化的草稿：一串要在同一事务里追加的事件，之后要做的事 */
interface Draft {
  task: Task;
  /** 交给维护者的话、会话里的说明在任务的归属（taskMessageScope）之外带上的：项目的任务还有项目（16 号票） */
  projectScope: MessageScope;
  events: NewEvent[];
  /** 追加之后马上提示用户的待我处理事项 */
  alerts: InboxItem[];
  /** 第一个事件带上的请求幂等键（用户的控制：重发拿到同一个结果） */
  key?: string;
  /** 这次开始了哪个阶段 */
  startedStage?: string;
  /** 这次任务完成了 */
  completed: boolean;
  /** 这次是从某个阶段重做（84 号票）：任务事件上带着你点的阶段和重开了哪几个 */
  reworkOf?: { stageId: string; reopened: readonly string[] };
}

const listOf = (task: Task): TaskStage[] => task.stages?.list ?? [];

/** 去掉等我、失败、系统暂停的说明（恢复执行时） */
const cleared = (task: Task): Task => {
  const { waitReason: _r, waitNote: _n, failReason: _f, pauseReason: _p, ...rest } = task;
  return rest;
};

/** 用户让停下的这一支接着走（卡住求助、超预算）：阈值的计数清零（14 号票） */
const countersCleared = (stage: TaskStage): TaskStage => {
  const { pullBacks: _p, returns: _r, nudges: _n, ...rest } = stage;
  return rest;
};

/** 有了进展：催促计数清零 */
const nudgesCleared = (stage: TaskStage): TaskStage => {
  const { nudges: _n, ...rest } = stage;
  return rest;
};

const draftOf = (task: Task, projectScope: MessageScope, key?: string): Draft => ({ task, projectScope, events: [], alerts: [], completed: false, ...(key === undefined ? {} : { key }) });

/** 草稿里这时的归属：任务和当时的阶段（说的是某个阶段的写那个阶段），项目的任务还有项目 */
const scopeIn = (d: Draft, stageId?: string): MessageScope => ({ ...taskMessageScope(d.task, stageId), ...d.projectScope });

/** 交给维护者的一条输入（它会话里的系统通知）；interject：它正在干活时以插话送达（14 号票：只有催促这样送） */
const notify = (d: Draft, text: string, interject = false) => {
  d.events.push(buildAgentNotice(maintainerChannel(d.task.maintainerId), text, `task-exec:${d.task.id}:${randomUUID()}`, scopeIn(d), { interject }).event);
};

/** 维护者会话里的一条系统说明（只给人看，不交给维护者）；说的是某个阶段的就写上它 */
const note = (d: Draft, text: string, stageId?: string) => {
  d.events.push(buildMessage({ conversation: maintainerChannel(d.task.maintainerId), speaker: "system", parts: [{ type: "text", text }] }, scopeIn(d, stageId)).event);
};

/** 维护者会话里一张卡片（验收结论的进度卡：属于它验收的那个阶段） */
const cardRef = (d: Draft, cardId: string, stageId: string) => {
  d.events.push(buildMessage({ conversation: maintainerChannel(d.task.maintainerId), speaker: "system", parts: [{ type: "card_ref", cardId }] }, scopeIn(d, stageId)).event);
};

/** 被中断的调用（23 号票）是谁的：维护者自己的，或者它派出的子 agent 的（20 号票：写明哪个子 agent、在哪个阶段） */
const interruptedBy = (task: Task, execution: ExecutionRecord) => {
  const { agentId, stageId } = execution.origin;
  if (agentId === task.maintainerId) return { whose: "维护者", where: "", call: execution.call };
  const at = stageId === null ? "" : `在阶段 ${stageId} `;
  return { whose: `子 agent ${agentId} `, where: `里子 agent ${agentId} ${at}`, call: `${execution.call}（子 agent ${agentId} ${at}的调用）` };
};

/** 任务的时间线上记一笔（14 号票：偏离、计划变更、自行调整计划；25 号票的 timeline_record） */
const record = (d: Draft, kind: TimelineRecordKind, summary: string, extra: { detail?: string; stageId?: string } = {}) => {
  const conversation = maintainerChannel(d.task.maintainerId);
  d.events.push(buildTimelineRecord(conversation, { kind, summary, ...(extra.detail ? { detail: extra.detail } : {}) }, scopeIn(d, extra.stageId)).event);
};

/**
 * 在等用户验收的那个阶段（不在等的是 undefined）；从待我处理里点的（itemId）还要是它在等的那一条——重做过的阶段又在等新的一轮，
 * 旧的那条不能验收新的一轮（84 号票）
 */
const awaitingUser = (task: Task, stageId: string | undefined, itemId?: string): TaskStage | undefined => {
  const stage = stageId === undefined ? undefined : findStage(listOf(task), stageId);
  return stage?.state === "waiting" && stage.waitReason === "acceptance" && (itemId === undefined || stage.waitingOn === itemId) ? stage : undefined;
};

/** 这个阶段最近一次交上来没通过的标准：还有结论就按结论，重开过（结论清掉了）按重开时记下的 */
const lastFailedOf = (stage: TaskStage): string[] =>
  stage.acceptance.some((a) => a.result) ? stage.acceptance.filter((a) => a.result && !a.result.passed).map((a) => a.criterion) : [...(stage.lastFailed ?? [])];

/** 待我处理事项（等你验收、卡住求助、超预算、交给我做）上写着的阶段 */
const stagesOfItem = (item: InboxItem): string[] => {
  const data = (item.kind === "notice" ? item.data : undefined) as { stageId?: unknown; stageIds?: unknown; origin?: { stageId?: unknown } } | undefined;
  const ids = [data?.stageId, ...(Array.isArray(data?.stageIds) ? data.stageIds : []), data?.origin?.stageId];
  return ids.filter((id): id is string => typeof id === "string");
};

/** 返工要指明的阶段（没写、计划里没有的抛 RequestRejected） */
const reworkStage = (task: Task, params: TaskActionParams): TaskStage => {
  const list = listOf(task);
  const stage = params.stageId ? findStage(list, params.stageId) : undefined;
  if (!stage) throw new RequestRejected("bad_params", `返工要指明哪个阶段出了问题（${list.map((s) => s.stageId).join("、")}）`);
  return stage;
};

/** 从某个阶段重做之前停稳维护者手头这一轮最多等多久（84 号票，到点还没停的那一轮作废） */
const REWORK_STOP_TIMEOUT_MS = 10_000;

/** 重做之后作废的东西：旧按钮点了回这几句，通知记成处理过时的那一项（84 号票，用户 2026-10-11 定：作废，不只是"不卡着"） */
/** 直接归档了的任务还没处理的通知：作废（90 号票），再点它的按钮时被拒的原因 */
const ARCHIVED_NOTICE = "任务已经归档，这一条作废了";

const VOIDED = {
  card: "已经重做过，这张卡作废了",
  notice: "已经重做过，这一条作废了",
  choice: "已作废",
  turn: "用户从某个阶段重做了，这一轮已经作废：不要再调用工具，停下等新的交代。",
  input: "重做之前排着的通知，作废了（重做的交代里说清楚了）",
} as const;

/**
 * 任务在等我是不是维护者自己说的（转为等我）：等我时还有能推进的阶段（在做的、能开始的），就不是"所有分支都在等用户"推出来的。
 * 一支有了结论之后，推出来的等我恢复执行，维护者自己说的要用户点"继续执行"（或回话）
 */
const declaredWait = (task: Task, busy: ReadonlySet<string>): boolean => task.state === "waiting_for_user" && nextStep(listOf(task), busy).kind !== "wait";

/** 用户点"继续"就接着走的那几支（等用户定夺的：卡住求助、超预算，协议包的 USER_DECIDES_WAIT_REASONS） */
const userResolved = (s: TaskStage) => s.state === "waiting" && userDecidesWait(s);

/** 用户在会话里回话就接着走的那几支（卡住求助；超预算的要点"追加预算继续"，协议包的 RESUME_ON_REPLY_WAIT_REASONS） */
const replyResumable = (s: TaskStage) => s.state === "waiting" && resumesOnReply(s);

/** 各阶段在等的待我处理事项（等你验收、卡住求助、超预算……） */
const waitedOn = (t: Task) => new Set(listOf(t).flatMap((s) => (s.state === "waiting" && s.waitingOn !== undefined ? [s.waitingOn] : [])));

/** 用户验收之后，这个阶段各条标准的结论（自动判过的照原样，由用户验收的按这次的；退回写了原因的记在由用户验收的那几条上，84 号票） */
const verdictsAfterUser = (stage: TaskStage, passed: boolean, why?: string): AcceptanceVerdict[] => [
  ...(passed ? stage.acceptance.filter((a) => a.method !== "user" && a.result).map((a) => ({ criterion: a.criterion, method: a.method, passed: a.result!.passed, ...(a.result!.note ? { note: a.result!.note } : {}) })) : []),
  ...stage.acceptance.filter((a) => a.method === "user").map((a) => ({ criterion: a.criterion, method: a.method, passed, ...(why ? { note: why } : {}) })),
];

/** 结论卡上带的维护者宣布完成时写的那句（84 号票：尝试记录的备注）；没写的不带 */
const summaryText = (summary: string | undefined): { summary?: string } => (summary?.trim() ? { summary: summary.trim() } : {});

/** 由你验收的阶段：这次交上来时写的那句（宣布完成时记在阶段上） */
const summaryOf = (stage: TaskStage) => summaryText(stage.summary);

const errorText = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));

/**
 * 一个阶段的编号（93 号票：计划里存的、开始执行时带到看板上的阶段列表里，"1a"；之前开始执行的任务按依赖图现算，和界面一致）；
 * 列表里没有（已经去掉）时写阶段 id
 */
const stageCodeIn = (task: Task, stageId: string) => listStageCodes(listOf(task)).get(stageId) ?? stageId;

/** 第几阶段「名字」（给用户看的说法；93 号票起写编号，和界面上的"第 1a 阶段"一致） */
const stageName = (task: Task, stage: StageRef) =>
  // 流程只有一个内部的阶段：说"流程"（58 号票）
  stage.stageId === WORKFLOW_STAGE_ID ? "流程" : `第 ${stageCodeIn(task, stage.stageId)} 阶段「${stage.title}」`;

const ref = (s: StageRef): StageRef => ({ stageId: s.stageId, title: s.title });

/** 改了什么，一项一行（时间线记录的详细说明） */
const changeLines = (changes: readonly PlanChangeItem[], grantInfo: Readonly<Record<string, GrantInfo>>) => changes.map((c) => `- ${planChangeItemText(c, grantInfo)}`).join("\n");

/** 现在生效的计划换了一版（计划变更确认、自行调整）：看板上推一条，任务详情的阶段抽屉按它显示 */
const planEvent = (d: Draft, planned: { planId: string; revision: number; plan: Plan }, grantInfo: Readonly<Record<string, GrantInfo>>) => {
  const payload: TaskPlanEventPayload = { taskId: d.task.id, planId: planned.planId, revision: planned.revision, plan: planned.plan, grantInfo: { ...grantInfo } };
  d.events.push({ channel: CHANNELS.board, type: EVENT_TYPES.taskPlan, payload });
};

/** 不算进展的任务变化（无进展的计时不因它们重新开始）：计数本身、拉回；用户开关跑完自动播报（100 号票） */
const STALL_NEUTRAL: readonly TaskChange[] = ["nudged", "progressed", "pulled_back", "rejection_counted", "steps_inferred", "voice_announce_set"];

export function createTaskExecution(options: TaskExecutionOptions): TaskExecution {
  const { store, tasks, cards, inbox, now, log, clock, scheduler, thresholds } = options;
  const completedHooks = new Set<(completed: CompletedTask) => void>();
  const unsubscribes: Array<() => void> = [];
  let fillQueued = false;

  /** 项目的任务（16 号票）：项目编号、工作目录、工具包 */
  const projectOf = (task: Task | undefined) => (task ? options.projectTasks?.of(task) : undefined);
  const workDir = (taskId: string) => projectOf(tasks.get(taskId))?.workDir ?? path.join(options.outputsDir, taskId);
  /** 项目的任务交给维护者的话、会话里的说明还带上项目 */
  const projectScopeOf = (task: Task): MessageScope => {
    const project = projectOf(task);
    return project ? { projectId: project.projectId } : {};
  };
  const draft = (task: Task, key?: string): Draft => draftOf(task, projectScopeOf(task), key);
  /**
   * 执行时的工具包：项目的任务取交集；涉及多个项目的任务（17 号票）的维护者工具包固定，不写文件、不跑 bash、不联网
   * （计划里的工具包是给各项目工单的，在项目维护者那边和项目的工具包取交集）
   */
  const toolkitOf = (task: Task, plan: Plan): PlanToolkit => options.multiProject?.toolkit(task) ?? effectiveToolkit(plan.toolkit, projectOf(task)?.toolkit);
  /** 本阶段另写的几行交代（涉及多个项目的任务：发往各项目的工单） */
  const stageNotes = (task: Task, stageId: string) => options.multiProject?.stageLines(task, stageId) ?? [];
  /** 项目的任务能不能进入执行中（项目的维护者空着、它的执行工单排在队首），以及同一事务追加的事件 */
  const admit = (task: Task) => options.projectTasks?.admit(task) ?? { admit: true, events: [] };

  /** 有子 agent 在做的阶段（20 号票） */
  const subAgentsOn = (taskId: string): ReadonlyMap<string, readonly string[]> => options.subAgentsOn?.(taskId) ?? new Map();

  /** 有子 agent 在做的阶段的集合 */
  const busyOf = (taskId: string): ReadonlySet<string> => new Set(subAgentsOn(taskId).keys());

  /** 阶段改了之后的任务（第 N 阶段跟着重算）；focus 是维护者最后一次开始的阶段，不给就照旧 */
  const withList = (task: Task, list: TaskStage[], focus = task.stages?.focus): Task => ({
    ...task,
    stages: { total: task.stages?.total ?? list.length, current: stagePosition(list, focus, busyOf(task.id)), list, ...(focus === undefined ? {} : { focus }) },
  });

  /** 计划改了之后的任务（14 号票）：阶段数也跟着新的计划；维护者最后开始的阶段被去掉了就不再记 */
  const withPlanList = (task: Task, list: TaskStage[]): Task => {
    const focus = task.stages?.focus !== undefined && findStage(list, task.stages.focus) ? task.stages.focus : undefined;
    return { ...task, stages: { total: list.length, current: stagePosition(list, focus, busyOf(task.id)), list, ...(focus === undefined ? {} : { focus }) } };
  };

  /** 维护者的当前阶段（20 号票起按它最后一次开始的阶段） */
  const currentOf = (task: Task): TaskStage => currentStage(listOf(task), task.stages?.focus, busyOf(task.id));

  /** 维护者手头在做的阶段（无进展的计时、催促按它，14 号票）：它的当前阶段在做、没交给子 agent；不是的没有 */
  const workingStage = (task: Task): TaskStage | undefined => {
    // 还没建阶段的（普通任务没有阶段，75 号票）不计时
    if (listOf(task).length === 0) return undefined;
    const current = currentOf(task);
    return current.state === "running" && !busyOf(task.id).has(current.stageId) ? current : undefined;
  };

  /** 现在生效的计划（还没确认的没有；14 号票起是最新一版确认过的） */
  const confirmedPlan = (taskId: string) => tasks.confirmedPlan(taskId);

  /** 执行中的任务确认过的计划 */
  const planOf = (taskId: string): Plan => {
    const stored = confirmedPlan(taskId);
    if (!stored) throw new Error(`任务 ${taskId} 没有确认过的计划`);
    return stored.plan;
  };

  const grantInfoFor = (plan: Plan) => grantInfoOf(plan, { tools: options.planTools, settings: options.watchSettings() });

  /** 交给维护者的一个阶段：交代、授权、边界都按确认的计划和现在的关注类别设置 */
  const handoff = (task: Task, stageId: string): StageHandoff => {
    const confirmed = planOf(task.id);
    // 边界里写的 bash、联网开关按执行时真正的工具包（项目的任务取交集）
    const plan = { ...confirmed, toolkit: toolkitOf(task, confirmed) };
    const list = listOf(task);
    const stage = findStage(list, stageId);
    return {
      stageId,
      title: stage?.title ?? stageId,
      code: stageCodeIn(task, stageId),
      layers: stageLayerCount(list),
      plan,
      grantInfo: grantInfoFor(plan),
      cwd: workDir(task.id),
      notes: stageNotes(task, stageId),
      ...(stage && stage.attempts > 0 ? { history: { attempts: stage.attempts, lastFailed: lastFailedOf(stage) } } : {}),
    };
  };

  /** 草稿里加一次任务的变化 */
  const apply = (d: Draft, change: TaskChange, by: TaskActor, edit: (t: Task) => Task, stageId?: string) => {
    const rework = change === "rework" ? d.reworkOf : undefined;
    const at = rework?.stageId ?? stageId;
    const built = tasks.buildChange(d.task, edit(d.task), { by, change, ...(at === undefined ? {} : { stageId: at }), ...(rework ? { reopened: rework.reopened } : {}) }, d.key);
    delete d.key;
    d.events.push(built.event);
    d.task = built.task;
  };

  /** 改一个阶段 */
  const applyStage = (d: Draft, change: TaskChange, by: TaskActor, stageId: string, patch: (s: TaskStage) => TaskStage) =>
    apply(d, change, by, (t) => withList(t, withStage(listOf(t), stageId, patch)), stageId);

  /** 进度卡，出现在维护者的会话里 */
  const progressCard = (d: Draft, stageId: string, kind: ProgressCardPayload["kind"], text: string, acceptance?: ProgressCardPayload["acceptance"]): string => {
    const list = listOf(d.task);
    const payload: ProgressCardPayload = {
      taskId: d.task.id,
      taskTitle: d.task.title,
      stageId,
      stageTitle: findStage(list, stageId)?.title ?? stageId,
      stageIndex: Math.max(1, list.findIndex((s) => s.stageId === stageId) + 1),
      stageTotal: d.task.stages?.total ?? Math.max(1, list.length),
      // 文字里写编号（93 号票）：卡上的"第 N/M 阶段"换成"第 1a 阶段"（和界面上进度卡的标题一样）
      stageCode: stageCodeIn(d.task, stageId),
      kind,
      text,
      ...(acceptance ? { acceptance } : {}),
    };
    const card = cards.buildCreate({ type: "progress", payload });
    d.events.push(card.event);
    return card.card.id;
  };

  /** 用户对产出的反应（素材的来源） */
  const outputReaction = (d: Draft, stage: TaskStage, reaction: OutputReaction, extra: { note?: string | undefined; reopened?: string[]; cardId?: string; recordId?: string } = {}) => {
    const payload: OutputReactionPayload = {
      taskId: d.task.id,
      taskTitle: d.task.title,
      stageId: stage.stageId,
      stageTitle: stage.title,
      reaction,
      ...(extra.note ? { note: extra.note } : {}),
      ...(extra.reopened ? { reopened: extra.reopened } : {}),
      ...(extra.cardId ? { cardId: extra.cardId } : {}),
      ...(extra.recordId ? { recordId: extra.recordId } : {}),
      by: "user",
      time: now(),
    };
    d.events.push({ channel: TASKS_CHANNEL, type: TASK_EVENTS.outputReaction, payload });
  };

  /**
   * 放一条卡着任务的通知进待我处理（追加之后提示用户）。origin：一次调用引出的（中断不确定）记那次调用实际所在的会话
   * （105 号票：多项目任务派到项目的工单由项目维护者做，调用在项目维护者的会话里），不给就是任务自己的
   */
  const addNotice = (
    d: Draft,
    input: { notice: "stage_acceptance" | "stuck_help" | "failure_choice" | "over_budget" | "interrupted"; title: string; body: string; actions: string[]; data: Record<string, unknown> },
    origin?: InboxOrigin,
  ): InboxItem => {
    // 105 号票：data 里有阶段（等你验收）的，一起记进 origin
    const { stageId } = input.data;
    const own = taskInboxOrigin(d.task, typeof stageId === "string" ? { stageId } : {});
    const { item, event } = inbox.buildAdd({ kind: "notice", ...own, ...(origin ? { origin } : {}), urgency: "blocking", ...input, title: oneLine(input.title, 60) });
    d.events.push(event);
    d.alerts.push(item);
    return item;
  };

  /** 这个任务还卡着的待我处理事项（审批卡、交给我做、这里放的通知） */
  /** 这条事项是不是这个任务的（卡片看负载里的任务，通知看 data 里的任务或调用的来处） */
  const itemOfTask = (item: InboxItem, taskId: string): boolean => {
    if (item.kind === "card") return (cards.get(item.cardId)?.payload as { taskId?: unknown } | undefined)?.taskId === taskId;
    const data = item.data as { taskId?: unknown; origin?: { taskId?: unknown } } | undefined;
    return data?.taskId === taskId || data?.origin?.taskId === taskId;
  };

  const blockingItemsOf = (taskId: string): InboxItem[] =>
    inbox.list().filter((item) => (BLOCKING_URGENCIES as readonly Urgency[]).includes(item.urgency) && !inbox.isProcessed(item) && itemOfTask(item, taskId));

  /** 任务结束了：它留下的事项不再卡着任务（可以归档、删除）；keep 是还要用户选的那一条（失败后的抉择）、这次草稿里已经改过的 */
  const unblockItems = (d: Draft, keep?: string | ReadonlySet<string>) => {
    for (const item of blockingItemsOf(d.task.id)) {
      if (typeof keep === "string" ? item.id === keep : keep?.has(item.id)) continue;
      d.events.push(inbox.buildUpdate(item, { urgency: "non_blocking" }).event);
    }
  };

  const commit = (d: Draft) => {
    if (d.events.length === 0) return;
    store.appendBatch(d.events);
    runAfterCommit(d);
  };

  /** 草稿的事件落盘之后要做的：提示用户，任务完成了叫回调（commit 里叫；prepareAct 交给调用方落盘之后叫） */
  const runAfterCommit = (d: Draft) => {
    for (const item of d.alerts) inbox.alert(item);
    if (!d.completed) return;
    const completed: CompletedTask = { task: d.task, brief: tasks.brief(d.task.id)?.brief, plan: planOf(d.task.id), workDir: workDir(d.task.id) };
    for (const fn of completedHooks) {
      try {
        fn(completed);
      } catch (err) {
        log(`任务 ${d.task.id} 完成后的回调出错：${errorText(err)}`);
      }
    }
  };

  // ───────────────────────── 阶段推进 ─────────────────────────

  /** 阶段开始做（第一次开始的记下开始时间；已经在做的不动） */
  const startNow = (s: TaskStage): TaskStage => (s.state === "running" ? s : stageNow(s, "running", { startedAt: s.startedAt ?? now() }));

  /** 开始一个阶段；forMaintainer：是维护者（或运行时替它）开始的，记成它的当前阶段（用户同意并行时交给子 agent 的不记） */
  const startStageIn = (d: Draft, stageId: string, by: TaskActor, forMaintainer = true) => {
    apply(d, "stage_started", by, (t) => withList(t, withStage(listOf(t), stageId, startNow), forMaintainer ? stageId : t.stages?.focus), stageId);
    if (forMaintainer) d.startedStage = stageId;
  };

  /** 全部阶段验收了：任务完成（执行中或等我 → 已完成，系统）；流程是步骤都做完或说明跳过了 */
  const complete = (d: Draft) => {
    apply(d, "completed", "system", (t) => ({ ...cleared(t), state: "done" }));
    d.completed = true;
    note(d, taskKind(d.task) === "workflow" ? workflowNoticeText.completed : "全部阶段验收通过，任务完成。");
    unblockItems(d);
  };

  /** 执行中的任务看下一步：接着做、开始一个能开始的阶段、全都在等用户就转等我（写明第一支在等什么）、全验收了就完成 */
  const settle = (d: Draft) => {
    if (d.task.state !== "running") return;
    // 在做的都是子 agent 的（并行，20 号票）时，维护者手头空着：开始一个能开始的阶段
    const step = nextStep(listOf(d.task), busyOf(d.task.id));
    if (step.kind === "continue") return;
    if (step.kind === "start") return startStageIn(d, step.stageId, "system");
    if (step.kind === "complete") return complete(d);
    const reason: TaskWaitReason = step.reason;
    const why = findStage(listOf(d.task), step.stageId)?.waitNote;
    apply(d, "waiting", "system", (t) => {
      const { waitNote: _n, ...rest } = t;
      return { ...rest, state: "waiting_for_user", waitReason: reason, ...(why ? { waitNote: why } : {}) };
    });
  };

  /** 有没有执行名额（不算这个任务自己） */
  const hasSlot = (taskId: string) => options.slots.hasSlot({ taskId });

  /**
   * 进入执行中，再看下一步。第一次（还没建阶段：从排队中开始，或者排队时暂停、没开始过就继续了）建好各阶段，
   * 开始第一个能开始的阶段，交给维护者"开始执行"的交代
   */
  const enterRunning = (d: Draft, by: TaskActor, change: TaskChange, edit: (t: Task) => Task = (t) => t) => {
    if (isPlainTask(d.task)) return enterPlain(d, by, change, edit);
    const first = d.task.stages?.list === undefined;
    const stored = confirmedPlan(d.task.id);
    const plan = planOf(d.task.id);
    // 流程（58 号票）：第一次开始时建好各步的状态
    const workflow = taskKind(d.task) === "workflow" ? stored?.workflow : undefined;
    const steps = (t: Task): Partial<Task> =>
      workflow && t.steps?.list === undefined
        ? { steps: { total: workflow.steps.length, done: 0, list: workflow.steps.map((s): TaskStep => ({ stepId: s.id, title: s.title, state: "pending" })) } }
        : {};
    apply(d, change, by, (t) => {
      const next = cleared(edit(t));
      return withList({ ...next, ...steps(next), state: "running" }, next.stages?.list ?? initialStages(plan));
    });
    settle(d);
    if (!first) return;
    if (workflow && stored) notify(d, workflowNoticeText.started(d.task, workflow, { cwd: workDir(d.task.id) }));
    else notify(d, noticeText.started(d.task, d.startedStage ? handoff(d.task, d.startedStage) : undefined));
  };

  /**
   * 普通任务（75 号票）进入执行中：没有阶段，第一次开始时交给 agent 任务书（同一个任务只交一次：名额满了回到排队、
   * 做完之后接着说再开始时都不重交）。项目内部的普通任务这时它的执行工单已经开始（admit），任务书进这一段
   */
  const enterPlain = (d: Draft, by: TaskActor, change: TaskChange, edit: (t: Task) => Task) => {
    apply(d, change, by, (t) => ({ ...cleared(edit(t)), state: "running" }));
    d.events.push(buildAgentNotice(maintainerChannel(d.task.maintainerId), plainBriefText(d.task), plainBriefKey(d.task.id), scopeIn(d)).event);
  };

  /** 输入没写属于哪个任务时：任务自己的维护者（tm-<n>）就是它那个任务的；项目的维护者同时有几件事，认不出 */
  const ownTaskOf = (maintainerId: string): Task | undefined => {
    const task = tasks.ofMaintainer(maintainerId);
    return task && hasOwnMaintainer(task) ? task : undefined;
  };

  /** 普通任务的 agent 交过任务书了没有（开始过） */
  const plainStarted = (taskId: string) => store.eventByIdempotencyKey(plainBriefKey(taskId)) !== undefined;

  /**
   * 普通任务这一轮做完了（75 号票）：任务自动完成（系统），会话里一条说明，留下的事项不再卡着任务。没有阶段验收，不叫"任务完成后"的回调。
   * 告诉助理：不属于项目的和别的任务一样由"任务做完告诉秘书"（secretary/task-done.ts，99 号票）带上结果告诉它；
   * 项目内部的（助理看不到细节）照旧在同一事务里交给它一句"在哪个项目里做完了"
   */
  const completePlain = (d: Draft) => {
    apply(d, "completed", "system", (t) => ({ ...cleared(t), state: "done" }));
    note(d, PLAIN_DONE_NOTE);
    unblockItems(d);
    if (isProjectInternal(d.task)) d.events.push(buildAgentNotice(CHANNELS.secretary, internalPlainDoneNotice(d.task), `plain-done:${d.task.id}:${randomUUID()}`).event);
  };

  /** 这个普通任务的 agent 最后一轮的结局：全局的是它会话里的最后一轮，项目内部的是项目的维护者处理带着它编号的输入的最后一轮 */
  const lastPlainTurn = (task: Task): TurnEndEventPayload | undefined => {
    const turns = store.read(maintainerChannel(task.maintainerId), 0, EVENT_TYPES.turnEnd).map((e) => e.payload as TurnEndEventPayload);
    if (!isProjectInternal(task)) return turns.at(-1);
    return turns.findLast((t) => inputOf(store.reader, t.inputMessageId)?.scope.taskId === task.id);
  };

  /** 这个普通任务还有没处理完的输入（排着的、交给 agent 了还没结局的）：全局的是它会话里的全部，项目内部的是带着它编号的 */
  const plainInputsLeft = (task: Task): boolean => {
    const conversation = maintainerChannel(task.maintainerId);
    const inputs = [...pendingInputs(store.reader, conversation), ...startedInputs(store.reader, conversation)];
    return isProjectInternal(task) ? inputs.some((q) => q.scope.taskId === task.id) : inputs.length > 0;
  };

  /**
   * 普通任务的 agent 一轮结束（75 号票）：正常结束、手上没有这个任务别的输入了，任务自动完成；出错、被打断的转等我（卡住求助，
   * 待我处理里一条，用户回一句或点"继续执行"就接着做）；被中止的（用户暂停、取消）不管。只看执行中的、这一轮处理的是它的输入
   */
  const onPlainTurnEnded = (maintainerId: string, p: TurnEndEventPayload) => {
    const taskId = inputOf(store.reader, p.inputMessageId)?.scope.taskId;
    const task = taskId === undefined ? ownTaskOf(maintainerId) : tasks.get(taskId);
    if (!task || !isPlainTask(task) || task.maintainerId !== maintainerId || task.state !== "running") return;
    if (p.outcome === "aborted") return;
    const d = draft(task);
    if (p.outcome === "completed") {
      if (plainInputsLeft(task)) return;
      completePlain(d);
      return commit(d);
    }
    const why = plainStuckNote(p.outcome, p.error);
    apply(d, "waiting", "system", (t) => ({ ...t, state: "waiting_for_user", waitReason: "stuck", waitNote: why }));
    addNotice(d, {
      notice: "stuck_help",
      title: `卡住求助：${task.title}`,
      body: `普通任务「${task.title}」${why}。`,
      actions: [STUCK_HELP_ACTIONS.resume],
      data: { taskId: task.id },
    });
    commit(d);
  };

  /**
   * 做完了的普通任务又来了输入（75 号票）：用户在任务详情里接着说了（项目内部的：带着它的编号，网关按用户在哪个任务的详情里说的认），
   * 或者运行时交给它的 agent 一条通知（事后批准了一次调用、交给我做的事用户做完了……，只认任务自己的 agent 的会话）：
   * 任务回到执行中接着做（名额满了、项目的维护者正忙时回到排队中），它的话就是交给 agent 的输入
   */
  const onPlainInput = (maintainerId: string, payload: MessageEventPayload) => {
    const user = payload.message.speaker === "user";
    if (!user && payload.agentInput !== true) return;
    const task = payload.taskId !== undefined ? tasks.get(payload.taskId) : ownTaskOf(maintainerId);
    if (!task || !isPlainTask(task) || task.state !== "done" || task.maintainerId !== maintainerId) return;
    // 项目的维护者的会话里同时有几件事：带着这个任务编号的运行时通知（工单段收尾时催写回）不算接着说
    if (isProjectInternal(task) && !user) return;
    const d = draft(task);
    resume(d, "user", "continued");
    commit(d);
  };

  /**
   * 恢复执行（继续、一支不用再等了、重试、返工）：有名额回到执行中，满了回到排队中（记成 requeued；从某个阶段重做的照样记成
   * rework，84 号票：看板上的重做记录、重开了哪几个只看这一条）。项目的任务还要项目的维护者能接（16 号票）：正忙时同样回到排队中
   */
  const resume = (d: Draft, by: TaskActor, change: TaskChange, edit: (t: Task) => Task = (t) => t) => {
    if (hasSlot(d.task.id)) {
      const admitted = admit(d.task);
      d.events.push(...admitted.events);
      if (admitted.admit) return enterRunning(d, by, change, edit);
    }
    apply(d, change === "rework" ? "rework" : "requeued", by, (t) => ({ ...cleared(edit(t)), state: "queued" }));
  };

  /**
   * 一支有了结论之后（验收、退回、不用再等了）：在等我的恢复执行（维护者自己说的等我、中断不确定的除外，declared 在这一支有结论之前算），
   * 全验收了就完成；执行中的看下一步
   */
  const proceed = (d: Draft, by: TaskActor, declared: boolean) => {
    if (d.task.state === "running") return settle(d);
    if (d.task.state !== "waiting_for_user") return;
    if (allAccepted(listOf(d.task))) return complete(d);
    // 中断不确定（23 号票）是整个任务的，等用户定夺；别的分支有了结论也不自己恢复
    if (!declared && d.task.waitReason !== "interrupted") resume(d, by, "resumed");
  };

  /** 交给维护者的通知后面接上这次开始的阶段（交代、授权、边界） */
  const withStarted = (d: Draft, text: string) => (d.startedStage && d.task.state === "running" ? `${text}\n${stageText(handoff(d.task, d.startedStage))}` : text);

  /** 一个阶段有了结论之后接下来做什么 */
  const nextUp = (d: Draft): NextUp => {
    if (d.completed) return { kind: "completed" };
    if (d.startedStage && d.task.state === "running") return { kind: "stage", stage: handoff(d.task, d.startedStage) };
    if (d.task.state === "waiting_for_user") return { kind: "waiting", reason: d.task.waitReason ?? "acceptance" };
    return { kind: "continue" };
  };

  // ───────────────────────── 排队与名额 ─────────────────────────

  /** 名额空出时，排在最前的排队中任务开始执行；项目的任务要项目的维护者空着（正忙时跳过它，留在排队中） */
  const fill = () => {
    fillQueued = false;
    for (const task of tasks.queued()) {
      // 每开始一个，名额现数一次（任务进入执行中和占名额在同一事务里）
      if (!options.slots.hasSlot()) return;
      // 普通任务（75 号票）没有计划，排到了就开始
      if (!isPlainTask(task) && !confirmedPlan(task.id)) {
        log(`任务 ${task.id} 在排队，但没有确认过的计划，不能开始`);
        continue;
      }
      try {
        const admitted = admit(task);
        if (!admitted.admit) {
          if (admitted.events.length > 0) store.appendBatch(admitted.events);
          continue;
        }
        const d = draft(task);
        d.events.push(...admitted.events);
        enterRunning(d, "system", "started");
        commit(d);
      } catch (err) {
        log(`任务 ${task.id} 开始执行出错：${errorText(err)}`);
      }
    }
  };

  const scheduleFill = () => {
    if (fillQueued) return;
    fillQueued = true;
    queueMicrotask(fill);
  };

  // ───────────────────────── 一支停下、接着走 ─────────────────────────

  /** 某个阶段的这一支停下等用户（审批挂起、交给我做）：不依赖它的阶段接着推进，都在等就转等我 */
  const branchWaits = (taskId: string, stageId: string | null, reason: TaskWaitReason, waitingOn: string, what: string) => {
    const task = tasks.get(taskId);
    if (!task || (task.state !== "running" && task.state !== "waiting_for_user")) return;
    const list = listOf(task);
    // 调用所在的阶段（没有阶段时算当前在做的那个）
    const stage = (stageId ? findStage(list, stageId) : undefined) ?? list.find((s) => s.state === "running");
    if (!stage || (stage.state !== "running" && stage.state !== "pending")) return;
    const d = draft(task);
    applyStage(d, "stage_waiting", "system", stage.stageId, (s) => stageWaiting(s, reason, waitingOn));
    settle(d);
    if (d.startedStage) notify(d, noticeText.branchWaits(stage, what, handoff(d.task, d.startedStage)));
    else if (d.task.state === "waiting_for_user") note(d, `所有能推进的阶段都在等你（${TASK_WAIT_REASON_LABEL[reason]}：${what}），任务转等我。`);
    commit(d);
  };

  /**
   * 这一支停下找用户（14 号票：阈值超了、标了做不了、超预算）：待我处理里放一条事项（卡住求助 / 超预算，卡着任务），
   * 这几个阶段转等我（写明为什么），别的能推进就接着推进，都在等就转等我；维护者收到通知（排在手头这一条之后），
   * 时间线上记一笔偏离
   */
  const stopBranch = (d: Draft, stages: readonly TaskStage[], reason: BranchStopReason, by: TaskActor = "system"): InboxItem => {
    const task = d.task;
    const ids = stages.map((s) => s.stageId);
    const names = stages.map((s) => stageName(task, s)).join("、");
    const why = stopReasonText(reason);
    const waitReason: TaskWaitReason = reason.kind === "over_budget" ? "over_budget" : "stuck";
    const item = addNotice(
      d,
      waitReason === "over_budget"
        ? {
            notice: "over_budget",
            title: `超预算：${task.title}`,
            body: `任务「${task.title}」${names}${why}，这一支先停下。\n看过之后点"${OVER_BUDGET_ACTIONS.resume}"（这个阶段从现在起重新给一整份预算），或者在任务详情里暂停、取消任务。`,
            actions: [OVER_BUDGET_ACTIONS.resume],
            data: { taskId: task.id, stageIds: ids },
          }
        : {
            notice: "stuck_help",
            title: `卡住求助：${task.title}`,
            body: `任务「${task.title}」${names}${why}，这一支先停下等你拍板。\n在任务详情里回维护者，或者做完它要的事后点"${STUCK_HELP_ACTIONS.resume}"。`,
            actions: [STUCK_HELP_ACTIONS.resume],
            data: { taskId: task.id, stageIds: ids },
          },
    );
    apply(d, "stage_waiting", by, (t) => withList(t, listOf(t).map((s) => (ids.includes(s.stageId) ? stageWaiting(s, waitReason, item.id, why) : s))), ids[0]);
    record(d, "deviation", `${names}停下等你（${TASK_WAIT_REASON_LABEL[waitReason]}）：${why}`, { stageId: ids[0]! });
    settle(d);
    notify(d, noticeText.branchStopped(stages.map(ref), reason, d.startedStage && d.task.state === "running" ? handoff(d.task, d.startedStage) : undefined));
    return item;
  };

  /**
   * 一次验收退回（14 号票：脚本、评审没通过；17 号票：多项目任务的工单被退回、做不了，任务维护者调整做法）：阶段的退回计数加 1
   * （patch 顺带改阶段的别的），after 里追加这次退回的说明；超了阈值（退回 2 次、第 3 次还不过）这一支停下找用户（卡住求助）
   */
  const acceptanceReturn = (d: Draft, stageId: string, by: TaskActor, judged: string, extra: { patch?: (s: TaskStage) => TaskStage; after?: () => void } = {}): { returns: number; stuck: boolean } => {
    const returns = (findStage(listOf(d.task), stageId)?.returns ?? 0) + 1;
    applyStage(d, "stage_returned", by, stageId, (s) => ({ ...(extra.patch ? extra.patch(s) : s), returns }));
    extra.after?.();
    if (returns <= thresholds.acceptanceReturns) return { returns, stuck: false };
    stopBranch(d, [findStage(listOf(d.task), stageId)!], { kind: "acceptance", returns, judged });
    return { returns, stuck: true };
  };

  /** 超预算的阶段接着走：从现在起重新给一整份预算（工具调用次数从现在的起算，token 从账本里这时的数起算） */
  const budgetReset = (d: Draft, stageId: string) => {
    const payload: BudgetResetPayload = { taskId: d.task.id, stageId, baseTokens: options.stageTokens(d.task.id, stageId), time: now() };
    d.events.push({ channel: TASKS_CHANNEL, type: TASK_EVENTS.budgetReset, payload });
  };

  /**
   * 这一支不用再等了（批准或拒绝了、交给我做的事做完了、用户让卡住或超预算的这一支接着走）：在等它的阶段回到能开始，接着走。
   * 卡住求助、超预算的计数清零（超预算的再给一份预算）。
   * 维护者自己的调用批准了（approvedFor 是发起调用的 agent）、可它正在做别的阶段：通知它先切回去再重试（授权和调用指纹按阶段）；
   * 子 agent 的调用批准了，通知由子 agent 那边给（sub-agents/texts.ts 的 lateDecisionText），这里不再说
   */
  const branchUnblocked = (waitingOn: string, approvedFor?: string) => {
    const task = tasks.list().find((t) => listOf(t).some((s) => s.state === "waiting" && s.waitingOn === waitingOn));
    if (!task) return;
    const stages = listOf(task).filter((s) => s.state === "waiting" && s.waitingOn === waitingOn);
    const declared = declaredWait(task, busyOf(task.id));
    const d = draft(task);
    for (const stage of stages) {
      if (stage.waitReason === "over_budget") budgetReset(d, stage.stageId);
      applyStage(d, "stage_unblocked", "user", stage.stageId, (s) => (userResolved(s) ? countersCleared(stageNow(s, "pending")) : stageNow(s, "pending")));
    }
    proceed(d, "system", declared);
    const resolved = stages.filter(userResolved);
    if (resolved.length > 0) notify(d, withStarted(d, noticeText.branchResumed(resolved)));
    const current = d.task.state === "running" ? currentOf(d.task) : undefined;
    const active = current && (current.state === "running" || current.state === "accepting") ? current : undefined;
    const stage = stages[0]!;
    if (approvedFor === task.maintainerId && active && active.stageId !== stage.stageId) {
      notify(d, noticeText.approvedElsewhere(stage, { stageId: active.stageId, title: active.title, accepting: active.state === "accepting" }));
    }
    commit(d);
  };

  const onSuspended = (p: ApprovalSuspendedPayload) => {
    if (p.origin.taskId === null) return;
    branchWaits(p.origin.taskId, p.origin.stageId, "approval", p.approvalId, "等用户批准");
  };

  const onDecided = (p: ApprovalDecidedPayload) => {
    if (p.origin.taskId === null) return;
    // 决定时调用还在等的直接接着执行或拦下，这一支没停过
    if (!p.resumed) branchUnblocked(p.approvalId, p.decision === "approved" ? p.origin.agentId : undefined);
    // 用户拒绝了一次：累计被拒次数加 1（14 号票）
    if (p.decision === "denied") {
      const task = tasks.get(p.origin.taskId);
      if (!task) return;
      const d = draft(task);
      countRejection(d);
      commit(d);
    }
  };

  const onInboxItem = (item: InboxItem) => {
    if (item.kind !== "notice" || item.notice !== "hand_over") return;
    const data = item.data as Partial<HandOverData> | undefined;
    const taskId = data?.origin?.taskId;
    if (!taskId) return;
    if (item.version === 1 && item.handled === undefined) {
      branchWaits(taskId, data.origin?.stageId ?? null, "hand_over", item.id, `等你亲手做「${data.toolTitle ?? data.tool ?? ""}」`);
    } else if (item.handled === HAND_OVER_DONE) {
      branchUnblocked(item.id);
    }
  };

  // ───────────────────────── 阈值：拉回、催促、预算、被拒（14 号票） ─────────────────────────

  /** 维护者被拉回一次：这一支的拉回次数加 1，满了再犯就停下找用户 */
  const onPulledBack = (p: PulledBackPayload) => {
    if (p.origin.taskId === null) return;
    const task = tasks.get(p.origin.taskId);
    if (task?.state !== "running") return;
    const list = listOf(task);
    const stage = (p.origin.stageId ? findStage(list, p.origin.stageId) : undefined) ?? currentOf(task);
    if (stage?.state !== "running") return;
    const n = (stage.pullBacks ?? 0) + 1;
    const d = draft(task);
    applyStage(d, "pulled_back", "system", stage.stageId, (s) => ({ ...s, pullBacks: n }));
    if (n > thresholds.pullBacks) stopBranch(d, [findStage(listOf(d.task), stage.stageId)!], { kind: "pull_backs", count: n, tool: p.tool, ruleIds: [...p.ruleIds] });
    commit(d);
  };

  /** 停滞了（stall.ts 判的：维护者活着、它手头的阶段在做、stallMs 内没有进展）：催一次（正在干活时以插话送达）；催满了这一支停下 */
  const onStall = (taskId: string) => {
    const task = tasks.get(taskId);
    const active = task?.state === "running" ? workingStage(task) : undefined;
    if (!task || !active) return;
    const minutes = Math.round(thresholds.stallMs / 60_000);
    const step = nextNudge(active, thresholds.nudges);
    const d = draft(task);
    if (step.kind === "stop") {
      stopBranch(d, [active], { kind: "stall", minutes, nudges: step.nudges });
    } else {
      applyStage(d, "nudged", "system", active.stageId, (s) => ({ ...s, nudges: step.n }));
      notify(d, noticeText.nudge(ref(active), minutes, step.n, thresholds.nudges), true);
      record(d, "deviation", `${stageName(task, active)} ${minutes} 分钟没有进展，催了第 ${step.n} 次`, { stageId: active.stageId });
    }
    // 下一段停滞从现在算
    stall.restart(taskId);
    commit(d);
  };

  const stall = createStallWatch({ tasks, clock, scheduler, stallMs: thresholds.stallMs, working: workingStage, alive: (task) => options.agentAlive(task.maintainerId), onStall });

  /** 有了进展（成功的工具调用、阶段推进）：在做的、能接着做的阶段催促计数清零 */
  const clearNudges = (taskId: string) => {
    const task = tasks.get(taskId);
    if (task?.state !== "running") return;
    const nudged = listOf(task).filter((s) => (s.nudges ?? 0) > 0 && s.state !== "waiting");
    if (nudged.length === 0) return;
    const d = draft(task);
    const ids = nudged.map((s) => s.stageId);
    apply(d, "progressed", "system", (t) => withList(t, listOf(t).map((s) => (ids.includes(s.stageId) ? nudgesCleared(s) : s))), ids[0]);
    commit(d);
  };

  /** 一个阶段这一份预算里的用量：token 取自账本（减去起算点），工具调用次数取自预算记账 */
  const stageSpend = (taskId: string, stageId: string): { used: StageSpend; warned: boolean } => {
    const usage = tasks.stageUsage(taskId, stageId);
    return { used: { tokens: Math.max(0, options.stageTokens(taskId, stageId) - usage.baseTokens), toolCalls: usage.toolCalls }, warned: usage.warned };
  };

  /**
   * 用量超过预算让维护者说明进展（只说一次）；超过预算的 budgetAskTimes 倍这一支停下（超预算）。
   * 预算控制关着（93 号票，默认）时什么都不做：用量照旧记在预算账上（阶段详情照旧显示用了多少），超了不说明、不停下
   */
  const checkBudget = (taskId: string, stageId: string) => {
    if (!thresholds.budgetControl) return;
    const task = tasks.get(taskId);
    const stage = task ? findStage(listOf(task), stageId) : undefined;
    const planned = task ? confirmedPlan(taskId)?.plan.stages.find((s) => s.stageId === stageId) : undefined;
    if (!task || !stage || !planned || task.state !== "running" || (stage.state !== "running" && stage.state !== "accepting")) return;
    const { used, warned } = stageSpend(taskId, stageId);
    const budget: StageSpend = { tokens: planned.budget.tokens, toolCalls: planned.budget.toolCalls };
    const ratio = budgetRatio(used, budget);
    if (ratio > thresholds.budgetAskTimes) {
      const d = draft(task);
      stopBranch(d, [stage], { kind: "over_budget", used, budget, times: thresholds.budgetAskTimes });
      commit(d);
      return;
    }
    if (ratio > thresholds.budgetExplainTimes && !warned) {
      const d = draft(task);
      const mark: BudgetMarkPayload = { taskId, stageId, time: now() };
      d.events.push({ channel: TASKS_CHANNEL, type: TASK_EVENTS.budgetWarned, payload: mark });
      notify(d, noticeText.budgetExplain(ref(stage), { used, budget }, thresholds.budgetAskTimes));
      record(d, "deviation", `${stageName(task, stage)}的用量超过预算：${spendText(used, budget)}，让维护者说明进展`, { stageId });
      commit(d);
    }
  };

  /**
   * 任务里的工具调用记录（维护者和它的子 agent 的，都记在维护者的会话里，带着调用时的阶段）：工具调用次数记到那个阶段的预算上。
   * 被拦下的调用也算一次
   */
  // ───────────────────────── 流程的一轮（59 号票，workflow-run.ts） ─────────────────────────

  /**
   * 流程的维护者处理一条输入算一轮（AgentSense 的一次 run）；收尾提醒替它补的那条输入接着同一轮。这一轮调用了几次步骤能用的工具
   * （不算 report_step 这些推进流程的工具）、提醒过没有：只在内存里（AgentSense 的总账也一样，一轮一份）
   */
  const workflowRuns = new Map<string, { actions: number; nudged: boolean }>();
  const runOf = (taskId: string) => {
    let run = workflowRuns.get(taskId);
    if (!run) workflowRuns.set(taskId, (run = { actions: 0, nudged: false }));
    return run;
  };

  /** 会话里一条工具调用记录：流程里步骤能用的工具（计划的注册表里登记了的）算这一轮做了一件事 */
  const countWorkflowActions = (p: MessageEventPayload) => {
    if (p.taskId === undefined) return;
    const task = tasks.get(p.taskId);
    if (!task || taskKind(task) !== "workflow") return;
    const n = p.message.parts.filter((part) => part.type === "tool_call" && findTool(options.planTools, part.tool) !== undefined).length;
    if (n > 0) runOf(task.id).actions += n;
  };

  /**
   * 流程的维护者一轮结束（照 AgentSense runtime.ts 的 before_run_end 和 sessionView.ts 的推断）：
   * - 这一轮做了事、还有既没执行也没说明跳过的步骤、这一轮还没提醒过：提醒维护者一次（会话里一条通知，时间线记一笔偏离）；
   * - 否则这一轮就收工了：报着"在做"的、执行过却没报的步骤推断成做完；步骤都做完或说明跳过时流程完成。
   * 出错、被中止、被打断的那一轮不算收工；流程那一支在等用户（审批挂起、卡住求助）时不提醒
   */
  const onTurnEnded = (channel: string, p: TurnEndEventPayload) => {
    const maintainerId = channel.slice(MAINTAINER_CHANNEL_PREFIX.length);
    const task = tasks.list().find((t) => t.maintainerId === maintainerId && taskKind(t) === "workflow" && t.state === "running");
    if (!task) return;
    const run = runOf(task.id);
    const input = getMessage(store.reader, p.inputMessageId);
    const nudgeTurn = input?.parts.some((part) => part.type === "text" && part.text.startsWith(NUDGE_PREFIX)) === true;
    // 不是提醒接着的那一轮：这一轮是新的一轮，还没提醒过
    if (!nudgeTurn) run.nudged = false;
    const actions = run.actions;
    run.actions = 0;
    if (p.outcome !== "completed") return;
    const stored = confirmedPlan(task.id);
    if (!stored?.workflow || findStage(listOf(task), WORKFLOW_STAGE_ID)?.state !== "running") return;
    const history = planHistory(store, task.id, stored.planId);
    const pending = planPending(guardWorkflow(stored.planId, stored.workflow, task), history);
    if (!run.nudged && actions > 0 && pending.length > 0) {
      run.nudged = true;
      const nudge = nudgeOf(stored.workflow, pending);
      const d = draft(task);
      notify(d, nudge.text);
      record(d, "deviation", `自动纠偏：${nudge.correction.text}`, { detail: pending.map((f) => f.message).join("；") });
      commit(d);
      return;
    }
    settleSteps(task, stepsAtFinish(task.steps?.list ?? [], executedSteps(history)), "system");
  };

  /**
   * 换上新的步骤状态（汇报的、推断的）：步骤都做完或说明跳过，流程的那个阶段算完成，流程完成（不逐步验收）。
   * 没有变化时什么都不追加；返回做完了几步、一共几步、流程完成了没有
   */
  const settleSteps = (task: Task, next: TaskStep[], by: "maintainer" | "system"): { done: number; total: number; completed: boolean } => {
    const done = next.filter((s) => SETTLED_STEP_STATES.includes(s.state)).length;
    if (by === "system" && JSON.stringify(next) === JSON.stringify(task.steps?.list ?? [])) return { done, total: next.length, completed: false };
    const d = draft(task);
    apply(d, by === "maintainer" ? "step_reported" : "steps_inferred", by, (t) => ({ ...t, steps: { total: next.length, done, list: next } }));
    if (done === next.length) {
      if (findStage(listOf(d.task), WORKFLOW_STAGE_ID)?.state !== "accepted") applyStage(d, "stage_accepted", "system", WORKFLOW_STAGE_ID, (s) => ({ ...s, state: "accepted" }));
      if (allAccepted(listOf(d.task))) complete(d);
    }
    commit(d);
    return { done, total: next.length, completed: d.completed };
  };

  const onToolCallRecord = (p: MessageEventPayload) => {
    countWorkflowActions(p);
    const calls = p.message.parts.filter((part) => part.type === "tool_call").length;
    if (calls === 0 || p.taskId === undefined || p.stageId === undefined) return;
    const task = tasks.get(p.taskId);
    if (!task || (task.state !== "running" && task.state !== "waiting_for_user") || !findStage(listOf(task), p.stageId)) return;
    const payload: BudgetUsedPayload = { taskId: task.id, stageId: p.stageId, toolCalls: calls, time: now() };
    store.append({ channel: TASKS_CHANNEL, type: TASK_EVENTS.budgetUsed, payload });
    checkBudget(task.id, p.stageId);
  };

  /** 用户拒绝了一次（审批、计划变更）：累计被拒次数加 1，满了整个任务转已暂停（系统，写明原因）；返回是不是暂停了 */
  const countRejection = (d: Draft): boolean => {
    const state = d.task.state;
    if (ENDED_TASK_STATES.includes(state)) return false;
    const n = (d.task.rejections ?? 0) + 1;
    if (n < thresholds.rejections || (state !== "running" && state !== "waiting_for_user" && state !== "queued")) {
      apply(d, "rejection_counted", "system", (t) => ({ ...t, rejections: n }));
      return false;
    }
    apply(d, "paused", "system", (t) => ({ ...t, state: "paused", rejections: n, pauseReason: "too_many_rejections" }));
    record(d, "deviation", `你累计拒绝了 ${n} 次（审批、计划变更），任务先暂停：看过之后可以继续，或者取消任务`);
    return true;
  };

  // ───────────────────────── 计划变更、自行调整计划、做不了（14 号票） ─────────────────────────

  /** 维护者交来的计划合上沿用的几样、过一遍检查；碰了已验收的阶段、去掉了在等用户或在验收的阶段都不行 */
  const revised = (task: Task, stored: StoredPlan, draftPlan: PlanDraft): Plan => {
    const merged = mergeDraft(stored.plan, draftPlan);
    const checked = checkRevisedPlan(merged, options.planTools, options.toolkitProblems);
    // 涉及的项目要对得上任务（17 号票评审后定）
    const problems = checked.ok ? (options.planProjects?.(task, checked.plan) ?? []) : checked.problems;
    if (!checked.ok || problems.length > 0) throw new RequestRejected("bad_params", `新的计划没通过检查，改好再交：\n- ${problems.join("\n- ")}`);
    const list = listOf(task);
    const touched = touchedAcceptedStages(stored.plan, checked.plan, list);
    if (touched.length > 0) throw new RequestRejected("not_allowed", `已验收的阶段 ${touched.join("、")} 不能改（要改让用户在任务详情里返工）`);
    const busy = list.filter((s) => (s.state === "waiting" || s.state === "accepting") && !checked.plan.stages.some((p) => p.stageId === s.stageId));
    if (busy.length > 0) throw new RequestRejected("not_allowed", `阶段 ${busy.map((s) => s.stageId).join("、")} 在等用户或在验收，不能去掉`);
    // 编号（93 号票，照 AgentSense 计划调整时"已有的不改名，新加的按它所在的阶段编"）：已有的阶段沿用现在生效的那一版的号，
    // 新加的按依赖层给号，不用之前几版用过的号
    return withStageCodes(checked.plan, stored.plan, tasks.usedStageCodes(task.id));
  };

  /** 还在等用户的计划变更（同一任务一次只有一张） */
  const pendingChangeRefusal = (taskId: string) => {
    const pending = tasks.proposedPlan(taskId);
    if (pending) throw new RequestRejected("not_allowed", `上一张计划变更卡（${pending.planId}）还在等用户，先等它有结论`);
  };

  /** 下一版计划的编号 */
  const nextRevision = (taskId: string) => {
    const revision = (tasks.latestPlan(taskId)?.revision ?? 0) + 1;
    return { revision, planId: `${taskId}-p${revision}` };
  };

  const proposePlanChange = (scope: MaintainerScope, input: PlanChangeInput): PlanChangeProposal => {
    const why = input.why.trim();
    if (!why) throw new RequestRejected("bad_params", "计划变更要写明为什么改（用户在卡上看得到）");
    const task = mustExecute(scope, ["running", "waiting_for_user"]);
    const stored = confirmedPlan(task.id)!;
    pendingChangeRefusal(task.id);
    const plan = revised(task, stored, input.plan);
    const brief = tasks.brief(task.id)?.brief;
    const changes = diffPlan({
      before: stored.plan,
      after: plan,
      tools: options.planTools,
      ...(input.goal !== undefined ? { goal: { before: brief?.goal ?? task.summary, after: input.goal } } : {}),
      ...(input.acceptanceCriteria !== undefined ? { criteria: { before: brief?.acceptanceCriteria ?? [], after: input.acceptanceCriteria } } : {}),
    });
    if (changes.length === 0) throw new RequestRejected("bad_params", "和当前计划一样，没有要改的");
    if (expanding(changes).length === 0) {
      throw new RequestRejected("not_allowed", `这些改动不扩大授权，也不改目标、验收：直接用 ${EXECUTION_TOOL.revisePlan} 自行调整计划（不出卡，记进时间线）`);
    }
    const list = listOf(task);
    const unknown = (input.stages ?? []).filter((id) => !findStage(list, id));
    if (unknown.length > 0) throw new RequestRejected("bad_params", `没有这些阶段：${unknown.join("、")}`);
    const affected = affectedStages(changes, plan, list, input.stages ?? [], currentOf(task).stageId);
    const { revision, planId } = nextRevision(task.id);
    const affectedRefs = affected.map((id) => ref(findStage(list, id)!));
    const payload: PlanChangeCardPayload = {
      taskId: task.id,
      taskTitle: task.title,
      planId,
      revision,
      basePlanId: stored.planId,
      why,
      changes,
      affectedStages: affectedRefs,
      plan,
      grantInfo: grantInfoFor(plan),
    };
    const card = cards.buildCreate({ type: "plan_change", urgency: "blocking", payload });
    const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: oneLine(`计划变更等你确认：${task.title}`, 60), ...taskInboxOrigin(task), urgency: "blocking" });
    const proposed: PlanChangeProposedPayload = {
      taskId: task.id,
      planId,
      revision,
      basePlanId: stored.planId,
      plan,
      changes,
      affectedStages: affected,
      why,
      cardId: card.card.id,
      maintainerId: scope.maintainerId,
      time: now(),
    };
    const d = draft(task);
    d.events.push({ channel: TASKS_CHANNEL, type: TASK_EVENTS.planChangeProposed, payload: proposed }, card.event, item.event);
    d.alerts.push(item.item);
    apply(d, "plan_change_proposed", "maintainer", (t) => withList(t, listOf(t).map((s) => (affected.includes(s.stageId) ? stageWaiting(s, "plan_change", card.card.id, why) : s))));
    settle(d);
    commit(d);
    return { cardId: card.card.id, planId, changes, affected: affectedRefs, next: nextUp(d) };
  };

  /**
   * 计划变更卡上的动作能不能做：这一版还在等用户，任务还没结束。proposal 是确认时用的那一版（卡出来之后用户直接改过工具包的，带上那些改动），
   * after 是那时它要记成的新一版（没改过的为 undefined）
   */
  const pendingChange = (payload: PlanChangeCardPayload): { task: Task; stored: StoredPlan; base: StoredPlan; proposal: StoredPlan; after: { planId: string; revision: number } | undefined } => {
    const stored = tasks.plan(payload.planId);
    const task = tasks.get(payload.taskId);
    if (!stored || !task) throw new RequestRejected("not_found", `没有这版计划：${payload.planId}`);
    if (stored.status !== "proposed") throw new RequestRejected("conflict", "这张计划变更卡已经处理过了");
    if (ENDED_TASK_STATES.includes(task.state)) throw new RequestRejected("not_allowed", `任务已经${TASK_STATE_LABEL[task.state]}，计划变更不再生效`);
    const base = confirmedPlan(task.id);
    if (!base) throw new RequestRejected("conflict", "计划在这之后又改过了，这张计划变更卡不再生效");
    if (base.planId === payload.basePlanId) return { task, stored, base, proposal: stored, after: undefined };
    // 卡出来之后用户只直接改过工具包（27 号票：有计划变更卡在等时可以收窄、增减 skill）：照样能处理，确认的这一版带上那些改动
    const original = tasks.plan(payload.basePlanId);
    if (!original || !onlyToolkitDiffers(original.plan, base.plan)) throw new RequestRejected("conflict", "计划在这之后又改过了，这张计划变更卡不再生效");
    const toolkit = withCapabilities(withoutCapabilities(stored.plan.toolkit, toolkitRemoved(original.plan.toolkit, base.plan.toolkit)), toolkitAdded(original.plan.toolkit, base.plan.toolkit));
    return { task, stored, base, proposal: { ...stored, plan: { ...stored.plan, toolkit } }, after: nextRevision(task.id) };
  };

  const confirmPlanChange = (payload: PlanChangeCardPayload, input: PlanConfirmInput, idempotencyKey: string): CardActionEffect<PlanChangeCardPayload> => {
    const { task, stored, base, proposal, after } = pendingChange(payload);
    const at = clock.now();
    const confirmed = planConfirmation({ task, stored: proposal, choice: input, grantInfo: payload.grantInfo, tools: options.planTools, settings: readWatchSettings(options.watchSettings), time: nowIso(new Date(at)) });
    const { plan, narrowing, grantInfo } = confirmed;
    const grantTimes = grantTimesAfter({ before: base.plan, beforeTimes: base.grantTimes, beforeConfirmedAt: confirmedAtOf(base, at), after: plan, at, tools: options.planTools });
    const declared = declaredWait(task, busyOf(task.id));
    const d = draft(task);
    d.events.push({
      channel: TASKS_CHANNEL,
      type: TASK_EVENTS.planDecided,
      payload: { ...confirmed.decided, change: { why: payload.why, changes: payload.changes, basePlanId: base.planId }, grantTimes: isoTimes(grantTimes) },
      idempotencyKey: `${idempotencyKey}#decided`,
    });
    // 改了目标或任务的验收标准：任务书换成新的一版（重注入块、下一次比较都用它）
    const goal = payload.changes.find((c) => c.kind === "goal");
    const criteria = payload.changes.find((c) => c.kind === "criteria");
    if (goal || criteria) d.events.push(tasks.buildBriefRevision(task.id, { ...(goal ? { goal: goal.after } : {}), ...(criteria ? { acceptanceCriteria: criteria.after } : {}) }));
    // 计划和阶段跟着新的一版：等这张卡的阶段回到能开始，新加的阶段未开始，去掉的不要了；任务详情的计划取这张卡
    const list = stagesAfter(listOf(task), plan).map((s) => (s.state === "waiting" && s.waitingOn === stored.cardId ? stageNow(s, "pending") : s));
    apply(d, "plan_changed", "user", (t) => ({ ...withPlanList(t, list), planCardId: stored.cardId }));
    // 卡出来之后用户直接改过工具包：那几版排在这张卡后面，确认的这一版再记成最新的一版，现在生效的才是它
    if (after) {
      const revisedAfter: PlanRevisedPayload = {
        taskId: task.id,
        planId: after.planId,
        revision: after.revision,
        basePlanId: stored.planId,
        plan,
        changes: [],
        why: payload.why,
        grantTimes: isoTimes(grantTimes),
        maintainerId: task.maintainerId,
        time: nowIso(new Date(at)),
      };
      d.events.push({ channel: TASKS_CHANNEL, type: TASK_EVENTS.planRevised, payload: revisedAfter });
    }
    planEvent(d, after ? { ...after, plan } : { planId: stored.planId, revision: stored.revision, plan }, grantInfo);
    record(d, "plan_change", `你确认了计划变更（第 ${stored.revision} 版）：${payload.why}`, { detail: changeLines(payload.changes, grantInfo) });
    proceed(d, "system", declared);
    const toolkitChanged = !sameToolkit(base.plan.toolkit, plan.toolkit);
    notify(
      d,
      withStarted(
        d,
        noticeText.planChangeConfirmed({
          changes: payload.changes.map((c) => planChangeItemText(c, grantInfo)),
          removed: narrowing.removed.map((g) => g.title),
          narrowed: narrowing.narrowed,
          toolkit: toolkitChanged ? { added: toolkitAdded(base.plan.toolkit, plan.toolkit).map(capabilityText), after: plan.toolkit } : undefined,
          resumed: payload.affectedStages,
        }),
      ),
    );
    const added = narrowing.added ?? [];
    return {
      // 工具包变了：事件落盘之后活着的子 agent 跟着重新装配（维护者自己的由维护者模块看到任务变化后换）
      ...(toolkitChanged && options.toolkitChanged ? { afterCommit: () => options.toolkitChanged?.(task.id) } : {}),
      status: "handled",
      payload: {
        ...payload,
        plan,
        grantInfo,
        ...(narrowing.removed.length > 0 ? { removedGrants: narrowing.removed } : {}),
        ...(narrowing.narrowed.length > 0 ? { narrowedGrants: narrowing.narrowed } : {}),
        ...(added.length > 0 ? { addedCategories: added.map((c) => c.id) } : {}),
      },
      ...(confirmed.note ? { note: confirmed.note } : {}),
      events: d.events,
    };
  };

  const rejectPlanChange = (payload: PlanChangeCardPayload, why: string | undefined, idempotencyKey: string): CardActionEffect<PlanChangeCardPayload> => {
    const { task, stored, base } = pendingChange(payload);
    const comment = why?.trim() || undefined;
    const declared = declaredWait(task, busyOf(task.id));
    const d = draft(task);
    d.events.push({
      channel: TASKS_CHANNEL,
      type: TASK_EVENTS.planDecided,
      payload: {
        taskId: task.id,
        taskTitle: task.title,
        planId: stored.planId,
        revision: stored.revision,
        cardId: stored.cardId,
        decision: "rejected",
        removedGrants: [],
        narrowedGrants: [],
        grantInfo: payload.grantInfo,
        ...(comment ? { note: comment } : {}),
        change: { why: payload.why, changes: payload.changes, basePlanId: base.planId },
        by: "user",
        time: now(),
      },
      idempotencyKey: `${idempotencyKey}#decided`,
    });
    // 受影响的阶段交回维护者：在现有授权内重排，做不到再标做不了
    const waiting = listOf(task).filter((s) => s.state === "waiting" && s.waitingOn === stored.cardId);
    apply(d, "plan_change_rejected", "user", (t) => withList(t, listOf(t).map((s) => (waiting.some((w) => w.stageId === s.stageId) ? stageNow(s, "pending") : s))));
    record(d, "plan_change", `你拒绝了计划变更（第 ${stored.revision} 版），受影响的阶段交回维护者在现有授权内重排`, { detail: changeLines(payload.changes, payload.grantInfo) });
    const paused = countRejection(d);
    if (!paused) proceed(d, "system", declared);
    notify(d, withStarted(d, noticeText.planChangeRejected(comment, waiting)));
    return { status: "handled", ...(comment ? { note: comment } : {}), events: d.events };
  };

  const revisePlan = (scope: MaintainerScope, input: PlanDraftInput): PlanRevision => {
    const why = input.why.trim();
    if (!why) throw new RequestRejected("bad_params", "自行调整计划要写明为什么（记进任务时间线）");
    const task = mustExecute(scope, ["running", "waiting_for_user"]);
    const stored = confirmedPlan(task.id)!;
    pendingChangeRefusal(task.id);
    const plan = revised(task, stored, input.plan);
    const changes = diffPlan({ before: stored.plan, after: plan, tools: options.planTools });
    if (changes.length === 0) throw new RequestRejected("bad_params", "和当前计划一样，没有要改的");
    const grantInfo = grantInfoFor(plan);
    const widening = expanding(changes);
    if (widening.length > 0) {
      throw new RequestRejected(
        "not_allowed",
        [
          "这些改动扩大了授权、或者改了目标、验收，不能自行调整：",
          ...widening.map((c) => `- ${planChangeItemText(c, grantInfo)}`),
          `要这样改就用 ${EXECUTION_TOOL.proposePlanChange} 提交计划变更（用户确认后生效）；运行中的授权项只能收窄。`,
        ].join("\n"),
      );
    }
    const at = clock.now();
    const grantTimes = grantTimesAfter({ before: stored.plan, beforeTimes: stored.grantTimes, beforeConfirmedAt: confirmedAtOf(stored, at), after: plan, at, tools: options.planTools });
    const { revision, planId } = nextRevision(task.id);
    const payload: PlanRevisedPayload = { taskId: task.id, planId, revision, basePlanId: stored.planId, plan, changes, why, grantTimes: isoTimes(grantTimes), maintainerId: scope.maintainerId, time: nowIso(new Date(at)) };
    const d = draft(task);
    d.events.push({ channel: TASKS_CHANNEL, type: TASK_EVENTS.planRevised, payload });
    apply(d, "plan_revised", "maintainer", (t) => withPlanList(t, stagesAfter(listOf(t), plan)));
    planEvent(d, { planId, revision, plan }, grantInfo);
    record(d, "plan_revision", `维护者自行调整了计划（第 ${revision} 版，不扩大授权）：${why}`, { detail: changeLines(changes, grantInfo) });
    settle(d);
    commit(d);
    // 收窄了工具包（关掉 bash、联网……）：活着的子 agent 跟着重新装配
    if (!sameToolkit(stored.plan.toolkit, plan.toolkit)) options.toolkitChanged?.(task.id);
    return { planId, revision, changes, next: nextUp(d) };
  };

  const markInfeasible = (scope: MaintainerScope, input: { stageIds: string[]; reason: string }): InfeasibleResult => {
    const why = input.reason.trim();
    if (!why) throw new RequestRejected("bad_params", "标做不了要写明原因");
    const task = mustExecute(scope, ["running", "waiting_for_user"]);
    const list = listOf(task);
    const ids = [...new Set(input.stageIds)];
    if (ids.length === 0) throw new RequestRejected("bad_params", "要写明哪几个阶段做不了");
    const unknown = ids.filter((id) => !findStage(list, id));
    if (unknown.length > 0) throw new RequestRejected("not_found", `计划里没有阶段 ${unknown.join("、")}`);
    const stages = ids.map((id) => findStage(list, id)!);
    const done = stages.filter((s) => s.state === "accepted" || s.state === "accepting");
    if (done.length > 0) throw new RequestRejected("not_allowed", `阶段 ${done.map((s) => s.stageId).join("、")} 已经验收或正在验收`);
    const d = draft(task);
    const item = stopBranch(d, stages, { kind: "infeasible", reason: why }, "maintainer");
    commit(d);
    return { itemId: item.id, stages: stages.map(ref), next: nextUp(d) };
  };

  const changeToolkit: TaskExecution["changeToolkit"] = (input) => {
    const task = tasks.get(input.taskId);
    if (!task) throw new RequestRejected("not_found", `没有任务 ${input.taskId}`);
    if (ENDED_TASK_STATES.includes(task.state)) throw new RequestRejected("not_allowed", `任务已经${TASK_STATE_LABEL[task.state]}，不能再改工具包`);
    const stored = confirmedPlan(task.id);
    if (!stored) throw new RequestRejected("not_allowed", "计划还没确认：工具包在计划卡上确认，确认之后才能在这里改");
    const before = stored.plan.toolkit;
    const after: PlanToolkit = { skills: [...new Set(input.toolkit.skills)], mcp: [...new Set(input.toolkit.mcp)], bash: input.toolkit.bash, network: input.toolkit.network, ...tellSecretaryField(canTellSecretary(input.toolkit)) };
    if (sameToolkit(before, after)) return { task, before, after: before, changed: false };
    // 有计划变更卡在等时（规格第 20 节"工具包的细则"）：收窄、增减 skill 照样直接改，扩大（开 bash、开联网、加 MCP）要等这张卡处理完
    const pending = tasks.proposedPlan(task.id);
    if (pending && toolkitExpansions(before, after).length > 0) throw new RequestRejected("not_allowed", `计划变更卡（${pending.planId}）还在等用户：先处理它再扩大工具包；收窄随时可以`);
    const plan: Plan = { ...stored.plan, toolkit: after };
    const changes = diffPlan({ before: stored.plan, after: plan, tools: options.planTools });
    const at = clock.now();
    const grantTimes = grantTimesAfter({ before: stored.plan, beforeTimes: stored.grantTimes, beforeConfirmedAt: confirmedAtOf(stored, at), after: plan, at, tools: options.planTools });
    const { revision, planId } = nextRevision(task.id);
    const payload: PlanRevisedPayload = {
      taskId: task.id,
      planId,
      revision,
      basePlanId: stored.planId,
      plan,
      changes,
      why: input.why,
      grantTimes: isoTimes(grantTimes),
      maintainerId: task.maintainerId,
      time: nowIso(new Date(at)),
    };
    const d = draft(task, input.idempotencyKey);
    d.events.push(...(input.events ?? []));
    d.events.push({ channel: TASKS_CHANNEL, type: TASK_EVENTS.planRevised, payload });
    apply(d, "toolkit_changed", input.by, (t) => t);
    planEvent(d, { planId, revision, plan }, grantInfoFor(plan));
    record(d, "toolkit", `${input.why}：${toolkitChangeText(before, after)}`);
    commit(d);
    // 活着的子 agent 跟着收窄（维护者自己的由维护者模块看到任务变化后按新工具包重新装配）
    options.toolkitChanged?.(task.id);
    return { task: d.task, before, after, changed: true };
  };

  // 授权项到期前的续期事项（grant-renewal.ts）：计划换了一版、任务结束了重新看一眼
  const renewals = createGrantRenewals({ store, tasks, inbox, clock, scheduler, leadMs: thresholds.renewalLeadMs });

  // ───────────────────────── 用户的控制（task_action 和待我处理里的通知共用） ─────────────────────────

  const pause = (task: Task, key?: string): Draft => {
    const d = draft(task, key);
    apply(d, "paused", "user", (t) => ({ ...t, state: "paused" }));
    note(d, "你暂停了任务。");
    return d;
  };

  /** 已暂停的继续（没开始过的从第一个阶段开始）；因为累计被拒暂停的，被拒次数清零 */
  const resumePaused = (task: Task, key?: string): Draft => {
    const d = draft(task, key);
    // 普通任务（75 号票）：开始过的告诉 agent 接着做（暂停时中止的那一轮不会自己重来）；没开始过的开始时交任务书
    const plain = isPlainTask(task);
    const started = plain ? plainStarted(task.id) : task.stages?.list !== undefined;
    resume(d, "user", "resumed", (t) => (t.pauseReason ? { ...t, rejections: 0 } : t));
    if (started) notify(d, plain ? PLAIN_RESUMED_TEXT : withStarted(d, noticeText.resumed(d.task.state === "queued")));
    return d;
  };

  /**
   * 卡住求助、超预算的接着执行：用户点了"继续执行""追加预算继续"（交代维护者看会话），或者在会话里回了话（他的话就是输入，不另交代）。
   * 停下的那几支（14 号票：阈值、做不了、超预算）一起接着走，计数清零、超预算的重新给一整份预算；
   * which 是哪几支接着走（回话时只有卡住求助的，超预算的还等"追加预算继续"）
   */
  const resumeStuck = (task: Task, key?: string, withNotice = true, which: (s: TaskStage) => boolean = userResolved): Draft => {
    const d = draft(task, key);
    const held = listOf(task).filter(which);
    if (held.length > 0) {
      for (const s of held.filter((x) => x.waitReason === "over_budget")) budgetReset(d, s.stageId);
      apply(d, "stage_unblocked", "user", (t) => withList(t, listOf(t).map((s) => (held.some((h) => h.stageId === s.stageId) ? countersCleared(stageNow(s, "pending")) : s))), held[0]!.stageId);
    }
    resume(d, "user", "resumed");
    if (withNotice) notify(d, isPlainTask(task) ? PLAIN_RESUMED_TEXT : withStarted(d, noticeText.stuckResumed()));
    return d;
  };

  /**
   * 中断不确定的接着执行（23 号票）：用户在待我处理里说了那次调用做没做（answered），或者在任务详情里点了"继续"、回了话
   * （回话时他的话就是交给维护者的输入，不另交代）。这个任务别的"中断不确定"事项不再卡着任务
   */
  const resumeInterrupted = (task: Task, how: { key?: string; answered?: { call: string; executed: boolean }; notice?: boolean } = {}): Draft => {
    const d = draft(task, how.key);
    resume(d, "user", "resumed");
    for (const item of inbox.list()) {
      if (item.kind !== "notice" || item.handled !== undefined || item.urgency === "non_blocking" || interruptedNoticeData(item)?.taskId !== task.id) continue;
      d.events.push(inbox.buildUpdate(item, { urgency: "non_blocking" }).event);
    }
    const { answered } = how;
    if (how.notice !== false) {
      notify(d, withStarted(d, answered ? noticeText.interruptedAnswered(answered.call, answered.executed) : noticeText.interruptedResumed(task.waitNote ?? "中断")));
    }
    return d;
  };

  const cancel = (task: Task, key?: string): Draft => {
    const d = draft(task, key);
    apply(d, "cancelled", "user", (t) => ({ ...cleared(t), state: "cancelled" }));
    note(d, "你取消了任务。");
    unblockItems(d);
    return d;
  };

  /**
   * 结束了的任务直接归档：项目内部任务在项目页上（64 号票），90 号票起全局任务也能（看板卡的菜单、多选、任务详情的"⋯"）；
   * 每周的归档清单（archive-list.ts）照旧
   */
  const archive = (task: Task, key?: string): Draft => {
    const d = draft(task, key);
    apply(d, "archived", "user", (t) => ({ ...t, state: "archived" }));
    // 这个任务还没处理的、有动作的通知（失败的任务留着的"失败后的抉择"，结束前没处理的求助、验收……）作废：任务归档了，
    // 点它的按钮什么也做不了（作废了再点会被拒，写明原因），也不再卡着任务（能归档、删除）
    const voided = new Set<string>();
    for (const item of inbox.list()) {
      if (item.kind !== "notice" || item.handled !== undefined || item.actions.length === 0 || !itemOfTask(item, task.id)) continue;
      d.events.push(inbox.buildUpdate(item, { handled: VOIDED.choice, handledAt: now(), handledNote: ARCHIVED_NOTICE, urgency: "non_blocking", read: true }).event);
      voided.add(item.id);
    }
    unblockItems(d, voided);
    return d;
  };

  const retry = (task: Task, key?: string): Draft => {
    const d = draft(task, key);
    resume(d, "user", "retried");
    notify(d, withStarted(d, noticeText.retry(task.failReason)));
    return d;
  };

  /** 效果日志里的工具按这份认（框架自带的加登记的 MCP） */
  const effectTools = () => options.effectTools?.() ?? options.planTools;

  /**
   * 从某个阶段重做时作废的待我处理事项和卡（84 号票，用户 2026-10-11 定：作废，不只是"不卡着"；照 AgentSense 重开时停掉这一轮，
   * 它等着的确认一起作废）：
   * - 重开的那几个阶段在等的（等你验收、卡住求助、超预算、交给我做）和这几个阶段的审批卡；
   * - 这个任务还没确认的计划变更卡（维护者按之前那一轮提的）：提议记成作废（不算你拒绝），在等它的阶段（重开范围外的）回到未开始；
   * - 整个任务的：维护者自己转为等我的卡住求助、中断不确定（任务在等你确认它时）、失败后的抉择（失败的任务重做时）。
   * 通知记成处理过（"已作废"）、卡过期，都不再卡着任务；再点旧按钮回"已经重做过，这……作废了"（inbox.act、cards.act 按
   * handledNote、expiredNote 说）。返回要追加的事件和要一起回到未开始的阶段
   */
  const staleItems = (before: Task, scope: readonly string[]): { events: NewEvent[]; unblock: string[] } => {
    const inScope = new Set(scope);
    const list = listOf(before);
    const waits = waitedOn(before);
    const scopeWaits = new Set(list.filter((s) => inScope.has(s.stageId) && s.state === "waiting" && s.waitingOn !== undefined).map((s) => s.waitingOn!));
    const waitingTask = before.state === "waiting_for_user";
    const events: NewEvent[] = [];
    const unblock: string[] = [];
    for (const item of blockingItemsOf(before.id)) {
      if (item.kind === "card") {
        const card = cards.get(item.cardId);
        if (!card) continue;
        const stageId = (card.payload as { stageId?: unknown }).stageId;
        const stale = card.type === "approval" ? typeof stageId === "string" && inScope.has(stageId) : card.type === "plan_change";
        if (!stale) continue;
        events.push(cards.buildUpdate(card.id, { status: "expired", expiredNote: VOIDED.card }).event);
        if (card.type !== "plan_change") continue;
        const payload = card.payload as PlanChangeCardPayload;
        const stored = tasks.plan(payload.planId);
        if (stored?.status === "proposed") {
          const voided: PlanDecidedPayload = {
            taskId: before.id,
            taskTitle: before.title,
            planId: stored.planId,
            revision: stored.revision,
            cardId: card.id,
            decision: "voided",
            removedGrants: [],
            narrowedGrants: [],
            grantInfo: payload.grantInfo,
            change: { why: payload.why, changes: payload.changes, basePlanId: payload.basePlanId },
            by: "system",
            time: now(),
          };
          events.push({ channel: TASKS_CHANNEL, type: TASK_EVENTS.planDecided, payload: voided });
        }
        for (const s of list) if (s.state === "waiting" && s.waitingOn === card.id && !inScope.has(s.stageId)) unblock.push(s.stageId);
        continue;
      }
      if (item.kind !== "notice") continue;
      const stale =
        scopeWaits.has(item.id) ||
        (["stage_acceptance", "stuck_help", "over_budget", "hand_over"].includes(item.notice) && stagesOfItem(item).some((id) => inScope.has(id))) ||
        (waitingTask && before.waitReason === "stuck" && item.notice === "stuck_help" && !waits.has(item.id)) ||
        (waitingTask && before.waitReason === "interrupted" && item.notice === "interrupted") ||
        (before.state === "failed" && item.notice === "failure_choice");
      if (stale) events.push(inbox.buildUpdate(item, { handled: VOIDED.choice, handledAt: now(), handledNote: VOIDED.notice, urgency: "non_blocking", read: true }).event);
    }
    // 并行确认卡（20 号票，不卡着任务）：提议里有重开的阶段的作废——同意了会按旧提议开始已经重开的阶段
    for (const item of inbox.list()) {
      if (item.kind !== "card" || inbox.isProcessed(item)) continue;
      const card = cards.get(item.cardId);
      if (card?.type !== "parallel" || card.status !== "pending") continue;
      const payload = card.payload as ParallelCardPayload;
      if (payload.taskId === before.id && payload.agents.some((a) => inScope.has(a.stageId))) events.push(cards.buildUpdate(card.id, { status: "expired", expiredNote: VOIDED.card }).event);
    }
    events.push(...staleInputs(before, inScope));
    return { events, unblock };
  };

  /**
   * 重做之前排在维护者会话里、还没交给它的运行时通知：重开范围里的阶段的、整个任务的（没写阶段的）作废出队，不再交给它——
   * 照 AgentSense 重开时的 generation：旧一轮的结果不交给新一轮，重做的交代里说清楚了。你说的话照旧留着；别的阶段的照旧
   */
  const staleInputs = (task: Task, inScope: ReadonlySet<string>): NewEvent[] => {
    const conversation = maintainerChannel(task.maintainerId);
    return pendingInputs(store.reader, conversation).flatMap((input): NewEvent[] => {
      if (input.scope.taskId !== task.id || (input.scope.stageId !== undefined && !inScope.has(input.scope.stageId))) return [];
      if (getMessage(store.reader, input.messageId)?.speaker !== "system") return [];
      const payload: TurnEndEventPayload = { inputMessageId: input.messageId, outcome: "aborted", error: VOIDED.input };
      return [{ channel: conversation, type: EVENT_TYPES.turnEnd, payload }];
    });
  };

  /**
   * 从某个阶段重做（返工）：长程任务的阶段开始过就能做（84 号票，用户 2026-10-11 定，照 AgentSense controller.ts 的 reopen、
   * runtime.ts 的 reopen）——调用前维护者手头那一轮已经停稳（actRework）；
   * - 这个阶段和它的全部下游回到未开始（验收结果、这一轮的计数清掉，开始过的记下第几次重做时重开的、上次没过的标准），其余不动；
   *   任务的重做次数加 1（守卫判定时记进效果日志：重做之前那一轮迟到的结果不算新的一轮）；
   * - 重开范围里的阶段在等的、计划变更这些作废（staleItems）；
   * - 这几个阶段这一轮已经做了的事从效果日志里列出来（本机、对外），不撤回，告诉维护者（对外的别再做一遍），上次的尝试记录开始阶段时给它；
   * - 会话里一条重做记录（时间线的 reopen，落在你点的那个阶段），交给维护者接着做的那句由它替着说清楚（界面上不再重复显示）；
   * - 执行中的接着做（看下一步），已暂停的仍暂停、排队中的仍排队；已完成、等我、失败的恢复执行（名额满了回到排队中），一律记成 rework；
   * - 有子 agent 在做重开范围里的阶段时不能重做（等它交回结果）；没开始过的阶段不用重做。
   * 会话不分支（撤回到这里那种会话树退回在 85 号票）
   */
  const rework = (task: Task, stage: TaskStage, why: string | undefined, key?: string): Draft => {
    const list = listOf(task);
    const scope = reworkScope(task, stage);
    // 这一轮已经做了的事：按重开之前的样子算（重开之后就是新的一轮）
    const effectsDone = stageEffects(task, scope, listEffects(store.reader, { taskId: task.id }), effectTools());
    const reworkNo = (task.reworks ?? 0) + 1;
    const stale = staleItems(task, scope);
    const reopened = reopen(list, stage.stageId, reworkNo).map((s) => (stale.unblock.includes(s.stageId) ? stageNow(s, "pending") : s));
    const before = task.state;
    const d = draft(task, key);
    d.reworkOf = { stageId: stage.stageId, reopened: scope };
    // 这一轮的用量从现在起重新算（AgentSense 认领时用量清零）
    for (const id of scope) if (findStage(list, id)?.startedAt !== undefined) budgetReset(d, id);
    const edit = (t: Task): Task => ({ ...withList(t, reopened), reworks: reworkNo });
    if (before === "running" || before === "paused" || before === "queued") {
      apply(d, "rework", "user", edit);
      settle(d);
    } else resume(d, "user", "rework", edit);
    d.events.push(...stale.events);
    const title = (id: string) => findStage(list, id)?.title ?? id;
    const others = scope.filter((id) => id !== stage.stageId).map((id) => `「${title(id)}」`);
    const summary = `你从「${stage.title}」重做（${others.length > 0 ? `连带后面的 ${others.join("、")}` : "只重做这一阶段"}）${why ? `。你说：「${why}」` : ""}`;
    const conversation = maintainerChannel(d.task.maintainerId);
    const text = withStarted(d, noticeText.rework(stage, why, scope, effectsDone, { stopped: before === "running", state: d.task.state }));
    const notice = buildAgentNotice(conversation, text, `task-exec:${d.task.id}:${randomUUID()}`, scopeIn(d));
    const reopenRecord = buildTimelineRecord(conversation, { kind: "reopen", summary, noticeId: notice.message.id }, scopeIn(d, stage.stageId));
    outputReaction(d, stage, "rework", { note: why, reopened: [...scope], recordId: reopenRecord.record.id });
    d.events.push(reopenRecord.event, notice.event);
    return d;
  };

  /** 从这个阶段重做的范围；不能重做的（没开始过、范围里有子 agent 在做）抛 RequestRejected */
  const reworkScope = (task: Task, stage: TaskStage): string[] => {
    if (!stageStarted(stage)) throw new RequestRejected("not_allowed", `阶段 ${stage.stageId} 还没开始过，不用重做`);
    const scope = reopenScope(listOf(task), stage.stageId, stageStarted);
    const busy = scope.filter((id) => subAgentsOn(task.id).has(id));
    if (busy.length > 0) throw new RequestRejected("not_allowed", `阶段 ${busy.join("、")} 有子 agent 在做：等它交回结果再重做`);
    return scope;
  };

  /** 由我验收的阶段：用户验收通过 */
  const acceptStage = (task: Task, stage: TaskStage, key?: string): Draft => {
    const declared = declaredWait(task, busyOf(task.id));
    const d = draft(task, key);
    const at = now();
    applyStage(d, "stage_accepted", "user", stage.stageId, (s) =>
      stageNow(s, "accepted", { acceptance: s.acceptance.map((a) => (a.method === "user" ? { ...a, result: { passed: true, at } } : a)) }),
    );
    outputReaction(d, stage, "accepted");
    cardRef(d, progressCard(d, stage.stageId, "acceptance", "你验收通过了。", { passed: true, judgedBy: "user", results: verdictsAfterUser(stage, true), ...summaryOf(stage) }), stage.stageId);
    proceed(d, "user", declared);
    if (d.startedStage && d.task.state === "running") notify(d, noticeText.userAccepted(stage, handoff(d.task, d.startedStage)));
    return d;
  };

  /** 由我验收的阶段：用户退回（交回维护者，阶段不推进） */
  const returnStage = (task: Task, stage: TaskStage, why: string | undefined, key?: string): Draft => {
    const declared = declaredWait(task, busyOf(task.id));
    const d = draft(task, key);
    const at = now();
    applyStage(d, "stage_returned", "user", stage.stageId, (s) =>
      stageNow(s, "pending", { acceptance: s.acceptance.map((a) => (a.method === "user" ? { ...a, result: { passed: false, at } } : a)) }),
    );
    // 退回的原因是用户自己的话：记在"用户对产出的反应"事件里（素材的来源）、交给维护者的通知里，84 号票起也记在这次结论卡上
    // 由你验收的那几条的备注里（尝试记录里看得到；彻底删除那条反应时连带换成删除标记，见 material-sources.ts 的 outputReactionPurge）。
    // 阶段的验收结果（看板上的任务）里不记
    const cardId = progressCard(d, stage.stageId, "acceptance", why ? "你退回了，原因交给了维护者。" : "你退回了。", { passed: false, judgedBy: "user", results: verdictsAfterUser(stage, false, why), ...summaryOf(stage) });
    outputReaction(d, stage, "returned", { note: why, ...(why ? { cardId } : {}) });
    cardRef(d, cardId, stage.stageId);
    notify(d, noticeText.userReturned(stage, why));
    proceed(d, "user", declared);
    return d;
  };

  /** 在任务详情里做了的事，待我处理里对应的通知自动记成处理过 */
  const NOTICE_OF_ACT: Partial<Record<TaskAction, Array<{ notice: string; choice: string; byStage?: boolean; from?: TaskState }>>> = {
    retry: [{ notice: "failure_choice", choice: FAILURE_CHOICE_ACTIONS.retry }],
    cancel: [{ notice: "failure_choice", choice: FAILURE_CHOICE_ACTIONS.cancel, from: "failed" }],
    resume: [
      { notice: "stuck_help", choice: STUCK_HELP_ACTIONS.resume, from: "waiting_for_user" },
      { notice: "over_budget", choice: OVER_BUDGET_ACTIONS.resume, from: "waiting_for_user" },
    ],
    accept_stage: [{ notice: "stage_acceptance", choice: STAGE_ACCEPTANCE_ACTIONS.pass, byStage: true }],
    return_stage: [{ notice: "stage_acceptance", choice: STAGE_ACCEPTANCE_ACTIONS.return, byStage: true }],
  };

  /** 把这个任务的某种通知标成处理过（等这次的事件落盘之后，待我处理的回调看到任务已经变了就什么也不做） */
  const markHandled = (taskId: string, notice: string, choice: string, key: string, stageId?: string) => {
    const items = inbox.list().filter((i) => {
      if (i.kind !== "notice" || i.notice !== notice || i.handled !== undefined) return false;
      const data = i.data as { taskId?: unknown; stageId?: unknown } | undefined;
      return data?.taskId === taskId && (stageId === undefined || data.stageId === stageId);
    });
    queueMicrotask(() => {
      for (const item of items) {
        try {
          inbox.act({ itemIds: [item.id], action: "handle", choice, idempotencyKey: `${key}#${item.id}` });
        } catch (err) {
          log(`标记「${item.title}」处理过时出错：${errorText(err)}`);
        }
      }
    });
  };

  const mustTask = (taskId: string): Task => {
    const task = tasks.get(taskId);
    if (!task) throw new RequestRejected("not_found", `没有任务 ${taskId}`);
    return task;
  };

  /** 用户的一个控制（能不能做已经查过） */
  const runAction = (task: Task, params: TaskActionParams, key: string): Draft => {
    switch (params.action) {
      case "pause":
        return pause(task, key);
      case "resume":
        if (task.state === "paused") return resumePaused(task, key);
        return task.waitReason === "interrupted" ? resumeInterrupted(task, { key }) : resumeStuck(task, key);
      case "cancel":
        return cancel(task, key);
      case "archive":
        return archive(task, key);
      case "retry":
        return retry(task, key);
      case "rework":
        return rework(task, reworkStage(task, params), params.note?.trim() || undefined, key);
      case "accept_stage":
      case "return_stage": {
        if (!params.stageId) throw new RequestRejected("bad_params", "要指明是哪个阶段");
        const stage = awaitingUser(task, params.stageId);
        if (!stage) throw new RequestRejected("not_allowed", `阶段 ${params.stageId} 现在不在等你验收`);
        return params.action === "accept_stage" ? acceptStage(task, stage, key) : returnStage(task, stage, params.note?.trim() || undefined, key);
      }
    }
  };

  /**
   * 用户的一个控制（task_action、任务控制快速动作共用）：查能不能做、算出这次变化的草稿；
   * noticeHandled 是落盘之后把在任务详情里做了同一件事的通知记成处理过
   */
  const prepareDraft = (params: TaskActionParams, key: string): { d: Draft; noticeHandled: () => void } => {
    const task = mustTask(params.taskId);
    assertUserCan(task, params.action);
    const d = runAction(task, params, key);
    const noticeHandled = () => {
      for (const handled of NOTICE_OF_ACT[params.action] ?? []) {
        if (handled.from === undefined || handled.from === task.state) markHandled(task.id, handled.notice, handled.choice, key, handled.byStage ? params.stageId : undefined);
      }
    };
    return { d, noticeHandled };
  };

  const prepareAct = (params: TaskActionParams, key: string): PreparedTaskAct => {
    // 从某个阶段重做要先停稳维护者：走 act 或 prepareReworkAct
    if (params.action === "rework") throw new Error("从某个阶段重做要先停稳维护者手头这一轮：用 act 或 prepareReworkAct");
    return preparedOf(params, key);
  };

  const preparedOf = (params: TaskActionParams, key: string): PreparedTaskAct => {
    const { d, noticeHandled } = prepareDraft(params, key);
    return {
      events: d.events,
      result: { taskId: d.task.id, state: d.task.state },
      afterCommit: () => {
        runAfterCommit(d);
        noticeHandled();
      },
    };
  };

  const act = (params: TaskActionParams, key: string): TaskActionResult | Promise<TaskActionResult> => {
    const done = store.eventByIdempotencyKey(key);
    if (done) {
      const payload = done.payload as Partial<TaskEventPayload>;
      if (payload.task) return { taskId: payload.task.id, state: payload.task.state };
    }
    if (params.action === "rework") return actRework(params, key);
    const { d, noticeHandled } = prepareDraft(params, key);
    commit(d);
    noticeHandled();
    return { taskId: d.task.id, state: d.task.state };
  };

  /** 正在停稳维护者、还没提交的重做（按幂等键：重发拿到同一个结果）；同一任务的几次重做一个接一个（按任务：上一次放开了才接着） */
  const reworking = new Map<string, Promise<TaskActionResult>>();
  const reworkQueue = new Map<string, Promise<void>>();

  /**
   * 从某个阶段重做（84 号票，照 AgentSense runtime.ts 的 reopen：先 generation++，再 abort + waitForIdle，然后才 reopen）：
   * 先查能不能做（做不了的马上拒绝，不去停维护者），排在同一任务上一次重做之后，再停稳执行这个任务的维护者手头这一轮
   * （options.stopTurn：到点没停的那一轮作废，之后的调用守卫不放行），然后按此刻的任务算出重置（不落盘）。
   * release 放开维护者的会话、让同一任务的下一次重做接着
   */
  const prepareReworkAct = (params: TaskActionParams, key: string): Promise<PreparedTaskAct & { release(): void }> => {
    const task = mustTask(params.taskId);
    assertUserCan(task, "rework");
    reworkScope(task, reworkStage(task, params));
    const previous = reworkQueue.get(task.id) ?? Promise.resolve();
    let done!: () => void;
    const turn = new Promise<void>((resolve) => {
      done = resolve;
    });
    reworkQueue.set(task.id, turn);
    void turn.then(() => {
      if (reworkQueue.get(task.id) === turn) reworkQueue.delete(task.id);
    });
    return previous.then(async () => {
      let releaseTurn: (() => void) | undefined;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseTurn?.();
        done();
      };
      try {
        releaseTurn = await options.stopTurn?.(mustTask(params.taskId), { timeoutMs: options.reworkStopTimeoutMs ?? REWORK_STOP_TIMEOUT_MS, reason: VOIDED.turn });
        return { ...preparedOf(params, key), release };
      } catch (err) {
        release();
        throw err;
      }
    });
  };

  /** task_action 的重做：先停稳再重置（prepareReworkAct），落盘，最后放开维护者的会话去处理重做的通知 */
  const actRework = (params: TaskActionParams, key: string): Promise<TaskActionResult> => {
    const inFlight = reworking.get(key);
    if (inFlight) return inFlight;
    const run = prepareReworkAct(params, key).then((prepared) => {
      try {
        if (prepared.events.length > 0) store.appendBatch(prepared.events);
        prepared.afterCommit();
        return prepared.result;
      } finally {
        prepared.release();
      }
    });
    reworking.set(key, run);
    run
      .finally(() => reworking.delete(key))
      .catch(() => undefined);
    return run;
  };

  /** 待我处理里通知的动作：和 task_action 走同样的函数（现在做不了的——已经在任务详情里做过了——什么也不做） */
  const fromNotice = (item: InboxItem, action: TaskAction, run: (task: Task, stageId: string | undefined) => Draft | undefined) => {
    const data = (item.kind === "notice" ? item.data : undefined) as { taskId?: unknown; stageId?: unknown } | undefined;
    if (typeof data?.taskId !== "string") return;
    const task = tasks.get(data.taskId);
    if (!task || !availableTaskActions(task, "user").includes(action)) return;
    const d = run(task, typeof data.stageId === "string" ? data.stageId : undefined);
    if (d) commit(d);
  };

  /**
   * 卡住求助、超预算事项上点了"继续"：这一支（14 号票：阈值、做不了、超预算，在等这条事项的阶段）接着走；
   * 维护者自己"转为等我"的（13 号票，没有阶段在等它）按继续执行处理
   */
  const onContinueNotice = (item: InboxItem) => {
    if (tasks.list().some((t) => listOf(t).some((s) => s.state === "waiting" && s.waitingOn === item.id))) return branchUnblocked(item.id);
    fromNotice(item, "resume", (task) => (task.state === "waiting_for_user" ? resumeStuck(task) : undefined));
  };

  /**
   * 用户在等他定夺的任务的会话里说话了：回话就接着执行的（卡住求助、中断不确定，RESUME_ON_REPLY_WAIT_REASONS）接着执行，
   * 他的话就是交给维护者的输入。超预算的不接着执行、不重给预算（要点"追加预算继续"）：他的话照常交给维护者回答，任务仍等我；
   * 别的分支卡住求助的照样接着走
   */
  const onUserMessage = (payload: MessageEventPayload) => {
    if (payload.message.speaker !== "user" || payload.taskId === undefined) return;
    const task = tasks.get(payload.taskId);
    if (task?.state !== "waiting_for_user" || !userDecidesWait(task)) return;
    if (task.waitReason === "interrupted") return commit(resumeInterrupted(task, { notice: false }));
    if (!resumesOnReply(task) && !listOf(task).some(replyResumable)) return;
    commit(resumeStuck(task, undefined, false, replyResumable));
    markHandled(task.id, "stuck_help", STUCK_HELP_ACTIONS.resume, `stuck-resumed:${payload.message.id}`);
  };

  /**
   * 一次有副作用的调用被中断、说不清做没做完（23 号票：守护进程被杀，维护者或它派出的子 agent 的子进程意外退出时还在执行）：
   * 任务转为等我，原因"中断：不确定 X 是否已执行"，待我处理里一条卡着任务的"中断不确定"（用户查过之后选做了没有）；运行时不自动重做
   */
  const onInterrupted = (p: ToolCallInterruptedPayload) => {
    const { execution } = p;
    const task = execution.origin.taskId === null ? undefined : tasks.get(execution.origin.taskId);
    if (!task || ENDED_TASK_STATES.includes(task.state)) return;
    const why = interruptionNote(execution.call);
    const { whose, where } = interruptedBy(task, execution);
    const d = draft(task);
    if (task.state === "running" || task.state === "waiting_for_user") {
      const waitNote = task.waitReason === "interrupted" && task.waitNote ? `${task.waitNote}；${why}` : why;
      apply(d, "waiting", "system", (t) => ({ ...t, state: "waiting_for_user", waitReason: "interrupted", waitNote }));
    }
    note(d, `${why}：执行到一半时守护进程（或${whose}的子进程）重启了，说不清它做没做完，运行时不会自己重做。任务转为等我，等你确认。`, execution.origin.stageId ?? undefined);
    addNotice(d, {
      notice: "interrupted",
      title: why,
      body:
        `任务「${task.title}」${where}正在执行${execution.call}时，守护进程（或${whose}的子进程）重启了，说不清它做没做完；任务已转为等我，运行时不会自己重做。\n` +
        `查过之后选"${INTERRUPTED_ACTIONS.executed}"或"${INTERRUPTED_ACTIONS.notExecuted}"，维护者照你说的接着做；也可以在任务详情里回它的话。`,
      actions: [INTERRUPTED_ACTIONS.executed, INTERRUPTED_ACTIONS.notExecuted],
      data: { taskId: task.id, toolCallId: execution.toolCallId, agentId: execution.origin.agentId } satisfies InterruptedNoticeData,
    }, callInboxOrigin(execution.origin, execution.toolCallId).origin);
    commit(d);
  };

  /** 用户在"中断不确定"事项上说了做没做：还在等我（中断不确定）的任务接着执行，维护者照他说的做 */
  const answerInterrupted = (item: InboxItem, executed: boolean) =>
    fromNotice(item, "resume", (task) => {
      if (task.state !== "waiting_for_user" || task.waitReason !== "interrupted") return undefined;
      const data = interruptedNoticeData(item);
      const execution = data && executionOf(store.reader, data.toolCallId);
      const call = execution ? interruptedBy(task, execution).call : "那次调用";
      return resumeInterrupted(task, { answered: { call, executed } });
    });

  // ───────────────────────── 维护者 ─────────────────────────

  /** 维护者对任务做事：任务要是它执行的、还在执行中（或等我） */
  const mustExecute = (scope: MaintainerScope, states: readonly TaskState[] = ["running"]): Task => {
    const task = tasks.get(scope.taskId);
    if (!task) throw new RequestRejected("not_found", `没有任务 ${scope.taskId}`);
    if (task.maintainerId !== scope.maintainerId) throw new RequestRejected("not_allowed", `任务 ${scope.taskId} 不是你执行的`);
    if (!states.includes(task.state)) throw new RequestRejected("not_allowed", `任务 ${scope.taskId} 现在是${TASK_STATE_LABEL[task.state]}，不能这样做`);
    return task;
  };

  const acceptanceOf = (stage: TaskStage, results: readonly AcceptanceVerdict[]): TaskStageAcceptance[] => {
    const at = now();
    return stage.acceptance.map((a) => {
      const r = results.find((x) => x.criterion === a.criterion && x.method === a.method);
      return r ? { criterion: a.criterion, method: a.method, result: { passed: r.passed, ...(r.note ? { note: r.note } : {}), at } } : { criterion: a.criterion, method: a.method };
    });
  };

  const completeStage = async (scope: MaintainerScope, stageId: string, summary: string): Promise<CompleteStageResult> => {
    const { taskId } = scope;
    const task = mustExecute(scope);
    const plan = planOf(taskId);
    const planStage = plan.stages.find((s) => s.stageId === stageId);
    const stage = findStage(listOf(task), stageId);
    if (!planStage || !stage) throw new RequestRejected("not_found", `计划里没有阶段 ${stageId}`);
    if (stage.state !== "running") {
      throw new RequestRejected("not_allowed", `阶段 ${stageId} 现在是${STAGE_STATE_LABEL[stage.state]}，只有正在做的阶段能宣布完成${stage.state === "pending" ? `（先用 ${EXECUTION_TOOL.startStage} 开始它）` : ""}`);
    }
    const working = subAgentsOn(taskId).get(stageId) ?? [];
    if (working.length > 0) throw new RequestRejected("not_allowed", `阶段 ${stageId} 还有子 agent（${working.join("、")}）在做：等它交回结果（在 worktree 里改的先合并回来）再宣布完成`);
    // 涉及多个项目的任务（17 号票）：本阶段的回执全部到齐且都完成才跑验收；有工单被退回、做不了的，本阶段不通过
    const gate = options.multiProject?.stageGate(task, stageId);
    if (gate !== undefined) throw new RequestRejected("not_allowed", gate);
    const attempt = stage.attempts + 1;
    const submitted = draft(task);
    applyStage(submitted, "stage_submitted", "maintainer", stageId, (s) => {
      const { summary: _last, ...rest } = s;
      return { ...rest, state: "accepting", attempts: attempt, ...(summary.trim() ? { summary: summary.trim() } : {}) };
    });
    if (summary.trim()) note(submitted, `维护者宣布阶段 ${stageId}「${stage.title}」完成（第 ${attempt} 次）：${summary.trim()}`, stageId);
    commit(submitted);

    // 脚本方式的：在工作目录里跑，看退出码和期望的输出
    const cwd = workDir(taskId);
    const results: AcceptanceVerdict[] = [];
    let judgedBy: AcceptanceMethod = "script";
    for (const a of planStage.acceptance.filter((x) => x.method === "script")) {
      const outcome = await options.acceptance.runScript({ taskId, stageId, cwd, script: a.script ?? "", ...(a.expectOutput ? { expectOutput: a.expectOutput } : {}), network: toolkitOf(task, plan).network });
      results.push({ criterion: a.criterion, method: "script", passed: outcome.passed, note: outcome.note });
    }
    // 评审方式的：脚本都过了才派评审子 agent（新的上下文，只看交付件和标准）
    const reviewCriteria = planStage.acceptance.filter((x) => x.method === "review");
    if (results.every((r) => r.passed) && reviewCriteria.length > 0) {
      judgedBy = "review";
      try {
        const verdict = await options.acceptance.review({
          taskId,
          taskTitle: task.title,
          internal: task.internal,
          stageId,
          stageTitle: planStage.title,
          attempt,
          cwd,
          deliverables: planStage.deliverables,
          criteria: reviewCriteria.map((c) => c.criterion),
          // 涉及多个项目的任务（17 号票）：本阶段的工单和回执，各项目的档案和工作目录只读
          context: stageNotes(task, stageId),
          ...(options.multiProject ? { readOnly: options.multiProject.reviewPlaces(task, stageId) } : {}),
          guardTask: () => guardTask(taskId),
          // 给秘书发消息（102 号票）：任务的工具包里开着就有（涉及多个项目的任务看计划里的开关）
          taskKind: taskKind(task),
          tellSecretary: canTellSecretary(toolkitOf(task, plan)) && canTellSecretary(plan.toolkit),
          // 评审的调用归到这个任务、阶段（项目的任务还有项目）：删除项目时连它读过的内容一起改写（53 号票）
          scope: { ...taskMessageScope(task, stageId), ...projectScopeOf(task) },
        });
        results.push(...verdict.results.map((r) => ({ ...r, method: "review" as const })));
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        log(`任务 ${taskId} 阶段 ${stageId} 的评审出错：${why}`);
        results.push(...reviewCriteria.map((c) => ({ criterion: c.criterion, method: "review" as const, passed: false, note: `评审出错：${why}` })));
      }
    }

    // 验收期间任务可能被暂停、取消了：取消、结束了的这次作废；还在的照常记下结论。验收期间从这个阶段重做过（84 号票）：
    // 重开之后维护者又交了一次，阶段又在验收，但那是新的一次提交（attempts 不一样了）——这次的结论作废，不记到新的那次上
    const fresh = tasks.get(taskId)!;
    const freshStage = findStage(listOf(fresh), stageId);
    if (ENDED_TASK_STATES.includes(fresh.state) || freshStage?.state !== "accepting" || freshStage.attempts !== attempt) return { outcome: "void", state: fresh.state };
    const d = draft(fresh);
    const recorded = (state: TaskStage["state"], extra: Partial<TaskStage> = {}) => (s: TaskStage) => ({ ...s, ...extra, state, acceptance: acceptanceOf(s, results) });
    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      const back = acceptanceReturn(d, stageId, "system", ACCEPTANCE_VERDICT_LABEL[judgedBy], {
        patch: recorded("running"),
        after: () => cardRef(d, progressCard(d, stageId, "acceptance", `没通过 ${failed.length} 条，交回维护者修改。`, { passed: false, judgedBy, results, ...summaryText(summary) }), stageId),
      });
      commit(d);
      return back.stuck ? { outcome: "stuck", stageId, judgedBy, results, attempts: back.returns, next: nextUp(d) } : { outcome: "returned", stageId, judgedBy, results };
    }
    const userCriteria = planStage.acceptance.filter((x) => x.method === "user");
    if (userCriteria.length > 0) {
      const code = stageCodeIn(fresh, stageId);
      const resultText = results.map((r) => `- 通过：${r.criterion}（${r.method === "script" ? "脚本检查" : "评审判定"}）${r.note ? `：${r.note}` : ""}`);
      const item = addNotice(d, {
        notice: "stage_acceptance",
        title: `等你验收：${fresh.title} 第 ${code} 阶段「${planStage.title}」`,
        body: [
          `任务「${fresh.title}」第 ${code}/${stageLayerCount(listOf(fresh))} 阶段「${planStage.title}」做完了，计划里这几条由你验收：`,
          ...userCriteria.map((c) => `- ${c.criterion}`),
          `交付件：${planStage.deliverables.join("；")}（在${projectOf(fresh) ? "项目的工作目录" : "任务的产出区"}里）`,
          ...(resultText.length > 0 ? ["已经通过的：", ...resultText] : []),
          // 涉及多个项目的任务（17 号票）：本阶段的工单和回执
          ...stageNotes(fresh, stageId),
          `看过后点"${STAGE_ACCEPTANCE_ACTIONS.pass}"或"${STAGE_ACCEPTANCE_ACTIONS.return}"（退回的原因可以在任务详情里写）。`,
        ].join("\n"),
        actions: [STAGE_ACCEPTANCE_ACTIONS.pass, STAGE_ACCEPTANCE_ACTIONS.return],
        data: { taskId, stageId },
      });
      applyStage(d, "stage_waiting", "system", stageId, recorded("waiting", { waitReason: "acceptance", waitingOn: item.id }));
      // 只给人看的说明：待我处理在界面上叫"待办"（43 号票）
      note(d, `${stageName(fresh, ref({ stageId, title: planStage.title }))}等你验收：已放进待办。`, stageId);
      settle(d);
      commit(d);
      return { outcome: "awaiting_user", stageId, results, next: nextUp(d) };
    }
    applyStage(d, "stage_accepted", "system", stageId, recorded("accepted"));
    cardRef(d, progressCard(d, stageId, "acceptance", "验收通过。", { passed: true, judgedBy, results, ...summaryText(summary) }), stageId);
    settle(d);
    commit(d);
    return { outcome: "accepted", stageId, judgedBy, results, next: nextUp(d) };
  };

  const startStage = (scope: MaintainerScope, stageId: string): StartStageResult => {
    const task = mustExecute(scope);
    const list = listOf(task);
    const stage = findStage(list, stageId);
    if (!stage) throw new RequestRejected("not_found", `计划里没有阶段 ${stageId}`);
    // 有子 agent 在做的（20 号票）：等它交回结果再切过去
    const working = subAgentsOn(task.id).get(stageId) ?? [];
    if (working.length > 0) throw new RequestRejected("not_allowed", `阶段 ${stageId} 有子 agent（${working.join("、")}）在做：等它交回结果再切过去`);
    const mine = currentOf(task);
    if (stage.state === "running" && mine.stageId === stageId) return { stage: handoff(task, stageId), alreadyRunning: true };
    if (stage.state === "accepted") throw new RequestRejected("not_allowed", `阶段 ${stageId} 已经验收了`);
    if (stage.state === "waiting") throw new RequestRejected("not_allowed", `阶段 ${stageId} 在等用户（${TASK_WAIT_REASON_LABEL[stage.waitReason ?? "approval"]}），不能开始`);
    if (stage.state === "accepting") throw new RequestRejected("not_allowed", `阶段 ${stageId} 正在验收`);
    const missing = missingPrerequisites(list, stageId);
    if (missing.length > 0) throw new RequestRejected("not_allowed", `阶段 ${stageId} 的前置阶段 ${missing.join("、")} 还没验收，不能开始`);
    if (mine.state === "accepting") throw new RequestRejected("not_allowed", `阶段 ${mine.stageId} 正在验收，等它有结论再换`);
    // 维护者手头在做的那个放回去（开始过，之后能开始时优先接着做；交给了子 agent 的不动），和开始新的记成同一次变化。
    // 子 agent 交回结果后它的阶段仍在做：切过去就是记成维护者的当前阶段
    const aside = mine.state === "running" && mine.stageId !== stageId && !subAgentsOn(task.id).has(mine.stageId) ? mine : undefined;
    const base = aside ? withStage(list, aside.stageId, (s) => ({ ...s, state: "pending" })) : list;
    const d = draft(task);
    apply(d, "stage_started", "maintainer", (t) => withList(t, withStage(base, stageId, startNow), stageId), stageId);
    commit(d);
    return { stage: handoff(d.task, stageId), alreadyRunning: false, ...(aside ? { setAside: aside.stageId } : {}) };
  };

  const guardTask = (taskId: string): GuardTask | null => {
    const task = tasks.get(taskId);
    const stored = confirmedPlan(taskId);
    const list = task ? listOf(task) : [];
    if (!task || !stored || list.length === 0) return null;
    const confirmedAt = stored.decidedAt ? Date.parse(stored.decidedAt) : Date.parse(task.updatedAt);
    // 每项授权的授予时间、到期时间：计划变更、续期之后记下的（14 号票）；之前确认的按确认时刻算
    // 维护者的当前阶段：它最后一次开始的那个（并行，20 号票），不按计划里的顺序取
    const plan = toGuardPlan(stored.plan, { confirmedAt, ...(stored.grantTimes ? { grantTimes: stored.grantTimes } : {}) });
    // 流程（59 号票）：守卫把每次调用和授权的那份计划比对，连同维护者说明跳过的步骤
    const workflow = taskKind(task) === "workflow" && stored.workflow ? guardWorkflow(stored.planId, stored.workflow, task) : undefined;
    // 重做过的记下重做次数（84 号票）：效果日志按判定那一刻的值分轮
    return { taskId, plan: workflow ? { ...plan, workflow } : plan, currentStageId: currentOf(task).stageId, ...(task.reworks ? { reworkNo: task.reworks } : {}) };
  };

  const stageView = (taskId: string, stageId: string): TaskStageView | undefined => {
    const task = tasks.get(taskId);
    if (!task || listOf(task).length === 0) return undefined;
    return taskStageView({
      task,
      stageId,
      guardTask: guardTask(taskId),
      effects: listEffects(store.reader, { taskId }),
      tools: effectTools(),
      env: { cwd: workDir(taskId), homeDir: options.homeDir ?? workDir(taskId) },
    });
  };

  // ───────────────────────── 并行（20 号票） ─────────────────────────

  /** 维护者对这几个阶段提议并行、用户同意时都查一遍；不行的抛 RequestRejected */
  const checkParallel = (scope: MaintainerScope, stageIds: readonly string[]): Task => {
    const task = mustExecute(scope);
    if (stageIds.length === 0) throw new RequestRejected("bad_params", "要写明并行做哪些阶段");
    const list = listOf(task);
    const busy = subAgentsOn(task.id);
    const problems = [...new Set(stageIds)].flatMap((stageId) => {
      const stage = findStage(list, stageId);
      if (!stage) return [`计划里没有阶段 ${stageId}`];
      if (stage.state !== "pending" && stage.state !== "running") return [`阶段 ${stageId} 现在是${STAGE_STATE_LABEL[stage.state]}，只有正在做或能开始的阶段能并行`];
      const missing = missingPrerequisites(list, stageId);
      if (missing.length > 0) return [`阶段 ${stageId} 的前置阶段 ${missing.join("、")} 还没验收，不能和它们同时做`];
      const working = busy.get(stageId) ?? [];
      if (working.length > 0) return [`阶段 ${stageId} 已经有子 agent（${working.join("、")}）在做`];
      return [];
    });
    if (problems.length > 0) throw new RequestRejected("not_allowed", problems.join("；"));
    return task;
  };

  /** 用户同意并行：没开始的那几个阶段开始（和卡片更新同一事务） */
  const parallelStartEvents = (scope: MaintainerScope, stageIds: readonly string[]): NewEvent[] => {
    const d = draft(checkParallel(scope, stageIds));
    for (const stageId of new Set(stageIds)) {
      if (findStage(listOf(d.task), stageId)?.state === "pending") startStageIn(d, stageId, "user", false);
    }
    return d.events;
  };

  /** 看板上任务的一次变化之后：补名额；无进展的计时（阶段推进算进展，催促计数清零）；计划换了、结束了的重看续期 */
  const onTaskEvent = (p: TaskEventPayload) => {
    scheduleFill();
    const progress = !STALL_NEUTRAL.includes(p.change) && p.task.state === "running";
    stall.track(p.task, progress);
    if (progress) clearNudges(p.task.id);
    if (ENDED_TASK_STATES.includes(p.task.state) || p.change === "plan_confirmed" || p.change === "plan_changed" || p.change === "plan_revised") renewals.arm(p.task.id);
  };

  /** 成功的工具调用（效果日志里有这个任务的记录）：重新计时，催促计数清零 */
  const onEffects = (p: EffectRecordedPayload) => {
    for (const taskId of new Set(p.records.map((r) => r.taskId))) {
      if (!taskId) continue;
      stall.progressed(taskId);
      clearNudges(taskId);
    }
  };

  return {
    start() {
      // 名额空出来（别的任务离开执行中、定时作业的运行结束）：排着的任务看看能不能开始
      options.slots.onFreed(scheduleFill);
      unsubscribes.push(
        store.onAppend((event) => {
          try {
            if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.task) onTaskEvent(event.payload as TaskEventPayload);
            else if (event.channel === GUARD_CHANNEL && event.type === GUARD_EVENTS.approvalSuspended) onSuspended(event.payload as ApprovalSuspendedPayload);
            else if (event.channel === GUARD_CHANNEL && event.type === GUARD_EVENTS.approvalDecided) onDecided(event.payload as ApprovalDecidedPayload);
            else if (event.channel === GUARD_CHANNEL && event.type === GUARD_EVENTS.pulledBack) onPulledBack(event.payload as PulledBackPayload);
            else if (event.channel === GUARD_CHANNEL && event.type === GUARD_EVENTS.effectRecorded) onEffects(event.payload as EffectRecordedPayload);
            else if (event.channel === GUARD_CHANNEL && event.type === GUARD_EVENTS.toolCallInterrupted) onInterrupted(event.payload as ToolCallInterruptedPayload);
            else if (event.channel === CHANNELS.inbox && event.type === EVENT_TYPES.inboxItem) onInboxItem((event.payload as InboxItemEventPayload).item);
            else if (event.type === EVENT_TYPES.message && event.channel.startsWith(MAINTAINER_CHANNEL_PREFIX)) {
              onUserMessage(event.payload as MessageEventPayload);
              onPlainInput(event.channel.slice(MAINTAINER_CHANNEL_PREFIX.length), event.payload as MessageEventPayload);
              onToolCallRecord(event.payload as MessageEventPayload);
            } else if (event.type === EVENT_TYPES.turnEnd && event.channel.startsWith(MAINTAINER_CHANNEL_PREFIX)) {
              onTurnEnded(event.channel, event.payload as TurnEndEventPayload);
              onPlainTurnEnded(event.channel.slice(MAINTAINER_CHANNEL_PREFIX.length), event.payload as TurnEndEventPayload);
            }
          } catch (err) {
            log(`任务执行处理事件 ${event.type} 出错：${errorText(err)}`);
          }
        }),
        inbox.onNoticeHandled("stage_acceptance", STAGE_ACCEPTANCE_ACTIONS.pass, (item) =>
          fromNotice(item, "accept_stage", (task, stageId) => {
            const stage = awaitingUser(task, stageId, item.id);
            return stage && acceptStage(task, stage);
          }),
        ),
        inbox.onNoticeHandled("stage_acceptance", STAGE_ACCEPTANCE_ACTIONS.return, (item) =>
          fromNotice(item, "return_stage", (task, stageId) => {
            const stage = awaitingUser(task, stageId, item.id);
            return stage && returnStage(task, stage, undefined);
          }),
        ),
        inbox.onNoticeHandled("failure_choice", FAILURE_CHOICE_ACTIONS.retry, (item) => fromNotice(item, "retry", (task) => retry(task))),
        inbox.onNoticeHandled("failure_choice", FAILURE_CHOICE_ACTIONS.cancel, (item) => fromNotice(item, "cancel", (task) => (task.state === "failed" ? cancel(task) : undefined))),
        inbox.onNoticeHandled("stuck_help", STUCK_HELP_ACTIONS.resume, onContinueNotice),
        inbox.onNoticeHandled("over_budget", OVER_BUDGET_ACTIONS.resume, onContinueNotice),
        inbox.onNoticeHandled("interrupted", INTERRUPTED_ACTIONS.executed, (item) => answerInterrupted(item, true)),
        inbox.onNoticeHandled("interrupted", INTERRUPTED_ACTIONS.notExecuted, (item) => answerInterrupted(item, false)),
      );
      // 守护进程重启前验收做到一半的：交回维护者，重新宣布完成
      for (const task of tasks.list()) {
        const accepting = listOf(task).filter((s) => s.state === "accepting");
        if (accepting.length === 0 || ENDED_TASK_STATES.includes(task.state)) continue;
        const d = draft(task);
        for (const s of accepting) {
          applyStage(d, "stage_returned", "system", s.stageId, (x) => ({ ...x, state: "running" }));
          notify(d, noticeText.acceptanceInterrupted(s));
        }
        commit(d);
      }
      // 普通任务（75 号票）：上次停机时 agent 这一轮刚做完、还没来得及算完成的（这个任务的最后一轮正常结束，没有别的输入了），补上完成。
      // 项目内部的看项目的维护者处理这个任务的输入的那几轮（它同时还做别的事）。被打断的那一轮（最后一轮是中断）不在这里：被杀后的恢复唤起它接着做
      for (const task of tasks.list()) {
        if (!isPlainTask(task) || task.state !== "running" || !plainStarted(task.id) || plainInputsLeft(task)) continue;
        if (lastPlainTurn(task)?.outcome !== "completed") continue;
        const d = draft(task);
        completePlain(d);
        commit(d);
      }
      // 无进展从现在算；授权项到期前的续期事项（错过的到点马上放）
      stall.start();
      renewals.start();
      fill();
    },
    stop() {
      for (const off of unsubscribes.splice(0)) off();
      stall.stop();
      renewals.stop();
    },
    startStage,
    completeStage,
    reportProgress(scope, text) {
      const task = mustExecute(scope, ["running", "waiting_for_user"]);
      const d = draft(task);
      const cardId = progressCard(d, currentOf(task).stageId, "progress", text.trim());
      commit(d);
      return { cardId };
    },
    waitForUser(scope, reason) {
      const why = reason.trim();
      if (!why) throw new RequestRejected("bad_params", "转为等我要写明原因：卡在哪、要用户做什么决定");
      const task = mustExecute(scope);
      const d = draft(task);
      apply(d, "waiting", "maintainer", (t) => ({ ...t, state: "waiting_for_user", waitReason: "stuck", waitNote: why }));
      const item = addNotice(d, {
        notice: "stuck_help",
        title: `卡住求助：${task.title}`,
        body: `任务「${task.title}」的维护者卡住了：${why}\n在任务详情里回它，或者做完它要的事后点"${STUCK_HELP_ACTIONS.resume}"。`,
        actions: [STUCK_HELP_ACTIONS.resume],
        data: { taskId: task.id },
      });
      commit(d);
      return { itemId: item.id };
    },
    reportStep(scope, input) {
      const task = mustExecute(scope, ["running", "waiting_for_user"]);
      if (taskKind(task) !== "workflow") throw new RequestRejected("not_allowed", `任务 ${task.id} 是长程任务，没有步骤：做完一个阶段用 ${EXECUTION_TOOL.completeStage} 宣布完成`);
      const list = task.steps?.list ?? [];
      const step = list.find((s) => s.stepId === input.stepId);
      if (!step) throw new RequestRejected("not_found", `计划里没有步骤 ${input.stepId}（有的是 ${list.map((s) => s.stepId).join("、")}）`);
      const gist = input.gist?.trim();
      // 开始一个新步骤：别的还报着"在做"的算做完（推断，59 号票，照 AgentSense sessionView 的 setStep）
      const stored = confirmedPlan(task.id);
      const executed = stored ? executedSteps(planHistory(store, task.id, stored.planId)) : new Set<string>();
      const before = input.state === "in_progress" ? stepsOnStart(list, input.stepId, executed) : list;
      const next = before.map((s): TaskStep => (s.stepId === input.stepId ? { stepId: s.stepId, title: s.title, state: input.state, ...(gist ? { gist } : s.gist ? { gist: s.gist } : {}) } : s));
      return settleSteps(task, next, "maintainer");
    },
    fail(scope, reason) {
      const why = reason.trim();
      if (!why) throw new RequestRejected("bad_params", "判失败必须写明原因");
      const task = mustExecute(scope);
      const d = draft(task);
      apply(d, "failed", "maintainer", (t) => ({ ...cleared(t), state: "failed", failReason: why }));
      note(d, `维护者判任务失败：${why}`);
      const item = addNotice(d, {
        notice: "failure_choice",
        title: `任务失败：${task.title}`,
        body: `任务「${task.title}」的维护者判它失败了：${why}\n可以让它重试（回到执行中），或者取消任务。`,
        actions: [FAILURE_CHOICE_ACTIONS.retry, FAILURE_CHOICE_ACTIONS.cancel],
        data: { taskId: task.id },
      });
      unblockItems(d, item.id);
      commit(d);
      return { itemId: item.id };
    },
    checkParallel(scope, stageIds) {
      checkParallel(scope, stageIds);
    },
    parallelStartEvents,
    proposePlanChange,
    revisePlan,
    markInfeasible,
    changeToolkit,
    tokensRecorded: checkBudget,
    act,
    prepareAct,
    prepareReworkAct,
    confirmPlanChange,
    rejectPlanChange,
    guardTask,
    toolkitNow(taskId) {
      const task = tasks.get(taskId);
      const stored = confirmedPlan(taskId);
      return task && stored ? toolkitOf(task, stored.plan) : undefined;
    },
    contextBlock(taskId) {
      const task = tasks.get(taskId);
      const stored = confirmedPlan(taskId);
      if (!task || !stored || listOf(task).length === 0) return undefined;
      // 流程（58 号票）：计划的步骤、每一步的状态和条件、边界
      if (taskKind(task) === "workflow" && stored.workflow) return workflowContextText({ task, plan: stored.workflow, cwd: workDir(taskId), toolkit: toolkitOf(task, stored.plan) });
      const brief = tasks.brief(taskId)?.brief;
      return contextBlockText({
        task,
        plan: { ...stored.plan, toolkit: toolkitOf(task, stored.plan) },
        goal: brief?.goal ?? task.summary,
        ...(brief && brief.acceptanceCriteria.length > 0 ? { criteria: brief.acceptanceCriteria } : {}),
        cwd: workDir(taskId),
        grantInfo: grantInfoFor(stored.plan),
        busy: busyOf(taskId),
        notes: (stageId) => stageNotes(task, stageId),
      });
    },
    workDir,
    stageView,
    kick: scheduleFill,
    awaitAnswer(taskId, waitingOn, branch = {}) {
      branchWaits(taskId, branch.stageId ?? null, branch.reason ?? "clarification", waitingOn, branch.what ?? "等你回答维护者的提问");
    },
    answered(waitingOn) {
      branchUnblocked(waitingOn);
    },
    countReturn(scope, stageId, how) {
      const task = mustExecute(scope, ["running", "waiting_for_user"]);
      const stage = findStage(listOf(task), stageId);
      if (!stage) throw new RequestRejected("not_found", `计划里没有阶段 ${stageId}`);
      const d = draft(task);
      const back = acceptanceReturn(d, stageId, "maintainer", how.judged, {
        after: () => note(d, `${stageName(task, stage)}不通过，${how.why}：算一次验收退回（第 ${(stage.returns ?? 0) + 1} 次）。`, stageId),
      });
      // 超了阈值（14 号票）：这一支已经停下找用户，落盘；没超的交给调用方和调整一起追加
      if (back.stuck) {
        commit(d);
        return { events: [], stuck: true };
      }
      return { events: d.events, stuck: false };
    },
    onCompleted(fn) {
      completedHooks.add(fn);
      return () => completedHooks.delete(fn);
    },
  };
}
