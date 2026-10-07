// 往会话里追加消息：用户发来的消息、agent 定稿的回复、系统说明。消息 id 由守护进程生成。
// 用户消息事件的负载里有会话、发言方、时间和原文（08 号票据此采集"用户发言"素材），带着发送请求的幂等键。
import { randomUUID } from "node:crypto";
import {
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  nowIso,
  type SendMessageResult,
} from "@ergou/protocol";
import { RequestRejected } from "../errors.ts";
import type { EventStore } from "../events/event-store.ts";

export function newMessageId(): string {
  return `m-${randomUUID()}`;
}

/**
 * 用户往会话里发一条消息。同一个幂等键重发拿到第一次的结果，不多出消息（也就不会多一次回复：
 * agent 的输入队列就是这些消息事件）。
 * 本票只有秘书会话和文本 part；维护者会话（13、16）和图片、文件（09）由后面的票放开。
 */
export function postUserMessage(
  store: EventStore,
  request: { conversation: ConversationId; parts: readonly MessagePart[]; idempotencyKey: string },
): SendMessageResult {
  if (request.conversation !== CHANNELS.secretary) {
    throw new RequestRejected("not_implemented", `这个版本只能和秘书聊天，还不能往 ${request.conversation} 发消息`);
  }
  const parts: MessagePart[] = [];
  for (const part of request.parts) {
    if (part.type !== "text") throw new RequestRejected("not_implemented", `这个版本还不能发 ${part.type}`);
    // 只取认识的字段，前端多带的东西不进事件日志
    parts.push({ type: "text", text: part.text });
  }
  if (!parts.some((p) => p.type === "text" && p.text.trim().length > 0)) throw new RequestRejected("bad_params", "消息是空的");

  const message: MessageEnvelope = { id: newMessageId(), conversation: request.conversation, speaker: "user", time: nowIso(), parts };
  const payload: MessageEventPayload = { message, idempotencyKey: request.idempotencyKey };
  const { event } = store.append({ channel: request.conversation, type: EVENT_TYPES.message, payload, idempotencyKey: request.idempotencyKey });
  const stored = (event.payload as Partial<MessageEventPayload>).message;
  if (event.type !== EVENT_TYPES.message || !stored) throw new RequestRejected("bad_params", "这个幂等键已经用在别的请求上了");
  return { messageId: stored.id, seq: event.seq };
}

/** agent 或系统往会话里追加一条定稿的消息（时间取现在） */
export function appendMessage(store: EventStore, message: Omit<MessageEnvelope, "id" | "time"> & { id?: string }): MessageEnvelope {
  const full: MessageEnvelope = { ...message, id: message.id ?? newMessageId(), time: nowIso() };
  const payload: MessageEventPayload = { message: full };
  store.append({ channel: full.conversation, type: EVENT_TYPES.message, payload });
  return full;
}
