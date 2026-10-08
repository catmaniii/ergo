// 会话历史分页（规格第 5 节 HTTP）。会话频道的历史可能很长，前端第一次订阅时 WebSocket 只补发最近一页
// （最近 HISTORY_PAGE_SIZE 条消息起的全部事件），往上翻时经 HTTP 按页取更早的消息：
// - 第一页的起点是第 HISTORY_PAGE_SIZE 新的那条消息的序号 S，WebSocket 补发序号 ≥ S 的事件；
// - HTTP 的 before 是前端手里最早那条消息的序号，返回序号 < before 的最近若干条消息。
// 两边按同一个序号切开，所以交界处不重不漏。带着游标重连的照旧补发缺的全部事件。
// 25 号票起一页里还带着落在这一页里的时间线记录（timeline_record、快速动作的操作记录 quick_action_executed）：
// 序号从这一页第一条消息起、小于 before（更早没有了的从头起），往上翻时要点层、全局层也看得到旧页里的偏离和操作记录。
import {
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  HISTORY_PAGE_SIZE,
  type HistoryMessage,
  type HistoryPage,
  type HistoryRecord,
  isChannel,
  isDeletedEventPayload,
  MAINTAINER_CHANNEL_PREFIX,
  type MessageEventPayload,
  pickMessageScope,
  type QuickActionExecutedEventPayload,
  type TimelineRecordEventPayload,
} from "@ergou/protocol";
import type { EventStore } from "../events/event-store.ts";

/** 一页最多取多少条 */
export const MAX_HISTORY_LIMIT = 200;

/** 是不是一个会话频道（秘书会话、某个维护者的会话） */
export function isConversationChannel(channel: string): channel is ConversationId {
  return isChannel(channel) && (channel === CHANNELS.secretary || channel.startsWith(MAINTAINER_CHANNEL_PREFIX));
}

/**
 * 前端第一次订阅（游标为 0）时从哪个序号之后补发：会话频道从最近一页的第一条消息起，其他频道从头。
 * 返回的是"之后"的序号，和订阅游标同义。
 */
export function firstReplayAfter(store: EventStore, channel: string): number {
  if (!isConversationChannel(channel)) return 0;
  const recent = store.readBefore(channel, Number.MAX_SAFE_INTEGER, HISTORY_PAGE_SIZE, EVENT_TYPES.message);
  if (recent.length < HISTORY_PAGE_SIZE) return 0;
  return recent[0]!.seq - 1;
}

/** 时间线记录的事件类型：历史分页里跟着消息一起带回 */
const RECORD_TYPES: readonly string[] = [EVENT_TYPES.timelineRecord, EVENT_TYPES.quickActionExecuted];

/**
 * 一页历史：序号小于 before（不给就是最新）的最近 limit 条消息，按序号从早到晚；被彻底删除的只有"已删除"标记。
 * 连同落在这一页里的时间线记录（序号从这一页第一条消息起、小于 before；更早没有了的从头起）
 */
export function historyPage(store: EventStore, conversation: ConversationId, options: { before?: number; limit?: number }): HistoryPage {
  const limit = Math.min(options.limit ?? HISTORY_PAGE_SIZE, MAX_HISTORY_LIMIT);
  const before = options.before ?? Number.MAX_SAFE_INTEGER;
  const events = store.readBefore(conversation, before, limit + 1, EVENT_TYPES.message);
  const hasMore = events.length > limit;
  const page = hasMore ? events.slice(1) : events;
  // 这一页覆盖的序号：更早还有的，从这一页第一条消息起；没有了的从头起
  const from = hasMore ? page[0]!.seq : 1;
  return {
    conversation,
    messages: page.map((event): HistoryMessage => {
      if (isDeletedEventPayload(event.payload)) return { seq: event.seq, deleted: event.payload };
      const payload = event.payload as MessageEventPayload;
      return { seq: event.seq, message: payload.message, ...(payload.idempotencyKey === undefined ? {} : { idempotencyKey: payload.idempotencyKey }), ...pickMessageScope(payload) };
    }),
    // 记录很稀：按类型取 before 之前的，留下落在这一页里的
    records: RECORD_TYPES.flatMap((type) => store.readBefore(conversation, before, Number.MAX_SAFE_INTEGER, type))
      .filter((event) => event.seq >= from)
      .toSorted((a, b) => a.seq - b.seq)
      .map((event): HistoryRecord =>
        event.type === EVENT_TYPES.timelineRecord
          ? { seq: event.seq, type: EVENT_TYPES.timelineRecord, payload: event.payload as TimelineRecordEventPayload }
          : { seq: event.seq, type: EVENT_TYPES.quickActionExecuted, payload: event.payload as QuickActionExecutedEventPayload },
      ),
    hasMore,
  };
}
