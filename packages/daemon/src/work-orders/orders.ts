// 建出、派出工单，和"任务变了，手上这张工单该以什么结局结束"（16 号票的派单队列 work-orders.ts、17 号票的多项目任务
// multi-project.ts 共用一份）。工单按来源分支：用户发起的单项目任务的（起草计划、执行）建出即进收件维护者的队列；
// 涉及多个项目的任务的维护者派来的改动先"等阶段开始"或"待你确认"，派出时才进队列。
import {
  ENDED_TASK_STATES,
  type Project,
  type TaskActor,
  type Task,
  type TaskMaintainerWorkOrder,
  type UserTaskWorkOrder,
  WORK_ORDER_KIND_LABEL,
  type WorkOrder,
  type WorkOrderOutcome,
} from "@ergou/protocol";
import type { NewEvent } from "../events/event-store.ts";
import { oneLine } from "../util/text.ts";
import { endedEvent, workOrderEvent } from "./events.ts";
import { archivedReason, deletedProjectReason, TASK_CANCELLED_REASON, TASK_ENDED_REASON } from "./texts.ts";

/** 用户发起的单项目任务（16 号票）的一张新工单的内容：起草计划（内容是任务书、打回意见……）、执行 */
export type UserTaskOrderBody = { source: "user_task"; kind: UserTaskWorkOrder["kind"]; instructions?: string | undefined };
/** 涉及多个项目的任务的维护者派来的改动（17 号票）的内容：所属阶段、验收标准、计划内外；建出时等阶段开始 */
export type TaskMaintainerOrderBody = Pick<TaskMaintainerWorkOrder, "source" | "title" | "instructions" | "stageId" | "planned"> & { acceptance: readonly string[] };

/** 一张新工单：用户发起的待接（建出即进队列），任务维护者派来的等阶段开始 */
export function newWorkOrder(id: string, time: string, task: Pick<Task, "id" | "title">, project: Pick<Project, "id" | "maintainerId">, body: UserTaskOrderBody): UserTaskWorkOrder;
export function newWorkOrder(id: string, time: string, task: Pick<Task, "id" | "title">, project: Pick<Project, "id" | "maintainerId">, body: TaskMaintainerOrderBody): TaskMaintainerWorkOrder;
export function newWorkOrder(id: string, time: string, task: Pick<Task, "id" | "title">, project: Pick<Project, "id" | "maintainerId">, body: UserTaskOrderBody | TaskMaintainerOrderBody): WorkOrder {
  const base = { id, projectId: project.id, maintainerId: project.maintainerId, taskId: task.id, taskTitle: task.title, createdAt: time, updatedAt: time };
  if (body.source === "user_task") {
    return {
      ...base,
      source: "user_task",
      kind: body.kind,
      title: oneLine(`${WORK_ORDER_KIND_LABEL[body.kind]}：${task.title}`, 80),
      ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
      state: "pending",
    };
  }
  return {
    ...base,
    source: "task_maintainer",
    kind: "change",
    title: oneLine(body.title, 80),
    instructions: body.instructions,
    stageId: body.stageId,
    acceptance: [...body.acceptance],
    planned: body.planned,
    state: "planned",
  };
}

/**
 * 工单进收件维护者的队列：用户发起的建出即进（created）；任务维护者派来的（等阶段开始、待你确认）派出时进（dispatched，记下时刻）。
 * 发给已归档、删掉的项目的直接退回（同一事务，附原因），维护者不被唤起
 */
export function dispatchedEvents(wo: WorkOrder, project: Project | undefined, by: TaskActor, time: string, key?: string): NewEvent[] {
  const queued: WorkOrder = wo.source === "user_task" ? wo : { ...wo, state: "pending", dispatchedAt: time, updatedAt: time };
  const event = wo.source === "user_task" ? workOrderEvent(wo, "created", null, by, key) : workOrderEvent(queued, "dispatched", wo.state, by, key);
  if (project && project.state !== "archived") return [event];
  return [event, endedEvent(queued, time, "returned", { reason: project ? archivedReason(project) : deletedProjectReason(wo.projectId) })];
}

/**
 * 这张工单的活做完了没有（任务变了之后）：返回工单要以什么结局结束；还没做完是 undefined。
 * 任务取消（归档）了退回、失败了做不了；起草计划的在计划交了、执行的在任务完成时完成；
 * 任务维护者派来的改动（17 号票）由项目维护者交回执结束，任务结束时还在做的退回
 */
export function outcomeOf(wo: WorkOrder, task: Task): { outcome: WorkOrderOutcome; reason?: string } | undefined {
  if (task.state === "cancelled" || task.state === "archived") return { outcome: "returned", reason: TASK_CANCELLED_REASON };
  if (task.state === "failed") return { outcome: "unable", ...(task.failReason ? { reason: task.failReason } : {}) };
  if (wo.source === "task_maintainer") return ENDED_TASK_STATES.includes(task.state) ? { outcome: "returned", reason: TASK_ENDED_REASON } : undefined;
  if (wo.kind === "plan") return task.state === "planning" ? undefined : { outcome: "done" };
  return task.state === "done" ? { outcome: "done" } : undefined;
}
