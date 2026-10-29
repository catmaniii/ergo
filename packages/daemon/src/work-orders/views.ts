// 工单和维护者会话分段的派生视图（ergo.db，规格第 4 节"工单"）：
// - work_orders：每张工单的最新状态（项目列表频道上的 work_order 事件，按工单号留最后一条）；
// - maintainer_segments：每个维护者的每一段会话的最新状态（维护者会话频道上的 segment 事件）。
// 删除项目时维护者会话频道上的事件整条换成"已删除"标记（ADR-0010），派生视图整体重放时它的分段也就没了。
import {
  CHANNELS,
  EVENT_TYPES,
  isJobRunWorkOrder,
  MAINTAINER_CHANNEL_PREFIX,
  type MaintainerSegment,
  type ProjectInternal,
  type SegmentEventPayload,
  type WorkOrder,
  type WorkOrderEventPayload,
  type WorkOrderState,
} from "@ergo/protocol";
import type { DerivedView } from "../events/event-store.ts";
import { getJob } from "../scheduled-jobs/views.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { getTask } from "../tasks/views.ts";

/**
 * 不属于任务的工单（定时作业的一次运行，19 号票）在 task_id 一栏记的值：表是 16 号票建的，这一栏不能为空。
 * 按任务查工单（workOrdersOfTask）不能拿它来查
 */
export const NO_TASK_ID = "";

export const workOrdersView: DerivedView = {
  name: "work_orders",
  create(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_orders (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        maintainer_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        state TEXT NOT NULL,
        work_order TEXT NOT NULL,
        created_seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS work_orders_by_maintainer ON work_orders (maintainer_id, state, created_seq);
      CREATE INDEX IF NOT EXISTS work_orders_by_task ON work_orders (task_id, created_seq);
      CREATE TABLE IF NOT EXISTS maintainer_segments (
        segment_id TEXT PRIMARY KEY,
        maintainer_id TEXT NOT NULL,
        state TEXT NOT NULL,
        segment TEXT NOT NULL,
        created_seq INTEGER NOT NULL,
        opened_seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS maintainer_segments_by_maintainer ON maintainer_segments (maintainer_id, created_seq);
    `);
  },
  clear(db) {
    db.exec("DELETE FROM work_orders; DELETE FROM maintainer_segments;");
  },
  apply(db, event) {
    if (event.channel === CHANNELS.projects && event.type === EVENT_TYPES.workOrder) {
      const { workOrder } = event.payload as WorkOrderEventPayload;
      db.run(
        `INSERT INTO work_orders (id, project_id, maintainer_id, task_id, state, work_order, created_seq) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, work_order = excluded.work_order`,
        workOrder.id,
        workOrder.projectId,
        workOrder.maintainerId,
        isJobRunWorkOrder(workOrder) ? NO_TASK_ID : workOrder.taskId,
        workOrder.state,
        JSON.stringify(workOrder),
        event.globalSeq,
      );
      return;
    }
    if (event.channel.startsWith(MAINTAINER_CHANNEL_PREFIX) && event.type === EVENT_TYPES.segment) {
      const { segment } = event.payload as SegmentEventPayload;
      db.run(
        `INSERT INTO maintainer_segments (segment_id, maintainer_id, state, segment, created_seq, opened_seq) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (segment_id) DO UPDATE SET state = excluded.state, segment = excluded.segment`,
        segment.segmentId,
        segment.maintainerId,
        segment.state,
        JSON.stringify(segment),
        event.globalSeq,
        event.seq,
      );
    }
  },
};

const parseWorkOrder = (row: { work_order: string }) => JSON.parse(row.work_order) as WorkOrder;
const parseSegment = (row: { segment: string }) => JSON.parse(row.segment) as MaintainerSegment;

export function getWorkOrder(db: ReadonlyDatabase, id: string): WorkOrder | undefined {
  const row = db.get<{ work_order: string }>("SELECT work_order FROM work_orders WHERE id = ?", id);
  return row && parseWorkOrder(row);
}

/**
 * 工单属于的东西是不是项目内部的（64 号票）：任务的工单看任务，定时作业的一次运行看作业。是的话给出标记——
 * 这张工单段里产生的待我处理事项（催写回到了次数的卡住求助、越界通知……）带上它
 */
export function workOrderInternal(db: ReadonlyDatabase, wo: WorkOrder | undefined): ProjectInternal | undefined {
  if (wo === undefined) return undefined;
  return isJobRunWorkOrder(wo) ? getJob(db, wo.scheduledJobId)?.internal : getTask(db, wo.taskId)?.internal;
}

/** 某个维护者收到的、处于这些状态的工单，先派出的在前 */
export function workOrdersOf(db: ReadonlyDatabase, maintainerId: string, states: readonly WorkOrderState[]): WorkOrder[] {
  const marks = states.map(() => "?").join(", ");
  return db
    .all<{ work_order: string }>(`SELECT work_order FROM work_orders WHERE maintainer_id = ? AND state IN (${marks}) ORDER BY created_seq`, maintainerId, ...states)
    .map(parseWorkOrder);
}

/** 某个项目还没结束的工单（等阶段开始、待你确认、待接、进行中、等澄清：都挡项目归档），先建出的在前 */
export function openWorkOrdersOfProject(db: ReadonlyDatabase, projectId: string): WorkOrder[] {
  return db.all<{ work_order: string }>("SELECT work_order FROM work_orders WHERE project_id = ? AND state != 'ended' ORDER BY created_seq", projectId).map(parseWorkOrder);
}

/** 某个任务的工单，先派出的在前（不属于任务的工单不按这个查：taskId 是 NO_TASK_ID 时抛错） */
export function workOrdersOfTask(db: ReadonlyDatabase, taskId: string): WorkOrder[] {
  if (taskId === NO_TASK_ID) throw new Error("按任务查工单要给任务 id：不属于任务的工单（定时作业的一次运行）不能这样查"); // @i18n-ignore log：编程错误
  return db.all<{ work_order: string }>("SELECT work_order FROM work_orders WHERE task_id = ? ORDER BY created_seq", taskId).map(parseWorkOrder);
}

/** 进行中（含等澄清）的定时作业运行工单有几张：它们占着全局执行名额（19 号票，tasks/slots.ts 数名额用） */
export function countActiveRunWorkOrders(db: ReadonlyDatabase): number {
  return Number(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM work_orders WHERE state IN ('in_progress', 'clarifying') AND json_extract(work_order, '$.source') = 'scheduled_job'")?.n ?? 0,
  );
}

/** 派出过多少张工单（新工单的编号接着往下排） */
export function countWorkOrders(db: ReadonlyDatabase): number {
  return Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM work_orders")?.n ?? 0);
}

/** 某个维护者的各段会话，先开的在前 */
export function segmentsOf(db: ReadonlyDatabase, maintainerId: string): MaintainerSegment[] {
  return db.all<{ segment: string }>("SELECT segment FROM maintainer_segments WHERE maintainer_id = ? ORDER BY created_seq", maintainerId).map(parseSegment);
}

/** 维护者手上的那一段（进行中或收尾中）；没有是 undefined */
export function currentSegment(db: ReadonlyDatabase, maintainerId: string): MaintainerSegment | undefined {
  const row = db.get<{ segment: string }>(
    "SELECT segment FROM maintainer_segments WHERE maintainer_id = ? AND state != 'closed' ORDER BY created_seq DESC LIMIT 1",
    maintainerId,
  );
  return row && parseSegment(row);
}

/** 收尾中的段（守护进程重启时接着收尾） */
export function closingSegments(db: ReadonlyDatabase): MaintainerSegment[] {
  return db.all<{ segment: string }>("SELECT segment FROM maintainer_segments WHERE state = 'closing' ORDER BY created_seq").map(parseSegment);
}

/** 这一段开段的事件在维护者会话频道里的序号（之后的事件都在这一段里） */
export function segmentOpenedSeq(db: ReadonlyDatabase, segmentId: string): number | undefined {
  return db.get<{ opened_seq: number }>("SELECT opened_seq FROM maintainer_segments WHERE segment_id = ?", segmentId)?.opened_seq;
}
