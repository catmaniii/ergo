// 回复中发的消息排队（144 号票，规格第 4 节"同一个 agent 的输入串行排队"、第 11 节）：二狗（秘书、项目维护者、任务维护者）正在回复
// 这一轮时用户又发的话不进会话、不插进这一轮，先排进这个会话的队列；这一轮做完（或者用户点了停止）一起交给 agent 作为下一轮的输入。
// - 队列存在事件日志里，属于会话：会话频道上的 message_queue 事件带着整队的最新样子和这次的变化（排进来、拿掉、改顺序、交出去），
//   派生视图 message_queues 记每个会话最新的那一份。换设备、刷新页面、守护进程重启后都还在，几台设备看到的一样。
// - 排进来：发消息（messages.ts 的 postUserMessage）时这个会话有交给 agent、还没有结局的输入（agent_inputs 里 started 的）就排队。
//   附件照发消息的规矩核对，语音照常收下、马上开始识别（语音对象记的消息 id 就是交出去时那条消息的 id）。
// - 拿掉、改顺序：用户在聊天区叉掉一条、长按拖动（网关的 queued_message_action）。已经交出去的叉不掉；新的顺序里没提到的按原来的先后排在后面。
// - 交出去：agent 的会话（agent-session.ts）在这一轮结束时调 deliver：整队按先后追加成普通的用户消息（消息 id、时间、正文照排队时的，
//   带上同一个 queueDelivery），和"交出去"的那条 message_queue 事件同一事务（消息在前）。归属按交出去那一刻重新认（项目维护者的会话分段
//   可能已经换了；认不出来就用排进来时的），要先开对话段的照发消息时一样先追加。同一批的几条 agent 作为一轮的输入一起处理。
//   180 号票：排队时就识别完、只识别出模型自带串词的语音消息（消息里只有这段语音）照常交出去成为会话里的消息，但带 dropInput，
//   不进 agent 的输入队列（等同于没发）。208 号票起识别失败的（自动重试完了还不行、静音之类）都这样；还在识别、等着重试的照常交，
//   在输入队列里等它有结局（210 号票起等着自动重试的不挡同一批、之后的输入，见 agent-session.ts）。
import {
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  isDeletedEventPayload,
  MAINTAINER_CHANNEL_PREFIX,
  type MessageEventPayload,
  type MessageQueueEventPayload,
  type MessageScope,
  pickMessageScope,
  type QueueChange,
  type QueuedMessage,
  type SendMessageResult,
  t,
} from "@ergo/protocol";
import type { DerivedView, EventStore, NewEvent, StoredEvent } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { failedVoiceOnlyMessage } from "../voice-records/views.ts";

export const messageQueueView: DerivedView = {
  name: "message_queues",
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_queues (
        conversation TEXT PRIMARY KEY,
        queue TEXT NOT NULL,
        seq INTEGER NOT NULL
      );
    `),
  clear: (db) => db.exec("DELETE FROM message_queues"),
  apply(db, event) {
    if (event.type !== EVENT_TYPES.messageQueue || isDeletedEventPayload(event.payload)) return;
    const { queue } = event.payload as MessageQueueEventPayload;
    db.run(
      "INSERT INTO message_queues (conversation, queue, seq) VALUES (?, ?, ?) ON CONFLICT(conversation) DO UPDATE SET queue = excluded.queue, seq = excluded.seq",
      event.channel,
      JSON.stringify(queue),
      event.seq,
    );
  },
};

/** 这个会话现在排队的消息，先交的在前 */
export function queuedMessages(db: ReadonlyDatabase, conversation: ConversationId): QueuedMessage[] {
  const row = db.get<{ queue: string }>("SELECT queue FROM message_queues WHERE conversation = ?", conversation);
  return row ? (JSON.parse(row.queue) as QueuedMessage[]) : [];
}

/**
 * 队列不空时最新那条 message_queue 事件在会话频道上的序号（前端第一次订阅时从这之前补发，免得队列落在补发的那一页之外）；
 * 队列是空的时 undefined
 */
export function queueEventSeq(db: ReadonlyDatabase, conversation: ConversationId): number | undefined {
  const row = db.get<{ queue: string; seq: number }>("SELECT queue, seq FROM message_queues WHERE conversation = ?", conversation);
  return row && row.queue !== "[]" ? Number(row.seq) : undefined;
}

/** 这条消息还排在队里（语音识别据此知道还要不要写识别结果） */
export function isQueued(db: ReadonlyDatabase, conversation: ConversationId, messageId: string): boolean {
  return queuedMessages(db, conversation).some((q) => q.message.id === messageId);
}

/**
 * 一条 message_queue 事件。用户请求引起的带上请求的幂等键（事件的幂等键由它推出，重发不再变一次；排进来的就用发消息请求的，
 * 和别的发消息结果一样能按它找回来）
 */
function queueEvent(conversation: ConversationId, change: QueueChange, messageIds: readonly string[], queue: readonly QueuedMessage[], requestKey?: string): NewEvent {
  const payload: MessageQueueEventPayload = { change, messageIds: [...messageIds], queue: [...queue], ...(requestKey === undefined ? {} : { requestKey }) };
  const idempotencyKey = requestKey === undefined ? undefined : change === "queued" ? requestKey : `${change}:${requestKey}`;
  return { channel: conversation, type: EVENT_TYPES.messageQueue, payload, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) };
}

/** 发消息的结果：排进队的那条（同一幂等键重发也是它） */
export function queuedResult(event: StoredEvent): SendMessageResult | undefined {
  if (event.type !== EVENT_TYPES.messageQueue || isDeletedEventPayload(event.payload)) return undefined;
  const p = event.payload as MessageQueueEventPayload;
  const messageId = p.change === "queued" ? p.messageIds[0] : undefined;
  return messageId === undefined ? undefined : { messageId, seq: event.seq, queued: true };
}

/**
 * 排进来：一条已经核对好的用户消息（连同和它同一事务的语音对象），幂等键用发消息请求的。返回发消息的结果
 */
export function enqueueMessage(store: EventStore, item: QueuedMessage, extra: readonly NewEvent[]): SendMessageResult {
  const conversation = item.message.conversation;
  const queue = [...queuedMessages(store.reader, conversation), item];
  const [result] = store.appendBatch([queueEvent(conversation, "queued", [item.message.id], queue, item.idempotencyKey), ...extra]);
  const queued = queuedResult(result!.event);
  if (!queued) throw new Error(t("conversation.queue.keyReused", { key: item.idempotencyKey }));
  return queued;
}

/** 叉掉一条：还在队里才拿掉（已经交出去了的不变）。同一个幂等键重发不再拿一次 */
export function removeQueued(store: EventStore, conversation: ConversationId, messageId: string, requestKey: string): { changed: boolean; queue: QueuedMessage[] } {
  const queue = queuedMessages(store.reader, conversation);
  if (!queue.some((q) => q.message.id === messageId)) return { changed: false, queue };
  const next = queue.filter((q) => q.message.id !== messageId);
  const [result] = store.appendBatch([queueEvent(conversation, "removed", [messageId], next, requestKey)]);
  return { changed: !result!.duplicate, queue: queuedMessages(store.reader, conversation) };
}

/** 改顺序：按给的先后排，给的里面没提到的（刚排进来的）按原来的先后排在后面，不在队里的不管。顺序没变就不记 */
export function reorderQueued(store: EventStore, conversation: ConversationId, messageIds: readonly string[], requestKey: string): { changed: boolean; queue: QueuedMessage[] } {
  const queue = queuedMessages(store.reader, conversation);
  const byId = new Map(queue.map((q) => [q.message.id, q]));
  const named = [...new Set(messageIds)].flatMap((id) => byId.get(id) ?? []);
  const next = [...named, ...queue.filter((q) => !named.includes(q))];
  if (next.every((q, i) => q === queue[i])) return { changed: false, queue };
  const [result] = store.appendBatch([queueEvent(conversation, "reordered", next.map((q) => q.message.id), next, requestKey)]);
  return { changed: !result!.duplicate, queue: queuedMessages(store.reader, conversation) };
}

/** 交出去时重新认归属、开对话段要的（和网关发消息时一样，daemon.ts 接上） */
export interface QueueDeliveryHooks {
  /** 维护者会话里的消息此刻属于哪个任务、项目（taskId 是在哪个任务的详情里说的）；认不出来、不让发了时用排进来时的 */
  scopeOf?(conversation: ConversationId, taskId?: string): MessageScope | undefined;
  /** 用户的话之前同一事务先追加的事件（16 号票：项目维护者手上没有在进行的段时开一个对话段） */
  preludeOf?(conversation: ConversationId, idempotencyKey: string, taskId?: string): NewEvent[];
  log?(line: string): void;
}

/** agent 的会话在这一轮结束时调：把这个会话排队的消息一起交出去 */
export interface QueueDelivery {
  /** 交出去了哪几条（队列是空的时什么都不做，是空的） */
  deliver(conversation: ConversationId): string[];
}

export function createQueueDelivery(store: EventStore, hooks: QueueDeliveryHooks = {}): QueueDelivery {
  const scopeAt = (conversation: ConversationId, item: QueuedMessage): MessageScope => {
    if (conversation === CHANNELS.secretary) return {};
    try {
      const scope = hooks.scopeOf?.(conversation, item.inTask) ?? pickMessageScope(item);
      if (item.interviewId === undefined) return scope;
      // 284 号票：排进来时访谈开着（用户是在访谈里说的）：照排进来时的算访谈里的话、答的是那时管理员问的那一句（交出去时访谈可能已经收尾、
      // 管理员可能又说了一段；语音对象排进来时就带上了）
      const { interviewId: _now, interviewQuestion: _asked, ...rest } = scope;
      return { ...rest, interviewId: item.interviewId, ...(item.interviewQuestion === undefined ? {} : { interviewQuestion: item.interviewQuestion }) };
    } catch (err) {
      // 不让发了（项目归档、任务结束）：用户是在能发的时候说的，照排进来时的归属交出去
      hooks.log?.(`排队的消息交出去时认不出归属，用排进来时的：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log
      return pickMessageScope(item);
    }
  };
  const preludeAt = (conversation: ConversationId, item: QueuedMessage): NewEvent[] => {
    if (!conversation.startsWith(MAINTAINER_CHANNEL_PREFIX)) return [];
    try {
      return hooks.preludeOf?.(conversation, item.idempotencyKey, item.inTask) ?? [];
    } catch (err) {
      hooks.log?.(`排队的消息交出去时没能先开对话段：${err instanceof Error ? err.message : String(err)}`); // @i18n-ignore log
      return [];
    }
  };
  return {
    deliver(conversation) {
      const queue = queuedMessages(store.reader, conversation);
      if (queue.length === 0) return [];
      const delivery = `qd-${queue[0]!.message.id}`;
      const events: NewEvent[] = [];
      for (const item of queue) {
        // 要先开的对话段：一批里只开一次（开了之后后面的就有段了）
        if (events.length === 0) events.push(...preludeAt(conversation, item));
        const payload: MessageEventPayload = {
          message: item.message,
          idempotencyKey: item.idempotencyKey,
          ...scopeAt(conversation, item),
          ...(item.sentFrom ? { sentFrom: item.sentFrom } : {}),
          queueDelivery: delivery,
          ...(failedVoiceOnlyMessage(store.reader, item.message) ? { dropInput: true as const } : {}),
        };
        // 事件的幂等键由发消息请求的推出（同一条不会交两次）；负载里的是请求本身的（界面靠它原地换掉排队的气泡）
        events.push({ channel: conversation, type: EVENT_TYPES.message, payload, idempotencyKey: `queue-delivery:${item.idempotencyKey}` });
      }
      const ids = queue.map((q) => q.message.id);
      events.push(queueEvent(conversation, "delivered", ids, []));
      store.appendBatch(events);
      return ids;
    },
  };
}
