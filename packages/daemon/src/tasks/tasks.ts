// 任务（规格第 7、8 节）：发起、任务书、计划的提交和确认。所有状态迁移按"谁能改"表校验（state-machine.ts），
// 每次迁移是任务看板频道上的一条 task 事件（同一事务里还有它引起的别的事件）。
//
// 发起有三条路，建出的任务都是"规划中"，执行的维护者在建卡时产生（12 号票：任务自己的维护者）：
// - 用户点"发起任务"按钮（start_task 请求）：不经秘书判断直接建出（带上用户选的项目），同一事务给秘书一条通知，秘书接着澄清；
//   用户写的原话从这条 task 事件记成"用户发言"素材（material-sources.ts）；
// - 用户在消息里要秘书去做：这个要求就是授权，秘书用建任务工具直接建任务卡（tools.ts 的 create_task）；
// - 秘书自己发现、用户没要求的：秘书只给"建议发起任务"卡，用户点卡上的"发起任务"才建出（cards.ts）。
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
  type TaskOrigin,
  type TaskState,
  EVENT_TYPES,
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
import { checkPlan, globalWatchCategories, grantInfoOf, planConfirmation, readWatchSettings, type ToolkitProblems, verifiedQuotes } from "./plan.ts";
import { TASK_TOOL } from "./secretary-tools.ts";
import { checkTaskTransition } from "./state-machine.ts";
import { confirmedPlan, countTasks, getBrief, getPlan, getTask, latestPlan, listPlans, listTasks, proposedPlan, queuedTasks, type StageUsage, stageUsage, type StoredPlan, taskOfMaintainer } from "./views.ts";

/** 任务标题最多这么多字（点按钮时取用户写的第一行） */
const TITLE_MAX = 40;

export interface NewTask {
  title: string;
  summary: string;
  origin: TaskOrigin;
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
  createByRequest(input: { title: string; summary: string; projects?: readonly string[] }): Task;
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
  return `任务 ${task.id}「${task.title}」已建好（规划中）。先说出你的理解，需要时用 ${TASK_TOOL.askQuestions} 成批提问（每题带推荐答案），对齐后用 ${TASK_TOOL.writeTaskBrief} 写任务书。`;
}

const bullets = (items: readonly string[]) => (items.length === 0 ? "（无）" : items.map((x) => `\n- ${x}`).join(""));

/** 交给维护者的任务书 */
export function briefText(task: Task, brief: TaskBrief, revision: number, categories: ReturnType<typeof globalWatchCategories>): string {
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

  /** 计划卡上的动作能不能做：这一版计划还待确认，任务也还在待确认 */
  const pendingPlan = (payload: PlanCardPayload): { task: Task; stored: StoredPlan } => {
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
      const { task, events } = buildCreate({ title: text.split(/\r?\n/)[0]!, summary: text, origin: "button", projects: params.projects ?? [] }, "user");
      const projects = task.projects;
      // 用户选的项目是秘书写任务书时的依据
      const chosen = projects.length === 0 ? "用户选了：不涉及项目。" : `用户选了涉及的项目：${projects.join("、")}（写任务书时以它为依据）。`;
      const notice = buildAgentNotice(CHANNELS.secretary, `用户点「发起任务」发起了任务：${text}\n${chosen}\n${clarifyNext(task)}`, `${idempotencyKey}#notice`);
      // 同一个幂等键重发：不多建任务，拿到第一次建出的那个
      const [first] = store.appendBatch([{ ...events[0]!, idempotencyKey }, notice.event]);
      return (first!.event.payload as TaskEventPayload).task;
    },
    writeBrief(taskId, brief) {
      const task = mustGet(taskId);
      if (task.state !== "planning") {
        throw new RequestRejected("not_allowed", `任务 ${task.id}「${task.title}」现在是${task.state === "awaiting_confirm" ? "待确认（计划等用户确认）" : "已经过了规划"}，不能再写任务书`);
      }
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
      const checked = checkPlan(plan, { tools: options.planTools, settings: settings(), taskId, ...(options.toolkitProblems ? { toolkitProblems: options.toolkitProblems } : {}) });
      // 涉及的项目要对得上任务（17 号票评审后定）
      const problems = checked.ok ? (options.planProjects?.(task, checked.plan) ?? []) : checked.problems;
      if (!checked.ok || problems.length > 0) throw new RequestRejected("bad_params", `计划没通过检查，改好再提交：\n- ${problems.join("\n- ")}`);
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

/** 秘书收到的通知：用户在建议卡上点了"发起任务"，任务建好了 */
export function suggestionStartedNotice(task: Task): string {
  return `用户在建议卡上点了「发起任务」。${clarifyNext(task)}`;
}
