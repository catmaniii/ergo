// 工单事件的改写函数（彻底删除的改写函数表，见 memory/rewriters.ts；删除项目时也用它，279 号票起由这里在"删除参与方"登记表里登记）：
// 工单的内容（交给维护者的任务书、打回意见、定时作业这次运行要做的事；17 号票任务维护者派来的改动还有提问和回执）换成删除标记；
// 工单的标题、状态、结局、所属的任务（或定时作业）和项目原样保留，工单是哪一支（来源）不变。
// 会话分段的事件在维护者会话频道上，删除项目时随整条会话换成"已删除"标记，不用另登记。
// 项目内部任务（64 号票）随项目一起删掉时，它的工单连标题、任务名、原因也换掉（purgedWorkOrder 的 whole）。
import { CHANNELS, EVENT_TYPES, isInternalTo, PURGED_TEXT, type WorkOrder, type WorkOrderEventPayload } from "@ergo/protocol";
import { type DeletionParticipants, liveEvents, PROJECT_DELETION } from "../deletion/participants.ts";
import { purgedField, type PurgeRewriter } from "../events/purge.ts";
import { workOrderInternal } from "./views.ts";

const purged = (wo: WorkOrder): WorkOrder => {
  if (wo.source === "task_maintainer") return { ...wo, ...purgedField(wo, "instructions"), ...purgedField(wo, "question"), ...purgedField(wo, "receipt") };
  if (wo.source === "scheduled_job") return { ...wo, ...purgedField(wo, "instructions") };
  return { ...wo, ...purgedField(wo, "instructions") };
};

/**
 * 一张工单的内容换成删除标记；whole（项目内部任务的、它计划里的作业的工单，64 号票）连标题、所属任务的名字、原因也换掉
 */
export function purgedWorkOrder(wo: WorkOrder, whole = false): WorkOrder {
  const content = purged(wo);
  if (!whole) return content;
  return { ...content, title: PURGED_TEXT, ...("taskTitle" in content ? { taskTitle: PURGED_TEXT } : {}), ...purgedField(content, "reason") } as WorkOrder;
}

export const workOrderPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.workOrder,
  rewrite(event) {
    const p = event.payload as WorkOrderEventPayload;
    return { ...p, workOrder: purged(p.workOrder) } satisfies WorkOrderEventPayload;
  },
};

/**
 * 派单器登记的参与方（279 号票，删项目）：这个项目的工单（16 号票）——项目内部任务的、它计划里的作业每次运行的（64 号票）内容连标题、
 * 任务名、原因整个换掉（purgedWorkOrder 的 whole）；别的（涉及多个项目的任务派来的……）照彻底删除的改写函数只换内容
 */
export function registerWorkOrderDeletion(participants: Pick<DeletionParticipants, "register">): () => void {
  return participants.register(PROJECT_DELETION, {
    owner: "work-orders",
    join: ({ project }, plan) => ({
      claim() {
        for (const event of liveEvents(plan.store.read(CHANNELS.projects, 0, EVENT_TYPES.workOrder))) {
          const p = event.payload as WorkOrderEventPayload;
          if (p.workOrder.projectId !== project.id) continue;
          if (isInternalTo({ internal: workOrderInternal(plan.store.reader, p.workOrder) }, project.id)) plan.replace(event, { ...p, workOrder: purgedWorkOrder(p.workOrder, true) } satisfies WorkOrderEventPayload);
          else plan.rewrite(event);
        }
      },
    }),
  });
}
