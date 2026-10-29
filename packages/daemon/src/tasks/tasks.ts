// 任务（规格第 7、8 节）：发起、任务书、计划的提交和确认。所有状态迁移按"谁能改"表校验（state-machine.ts），
// 每次迁移是任务看板频道上的一条 task 事件（同一事务里还有它引起的别的事件）。
//
// 任务分两种（58 号票，ADR 0019）：流程和长程任务，建卡时定下（Task.kind），之后不能换。只有用户点明了才发起，
// 建出的任务都是"规划中"，执行的维护者在建卡时产生（12 号票：任务自己的维护者）：
// - 用户点"发起任务"按钮（start_task 请求）、在发起对话框里先选了种类：不经秘书判断直接建出（带上用户选的项目），
//   同一事务给秘书一条通知，秘书接着澄清；用户写的原话从这条 task 事件记成"用户发言"素材（material-sources.ts）；
// - 用户在消息里点明了（"按流程做""发起任务"、/workflow、/task）：秘书用 start_workflow / create_task 建任务卡
//   （secretary-tools.ts；点明没有由运行时判定，launch-intent.ts）；
// - 用户没点明、秘书觉得该发起的：秘书只给"建议发起任务"卡，用户点卡上的"作为流程""作为长程任务"才建出（cards.ts）。
// 普通任务（75 号票，ADR 0025）：不规划、不授权、不检查，建出就排队（不经"规划中""待确认"），有名额就开始做（执行控制器），
// 要做的事（Task.summary）就是交给 agent 的任务书；不写任务书、不交计划。除了用户在发起对话框里选它，助理可以自己决定交出去
// （delegate：不必等用户点明，origin 是 delegated）。只涉及一个项目的同样建成这个项目的内部任务，由项目的维护者在执行的工单段里做。
// 触发方式（76 号票，ADR 0025）：发起对话框里选了"定时"的普通任务、流程（Task.trigger；长程任务只能现在做一次，事件触发等 77 号票）。
// 定时的普通任务建出就是运营中（不排队），由触发底座（scheduled-jobs/）登记它的触发、按时间表一次次运行；定时的流程照常规划、
// 计划卡上授权一次，授权之后是运营中（不排队），之后每次运行都按步骤核对。76 号票之前的定时作业迁移成定时触发的普通任务（buildMigrated）。
// 项目内部任务（64 号票）：由项目的维护者执行、只在项目内部看得到的流程或长程任务（buildInternal，Task.internal）。
// 用户定（2026-10-09）：**只涉及一个项目的任务一律是这个项目的内部任务**，不管从哪个入口发起——项目的维护者会话里点明、
// 维护者给的建议卡、秘书那里点明、秘书给的建议卡上写了一个项目、"发起任务"对话框里选了一个项目、项目的首个建设任务，
// 以及建卡时没写项目、第一版任务书只涉及一个项目的（buildCreate、settledByBrief 都按这一条）；全局看板只放跨项目的、
// 不属于任何项目的任务。不是维护者自己建的同一事务给维护者一条通知（首个建设任务直接派起草计划的工单）。
// 任务书由维护者自己写（writeBrief 的 writer），之后和单项目任务一样派起草计划的工单。
// 之后：秘书写任务书（write_task_brief）→ 同一事务把任务书作为一条通知交给执行的维护者（它的会话频道，维护者模块据此唤起它）
// → 维护者用"提交计划"工具交出结构化的计划 → 检查（plan.ts）、存进事件日志、生成计划卡放进待我处理、任务转待确认
// → 用户在计划卡上确认（可勾掉、收窄授权项、改假设栏、加本任务的关注类别，任务转排队中；本任务调严过的全局关注类别
//   连当时的规则一起快照进计划，26 号票）或附意见打回（任务回到规划中，意见作为通知交回维护者）。
import { randomUUID } from "node:crypto";
import {
  CHANNELS,
  ENDED_TASK_STATES,
  hasOwnMaintainer,
  isDeletedEventPayload,
  isProjectInternal,
  maintainerChannel,
  type MessageEventPayload,
  ownMaintainerId,
  PI_RUNTIME_ID,
  type RuntimeChoice,
  type RuntimeTakeover,
  type Plan,
  planStageCodes,
  type PlanCardPayload,
  type PlanConfirmInput,
  type PlanWatchCategory,
  type EventTrigger,
  eventTriggerOf,
  describeTime,
  onceAt,
  LONG_RUNNING_TRIGGER_REFUSAL,
  type ReminderSchedule,
  type StartTaskParams,
  ASSISTANT_NAME_MARK,
  canSetVoiceAnnounce,
  type SetVoiceAnnounceParams,
  type SetVoiceAnnounceResult,
  TASK_STATE_LABEL,
  type Task,
  type TaskTrigger,
  type WorkFolderChoice,
  isTriggered,
  type TaskActor,
  type TaskChange,
  type TaskEventPayload,
  type TaskKind,
  TASK_KIND_LABEL,
  isPlainTask,
  taskKind,
  type TaskOrigin,
  taskInboxOrigin,
  type TaskState,
  EVENT_TYPES,
  type WorkflowConfirmInput,
  workflowConfirmationItems,
  type WorkflowPlanCardPayload,
  type WorkflowPlan,
  type InboxItem,
  withStageCodes,
  forModel,
  idLabel,
  t,
} from "@ergo/protocol";
import type { CardService } from "../cards/cards.ts";
import type { CardActionEffect } from "../cards/registry.ts";
import { buildAgentNotice, buildMessage } from "../conversation/messages.ts";
import { RequestRejected, UnknownProjects } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { ToolRegistry, WatchCategorySettings } from "../guard/index.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { SUBMIT_PLAN_TOOL } from "../maintainers/tools.ts";
import { oneLine } from "../util/text.ts";
import { type GrantTimes, type PlanDecidedPayload, type PlanSubmittedPayload, type TaskBrief, type TaskBriefPayload, TASK_EVENTS, TASKS_CHANNEL } from "./events.ts";
import { internalOtherProjects } from "./plan-projects.ts";
import { checkPlan, globalWatchCategories, grantInfoOf, planConfirmation, readWatchSettings, snapshotWatchCategories, type ToolkitProblems, verifiedQuotes, withoutLegacyJobs } from "./plan.ts";
import { isoTimes } from "./grant-renewal.ts";
import { grantTimesAfter } from "./plan-change.ts";
import { TASK_TOOL, WORKFLOW_TOOL } from "./tool-names.ts";
import { checkTaskTransition } from "./state-machine.ts";
import { confirmedPlan, confirmedPlans, countTasks, getBrief, getPlan, getTask, latestPlan, listPlans, listTasks, proposedPlan, queuedTasks, refusedPlans, shownPlans, type StageUsage, stageUsage, type StoredPlan, taskOfMaintainer } from "./views.ts";
import type { ReviewedWorkflow } from "./workflow-plan.ts";
import { EVENT_TRIGGER_PROBLEMS, eventTriggerLines, NO_EVENT_SOURCES, onceTriggerLine, scheduleTriggerLine } from "./trigger-texts.ts";

/** 任务标题最多这么多字（点按钮时取用户写的第一行） */
const TITLE_MAX = 40;

/**
 * 建出时的状态：有计划的两种从规划中开始；普通任务（75 号票）不规划，建出就排队；定时触发的普通任务（76 号票）建出就是运营中
 * （按时间表一次次运行，不进排队）；某个时间做一次的普通任务建出是等时间（到点了进排队）
 */
const initialState = (kind: TaskKind, trigger: TaskTrigger | undefined): TaskState =>
  isPlainTask({ kind }) ? (isTriggered({ trigger }) ? "operating" : onceAt({ trigger }) !== undefined ? "scheduled" : "queued") : "planning";

/** 某个时间做一次：那个时间要在将来 */
export const ONCE_AT_PASSED = (at: string) => t("tasks.tasks.onceAtPassed", { at: describeTime(new Date(at)) });

/**
 * 建卡时的触发方式（76 号票）：不写、一次性的不记（Task.trigger 不写就是一次性）；长程任务只能现在做一次；定时的时间表可以是重复的，
 * 也可以是某个时间做一次（用户 2026-10-10 定：那个时间要在将来）；事件触发的（77 号票）过事件来源登记表和来源的实现现查
 * （checkEvent：文件夹在不在、能不能监视……）。不行的抛 RequestRejected
 */
function checkedTrigger(kind: TaskKind, trigger: TaskTrigger | undefined, now: string, checkEvent: ((t: EventTrigger) => string[]) | undefined): TaskTrigger | undefined {
  if (!trigger || trigger.kind === "once") return undefined;
  if (kind === "long_running") throw new RequestRejected("not_allowed", LONG_RUNNING_TRIGGER_REFUSAL);
  if (trigger.kind === "event") {
    const problems = checkEvent ? checkEvent(trigger) : [NO_EVENT_SOURCES];
    if (problems.length > 0) throw new RequestRejected("bad_params", EVENT_TRIGGER_PROBLEMS(problems));
    return trigger;
  }
  const at = onceAt({ trigger });
  if (at !== undefined && !(Date.parse(at) > Date.parse(now))) throw new RequestRejected("bad_params", ONCE_AT_PASSED(at));
  return trigger;
}

/** 计划里写了定时作业（76 号票起不再有）：改成在发起对话框里建定时触发的普通任务或流程 */
// @i18n-ignore-next model：交回维护者
export const PLAN_JOBS_REFUSAL = "计划里不再写定时作业（scheduledJobs）：要定时反复做的事，请用户在发起对话框里建定时触发的普通任务或流程（“什么时候做”选定时）。把这一项去掉再提交，需要的话在假设栏里写明建议用户另建一个";

export interface NewTask {
  title: string;
  summary: string;
  origin: TaskOrigin;
  /** 种类（58 号票）：流程或长程任务；不给是长程任务 */
  kind?: TaskKind;
  /** 触发方式（76 号票）：不给是现在做一次；定时的只有普通任务、流程能用 */
  trigger?: TaskTrigger;
  /**
   * 涉及的项目（项目列表里的名字：用户点按钮时选的，秘书建卡、建议卡上写的）：按项目列表认成编号（不在列表里、
   * 已归档的拒绝并说明）；恰好一个的建成这个项目的内部任务（64 号票）
   */
  projects?: readonly string[];
  /** 发起对话框里先勾上了"跑完自动播报"（100 号票）：建成项目内部任务的不认（做完不告诉秘书） */
  voiceAnnounce?: boolean;
  /**
   * 任务自己的维护者用的 agent 运行时（286 号票，Task.runtime）：不给是 pi。建成项目内部任务的不认（由项目的维护者执行，照项目的）。
   * 289 号票起新建时选（这里不查登记了没有：没登记、插件停用了的维护者不启动，任务转等我）
   */
  runtime?: string;
  /** 维护者的工作目录在数据目录外面（290 号票：接管来的，会话原来的工作目录；Task.workdir）。不涉及项目的才能给 */
  workdir?: string;
  /**
   * 在哪个文件夹做（305 号票）：运行时能选工作文件夹的（Claude Code）才看——用已有的、或在默认文件夹下新开（不写也是新开，按标题起名）；
   * 定下的写进 Task.workdir。没设默认文件夹、又没选已有的照旧（产出区）。建成项目内部任务的不看
   */
  folder?: WorkFolderChoice;
  /** 从运行时已有的会话接管来的（290 号票，Task.takeover） */
  takeover?: RuntimeTakeover;
}

/** 项目内部任务（64 号票）：在哪个项目里、种类、怎么发起的（TaskOrigin；项目的首个建设任务是 project_build） */
export interface NewInternalTask {
  projectId: string;
  title: string;
  summary: string;
  kind: TaskKind;
  origin: TaskOrigin;
  /** 触发方式（76 号票）：不给是现在做一次 */
  trigger?: TaskTrigger;
}

/** 迁移出来的定时触发的普通任务（76 号票）：76 号票之前的定时作业的样子 */
export interface MigratedTask {
  title: string;
  summary: string;
  schedule: ReminderSchedule;
  /** 执行的 agent 照旧：作业自己的维护者（jm-<n>）或项目的维护者 */
  maintainerId: string;
  project?: { id: string; name: string } | undefined;
  internal?: Task["internal"];
}

/**
 * 任务是怎么发起的（建出时同一事务通知谁、怎么说，由 buildCreate / buildInternal 一处定）：用户点了维护者给的建议卡、
 * 秘书给的建议卡，在秘书那里点明了（秘书替用户建的），点了"发起任务"按钮。建成项目内部任务的通知交给项目的维护者；
 * 全局任务的通知交给秘书（秘书自己建的不另通知）。项目的维护者自己建的、项目的首个建设任务不通知
 */
export type TaskStart = "maintainer_suggestion" | "secretary_suggestion" | "secretary" | "button";

/** 建出任务时同一事务的通知：怎么发起的、通知的幂等键（`${key}#notice`） */
export interface StartNotice {
  how: TaskStart;
  key: string;
}

export interface TaskService {
  /**
   * 建出一个任务（规划中）和它的事件（不追加）：卡片动作把它们和卡片更新一起追加。只涉及一个项目的建成这个项目的内部任务
   * （64 号票，用户定：buildInternal）。给了 start 就同一事务带上通知：内部任务的交给项目的维护者，全局任务的交给秘书
   * （秘书自己建的不另通知）——通知谁只在这里定，调用方不再判断
   */
  buildCreate(input: NewTask, by: TaskActor, start?: StartNotice): { task: Task; events: NewEvent[] };
  /**
   * 用户把一个未结束的任务转为项目（15 号票）：任务以"已完成 · 已转为项目"结束的事件（不追加）。
   * 只有有自己维护者的任务能转（原任务的维护者接着做立项问答）
   */
  buildConvertToProject(taskId: string): { task: Task; event: NewEvent };
  /**
   * 秘书按用户在消息里的要求建任务卡（start_workflow / create_task 工具）：写了一个项目的建成这个项目的内部任务（64 号票），
   * 通知交给项目的维护者
   */
  createByRequest(input: { title: string; summary: string; kind?: TaskKind; projects?: readonly string[]; runtime?: string; folder?: WorkFolderChoice }): Task;
  /** 用户点"发起任务"按钮（start_task 请求）：同一个幂等键重发拿到同一个任务 */
  startFromButton(params: StartTaskParams, idempotencyKey: string): Task;
  /**
   * 从运行时已有的会话接管成任务（290 号票，接管服务 takeover/ 叫）：普通任务（origin takeover），维护者在会话原来的工作目录里、接着那个会话做，
   * 第一条输入是用户写的"接着让它做什么"。extra 给出要和任务一起追加的事件（前情消息：在任务书交给维护者之前进它的会话）。
   * 同一个幂等键重发拿到第一次建出的；运行时不能用的抛 RequestRejected
   */
  startTakenOver(input: { title: string; request: string; runtime: string; workdir: string; takeover: RuntimeTakeover }, idempotencyKey: string, extra: (task: Task) => NewEvent[]): Task;
  /**
   * 交还、收回（290 号票）：改任务上记着的接管（记一条 takeover_set，状态不变）。没有的、不是接管来的抛 RequestRejected；
   * 292 号票：二狗自己开的会话（takeover.own）第一次交给官方 App 时没有也能记
   */
  setTakeover(taskId: string, takeover: RuntimeTakeover): Task;
  /**
   * 开关"跑完自动播报"（100 号票，set_voice_announce：任务操作菜单里的）：记一条 voice_announce_set（状态不变，by 默认用户）。
   * 本来就是这样的不另记；同一个幂等键重发拿到同一个结果。没有的、项目内部的、不会再做完的（canSetVoiceAnnounce）抛 RequestRejected
   */
  setVoiceAnnounce(params: SetVoiceAnnounceParams, idempotencyKey: string, by?: TaskActor): SetVoiceAnnounceResult;
  /** 开关"跑完自动播报"的事件（不追加；本来就是这样的是空的）：秘书的快速动作和卡片、操作记录同一事务追加。不能开关的抛 RequestRejected */
  buildVoiceAnnounce(taskId: string, on: boolean, by: TaskActor, idempotencyKey?: string): { task: Task; events: NewEvent[] };
  /**
   * 任务自己的维护者用的运行时、给它选的值改了（289 号票：⚙ 里换运行时换完了、改了选的值）：记一条 runtime_set（状态不变）。
   * pi 不写（没写就是 pi），选的值是空的不写；本来就是这样的不另记。没有的任务抛 RequestRejected
   */
  setRuntime(taskId: string, runtime: string | undefined, runtimeOptions: RuntimeChoice | undefined, by: TaskActor): Task;
  /**
   * 助理自己把一件事交出去（75 号票，delegate_task）：建一个普通任务（排队，有名额就开始做），不必等用户点明；
   * instructions 是交给 agent 的那段话（用户交代的事加上必要的上下文）。只写了一个项目的建成这个项目的内部任务
   */
  delegate(input: { title: string; instructions: string; projects?: readonly string[]; at?: string; runtime?: string; folder?: WorkFolderChoice }): Task;
  /**
   * 项目内部任务（64 号票）的建出事件（不追加）：执行的就是项目的维护者，涉及的项目只有这一个，只在项目内部看得到。
   * 项目要在项目列表里、立项书已确认（只有首个建设任务例外：origin 是 project_build）、没归档，不然抛 RequestRejected 说明原因。
   * 给了 start（不是维护者自己建的）同一事务给维护者一条带任务编号的通知：它正在做工单时排着，空下来在对话段里接着和用户对齐、写任务书
   */
  buildInternal(input: NewInternalTask, by: TaskActor, start?: StartNotice, nth?: number): { task: Task; events: NewEvent[] };
  /**
   * 运营方案里流程的那一条（130 号票）：带着审查修补后的固定计划，用户确认运营方案时一起授权——这个项目的内部流程，建出就是运营中
   * （定时、事件触发的；某个时间做一次的是等时间），同一事务记下这版计划（plan_submitted）和用户的授权（plan_decided），
   * 流程计划卡建出就是已授权（写明随运营方案一起授权），任务详情里照常看得到计划、每次运行照步骤核对。
   * confirmations：审查要用户逐项确认的事项勾了哪些（流程计划卡上的 key），没勾完的抛 RequestRejected。
   * nth：同一事务里前面已经建了几个任务（编号接着往下排）
   */
  buildAuthorizedWorkflow(input: Omit<NewInternalTask, "kind">, reviewed: ReviewedWorkflow, auth: { confirmations: readonly string[]; note: string; key: string }, nth?: number): { task: Task; events: NewEvent[] };
  /**
   * 76 号票之前的定时作业迁移成定时触发的普通任务（触发底座迁移时用，不追加）：运营中、origin 是 migrated，执行的 agent 照旧，
   * 不属于项目的涉及的项目为空，属于项目的是那个项目（带着原来的项目内部标记）
   */
  /** nth：同一事务里建的第几个（从 0 起；编号接着往下排） */
  buildMigrated(input: MigratedTask, nth?: number): { task: Task; event: NewEvent };
  /** 项目的维护者按用户在它的会话里的点明建项目内部任务并追加（start_workflow / create_task）：maintainerId 要是这个项目的维护者 */
  createInternal(input: Omit<NewInternalTask, "origin">, maintainerId: string): Task;
  /**
   * 写（或改）任务书：同一事务交给执行的维护者。秘书写（不给 writer）的不能是项目内部任务（对秘书来说没有这个任务）；
   * 项目内部任务的任务书由它的维护者自己写（writer 是它，64 号票），之后照样派起草计划的工单给它
   */
  writeBrief(taskId: string, brief: TaskBrief, writer?: { maintainerId: string }): { task: Task; revision: number };
  /**
   * 执行中改任务书（14 号票：改目标或任务的验收标准的计划变更被确认后）：新的一版任务书的事件（不追加），
   * 调用方和计划变更的其余事件一起追加；不另交给维护者（确认的通知里写了改动）
   */
  buildBriefRevision(taskId: string, patch: Partial<Pick<TaskBrief, "goal" | "acceptanceCriteria">>): NewEvent;
  /** 执行的维护者提交计划（submit_plan 工具）：检查不过时抛 RequestRejected，原因交回维护者 */
  submitPlan(taskId: string, maintainerId: string, plan: Plan): { cardId: string; planId: string; revision: number };
  /** 计划卡上的"确认"（勾掉、收窄授权项，改假设栏） */
  confirmFromCard(payload: PlanCardPayload, input: PlanConfirmInput, idempotencyKey: string): CardActionEffect<PlanCardPayload>;
  /** 计划卡上的"附意见打回" */
  rejectFromCard(payload: PlanCardPayload, note: string | undefined, idempotencyKey: string): CardActionEffect<PlanCardPayload>;
  /**
   * 流程的维护者交出的计划（58 号票，propose_plan 工具）：要交给用户的那份（审查修补过、标注好的）。存进事件日志、
   * 生成流程计划卡放进待我处理、任务转待确认；任务不是它执行的流程、不在规划中时抛 RequestRejected
   */
  submitWorkflowPlan(taskId: string, maintainerId: string, reviewed: ReviewedWorkflow): { cardId: string; planId: string; revision: number };
  /** 流程的下一版计划是第几版（审查退回、判定不可执行的那一版也算一版） */
  nextPlanRevision(taskId: string): number;
  /**
   * 撤回会话回到流程的计划授权之前（153 号票）：那时在等你授权的那一版（后来授权了，随撤回作废）同样的计划作为新的一版重新等你授权——
   * 这一版、流程计划卡、待我处理里的事项（不追加；任务转待确认由调用方和撤回的其余变化一起做，事项落盘之后提示）
   */
  buildWorkflowReauthorization(task: Task, stored: StoredPlan): { events: NewEvent[]; item: InboxItem; cardId: string; planId: string; revision: number };
  /**
   * 流程的这一版审查没让它交给用户授权（审查退回维护者补充、判定不可执行）：也把这版计划显示出来——
   * 存进事件日志（这一版的状态是 refused）、生成流程计划卡（refused，不能授权）放进待我处理，写明原因和下一步；任务还在规划中
   */
  refuseWorkflowPlan(taskId: string, maintainerId: string, reviewed: ReviewedWorkflow, why: "needs_replan" | "blocked"): { cardId: string; planId: string; revision: number };
  /** 审查判定不可执行（或退回）的流程计划卡上的"让维护者改"（可以附说明）：交回维护者 */
  reviseWorkflowFromCard(payload: WorkflowPlanCardPayload, note: string | undefined, idempotencyKey: string): CardActionEffect<WorkflowPlanCardPayload>;
  /** 流程计划卡上的"授权执行"：需要你确认的事项全勾上了才行，任务转排队中 */
  confirmWorkflowFromCard(payload: WorkflowPlanCardPayload, input: WorkflowConfirmInput, idempotencyKey: string): CardActionEffect<WorkflowPlanCardPayload>;
  /** 流程计划卡上的"拒绝"（可以附说明）：任务回到规划中，交回维护者 */
  rejectWorkflowFromCard(payload: WorkflowPlanCardPayload, note: string | undefined, idempotencyKey: string): CardActionEffect<WorkflowPlanCardPayload>;
  /**
   * 任务的一次变化（13 号票起执行、阶段推进用）：next 是变化之后的任务（updatedAt 由这里填），状态变了就按"谁能改"表校验
   * （不合的抛 not_allowed）；给出看板频道上的 task 事件（不追加），调用方和别的事件一起放进 appendBatch
   */
  buildChange(prev: Task, next: Task, meta: { by: TaskActor; change: TaskChange; stageId?: string; reopened?: readonly string[] }, idempotencyKey?: string): { task: Task; event: NewEvent };
  get(taskId: string): Task | undefined;
  list(): Task[];
  /** 排队中的任务，按进入排队的先后 */
  queued(): Task[];
  /** 某个维护者执行的任务 */
  ofMaintainer(maintainerId: string): Task | undefined;
  brief(taskId: string): { brief: TaskBrief; revision: number } | undefined;
  plan(planId: string): StoredPlan | undefined;
  latestPlan(taskId: string): StoredPlan | undefined;
  /** 现在生效的计划：最新一版确认过的（14 号票起，计划变更提出的一版在确认之前不算；13 号票起执行、20 号票的子 agent 都按它） */
  confirmedPlan(taskId: string): StoredPlan | undefined;
  /** 确认过的各版计划，先确认的在前（112 号票：原定由你验收、按新规矩改由评审的那几条看它） */
  confirmedPlans(taskId: string): StoredPlan[];
  /** 还在等用户的计划变更（14 号票） */
  proposedPlan(taskId: string): StoredPlan | undefined;
  /**
   * 之前给用户看过的各版计划里用过的阶段编号（93 号票：计划调整时新加的阶段不用这些号；评审：被拒、作废的计划变更卡上显示过的也算，
   * 旧卡上的号不会指到别的阶段）
   */
  usedStageCodes(taskId: string): string[];
  /** 一个阶段这一份预算的记账（14 号票）：工具调用次数、token 从账本里的多少起算、说明过进展没有 */
  stageUsage(taskId: string, stageId: string): StageUsage;
  /** 全局的关注类别（任务书里列给维护者：本任务的关注类别只能在其上增加） */
  globalWatchCategories(): ReturnType<typeof globalWatchCategories>;
  /**
   * 各版计划里本任务的关注类别（26 号票，关注类别设置用）：confirmed 是确认了的那版，ongoing 是任务还没结束。
   * 确认了的计划里带规则的全局类别 id 是确认时快照下来的（任务仍按确认时的设置检查它）
   */
  planWatchCategories(): { taskId: string; confirmed: boolean; ongoing: boolean; categories: PlanWatchCategory[] }[];
}

/** 任务模块要的项目模块的几样（15、17、64 号票；ProjectService 就是它） */
export interface TaskProjects {
  checkTaskProjects(names: readonly string[]): string[];
  projectIdsOf(names: readonly string[]): string[];
  projectOf(task: Task): { id: string; name: string } | undefined;
  internalHost(projectId: string, opts?: { firstBuild?: boolean }): { id: string; name: string; maintainerId: string };
}

/** 任务模块要的派单器的几样（16、17 号票；WorkOrders 就是它） */
export interface TaskWorkOrders {
  dispatchPlan(task: Task, instructions: string, key: string): NewEvent[] | undefined;
  multiProject: { planConfirmed(task: Task, plan: Plan): NewEvent[] };
}

export interface TaskServiceOptions {
  store: EventStore;
  cards: CardService;
  inbox: InboxService;
  now: () => string;
  /** 全局的关注类别设置（数据目录配置区的文件，每次现取；文件坏了时抛错） */
  watchSettings: () => WatchCategorySettings;
  /** 计划里的授权项、时序规则照这份工具注册表查（内置的，加上维护者代为执行的工具） */
  planTools: ToolRegistry;
  /** 计划的工具包里的 skill 要在 skill 库里、MCP 要登记过（27 号票）；不给就不查 */
  toolkitProblems?: ToolkitProblems;
  /**
   * 项目列表（15 号票，项目模块建在任务模块之后，用到时现取；127 号票起直接给项目模块，不再一样样转手）：点"发起任务"时选的项目要在
   * 项目列表里（checkTaskProjects：不在的抛 UnknownProjects、已归档的抛 RequestRejected 说明原因，在的给出编号）；计划里写的涉及的项目
   * 认成编号（projectIdsOf）。项目的任务的计划里不管写没写，涉及的项目都有这个项目（projectOf：任务属于哪个项目）。
   * 只涉及一个项目的任务（64 号票：一律是这个项目的内部任务）在哪个项目里（internalHost：项目的名字和维护者，由它执行；不在项目列表里、
   * 立项书还没确认——firstBuild：项目的首个建设任务例外，它在确认立项书的那一刻建出——已归档的抛 RequestRejected 说明原因）。
   * 不给就不核对、不记编号，也建不了项目内部任务
   */
  projects?: () => TaskProjects;
  /**
   * 派单器（16 号票，建在任务模块之后，用到时现取）：项目的任务的任务书、打回意见不直接交给维护者，而是派一张起草计划的工单
   * （dispatchPlan，工单开始时交给它；返回 undefined 的——任务自己的维护者执行的——照旧作为通知交给维护者）；涉及多个项目的任务（17 号票）
   * 用户确认计划时每一行建成一张工单（multiProject.planConfirmed，等阶段开始），和计划卡的处理同一事务
   */
  workOrders?: () => TaskWorkOrders;
  /**
   * 升级前交了、升级后才确认的长程任务计划里还写着定时作业（76 号票，主会话定：不悄悄丢掉）：确认时照以前定时作业的迁移办法
   * 建成定时触发的普通任务，和确认计划同一事务；给出事件和卡上的说明。不给就不建（计划里的定时作业照样从确认后的计划里拿掉）
   */
  legacyPlanJobs?: (task: Task, stored: StoredPlan, grantInfo: PlanCardPayload["grantInfo"]) => { events: NewEvent[]; note?: string };
  /** 事件触发的任务（77 号票）：事件触发方式对不对（事件来源登记表、来源的实现现查）；不给就不收事件触发的任务 */
  checkEventTrigger?: (trigger: EventTrigger) => string[];
  /**
   * 提交的计划里涉及的项目对不对得上任务（17 号票评审后定：单项目任务不能写进别的项目，不涉及项目的任务不能写项目行，
   * 多项目任务每一行写所属阶段和验收标准）：不对的原因；不给就不查
   */
  planProjects?: (task: Task, plan: Plan) => string[];
  /**
   * 点"发起任务"时选的运行时现在能不能用（289 号票：运行时的登记表，组合根接上）：不能用的原因（"Claude Code插件没启用"、不认得的），
   * 能用是 undefined。不给就不查
   */
  runtimeRefusal?: (runtime: string) => string | undefined;
  /**
   * 新建时定工作文件夹（305 号票，work-folders/ 的 settle）：运行时能选的交回定下的文件夹（新开的这时建出），照旧的是 undefined；
   * 路径不对抛 RequestRejected。不给就都照旧
   */
  workFolder?: (runtime: string | undefined, choice: WorkFolderChoice | undefined, title: string) => string | undefined;
}

/** 定时、事件触发的任务（76、77 号票）：任务书、通知里写一句什么时候做 */
export function triggerLine(task: Task): string | undefined {
  const event = eventTriggerOf(task);
  if (event) return eventTriggerLines(event);
  if (task.trigger?.kind !== "schedule") return undefined;
  const at = onceAt(task);
  return at !== undefined ? onceTriggerLine(at) : scheduleTriggerLine(task.trigger.schedule);
}

/** 秘书收到的通知：任务刚建好，接着澄清、写任务书（给模型看，照旧中文） */
function clarifyNext(task: Task): string {
  const kind = forModel(() => TASK_KIND_LABEL[taskKind(task)]);
  return `${kind} ${task.id}「${task.title}」已建好（规划中）。先说出你的理解，需要时用 ${TASK_TOOL.askQuestions} 成批提问（每题带推荐答案），对齐后用 ${TASK_TOOL.writeTaskBrief} 写任务书。`; // @i18n-ignore model
}

/**
 * 流程涉及几个项目的被拒（58 号票）：只涉及一个项目的是这个项目的内部任务（64 号票，由项目的维护者起草、执行），全局的流程不涉及项目
 */
export const workflowProjectsRefusal = () => t("tasks.tasks.workflowProjects");

/** 秘书问到项目内部任务时：对秘书来说没有这个任务（它看不到项目内部任务的细节，64 号票） */
const notFoundText = (taskId: string) => `没有编号为 ${taskId} 的任务`; // @i18n-ignore model：交回秘书

const NL = "\n";

/** 审查退回、判定不可执行的那一版不能授权、也不用拒绝 */
const refusedNotAuthorizable = () => t("tasks.tasks.refusedNotAuthorizable");

// 任务书、交给维护者和秘书的通知：给模型看，照旧中文
// @i18n-ignore-start model
const bullets = (items: readonly string[]) => (items.length === 0 ? "（无）" : items.map((x) => `\n- ${x}`).join(""));

/** 任务书里项目内部任务（64 号票）涉及的项目：只有它自己那个，只在项目里看得到 */
const internalBriefScope = (task: Task) => `${task.projects.join("、")}（项目内部任务：只动这个项目，只在项目里看得到）`;

/** 交给维护者的任务书（流程的另有一种说法：workflowBriefText） */
export function briefText(task: Task, brief: TaskBrief, revision: number, categories: ReturnType<typeof globalWatchCategories>): string {
  if (taskKind(task) === "workflow") return workflowBriefText(task, brief, revision);
  return [
    `${revision > 1 ? `任务书改了（第 ${revision} 版）` : "任务书"}：任务 ${task.id}「${task.title}」`,
    `目标：${brief.goal}`,
    `验收标准：${bullets(brief.acceptanceCriteria)}`,
    `约束：${bullets(brief.constraints)}`,
    // 项目内部任务（64 号票）只动它自己那个项目
    `涉及的项目：${isProjectInternal(task) ? internalBriefScope(task) : brief.projects.length === 0 ? "不涉及项目" : brief.projects.join("、")}`,
    `记忆范围提议：${brief.memoryScope || "（无）"}（第一阶段只占位）`,
    `全局的关注类别（计划里的 watchCategories 一个都不能少，只能增加或往严里调）：${categories.map((c) => `${c.id}「${c.title}」`).join("、")}`,
    // 用户说过的限制由维护者编译、和原话一起显示在计划卡上（26 号票）
    ...(brief.constraints.length > 0 ? ["约束里用户说过的限制，编译成时序规则或授权收窄写进计划的 userLimits，附上用户的原话。"] : []),
    `请据此起草计划，用 ${SUBMIT_PLAN_TOOL} 提交；用户确认之前不要动手做。`,
  ].join("\n");
}

/** 交给流程的维护者的任务书（58 号票）：照它把要做的事排成步骤，用 propose_plan 交出 */
export function workflowBriefText(task: Task, brief: TaskBrief, revision: number): string {
  return forModel(() => workflowBriefLines(task, brief, revision));
}

function workflowBriefLines(task: Task, brief: TaskBrief, revision: number): string {
  return [
    `${revision > 1 ? `任务书改了（第 ${revision} 版）` : "任务书"}：流程 ${task.id}「${task.title}」`,
    `目标：${brief.goal}`,
    `验收标准：${bullets(brief.acceptanceCriteria)}`,
    `约束：${bullets(brief.constraints)}`,
    ...(isProjectInternal(task) ? [`涉及的项目：${internalBriefScope(task)}`] : []),
    ...(triggerLine(task) ? [triggerLine(task)!] : []),
    ...(brief.constraints.length > 0 ? ["约束里用户说过的限制，写成计划的条件（rules：时序规则）。"] : []),
    `请据此把要做的事排成步骤（每步一次工具调用，连同要满足的条件），用 ${WORKFLOW_TOOL.proposePlan} 提交；用户授权之前不要动手做。`,
  ].join(NL);
}
// @i18n-ignore-end

/**
 * 任务书交给任务自己的维护者的那条通知（和 buildAgentNotice 一样）；第一版标上 taskBrief（172 号票：网页按它认，在对话层照常显示）
 */
function briefNotice(task: Task, text: string, revision: number): NewEvent {
  return buildMessage(
    { conversation: maintainerChannel(task.maintainerId), speaker: "system", parts: [{ type: "text", text }], ...(revision === 1 ? { taskBrief: true as const } : {}) },
    { agentInput: true, idempotencyKey: `brief:${task.id}:${revision}`, taskId: task.id },
  ).event;
}

/** 建出全局任务时给秘书的通知（64 号票：建成项目内部任务的交给项目的维护者，见 buildInternal）；秘书自己建的不另通知 */
function secretaryStartNotice(task: Task, start: StartNotice | undefined): NewEvent[] {
  const text = start?.how === "button" ? buttonStartedNotice(task) : start?.how === "secretary_suggestion" ? suggestionStartedNotice(task) : undefined;
  return start === undefined || text === undefined ? [] : [buildAgentNotice(CHANNELS.secretary, text, `${start.key}#notice`).event];
}

export function createTaskService(options: TaskServiceOptions): TaskService {
  const { store, cards, inbox, now } = options;

  const settings = (): WatchCategorySettings => readWatchSettings(options.watchSettings);

  const mustGet = (taskId: string): Task => {
    const task = getTask(store.reader, taskId);
    if (!task) {
      // 项目内部任务不列出来（秘书看不到它们，64 号票）
      const list = listTasks(store.reader)
        .filter((tk) => tk.state === "planning" && !isProjectInternal(tk))
        .map((x) => idLabel(x.id, x.title))
        .join(t("protocol.common.semiSep"));
      throw new RequestRejected("not_found", list ? t("tasks.tasks.notFoundWithList", { id: taskId, list }) : t("tasks.tasks.notFoundNoList", { id: taskId }));
    }
    return task;
  };

  /** 状态迁移的事件：按"谁能改"表校验，不让做就拒绝并说明原因 */
  const transition = (task: Task, to: TaskState, by: TaskActor, change: TaskChange, patch: Partial<Task> = {}): { task: Task; event: NewEvent } => {
    const check = checkTaskTransition(task.state, to, by);
    if (!check.ok) throw new RequestRejected("not_allowed", check.reason);
    const next: Task = { ...task, ...patch, state: to, updatedAt: now() };
    const payload: TaskEventPayload = { task: next, change, from: task.state, by };
    return { task: next, event: { channel: CHANNELS.board, type: EVENT_TYPES.task, payload } };
  };

  const buildCreate = (input: NewTask, by: TaskActor, start?: StartNotice): { task: Task; events: NewEvent[] } => {
    // 建任务卡不是迁移：只有用户（按钮、建议卡）和按用户要求的秘书能建
    if (by !== "user" && by !== "secretary") throw new RequestRejected("not_allowed", "只有用户能发起任务（秘书按用户的要求建任务卡）"); // @i18n-ignore log：调用方写错了才有
    const projects = [...new Set((input.projects ?? []).map((p) => p.trim()).filter(Boolean))];
    const kind = input.kind ?? "long_running";
    const trigger = checkedTrigger(kind, input.trigger, now(), options.checkEventTrigger);
    // 涉及的项目认成编号：不在项目列表里、已归档的拒绝并说明
    const projectIds = options.projects?.().checkTaskProjects(projects);
    if (kind === "workflow" && (projectIds?.length ?? projects.length) > 1) throw new RequestRejected("not_allowed", workflowProjectsRefusal());
    // 只涉及一个项目的任务一律是这个项目的内部任务（64 号票，用户定）：由项目的维护者执行，只在项目里看得到
    if (projectIds?.length === 1) return buildInternal({ projectId: projectIds[0]!, title: input.title, summary: input.summary, kind, origin: input.origin, ...(trigger ? { trigger } : {}) }, by, start);
    // 在哪个文件夹做（305 号票）：能选工作文件夹的运行时才定（接管来的已经给了会话原来的）
    const workdir = input.workdir ?? options.workFolder?.(input.runtime, input.folder, input.title);
    const n = countTasks(store.reader) + 1;
    const time = now();
    // 全局任务由任务自己的维护者执行；涉及几个项目在建卡时定下（17 号票）：两个以上的是多项目。
    // 普通任务（75 号票）不规划：建出就排队，有名额就开始做（执行控制器）
    const task: Task = {
      id: `t-${n}`,
      title: oneLine(input.title, TITLE_MAX),
      summary: input.summary.trim(),
      state: initialState(kind, trigger),
      origin: input.origin,
      kind,
      ...(trigger ? { trigger } : {}),
      maintainerId: ownMaintainerId(`t-${n}`),
      projects,
      ...(projectIds === undefined ? {} : { projectIds }),
      projectScope: (projectIds?.length ?? projects.length) >= 2 ? "multi" : "none",
      ...(input.voiceAnnounce ? { voiceAnnounce: true } : {}),
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
      ...(workdir === undefined ? {} : { workdir }),
      ...(input.takeover === undefined ? {} : { takeover: { ...input.takeover } }),
      createdAt: time,
      updatedAt: time,
    };
    const payload: TaskEventPayload = { task, change: "created", from: null, by };
    // 普通任务不用秘书澄清、写任务书：不通知它（它在看板变化里看得到）
    return { task, events: [{ channel: CHANNELS.board, type: EVENT_TYPES.task, payload }, ...(isPlainTask(task) ? [] : secretaryStartNotice(task, start))] };
  };

  /**
   * 发起对话框、秘书建任务时写的运行时（289 号票）：pi 不写；别的要现在能用（runtimeRefusal 交回不能用的原因，抛 RequestRejected）；
   * 只涉及一个项目的（建成项目内部任务）不看它（照项目的）
   */
  const checkedRuntime = (runtime: string | undefined): string | undefined => {
    if (runtime === undefined || runtime === PI_RUNTIME_ID) return undefined;
    const refused = options.runtimeRefusal?.(runtime);
    if (refused !== undefined) throw new RequestRejected("bad_params", refused);
    return runtime;
  };

  /** 开关"跑完自动播报"（100 号票）：状态不变的一条 voice_announce_set；本来就是这样的不记 */
  const buildVoiceAnnounce = (taskId: string, on: boolean, by: TaskActor, idempotencyKey?: string): { task: Task; events: NewEvent[] } => {
    const task = getTask(store.reader, taskId);
    if (!task) throw new RequestRejected("not_found", t("tasks.tasks.noTask", { id: taskId }));
    if (!canSetVoiceAnnounce(task)) {
      throw new RequestRejected(
        "not_allowed",
        isProjectInternal(task)
          ? t("tasks.tasks.announceInternal", { task: idLabel(task.id, task.title), assistant: ASSISTANT_NAME_MARK })
          : t("tasks.tasks.announceEnded", { task: idLabel(task.id, task.title), state: TASK_STATE_LABEL[task.state] }),
      );
    }
    if ((task.voiceAnnounce === true) === on) return { task, events: [] };
    const next: Task = { ...task, voiceAnnounce: on, updatedAt: now() };
    const payload: TaskEventPayload = { task: next, change: "voice_announce_set", from: task.state, by };
    return { task: next, events: [{ channel: CHANNELS.board, type: EVENT_TYPES.task, payload, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }] };
  };

  /**
   * 项目内部任务的归属（64 号票）：执行的是项目的维护者，涉及的项目只有它，带着项目内部的标记。建出（buildInternal）、
   * 第一版任务书定下只涉及一个项目（settledByBrief）都用这一份；项目不能发起时（立项书还没确认、已归档……）抛出原因
   */
  const internalOwnership = (projectId: string, origin: TaskOrigin): Pick<Task, "maintainerId" | "projects" | "projectIds" | "projectScope" | "internal"> => {
    if (!options.projects) throw new RequestRejected("not_allowed", "项目内部任务还没接上"); // @i18n-ignore log：装配时漏了
    const host = options.projects().internalHost(projectId, { firstBuild: origin === "project_build" });
    return { maintainerId: host.maintainerId, projects: [host.name], projectIds: [host.id], projectScope: "single", internal: { projectId: host.id, projectName: host.name } };
  };

  /**
   * 执行的是项目的维护者，涉及的项目只有它，只在项目内部看得到；不是维护者自己建的（给了 start），同一事务通知它。
   * 通知带着任务编号：维护者正在做工单时排着（工单段里没有写任务书的工具），空下来在对话段里处理（work-orders/segments.ts）
   */
  function buildInternal(input: NewInternalTask, by: TaskActor, start?: StartNotice, nth = 0): { task: Task; events: NewEvent[] } {
    const trigger = checkedTrigger(input.kind, input.trigger, now(), options.checkEventTrigger);
    const owner = internalOwnership(input.projectId, input.origin);
    const n = countTasks(store.reader) + 1 + nth;
    const time = now();
    const task: Task = {
      id: `t-${n}`,
      title: oneLine(input.title, TITLE_MAX),
      summary: input.summary.trim(),
      state: initialState(input.kind, trigger),
      origin: input.origin,
      kind: input.kind,
      ...(trigger ? { trigger } : {}),
      ...owner,
      createdAt: time,
      updatedAt: time,
    };
    const payload: TaskEventPayload = { task, change: "created", from: null, by };
    const created: NewEvent = { channel: CHANNELS.board, type: EVENT_TYPES.task, payload };
    // 普通任务（75 号票）不用和维护者对齐、写任务书：派单器看到它进了排队就派一张执行的工单（work-orders/），工单开始时交给维护者
    if (!start || isPlainTask(input)) return { task, events: [created] };
    const notice = buildAgentNotice(maintainerChannel(task.maintainerId), internalStartedNotice(task, start.how), `${start.key}#notice`, { projectId: input.projectId, taskId: task.id });
    return { task, events: [created, notice.event] };
  }

  /** 运营方案里流程的那一条（130 号票）：见 TaskService.buildAuthorizedWorkflow */
  const buildAuthorizedWorkflow: TaskService["buildAuthorizedWorkflow"] = (input, reviewed, auth, nth = 0) => {
    const trigger = checkedTrigger("workflow", input.trigger, now(), options.checkEventTrigger);
    const owner = internalOwnership(input.projectId, input.origin);
    const id = `t-${countTasks(store.reader) + 1 + nth}`;
    const title = oneLine(input.title, TITLE_MAX);
    const time = now();
    const planId = `${id}-p1`;
    const workflow = { ...reviewed.plan, version: 1 };
    // 需要用户确认的事项：一次确认不等于默认同意它们，勾完才能授权（照流程计划卡）
    const items = workflowConfirmationItems(workflow.review, workflow.steps);
    const required = items.map((i) => i.key);
    const ticked = new Set(auth.confirmations);
    const missing = items.filter((i) => !ticked.has(i.key));
    if (missing.length > 0) throw new RequestRejected("bad_params", t("tasks.tasks.unconfirmed", { items: missing.map((i) => i.text).join(t("protocol.common.semiSep")) }));
    const settingsNow = settings();
    const plan = snapshotWatchCategories(reviewed.execution, settingsNow);
    const grantInfo = grantInfoOf(plan, { tools: options.planTools, settings: settingsNow });
    const card = cards.buildCreate({
      type: "workflow_plan",
      urgency: "non_blocking",
      status: "handled",
      outcome: { action: "confirm", note: auth.note },
      payload: {
        taskId: id,
        taskTitle: title,
        revision: 1,
        planId,
        goal: input.summary.trim(),
        plan: workflow,
        ...(required.length > 0 ? { confirmed: required } : {}),
        ...(isTriggered({ trigger }) && trigger?.kind === "schedule" ? { schedule: trigger.schedule } : {}),
        ...(trigger?.kind === "event" ? { event: trigger } : {}),
      } satisfies WorkflowPlanCardPayload,
    });
    const task: Task = {
      id,
      title,
      summary: input.summary.trim(),
      // 授权了：定时、事件触发的进运营中（触发底座看到它就登记触发），某个时间做一次的等时间
      state: isTriggered({ trigger }) ? "operating" : onceAt({ trigger }) !== undefined ? "scheduled" : "queued",
      origin: input.origin,
      kind: "workflow",
      ...(trigger ? { trigger } : {}),
      ...owner,
      planCardId: card.card.id,
      steps: { total: workflow.steps.length, done: 0 },
      createdAt: time,
      updatedAt: time,
    };
    const created: TaskEventPayload = { task, change: "created", from: null, by: "user" };
    const submitted: PlanSubmittedPayload = { taskId: id, planId, revision: 1, plan: reviewed.execution, workflow, cardId: card.card.id, maintainerId: owner.maintainerId, time };
    const decided: PlanDecidedPayload = {
      taskId: id,
      taskTitle: title,
      planId,
      revision: 1,
      cardId: card.card.id,
      decision: "confirmed",
      plan,
      workflow,
      ...(required.length > 0 ? { confirmations: required } : {}),
      removedGrants: [],
      narrowedGrants: [],
      grantInfo,
      by: "user",
      time,
    };
    return {
      task,
      events: [
        { channel: CHANNELS.board, type: EVENT_TYPES.task, payload: created },
        card.event,
        { channel: TASKS_CHANNEL, type: TASK_EVENTS.planSubmitted, payload: submitted },
        { channel: TASKS_CHANNEL, type: TASK_EVENTS.planDecided, payload: decided, idempotencyKey: `${auth.key}#decided` },
      ],
    };
  };

  /** 用户自己的话（核对用户的限制里的原话）：任务书的约束、点按钮发起任务时写的、用户在这个任务的维护者会话里发的消息 */
  const userWords = (task: Task): string[] => {
    const messages = store
      .read(maintainerChannel(task.maintainerId), 0, EVENT_TYPES.message)
      .map((e) => e.payload)
      .filter((p): p is MessageEventPayload => !isDeletedEventPayload(p) && (p as MessageEventPayload).message.speaker === "user")
      .map((p) => p.message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""));
    return [...(getBrief(store.reader, task.id)?.brief.constraints ?? []), ...(task.origin === "button" ? [task.summary] : []), ...messages];
  };

  /**
   * 秘书建卡时没写涉及的项目（任务自己的维护者还没接过任何输入）：第一版任务书定下涉及几个项目，之后的任务书、计划都不再改
   * （17 号票）。只涉及一个项目列表里的项目的，成了这个项目的内部任务（64 号票，用户定；归属同 buildInternal：internalOwnership），
   * 改由它的维护者起草并执行（看板上的任务事件 handed_to_project，状态不变；项目还在立项、已归档的拒绝并说明）；
   * 涉及两个以上、都在项目列表里的，定为多项目任务（projects_settled，执行的还是任务自己的维护者）。
   * 用户定（2026-10-10）：只管"建的时候"——定下是跨项目任务之后计划里缩到只涉及一个项目的，留在全局看板，照旧做完
   */
  const settledByBrief = (task: Task, brief: TaskBrief, revision: number): { task: Task; event: NewEvent } | undefined => {
    if (revision !== 1 || !hasOwnMaintainer(task) || task.projects.length > 0 || !options.projects) return undefined;
    const names = [...new Set(brief.projects.map((p) => p.trim()).filter(Boolean))];
    if (names.length === 0 || options.projects().projectIdsOf(names).length !== names.length) return undefined;
    const projectIds = options.projects().checkTaskProjects(names);
    const handed = projectIds.length === 1;
    const next: Task = handed
      ? { ...task, ...internalOwnership(projectIds[0]!, task.origin), updatedAt: now() }
      : { ...task, projects: names, projectIds, projectScope: "multi", updatedAt: now() };
    const payload: TaskEventPayload = { task: next, change: handed ? "handed_to_project" : "projects_settled", from: task.state, by: "secretary" };
    return { task: next, event: { channel: CHANNELS.board, type: EVENT_TYPES.task, payload } };
  };

  /**
   * 流程的一版计划（58 号票）：存进事件日志、出流程计划卡放进待我处理。交给用户授权的（refused 不给）卡着任务、任务转待确认；
   * 审查没让它交给用户授权的（refused）卡上不能授权，判定不可执行的卡着任务（等用户决定让维护者改还是取消），
   * 退回的不卡任务（维护者会自己改好重新提交），任务还在规划中。之前没处理的、审查没通过的那几版的卡过期
   */
  const putWorkflowPlan = (taskId: string, maintainerId: string, reviewed: ReviewedWorkflow, refused?: "needs_replan" | "blocked") => {
    const task = mustGet(taskId);
    // @i18n-ignore-start model：交回维护者
    if (task.maintainerId !== maintainerId) throw new RequestRejected("not_allowed", `任务 ${taskId} 不是你执行的，只有它的维护者能提交计划`);
    if (isPlainTask(task)) throw new RequestRejected("not_allowed", `任务 ${taskId} 是普通任务：不交计划，直接做`);
    if (taskKind(task) !== "workflow") throw new RequestRejected("not_allowed", `任务 ${taskId} 是长程任务，计划用 ${SUBMIT_PLAN_TOOL} 提交`);
    if (task.state !== "planning") throw new RequestRejected("not_allowed", `任务 ${taskId} 现在不在规划中，不能再提交计划`);
    // @i18n-ignore-end
    const title =
      refused === "blocked" ? t("tasks.tasks.workflowPlanBlocked") : refused === "needs_replan" ? t("tasks.tasks.workflowPlanReturned") : t("tasks.tasks.workflowPlanWaiting");
    const put = workflowPlanEvents(task, { workflow: reviewed.plan, execution: reviewed.execution, maintainerId, title, ...(refused ? { refused } : {}) });
    const moved = refused ? [] : [transition(task, "awaiting_confirm", "maintainer", "plan_submitted", { planCardId: put.cardId, steps: { total: reviewed.plan.steps.length, done: 0 } }).event];
    store.appendBatch([...supersedeRefused(taskId), ...put.events, ...moved, put.item.event]);
    inbox.alert(put.item.item);
    return { cardId: put.cardId, planId: put.planId, revision: put.revision };
  };

  /**
   * 流程的一版计划要追加的（不追加）：这一版（plan_submitted，版本号接着往上加）、流程计划卡，待我处理里的事项另给（调用方放在
   * 任务的变化之后追加、落盘之后提示）。refused：审查没让它交给用户授权的（卡上不能授权，退回的不卡任务）
   */
  const workflowPlanEvents = (
    task: Task,
    o: { workflow: WorkflowPlan; execution: Plan; maintainerId: string; title: string; refused?: "needs_replan" | "blocked" },
  ): { events: NewEvent[]; item: { item: InboxItem; event: NewEvent }; cardId: string; planId: string; revision: number } => {
    const { refused } = o;
    const revision = (latestPlan(store.reader, task.id)?.revision ?? 0) + 1;
    const planId = `${task.id}-p${revision}`;
    const plan = { ...o.workflow, version: revision };
    const urgency = refused === "needs_replan" ? "non_blocking" : "blocking";
    const card = cards.buildCreate({
      type: "workflow_plan",
      urgency,
      payload: {
        taskId: task.id,
        taskTitle: task.title,
        revision,
        planId,
        goal: getBrief(store.reader, task.id)?.brief.goal ?? task.summary,
        plan,
        ...(refused ? { refused } : {}),
        // 定时触发的流程（76 号票）：卡上写明按时间表反复运行、授权一直有效，直到暂停或取消（某个时间做一次的不是反复运行，不写）
        ...(isTriggered(task) && task.trigger?.kind === "schedule" ? { schedule: task.trigger.schedule } : {}),
        // 事件触发的流程（77 号票）：卡上写明在等什么事件、每次事件发生时运行、授权一直有效
        ...(task.trigger?.kind === "event" ? { event: task.trigger } : {}),
      } satisfies WorkflowPlanCardPayload,
    });
    const submitted: PlanSubmittedPayload = { taskId: task.id, planId, revision, plan: o.execution, workflow: plan, ...(refused ? { refused } : {}), cardId: card.card.id, maintainerId: o.maintainerId, time: now() };
    const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: oneLine(t("tasks.tasks.inboxTitle", { what: o.title, title: task.title }), 60), ...taskInboxOrigin(task), urgency });
    return { events: [{ channel: TASKS_CHANNEL, type: TASK_EVENTS.planSubmitted, payload: submitted }, card.event], item, cardId: card.card.id, planId, revision };
  };

  /**
   * 撤回会话回到计划确认之前、重新确认的（152 号票；153 号票起流程重新授权也一样）：和作废的那一版比，原样留着、收窄了的授权项接着用
   * 那时的授予时间，被放弃那段里用掉的次数照样算（ADR 0003，同计划变更的 grantTimesAfter 口径）；新加的、换了阶段的从这次确认起算。
   * 不是撤回之后重新确认的（现在有生效的计划、没有作废时记下授予时间的那一版）不带
   */
  const carriedGrantTimes = (taskId: string, plan: Plan, time: string): { grantTimes?: GrantTimes } => {
    const voided = confirmedPlan(store.reader, taskId) ? undefined : listPlans(store.reader).findLast((p) => p.taskId === taskId && p.status === "rejected" && p.grantTimes !== undefined);
    if (!voided) return {};
    return { grantTimes: isoTimes(grantTimesAfter({ before: voided.plan, beforeTimes: voided.grantTimes, beforeConfirmedAt: Date.parse(time), after: plan, at: Date.parse(time), tools: options.planTools })) };
  };

  /**
   * 维护者交了新的一版（流程）：之前审查没让它交给用户授权、卡还没处理的几版过期（卡不再等用户，待我处理里也不再卡着任务）
   */
  const supersedeRefused = (taskId: string): NewEvent[] =>
    refusedPlans(store.reader, taskId)
      .filter((p) => cards.get(p.cardId)?.status === "pending")
      .map((p) => cards.buildUpdate(p.cardId, { status: "expired" }).event);

  /**
   * 流程的计划交回维护者重新起草（拒绝、让维护者改）：项目的任务（64 号票起有项目内部的流程）派一张起草计划的工单（内容是这些话
   * 加上任务书：新的一段会话里没有上一版的对话；维护者正在起草就作为通知交给它），任务自己的维护者直接交给它
   */
  const replanHandOver = (task: Task, text: string, idempotencyKey: string): NewEvent[] => {
    const current = getBrief(store.reader, task.id);
    const forProject = options.workOrders?.().dispatchPlan(task, current ? `${text}\n\n${briefText(task, current.brief, current.revision, globalWatchCategories(settings()))}` : text, `${idempotencyKey}#replan`);
    return forProject ?? [buildAgentNotice(maintainerChannel(task.maintainerId), text, `${idempotencyKey}#notice`, { taskId: task.id }).event];
  };

  /** 审查没让它交给你授权的那一版（流程计划卡上的"让维护者改"）：这一版是 refused、任务还在规划中 */
  const refusedPlan = (payload: { taskId: string; planId: string }): { task: Task; stored: StoredPlan } => {
    const stored = getPlan(store.reader, payload.planId);
    const task = getTask(store.reader, payload.taskId);
    if (!stored || !task) throw new RequestRejected("not_found", t("tasks.tasks.noPlan", { id: payload.planId }));
    if (stored.status !== "refused") throw new RequestRejected("conflict", t("tasks.tasks.planHandled"));
    if (task.state !== "planning") throw new RequestRejected("conflict", t("tasks.tasks.notPlanning", { state: TASK_STATE_LABEL[task.state] }));
    return { task, stored };
  };

  /** 计划卡上的动作能不能做：这一版计划还待确认，任务也还在待确认 */
  const pendingPlan = (payload: { taskId: string; planId: string }): { task: Task; stored: StoredPlan } => {
    const stored = getPlan(store.reader, payload.planId);
    const task = getTask(store.reader, payload.taskId);
    if (!stored || !task) throw new RequestRejected("not_found", t("tasks.tasks.noPlan", { id: payload.planId }));
    if (stored.status !== "pending" || task.planCardId !== stored.cardId) throw new RequestRejected("conflict", t("tasks.tasks.planHandled"));
    return { task, stored };
  };

  return {
    buildCreate,
    buildConvertToProject(taskId) {
      const task = mustGet(taskId);
      if (!hasOwnMaintainer(task)) throw new RequestRejected("not_allowed", t("tasks.tasks.noConvert", { task: idLabel(task.id, task.title) }));
      return transition(task, "done", "user", "converted_to_project", { endKind: "converted_to_project" });
    },
    createByRequest(input) {
      let built: { task: Task; events: NewEvent[] };
      try {
        built = buildCreate({ ...input, origin: "request" }, "secretary", { how: "secretary", key: `request:${randomUUID()}` });
      } catch (err) {
        // 秘书认错了项目：说不清是哪个项目时先问用户
        if (err instanceof UnknownProjects) throw new RequestRejected(err.code, `${err.message}。说不清是哪个项目时先问用户，不要猜`); // @i18n-ignore model
        throw err;
      }
      store.appendBatch(built.events);
      return built.task;
    },
    startFromButton(params, idempotencyKey) {
      // 同一个幂等键重发：拿到第一次建出的那个（在定工作文件夹之前看：不多开一个子文件夹）
      const done = store.eventByIdempotencyKey(idempotencyKey);
      if (done?.type === EVENT_TYPES.task) return (done.payload as TaskEventPayload).task;
      const text = params.request.trim();
      if (!text) throw new RequestRejected("bad_params", t("tasks.tasks.emptyRequest"));
      // 发起对话框里先选了种类（58 号票）：不选是长程任务。只选了一个项目的是这个项目的内部任务（64 号票）；通知谁由 buildCreate 定
      // 选的运行时（289 号票）：现在能用的才行（pi 不写）
      const runtime = checkedRuntime(params.runtime);
      const { events } = buildCreate(
        {
          title: text.split(/\r?\n/)[0]!,
          summary: text,
          origin: "button",
          kind: params.kind ?? "long_running",
          projects: params.projects ?? [],
          ...(params.trigger ? { trigger: params.trigger } : {}),
          ...(params.voiceAnnounce ? { voiceAnnounce: true } : {}),
          ...(runtime === undefined ? {} : { runtime }),
          ...(params.folder === undefined ? {} : { folder: params.folder }),
        },
        "user",
        { how: "button", key: idempotencyKey },
      );
      // 同一个幂等键重发：不多建任务，拿到第一次建出的那个
      const [first] = store.appendBatch([{ ...events[0]!, idempotencyKey }, ...events.slice(1)]);
      return (first!.event.payload as TaskEventPayload).task;
    },
    startTakenOver(input, idempotencyKey, extra) {
      const done = store.eventByIdempotencyKey(idempotencyKey);
      if (done) return (done.payload as TaskEventPayload).task;
      const text = input.request.trim();
      if (!text) throw new RequestRejected("bad_params", t("tasks.tasks.emptyRequest"));
      const runtime = checkedRuntime(input.runtime);
      // 普通任务（75 号票）：建出就排队，有名额就开始做——第一条输入就是用户写的这段话；前情跟着任务一起追加（在它之前进会话）
      const { task, events } = buildCreate(
        { title: input.title, summary: text, origin: "takeover", kind: "plain", ...(runtime === undefined ? {} : { runtime }), workdir: input.workdir, takeover: input.takeover },
        "user",
        { how: "button", key: idempotencyKey },
      );
      const [first] = store.appendBatch([{ ...events[0]!, idempotencyKey }, ...events.slice(1), ...extra(task)]);
      return (first!.event.payload as TaskEventPayload).task;
    },
    setTakeover(taskId, takeover) {
      const task = getTask(store.reader, taskId);
      if (!task) throw new RequestRejected("not_found", t("tasks.tasks.noTask", { id: taskId }));
      // @i18n-ignore-next log：调用方写错了才有
      if (!task.takeover && takeover.own !== true) throw new RequestRejected("not_allowed", `${taskId} 不是从已有的会话接管来的`);
      const next: Task = { ...task, takeover: { ...takeover }, updatedAt: now() };
      const payload: TaskEventPayload = { task: next, change: "takeover_set", from: task.state, by: "user" };
      store.append({ channel: CHANNELS.board, type: EVENT_TYPES.task, payload });
      return next;
    },
    setVoiceAnnounce(params, idempotencyKey, by = "user") {
      const done = store.eventByIdempotencyKey(idempotencyKey);
      if (done) {
        const { task } = done.payload as TaskEventPayload;
        return { taskId: task.id, on: task.voiceAnnounce === true };
      }
      const built = buildVoiceAnnounce(params.taskId, params.on, by, idempotencyKey);
      if (built.events.length > 0) store.appendBatch(built.events);
      return { taskId: built.task.id, on: built.task.voiceAnnounce === true };
    },
    buildVoiceAnnounce,
    setRuntime(taskId, runtime, runtimeOptions, by) {
      const task = getTask(store.reader, taskId);
      if (!task) throw new RequestRejected("not_found", t("tasks.tasks.noTask", { id: taskId }));
      const nextRuntime = runtime === undefined || runtime === PI_RUNTIME_ID ? undefined : runtime;
      const nextOptions = runtimeOptions && (runtimeOptions.model !== undefined || Object.keys(runtimeOptions.settings ?? {}).length > 0) ? runtimeOptions : undefined;
      if (task.runtime === nextRuntime && JSON.stringify(task.runtimeOptions) === JSON.stringify(nextOptions)) return task;
      const { runtime: _runtime, runtimeOptions: _options, takeover, ...rest } = task;
      // 接管来的（290 号票）换了别的运行时：不再记着接管的会话（写入锁跟着放开），工作目录照旧
      const keepTakeover = takeover !== undefined && takeover.runtime === (nextRuntime ?? PI_RUNTIME_ID);
      const next: Task = {
        ...rest,
        ...(nextRuntime === undefined ? {} : { runtime: nextRuntime }),
        ...(nextOptions === undefined ? {} : { runtimeOptions: nextOptions }),
        ...(keepTakeover ? { takeover } : {}),
        updatedAt: now(),
      };
      const payload: TaskEventPayload = { task: next, change: "runtime_set", from: task.state, by };
      store.append({ channel: CHANNELS.board, type: EVENT_TYPES.task, payload });
      return next;
    },
    delegate(input) {
      const instructions = input.instructions.trim();
      if (!instructions) throw new RequestRejected("bad_params", "要交出去的事是空的：写清楚要做什么"); // @i18n-ignore model
      let built: { task: Task; events: NewEvent[] };
      try {
        built = buildCreate(
          {
            title: input.title,
            summary: instructions,
            origin: "delegated",
            kind: "plain",
            ...(input.projects ? { projects: input.projects } : {}),
            // 某个时间做一次（76 号票）：等到那个时间再做
            ...(input.at === undefined ? {} : { trigger: { kind: "schedule" as const, schedule: { kind: "once" as const, at: input.at } } }),
            ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
            ...(input.folder === undefined ? {} : { folder: input.folder }),
          },
          "secretary",
        );
      } catch (err) {
        if (err instanceof UnknownProjects) throw new RequestRejected(err.code, `${err.message}。说不清是哪个项目时先问用户，不要猜；不涉及项目的不写`); // @i18n-ignore model
        throw err;
      }
      store.appendBatch(built.events);
      return built.task;
    },
    buildInternal,
    buildAuthorizedWorkflow,
    buildMigrated(input, nth = 0) {
      const n = countTasks(store.reader) + 1 + nth;
      const time = now();
      const task: Task = {
        id: `t-${n}`,
        title: oneLine(input.title, TITLE_MAX),
        summary: input.summary.trim(),
        state: "operating",
        origin: "migrated",
        kind: "plain",
        trigger: { kind: "schedule", schedule: input.schedule },
        maintainerId: input.maintainerId,
        projects: input.project ? [input.project.name] : [],
        ...(input.project ? { projectIds: [input.project.id] } : {}),
        projectScope: input.project ? "single" : "none",
        ...(input.internal ? { internal: input.internal } : {}),
        createdAt: time,
        updatedAt: time,
      };
      const payload: TaskEventPayload = { task, change: "created", from: null, by: "system" };
      return { task, event: { channel: CHANNELS.board, type: EVENT_TYPES.task, payload } };
    },
    createInternal(input, maintainerId) {
      const { task, events } = buildInternal({ ...input, origin: "request" }, "maintainer");
      if (task.maintainerId !== maintainerId) throw new RequestRejected("not_allowed", `只有项目的维护者能在项目里发起内部任务`); // @i18n-ignore model
      store.appendBatch(events);
      return task;
    },
    writeBrief(taskId, brief, writer) {
      const task = mustGet(taskId);
      // 项目内部任务的任务书由它的维护者自己写（64 号票）；秘书看不到项目内部任务
      if (isProjectInternal(task) && writer?.maintainerId !== task.maintainerId) throw new RequestRejected("not_found", notFoundText(taskId));
      // @i18n-ignore-start model：写任务书是秘书、维护者的工具，交回 agent
      if (!isProjectInternal(task) && writer) throw new RequestRejected("not_allowed", `任务 ${task.id} 不是这个项目的内部任务：它的任务书由秘书写`);
      // 普通任务（75 号票）没有任务书：交代的那段话已经交给 agent 了
      if (isPlainTask(task)) throw new RequestRejected("not_allowed", `任务 ${task.id}「${task.title}」是普通任务：不写任务书，交代的事已经交给它的 agent；要补充就让用户在任务详情里接着说`);
      if (task.state !== "planning") {
        throw new RequestRejected("not_allowed", `任务 ${task.id}「${task.title}」现在是${task.state === "awaiting_confirm" ? "待确认（计划等用户确认）" : "已经过了规划"}，不能再写任务书`);
      }
      // @i18n-ignore-end
      if (isProjectInternal(task)) {
        // 项目内部任务只动本项目（64 号票）：要动别的项目，告诉用户改成普通任务
        const others = brief.projects.map((p) => p.trim()).filter((p) => p !== "" && !task.projects.includes(p));
        if (others.length > 0) throw new RequestRejected("not_allowed", internalOtherProjects(others));
      }
      const revision = (getBrief(store.reader, taskId)?.revision ?? 0) + 1;
      const payload: TaskBriefPayload = { taskId, brief, revision, time: now() };
      // 建卡时没写项目：第一版任务书定下涉及几个项目（只涉及一个的交给这个项目的维护者，成了它的内部任务，16、17、64 号票）
      const handed = settledByBrief(task, brief, revision);
      const owned = handed?.task ?? task;
      // 流程只在一个项目里做（成了这个项目的内部任务）或者不涉及项目（58 号票）
      if (!isProjectInternal(owned) && taskKind(owned) === "workflow" && brief.projects.some((p) => p.trim() !== "")) {
        throw new RequestRejected("not_allowed", `${forModel(workflowProjectsRefusal)}（任务书的 projects 写空数组）`); // @i18n-ignore model
      }
      const text = briefText(owned, brief, revision, globalWatchCategories(settings()));
      // 项目的任务：派一张起草计划的工单（16 号票）；任务自己的维护者：直接交给它
      const handOver = options.workOrders?.().dispatchPlan(owned, text, `brief:${taskId}:${revision}`) ?? [briefNotice(owned, text, revision)];
      store.appendBatch([...(handed ? [handed.event] : []), { channel: TASKS_CHANNEL, type: TASK_EVENTS.briefWritten, payload }, ...handOver]);
      return { task: owned, revision };
    },
    buildBriefRevision(taskId, patch) {
      const current = getBrief(store.reader, taskId);
      if (!current) throw new RequestRejected("not_found", `任务 ${taskId} 还没有任务书`); // @i18n-ignore model
      const payload: TaskBriefPayload = { taskId, brief: { ...current.brief, ...patch }, revision: current.revision + 1, time: now() };
      return { channel: TASKS_CHANNEL, type: TASK_EVENTS.briefWritten, payload };
    },
    submitPlan(taskId, maintainerId, plan) {
      const task = mustGet(taskId);
      // @i18n-ignore-start model：交回维护者
      if (task.maintainerId !== maintainerId) throw new RequestRejected("not_allowed", `任务 ${taskId} 不是你执行的，只有它的维护者能提交计划`);
      if (isPlainTask(task)) throw new RequestRejected("not_allowed", `任务 ${taskId} 是普通任务：不交计划，直接做`);
      // @i18n-ignore-end
      // 76 号票起计划里不再写定时作业（提交计划的工具的参数里没有这一项；直接调进来的也拒，说清改去哪里建）
      if (Object.hasOwn(plan, "scheduledJobs")) throw new RequestRejected("bad_params", PLAN_JOBS_REFUSAL);
      const basic = checkPlan(plan, { tools: options.planTools, settings: settings(), taskId, ...(options.toolkitProblems ? { toolkitProblems: options.toolkitProblems } : {}) });
      // 涉及的项目要对得上任务（17 号票评审后定）
      const problems = basic.ok ? (options.planProjects?.(task, basic.plan) ?? []) : basic.problems;
      if (problems.length > 0) throw new RequestRejected("bad_params", `计划没通过检查，改好再提交：\n- ${problems.join("\n- ")}`); // @i18n-ignore model
      // 编号存进计划（93 号票）：第一版按依赖层定，打回后重交的也是第一版（只有计划调整才沿用）
      const checked = { plan: withStageCodes(basic.ok ? basic.plan : plan) };
      const revision = (latestPlan(store.reader, taskId)?.revision ?? 0) + 1;
      const planId = `${taskId}-p${revision}`;
      const card = cards.buildCreate({
        type: "plan",
        urgency: "blocking",
        payload: {
          taskId,
          taskTitle: task.title,
          revision,
          planId,
          goal: getBrief(store.reader, taskId)?.brief.goal ?? task.summary,
          plan: checked.plan,
          globalCategories: globalWatchCategories(settings()).map((c) => c.id),
          grantInfo: grantInfoOf(checked.plan, { tools: options.planTools, settings: settings() }),
          verifiedQuotes: verifiedQuotes(checked.plan.userLimits ?? [], userWords(task)),
        } satisfies PlanCardPayload,
      });
      // 项目的任务（16 号票）：执行它的项目总在涉及的项目里，计划里没写也算
      const project = options.projects?.().projectOf(task);
      const names = [...new Set([...(project ? [project.name] : []), ...checked.plan.projects.map((p) => p.project)])];
      const moved = transition(task, "awaiting_confirm", "maintainer", "plan_submitted", {
        planCardId: card.card.id,
        stages: { total: checked.plan.stages.length },
        projects: names,
        ...(options.projects ? { projectIds: [...new Set([...(project ? [project.id] : []), ...options.projects().projectIdsOf(names)])] } : {}),
      });
      const submitted: PlanSubmittedPayload = { taskId, planId, revision, plan: checked.plan, cardId: card.card.id, maintainerId, time: now() };
      const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: oneLine(t("tasks.tasks.planWaiting", { title: task.title }), 60), ...taskInboxOrigin(task), urgency: "blocking" });
      store.appendBatch([{ channel: TASKS_CHANNEL, type: TASK_EVENTS.planSubmitted, payload: submitted }, card.event, moved.event, item.event]);
      inbox.alert(item.item);
      return { cardId: card.card.id, planId, revision };
    },
    confirmFromCard(payload, input, idempotencyKey) {
      const pending = pendingPlan(payload);
      const { task } = pending;
      // 升级前交的计划里的定时作业（76 号票）：照迁移的办法建成定时触发的普通任务；确认的是拿掉它之后的计划
      const legacy = options.legacyPlanJobs?.(task, pending.stored, payload.grantInfo) ?? { events: [] };
      const stored = { ...pending.stored, plan: withoutLegacyJobs(pending.stored.plan) };
      const time = now();
      const confirmed = planConfirmation({ task, stored, choice: input, grantInfo: payload.grantInfo, tools: options.planTools, settings: settings(), time });
      const { plan, narrowing, grantInfo } = confirmed;
      const carried = carriedGrantTimes(task.id, plan, time);
      const added = narrowing.added ?? [];
      const moved = transition(task, "queued", "user", "plan_confirmed", { stages: { total: plan.stages.length } });
      return {
        status: "handled",
        payload: {
          ...payload,
          plan,
          removedGrants: narrowing.removed,
          narrowedGrants: narrowing.narrowed,
          grantInfo,
          ...(narrowing.assumptions ? { assumptionsEdited: true } : {}),
          ...(added.length > 0 ? { addedCategories: added.map((c) => c.id) } : {}),
        },
        ...(confirmed.note || legacy.note ? { note: [confirmed.note, legacy.note].filter(Boolean).join(t("protocol.common.semiSep")) } : {}),
        events: [
          { channel: TASKS_CHANNEL, type: TASK_EVENTS.planDecided, payload: { ...confirmed.decided, ...carried }, idempotencyKey: `${idempotencyKey}#decided` },
          // 涉及多个项目的任务（17 号票）：每一行建成一张工单，所属阶段开始时派出（排在任务进排队中之前：开始执行时它们已经在了）
          ...(options.workOrders?.().multiProject.planConfirmed(task, plan) ?? []),
          moved.event,
          ...legacy.events,
        ],
      };
    },
    rejectFromCard(payload, note, idempotencyKey) {
      const comment = note?.trim();
      if (!comment) throw new RequestRejected("bad_params", t("tasks.tasks.rejectNeedsNote"));
      const { task, stored } = pendingPlan(payload);
      const moved = transition(task, "planning", "user", "plan_rejected");
      const decided: PlanDecidedPayload = {
        taskId: task.id,
        taskTitle: task.title,
        planId: stored.planId,
        revision: stored.revision,
        cardId: stored.cardId,
        decision: "rejected",
        removedGrants: [],
        narrowedGrants: [],
        grantInfo: payload.grantInfo,
        note: comment,
        by: "user",
        time: now(),
      };
      const rejected = `用户打回了计划（第 ${stored.revision} 版），意见：「${comment}」\n请按意见修改后重新用 ${SUBMIT_PLAN_TOOL} 提交。`; // @i18n-ignore model
      // 项目的任务（16 号票）：重新起草是一张新的工单，内容是打回意见加上任务书（新的一段会话里没有上一版的对话）
      const current = getBrief(store.reader, task.id);
      const forProject = options.workOrders?.().dispatchPlan(
        moved.task,
        current ? `${rejected}\n\n${briefText(task, current.brief, current.revision, globalWatchCategories(settings()))}` : rejected,
        `${idempotencyKey}#replan`,
      );
      const handOver = forProject ?? [buildAgentNotice(maintainerChannel(task.maintainerId), rejected, `${idempotencyKey}#notice`, { taskId: task.id }).event];
      return {
        status: "handled",
        events: [{ channel: TASKS_CHANNEL, type: TASK_EVENTS.planDecided, payload: decided, idempotencyKey: `${idempotencyKey}#decided` }, moved.event, ...handOver],
      };
    },
    submitWorkflowPlan: (taskId, maintainerId, reviewed) => putWorkflowPlan(taskId, maintainerId, reviewed),
    nextPlanRevision: (taskId) => (latestPlan(store.reader, taskId)?.revision ?? 0) + 1,
    buildWorkflowReauthorization(task, stored) {
      if (!stored.workflow) throw new RequestRejected("conflict", t("tasks.tasks.notWorkflowPlan"));
      const put = workflowPlanEvents(task, { workflow: stored.workflow, execution: stored.plan, maintainerId: task.maintainerId, title: t("tasks.tasks.workflowPlanReauthorize") });
      return { events: [...put.events, put.item.event], item: put.item.item, cardId: put.cardId, planId: put.planId, revision: put.revision };
    },
    refuseWorkflowPlan: (taskId, maintainerId, reviewed, why) => putWorkflowPlan(taskId, maintainerId, reviewed, why),
    reviseWorkflowFromCard(payload, note, idempotencyKey) {
      const comment = note?.trim();
      const { task, stored } = refusedPlan(payload);
      const decided: PlanDecidedPayload = {
        taskId: task.id,
        taskTitle: task.title,
        planId: stored.planId,
        revision: stored.revision,
        cardId: stored.cardId,
        decision: "returned",
        ...(stored.workflow ? { workflow: stored.workflow } : {}),
        removedGrants: [],
        narrowedGrants: [],
        grantInfo: {},
        ...(comment ? { note: comment } : {}),
        by: "user",
        time: now(),
      };
      // @i18n-ignore-start model：交回维护者
      const text = [
        `用户看了计划 v${stored.revision} 的审查结果（${payload.refused === "blocked" ? "判定不可执行" : "退回补充"}），让你改。${comment ? `用户说明：${comment}` : ""}`,
        `照审查给出的原因${comment ? "和用户的说明" : ""}改好后重新用 ${WORKFLOW_TOOL.proposePlan} 提交；改不了的在会话里说明为什么。`,
      ].join(NL);
      // @i18n-ignore-end
      return {
        status: "handled",
        ...(comment ? { note: comment } : {}),
        events: [{ channel: TASKS_CHANNEL, type: TASK_EVENTS.planDecided, payload: decided, idempotencyKey: `${idempotencyKey}#decided` }, ...replanHandOver(task, text, idempotencyKey)],
      };
    },
    confirmWorkflowFromCard(payload, input, idempotencyKey) {
      if (payload.refused) throw new RequestRejected("not_allowed", refusedNotAuthorizable());
      const { task, stored } = pendingPlan(payload);
      const workflow = stored.workflow;
      if (!workflow) throw new RequestRejected("conflict", t("tasks.tasks.notWorkflowPlan"));
      // 需要你确认的事项：一次授权不等于默认同意它们，勾完才能授权
      const required = workflowConfirmationItems(workflow.review, workflow.steps);
      const ticked = new Set(input.confirmations);
      const missing = required.filter((i) => !ticked.has(i.key));
      if (missing.length > 0) throw new RequestRejected("bad_params", t("tasks.tasks.unconfirmed", { items: missing.map((i) => i.text).join(t("protocol.common.semiSep")) }));
      const confirmations = required.map((i) => i.key);
      const settingsNow = settings();
      // 本任务调严过的全局自定义类别快照进计划（和长程任务同一个口径；流程不在卡上加类别，照全局走）
      const plan = snapshotWatchCategories(stored.plan, settingsNow);
      const grantInfo = grantInfoOf(plan, { tools: options.planTools, settings: settingsNow });
      const decided: PlanDecidedPayload = {
        taskId: task.id,
        taskTitle: task.title,
        planId: stored.planId,
        revision: stored.revision,
        cardId: stored.cardId,
        decision: "confirmed",
        plan,
        // 撤回会话回到授权之前、重新授权的（153 号票）：原样留着的授权项接着用作废那一版的授予时间（次数不清零）
        ...carriedGrantTimes(task.id, plan, now()),
        workflow,
        ...(confirmations.length > 0 ? { confirmations } : {}),
        removedGrants: [],
        narrowedGrants: [],
        grantInfo,
        by: "user",
        time: now(),
      };
      // 定时触发的流程（76 号票）：授权一次，之后按时间表运行（运营中，触发底座登记它的触发），每次运行都按步骤核对；
      // 某个时间做一次的：授权后等时间，到点了进排队（触发底座到点时挪）
      const steps = { steps: { total: workflow.steps.length, done: 0 } };
      const moved = isTriggered(task)
        ? transition(task, "operating", "user", "plan_confirmed", steps)
        : transition(task, onceAt(task) !== undefined ? "scheduled" : "queued", "user", "plan_confirmed", steps);
      return {
        status: "handled",
        payload: { ...payload, confirmed: confirmations },
        ...(confirmations.length > 0 ? { note: t("tasks.tasks.confirmedCount", { n: confirmations.length, count: confirmations.length }) } : {}),
        events: [{ channel: TASKS_CHANNEL, type: TASK_EVENTS.planDecided, payload: decided, idempotencyKey: `${idempotencyKey}#decided` }, moved.event],
      };
    },
    rejectWorkflowFromCard(payload, note, idempotencyKey) {
      if (payload.refused) throw new RequestRejected("not_allowed", refusedNotAuthorizable());
      const comment = note?.trim();
      const { task, stored } = pendingPlan(payload);
      const moved = transition(task, "planning", "user", "plan_rejected");
      const decided: PlanDecidedPayload = {
        taskId: task.id,
        taskTitle: task.title,
        planId: stored.planId,
        revision: stored.revision,
        cardId: stored.cardId,
        decision: "rejected",
        ...(stored.workflow ? { workflow: stored.workflow } : {}),
        removedGrants: [],
        narrowedGrants: [],
        grantInfo: {},
        ...(comment ? { note: comment } : {}),
        by: "user",
        time: now(),
      };
      // 用户拒绝了计划 vN（附上用户的说明）
      // @i18n-ignore-start model：交回维护者
      const rejected = [
        `用户拒绝了计划 v${stored.revision}。${comment ? `用户说明：${comment}` : ""}`,
        comment
          ? `照用户的说明改好后重新用 ${WORKFLOW_TOOL.proposePlan} 提交。`
          : `用户没写说明：不要原样再提交，先在会话里说说你的理解、问用户想怎么改（用户在任务详情里回你），再重新用 ${WORKFLOW_TOOL.proposePlan} 提交。`,
      ].join(NL);
      // @i18n-ignore-end
      return {
        status: "handled",
        ...(comment ? { note: comment } : {}),
        events: [{ channel: TASKS_CHANNEL, type: TASK_EVENTS.planDecided, payload: decided, idempotencyKey: `${idempotencyKey}#decided` }, moved.event, ...replanHandOver(moved.task, rejected, idempotencyKey)],
      };
    },
    buildChange(prev, next, meta, idempotencyKey) {
      if (next.state !== prev.state) {
        const check = checkTaskTransition(prev.state, next.state, meta.by);
        if (!check.ok) throw new RequestRejected("not_allowed", check.reason);
      }
      const task: Task = { ...next, updatedAt: now() };
      const payload: TaskEventPayload = {
        task,
        change: meta.change,
        from: prev.state,
        by: meta.by,
        ...(meta.stageId === undefined ? {} : { stageId: meta.stageId }),
        ...(meta.reopened === undefined ? {} : { reopened: [...meta.reopened] }),
      };
      return { task, event: { channel: CHANNELS.board, type: EVENT_TYPES.task, payload, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } };
    },
    get: (taskId) => getTask(store.reader, taskId),
    list: () => listTasks(store.reader),
    queued: () => queuedTasks(store.reader),
    ofMaintainer: (maintainerId) => taskOfMaintainer(store.reader, maintainerId),
    brief: (taskId) => getBrief(store.reader, taskId),
    plan: (planId) => getPlan(store.reader, planId),
    latestPlan: (taskId) => latestPlan(store.reader, taskId),
    confirmedPlan: (taskId) => confirmedPlan(store.reader, taskId),
    confirmedPlans: (taskId) => confirmedPlans(store.reader, taskId),
    proposedPlan: (taskId) => proposedPlan(store.reader, taskId),
    usedStageCodes: (taskId) => [...new Set(shownPlans(store.reader, taskId).flatMap((p) => [...planStageCodes(p.plan).values()]))],
    stageUsage: (taskId, stageId) => stageUsage(store.reader, taskId, stageId),
    globalWatchCategories: () => globalWatchCategories(settings()),
    planWatchCategories: () => {
      const tasks = new Map(listTasks(store.reader).map((tk) => [tk.id, tk]));
      return listPlans(store.reader).map((p) => ({
        taskId: p.taskId,
        confirmed: p.status === "confirmed",
        ongoing: !ENDED_TASK_STATES.includes(tasks.get(p.taskId)?.state ?? "done"),
        categories: p.plan.watchCategories,
      }));
    },
  };
}

// 交给秘书、项目的维护者的通知：给模型看，照旧中文
// @i18n-ignore-start model
/** 秘书收到的通知：用户点「发起任务」发起了全局任务（用户选的项目是秘书写任务书时的依据） */
function buttonStartedNotice(task: Task): string {
  return forModel(() => buttonStartedLines(task));
}

function buttonStartedLines(task: Task): string {
  const chosen = task.projects.length === 0 ? "用户选了：不涉及项目。" : `用户选了涉及的项目：${task.projects.join("、")}（写任务书时以它为依据）。`;
  // 305 号票：新建时定好了工作文件夹的（选了 Claude Code 这类运行时），写明在哪做，秘书就不再问"代码放哪儿"（294 号票端到端小测里问了一遍）
  const folder = task.workdir === undefined ? [] : [`维护者在用户新建时定好的工作文件夹里做：${task.workdir}（不用再问放在哪）。`];
  return [`用户点「发起任务」发起了${TASK_KIND_LABEL[taskKind(task)]}：${task.summary}`, chosen, ...folder, ...(triggerLine(task) ? [`${triggerLine(task)!}。写任务书时写明它是定时做的。`] : []), clarifyNext(task)].join(NL);
}

/** 秘书收到的通知：用户在建议卡上点了"作为流程"或"作为长程任务"，任务建好了 */
function suggestionStartedNotice(task: Task): string {
  return `用户在建议卡上点了「作为${forModel(() => TASK_KIND_LABEL[taskKind(task)])}」。${clarifyNext(task)}`;
}

/**
 * 项目的维护者收到的通知（64 号票）：不是它自己建的项目内部任务建好了（用户点了建议卡、在秘书那里点明了、点了"发起任务"按钮）；
 * 接着和用户对齐、写任务书（write_task_brief），运行时把它作为起草计划的工单交回给它
 */
export function internalStartedNotice(task: Task, start: TaskStart): string {
  return forModel(() => internalStartedLines(task, start));
}

function internalStartedLines(task: Task, start: TaskStart): string {
  const kind = TASK_KIND_LABEL[taskKind(task)];
  const asked = oneLine(task.summary, 300);
  const how = {
    maintainer_suggestion: `用户在你的建议卡上点了「作为${kind}」`,
    secretary_suggestion: `用户在秘书给的建议卡（卡上写着这个项目）上点了「作为${kind}」（秘书看不到它的细节；卡上的理由：${asked}）`,
    secretary: `用户在秘书那里点明了要在这个项目里做（秘书替用户建的，它看不到细节；用户的要求：${asked}）`,
    button: `用户点「发起任务」、选了这个项目（用户写的：${asked}）`,
  }[start];
  return (
    `${how}：项目内部${kind} ${task.id}「${task.title}」已建好（规划中），由你起草、执行，只在这个项目里看得到。` +
    (triggerLine(task) ? `${triggerLine(task)!}。` : "") +
    `先在这里说出你的理解，需要时直接问用户（用户在项目页的会话里看得到），对齐后用 ${TASK_TOOL.writeTaskBrief} 写任务书：运行时把它作为一张起草计划的工单交回给你。`
  );
}
// @i18n-ignore-end
