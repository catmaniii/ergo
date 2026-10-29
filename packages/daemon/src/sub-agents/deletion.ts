// 子 agent 模块在"删除参与方"登记表里的那一份（279 号票；登记表见 deletion/participants.ts）：随删除一起走的任务（plan.tasks：
// 删项目时项目的内部任务，删任务时它自己）在 sub_agents 频道上的并行提议和决定，文字换成删除标记（purgedParallelPayload：任务名、
// 为什么并行、子 agent 的工作说明……；编号、阶段、目录、决定原样）。186 号票起删任务也这样（原来在 tasks/records-purge.ts）。
import { type DeletionParticipants, type DeletionPlan, liveEvents, PROJECT_DELETION, TASK_DELETION } from "../deletion/participants.ts";
import { SUB_AGENTS_CHANNEL } from "./events.ts";
import { purgedParallelPayload } from "./material-source.ts";

function claimParallel(plan: DeletionPlan): void {
  for (const event of liveEvents(plan.store.read(SUB_AGENTS_CHANNEL))) {
    const taskId = (event.payload as { taskId?: unknown }).taskId;
    if (typeof taskId !== "string" || !plan.tasks.has(taskId)) continue;
    const purged = purgedParallelPayload(event.type, event.payload);
    if (purged) plan.replace(event, purged);
  }
}

/** 子 agent 模块登记的参与方：删项目、删任务各一个 */
export function registerSubAgentDeletion(participants: Pick<DeletionParticipants, "register">): () => void {
  const undo = [
    participants.register(PROJECT_DELETION, { owner: "sub-agents", join: (_subject, plan) => ({ claim: () => claimParallel(plan) }) }),
    participants.register(TASK_DELETION, { owner: "sub-agents", join: (_subject, plan) => ({ claim: () => claimParallel(plan) }) }),
  ];
  return () => {
    for (const u of undo) u();
  };
}
