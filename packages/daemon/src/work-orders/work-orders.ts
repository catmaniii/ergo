// 派单器（规格第 11、12、21 节，16 号票）：派单队列，以及把会话分段（segments.ts）、澄清（clarifications.ts）接在一起。
//
// 工单：交给某个项目维护者的一份工作。只涉及一个项目的任务由这个项目的维护者起草计划并执行，维护者要做的事都以工单送达：
// - 起草计划（plan）：秘书写好任务书、用户打回计划、项目开工建出首个建设任务时，派一张起草计划的工单，内容就是交给维护者的话；
// - 执行（execute）：用户确认计划后派一张；失败后重试、完成后返工时再派一张。
// 工单写进事件日志（项目列表频道的 work_order 事件）时注明收件项目，派单器把它放进收件维护者的队列：一次只做一件、先来先做。
// 维护者空着（手上没有工单、也没有进行中或收尾中的会话段）就开始队首的工单：起草计划的直接开始，执行的交给执行控制器——
// 全局执行名额也有空时任务才进入执行中（admit），正忙时任务留在排队中（看板上"等项目 X"）。
// 发给已归档项目的工单直接以"退回"结束并附原因，维护者不被唤起；已停用的项目照常接单。
// 工单状态：待接 → 进行中 ⇄ 等澄清 → 已结束（完成、退回、做不了），每次迁移是一条 work_order 事件。
// 工单的结局：起草计划的在计划交了（任务离开规划中）时、执行的在任务完成 / 失败 / 取消时，先让这一段收尾，
// 写回之后（或者催写回到了次数，转为用户拍板）工单才结束；任务结束时还排着的工单退回。
import {
  CHANNELS,
  ENDED_TASK_STATES,
  EVENT_TYPES,
  isActiveWorkOrder,
  MAINTAINER_CHANNEL_PREFIX,
  maintainerChannel,
  type MessageEventPayload,
  type Project,
  type ProjectEventPayload,
  type Task,
  type TaskEventPayload,
  WORK_ORDER_KIND_LABEL,
  type WorkOrder,
  type WorkOrderEventPayload,
  type WorkOrderKind,
  type WorkOrderOutcome,
} from "@ergou/protocol";
import type { CardService } from "../cards/cards.ts";
import { buildAgentNotice } from "../conversation/messages.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { ProjectService } from "../projects/projects.ts";
import type { TaskExecution } from "../tasks/execution.ts";
import type { TaskService } from "../tasks/tasks.ts";
import { oneLine } from "../util/text.ts";
import { type Clarifications, createClarifications } from "./clarifications.ts";
import { endedEvent, workOrderEvent } from "./events.ts";
import { createSegments, type Segments } from "./segments.ts";
import { archivedReason, executeInstructions, planStartText, TASK_CANCELLED_REASON, TASK_ENDED_REASON } from "./texts.ts";
import { countWorkOrders, getWorkOrder, openWorkOrdersOfProject, workOrdersOf, workOrdersOfTask } from "./views.ts";

/**
 * 一段收尾时最多催几次写回（同第 8 节的催促阈值，默认 3）。14 号票合并后改成取配置里的 tasks.thresholds.nudges
 * （DEFAULT_TASK_THRESHOLDS.nudges），和执行中的催促同一个阈值
 */
export const WRITE_BACK_NUDGES = 3;

export interface WorkOrderServiceOptions {
  store: EventStore;
  tasks: TaskService;
  projects: ProjectService;
  cards: CardService;
  inbox: InboxService;
  /** 执行控制器：项目空出来了看看排队的任务能不能开始（kick）；等澄清时这一支停下、有了回答接着走 */
  execution: Pick<TaskExecution, "kick" | "awaitAnswer" | "answered">;
  /** 一段收尾时最多催几次写回（同第 8 节的催促阈值） */
  nudges: number;
  now: () => string;
  log: (line: string) => void;
}

/**
 * 派单器。会话分段（segments）、澄清（clarifications）的入口都从这里给出去：项目维护者模块、网关、提问卡、项目模块经它接上。
 * Segments 的方法里 current、currentWorkOrder、scopeOf、accepts、idleExited、writeSummary、recordSession、messagePrelude 给项目维护者模块和网关用
 */
export interface WorkOrders extends Pick<Segments, "current" | "previous" | "currentWorkOrder" | "scopeOf" | "accepts" | "idleExited" | "writeSummary" | "recordSession" | "messagePrelude"> {
  start(): void;
  stop(): void;
  /**
   * 交给项目维护者起草计划（任务书、打回意见、首个建设任务的交代）：返回要和引起它的事件同一事务追加的事件。
   * 不是项目的任务返回 undefined（照旧交给任务自己的维护者）
   */
  dispatchPlan(task: Task, instructions: string, key: string): NewEvent[] | undefined;
  /**
   * 执行控制器问：这个排队的任务现在能不能进入执行中（全局名额另由控制器看）。项目的任务要等项目的维护者空着、
   * 它的执行工单排在队首；能开始时 events 里是工单开始、开一段会话的事件（和任务进入执行中同一事务）。
   * 不能开始时 events 里可能有补派的执行工单（任务留在排队中，看板上"等项目 X"），项目已归档的是退回的工单
   */
  admit(task: Task): { admit: boolean; events: NewEvent[] };
  get(workOrderId: string): WorkOrder | undefined;
  /** 项目还没结束的工单（有就不能归档） */
  openOf(projectId: string): WorkOrder[];
  /** 维护者干活中遇到要问派单方的（ask_clarification）：工单转等澄清，提问卡进待我处理 */
  askClarification: Clarifications["ask"];
  /** 提问卡上用户回答了项目维护者为工单问的：交回它的通知 */
  clarificationReply: Clarifications["replyEvents"];
  /** 重置维护者（项目页上）：当前这段直接结束，新开一段，只凭项目档案 */
  reset: Segments["reset"];
}

/** 这张工单的活做完了没有（任务变了之后）：返回工单要以什么结局结束；还没做完是 undefined */
const outcomeOf = (wo: WorkOrder, task: Task): { outcome: WorkOrderOutcome; reason?: string } | undefined => {
  if (task.state === "cancelled" || task.state === "archived") return { outcome: "returned", reason: TASK_CANCELLED_REASON };
  if (task.state === "failed") return { outcome: "unable", ...(task.failReason ? { reason: task.failReason } : {}) };
  if (wo.kind === "plan") return task.state === "planning" ? undefined : { outcome: "done" };
  return task.state === "done" ? { outcome: "done" } : undefined;
};

const errorText = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));

export function createWorkOrders(options: WorkOrderServiceOptions): WorkOrders {
  const { store, tasks, projects, now, log } = options;
  let unsubscribe: (() => void) | undefined;
  /** 这一轮同步代码里已经编好、还没追加的工单号（同一事务里编几个时不撞号） */
  let issued = 0;

  const segments = createSegments({ store, tasks, projects, inbox: options.inbox, nudges: options.nudges, now, onClosed: (maintainerId) => tryStart(maintainerId) });
  const clarifications = createClarifications({ store, cards: options.cards, inbox: options.inbox, projects, segments, execution: options.execution, now });

  // ───────────────────────── 工单 ─────────────────────────

  const nextWorkOrderId = () => {
    issued = Math.max(issued, countWorkOrders(store.reader)) + 1;
    return `wo-${issued}`;
  };

  const newWorkOrder = (task: Task, project: Project, kind: WorkOrderKind, instructions?: string): WorkOrder => {
    const time = now();
    return {
      id: nextWorkOrderId(),
      projectId: project.id,
      maintainerId: project.maintainerId,
      source: "user_task",
      kind,
      taskId: task.id,
      taskTitle: task.title,
      title: oneLine(`${WORK_ORDER_KIND_LABEL[kind]}：${task.title}`, 80),
      ...(instructions === undefined ? {} : { instructions }),
      state: "pending",
      createdAt: time,
      updatedAt: time,
    };
  };

  const ended = (wo: WorkOrder, outcome: WorkOrderOutcome, reason?: string) => endedEvent(wo, now(), outcome, { reason });

  /** 派出一张工单：发给已归档项目的直接退回（同一事务，附原因） */
  const dispatched = (wo: WorkOrder, project: Project, by: "user" | "system", key?: string): NewEvent[] => {
    const created = workOrderEvent(wo, "created", null, by, key);
    return project.state === "archived" ? [created, ended(wo, "returned", archivedReason(project))] : [created];
  };

  /** 维护者手上的工单（进行中、等澄清） */
  const activeWorkOrder = (maintainerId: string) => workOrdersOf(store.reader, maintainerId, ["in_progress", "clarifying"])[0];

  /** 现在能开始的待接工单：起草计划的要任务还在规划中，执行的要任务在排队中（暂停了的跳过） */
  const startable = (wo: WorkOrder): boolean => {
    const state = tasks.get(wo.taskId)?.state;
    return wo.kind === "plan" ? state === "planning" : state === "queued";
  };

  /** 队首：先派出的、现在能开始的待接工单 */
  const headOf = (maintainerId: string) => workOrdersOf(store.reader, maintainerId, ["pending"]).find(startable);

  /** 任务还没结束的工单（某种） */
  const openOfTask = (taskId: string, kind: WorkOrderKind) => workOrdersOfTask(store.reader, taskId).find((w) => w.kind === kind && w.state !== "ended");

  /** 工单开始：工单进行中、开一段会话；起草计划的工单另给维护者一条通知（执行的由执行控制器交代） */
  const startEvents = (wo: WorkOrder, project: Project): NewEvent[] => {
    const time = now();
    const started: WorkOrder = { ...wo, state: "in_progress", startedAt: time, updatedAt: time };
    const opened = segments.open(project, { workOrder: started });
    const events = [workOrderEvent(started, "started", wo.state, "system"), ...opened.events];
    if (wo.kind === "plan") events.push(buildAgentNotice(maintainerChannel(wo.maintainerId), planStartText(wo), `work-order-start:${wo.id}`, segments.scopeIn(opened.segment)).event);
    return events;
  };

  /** 维护者空着就开始队首的工单；正在对话段里、有工单在等就先让对话段收尾 */
  function tryStart(maintainerId: string): void {
    try {
      if (activeWorkOrder(maintainerId)) return;
      const project = projects.maintainedBy(maintainerId);
      if (!project) return;
      const head = headOf(maintainerId);
      const segment = segments.current(maintainerId);
      if (segment) {
        if (head && segment.kind === "chat" && segment.state === "open") segments.requestClose(segment);
        return;
      }
      // 已归档的项目没有排着的工单（派出时就退回，还有工单没结束的不能归档）
      if (!head) return;
      if (head.kind === "plan") store.appendBatch(startEvents(head, project));
      else options.execution.kick();
    } catch (err) {
      log(`派单器给维护者 ${maintainerId} 开始工单时出错：${errorText(err)}`);
    }
  }

  // ───────────────────────── 跟着别的事件走 ─────────────────────────

  /** 任务变了：工单的活做完了就收尾；刚进排队中的项目任务补派执行工单；任务结束时还在排队的工单退回 */
  const onTask = ({ task, from }: TaskEventPayload) => {
    const project = projects.projectOf(task);
    if (!project) return;
    const maintainerId = task.maintainerId;
    const active = activeWorkOrder(maintainerId);
    const segment = segments.current(maintainerId);
    if (active?.taskId === task.id && segment?.workOrderId === active.id) {
      const done = outcomeOf(active, task);
      if (done) segments.requestClose(segment, done.outcome, done.reason);
    }
    if (ENDED_TASK_STATES.includes(task.state)) {
      const pending = workOrdersOfTask(store.reader, task.id).filter((w) => w.state === "pending");
      if (pending.length > 0) store.appendBatch(pending.map((w) => ended(w, "returned", TASK_ENDED_REASON)));
    }
    // 刚进排队中（确认了计划、重试、返工）：还没有执行工单就派一张（项目已归档的直接退回、附原因，维护者不被唤起；
    // 只在进排队中的那一下派，不会每次任务变化都派一张再退回）
    if (task.state === "queued" && from !== "queued" && !openOfTask(task.id, "execute")) {
      store.appendBatch(dispatched(newWorkOrder(task, project, "execute", executeInstructions(task)), project, "system"));
    }
    tryStart(maintainerId);
  };

  /** 取消归档了：排着的任务看看能不能开始（还有工单没结束的项目不能归档，归档时没有要退回的） */
  const onProject = ({ change }: ProjectEventPayload) => {
    if (change === "unarchived") options.execution.kick();
  };

  const onEvent = (event: { channel: string; type: string; payload: unknown }) => {
    if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.task) return onTask(event.payload as TaskEventPayload);
    if (event.channel === CHANNELS.projects && event.type === EVENT_TYPES.project) return onProject(event.payload as ProjectEventPayload);
    if (event.channel === CHANNELS.projects && event.type === EVENT_TYPES.workOrder) {
      const { workOrder, change } = event.payload as WorkOrderEventPayload;
      if (change === "created") tryStart(workOrder.maintainerId);
      return;
    }
    if (!event.channel.startsWith(MAINTAINER_CHANNEL_PREFIX)) return;
    const maintainerId = event.channel.slice(MAINTAINER_CHANNEL_PREFIX.length);
    if (event.type === EVENT_TYPES.message) return segments.inputArrived(maintainerId, event.payload as MessageEventPayload);
    if (event.type === EVENT_TYPES.turnEnd) segments.turnEnded(maintainerId);
  };

  return {
    start() {
      unsubscribe = store.onAppend((event) => {
        try {
          onEvent(event);
        } catch (err) {
          log(`派单器处理事件 ${event.type} 出错：${errorText(err)}`);
        }
      });
      clarifications.start();
      // 守护进程重启前在收尾的段：接着收尾；空着的维护者：开始队首的工单
      segments.start();
      for (const project of projects.list()) tryStart(project.maintainerId);
    },
    stop() {
      unsubscribe?.();
      clarifications.stop();
    },

    dispatchPlan(task, instructions, key) {
      const project = projects.projectOf(task);
      if (!project) return undefined;
      const open = openOfTask(task.id, "plan");
      const drafting = open && isActiveWorkOrder(open) && segments.current(open.maintainerId)?.state === "open";
      // 维护者正在起草：改了的任务书作为一条通知交给它（属于这一段）
      if (open && drafting) return [buildAgentNotice(maintainerChannel(open.maintainerId), instructions, `${key}#notice`, segments.scopeIn(open)).event];
      // 还在排队：换成新的内容
      if (open?.state === "pending") return [workOrderEvent({ ...open, instructions, updatedAt: now() }, "updated", open.state, "system", `${key}#wo`)];
      // 没有，或者上一张起草计划的工单正在收尾：派一张新的（收尾完了再开始；发给已归档项目的直接退回）
      const wo = newWorkOrder(task, project, "plan", instructions);
      const events = dispatched(wo, project, "user", `${key}#wo`);
      if (project.state === "archived") return events;
      // 维护者空着、前面没有排着的：马上开始（分隔线、开始的通知和派出在同一事务）
      const free = !activeWorkOrder(project.maintainerId) && !segments.current(project.maintainerId) && !headOf(project.maintainerId);
      return free ? [...events, ...startEvents(wo, project)] : events;
    },

    admit(task) {
      const project = projects.projectOf(task);
      if (!project) return { admit: true, events: [] };
      const maintainerId = task.maintainerId;
      const active = activeWorkOrder(maintainerId);
      if (active?.taskId === task.id && active.kind === "execute") return { admit: true, events: [] };
      const existing = openOfTask(task.id, "execute");
      // 已归档的项目：派单器把发给它的工单直接退回、说明原因，维护者不被唤起（任务留在排队中，取消归档后接着排）。
      // 排着的退回；没有排着的不再补派（补派在任务进入排队中时做，那里同样退回）
      if (project.state === "archived") return { admit: false, events: existing?.state === "pending" ? [ended(existing, "returned", archivedReason(project))] : [] };
      // 还没有执行工单（重试、返工）：补派一张
      const wo = existing ?? newWorkOrder(task, project, "execute", executeInstructions(task));
      const created = existing ? [] : [workOrderEvent(wo, "created", null, "system")];
      if (active || segments.current(maintainerId)) {
        // 维护者正忙（或者在对话段里：等它收尾）：任务留在排队中
        queueMicrotask(() => tryStart(maintainerId));
        return { admit: false, events: created };
      }
      const head = headOf(maintainerId);
      if (head && head.id !== wo.id) return { admit: false, events: created };
      return { admit: true, events: [...created, ...startEvents(wo, project)] };
    },

    get: (id) => getWorkOrder(store.reader, id),
    openOf: (projectId) => openWorkOrdersOfProject(store.reader, projectId),

    current: segments.current,
    previous: segments.previous,
    currentWorkOrder: segments.currentWorkOrder,
    scopeOf: segments.scopeOf,
    accepts: segments.accepts,
    idleExited: segments.idleExited,
    writeSummary: segments.writeSummary,
    recordSession: segments.recordSession,
    messagePrelude: segments.messagePrelude,
    reset: segments.reset,
    askClarification: clarifications.ask,
    clarificationReply: clarifications.replyEvents,
  };
}
