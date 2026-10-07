// 往会话里追加消息：用户发来的消息、agent 定稿的回复、系统说明。消息 id 由守护进程生成。
// 用户消息事件的负载里有会话、发言方、时间和原文（08 号票据此采集"用户发言"素材），带着发送请求的幂等键。
import { randomUUID } from "node:crypto";
import {
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  imagePartFrom,
  isMediaId,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  nowIso,
  type SendMessageResult,
} from "@ergou/protocol";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { mimeFromName } from "../media/file-types.ts";
import { sanitizeName } from "../media/media-store.ts";

export function newMessageId(): string {
  return `m-${randomUUID()}`;
}

/** 发消息时核对附件用：媒体库里有没有这份媒体、是不是图片（MediaStore 满足它） */
export interface AttachmentLookup {
  info(mediaId: string): { size: number; image: { mime: string; width: number | undefined; height: number | undefined } | undefined } | undefined;
}

/**
 * 用户往会话里发一条消息。同一个幂等键重发拿到第一次的结果，不多出消息（也就不会多一次回复：
 * agent 的输入队列就是这些消息事件）。
 * 现在只有秘书会话；维护者会话（13、16）由后面的票放开。part 可以是文本、图片、文件（09）：
 * 附件先经 HTTP 上传入库，消息里引用入库版本的哈希（媒体 id）。图片的类型和尺寸、文件的大小以服务端入库的为准，
 * 前端带来的不作数；文件的类型按扩展名认得的优先（浏览器常把 .md 报成空、把 .ts 报成视频）。
 */
export function postUserMessage(
  store: EventStore,
  request: { conversation: ConversationId; parts: readonly MessagePart[]; idempotencyKey: string },
  attachments: AttachmentLookup,
): SendMessageResult {
  if (request.conversation !== CHANNELS.secretary) {
    throw new RequestRejected("not_implemented", `这个版本只能和秘书聊天，还不能往 ${request.conversation} 发消息`);
  }
  const parts: MessagePart[] = [];
  for (const part of request.parts) {
    // 只取认识的字段，前端多带的东西不进事件日志
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text });
        break;
      case "image": {
        const name = sanitizeName(part.name);
        const image = existing(attachments, part.mediaId, name).image;
        if (!image) throw new RequestRejected("bad_params", `「${name}」不是图片（只认 JPEG、PNG、GIF、WebP），请作为文件发送`);
        parts.push(imagePartFrom({ mediaId: part.mediaId, name, mime: image.mime, width: image.width, height: image.height }));
        break;
      }
      case "file": {
        const name = sanitizeName(part.name);
        const { size } = existing(attachments, part.mediaId, name);
        const mime = mimeFromName(name) ?? (part.mime.trim() || "application/octet-stream");
        // "作为材料投喂"归 21 号票：这一版不记 asMaterial 标记
        parts.push({ type: "file", mediaId: part.mediaId, name, mime, size });
        break;
      }
      default:
        throw new RequestRejected("not_implemented", `这个版本还不能发 ${part.type}`);
    }
  }
  const hasText = parts.some((p) => p.type === "text" && p.text.trim().length > 0);
  if (!hasText && !parts.some((p) => p.type === "image" || p.type === "file")) throw new RequestRejected("bad_params", "消息是空的");

  const message: MessageEnvelope = { id: newMessageId(), conversation: request.conversation, speaker: "user", time: nowIso(), parts };
  const payload: MessageEventPayload = { message, idempotencyKey: request.idempotencyKey };
  const { event } = store.append({ channel: request.conversation, type: EVENT_TYPES.message, payload, idempotencyKey: request.idempotencyKey });
  const stored = (event.payload as Partial<MessageEventPayload>).message;
  if (event.type !== EVENT_TYPES.message || !stored) throw new RequestRejected("bad_params", "这个幂等键已经用在别的请求上了");
  return { messageId: stored.id, seq: event.seq };
}

function existing(attachments: AttachmentLookup, mediaId: string, name: string) {
  const info = isMediaId(mediaId) ? attachments.info(mediaId) : undefined;
  if (!info) throw new RequestRejected("bad_params", `附件「${name}」不存在：媒体 ${mediaId} 没有入库（先上传、收尾，再发消息）`);
  return info;
}

export interface AppendMessageOptions {
  /**
   * 运行时给 agent 的通知：系统消息同时排进 agent 的输入队列（"某某已获批准，可以重试"这类）。
   * 只用于发言方是 system 的消息
   */
  agentInput?: boolean;
  /** 同一件事只追加一次（比如同一个审批的"可以重试"） */
  idempotencyKey?: string;
}

/** agent 或系统的一条定稿消息和它的事件（不追加）：调用方和别的事件一起放进 appendBatch */
export function buildMessage(
  message: Omit<MessageEnvelope, "id" | "time"> & { id?: string },
  options: AppendMessageOptions = {},
): { message: MessageEnvelope; event: NewEvent } {
  const full: MessageEnvelope = { ...message, id: message.id ?? newMessageId(), time: nowIso() };
  const payload: MessageEventPayload = { message: full, ...(options.agentInput ? { agentInput: true } : {}) };
  const event: NewEvent = { channel: full.conversation, type: EVENT_TYPES.message, payload, ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }) };
  return { message: full, event };
}

/** agent 或系统往会话里追加一条定稿的消息（时间取现在） */
export function appendMessage(store: EventStore, message: Omit<MessageEnvelope, "id" | "time"> & { id?: string }, options: AppendMessageOptions = {}): MessageEnvelope {
  const built = buildMessage(message, options);
  const { event } = store.append(built.event);
  return (event.payload as MessageEventPayload).message;
}
