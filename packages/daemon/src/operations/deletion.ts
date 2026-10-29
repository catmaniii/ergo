// 运营方案在"删除参与方"登记表里的那一份（279 号票，删项目；登记表见 deletion/participants.ts）。原来在 projects/deletion.ts（130 号票）：
// - operations 频道上这个项目交过的每一份运营方案、用户的决定（每一条的文字、引用的原话）：整条换成"已删除"标记；
// - 项目列表频道上 project 事件里现在生效的运营方案：每一条的文字换成删除标记（项目本身的字段照旧，同 15 号票；生效成的内部任务不变）。
// "运营方案变更"卡、"首版做完了"卡、"转入使用"卡随项目整张换成标记（项目系统的 projects/deletion-participants.ts）。
import { CHANNELS, EVENT_TYPES, type ProjectEventPayload } from "@ergo/protocol";
import { type DeletionParticipants, liveEvents, PROJECT_DELETION } from "../deletion/participants.ts";
import { OPERATIONS_CHANNEL } from "./events.ts";
import { purgedProjectOperations } from "./operations.ts";

export function registerOperationsDeletion(participants: Pick<DeletionParticipants, "register">): () => void {
  return participants.register(PROJECT_DELETION, {
    owner: "operations",
    join: ({ project }, plan) => ({
      claim() {
        for (const event of liveEvents(plan.store.read(OPERATIONS_CHANNEL))) {
          if ((event.payload as { projectId?: unknown }).projectId === project.id) plan.marker(event);
        }
        for (const event of liveEvents(plan.store.read(CHANNELS.projects, 0, EVENT_TYPES.project))) {
          const p = event.payload as ProjectEventPayload;
          if (p.project.id === project.id && p.project.operations) plan.replace(event, { ...p, project: { ...p.project, operations: purgedProjectOperations(p.project.operations) } } satisfies ProjectEventPayload);
        }
      },
    }),
  });
}
