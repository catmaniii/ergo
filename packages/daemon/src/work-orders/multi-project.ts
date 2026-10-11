// 涉及多个项目的任务的工单（规格第 8、11、12、21 节，17 号票）。派单队列、会话分段、等澄清照 16 号票（work-orders.ts、
// segments.ts、clarifications.ts），建出、派出和"工单该以什么结局结束"和派单队列共用 orders.ts，这里只管多项目任务自己的那一部分：
// - 哪些任务算：建卡时定下的多项目任务（Task.projectScope，不随计划改动重新判断；计划里只剩一个项目也还是）；
// - 计划的检查在 tasks/plan-projects.ts（提交计划、计划变更、自行调整都过一遍）：每个项目的一行写明所属阶段和这张工单自己的验收标准；
// - 用户确认计划：每一行建成一张工单（计划内），先"等阶段开始"；所属阶段开始时才派出、进入项目维护者的队列
//   （前置阶段没验收，后面阶段的工单不会出现在项目的工单流水线里）；按依赖重开（返工）某个阶段时，向这个阶段涉及的项目重新建出工单；
// - 任务维护者执行中派工单（dispatch_work_order）：这个阶段有这个项目的一行的是计划内的，直接派出（可以改写内容）；本阶段这一行上次
//   被退回、做不了的，这次重新派单是"调整做法"，算一次验收退回。没有这一行的是计划外的：交给守卫判定（计划外工单类别，unplanned.ts），
//   工单"待你确认"，待我处理出现工单卡（card.ts），用户确认后才派出、拒绝则不派（这一支在等用户）；
// - 回执：项目维护者完成或退回（做不了）时交回执（submit_receipt），这一段写回之后工单结束，回执作为一条消息进任务维护者的会话；
//   某个阶段的回执全部到齐且全部完成，任务维护者才能宣布阶段完成、跑本阶段的验收（stageGate）；任何一张被退回或做不了，本阶段不通过。
//   只看现行计划里这一阶段的行（和计划外确认派出的）：计划变更、自行调整计划之后去掉了的行，它的工单不再挡这一阶段；
// - 计划换了一版（14 号票的计划变更确认"加项目"、自行调整计划）：新计划里还没有工单的行照样建出工单，所属阶段已经在做的马上派出；
//   新计划里没有了的行，还没派出的工单退回，派出了的在时间线上记一笔、不再挡阶段；去掉的是退回、做不了的那几行时算一次验收退回；
// - 任务结束：还没派出、还在排队的工单退回，进行中的那一段收尾后以退回（任务取消了）或做不了（任务失败）结束；
// - 工单的建出、派出、待你确认、确认或拒绝、回执都记在任务时间线上（任务维护者的会话里的 work_order 记录）。
// agent 之间只通过工单往来：项目维护者的提问交给任务维护者、任务维护者的回答交回项目维护者（clarifications.ts）。说法都在 multi-project-texts.ts。
import {
  CHANNELS,
  ENDED_TASK_STATES,
  EVENT_TYPES,
  isActiveWorkOrder,
  maintainerChannel,
  type Plan,
  type Project,
  STAGE_STATE_LABEL,
  type Task,
  type TaskEventPayload,
  type TaskMaintainerWorkOrder,
  taskProjectScope,
  type WorkOrder,
  type WorkOrderCardPayload,
  type WorkOrderDecision,
  type WorkOrderEventPayload,
  type WorkOrderOutcome,
} from "@ergou/protocol";
import type { CardService } from "../cards/cards.ts";
import type { CardActionEffect } from "../cards/registry.ts";
import { buildAgentNotice, buildTimelineRecord } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { GuardTask } from "../guard/index.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { ProjectService } from "../projects/projects.ts";
import { type OutputReactionPayload, type PlanDecidedPayload, type PlanRevisedPayload, TASK_EVENTS, TASKS_CHANNEL } from "../tasks/events.ts";
import type { MaintainerScope, TaskExecution } from "../tasks/execution.ts";
import { findStage, taskMessageScope } from "../tasks/stages.ts";
import type { TaskService } from "../tasks/tasks.ts";
import { findByIdOrName } from "../util/find-by-ref.ts";
import { realPathOf } from "../util/real-path.ts";
import { oneLine } from "../util/text.ts";
import { endedEvent, workOrderEvent } from "./events.ts";
import {
  changeInstructions,
  confirmedText,
  declinedReason,
  declinedText,
  droppedWhy,
  gateText,
  LINE_DROPPED_REASON,
  noOrdersText,
  orderLine,
  type OrderRef,
  RECEIPTS_JUDGED,
  receiptsStageTitle,
  receiptText,
  redispatchWhy,
  refusal,
  resumedText,
  STAGE_ORDERS_HEADER,
  taskSource,
  type StageOrders,
  stageStatusText,
  timelineText,
  UNPLANNED_WAIT,
  unplannedInboxTitle,
} from "./multi-project-texts.ts";
import { dispatchedEvents, newWorkOrder, outcomeOf } from "./orders.ts";
import type { Segments } from "./segments.ts";
import { TASK_ENDED_REASON } from "./texts.ts";
import type { UnplannedJudgement } from "./unplanned.ts";
import { getWorkOrder, workOrdersOfTask } from "./views.ts";

/** 守护进程内部的 work_orders 频道（前端不订阅）：用户在工单卡上的决定（"审批决定"素材的来源） */
export const WORK_ORDERS_CHANNEL = "work_orders";

/** 用户在工单卡上确认派出或拒绝计划外的工单（和卡片更新同一事务） */
export interface WorkOrderDecidedPayload {
  workOrderId: string;
  cardId: string;
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  stageId: string;
  title: string;
  decision: WorkOrderDecision;
  /** 用户附的话 */
  note?: string;
  by: "user";
  time: string;
}

export interface MultiProjectOptions {
  store: EventStore;
  tasks: TaskService;
  projects: ProjectService;
  cards: CardService;
  inbox: InboxService;
  segments: Segments;
  /** 执行控制器：守卫看到的任务、一支等用户确认、调整做法算一次验收退回 */
  execution: Pick<TaskExecution, "awaitAnswer" | "answered" | "countReturn" | "guardTask">;
  /** 新工单的编号（和派单器共用一个计数） */
  nextId: () => string;
  /** 项目的维护者空着就开始队首的工单 */
  tryStart: (maintainerId: string) => void;
  /** 计划外工单交给守卫判定（unplanned.ts；daemon.ts 接上守卫的各区、关注类别设置和任务维护者此刻的装配） */
  judgeUnplanned: (input: { task: GuardTask; maintainerId: string; project: Project }) => UnplannedJudgement;
  now: () => string;
  log: (line: string) => void;
}

export interface DispatchInput {
  /** 收件项目（编号或名字） */
  project: string;
  /** 所属阶段；不写是维护者的当前阶段 */
  stageId?: string;
  /** 要做的事（交给项目维护者的话） */
  instructions: string;
  /** 这张工单的验收标准：计划内的不写就照计划里那一行的 */
  acceptance?: readonly string[];
}

export interface DispatchResult {
  order: OrderRef;
  /** 这次是调整做法（本阶段这个项目上次退回、做不了），算了一次验收退回 */
  countedReturn: boolean;
  /** 计划外的：命中的关注类别、工单卡 */
  unplanned?: { categories: string[]; cardId: string };
}

export interface ReceiptInput {
  outcome: Extract<WorkOrderOutcome, "done" | "returned" | "unable">;
  /** 回执：做了什么（完成时）、说明 */
  summary: string;
  /** 退回、做不了的理由（必填） */
  reason?: string;
}

export interface MultiProject {
  start(): void;
  stop(): void;
  /** 计划能参与的项目（任务维护者能读的项目档案）：任务上的、任务书里的、现在生效的计划里的，在项目列表里的 */
  involvedProjects(task: Task): Project[];
  /** 用户确认计划：每一行建成一张工单（等阶段开始），和计划卡的处理同一事务追加 */
  planConfirmed(task: Task, plan: Plan): NewEvent[];
  /** 宣布阶段完成之前：本阶段的回执到齐、都完成了没有；没有时给出不能宣布完成的原因 */
  stageGate(task: Task, stageId: string): string | undefined;
  /** 交给任务维护者的阶段交代、重注入块、由我验收的事项、评审的输入里多写的几行：本阶段的工单和回执 */
  stageLines(task: Task, stageId: string): string[];
  /** 评审子 agent 能只读访问的：本阶段涉及的各项目的档案和工作目录（真实路径） */
  reviewPlaces(task: Task, stageId: string): { projectRecords: string[]; workingDirs: string[] };
  /** 任务维护者派工单（dispatch_work_order） */
  dispatch(scope: MaintainerScope, input: DispatchInput): DispatchResult;
  /** 汇总回执（summarize_receipts）：这个任务各阶段的工单和回执 */
  receipts(scope: MaintainerScope, stageId?: string): string;
  /** 项目维护者交回执（submit_receipt）：这一段收尾，写回之后工单结束、回执交给任务维护者 */
  submitReceipt(maintainerId: string, input: ReceiptInput): TaskMaintainerWorkOrder;
  /** 工单卡上用户确认派出或拒绝 */
  decide(card: { id: string; payload: WorkOrderCardPayload }, decision: WorkOrderDecision, note: string | undefined): CardActionEffect<WorkOrderCardPayload>;
}

const RECEIPT_KEY = (workOrderId: string) => `work-order-receipt:${workOrderId}`;
const LINE_DROPPED_KEY = (workOrderId: string) => `work-order-line-dropped:${workOrderId}`;

const isMulti = (task: Task) => taskProjectScope(task) === "multi";
const fromTaskMaintainer = (wo: WorkOrder): wo is TaskMaintainerWorkOrder => wo.source === "task_maintainer";
const failedOrder = (wo: TaskMaintainerWorkOrder) => wo.outcome === "returned" || wo.outcome === "unable";
/** 计划里一行的键：阶段 + 项目（计划内只按它判断） */
const lineKey = (stageId: string, projectId: string) => `${stageId}@${projectId}`;
const real = (p: string) => realPathOf(p) ?? p;

/** 任务时间线上的一条工单记录（任务维护者的会话里） */
const record = (task: Task, r: OrderRef, summary: string, key?: string): NewEvent =>
  buildTimelineRecord(maintainerChannel(task.maintainerId), { kind: "work_order", summary, workOrderId: r.wo.id }, taskMessageScope(task, r.wo.stageId), key ? { idempotencyKey: key } : {}).event;

/** 交给任务维护者的一条通知（属于工单所在的阶段） */
const notifyTask = (task: Task, r: OrderRef, text: string, key: string): NewEvent => buildAgentNotice(maintainerChannel(task.maintainerId), text, key, taskMessageScope(task, r.wo.stageId)).event;

export function createMultiProject(options: MultiProjectOptions): MultiProject {
  const { store, tasks, projects, cards, inbox, segments, now, log } = options;
  const unsubscribes: Array<() => void> = [];

  const refOf = (wo: TaskMaintainerWorkOrder): OrderRef => ({ wo, projectName: projects.get(wo.projectId)?.name ?? wo.projectId });

  /** 一个项目名（或编号）认成项目列表里的项目 */
  const projectNamed = (ref: string): Project | undefined => {
    const id = projects.projectIdsOf([ref])[0];
    return id === undefined ? projects.get(ref.trim()) : projects.get(id);
  };

  /** 任务维护者派的工单 */
  const ordersOf = (taskId: string): TaskMaintainerWorkOrder[] => workOrdersOfTask(store.reader, taskId).filter(fromTaskMaintainer);

  /** 现行计划里的行（阶段 + 项目 → 那一行） */
  const planLines = (plan: Plan | undefined): Map<string, Plan["projects"][number]> => {
    const lines = new Map<string, Plan["projects"][number]>();
    for (const line of plan?.projects ?? []) {
      const project = projectNamed(line.project);
      if (project && line.stageId !== undefined) lines.set(lineKey(line.stageId, project.id), line);
    }
    return lines;
  };

  /** 每个（阶段，项目）最新的那张工单（你拒绝了的不算） */
  const latestOrders = (taskId: string, keep: (wo: TaskMaintainerWorkOrder) => boolean = () => true): Map<string, TaskMaintainerWorkOrder> => {
    const latest = new Map<string, TaskMaintainerWorkOrder>();
    for (const wo of ordersOf(taskId)) if (wo.outcome !== "declined" && keep(wo)) latest.set(lineKey(wo.stageId, wo.projectId), wo);
    return latest;
  };

  /**
   * 本阶段现在算数的工单：现行计划里这一阶段每个项目的一行（重新派过的取最新的）、计划外确认派出的；
   * 计划变更、自行调整之后去掉了的行，它的工单不再算
   */
  const stageOrders = (task: Task, stageId: string): StageOrders => {
    const lines = planLines(tasks.confirmedPlan(task.id)?.plan);
    const current = [...latestOrders(task.id, (wo) => wo.stageId === stageId).entries()].filter(([key, wo]) => !wo.planned || lines.has(key)).map(([, wo]) => refOf(wo));
    return { stageId, current };
  };

  /** 计划里的一行建成一张工单（等阶段开始）和时间线上"建出"的记录 */
  const plannedEvents = (task: Task, plan: Plan, line: Plan["projects"][number]): NewEvent[] => {
    const project = projectNamed(line.project);
    const stage = plan.stages.find((s) => s.stageId === line.stageId);
    if (!project || !stage) return [];
    const wo = newWorkOrder(options.nextId(), now(), task, project, {
      source: "task_maintainer",
      stageId: stage.stageId,
      title: line.changes.join("；"),
      instructions: changeInstructions(task, stage, project.name, line.changes, tasks.brief(task.id)?.brief.goal),
      acceptance: line.acceptance ?? [],
      planned: true,
    });
    return [workOrderEvent(wo, "created", null, "user"), record(task, { wo, projectName: project.name }, timelineText.created({ wo, projectName: project.name }))];
  };

  /** 派出一张工单（等阶段开始的、待你确认的进收件维护者的队列；发给已归档、删掉的项目的直接退回）和时间线上"派出"的记录 */
  const dispatchOrder = (task: Task, wo: TaskMaintainerWorkOrder, by: "user" | "system"): NewEvent[] => [
    ...dispatchedEvents(wo, projects.get(wo.projectId), by, now()),
    record(task, refOf(wo), timelineText.dispatched(refOf(wo))),
  ];

  /** 所属阶段开始了（在做）的、等阶段开始的工单：派出 */
  const dispatchDue = (task: Task) => {
    if (task.state !== "running" && task.state !== "waiting_for_user") return;
    const live = new Set((task.stages?.list ?? []).filter((s) => s.state === "running").map((s) => s.stageId));
    const due = ordersOf(task.id).filter((w) => w.state === "planned" && live.has(w.stageId));
    if (due.length > 0) store.appendBatch(due.flatMap((w) => dispatchOrder(task, w, "system")));
  };

  /** 任务结束了：还没派出、还在排队的工单退回（待你确认的卡片过期）；进行中、等澄清的那一段收尾后按任务的结局结束 */
  const endForTask = (task: Task, orders: readonly TaskMaintainerWorkOrder[]) => {
    const time = now();
    const events: NewEvent[] = [];
    for (const wo of orders.filter((w) => w.state === "planned" || w.state === "pending" || w.state === "awaiting_confirm")) {
      events.push(endedEvent(wo, time, "returned", { reason: TASK_ENDED_REASON }));
      const card = wo.cardId === undefined ? undefined : cards.get(wo.cardId);
      if (card?.status === "pending") events.push(cards.buildUpdate(card.id, { status: "expired" }).event);
    }
    if (events.length > 0) store.appendBatch(events);
    for (const wo of orders.filter(isActiveWorkOrder)) {
      const segment = segments.current(wo.maintainerId);
      const done = outcomeOf(wo, task);
      if (done && segment?.workOrderId === wo.id) segments.requestClose(segment, done.outcome, done.reason);
    }
  };

  /** 回执：工单结束了（你拒绝了的除外，那个由工单卡交代），回执交给任务维护者（任务已经结束的只记在时间线上；没派出的不算回执） */
  const sendReceipt = (wo: WorkOrder) => {
    if (!fromTaskMaintainer(wo) || wo.state !== "ended" || wo.outcome === "declined") return;
    if (store.eventByIdempotencyKey(`${RECEIPT_KEY(wo.id)}#record`)) return;
    const task = tasks.get(wo.taskId);
    if (!task) return;
    const r = refOf(wo);
    // 没派出就结束了的（任务结束、新的计划里没有这一行）没到项目那里：时间线上记一笔，不算回执
    if (wo.dispatchedAt === undefined) return void store.appendBatch([record(task, r, timelineText.undispatched(r), `${RECEIPT_KEY(wo.id)}#record`)]);
    const events = [record(task, r, timelineText.receipt(r), `${RECEIPT_KEY(wo.id)}#record`)];
    if (!ENDED_TASK_STATES.includes(task.state)) events.push(notifyTask(task, r, receiptText(r, stageStatusText(stageOrders(task, wo.stageId))), RECEIPT_KEY(wo.id)));
    store.appendBatch(events);
  };

  /** 任务变了：派出到了阶段的工单；结束了的收拾；暂停后又接着执行的告诉手上有工单的项目维护者 */
  const onTask = ({ task, from }: TaskEventPayload) => {
    if (!isMulti(task)) return;
    const orders = ordersOf(task.id);
    if (orders.length === 0) return;
    if (ENDED_TASK_STATES.includes(task.state)) return endForTask(task, orders);
    dispatchDue(task);
    if (task.state === "running" && (from === "paused" || from === "queued")) {
      const resumed = orders.filter((w) => w.state === "in_progress");
      if (resumed.length > 0) {
        store.appendBatch(
          resumed.map((w) => buildAgentNotice(maintainerChannel(w.maintainerId), resumedText(w), `work-order-resumed:${w.id}:${task.updatedAt}`, { ...taskMessageScope(task, w.stageId), projectId: w.projectId }).event),
        );
      }
    }
    // 任务能接着做了：排着的工单看看能不能开始
    for (const maintainerId of new Set(orders.filter((w) => w.state === "pending").map((w) => w.maintainerId))) options.tryStart(maintainerId);
  };

  /** 返工（按依赖重开了几个阶段）：这几个阶段涉及的项目重新建出工单，阶段开始时派出；没受影响的阶段不重派 */
  const onReaction = (p: OutputReactionPayload) => {
    if (p.reaction !== "rework" || !p.reopened?.length) return;
    const task = tasks.get(p.taskId);
    const plan = tasks.confirmedPlan(p.taskId)?.plan;
    if (!task || !plan || !isMulti(task)) return;
    const reopened = new Set(p.reopened);
    const events = plan.projects.filter((line) => line.stageId !== undefined && reopened.has(line.stageId)).flatMap((line) => plannedEvents(task, plan, line));
    if (events.length === 0) return;
    store.appendBatch(events);
    dispatchDue(tasks.get(task.id) ?? task);
  };

  /**
   * 计划换了一版（计划变更确认、自行调整计划，14 号票）：新计划里还没有工单的行建出工单（等阶段开始），所属阶段已经在做的马上派出；
   * 新计划里没有了的行：还没派出的工单退回，派出了的在时间线上记一笔、不再挡阶段；去掉的是退回、做不了的那几行时，
   * 这是调整做法，每个阶段算一次验收退回
   */
  const onPlanChanged = (taskId: string) => {
    const task = tasks.get(taskId);
    const plan = tasks.confirmedPlan(taskId)?.plan;
    if (!task || !plan || ENDED_TASK_STATES.includes(task.state) || !isMulti(task)) return;
    const lines = planLines(plan);
    const latest = latestOrders(task.id, (wo) => wo.planned);
    const time = now();
    const events: NewEvent[] = [...lines.entries()].filter(([key]) => !latest.has(key)).flatMap(([, line]) => plannedEvents(task, plan, line));
    const failed = new Map<string, OrderRef[]>();
    for (const [key, wo] of latest) {
      if (lines.has(key)) continue;
      if (wo.state === "planned") {
        events.push(endedEvent(wo, time, "returned", { reason: LINE_DROPPED_REASON }));
        continue;
      }
      if (store.eventByIdempotencyKey(LINE_DROPPED_KEY(wo.id))) continue;
      const r = refOf(wo);
      events.push(record(task, r, timelineText.lineDropped(r), LINE_DROPPED_KEY(wo.id)));
      if (wo.state === "ended" && failedOrder(wo)) failed.set(wo.stageId, [...(failed.get(wo.stageId) ?? []), r]);
    }
    for (const [stageId, refs] of failed) {
      const counted = options.execution.countReturn({ taskId: task.id, maintainerId: task.maintainerId }, stageId, { why: droppedWhy(refs), judged: RECEIPTS_JUDGED });
      events.push(...counted.events);
    }
    if (events.length === 0) return;
    store.appendBatch(events);
    dispatchDue(tasks.get(task.id) ?? task);
  };

  const mustTask = (scope: MaintainerScope): Task => {
    const task = tasks.get(scope.taskId);
    if (!task) throw new RequestRejected("not_found", refusal.noTask(scope.taskId));
    if (task.maintainerId !== scope.maintainerId) throw new RequestRejected("not_allowed", refusal.notYourTask(scope.taskId));
    return task;
  };

  /** 计划外的工单：交给守卫判定，要确认的出工单卡（这一支等用户确认） */
  const dispatchUnplanned = (task: Task, project: Project, wo: TaskMaintainerWorkOrder, stageTitle: string): DispatchResult => {
    const guardTask = options.execution.guardTask(task.id);
    if (!guardTask) throw new RequestRejected("not_allowed", refusal.notRunning(task));
    const judgement = options.judgeUnplanned({ task: { ...guardTask, currentStageId: wo.stageId }, maintainerId: task.maintainerId, project });
    if (judgement.refused !== undefined) throw new RequestRejected("not_allowed", judgement.refused);
    const payload: WorkOrderCardPayload = {
      workOrderId: wo.id,
      taskId: task.id,
      taskTitle: task.title,
      projectId: project.id,
      projectName: project.name,
      stageId: wo.stageId,
      stageTitle,
      title: wo.title,
      instructions: wo.instructions,
      acceptance: wo.acceptance,
      categories: judgement.categories,
    };
    const card = cards.buildCreate({ type: "work_order", urgency: "blocking", payload });
    const awaiting: TaskMaintainerWorkOrder = { ...wo, state: "awaiting_confirm", cardId: card.card.id };
    const r: OrderRef = { wo: awaiting, projectName: project.name };
    const item = inbox.buildAdd({ kind: "card", cardId: card.card.id, title: oneLine(unplannedInboxTitle(r), 60), source: taskSource(task), urgency: "blocking" });
    store.appendBatch([workOrderEvent(awaiting, "created", null, "maintainer"), card.event, item.event, record(task, r, timelineText.awaiting(r))]);
    inbox.alert(item.item);
    // 这一支等用户确认（都在等时任务转等我）
    options.execution.awaitAnswer(task.id, card.card.id, { stageId: wo.stageId, reason: "approval", what: UNPLANNED_WAIT });
    return { order: r, countedReturn: false, unplanned: { categories: judgement.categories, cardId: card.card.id } };
  };

  return {
    start() {
      unsubscribes.push(
        store.onAppend((event) => {
          try {
            if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.task) onTask(event.payload as TaskEventPayload);
            else if (event.channel === CHANNELS.projects && event.type === EVENT_TYPES.workOrder) sendReceipt((event.payload as WorkOrderEventPayload).workOrder);
            else if (event.channel === TASKS_CHANNEL && event.type === TASK_EVENTS.outputReaction) onReaction(event.payload as OutputReactionPayload);
            else if (event.channel === TASKS_CHANNEL && event.type === TASK_EVENTS.planDecided) {
              const p = event.payload as PlanDecidedPayload;
              // 计划变更确认了才换（拒绝的、重做时作废的不换，84 号票）
              if (p.change && p.decision === "confirmed") onPlanChanged(p.taskId);
            } else if (event.channel === TASKS_CHANNEL && event.type === TASK_EVENTS.planRevised) onPlanChanged((event.payload as PlanRevisedPayload).taskId);
          } catch (err) {
            log(`多项目任务的工单处理事件 ${event.type} 出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
          }
        }),
      );
      // 守护进程重启前没来得及做的：到了阶段还没派出的派出、结束了还没交回执的交回执
      for (const task of tasks.list()) {
        if (!isMulti(task)) continue;
        const orders = ordersOf(task.id);
        if (orders.length === 0) continue;
        for (const wo of orders) sendReceipt(wo);
        if (!ENDED_TASK_STATES.includes(task.state)) dispatchDue(task);
      }
    },
    stop() {
      for (const off of unsubscribes.splice(0)) off();
    },

    involvedProjects(task) {
      const plan = (tasks.confirmedPlan(task.id) ?? tasks.latestPlan(task.id))?.plan;
      const names = [...task.projects, ...(tasks.brief(task.id)?.brief.projects ?? []), ...(plan?.projects.map((p) => p.project) ?? [])];
      const found = new Map<string, Project>();
      for (const name of names) {
        const project = name.trim() ? projectNamed(name) : undefined;
        if (project) found.set(project.id, project);
      }
      return [...found.values()];
    },

    planConfirmed(task, plan) {
      if (!isMulti(task)) return [];
      return plan.projects.flatMap((line) => plannedEvents(task, plan, line));
    },

    stageGate(task, stageId) {
      if (!isMulti(task)) return undefined;
      const orders = stageOrders(task, stageId);
      const open = orders.current.some((x) => x.wo.state !== "ended");
      const failed = orders.current.some((x) => failedOrder(x.wo));
      return open || failed ? gateText(stageStatusText(orders), open) : undefined;
    },

    stageLines(task, stageId) {
      if (!isMulti(task)) return [];
      const orders = stageOrders(task, stageId);
      return orders.current.length === 0 ? [] : [STAGE_ORDERS_HEADER, ...orders.current.map(orderLine)];
    },

    reviewPlaces(task, stageId) {
      const involved = isMulti(task) ? stageOrders(task, stageId).current.flatMap((r) => projects.get(r.wo.projectId) ?? []) : [];
      return { projectRecords: involved.map((p) => real(projects.records(p.id).root)), workingDirs: involved.map((p) => real(projects.workdir(p))) };
    },

    dispatch(scope, input) {
      const task = mustTask(scope);
      if (!isMulti(task)) throw new RequestRejected("not_allowed", refusal.notMulti);
      if (task.state === "planning" || task.state === "awaiting_confirm") throw new RequestRejected("not_allowed", refusal.planning);
      if (task.state !== "running" && task.state !== "waiting_for_user") throw new RequestRejected("not_allowed", refusal.notRunning(task));
      const list = task.stages?.list ?? [];
      const stageId = input.stageId ?? taskMessageScope(task).stageId;
      const stage = stageId === undefined ? undefined : findStage(list, stageId);
      if (!stage) throw new RequestRejected("not_found", refusal.noStage(stageId, list.map((s) => s.stageId)));
      if (stage.state !== "running" && stage.state !== "waiting") throw new RequestRejected("not_allowed", refusal.stageNotActive(stage.stageId, STAGE_STATE_LABEL[stage.state]));
      const known = projects.list();
      const project = findByIdOrName(known, input.project, { nameOf: (p) => p.name, what: "项目", hint: refusal.knownProjects(known) });
      const instructions = input.instructions.trim();
      if (!instructions) throw new RequestRejected("bad_params", refusal.noInstructions);
      // 计划内只按"阶段 + 项目"判断（重新派单时可以改写内容）
      const line = planLines(tasks.confirmedPlan(task.id)?.plan).get(lineKey(stage.stageId, project.id));
      const previous = latestOrders(task.id).get(lineKey(stage.stageId, project.id));
      if (previous && previous.state !== "ended") throw new RequestRejected("not_allowed", refusal.stillOpen(refOf(previous)));
      const acceptance = input.acceptance?.length ? input.acceptance : (line?.acceptance ?? []);
      if (acceptance.length === 0) throw new RequestRejected("bad_params", refusal.noAcceptance);
      const wo = newWorkOrder(options.nextId(), now(), task, project, {
        source: "task_maintainer",
        stageId: stage.stageId,
        title: instructions.split(/\r?\n/)[0]!,
        instructions,
        acceptance,
        planned: line !== undefined,
      });
      if (!line) return dispatchUnplanned(task, project, wo, stage.title);
      // 计划内：直接派出。本阶段这个项目上次被退回、做不了的，这次是调整做法，算一次验收退回
      const adjusting = previous !== undefined && failedOrder(previous);
      const counted = adjusting
        ? options.execution.countReturn(scope, stage.stageId, { why: redispatchWhy({ wo, projectName: project.name }, previous), judged: RECEIPTS_JUDGED })
        : { events: [], stuck: false };
      // 验收退回超了阈值：这一支已经停下找用户，不派
      if (counted.stuck) throw new RequestRejected("not_allowed", refusal.stuck(stage.stageId));
      store.appendBatch([...counted.events, workOrderEvent(wo, "created", null, "maintainer"), ...dispatchOrder(task, wo, "system")]);
      const latestWo = getWorkOrder(store.reader, wo.id);
      return { order: refOf(latestWo && fromTaskMaintainer(latestWo) ? latestWo : wo), countedReturn: adjusting };
    },

    receipts(scope, stageId) {
      const task = mustTask(scope);
      const orders = ordersOf(task.id).filter((w) => stageId === undefined || w.stageId === stageId);
      if (orders.length === 0) return noOrdersText(stageId);
      const stages = task.stages?.list ?? [];
      const ids = [...new Set(orders.map((w) => w.stageId))].toSorted((a, b) => stages.findIndex((s) => s.stageId === a) - stages.findIndex((s) => s.stageId === b));
      return ids
        .map((id) => {
          const stage = stages.find((s) => s.stageId === id);
          const status = stageStatusText(stageOrders(task, id));
          return [
            receiptsStageTitle(id, stage && { title: stage.title, state: STAGE_STATE_LABEL[stage.state] }),
            ...orders.filter((w) => w.stageId === id).map((w) => orderLine(refOf(w))),
            ...(status ? [status] : []),
          ].join("\n");
        })
        .join("\n");
    },

    submitReceipt(maintainerId, input) {
      const segment = segments.current(maintainerId);
      const wo = segments.currentWorkOrder(maintainerId);
      if (!segment || !wo || !fromTaskMaintainer(wo)) throw new RequestRejected("not_allowed", refusal.receiptOnlyInChange);
      if (segment.state !== "open") throw new RequestRejected("not_allowed", refusal.receiptClosing(wo));
      if (wo.state === "clarifying") throw new RequestRejected("not_allowed", refusal.receiptClarifying(wo));
      const reason = input.reason?.trim();
      if (input.outcome !== "done" && !reason) throw new RequestRejected("bad_params", refusal.reasonRequired);
      const next: TaskMaintainerWorkOrder = { ...wo, receipt: input.summary.trim(), updatedAt: now() };
      store.append(workOrderEvent(next, "updated", wo.state, "maintainer"));
      segments.requestClose(segment, input.outcome, input.outcome === "done" ? undefined : reason);
      return next;
    },

    decide(card, decision, note) {
      const wo = getWorkOrder(store.reader, card.payload.workOrderId);
      if (!wo || !fromTaskMaintainer(wo) || wo.state !== "awaiting_confirm" || wo.cardId !== card.id) throw new RequestRejected("conflict", refusal.notAwaiting);
      const task = tasks.get(wo.taskId);
      if (!task) throw new RequestRejected("not_found", refusal.noTask(wo.taskId));
      const r = refOf(wo);
      const time = now();
      const said = note?.trim() || undefined;
      const decided: WorkOrderDecidedPayload = {
        workOrderId: wo.id,
        cardId: card.id,
        taskId: task.id,
        taskTitle: task.title,
        projectId: wo.projectId,
        projectName: r.projectName,
        stageId: wo.stageId,
        title: wo.title,
        decision,
        ...(said ? { note: said } : {}),
        by: "user",
        time,
      };
      const events: NewEvent[] = [{ channel: WORK_ORDERS_CHANNEL, type: EVENT_TYPES.workOrderDecided, payload: decided }];
      if (decision === "dispatch") {
        events.push(...dispatchOrder(task, wo, "user"), record(task, r, timelineText.confirmed(r)), notifyTask(task, r, confirmedText(r, said), `work-order-decided:${wo.id}`));
      } else {
        events.push(endedEvent(wo, time, "declined", { reason: declinedReason(said) }), record(task, r, timelineText.declined(r)), notifyTask(task, r, declinedText(r, said), `work-order-decided:${wo.id}`));
      }
      return {
        status: "handled",
        events,
        ...(decision === "deny" && said ? { note: said } : {}),
        // 这一支不用再等了（批准、拒绝都是）：阶段接着走，任务在等我的恢复执行
        afterCommit: () => options.execution.answered(card.id),
      };
    },
  };
}
