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
// → 用户在计划卡上确认（可勾掉、收窄授权项、改假设栏，任务转排队中）或附意见打回（任务回到规划中，意见作为通知交回维护者）。
import {
  CHANNELS,
  maintainerChannel,
  type Plan,
  type PlanCardPayload,
  type PlanConfirmInput,
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
import { checkPlan, globalWatchCategories, grantInfoOf, narrowPlan } from "./plan.ts";
import { TASK_TOOL } from "./secretary-tools.ts";
import { checkTaskTransition } from "./state-machine.ts";
import { countTasks, getBrief, getPlan, getTask, latestPlan, listTasks, type StoredPlan, taskOfMaintainer } from "./views.ts";

/** narrowPlan 报加的关注类别不对时的开头（和授权项的问题分开说） */
const ADDED_CATEGORY_PROBLEM = "加的关注类别";

/** 任务标题最多这么多字（点按钮时取用户写的第一行） */
const TITLE_MAX = 40;

export interface NewTask {
  title: string;
  summary: string;
  origin: TaskOrigin;
  /** 涉及的项目（用户点按钮时选的） */
  projects?: readonly string[];
}

export interface TaskService {
  /** 建出一个任务（规划中）和它的事件（不追加）：卡片动作把它们和卡片更新一起追加 */
  buildCreate(input: NewTask, by: TaskActor): { task: Task; events: NewEvent[] };
  /** 秘书按用户在消息里的要求建任务卡（create_task 工具） */
  createByRequest(input: { title: string; summary: string }): Task;
  /** 用户点"发起任务"按钮（start_task 请求）：同一个幂等键重发拿到同一个任务 */
  startFromButton(params: StartTaskParams, idempotencyKey: string): Task;
  /** 秘书写（或改）任务书：同一事务交给执行的维护者 */
  writeBrief(taskId: string, brief: TaskBrief): { task: Task; revision: number };
  /** 执行的维护者提交计划（submit_plan 工具）：检查不过时抛 RequestRejected，原因交回维护者 */
  submitPlan(taskId: string, maintainerId: string, plan: Plan): { cardId: string; planId: string; revision: number };
  /** 计划卡上的"确认"（勾掉、收窄授权项，改假设栏） */
  confirmFromCard(payload: PlanCardPayload, input: PlanConfirmInput, idempotencyKey: string): CardActionEffect<PlanCardPayload>;
  /** 计划卡上的"附意见打回" */
  rejectFromCard(payload: PlanCardPayload, note: string | undefined, idempotencyKey: string): CardActionEffect<PlanCardPayload>;
  get(taskId: string): Task | undefined;
  list(): Task[];
  /** 某个维护者执行的任务 */
  ofMaintainer(maintainerId: string): Task | undefined;
  brief(taskId: string): { brief: TaskBrief; revision: number } | undefined;
  plan(planId: string): StoredPlan | undefined;
  latestPlan(taskId: string): StoredPlan | undefined;
  /** 全局的关注类别（任务书里列给维护者：本任务的关注类别只能在其上增加） */
  globalWatchCategories(): ReturnType<typeof globalWatchCategories>;
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

  const settings = (): WatchCategorySettings => {
    try {
      return options.watchSettings();
    } catch (err) {
      throw new RequestRejected("internal", `读不了关注类别设置：${err instanceof Error ? err.message : String(err)}`);
    }
  };

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

  const buildCreate = (input: NewTask, by: TaskActor): { task: Task; events: NewEvent[] } => {
    // 建任务卡不是迁移：只有用户（按钮、建议卡）和按用户要求的秘书能建
    if (by !== "user" && by !== "secretary") throw new RequestRejected("not_allowed", "只有用户能发起任务（秘书按用户的要求建任务卡）");
    const n = countTasks(store.reader) + 1;
    const time = now();
    const task: Task = {
      id: `t-${n}`,
      title: oneLine(input.title, TITLE_MAX),
      summary: input.summary.trim(),
      state: "planning",
      origin: input.origin,
      maintainerId: `tm-${n}`,
      projects: [...(input.projects ?? [])],
      createdAt: time,
      updatedAt: time,
    };
    const payload: TaskEventPayload = { task, change: "created", from: null, by };
    return { task, events: [{ channel: CHANNELS.board, type: EVENT_TYPES.task, payload }] };
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
    createByRequest(input) {
      const { task, events } = buildCreate({ ...input, origin: "request" }, "secretary");
      store.appendBatch(events);
      return task;
    },
    startFromButton(params, idempotencyKey) {
      const text = params.request.trim();
      if (!text) throw new RequestRejected("bad_params", "要做什么是空的");
      const projects = [...new Set((params.projects ?? []).map((p) => p.trim()).filter(Boolean))];
      const { task, events } = buildCreate({ title: text.split(/\r?\n/)[0]!, summary: text, origin: "button", projects }, "user");
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
      const notice = buildAgentNotice(maintainerChannel(task.maintainerId), briefText(task, brief, revision, globalWatchCategories(settings())), `brief:${taskId}:${revision}`, { taskId });
      store.appendBatch([{ channel: TASKS_CHANNEL, type: TASK_EVENTS.briefWritten, payload }, notice.event]);
      return { task, revision };
    },
    submitPlan(taskId, maintainerId, plan) {
      const task = mustGet(taskId);
      if (task.maintainerId !== maintainerId) throw new RequestRejected("not_allowed", `任务 ${taskId} 不是你执行的，只有它的维护者能提交计划`);
      const checked = checkPlan(plan, { tools: options.planTools, settings: settings() });
      if (!checked.ok) throw new RequestRejected("bad_params", `计划没通过检查，改好再提交：\n- ${checked.problems.join("\n- ")}`);
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
        } satisfies PlanCardPayload,
      });
      const moved = transition(task, "awaiting_confirm", "maintainer", "plan_submitted", {
        planCardId: card.card.id,
        stages: { total: checked.plan.stages.length },
        projects: checked.plan.projects.map((p) => p.project),
      });
      const submitted: PlanSubmittedPayload = { taskId, planId, revision, plan: checked.plan, cardId: card.card.id, maintainerId, time: now() };
      const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: oneLine(`计划等你确认：${task.title}`, 60), source: `任务「${task.title}」`, urgency: "blocking" });
      store.appendBatch([{ channel: TASKS_CHANNEL, type: TASK_EVENTS.planSubmitted, payload: submitted }, card.event, moved.event, item.event]);
      inbox.alert(item.item);
      return { cardId: card.card.id, planId, revision };
    },
    confirmFromCard(payload, input, idempotencyKey) {
      const { task, stored } = pendingPlan(payload);
      // 加的关注类别 id 按计划 id 起头（26 号票），只在这个任务的计划里
      const narrowed = narrowPlan(stored.plan, input, options.planTools, { categoryIdPrefix: stored.planId });
      if (!narrowed.ok) {
        const categoryProblems = narrowed.problems.filter((p) => p.startsWith(ADDED_CATEGORY_PROBLEM));
        const grantProblems = narrowed.problems.filter((p) => !p.startsWith(ADDED_CATEGORY_PROBLEM));
        throw new RequestRejected("bad_params", [...(grantProblems.length > 0 ? [`授权项只能勾掉或收窄：${grantProblems.join("；")}`] : []), ...categoryProblems].join("；"));
      }
      const removed = narrowed.removed.map((g) => g.id);
      const added = narrowed.added ?? [];
      // 加的类别可能让授权项的处置变严（落在"先问我"里就不算授权）：授权行跟着确认的计划重算
      const grantInfo = added.length > 0 ? grantInfoOf(narrowed.plan, { tools: options.planTools, settings: settings() }) : payload.grantInfo;
      const moved = transition(task, "queued", "user", "plan_confirmed", { stages: { total: narrowed.plan.stages.length } });
      const decided: PlanDecidedPayload = {
        taskId: task.id,
        taskTitle: task.title,
        planId: stored.planId,
        revision: stored.revision,
        cardId: stored.cardId,
        decision: "confirmed",
        plan: narrowed.plan,
        removedGrants: narrowed.removed,
        narrowedGrants: narrowed.narrowed,
        grantInfo,
        ...(narrowed.assumptions ? { assumptions: narrowed.assumptions } : {}),
        ...(added.length > 0 ? { addedCategories: added } : {}),
        by: "user",
        time: now(),
      };
      const bits = [
        removed.length > 0 ? `勾掉 ${removed.length} 项授权` : "",
        narrowed.narrowed.length > 0 ? `收窄 ${narrowed.narrowed.length} 项` : "",
        narrowed.assumptions ? "改了假设栏" : "",
        added.length > 0 ? `加了 ${added.length} 个关注类别` : "",
      ].filter(Boolean);
      return {
        status: "handled",
        payload: {
          ...payload,
          plan: narrowed.plan,
          removedGrants: narrowed.removed,
          narrowedGrants: narrowed.narrowed,
          grantInfo,
          ...(narrowed.assumptions ? { assumptionsEdited: true } : {}),
          ...(added.length > 0 ? { addedCategories: added.map((c) => c.id) } : {}),
        },
        ...(bits.length > 0 ? { note: bits.join("，") } : {}),
        events: [{ channel: TASKS_CHANNEL, type: TASK_EVENTS.planDecided, payload: decided, idempotencyKey: `${idempotencyKey}#decided` }, moved.event],
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
      const notice = buildAgentNotice(
        maintainerChannel(task.maintainerId),
        `用户打回了计划（第 ${stored.revision} 版），意见：「${comment}」\n请按意见修改后重新用 ${SUBMIT_PLAN_TOOL} 提交。`,
        `${idempotencyKey}#notice`,
        { taskId: task.id },
      );
      return {
        status: "handled",
        events: [{ channel: TASKS_CHANNEL, type: TASK_EVENTS.planDecided, payload: decided, idempotencyKey: `${idempotencyKey}#decided` }, moved.event, notice.event],
      };
    },
    get: (taskId) => getTask(store.reader, taskId),
    list: () => listTasks(store.reader),
    ofMaintainer: (maintainerId) => taskOfMaintainer(store.reader, maintainerId),
    brief: (taskId) => getBrief(store.reader, taskId),
    plan: (planId) => getPlan(store.reader, planId),
    latestPlan: (taskId) => latestPlan(store.reader, taskId),
    globalWatchCategories: () => globalWatchCategories(settings()),
  };
}

/** 秘书收到的通知：用户在建议卡上点了"发起任务"，任务建好了 */
export function suggestionStartedNotice(task: Task): string {
  return `用户在建议卡上点了「发起任务」。${clarifyNext(task)}`;
}
