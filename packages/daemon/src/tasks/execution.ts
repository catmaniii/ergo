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
// 交给维护者的话都是它会话里的系统通知（带 taskId），维护者模块据此唤起它；什么时候能处理输入看任务的状态（maintainers/）。
// 维护者的工具和通知的措辞在 execution-tools.ts，这里只返回结构化的结果。
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  ACCEPTANCE_VERDICT_LABEL,
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
  type Plan,
  type PlanToolkit,
  type ProgressCardPayload,
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
  type TaskStage,
  type TaskStageAcceptance,
  type TaskState,
  TASK_STATE_LABEL,
  TASK_WAIT_REASON_LABEL,
  type TaskWaitReason,
  type Urgency,
  userDecidesWait,
} from "@ergou/protocol";
import type { CardService } from "../cards/cards.ts";
import { buildAgentNotice, buildMessage, type MessageScope } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { GuardTask, ToolRegistry, WatchCategorySettings } from "../guard/index.ts";
import { type ApprovalDecidedPayload, type ApprovalSuspendedPayload, type ExecutionRecord, GUARD_CHANNEL, GUARD_EVENTS, type ToolCallInterruptedPayload } from "../guard-runtime/events.ts";
import { executionOf, interruptionNote } from "../guard-runtime/executions.ts";
import type { HandOverData } from "../hand-over/hand-over.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { oneLine } from "../util/text.ts";
import type { ScriptOutcome } from "./acceptance.ts";
import { contextBlockText } from "./context-block.ts";
import { type OutputReaction, type OutputReactionPayload, TASK_EVENTS, TASKS_CHANNEL } from "./events.ts";
import { noticeText, stageText } from "./execution-tools.ts";
import { grantInfoOf, toGuardPlan } from "./plan.ts";
import type { ReviewInput, ReviewResult } from "./review.ts";
import { allAccepted, currentStage, findStage, guardStageId, missingPrerequisites, nextStep, reopen, stageNow, stagePosition, taskMessageScope, withStage } from "./stages.ts";
import { assertUserCan } from "./state-machine.ts";
import type { TaskService } from "./tasks.ts";
import { EXECUTION_TOOL } from "./tool-names.ts";

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

export interface TaskExecutionOptions {
  store: EventStore;
  tasks: TaskService;
  cards: CardService;
  inbox: InboxService;
  now: () => string;
  /** 全局最多几个任务处于执行中 */
  maxRunning: number;
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
  // ───── 用户 ─────
  /** 用户对任务的控制（task_action 请求）：同一个幂等键重发拿到同一个结果 */
  act(params: TaskActionParams, idempotencyKey: string): TaskActionResult;
  /**
   * 用户对任务的控制，先不落盘（22 号票：任务控制快速动作和快速动作卡、操作记录同一事务追加）：能不能做照样只看
   * availableTaskActions(task, "user")，做不了抛 RequestRejected；返回要追加的事件（第一条任务事件带这个幂等键）、
   * 控制之后的状态，以及落盘之后调用方要叫的 afterCommit（提示用户、把对应的通知记成处理过）
   */
  prepareAct(params: TaskActionParams, idempotencyKey: string): PreparedTaskAct;
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

/** 去掉等我、失败的说明（恢复执行时） */
const cleared = (task: Task): Task => {
  const { waitReason: _r, waitNote: _n, failReason: _f, ...rest } = task;
  return rest;
};

const draftOf = (task: Task, projectScope: MessageScope, key?: string): Draft => ({ task, projectScope, events: [], alerts: [], completed: false, ...(key === undefined ? {} : { key }) });

/** 草稿里这时的归属：任务和当时的阶段（说的是某个阶段的写那个阶段），项目的任务还有项目 */
const scopeIn = (d: Draft, stageId?: string): MessageScope => ({ ...taskMessageScope(d.task, stageId), ...d.projectScope });

/** 交给维护者的一条输入（它会话里的系统通知） */
const notify = (d: Draft, text: string) => {
  d.events.push(buildAgentNotice(maintainerChannel(d.task.maintainerId), text, `task-exec:${d.task.id}:${randomUUID()}`, scopeIn(d)).event);
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

/** 在等用户验收的那个阶段（不在等的是 undefined） */
const awaitingUser = (task: Task, stageId: string | undefined): TaskStage | undefined => {
  const stage = stageId === undefined ? undefined : findStage(listOf(task), stageId);
  return stage?.state === "waiting" && stage.waitReason === "acceptance" ? stage : undefined;
};

/** 用户验收之后，这个阶段各条标准的结论（自动判过的照原样，由用户验收的按这次的） */
const verdictsAfterUser = (stage: TaskStage, passed: boolean): AcceptanceVerdict[] => [
  ...(passed ? stage.acceptance.filter((a) => a.method !== "user" && a.result).map((a) => ({ criterion: a.criterion, method: a.method, passed: a.result!.passed, ...(a.result!.note ? { note: a.result!.note } : {}) })) : []),
  ...stage.acceptance.filter((a) => a.method === "user").map((a) => ({ criterion: a.criterion, method: a.method, passed })),
];

const errorText = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));

export function createTaskExecution(options: TaskExecutionOptions): TaskExecution {
  const { store, tasks, cards, inbox, now, log } = options;
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

  /** 维护者的当前阶段（20 号票起按它最后一次开始的阶段） */
  const currentOf = (task: Task): TaskStage => currentStage(listOf(task), task.stages?.focus, busyOf(task.id));

  /** 确认过的计划（还没确认的没有） */
  const confirmedPlan = (taskId: string) => tasks.confirmedPlan(taskId);

  /** 执行中的任务确认过的计划 */
  const planOf = (taskId: string): Plan => {
    const stored = confirmedPlan(taskId);
    if (!stored) throw new Error(`任务 ${taskId} 没有确认过的计划`);
    return stored.plan;
  };

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
      grantInfo: grantInfoOf(plan, { tools: options.planTools, settings: options.watchSettings() }),
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
  const addNotice = (d: Draft, input: { notice: "stage_acceptance" | "stuck_help" | "failure_choice" | "interrupted"; title: string; body: string; actions: string[]; data: Record<string, unknown> }): InboxItem => {
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

  /** 执行中的任务看下一步：接着做、开始一个能开始的阶段、全都在等用户就转等我、全验收了就完成 */
  const settle = (d: Draft) => {
    if (d.task.state !== "running") return;
    // 在做的都是子 agent 的（并行，20 号票）时，维护者手头空着：开始一个能开始的阶段
    const step = nextStep(listOf(d.task), busyOf(d.task.id));
    if (step.kind === "continue") return;
    if (step.kind === "start") return startStageIn(d, step.stageId, "system");
    if (step.kind === "complete") return complete(d);
    const reason: TaskWaitReason = step.reason;
    apply(d, "waiting", "system", (t) => ({ ...t, state: "waiting_for_user", waitReason: reason }));
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

  /** 一支有了结论之后（验收、退回、不用再等了）：在等我的（卡住求助、中断不确定的除外）恢复执行，全验收了就完成；执行中的看下一步 */
  const proceed = (d: Draft, by: TaskActor) => {
    if (d.task.state === "running") return settle(d);
    if (d.task.state !== "waiting_for_user") return;
    if (allAccepted(listOf(d.task))) return complete(d);
    if (!userDecidesWait(d.task)) resume(d, by, "resumed");
  };

  /** 交给维护者的通知后面接上这次开始的阶段（交代、授权、边界） */
  const withStarted = (d: Draft, text: string) => (d.startedStage && d.task.state === "running" ? `${text}\n${stageText(handoff(d.task, d.startedStage))}` : text);

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
    applyStage(d, "stage_waiting", "system", stage.stageId, (s) => ({ ...s, state: "waiting", waitReason: reason, waitingOn }));
    settle(d);
    if (d.startedStage) notify(d, noticeText.branchWaits(stage, what, handoff(d.task, d.startedStage)));
    else if (d.task.state === "waiting_for_user") note(d, `所有能推进的阶段都在等你（${TASK_WAIT_REASON_LABEL[reason]}：${what}），任务转等我。`);
    commit(d);
  };

  /**
   * 这一支不用再等了（批准或拒绝了、交给我做的事做完了）：阶段回到能开始，接着走。
   * 维护者自己的调用批准了（approvedFor 是发起调用的 agent）、可它正在做别的阶段：通知它先切回去再重试（授权和调用指纹按阶段）；
   * 子 agent 的调用批准了，通知由子 agent 那边给（sub-agents/texts.ts 的 lateDecisionText），这里不再说
   */
  const branchUnblocked = (waitingOn: string, approvedFor?: string) => {
    const task = tasks.list().find((t) => listOf(t).some((s) => s.state === "waiting" && s.waitingOn === waitingOn));
    if (!task) return;
    const stage = listOf(task).find((s) => s.state === "waiting" && s.waitingOn === waitingOn)!;
    const d = draft(task);
    applyStage(d, "stage_unblocked", "user", stage.stageId, (s) => stageNow(s, "pending"));
    proceed(d, "system");
    const current = d.task.state === "running" ? currentOf(d.task) : undefined;
    const active = current && (current.state === "running" || current.state === "accepting") ? current : undefined;
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
    // 决定时调用还在等的直接接着执行或拦下，这一支没停过
    if (p.resumed || p.origin.taskId === null) return;
    branchUnblocked(p.approvalId, p.decision === "approved" ? p.origin.agentId : undefined);
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

  // ───────────────────────── 用户的控制（task_action 和待我处理里的通知共用） ─────────────────────────

  const pause = (task: Task, key?: string): Draft => {
    const d = draft(task, key);
    apply(d, "paused", "user", (t) => ({ ...t, state: "paused" }));
    note(d, "你暂停了任务。");
    return d;
  };

  /** 已暂停的继续（没开始过的从第一个阶段开始） */
  const resumePaused = (task: Task, key?: string): Draft => {
    const d = draft(task, key);
    const started = task.stages?.list !== undefined;
    resume(d, "user", "resumed");
    if (started) notify(d, withStarted(d, noticeText.resumed(d.task.state === "queued")));
    return d;
  };

  /** 卡住求助的接着执行：用户点了"继续执行"（交代维护者看会话），或者在会话里回了话（他的话就是输入，不另交代） */
  const resumeStuck = (task: Task, key?: string, withNotice = true): Draft => {
    const d = draft(task, key);
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
    const d = draft(task, key);
    const at = now();
    applyStage(d, "stage_accepted", "user", stage.stageId, (s) =>
      stageNow(s, "accepted", { acceptance: s.acceptance.map((a) => (a.method === "user" ? { ...a, result: { passed: true, at } } : a)) }),
    );
    outputReaction(d, stage, "accepted");
    cardRef(d, progressCard(d, stage.stageId, "acceptance", "你验收通过了。", { passed: true, judgedBy: "user", results: verdictsAfterUser(stage, true) }), stage.stageId);
    proceed(d, "user");
    if (d.startedStage && d.task.state === "running") notify(d, noticeText.userAccepted(stage, handoff(d.task, d.startedStage)));
    return d;
  };

  /** 由我验收的阶段：用户退回（交回维护者，阶段不推进） */
  const returnStage = (task: Task, stage: TaskStage, why: string | undefined, key?: string): Draft => {
    const d = draft(task, key);
    const at = now();
    applyStage(d, "stage_returned", "user", stage.stageId, (s) =>
      stageNow(s, "pending", { acceptance: s.acceptance.map((a) => (a.method === "user" ? { ...a, result: { passed: false, at } } : a)) }),
    );
    outputReaction(d, stage, "returned", { note: why });
    // 退回的原因是用户自己的话：只记在"用户对产出的反应"事件里（素材的来源，彻底删除时改写它）和交给维护者的通知里
    cardRef(d, progressCard(d, stage.stageId, "acceptance", why ? "你退回了，原因交给了维护者。" : "你退回了。", { passed: false, judgedBy: "user", results: verdictsAfterUser(stage, false) }), stage.stageId);
    notify(d, noticeText.userReturned(stage, why));
    proceed(d, "user");
    return d;
  };

  /** 在任务详情里做了的事，待我处理里对应的通知自动记成处理过 */
  const NOTICE_OF_ACT: Partial<Record<TaskAction, { notice: string; choice: string; byStage?: boolean; from?: TaskState }>> = {
    retry: { notice: "failure_choice", choice: FAILURE_CHOICE_ACTIONS.retry },
    cancel: { notice: "failure_choice", choice: FAILURE_CHOICE_ACTIONS.cancel, from: "failed" },
    resume: { notice: "stuck_help", choice: STUCK_HELP_ACTIONS.resume, from: "waiting_for_user" },
    accept_stage: { notice: "stage_acceptance", choice: STAGE_ACCEPTANCE_ACTIONS.pass, byStage: true },
    return_stage: { notice: "stage_acceptance", choice: STAGE_ACCEPTANCE_ACTIONS.return, byStage: true },
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
    const handled = NOTICE_OF_ACT[params.action];
    const noticeHandled = () => {
      if (handled && (handled.from === undefined || handled.from === task.state)) markHandled(task.id, handled.notice, handled.choice, key, handled.byStage ? params.stageId : undefined);
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

  /** 用户在卡住求助（或中断不确定）的任务的会话里说话了：任务接着执行（他的话就是交给维护者的输入） */
  const onUserMessage = (payload: MessageEventPayload) => {
    if (payload.message.speaker !== "user" || payload.taskId === undefined) return;
    const task = tasks.get(payload.taskId);
    if (task?.state !== "waiting_for_user" || !userDecidesWait(task)) return;
    if (task.waitReason === "interrupted") return commit(resumeInterrupted(task, { notice: false }));
    commit(resumeStuck(task, undefined, false));
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

  /** 一个阶段有了结论之后接下来做什么 */
  const nextUp = (d: Draft): NextUp => {
    if (d.completed) return { kind: "completed" };
    if (d.startedStage) return { kind: "stage", stage: handoff(d.task, d.startedStage) };
    if (d.task.state === "waiting_for_user") return { kind: "waiting", reason: d.task.waitReason ?? "acceptance" };
    return { kind: "continue" };
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
    const stageNowState = findStage(listOf(fresh), stageId)?.state;
    if (ENDED_TASK_STATES.includes(fresh.state) || stageNowState !== "accepting") return { outcome: "void", state: fresh.state };
    const d = draft(fresh);
    const recorded = (state: TaskStage["state"], extra: Partial<TaskStage> = {}) => (s: TaskStage) => ({ ...s, ...extra, state, acceptance: acceptanceOf(s, results) });
    const failed = results.filter((r) => !r.passed);
    if (failed.length > 0) {
      applyStage(d, "stage_returned", "system", stageId, recorded("running"));
      cardRef(d, progressCard(d, stageId, "acceptance", `没通过 ${failed.length} 条，交回维护者修改。`, { passed: false, judgedBy, results }), stageId);
      commit(d);
      return { outcome: "returned", stageId, judgedBy, results };
    }
    const userCriteria = planStage.acceptance.filter((x) => x.method === "user");
    if (userCriteria.length > 0) {
      const n = listOf(fresh).findIndex((s) => s.stageId === stageId) + 1;
      const resultText = results.map((r) => `- 通过：${r.criterion}（${ACCEPTANCE_VERDICT_LABEL[r.method]}）${r.note ? `：${r.note}` : ""}`);
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
    // 维护者的当前阶段：它最后一次开始的那个（并行，20 号票），不按计划里的顺序取
    return { taskId, plan: toGuardPlan(stored.plan, { confirmedAt }), currentStageId: guardStageId(list, task.stages?.focus, busyOf(taskId)) };
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

  return {
    start() {
      unsubscribes.push(
        store.onAppend((event) => {
          try {
            if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.task) scheduleFill();
            else if (event.channel === GUARD_CHANNEL && event.type === GUARD_EVENTS.approvalSuspended) onSuspended(event.payload as ApprovalSuspendedPayload);
            else if (event.channel === GUARD_CHANNEL && event.type === GUARD_EVENTS.approvalDecided) onDecided(event.payload as ApprovalDecidedPayload);
            else if (event.channel === GUARD_CHANNEL && event.type === GUARD_EVENTS.toolCallInterrupted) onInterrupted(event.payload as ToolCallInterruptedPayload);
            else if (event.channel === CHANNELS.inbox && event.type === EVENT_TYPES.inboxItem) onInboxItem((event.payload as InboxItemEventPayload).item);
            else if (event.type === EVENT_TYPES.message && event.channel.startsWith(MAINTAINER_CHANNEL_PREFIX)) onUserMessage(event.payload as MessageEventPayload);
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
        inbox.onNoticeHandled("stuck_help", STUCK_HELP_ACTIONS.resume, (item) => fromNotice(item, "resume", (task) => (task.state === "waiting_for_user" ? resumeStuck(task) : undefined))),
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
      fill();
    },
    stop() {
      for (const off of unsubscribes.splice(0)) off();
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
    checkParallel(scope, stageIds) {
      checkParallel(scope, stageIds);
    },
    parallelStartEvents,
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
    act,
    prepareAct,
    guardTask,
    contextBlock(taskId) {
      const task = tasks.get(taskId);
      const stored = confirmedPlan(taskId);
      if (!task || !stored || listOf(task).length === 0) return undefined;
      return contextBlockText({
        task,
        plan: { ...stored.plan, toolkit: toolkitOf(task, stored.plan) },
        goal: tasks.brief(taskId)?.brief.goal ?? task.summary,
        cwd: workDir(taskId),
        grantInfo: grantInfoOf(stored.plan, { tools: options.planTools, settings: options.watchSettings() }),
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
