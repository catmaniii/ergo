// 待我处理在"删除参与方"登记表里的那一份（279 号票；登记表见 deletion/participants.ts）：属于这次删除的事项。要看别人认领了哪些卡片，
// 在 follow 一步里做。原来在 projects/deletion.ts（ADR-0010）、tasks/deletion.ts（186 号票）里各写一遍。
// - 删项目：项目内部的事项（建的时候标上的，64 号票）、整张换成标记的卡的事项、记着它的内部任务的通知——这几条的卡也整张换成标记，
//   事项再追加一版删掉的（不会一直卡着）；连同删除的二次确认（数据里有项目编号的）、字段级改写的卡的事项、这个维护者的"中断不确定"：
//   照彻底删除的改写函数换掉标题和正文（inboxItemPurge，状态不变：二次确认还是"确认删除"）。
// - 删任务：数据、来处里记着它的，它的卡（整张换成标记的）的，它的维护者和子 agent 的"中断不确定"：标题、正文、来源（"任务「X」"）
//   换成删除标记，再追加一版删掉的（待办里不再有）。
import { CHANNELS, EVENT_TYPES, type InboxItem, type InboxItemEventPayload, inboxItemProjectId, interruptedNoticeData, isInternalTo, PURGED_TEXT } from "@ergo/protocol";
import { type DeletionParticipants, liveEvents, PROJECT_DELETION, TASK_DELETION } from "../deletion/participants.ts";
import { purgedInboxItem } from "./inbox.ts";
import { listInboxItems } from "./views.ts";

/** 删掉的任务的事项：标题、正文、来源（"任务「X」"）、"交给我做"数据里调用的来处都换成删除标记 */
function deletedTaskItem(item: InboxItem): InboxItem {
  const purged = purgedInboxItem(item);
  const data = purged.kind === "notice" ? (purged.data as { origin?: { source?: unknown } } | undefined) : undefined;
  const origin = data?.origin && typeof data.origin.source === "string" ? { data: { ...data, origin: { ...data.origin, source: PURGED_TEXT } } } : {};
  return { ...purged, source: PURGED_TEXT, ...origin } as InboxItem;
}

/** 待我处理登记的参与方：删项目、删任务各一个 */
export function registerInboxDeletion(participants: Pick<DeletionParticipants, "register">): () => void {
  const undo = [
    participants.register(PROJECT_DELETION, {
      owner: "inbox",
      join: ({ project }, plan) => ({
        follow() {
          const { store } = plan;
          const mineTask = (taskId: unknown) => typeof taskId === "string" && plan.tasks.has(taskId);
          // 项目内部的事项（64 号票）：它们的卡也整张换成标记
          const internal = new Set<string>();
          for (const event of liveEvents(store.read(CHANNELS.inbox, 0, EVENT_TYPES.inboxItem))) {
            const { item } = event.payload as InboxItemEventPayload;
            const data = item.kind === "notice" ? (item.data as { taskId?: unknown } | undefined) : undefined;
            if (!isInternalTo(item, project.id) && !(item.cardId !== undefined && plan.cardFate(item.cardId) === "dropped") && !mineTask(data?.taskId)) continue;
            internal.add(item.id);
            if (item.cardId !== undefined) plan.dropCard(item.cardId);
          }
          // 属于这个项目的事项：照彻底删除的改写函数换掉文字
          for (const event of liveEvents(store.read(CHANNELS.inbox, 0, EVENT_TYPES.inboxItem))) {
            const { item } = event.payload as InboxItemEventPayload;
            if (
              internal.has(item.id) ||
              inboxItemProjectId(item) === project.id ||
              (item.kind === "card" && plan.cardFate(item.cardId) === "purged") ||
              interruptedNoticeData(item)?.agentId === project.maintainerId
            ) {
              plan.rewrite(event);
            }
          }
          // 项目内部的事项：再追加一版删掉的
          for (const item of listInboxItems(store.reader)) {
            if (internal.has(item.id)) plan.append("inbox", { channel: CHANNELS.inbox, type: EVENT_TYPES.inboxItem, payload: { item: { ...purgedInboxItem(item), deleted: true, version: item.version + 1 } } satisfies InboxItemEventPayload });
          }
        },
      }),
    }),
    participants.register(TASK_DELETION, {
      owner: "inbox",
      join: ({ task, agents }, plan) => ({
        follow() {
          const { store } = plan;
          const mine = (item: InboxItem): boolean => {
            if (item.kind === "card") return plan.cardFate(item.cardId) !== undefined;
            const data = item.data as { taskId?: unknown; origin?: { taskId?: unknown } } | undefined;
            const interrupted = interruptedNoticeData(item);
            return data?.taskId === task.id || data?.origin?.taskId === task.id || item.origin?.taskId === task.id || (interrupted !== undefined && agents.has(interrupted.agentId));
          };
          const itemIds = new Set<string>();
          for (const event of liveEvents(store.read(CHANNELS.inbox, 0, EVENT_TYPES.inboxItem))) {
            const { item } = event.payload as InboxItemEventPayload;
            if (!mine(item)) continue;
            itemIds.add(item.id);
            plan.replace(event, { item: deletedTaskItem(item) } satisfies InboxItemEventPayload);
          }
          for (const item of listInboxItems(store.reader)) {
            if (itemIds.has(item.id)) plan.append("inbox", { channel: CHANNELS.inbox, type: EVENT_TYPES.inboxItem, payload: { item: { ...deletedTaskItem(item), deleted: true, version: item.version + 1 } } satisfies InboxItemEventPayload });
          }
        },
      }),
    }),
  ];
  return () => {
    for (const u of undo) u();
  };
}
