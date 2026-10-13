// 已读位置（109 号票，规格第 19 节"秘书来了新消息"）：用户在会话里看到哪一条了。现在只有秘书会话用——秘书页上滚到了那条消息、
// 或者停在最底部，前端报 mark_read，这里记成已读位置频道上的一条 read_mark 事件；开着的几个前端（手机、平板、电脑）都收到，
// 一台上看过，别的设备上"秘书"页签的红点、顶上的提醒也跟着消失。
// - 只往后挪：比记着的还靠前的（另一台设备晚到的、往回翻的）不记，回记着的位置；比会话的最后一条还靠后的按最后一条记；
// - 同一个幂等键重发拿到同一个结果（事件存储按幂等键去重）；
// - 启动时还没有秘书会话的记录（新装的、刚升级上来的）：记一条，位置是秘书会话那时的最后一条——升级之前的历史消息当作都看过，
//   不对它们亮红点；新装的是 0。之后每个前端打开时都能从这个频道读到秘书会话的已读位置。
import { CHANNELS, type ConversationId, EVENT_TYPES, type MarkReadParams, type MarkReadResult, type ReadMarkEventPayload } from "@ergou/protocol";
import type { EventStore } from "../events/event-store.ts";

export interface ReadMarks {
  /** 读入记着的位置；秘书会话还没有记录时记一条（当作全部看过） */
  start(): void;
  /** 记下会话看到哪一条了（只往后挪），回记完之后的位置 */
  markRead(params: MarkReadParams, idempotencyKey: string): MarkReadResult;
}

export interface ReadMarksOptions {
  store: EventStore;
  now: () => string;
}

export function createReadMarks(options: ReadMarksOptions): ReadMarks {
  const { store, now } = options;
  /** 每个会话记着的位置（这个频道只有这里写） */
  const marks = new Map<ConversationId, number>();
  const load = () => {
    marks.clear();
    for (const e of store.read(CHANNELS.readMarks, 0, EVENT_TYPES.readMark)) {
      const { conversation, seq } = e.payload as ReadMarkEventPayload;
      marks.set(conversation, Math.max(marks.get(conversation) ?? 0, seq));
    }
  };
  const append = (payload: ReadMarkEventPayload, idempotencyKey?: string) => {
    store.append({ channel: CHANNELS.readMarks, type: EVENT_TYPES.readMark, payload, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
    marks.set(payload.conversation, Math.max(marks.get(payload.conversation) ?? 0, payload.seq));
  };

  return {
    start() {
      load();
      if (!marks.has(CHANNELS.secretary)) append({ conversation: CHANNELS.secretary, seq: store.lastSeq(CHANNELS.secretary), time: now() });
    },
    markRead({ conversation, seq }, idempotencyKey) {
      // 同一个幂等键重发：回第一次记下的
      const done = store.eventByIdempotencyKey(idempotencyKey);
      if (done) {
        const first = done.payload as ReadMarkEventPayload;
        return { conversation: first.conversation, seq: first.seq };
      }
      if (marks.size === 0) load();
      const at = Math.min(seq, store.lastSeq(conversation));
      const current = marks.get(conversation);
      if (current !== undefined && at <= current) return { conversation, seq: current };
      append({ conversation, seq: at, time: now() }, idempotencyKey);
      return { conversation, seq: at };
    },
  };
}
