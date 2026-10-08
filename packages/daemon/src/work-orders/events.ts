// 工单和会话分段的事件（派单队列 work-orders.ts、会话分段 segments.ts、澄清 clarifications.ts 共用）：
// - 项目列表频道上的 work_order 事件：工单的最新状态和这次的变化；
// - 维护者会话频道上的 segment 事件：一段会话的最新状态和这次的变化。
import {
  CHANNELS,
  EVENT_TYPES,
  type MaintainerSegment,
  maintainerChannel,
  type SegmentChange,
  type SegmentEventPayload,
  type TaskActor,
  type WorkOrder,
  type WorkOrderChange,
  type WorkOrderEventPayload,
  type WorkOrderOutcome,
  type WriteBackGap,
} from "@ergou/protocol";
import type { NewEvent } from "../events/event-store.ts";

export function workOrderEvent(workOrder: WorkOrder, change: WorkOrderChange, from: WorkOrder["state"] | null, by: TaskActor, idempotencyKey?: string): NewEvent {
  const payload: WorkOrderEventPayload = { workOrder, change, from, by };
  return { channel: CHANNELS.projects, type: EVENT_TYPES.workOrder, payload, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) };
}

export function segmentEvent(segment: MaintainerSegment, change: SegmentChange, idempotencyKey?: string): NewEvent {
  const payload: SegmentEventPayload = { segment, change };
  return { channel: maintainerChannel(segment.maintainerId), type: EVENT_TYPES.segment, payload, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) };
}

/** 工单结束（带结局、原因；那一段没写回项目档案的如实记下） */
export function endedEvent(wo: WorkOrder, time: string, outcome: WorkOrderOutcome, extra: { reason?: string | undefined; unwritten?: WriteBackGap | undefined } = {}): NewEvent {
  const { questionsCardId: _card, ...rest } = wo;
  const ended: WorkOrder = {
    ...rest,
    state: "ended",
    outcome,
    ...(extra.reason ? { reason: extra.reason } : {}),
    ...(extra.unwritten ? { unwritten: extra.unwritten } : {}),
    endedAt: time,
    updatedAt: time,
  };
  return workOrderEvent(ended, "ended", wo.state, "system");
}
