// 任务模块在"删除参与方"登记表里的那一份（279 号票；登记表见 deletion/participants.ts）。186 号票的 tasks/records-purge.ts 并进来：
// 删项目时随项目删的内部任务（ADR-0010、64 号票）、用户删一个任务（186 号票）共用这几样任务自己的记录——
// - 看板频道上它们的每条 task 事件：任务的文字换成删除标记（purgedTask），行留着、编号不收回；
// - 看板频道上现在生效的计划换了一版时推的 task_plan（计划栏、阶段抽屉按它画）：整条换成"已删除"标记；
// - tasks 频道上它们的任务书、计划、计划的决定……：整条换成"已删除"标记。
// 并行的提议和决定（sub-agents/deletion.ts）、触发登记和定时作业（scheduled-jobs/purge.ts）由拥有它们的模块各自登记，按 plan.tasks 认。
// 删项目时另外：scope 一步认出项目的内部任务（带着这个项目的标记，isInternalTo）写进 plan.tasks；没结束的同一事务取消（能删的项目
// 没有在做、排队的工单，只会是还没派工单的规划中、计划等确认的）；负载里记着它们的任务编号、或者带着这个项目的标记的卡片整张换成标记。
// 删任务时另外：它自己的维护者会话（任务自己的维护者、迁移来的定时任务的作业维护者）整条换成标记；负载里记着它的卡片整张换成标记，
// 在别人会话里的不动（KEEP_CARD_TYPES）。
import {
  type CardEventPayload,
  type CardType,
  CHANNELS,
  ENDED_TASK_STATES,
  EVENT_TYPES,
  isInternalTo,
  type ProjectInternal,
  type TaskEventPayload,
} from "@ergo/protocol";
import { type DeletionParticipants, type DeletionPlan, liveEvents, PROJECT_DELETION, TASK_DELETION } from "../deletion/participants.ts";
import { TASKS_CHANNEL } from "./events.ts";
import { purgedTask } from "./material-sources.ts";
import { listTasks } from "./views.ts";

/**
 * 负载里记着任务编号、但在别人会话里的卡（不随任务删）：秘书的提问卡、建议发起任务卡、快速动作卡，项目维护者为工单的提问卡、
 * 工单卡，每周的归档清单
 */
const KEEP_CARD_TYPES: ReadonlySet<CardType> = new Set<CardType>(["questions", "suggest_task", "quick_action", "archive_list", "work_order"]);

/** plan.tasks 里这几个任务自己的记录（见文件开头） */
function claimTaskRecords(plan: DeletionPlan): void {
  const { store, tasks: ids } = plan;
  const mine = (taskId: unknown) => typeof taskId === "string" && ids.has(taskId);
  for (const event of liveEvents(store.read(CHANNELS.board, 0, EVENT_TYPES.task))) {
    const p = event.payload as TaskEventPayload;
    if (ids.has(p.task.id)) plan.replace(event, { ...p, task: purgedTask(p.task) } satisfies TaskEventPayload);
  }
  for (const event of liveEvents(store.read(CHANNELS.board, 0, EVENT_TYPES.taskPlan))) {
    if (mine((event.payload as { taskId?: unknown }).taskId)) plan.marker(event);
  }
  for (const event of liveEvents(store.read(TASKS_CHANNEL))) {
    if (mine((event.payload as { taskId?: unknown }).taskId)) plan.marker(event);
  }
}

/** 任务模块登记的参与方：删项目、删任务各一个 */
export function registerTaskDeletion(participants: Pick<DeletionParticipants, "register">): () => void {
  const undoProject = participants.register(PROJECT_DELETION, {
    owner: "tasks",
    join: ({ project }, plan) => ({
      // 项目的内部任务（64 号票）随项目一起删
      scope() {
        for (const task of listTasks(plan.store.reader)) if (isInternalTo(task, project.id)) plan.tasks.add(task.id);
      },
      claim() {
        claimTaskRecords(plan);
        // 没结束的同一事务取消（用户确认了删除项目）
        for (const task of listTasks(plan.store.reader)) {
          if (!plan.tasks.has(task.id) || ENDED_TASK_STATES.includes(task.state)) continue;
          const payload: TaskEventPayload = { task: { ...purgedTask(task), state: "cancelled", updatedAt: plan.context.deletedAt }, change: "cancelled", from: task.state, by: "user" };
          plan.append("records", { channel: CHANNELS.board, type: EVENT_TYPES.task, payload });
        }
        // 卡片：负载里记着它们的任务编号的（计划卡、计划变更卡、并行确认卡、提问卡……）、带着这个项目的标记的（项目的维护者给的还没点的
        // 建议卡、起草段的审批卡这类负载里没有任务编号的）：每个版本整条换成标记
        for (const event of liveEvents(plan.store.read(CHANNELS.cards, 0, EVENT_TYPES.card))) {
          const { card } = event.payload as CardEventPayload;
          const payload = card.payload as { taskId?: unknown; internal?: ProjectInternal } | undefined;
          if ((typeof payload?.taskId === "string" && plan.tasks.has(payload.taskId)) || isInternalTo(payload, project.id)) plan.dropCard(card.id);
        }
      },
    }),
  });
  const undoTask = participants.register(TASK_DELETION, {
    owner: "tasks",
    join: ({ task, conversation }, plan) => ({
      scope() {
        plan.tasks.add(task.id);
      },
      claim() {
        claimTaskRecords(plan);
        // 它自己的维护者会话：整条换成"已删除"标记（由项目的维护者做的不碰）
        if (conversation) for (const event of liveEvents(plan.store.read(conversation))) plan.marker(event);
        // 卡片：这个任务的（别人会话里的除外）每个版本整条换成标记
        for (const event of liveEvents(plan.store.read(CHANNELS.cards, 0, EVENT_TYPES.card))) {
          const { card } = event.payload as CardEventPayload;
          if ((card.payload as { taskId?: unknown } | undefined)?.taskId === task.id && !KEEP_CARD_TYPES.has(card.type as CardType)) plan.dropCard(card.id);
        }
      },
    }),
  });
  return () => {
    undoProject();
    undoTask();
  };
}
