// 任务（规格第 7、8 节）：发起、任务书、计划的提交和确认。所有状态迁移按"谁能改"表校验（state-machine.ts），
// 每次迁移是任务看板频道上的一条 task 事件（同一事务里还有它引起的别的事件）。
//
// 任务分两种（58 号票，ADR 0019）：流程和长程任务，建卡时定下（Task.kind），之后不能换。只有用户点明了才发起，
// 建出的任务都是"规划中"，执行的维护者在建卡时产生（12 号票：任务自己的维护者）：
// - 用户点"发起任务"按钮（start_task 请求）、在发起对话框里先选了种类：不经秘书判断直接建出（带上用户选的项目），
//   同一事务给秘书一条通知，秘书接着澄清；用户写的原话从这条 task 事件记成"用户发言"素材（material-sources.ts）；
// - 用户在消息里点明了（"按流程做""发起任务"、/流程、/任务）：秘书用 start_workflow / create_task 建任务卡
//   （secretary-tools.ts；点明没有由运行时判定，launch-intent.ts）；
// - 用户没点明、秘书觉得该发起的：秘书只给"建议发起任务"卡，用户点卡上的"作为流程""作为长程任务"才建出（cards.ts）。
// 流程暂时只做不涉及项目的事（58 号票）：涉及项目的流程要由项目的维护者起草、执行，还没接上，发起时拒绝并说明。
// 之后：秘书写任务书（write_task_brief）→ 同一事务把任务书作为一条通知交给执行的维护者（它的会话频道，维护者模块据此唤起它）
// → 维护者用"提交计划"工具交出结构化的计划 → 检查（plan.ts）、存进事件日志、生成计划卡放进待我处理、任务转待确认
// → 用户在计划卡上确认（可勾掉、收窄授权项、改假设栏、加本任务的关注类别，任务转排队中；本任务调严过的全局关注类别
//   连当时的规则一起快照进计划，26 号票）或附意见打回（任务回到规划中，意见作为通知交回维护者）。
import {
  CHANNELS,
  ENDED_TASK_STATES,
  hasOwnMaintainer,
  isDeletedEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  ownMaintainerId,
  type TaskProjectScope,
  type Plan,
  type PlanCardPayload,
  type PlanConfirmInput,
  type PlanWatchCategory,
  type StartTaskParams,
  type Task,
  type TaskActor,
  type TaskChange,
  type TaskEventPayload,
  type TaskKind,
  TASK_KIND_LABEL,
  taskKind,
  type TaskOrigin,
  type TaskState,
  EVENT_TYPES,
  type WorkflowConfirmInput,
  workflowConfirmationItems,
  type WorkflowPlanCardPayload,
} from "@ergou/protocol";
import type { CardService } from "../cards/cards.ts";
import type { CardActionEffect } from "../cards/registry.ts";
import { buildAgentNotice } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { ToolRegistry, WatchCategorySettings } from "../guard/index.ts";
import type { InboxService } from "../inbox/inbox.ts";
import { SUBMIT_PLAN_TOOL } from "../maintainers/tools.ts";
import { oneLine } from "../util/text.ts";
import { type PlanDecidedPayload, type PlanSubmittedPayload, type TaskBrief, type TaskBriefPayload, TASK_EVENTS, TASKS_CHANNEL } from "./events.ts";
import { checkPlanJobs, jobProjectOf } from "../scheduled-jobs/index.ts";
import { checkPlan, globalWatchCategories, grantInfoOf, planConfirmation, readWatchSettings, snapshotWatchCategories, type ToolkitProblems, verifiedQuotes } from "./plan.ts";
import { TASK_TOOL } from "./secretary-tools.ts";
import { checkTaskTransition } from "./state-machine.ts";
import { confirmedPlan, countTasks, getBrief, getPlan, getTask, latestPlan, listPlans, listTasks, proposedPlan, queuedTasks, refusedPlans, type StageUsage, stageUsage, type StoredPlan, taskOfMaintainer } from "./views.ts";
import { WORKFLOW_TOOL } from "./tool-names.ts";
import type { ReviewedWorkflow } from "./workflow-plan.ts";

/** 任务标题最多这么多字（点按钮时取用户写的第一行） */
const TITLE_MAX = 40;

export interface NewTask {
  title: string;
  summary: string;
  origin: TaskOrigin;
  /** 种类（58 号票）：流程或长程任务；不给是长程任务 */
  kind?: TaskKind;
  /**
   * 涉及的项目（项目列表里的名字：用户点按钮时选的，秘书建卡、建议卡上写的）。没给编号时按项目列表认成编号（不在列表里、
   * 已归档的拒绝并说明），恰好一个时执行的维护者是这个项目的维护者（16 号票）
   */
  projects?: readonly string[];
  /** 涉及的项目的编号（项目列表按它数进行中的任务）：给了就不再认（项目的首个建设任务） */
  projectIds?: readonly string[];
  /** 执行的维护者：不给就按涉及的项目定（恰好一个项目的是它的维护者），否则产生任务自己的维护者（tm-<n>） */
  maintainerId?: string;
}

export interface TaskService {
  /** 建出一个任务（规划中）和它的事件（不追加）：卡片动作把它们和卡片更新一起追加 */
  buildCreate(input: NewTask, by: TaskActor): { task: Task; events: NewEvent[] };
  /**
   * 用户把一个未结束的任务转为项目（15 号票）：任务以"已完成 · 已转为项目"结束的事件（不追加）。
   * 只有有自己维护者的任务能转（原任务的维护者接着做立项问答）
   */
  buildConvertToProject(taskId: string): { task: Task; event: NewEvent };
  /** 秘书按用户在消息里的要求建任务卡（create_task 工具；只涉及一个项目时写上它，16 号票） */
  createByRequest(input: { title: string; summary: string; kind?: TaskKind; projects?: readonly string[] }): Task;
  /** 用户点"发起任务"按钮（start_task 请求）：同一个幂等键重发拿到同一个任务 */
  startFromButton(params: StartTaskParams, idempotencyKey: string): Task;
  /** 秘书写（或改）任务书：同一事务交给执行的维护者 */
  writeBrief(taskId: string, brief: TaskBrief): { task: Task; revision: number };
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
   * 流程的这一版审查没让它交给用户授权（审查退回维护者补充、判定不可执行）：照 AgentSense 把这版计划显示出来——
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
  buildChange(prev: Task, next: Task, meta: { by: TaskActor; change: TaskChange; stageId?: string }, idempotencyKey?: string): { task: Task; event: NewEvent };
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
  /** 还在等用户的计划变更（14 号票） */
  proposedPlan(taskId: string): StoredPlan | undefined;
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
   * 项目列表（15 号票）：点"发起任务"时选的项目要在项目列表里（check：不在的抛 RequestRejected 说明原因，在的给出编号）；
   * 计划里写的涉及的项目认成编号（idsOf）。16 号票：只涉及一个项目的任务由这个项目的维护者执行（maintainerOf：项目的维护者），
   * 项目的任务的计划里不管写没写，涉及的项目都有这个项目（projectOf：任务属于哪个项目，同 ProjectService.projectOf）。
   * 不给就不核对、不记编号
   */
  projects?: {
    check(names: readonly string[]): string[];
    idsOf(names: readonly string[]): string[];
    maintainerOf?(projectId: string): string | undefined;
    projectOf?(task: Task): { id: string; name: string } | undefined;
  };
  /**
   * 派单器（16 号票）：项目的任务的任务书、打回意见不直接交给维护者，而是派一张起草计划的工单（工单开始时交给它）。
   * 返回 undefined 的（任务自己的维护者执行的）照旧作为通知交给维护者
   */
  workOrders?: {
    dispatchPlan(task: Task, instructions: string, key: string): NewEvent[] | undefined;
    /** 涉及多个项目的任务（17 号票）：用户确认计划时每一行建成一张工单（等阶段开始），和计划卡的处理同一事务 */
    planConfirmed?(task: Task, plan: Plan): NewEvent[];
  };
  /**
   * 提交的计划里涉及的项目对不对得上任务（17 号票评审后定：单项目任务不能写进别的项目，不涉及项目的任务不能写项目行，
   * 多项目任务每一行写所属阶段和验收标准）：不对的原因；不给就不查
   */
  planProjects?: (task: Task, plan: Plan) => string[];
}

/** 秘书收到的通知：任务刚建好，接着澄清、写任务书 */
function clarifyNext(task: Task): string {
  return `${TASK_KIND_LABEL[taskKind(task)]} ${task.id}「${task.title}」已建好（规划中）。先说出你的理解，需要时用 ${TASK_TOOL.askQuestions} 成批提问（每题带推荐答案），对齐后用 ${TASK_TOOL.writeTaskBrief} 写任务书。`;
}

/** 流程暂时只做不涉及项目的事（58 号票） */
const WORKFLOW_PROJECTS_REFUSAL = "流程暂时只能做不涉及项目的事：涉及项目的请作为长程任务发起";

const NL = "\n";

/** 审查退回、判定不可执行的那一版不能授权、也不用拒绝 */
const REFUSED_NOT_AUTHORIZABLE = "这版计划审查没通过（退回维护者补充或判定不可执行），不能授权；可以让维护者改，或者取消任务";

const bullets = (items: readonly string[]) => (items.length === 0 ? "（无）" : items.map((x) => `\n- ${x}`).join(""));

/** 交给维护者的任务书（流程的另有一种说法：workflowBriefText） */
export function briefText(task: Task, brief: TaskBrief, revision: number, categories: ReturnType<typeof globalWatchCategories>): string {
  if (taskKind(task) === "workflow") return workflowBriefText(task, brief, revision);
  return [
    `${revision > 1 ? `任务书改了（第 ${revision} 版）` : "任务书"}：任务 ${task.id}「${task.title}」`,
    `目标：${brief.goal}`,
    `验收标准：${bullets(brief.acceptanceCriteria)}`,
    `约束：${bullets(brief.constraints)}`,
    `涉及的项目：${brief.projects.length === 0 ? "不涉及项目" : brief.projects.join("、")}`,
    `记忆范围提议：${brief.memoryScope || "（无）"}（第一阶段只占位）`,
    `全局的关注类别（计划里的 watchCategories 一个都不能少，只能增加或往严里调）：${categories.map((c) => `${c.id}「${c.title}」`).join("、")}`,
    // 用户说过的限制由维护者编译、和原话一起显示在计划卡上（26 号票）
    ...(brief.constraints.length > 0 ? ["约束里用户说过的限制，编译成时序规则或授权收窄写进计划的 userLimits，附上用户的原话。"] : []),
    `请据此起草计划，用 ${SUBMIT_PLAN_TOOL} 提交；用户确认之前不要动手做。`,
  ].join("\n");
}

/** 交给流程的维护者的任务书（58 号票）：照它把要做的事排成步骤，用 propose_plan 交出 */
export function workflowBriefText(task: Task, brief: TaskBrief, revision: number): string {
  return [
    `${revision > 1 ? `任务书改了（第 ${revision} 版）` : "任务书"}：流程 ${task.id}「${task.title}」`,
    `目标：${brief.goal}`,
    `验收标准：${bullets(brief.acceptanceCriteria)}`,
    `约束：${bullets(brief.constraints)}`,
    ...(brief.constraints.length > 0 ? ["约束里用户说过的限制，写成计划的条件（rules：时序规则）。"] : []),
    `请据此把要做的事排成步骤（每步一次工具调用，连同要满足的条件），用 ${WORKFLOW_TOOL.proposePlan} 提交；用户授权之前不要动手做。`,
  ].join(NL);
}

export function createTaskService(options: TaskServiceOptions): TaskService {
  const { store, cards, inbox, now } = options;

  const settings = (): WatchCategorySettings => readWatchSettings(options.watchSettings);

  const mustGet = (taskId: string): Task => {
    const task = getTask(store.reader, taskId);
    if (!task) {
      const list = listTasks(store.reader)
        .filter((t) => t.state === "planning")
        .map((t) => `${t.id}「${t.title}」`)
        .join("；");
      throw new RequestRejected("not_found", `没有编号为 ${taskId} 的任务。${list ? `规划中的任务：${list}` : "现在没有规划中的任务"}`);
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

  /** 涉及的项目（名字）认成编号；恰好一个时执行的维护者是这个项目的维护者（16 号票）。不在项目列表里、已归档的拒绝并说明 */
  const routed = (names: readonly string[]): { projectIds?: string[]; maintainerId?: string } => {
    const projectIds = options.projects?.check(names);
    const maintainerId = projectIds?.length === 1 ? options.projects?.maintainerOf?.(projectIds[0]!) : undefined;
    return { ...(projectIds === undefined ? {} : { projectIds }), ...(maintainerId === undefined ? {} : { maintainerId }) };
  };

  const buildCreate = (input: NewTask, by: TaskActor): { task: Task; events: NewEvent[] } => {
    // 建任务卡不是迁移：只有用户（按钮、建议卡）和按用户要求的秘书能建
    if (by !== "user" && by !== "secretary") throw new RequestRejected("not_allowed", "只有用户能发起任务（秘书按用户的要求建任务卡）");
    const projects = [...new Set((input.projects ?? []).map((p) => p.trim()).filter(Boolean))];
    const kind = input.kind ?? "long_running";
    if (kind === "workflow" && (projects.length > 0 || (input.projectIds?.length ?? 0) > 0)) throw new RequestRejected("not_allowed", WORKFLOW_PROJECTS_REFUSAL);
    const route = input.projectIds === undefined ? routed(projects) : { projectIds: [...input.projectIds] };
    const n = countTasks(store.reader) + 1;
    const time = now();
    const maintainerId = input.maintainerId ?? route.maintainerId ?? ownMaintainerId(`t-${n}`);
    // 涉及几个项目在建卡时定下（17 号票）：由项目的维护者执行的是单项目，任务自己的维护者涉及两个以上项目的是多项目
    const own = maintainerId === ownMaintainerId(`t-${n}`);
    const projectScope: TaskProjectScope = !own ? "single" : (route.projectIds?.length ?? projects.length) >= 2 ? "multi" : "none";
    const task: Task = {
      id: `t-${n}`,
      title: oneLine(input.title, TITLE_MAX),
      summary: input.summary.trim(),
      state: "planning",
      origin: input.origin,
      kind,
      maintainerId,
      projects,
      ...(route.projectIds === undefined ? {} : { projectIds: route.projectIds }),
      projectScope,
      createdAt: time,
      updatedAt: time,
    };
    const payload: TaskEventPayload = { task, change: "created", from: null, by };
    return { task, events: [{ channel: CHANNELS.board, type: EVENT_TYPES.task, payload }] };
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
   * （17 号票）。只涉及一个项目列表里的项目的，改由这个项目的维护者起草并执行（16 号票，看板上的任务事件 handed_to_project，
   * 状态不变；项目已归档的拒绝并说明）；涉及两个以上、都在项目列表里的，定为多项目任务（projects_settled，执行的还是任务自己的维护者）
   */
  const settledByBrief = (task: Task, brief: TaskBrief, revision: number): { task: Task; event: NewEvent } | undefined => {
    if (revision !== 1 || !hasOwnMaintainer(task) || task.projects.length > 0 || !options.projects) return undefined;
    const names = [...new Set(brief.projects.map((p) => p.trim()).filter(Boolean))];
    if (names.length === 0 || options.projects.idsOf(names).length !== names.length) return undefined;
    if (names.length === 1 && !options.projects.maintainerOf) return undefined;
    const route = routed(names);
    const handed = names.length === 1;
    if (handed && route.maintainerId === undefined) return undefined;
    const next: Task = {
      ...task,
      ...(handed ? { maintainerId: route.maintainerId! } : {}),
      projects: names,
      ...(route.projectIds ? { projectIds: route.projectIds } : {}),
      projectScope: handed ? "single" : "multi",
      updatedAt: now(),
    };
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
    if (task.maintainerId !== maintainerId) throw new RequestRejected("not_allowed", `任务 ${taskId} 不是你执行的，只有它的维护者能提交计划`);
    if (taskKind(task) !== "workflow") throw new RequestRejected("not_allowed", `任务 ${taskId} 是长程任务，计划用 ${SUBMIT_PLAN_TOOL} 提交`);
    if (task.state !== "planning") throw new RequestRejected("not_allowed", `任务 ${taskId} 现在不在规划中，不能再提交计划`);
    const revision = (latestPlan(store.reader, taskId)?.revision ?? 0) + 1;
    const planId = `${taskId}-p${revision}`;
    const plan = { ...reviewed.plan, version: revision };
    const urgency = refused === "needs_replan" ? "non_blocking" : "blocking";
    const card = cards.buildCreate({
      type: "workflow_plan",
      urgency,
      payload: {
        taskId,
        taskTitle: task.title,
        revision,
        planId,
        goal: getBrief(store.reader, taskId)?.brief.goal ?? task.summary,
        plan,
        ...(refused ? { refused } : {}),
      } satisfies WorkflowPlanCardPayload,
    });
    const moved = refused ? [] : [transition(task, "awaiting_confirm", "maintainer", "plan_submitted", { planCardId: card.card.id, steps: { total: plan.steps.length, done: 0 } }).event];
    const submitted: PlanSubmittedPayload = { taskId, planId, revision, plan: reviewed.execution, workflow: plan, ...(refused ? { refused } : {}), cardId: card.card.id, maintainerId, time: now() };
    const title = refused === "blocked" ? "流程的计划不能执行" : refused === "needs_replan" ? "流程的计划被审查退回维护者补充" : "流程的计划等你授权";
    const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: oneLine(`${title}：${task.title}`, 60), source: `任务「${task.title}」`, urgency });
    store.appendBatch([...supersedeRefused(taskId), { channel: TASKS_CHANNEL, type: TASK_EVENTS.planSubmitted, payload: submitted }, card.event, ...moved, item.event]);
    inbox.alert(item.item);
    return { cardId: card.card.id, planId, revision };
  };

  /**
   * 维护者交了新的一版（流程）：之前审查没让它交给用户授权、卡还没处理的几版过期（卡不再等用户，待我处理里也不再卡着任务）
   */
  const supersedeRefused = (taskId: string): NewEvent[] =>
    refusedPlans(store.reader, taskId)
      .filter((p) => cards.get(p.cardId)?.status === "pending")
      .map((p) => cards.buildUpdate(p.cardId, { status: "expired" }).event);

  /** 审查没让它交给你授权的那一版（流程计划卡上的"让维护者改"）：这一版是 refused、任务还在规划中 */
  const refusedPlan = (payload: { taskId: string; planId: string }): { task: Task; stored: StoredPlan } => {
    const stored = getPlan(store.reader, payload.planId);
    const task = getTask(store.reader, payload.taskId);
    if (!stored || !task) throw new RequestRejected("not_found", `没有这版计划：${payload.planId}`);
    if (stored.status !== "refused") throw new RequestRejected("conflict", "这版计划已经处理过了");
    if (task.state !== "planning") throw new RequestRejected("conflict", `任务现在不在规划中（${task.state}），不用再让维护者改这一版`);
    return { task, stored };
  };

  /** 计划卡上的动作能不能做：这一版计划还待确认，任务也还在待确认 */
  const pendingPlan = (payload: { taskId: string; planId: string }): { task: Task; stored: StoredPlan } => {
    const stored = getPlan(store.reader, payload.planId);
    const task = getTask(store.reader, payload.taskId);
    if (!stored || !task) throw new RequestRejected("not_found", `没有这版计划：${payload.planId}`);
    if (stored.status !== "pending" || task.planCardId !== stored.cardId) throw new RequestRejected("conflict", "这版计划已经处理过了");
    return { task, stored };
  };

  return {
    buildCreate,
    buildConvertToProject(taskId) {
      const task = mustGet(taskId);
      if (!hasOwnMaintainer(task)) throw new RequestRejected("not_allowed", `任务 ${task.id}「${task.title}」由项目的维护者执行，不能转为项目`);
      return transition(task, "done", "user", "converted_to_project", { endKind: "converted_to_project" });
    },
    createByRequest(input) {
      const { task, events } = buildCreate({ ...input, origin: "request" }, "secretary");
      store.appendBatch(events);
      return task;
    },
    startFromButton(params, idempotencyKey) {
      const text = params.request.trim();
      if (!text) throw new RequestRejected("bad_params", "要做什么是空的");
      // 只涉及一个项目的任务由这个项目的维护者起草计划并执行（16 号票），不新建任务自己的维护者（buildCreate 按选的项目定）
      // 发起对话框里先选了种类（58 号票）：不选是长程任务
      const { task, events } = buildCreate({ title: text.split(/\r?\n/)[0]!, summary: text, origin: "button", kind: params.kind ?? "long_running", projects: params.projects ?? [] }, "user");
      const projects = task.projects;
      // 用户选的项目是秘书写任务书时的依据
      const chosen = projects.length === 0 ? "用户选了：不涉及项目。" : `用户选了涉及的项目：${projects.join("、")}（写任务书时以它为依据）。`;
      const notice = buildAgentNotice(CHANNELS.secretary, `用户点「发起任务」发起了${TASK_KIND_LABEL[taskKind(task)]}：${text}\n${chosen}\n${clarifyNext(task)}`, `${idempotencyKey}#notice`);
      // 同一个幂等键重发：不多建任务，拿到第一次建出的那个
      const [first] = store.appendBatch([{ ...events[0]!, idempotencyKey }, notice.event]);
      return (first!.event.payload as TaskEventPayload).task;
    },
    writeBrief(taskId, brief) {
      const task = mustGet(taskId);
      if (task.state !== "planning") {
        throw new RequestRejected("not_allowed", `任务 ${task.id}「${task.title}」现在是${task.state === "awaiting_confirm" ? "待确认（计划等用户确认）" : "已经过了规划"}，不能再写任务书`);
      }
      if (taskKind(task) === "workflow" && brief.projects.some((p) => p.trim() !== "")) throw new RequestRejected("not_allowed", `${WORKFLOW_PROJECTS_REFUSAL}（任务书的 projects 写空数组）`);
      const revision = (getBrief(store.reader, taskId)?.revision ?? 0) + 1;
      const payload: TaskBriefPayload = { taskId, brief, revision, time: now() };
      // 建卡时没写项目：第一版任务书定下涉及几个项目（只涉及一个的交给这个项目的维护者起草并执行，16、17 号票）
      const handed = settledByBrief(task, brief, revision);
      const owned = handed?.task ?? task;
      const text = briefText(owned, brief, revision, globalWatchCategories(settings()));
      // 项目的任务：派一张起草计划的工单（16 号票）；任务自己的维护者：直接交给它
      const handOver = options.workOrders?.dispatchPlan(owned, text, `brief:${taskId}:${revision}`) ?? [buildAgentNotice(maintainerChannel(owned.maintainerId), text, `brief:${taskId}:${revision}`, { taskId }).event];
      store.appendBatch([...(handed ? [handed.event] : []), { channel: TASKS_CHANNEL, type: TASK_EVENTS.briefWritten, payload }, ...handOver]);
      return { task: owned, revision };
    },
    buildBriefRevision(taskId, patch) {
      const current = getBrief(store.reader, taskId);
      if (!current) throw new RequestRejected("not_found", `任务 ${taskId} 还没有任务书`);
      const payload: TaskBriefPayload = { taskId, brief: { ...current.brief, ...patch }, revision: current.revision + 1, time: now() };
      return { channel: TASKS_CHANNEL, type: TASK_EVENTS.briefWritten, payload };
    },
    submitPlan(taskId, maintainerId, plan) {
      const task = mustGet(taskId);
      if (task.maintainerId !== maintainerId) throw new RequestRejected("not_allowed", `任务 ${taskId} 不是你执行的，只有它的维护者能提交计划`);
      const basic = checkPlan(plan, { tools: options.planTools, settings: settings(), taskId, ...(options.toolkitProblems ? { toolkitProblems: options.toolkitProblems } : {}) });
      // 定时作业的定义（19 号票）：时间表要重复；单项目任务里的作业都属于它那个项目，别的任务里的不属于项目
      const jobs = checkPlanJobs(basic.ok ? basic.plan : plan, jobProjectOf(task, (t) => options.projects?.projectOf?.(t)));
      // 涉及的项目要对得上任务（17 号票评审后定）
      const problems = basic.ok ? [...(options.planProjects?.(task, jobs.plan) ?? []), ...jobs.problems] : [...basic.problems, ...jobs.problems];
      if (problems.length > 0) throw new RequestRejected("bad_params", `计划没通过检查，改好再提交：\n- ${problems.join("\n- ")}`);
      const checked = { plan: jobs.plan };
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
      const project = options.projects?.projectOf?.(task);
      const names = [...new Set([...(project ? [project.name] : []), ...checked.plan.projects.map((p) => p.project)])];
      const moved = transition(task, "awaiting_confirm", "maintainer", "plan_submitted", {
        planCardId: card.card.id,
        stages: { total: checked.plan.stages.length },
        projects: names,
        ...(options.projects ? { projectIds: [...new Set([...(project ? [project.id] : []), ...options.projects.idsOf(names)])] } : {}),
      });
      const submitted: PlanSubmittedPayload = { taskId, planId, revision, plan: checked.plan, cardId: card.card.id, maintainerId, time: now() };
      const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: oneLine(`计划等你确认：${task.title}`, 60), source: `任务「${task.title}」`, urgency: "blocking" });
      store.appendBatch([{ channel: TASKS_CHANNEL, type: TASK_EVENTS.planSubmitted, payload: submitted }, card.event, moved.event, item.event]);
      inbox.alert(item.item);
      return { cardId: card.card.id, planId, revision };
    },
    confirmFromCard(payload, input, idempotencyKey) {
      const { task, stored } = pendingPlan(payload);
      const confirmed = planConfirmation({ task, stored, choice: input, grantInfo: payload.grantInfo, tools: options.planTools, settings: settings(), time: now() });
      const { plan, narrowing, grantInfo } = confirmed;
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
        ...(confirmed.note ? { note: confirmed.note } : {}),
        events: [
          { channel: TASKS_CHANNEL, type: TASK_EVENTS.planDecided, payload: confirmed.decided, idempotencyKey: `${idempotencyKey}#decided` },
          // 涉及多个项目的任务（17 号票）：每一行建成一张工单，所属阶段开始时派出（排在任务进排队中之前：开始执行时它们已经在了）
          ...(options.workOrders?.planConfirmed?.(task, plan) ?? []),
          moved.event,
        ],
      };
    },
    rejectFromCard(payload, note, idempotencyKey) {
      const comment = note?.trim();
      if (!comment) throw new RequestRejected("bad_params", "打回要写意见：意见会交回给起草计划的维护者");
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
      const rejected = `用户打回了计划（第 ${stored.revision} 版），意见：「${comment}」\n请按意见修改后重新用 ${SUBMIT_PLAN_TOOL} 提交。`;
      // 项目的任务（16 号票）：重新起草是一张新的工单，内容是打回意见加上任务书（新的一段会话里没有上一版的对话）
      const current = getBrief(store.reader, task.id);
      const forProject = options.workOrders?.dispatchPlan(
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
      const text = [
        `用户看了计划 v${stored.revision} 的审查结果（${payload.refused === "blocked" ? "判定不可执行" : "退回补充"}），让你改。${comment ? `用户说明：${comment}` : ""}`,
        `照审查给出的原因${comment ? "和用户的说明" : ""}改好后重新用 ${WORKFLOW_TOOL.proposePlan} 提交；改不了的在会话里说明为什么。`,
      ].join(NL);
      return {
        status: "handled",
        ...(comment ? { note: comment } : {}),
        events: [
          { channel: TASKS_CHANNEL, type: TASK_EVENTS.planDecided, payload: decided, idempotencyKey: `${idempotencyKey}#decided` },
          buildAgentNotice(maintainerChannel(task.maintainerId), text, `${idempotencyKey}#notice`, { taskId: task.id }).event,
        ],
      };
    },
    confirmWorkflowFromCard(payload, input, idempotencyKey) {
      if (payload.refused) throw new RequestRejected("not_allowed", REFUSED_NOT_AUTHORIZABLE);
      const { task, stored } = pendingPlan(payload);
      const workflow = stored.workflow;
      if (!workflow) throw new RequestRejected("conflict", "这版计划不是流程的计划");
      // 需要你确认的事项（AgentSense 的 confirmationItems）：一次授权不等于默认同意它们，勾完才能授权
      const required = workflowConfirmationItems(workflow.review, workflow.steps);
      const ticked = new Set(input.confirmations);
      const missing = required.filter((i) => !ticked.has(i.key));
      if (missing.length > 0) throw new RequestRejected("bad_params", `需要你确认的事项还没勾完：${missing.map((i) => i.text).join("；")}`);
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
        workflow,
        ...(confirmations.length > 0 ? { confirmations } : {}),
        removedGrants: [],
        narrowedGrants: [],
        grantInfo,
        by: "user",
        time: now(),
      };
      const moved = transition(task, "queued", "user", "plan_confirmed", { steps: { total: workflow.steps.length, done: 0 } });
      return {
        status: "handled",
        payload: { ...payload, confirmed: confirmations },
        ...(confirmations.length > 0 ? { note: `确认了 ${confirmations.length} 项` } : {}),
        events: [{ channel: TASKS_CHANNEL, type: TASK_EVENTS.planDecided, payload: decided, idempotencyKey: `${idempotencyKey}#decided` }, moved.event],
      };
    },
    rejectWorkflowFromCard(payload, note, idempotencyKey) {
      if (payload.refused) throw new RequestRejected("not_allowed", REFUSED_NOT_AUTHORIZABLE);
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
      // 照 AgentSense：用户拒绝了计划 vN（附上用户的说明）
      const rejected = [
        `用户拒绝了计划 v${stored.revision}。${comment ? `用户说明：${comment}` : ""}`,
        comment
          ? `照用户的说明改好后重新用 ${WORKFLOW_TOOL.proposePlan} 提交。`
          : `用户没写说明：不要原样再提交，先在会话里说说你的理解、问用户想怎么改（用户在任务详情里回你），再重新用 ${WORKFLOW_TOOL.proposePlan} 提交。`,
      ].join(NL);
      const handOver = buildAgentNotice(maintainerChannel(task.maintainerId), rejected, `${idempotencyKey}#notice`, { taskId: task.id }).event;
      return {
        status: "handled",
        ...(comment ? { note: comment } : {}),
        events: [{ channel: TASKS_CHANNEL, type: TASK_EVENTS.planDecided, payload: decided, idempotencyKey: `${idempotencyKey}#decided` }, moved.event, handOver],
      };
    },
    buildChange(prev, next, meta, idempotencyKey) {
      if (next.state !== prev.state) {
        const check = checkTaskTransition(prev.state, next.state, meta.by);
        if (!check.ok) throw new RequestRejected("not_allowed", check.reason);
      }
      const task: Task = { ...next, updatedAt: now() };
      const payload: TaskEventPayload = { task, change: meta.change, from: prev.state, by: meta.by, ...(meta.stageId === undefined ? {} : { stageId: meta.stageId }) };
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
    proposedPlan: (taskId) => proposedPlan(store.reader, taskId),
    stageUsage: (taskId, stageId) => stageUsage(store.reader, taskId, stageId),
    globalWatchCategories: () => globalWatchCategories(settings()),
    planWatchCategories: () => {
      const tasks = new Map(listTasks(store.reader).map((t) => [t.id, t]));
      return listPlans(store.reader).map((p) => ({
        taskId: p.taskId,
        confirmed: p.status === "confirmed",
        ongoing: !ENDED_TASK_STATES.includes(tasks.get(p.taskId)?.state ?? "done"),
        categories: p.plan.watchCategories,
      }));
    },
  };
}

/** 秘书收到的通知：用户在建议卡上点了"作为流程"或"作为长程任务"，任务建好了 */
export function suggestionStartedNotice(task: Task): string {
  return `用户在建议卡上点了「作为${TASK_KIND_LABEL[taskKind(task)]}」。${clarifyNext(task)}`;
}
