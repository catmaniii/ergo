// 工单的视图（纯函数，16 号票）：
// - 项目页上的工单流水线：排队中（待接）、进行中（含等澄清）、已结束三栏，每张工单显示来源、所属任务和这个任务现在到哪了；
// - 看板上任务卡的"等项目 X"：只在真被项目挡住时标——任务有一张还排着（待接）的工单、任务正等着它（起草计划的还在规划中，
//   执行的在排队中），而项目的维护者手上有别的工单（一次只做一件）。全局执行名额满了、任务暂停了都不算。
// 工单不在看板上单独占卡：看板上只有任务，工单挂在任务和项目上。
import {
  isActiveWorkOrder,
  type Task,
  TASK_STATE_LABEL,
  WORK_ORDER_KIND_LABEL,
  WORK_ORDER_LANES,
  WORK_ORDER_SOURCE_LABEL,
  type WorkOrder,
  type WorkOrderLane,
  workOrderLane,
  workOrderStatusText,
} from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

export interface WorkOrderView {
  workOrder: WorkOrder;
  /** 来源（派单方）："你" */
  source: string;
  /** 要做的事：起草计划、执行 */
  kind: string;
  /** 工单的状态："等澄清"、"已结束 · 退回" */
  status: string;
  /** 所属任务（看板上收到过的） */
  task: Task | undefined;
  /** 所属任务现在到哪了："执行中 · 第 1/2 阶段「写出来」"；看板上没有这个任务时没有 */
  stage: string | undefined;
}

/** 已结束的工单在流水线上最多列几张（最近结束的在前） */
export const ENDED_WORK_ORDERS_SHOWN = 10;

/** 任务现在到哪了：状态，执行起来之后加上第几阶段 */
function stageOf(task: Task | undefined): string | undefined {
  if (!task) return undefined;
  const state = TASK_STATE_LABEL[task.state];
  const current = task.stages?.current;
  if (current === undefined) return state;
  const title = task.stages?.list?.[current - 1]?.title;
  return `${state} · 第 ${current}/${task.stages!.total} 阶段${title ? `「${title}」` : ""}`;
}

function viewOf(state: UiState, workOrder: WorkOrder): WorkOrderView {
  const task = state.tasks[workOrder.taskId];
  return {
    workOrder,
    source: WORK_ORDER_SOURCE_LABEL[workOrder.source],
    kind: WORK_ORDER_KIND_LABEL[workOrder.kind],
    status: workOrderStatusText(workOrder),
    task,
    stage: stageOf(task),
  };
}

/** 按派出的先后（同一时刻派出的按编号） */
const byCreated = (a: WorkOrder, b: WorkOrder) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id, undefined, { numeric: true });

/** 一个项目的工单流水线：排队中按派出的先后（先来先做），进行中，已结束的最近的在前（最多列 ENDED_WORK_ORDERS_SHOWN 张） */
export function projectPipeline(state: UiState, projectId: string): Record<WorkOrderLane, WorkOrderView[]> {
  const orders = Object.values(state.workOrders).filter((w) => w.projectId === projectId);
  const lane = (l: WorkOrderLane) => orders.filter((w) => workOrderLane(w) === l);
  const lanes = {
    queued: lane("queued").toSorted(byCreated),
    active: lane("active").toSorted(byCreated),
    ended: lane("ended")
      .toSorted((a, b) => (b.endedAt ?? b.updatedAt).localeCompare(a.endedAt ?? a.updatedAt) || b.id.localeCompare(a.id, undefined, { numeric: true }))
      .slice(0, ENDED_WORK_ORDERS_SHOWN),
  };
  return Object.fromEntries(WORK_ORDER_LANES.map((l) => [l, lanes[l].map((w) => viewOf(state, w))])) as Record<WorkOrderLane, WorkOrderView[]>;
}

/** 排着的工单是任务正在等的：起草计划的任务还在规划中，执行的在排队中（暂停了、结束了的不算；看板上没收到这个任务时算） */
function awaited(order: WorkOrder, task: Task | undefined): boolean {
  if (!task) return true;
  return order.kind === "plan" ? task.state === "planning" : task.state === "queued";
}

/**
 * 任务在等哪个项目（看板上标"等项目 X"）：它有一张排着的、正等着的工单，而项目的维护者手上有别的工单（进行中、等澄清）时
 * 是那个项目的名字，否则 undefined
 */
export function taskWaitingForProject(state: UiState, taskId: string): string | undefined {
  const orders = Object.values(state.workOrders);
  const pending = orders.find((w) => w.taskId === taskId && w.state === "pending" && awaited(w, state.tasks[taskId]));
  if (!pending) return undefined;
  const busy = orders.some((w) => w.projectId === pending.projectId && w.id !== pending.id && isActiveWorkOrder(w));
  return busy ? (state.projects[pending.projectId]?.name ?? pending.projectId) : undefined;
}
