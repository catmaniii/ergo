// 彻底删除和范围记录（18 号票；改写函数表见 memory/rewriters.ts）：
// - 范围记录的改写：摘要、说明、依据（可能引着用户的原话）换成删除标记；种类、哪次审视、归属、来源原样保留。
//   连带改写它在时间线上的那条记录（幂等键 scopeTimelineKey）和越界通知（每个版本），改写后追加一条新版本（同一个 id：
//   开着的页面换掉手里的，项目档案里的 scope-records.md 换掉那一条）。删项目、删任务时也用它改写那个项目、那个任务的范围记录
//   （279 号票起由这里在"删除参与方"登记表里登记，registerScopeRecordDeletion；那时只换负载，不连带、不追加新版本，照原来的做法）；
// - 引用（PurgeQuotes）：范围记录上记着审视时看到的用户原话从哪来（sources）。彻底删除用户在维护者会话里的一条消息、
//   审批卡上的一次批准时，记着它的范围记录一起改写——审视的模型可能原样引了，也可能转述了，不去辨认，凡是看到过的都改。
import {
  CHANNELS,
  EVENT_TYPES,
  type InboxItemEventPayload,
  isDeletedEventPayload,
  MAINTAINER_CHANNEL_PREFIX,
  type MessageEventPayload,
  PURGED_TEXT,
  type ScopeRecordEventPayload,
} from "@ergo/protocol";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import type { PurgeQuotes, PurgeRewriter } from "../events/purge.ts";
import { type DeletionParticipants, liveEvents, PROJECT_DELETION, TASK_DELETION } from "../deletion/participants.ts";
import { type ApprovalDecidedPayload, GUARD_EVENTS } from "../guard-runtime/events.ts";
import { scopeTimelineKey } from "./scope-review.ts";

/** 记着某条用户消息、某次批准的范围记录（id 写在 sources 里才算） */
function recordsQuoting(store: EventStore, id: string, from: keyof ScopeRecordEventPayload["sources"]): StoredEvent[] {
  return store.mentioning(EVENT_TYPES.scopeRecord, id).filter((e) => !isDeletedEventPayload(e.payload) && (e.payload as ScopeRecordEventPayload).sources?.[from].includes(id));
}

export const scopeRecordPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.scopeRecord,
  rewrite(event) {
    const p = event.payload as ScopeRecordEventPayload;
    const { record } = p;
    return {
      ...p,
      record: {
        ...record,
        summary: PURGED_TEXT,
        ...(record.detail === undefined ? {} : { detail: PURGED_TEXT }),
        ...(record.basis === undefined ? {} : { basis: PURGED_TEXT }),
      },
    } satisfies ScopeRecordEventPayload;
  },
  related(event, store) {
    const { record } = event.payload as ScopeRecordEventPayload;
    const timeline = store.eventByIdempotencyKey(scopeTimelineKey(record.id));
    const notices = store.mentioning(EVENT_TYPES.inboxItem, record.id).filter((e) => {
      if (isDeletedEventPayload(e.payload)) return false;
      const { item } = e.payload as InboxItemEventPayload;
      return item.kind === "notice" && item.notice === "out_of_scope" && (item.data as { recordId?: unknown } | undefined)?.recordId === record.id;
    });
    return [...(timeline ? [timeline] : []), ...notices];
  },
  newVersion(event, rewritten) {
    return { channel: event.channel, type: EVENT_TYPES.scopeRecord, payload: rewritten };
  },
};

/** 范围记录引着的：用户在维护者会话里的消息、审批卡上的批准（审批决定） */
export const scopeRecordQuotes: readonly PurgeQuotes[] = [
  {
    eventType: EVENT_TYPES.message,
    quotedIn(event, store) {
      if (!event.channel.startsWith(MAINTAINER_CHANNEL_PREFIX) || isDeletedEventPayload(event.payload)) return [];
      return recordsQuoting(store, (event.payload as MessageEventPayload).message.id, "messageIds");
    },
  },
  {
    eventType: GUARD_EVENTS.approvalDecided,
    quotedIn(event, store) {
      if (isDeletedEventPayload(event.payload)) return [];
      return recordsQuoting(store, (event.payload as ApprovalDecidedPayload).approvalId, "approvalIds");
    },
  },
];

/**
 * 范围审视登记的参与方（279 号票）：删项目时这个项目的范围记录（项目列表频道上的，18 号票：摘要、说明、依据可能引着用户的原话），
 * 删任务时这个任务的（看板频道上不属于项目的任务的）——照彻底删除的改写函数字段级改写
 */
export function registerScopeRecordDeletion(participants: Pick<DeletionParticipants, "register">): () => void {
  const undo = [
    participants.register(PROJECT_DELETION, {
      owner: "scope-review",
      join: ({ project }, plan) => ({
        claim() {
          for (const event of liveEvents(plan.store.read(CHANNELS.projects, 0, EVENT_TYPES.scopeRecord))) {
            if ((event.payload as ScopeRecordEventPayload).record.projectId === project.id) plan.rewrite(event);
          }
        },
      }),
    }),
    participants.register(TASK_DELETION, {
      owner: "scope-review",
      join: ({ task }, plan) => ({
        claim() {
          for (const event of liveEvents(plan.store.read(CHANNELS.board, 0, EVENT_TYPES.scopeRecord))) {
            if ((event.payload as ScopeRecordEventPayload).record.taskId === task.id) plan.rewrite(event);
          }
        },
      }),
    }),
  ];
  return () => {
    for (const u of undo) u();
  };
}
