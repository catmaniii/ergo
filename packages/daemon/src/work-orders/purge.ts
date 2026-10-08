// 工单事件的改写函数（彻底删除的改写函数表，见 memory/rewriters.ts；删除项目时 projects/deletion.ts 用它）：
// 工单的内容（交给维护者的任务书、打回意见）换成删除标记；工单的状态、结局、所属的任务和项目原样保留。
// 会话分段的事件在维护者会话频道上，删除项目时随整条会话换成"已删除"标记，不用另登记。
import { EVENT_TYPES, type WorkOrderEventPayload } from "@ergou/protocol";
import { purgedField, type PurgeRewriter } from "../events/purge.ts";

export const workOrderPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.workOrder,
  rewrite(event) {
    const p = event.payload as WorkOrderEventPayload;
    return { ...p, workOrder: { ...p.workOrder, ...purgedField(p.workOrder, "instructions") } } satisfies WorkOrderEventPayload;
  },
};
