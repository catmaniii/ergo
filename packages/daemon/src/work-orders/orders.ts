// 建出、派出工单，和"任务变了，手上这张工单该以什么结局结束"（16 号票的派单队列 work-orders.ts、17 号票的多项目任务
// multi-project.ts、19 号票的定时作业的一次运行共用一份）。工单按来源分支：用户发起的单项目任务的（起草计划、执行）、
// 定时作业的一次运行（不属于任务）建出即进收件维护者的队列；涉及多个项目的任务的维护者派来的改动先"等阶段开始"或"待你确认"，
// 派出时才进队列。每张工单都有的基础字段只在 orderBase 里拼。
import {
  ENDED_TASK_STATES,
  JOB_RUN_WORK_ORDER_LABEL,
  type JobRun,
  type JobRunWorkOrder,
  type Project,
  type ScheduledJob,
  type TaskActor,
  type Task,
  type TaskMaintainerWorkOrder,
  type TaskWorkOrder,
  type UserTaskWorkOrder,
  WORK_ORDER_KIND_LABEL,
  type WorkOrder,
  type WorkOrderOutcome,
  t,
} from "@ergo/protocol";
import type { NewEvent } from "../events/event-store.ts";
import { oneLine } from "../util/text.ts";
import { endedEvent, workOrderEvent } from "./events.ts";
import { archivedReason, deletedProjectReason, taskCancelledReason, taskEndedReason } from "./texts.ts";

/** 用户发起的单项目任务（16 号票）的一张新工单的内容：起草计划（内容是任务书、打回意见……）、执行 */
export type UserTaskOrderBody = { source: "user_task"; kind: UserTaskWorkOrder["kind"]; instructions?: string | undefined };
/** 涉及多个项目的任务的维护者派来的改动（17 号票）的内容：所属阶段、验收标准、计划内外；建出时等阶段开始 */
export type TaskMaintainerOrderBody = Pick<TaskMaintainerWorkOrder, "source" | "title" | "instructions" | "stageId" | "planned"> & { acceptance: readonly string[] };

/** 每张工单都有的：工单号、收件项目和它的维护者、流水线上的说法、建出的时刻 */
function orderBase(id: string, time: string, project: Pick<Project, "id" | "maintainerId">, title: string) {
  return { id, projectId: project.id, maintainerId: project.maintainerId, title: oneLine(title, 80), createdAt: time, updatedAt: time };
}

/** 一张新工单：用户发起的待接（建出即进队列），任务维护者派来的等阶段开始 */
export function newWorkOrder(id: string, time: string, task: Pick<Task, "id" | "title">, project: Pick<Project, "id" | "maintainerId">, body: UserTaskOrderBody): UserTaskWorkOrder;
export function newWorkOrder(id: string, time: string, task: Pick<Task, "id" | "title">, project: Pick<Project, "id" | "maintainerId">, body: TaskMaintainerOrderBody): TaskMaintainerWorkOrder;
export function newWorkOrder(id: string, time: string, task: Pick<Task, "id" | "title">, project: Pick<Project, "id" | "maintainerId">, body: UserTaskOrderBody | TaskMaintainerOrderBody): TaskWorkOrder {
  const ofTask = { taskId: task.id, taskTitle: task.title };
  if (body.source === "user_task") {
    return {
      ...orderBase(id, time, project, t("workOrders.orderTitle", { kind: WORK_ORDER_KIND_LABEL[body.kind], title: task.title })),
      ...ofTask,
      source: "user_task",
      kind: body.kind,
      ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
      state: "pending",
    };
  }
  return {
    ...orderBase(id, time, project, body.title),
    ...ofTask,
    source: "task_maintainer",
    kind: "change",
    instructions: body.instructions,
    stageId: body.stageId,
    acceptance: [...body.acceptance],
    planned: body.planned,
    state: "planned",
  };
}

/** 定时作业的一次运行的工单（19 号票）：不属于任务，记着作业和这次运行，待接（建出即进队列） */
export function newRunWorkOrder(id: string, time: string, job: Pick<ScheduledJob, "id" | "title">, run: Pick<JobRun, "runId">, project: Pick<Project, "id" | "maintainerId">, instructions: string): JobRunWorkOrder {
  return {
    ...orderBase(id, time, project, t("workOrders.orderTitle", { kind: JOB_RUN_WORK_ORDER_LABEL, title: job.title })),
    source: "scheduled_job",
    kind: "run",
    scheduledJobId: job.id,
    runId: run.runId,
    instructions,
    state: "pending",
  };
}

/**
 * 工单进收件维护者的队列：用户发起的、定时作业的运行建出即进（created）；任务维护者派来的（等阶段开始、待你确认）派出时进
 * （dispatched，记下时刻）。发给已归档、删掉的项目的直接退回（同一事务，附原因），维护者不被唤起
 */
export function dispatchedEvents(wo: WorkOrder, project: Project | undefined, by: TaskActor, time: string, key?: string): NewEvent[] {
  const queued: WorkOrder = wo.source === "task_maintainer" ? { ...wo, state: "pending", dispatchedAt: time, updatedAt: time } : wo;
  const event = wo.source === "task_maintainer" ? workOrderEvent(queued, "dispatched", wo.state, by, key) : workOrderEvent(wo, "created", null, by, key);
  if (project && project.state !== "archived") return [event];
  return [event, endedEvent(queued, time, "returned", { reason: project ? archivedReason(project) : deletedProjectReason(wo.projectId) })];
}

/**
 * 这张工单的活做完了没有（任务变了之后）：返回工单要以什么结局结束；还没做完是 undefined。
 * 任务取消（归档）了退回、失败了做不了；起草计划的在计划交了、执行的在任务完成时完成；
 * 任务维护者派来的改动（17 号票）由项目维护者交回执结束，任务结束时还在做的退回。定时作业的运行不属于任务，不看这个
 */
export function outcomeOf(wo: TaskWorkOrder, task: Task): { outcome: WorkOrderOutcome; reason?: string } | undefined {
  if (task.state === "cancelled" || task.state === "archived") return { outcome: "returned", reason: taskCancelledReason() };
  if (task.state === "failed") return { outcome: "unable", ...(task.failReason ? { reason: task.failReason } : {}) };
  if (wo.source === "task_maintainer") return ENDED_TASK_STATES.includes(task.state) ? { outcome: "returned", reason: taskEndedReason() } : undefined;
  if (wo.kind === "plan") return task.state === "planning" ? undefined : { outcome: "done" };
  return task.state === "done" ? { outcome: "done" } : undefined;
}
