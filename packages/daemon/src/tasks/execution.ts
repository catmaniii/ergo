// 任务执行（规格第 8 节"阶段执行""验收""并发""状态补充"，13 号票）：确认过的任务从排队到完成的控制器。
//
// 执行状态都在任务里（Task.stages.list，每次变化是看板频道上的一条 task 事件），不在 pi 会话里：
// - 全局执行名额（默认 3 个，配置 tasks.maxRunning）：名额空出时排在最前的排队中任务开始执行（排队中 → 执行中，系统）；
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
//   对已完成的任务返工（按依赖重开指定阶段和全部下游）、由我验收的验收通过或退回；待我处理里通知的动作走同样的函数。
// - 并行（20 号票）：维护者提议派子 agent 做的阶段先过 checkParallel（任务在执行、阶段在做或能开始、没有子 agent 在做），
//   用户在并行确认卡上同意时，没开始的那几个阶段随卡片更新一起开始（parallelStartEvents），几个阶段同时在做；
//   维护者的当前阶段（守卫看到的、重注入块和看板上的）是它最后一次开始的阶段（任务里的 stages.focus：维护者 start_stage 的、
//   运行时替它开始的，交给子 agent 的不算；stages.ts 的 currentStage），不按计划里的顺序取；
//   有子 agent 在做的阶段（subAgentsOn）维护者不能宣布完成、不能切过去（等结果回来），子 agent 交回结果后维护者用 start_stage 切过去；
//   维护者手头空着（在做的只剩子 agent 的）时，看下一步替它开始一个能开始的阶段（nextStep 的 busy）。
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
// 交给维护者的话都是它会话里的系统通知（带 taskId），维护者模块据此唤起它；什么时候能处理输入看任务的状态（maintainers/）。
// 维护者的工具和给它看的话在 execution-tools.ts（包括这一支为什么停下的说法），这里只返回结构化的结果。
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  type AcceptanceCriterion,
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
  INTERRUPTED_ACTIONS,
  type InterruptedNoticeData,
  interruptedNoticeData,
  type InboxItem,
  type InboxItemEventPayload,
  MAINTAINER_CHANNEL_PREFIX,
  maintainerChannel,
  type MessageEventPayload,
  nowIso,
  OVER_BUDGET_ACTIONS,
  type Plan,
  type PlanChangeCardPayload,
  type PlanChangeItem,
  type PlanConfirmInput,
  type PlanDraft,
  type PlanToolkit,
  planChangeItemText,
  type ProgressCardPayload,
  sameToolkit,
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
  type TaskState,
  TASK_STATE_LABEL,
  TASK_WAIT_REASON_LABEL,
  type TaskWaitReason,
  type TimelineRecordKind,
  type Urgency,
  resumesOnReply,
  userDecidesWait,
} from "@ergou/protocol";
import type { CardService } from "../cards/cards.ts";
import type { CardActionEffect } from "../cards/registry.ts";
import { buildAgentNotice, buildMessage, buildTimelineRecord, type MessageScope } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { GuardTask, ToolRegistry, WatchCategorySettings } from "../guard/index.ts";
import {
  type ApprovalDecidedPayload,
  type ApprovalSuspendedPayload,
  type EffectRecordedPayload,
  type ExecutionRecord,
  GUARD_CHANNEL,
  GUARD_EVENTS,
  type PulledBackPayload,
  type ToolCallInterruptedPayload,
} from "../guard-runtime/events.ts";
import { executionOf, interruptionNote } from "../guard-runtime/executions.ts";
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
  type PlanRevisedPayload,
  TASK_EVENTS,
  TASKS_CHANNEL,
} from "./events.ts";
import { noticeText, spendText, stageText, stopReasonText } from "./execution-tools.ts";
import { confirmedAtOf, createGrantRenewals, isoTimes } from "./grant-renewal.ts";
import { affectedStages, diffPlan, expanding, grantTimesAfter, mergeDraft, stagesAfter, toolkitAdditions, touchedAcceptedStages } from "./plan-change.ts";
import { checkRevisedPlan, grantInfoOf, planConfirmation, readWatchSettings, toGuardPlan } from "./plan.ts";
import type { ReviewInput, ReviewResult } from "./review.ts";
import { createStallWatch, nextNudge } from "./stall.ts";
import { allAccepted, currentStage, findStage, missingPrerequisites, nextStep, reopen, stageNow, stagePosition, stageWaiting, taskMessageScope, withStage } from "./stages.ts";
import { assertUserCan } from "./state-machine.ts";
import type { TaskService } from "./tasks.ts";
import { budgetRatio, type StageSpend, type TaskThresholds } from "./thresholds.ts";
import { EXECUTION_TOOL } from "./tool-names.ts";
import type { StoredPlan } from "./views.ts";

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
  /** 第几阶段（按计划里的顺序）、共几个 */
  n: number;
  total: number;
  plan: Plan;
  /** 每项授权在守卫眼里的样子（和计划卡上的说法一样） */
  grantInfo: Readonly<Record<string, GrantInfo>>;
  /** 维护者的工作目录 */
  cwd: string;
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
  /** 验收：算上这次退回了几次 */
  | { kind: "acceptance"; returns: number; judgedBy: AcceptanceMethod }
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
  /** 全局最多几个任务处于执行中 */
  maxRunning: number;
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
  /** 数据目录的输出区（真实路径）：不属于项目的任务的产出，每个任务一格，也是维护者的工作目录 */
  outputsDir: string;
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
  log: (line: string) => void;
}

/** 项目的任务在执行控制器这里的差异（派单器在 daemon.ts 里接上，16 号票） */
export interface ProjectTasks {
  /** 这个任务由哪个项目的维护者执行：项目编号、项目的工作目录（真实路径）、项目的工具包；任务自己的维护者执行的是 undefined */
  of(task: Task): { projectId: string; workDir: string; toolkit: PlanToolkit | undefined } | undefined;
  /** 排队的任务能不能进入执行中（全局名额另看）；events 和这次变化同一事务追加（工单开始、开一段会话，或者补派的工单） */
  admit(task: Task): { admit: boolean; events: NewEvent[] };
}

/** 执行时的工具包：项目的任务是任务授权和项目工具包的交集（项目工具包里没有的能力，任务授权也放不开） */
export function effectiveToolkit(planned: PlanToolkit, project: PlanToolkit | undefined): PlanToolkit {
  if (!project) return planned;
  return {
    skills: planned.skills.filter((s) => project.skills.includes(s)),
    mcp: planned.mcp.filter((m) => project.mcp.includes(m)),
    bash: planned.bash && project.bash,
    network: planned.network && project.network,
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
  /** 账本记下了这个任务的一次用量（14 号票：token 的预算比较；daemon.ts 接在账本的 onRecorded 上） */
  tokensRecorded(taskId: string, stageId: string): void;
  // ───── 用户 ─────
  /** 用户对任务的控制（task_action 请求）：同一个幂等键重发拿到同一个结果 */
  act(params: TaskActionParams, idempotencyKey: string): TaskActionResult;
  /**
   * 用户对任务的控制，先不落盘（22 号票：任务控制快速动作和快速动作卡、操作记录同一事务追加）：能不能做照样只看
   * availableTaskActions(task, "user")，做不了抛 RequestRejected；返回要追加的事件（第一条任务事件带这个幂等键）、
   * 控制之后的状态，以及落盘之后调用方要叫的 afterCommit（提示用户、把对应的通知记成处理过）
   */
  prepareAct(params: TaskActionParams, idempotencyKey: string): PreparedTaskAct;
  /** 计划变更卡上的"确认"（可以勾掉、收窄授权项，加本任务的关注类别）：卡片动作的结果（和卡片更新同一事务） */
  confirmPlanChange(payload: PlanChangeCardPayload, input: PlanConfirmInput, idempotencyKey: string): CardActionEffect<PlanChangeCardPayload>;
  /** 计划变更卡上的"拒绝"（可附说明）：受影响的阶段交回维护者在现有授权内重排 */
  rejectPlanChange(payload: PlanChangeCardPayload, note: string | undefined, idempotencyKey: string): CardActionEffect<PlanChangeCardPayload>;
  // ───── 别的模块读 ─────
  /** 守卫看到的任务（计划、当前阶段）；还没开始执行的是 null */
  guardTask(taskId: string): GuardTask | null;
  /** 重注入块（计划摘要 + 当前阶段 + 授权 + 边界）；还没开始执行的没有 */
  contextBlock(taskId: string): string | undefined;
  /** 维护者的工作目录：任务的产出区；项目的任务是项目的工作目录（16 号票） */
  workDir(taskId: string): string;
  /** 项目空出来了（派单器）：看看排队的任务能不能开始（16 号票） */
  kick(): void;
  /** 项目维护者做工单时在等派单方回答（等澄清，16 号票）：它所在的这一支停下，都在等时任务转等我（原因"澄清"） */
  awaitAnswer(taskId: string, waitingOn: string): void;
  /** 等的回答来了：这一支接着走，任务在等我的恢复执行（名额满了回到排队中） */
  answered(waitingOn: string): void;
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

/** 在等用户验收的那个阶段（不在等的是 undefined） */
const awaitingUser = (task: Task, stageId: string | undefined): TaskStage | undefined => {
  const stage = stageId === undefined ? undefined : findStage(listOf(task), stageId);
  return stage?.state === "waiting" && stage.waitReason === "acceptance" ? stage : undefined;
};

/**
 * 任务在等我是不是维护者自己说的（转为等我）：等我时还有能推进的阶段（在做的、能开始的），就不是"所有分支都在等用户"推出来的。
 * 一支有了结论之后，推出来的等我恢复执行，维护者自己说的要用户点"继续执行"（或回话）
 */
const declaredWait = (task: Task, busy: ReadonlySet<string>): boolean => task.state === "waiting_for_user" && nextStep(listOf(task), busy).kind !== "wait";

/** 用户点"继续"就接着走的那几支（等用户定夺的：卡住求助、超预算，协议包的 USER_DECIDES_WAIT_REASONS） */
const userResolved = (s: TaskStage) => s.state === "waiting" && userDecidesWait(s);

/** 用户在会话里回话就接着走的那几支（卡住求助；超预算的要点"追加预算继续"，协议包的 RESUME_ON_REPLY_WAIT_REASONS） */
const replyResumable = (s: TaskStage) => s.state === "waiting" && resumesOnReply(s);

/** 用户验收之后，这个阶段各条标准的结论（自动判过的照原样，由用户验收的按这次的） */
const verdictsAfterUser = (stage: TaskStage, passed: boolean): AcceptanceVerdict[] => [
  ...(passed ? stage.acceptance.filter((a) => a.method !== "user" && a.result).map((a) => ({ criterion: a.criterion, method: a.method, passed: a.result!.passed, ...(a.result!.note ? { note: a.result!.note } : {}) })) : []),
  ...stage.acceptance.filter((a) => a.method === "user").map((a) => ({ criterion: a.criterion, method: a.method, passed })),
];

const errorText = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));

/** 第几阶段「名字」（给用户看的说法） */
const stageName = (task: Task, stage: StageRef) => `第 ${listOf(task).findIndex((s) => s.stageId === stage.stageId) + 1} 阶段「${stage.title}」`;

const ref = (s: StageRef): StageRef => ({ stageId: s.stageId, title: s.title });

/** 改了什么，一项一行（时间线记录的详细说明） */
const changeLines = (changes: readonly PlanChangeItem[], grantInfo: Readonly<Record<string, GrantInfo>>) => changes.map((c) => `- ${planChangeItemText(c, grantInfo)}`).join("\n");

/** 现在生效的计划换了一版（计划变更确认、自行调整）：看板上推一条，任务详情的阶段抽屉按它显示 */
const planEvent = (d: Draft, planned: { planId: string; revision: number; plan: Plan }, grantInfo: Readonly<Record<string, GrantInfo>>) => {
  const payload: TaskPlanEventPayload = { taskId: d.task.id, planId: planned.planId, revision: planned.revision, plan: planned.plan, grantInfo: { ...grantInfo } };
  d.events.push({ channel: CHANNELS.board, type: EVENT_TYPES.taskPlan, payload });
};

/** 不算进展的任务变化（无进展的计时不因它们重新开始）：计数本身、拉回 */
const STALL_NEUTRAL: readonly TaskChange[] = ["nudged", "progressed", "pulled_back", "rejection_counted"];

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
  /** 执行时的工具包（项目的任务取交集） */
  const toolkitOf = (task: Task, plan: Plan) => effectiveToolkit(plan.toolkit, projectOf(task)?.toolkit);
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
    return {
      stageId,
      title: findStage(list, stageId)?.title ?? stageId,
      n: list.findIndex((s) => s.stageId === stageId) + 1,
      total: list.length,
      plan,
      grantInfo: grantInfoFor(plan),
      cwd: workDir(task.id),
    };
  };

  /** 草稿里加一次任务的变化 */
  const apply = (d: Draft, change: TaskChange, by: TaskActor, edit: (t: Task) => Task, stageId?: string) => {
    const built = tasks.buildChange(d.task, edit(d.task), { by, change, ...(stageId === undefined ? {} : { stageId }) }, d.key);
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
      kind,
      text,
      ...(acceptance ? { acceptance } : {}),
    };
    const card = cards.buildCreate({ type: "progress", payload });
    d.events.push(card.event);
    return card.card.id;
  };

  /** 用户对产出的反应（素材的来源） */
  const outputReaction = (d: Draft, stage: TaskStage, reaction: OutputReaction, extra: { note?: string | undefined; reopened?: string[] } = {}) => {
    const payload: OutputReactionPayload = {
      taskId: d.task.id,
      taskTitle: d.task.title,
      stageId: stage.stageId,
      stageTitle: stage.title,
      reaction,
      ...(extra.note ? { note: extra.note } : {}),
      ...(extra.reopened ? { reopened: extra.reopened } : {}),
      by: "user",
      time: now(),
    };
    d.events.push({ channel: TASKS_CHANNEL, type: TASK_EVENTS.outputReaction, payload });
  };

  /** 放一条卡着任务的通知进待我处理（追加之后提示用户） */
  const addNotice = (
    d: Draft,
    input: { notice: "stage_acceptance" | "stuck_help" | "failure_choice" | "over_budget" | "interrupted"; title: string; body: string; actions: string[]; data: Record<string, unknown> },
  ): InboxItem => {
    const { item, event } = inbox.buildAdd({ kind: "notice", source: `任务「${d.task.title}」`, urgency: "blocking", ...input, title: oneLine(input.title, 60) });
    d.events.push(event);
    d.alerts.push(item);
    return item;
  };

  /** 这个任务还卡着的待我处理事项（审批卡、交给我做、这里放的通知） */
  const blockingItemsOf = (taskId: string): InboxItem[] =>
    inbox.list().filter((item) => {
      if (!(BLOCKING_URGENCIES as readonly Urgency[]).includes(item.urgency) || inbox.isProcessed(item)) return false;
      if (item.kind === "card") return (cards.get(item.cardId)?.payload as { taskId?: unknown } | undefined)?.taskId === taskId;
      const data = item.data as { taskId?: unknown; origin?: { taskId?: unknown } } | undefined;
      return data?.taskId === taskId || data?.origin?.taskId === taskId;
    });

  /** 任务结束了：它留下的事项不再卡着任务（可以归档、删除）；keep 是还要用户选的那一条（失败后的抉择） */
  const unblockItems = (d: Draft, keep?: string) => {
    for (const item of blockingItemsOf(d.task.id)) {
      if (item.id === keep) continue;
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

  /** 全部阶段验收了：任务完成（执行中或等我 → 已完成，系统） */
  const complete = (d: Draft) => {
    apply(d, "completed", "system", (t) => ({ ...cleared(t), state: "done" }));
    d.completed = true;
    note(d, "全部阶段验收通过，任务完成。");
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
  const hasSlot = (taskId: string) => tasks.list().filter((t) => t.state === "running" && t.id !== taskId).length < options.maxRunning;

  /**
   * 进入执行中，再看下一步。第一次（还没建阶段：从排队中开始，或者排队时暂停、没开始过就继续了）建好各阶段，
   * 开始第一个能开始的阶段，交给维护者"开始执行"的交代
   */
  const enterRunning = (d: Draft, by: TaskActor, change: TaskChange, edit: (t: Task) => Task = (t) => t) => {
    const first = d.task.stages?.list === undefined;
    const plan = planOf(d.task.id);
    apply(d, change, by, (t) => {
      const next = cleared(edit(t));
      return withList({ ...next, state: "running" }, next.stages?.list ?? initialStages(plan));
    });
    settle(d);
    if (first) notify(d, noticeText.started(d.task, d.startedStage ? handoff(d.task, d.startedStage) : undefined));
  };

  /**
   * 恢复执行（继续、一支不用再等了、重试、返工）：有名额回到执行中，满了回到排队中（一律记成 requeued）。
   * 项目的任务还要项目的维护者能接（16 号票）：正忙时同样回到排队中
   */
  const resume = (d: Draft, by: TaskActor, change: TaskChange, edit: (t: Task) => Task = (t) => t) => {
    if (hasSlot(d.task.id)) {
      const admitted = admit(d.task);
      d.events.push(...admitted.events);
      if (admitted.admit) return enterRunning(d, by, change, edit);
    }
    apply(d, "requeued", by, (t) => ({ ...cleared(edit(t)), state: "queued" }));
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
    let running = tasks.list().filter((t) => t.state === "running").length;
    for (const task of tasks.queued()) {
      if (running >= options.maxRunning) return;
      if (!confirmedPlan(task.id)) {
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
        running += 1;
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

  /** 用量超过预算让维护者说明进展（只说一次）；超过预算的 budgetAskTimes 倍这一支停下（超预算） */
  const checkBudget = (taskId: string, stageId: string) => {
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
  const onToolCallRecord = (p: MessageEventPayload) => {
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
    const checked = checkRevisedPlan(merged, options.planTools);
    if (!checked.ok) throw new RequestRejected("bad_params", `新的计划没通过检查，改好再交：\n- ${checked.problems.join("\n- ")}`);
    const list = listOf(task);
    const touched = touchedAcceptedStages(stored.plan, checked.plan, list);
    if (touched.length > 0) throw new RequestRejected("not_allowed", `已验收的阶段 ${touched.join("、")} 不能改（要改让用户在任务详情里返工）`);
    const busy = list.filter((s) => (s.state === "waiting" || s.state === "accepting") && !checked.plan.stages.some((p) => p.stageId === s.stageId));
    if (busy.length > 0) throw new RequestRejected("not_allowed", `阶段 ${busy.map((s) => s.stageId).join("、")} 在等用户或在验收，不能去掉`);
    return checked.plan;
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
    const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: oneLine(`计划变更等你确认：${task.title}`, 60), source: `任务「${task.title}」`, urgency: "blocking" });
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

  /** 计划变更卡上的动作能不能做：这一版还在等用户，任务还没结束 */
  const pendingChange = (payload: PlanChangeCardPayload): { task: Task; stored: StoredPlan; base: StoredPlan } => {
    const stored = tasks.plan(payload.planId);
    const task = tasks.get(payload.taskId);
    if (!stored || !task) throw new RequestRejected("not_found", `没有这版计划：${payload.planId}`);
    if (stored.status !== "proposed") throw new RequestRejected("conflict", "这张计划变更卡已经处理过了");
    if (ENDED_TASK_STATES.includes(task.state)) throw new RequestRejected("not_allowed", `任务已经${TASK_STATE_LABEL[task.state]}，计划变更不再生效`);
    const base = confirmedPlan(task.id);
    if (!base || base.planId !== payload.basePlanId) throw new RequestRejected("conflict", "计划在这之后又改过了，这张计划变更卡不再生效");
    return { task, stored, base };
  };

  const confirmPlanChange = (payload: PlanChangeCardPayload, input: PlanConfirmInput, idempotencyKey: string): CardActionEffect<PlanChangeCardPayload> => {
    const { task, stored, base } = pendingChange(payload);
    const at = clock.now();
    const confirmed = planConfirmation({ task, stored, choice: input, grantInfo: payload.grantInfo, tools: options.planTools, settings: readWatchSettings(options.watchSettings), time: nowIso(new Date(at)) });
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
    planEvent(d, { planId: stored.planId, revision: stored.revision, plan }, grantInfo);
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
          toolkit: toolkitChanged ? { added: toolkitAdditions(base.plan.toolkit, plan.toolkit), after: plan.toolkit } : undefined,
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
    const started = task.stages?.list !== undefined;
    resume(d, "user", "resumed", (t) => (t.pauseReason ? { ...t, rejections: 0 } : t));
    if (started) notify(d, withStarted(d, noticeText.resumed(d.task.state === "queued")));
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
    if (withNotice) notify(d, withStarted(d, noticeText.stuckResumed()));
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

  const retry = (task: Task, key?: string): Draft => {
    const d = draft(task, key);
    resume(d, "user", "retried");
    notify(d, withStarted(d, noticeText.retry(task.failReason)));
    return d;
  };

  /** 对已完成的任务返工：按依赖重开这个阶段和它的全部下游，由同一个维护者接着做 */
  const rework = (task: Task, stage: TaskStage, why: string | undefined, key?: string): Draft => {
    const list = listOf(task);
    const reopened = reopen(list, stage.stageId);
    const ids = reopened.filter((s, i) => s.state !== list[i]!.state).map((s) => s.stageId);
    const d = draft(task, key);
    resume(d, "user", "rework", (t) => withList(t, reopened));
    outputReaction(d, stage, "rework", { note: why, reopened: ids });
    notify(d, withStarted(d, noticeText.rework(stage, why, ids, d.task.state === "queued")));
    return d;
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
    cardRef(d, progressCard(d, stage.stageId, "acceptance", "你验收通过了。", { passed: true, judgedBy: "user", results: verdictsAfterUser(stage, true) }), stage.stageId);
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
    outputReaction(d, stage, "returned", { note: why });
    // 退回的原因是用户自己的话：只记在"用户对产出的反应"事件里（素材的来源，彻底删除时改写它）和交给维护者的通知里
    cardRef(d, progressCard(d, stage.stageId, "acceptance", why ? "你退回了，原因交给了维护者。" : "你退回了。", { passed: false, judgedBy: "user", results: verdictsAfterUser(stage, false) }), stage.stageId);
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
      case "retry":
        return retry(task, key);
      case "rework": {
        const list = listOf(task);
        const stage = params.stageId ? findStage(list, params.stageId) : undefined;
        if (!stage) throw new RequestRejected("bad_params", `返工要指明哪个阶段出了问题（${list.map((s) => s.stageId).join("、")}）`);
        return rework(task, stage, params.note?.trim() || undefined, key);
      }
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

  const act = (params: TaskActionParams, key: string): TaskActionResult => {
    const done = store.eventByIdempotencyKey(key);
    if (done) {
      const payload = done.payload as Partial<TaskEventPayload>;
      if (payload.task) return { taskId: payload.task.id, state: payload.task.state };
    }
    const { d, noticeHandled } = prepareDraft(params, key);
    commit(d);
    noticeHandled();
    return { taskId: d.task.id, state: d.task.state };
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
    });
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
    const attempt = stage.attempts + 1;
    const submitted = draft(task);
    applyStage(submitted, "stage_submitted", "maintainer", stageId, (s) => ({ ...s, state: "accepting", attempts: attempt }));
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
          stageId,
          stageTitle: planStage.title,
          attempt,
          cwd,
          deliverables: planStage.deliverables,
          criteria: reviewCriteria.map((c) => c.criterion),
          guardTask: () => guardTask(taskId),
        });
        results.push(...verdict.results.map((r) => ({ ...r, method: "review" as const })));
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        log(`任务 ${taskId} 阶段 ${stageId} 的评审出错：${why}`);
        results.push(...reviewCriteria.map((c) => ({ criterion: c.criterion, method: "review" as const, passed: false, note: `评审出错：${why}` })));
      }
    }

    // 验收期间任务可能被暂停、取消了：取消、结束了的这次作废；还在的照常记下结论
    const fresh = tasks.get(taskId)!;
    const freshStage = findStage(listOf(fresh), stageId);
    if (ENDED_TASK_STATES.includes(fresh.state) || freshStage?.state !== "accepting") return { outcome: "void", state: fresh.state };
    const d = draft(fresh);
    const recorded = (state: TaskStage["state"], extra: Partial<TaskStage> = {}) => (s: TaskStage) => ({ ...s, ...extra, state, acceptance: acceptanceOf(s, results) });
    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      // 验收（脚本、评审）退回的次数：超了阈值（退回 2 次、第 3 次还不过）这一支停下找用户（14 号票）
      const returns = (freshStage.returns ?? 0) + 1;
      applyStage(d, "stage_returned", "system", stageId, recorded("running", { returns }));
      cardRef(d, progressCard(d, stageId, "acceptance", `没通过 ${failed.length} 条，交回维护者修改。`, { passed: false, judgedBy, results }), stageId);
      if (returns > thresholds.acceptanceReturns) {
        stopBranch(d, [findStage(listOf(d.task), stageId)!], { kind: "acceptance", returns, judgedBy });
        commit(d);
        return { outcome: "stuck", stageId, judgedBy, results, attempts: returns, next: nextUp(d) };
      }
      commit(d);
      return { outcome: "returned", stageId, judgedBy, results };
    }
    const userCriteria = planStage.acceptance.filter((x) => x.method === "user");
    if (userCriteria.length > 0) {
      const n = listOf(fresh).findIndex((s) => s.stageId === stageId) + 1;
      const resultText = results.map((r) => `- 通过：${r.criterion}（${r.method === "script" ? "脚本检查" : "评审判定"}）${r.note ? `：${r.note}` : ""}`);
      const item = addNotice(d, {
        notice: "stage_acceptance",
        title: `等你验收：${fresh.title} 第 ${n} 阶段「${planStage.title}」`,
        body: [
          `任务「${fresh.title}」第 ${n}/${listOf(fresh).length} 阶段「${planStage.title}」做完了，计划里这几条由你验收：`,
          ...userCriteria.map((c) => `- ${c.criterion}`),
          `交付件：${planStage.deliverables.join("；")}（在${projectOf(fresh) ? "项目的工作目录" : "任务的产出区"}里）`,
          ...(resultText.length > 0 ? ["已经通过的：", ...resultText] : []),
          `看过后点"${STAGE_ACCEPTANCE_ACTIONS.pass}"或"${STAGE_ACCEPTANCE_ACTIONS.return}"（退回的原因可以在任务详情里写）。`,
        ].join("\n"),
        actions: [STAGE_ACCEPTANCE_ACTIONS.pass, STAGE_ACCEPTANCE_ACTIONS.return],
        data: { taskId, stageId },
      });
      applyStage(d, "stage_waiting", "system", stageId, recorded("waiting", { waitReason: "acceptance", waitingOn: item.id }));
      note(d, `阶段 ${stageId}「${planStage.title}」等你验收：已放进待我处理。`, stageId);
      settle(d);
      commit(d);
      return { outcome: "awaiting_user", stageId, results, next: nextUp(d) };
    }
    applyStage(d, "stage_accepted", "system", stageId, recorded("accepted"));
    cardRef(d, progressCard(d, stageId, "acceptance", "验收通过。", { passed: true, judgedBy, results }), stageId);
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
    return { taskId, plan: toGuardPlan(stored.plan, { confirmedAt, ...(stored.grantTimes ? { grantTimes: stored.grantTimes } : {}) }), currentStageId: currentOf(task).stageId };
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
              onToolCallRecord(event.payload as MessageEventPayload);
            }
          } catch (err) {
            log(`任务执行处理事件 ${event.type} 出错：${errorText(err)}`);
          }
        }),
        inbox.onNoticeHandled("stage_acceptance", STAGE_ACCEPTANCE_ACTIONS.pass, (item) =>
          fromNotice(item, "accept_stage", (task, stageId) => {
            const stage = awaitingUser(task, stageId);
            return stage && acceptStage(task, stage);
          }),
        ),
        inbox.onNoticeHandled("stage_acceptance", STAGE_ACCEPTANCE_ACTIONS.return, (item) =>
          fromNotice(item, "return_stage", (task, stageId) => {
            const stage = awaitingUser(task, stageId);
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
    tokensRecorded: checkBudget,
    act,
    prepareAct,
    confirmPlanChange,
    rejectPlanChange,
    guardTask,
    contextBlock(taskId) {
      const task = tasks.get(taskId);
      const stored = confirmedPlan(taskId);
      if (!task || !stored || listOf(task).length === 0) return undefined;
      const brief = tasks.brief(taskId)?.brief;
      return contextBlockText({
        task,
        plan: { ...stored.plan, toolkit: toolkitOf(task, stored.plan) },
        goal: brief?.goal ?? task.summary,
        ...(brief && brief.acceptanceCriteria.length > 0 ? { criteria: brief.acceptanceCriteria } : {}),
        cwd: workDir(taskId),
        grantInfo: grantInfoFor(stored.plan),
        busy: busyOf(taskId),
      });
    },
    workDir,
    kick: scheduleFill,
    awaitAnswer(taskId, waitingOn) {
      branchWaits(taskId, null, "clarification", waitingOn, "等你回答维护者的提问");
    },
    answered(waitingOn) {
      branchUnblocked(waitingOn);
    },
    onCompleted(fn) {
      completedHooks.add(fn);
      return () => completedHooks.delete(fn);
    },
  };
}
