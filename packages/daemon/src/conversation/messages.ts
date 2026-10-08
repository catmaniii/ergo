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
import { getCard } from "../cards/views.ts";
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
 * 秘书会话之外的会话由 scopeOf 认（15 号票起是项目维护者的会话：消息带上所属的项目，已归档的只读；13 号票起是任务维护者的会话：
 * 消息带上所属的任务，已结束的任务不再收）。part 可以是文本、图片、文件（09），以及引用的卡片（21：
 * 用户引用一张卡说话，快速动作据此判定"用户明确点了"；卡片要存在）：
 * 附件先经 HTTP 上传入库，消息里引用入库版本的哈希（媒体 id）。图片的类型和尺寸、文件的大小以服务端入库的为准，
 * 前端带来的不作数；文件的类型按扩展名认得的优先（浏览器常把 .md 报成空、把 .ts 报成视频）。
 * 经附件菜单"作为材料投喂"发的附件带 asMaterial（21），原样记下：素材模块据此把这条消息记成"用户主动投喂的材料"。
 */
export function postUserMessage(
  store: EventStore,
  request: { conversation: ConversationId; parts: readonly MessagePart[]; idempotencyKey: string },
  attachments: AttachmentLookup,
  scopeOf?: (conversation: ConversationId) => MessageScope | undefined,
): SendMessageResult {
  // 秘书会话之外：认得的会话（15 号票起是项目维护者的会话）给出消息所属的任务、项目（不让发的在这里就抛出原因）
  const scope = request.conversation === CHANNELS.secretary ? {} : scopeOf?.(request.conversation);
  if (!scope) throw new RequestRejected("not_implemented", `这个版本还不能往 ${request.conversation} 发消息`);
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
        parts.push({ ...imagePartFrom({ mediaId: part.mediaId, name, mime: image.mime, width: image.width, height: image.height }), ...fed(part) });
        break;
      }
      case "file": {
        const name = sanitizeName(part.name);
        const { size } = existing(attachments, part.mediaId, name);
        const mime = mimeFromName(name) ?? (part.mime.trim() || "application/octet-stream");
        parts.push({ type: "file", mediaId: part.mediaId, name, mime, size, ...fed(part) });
        break;
      }
      case "card_ref":
        if (!getCard(store.reader, part.cardId)) throw new RequestRejected("bad_params", `引用的卡片不存在：${part.cardId}`);
        parts.push({ type: "card_ref", cardId: part.cardId });
        break;
      default:
        throw new RequestRejected("not_implemented", `这个版本还不能发 ${part.type}`);
    }
  }
  const hasText = parts.some((p) => p.type === "text" && p.text.trim().length > 0);
  if (!hasText && !parts.some((p) => p.type === "image" || p.type === "file")) throw new RequestRejected("bad_params", "消息是空的");

  const message: MessageEnvelope = { id: newMessageId(), conversation: request.conversation, speaker: "user", time: nowIso(), parts };
  const payload: MessageEventPayload = {
    message,
    idempotencyKey: request.idempotencyKey,
    ...scopeFields(scope),
  };
  const { event } = store.append({ channel: request.conversation, type: EVENT_TYPES.message, payload, idempotencyKey: request.idempotencyKey });
  const stored = (event.payload as Partial<MessageEventPayload>).message;
  if (event.type !== EVENT_TYPES.message || !stored) throw new RequestRejected("bad_params", "这个幂等键已经用在别的请求上了");
  return { messageId: stored.id, seq: event.seq };
}

/** "作为材料投喂"的标记：带了才记 */
function fed(part: { asMaterial?: boolean | undefined }): { asMaterial?: true } {
  return part.asMaterial === true ? { asMaterial: true } : {};
}

function existing(attachments: AttachmentLookup, mediaId: string, name: string) {
  const info = isMediaId(mediaId) ? attachments.info(mediaId) : undefined;
  if (!info) throw new RequestRejected("bad_params", `附件「${name}」不存在：媒体 ${mediaId} 没有入库（先上传、收尾，再发消息）`);
  return info;
}

/**
 * 维护者会话里的消息所属的任务、项目（素材的"任务或项目"取自这里，12 号票起），以及定时作业的一次运行（24 号票：
 * 维护者处理它时的用量记在作业名下，19 号票交给维护者执行作业时带上）
 */
export interface MessageScope {
  taskId?: string;
  projectId?: string;
  scheduledJobId?: string;
}

/** 消息事件里写的归属：有哪项写哪项 */
export function scopeFields(scope: MessageScope): MessageScope {
  return {
    ...(scope.taskId === undefined ? {} : { taskId: scope.taskId }),
    ...(scope.projectId === undefined ? {} : { projectId: scope.projectId }),
    ...(scope.scheduledJobId === undefined ? {} : { scheduledJobId: scope.scheduledJobId }),
  };
}

export interface AppendMessageOptions extends MessageScope {
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
  const payload: MessageEventPayload = {
    message: full,
    ...(options.agentInput ? { agentInput: true } : {}),
    ...scopeFields(options),
  };
  const event: NewEvent = { channel: full.conversation, type: EVENT_TYPES.message, payload, ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }) };
  return { message: full, event };
}

/** agent 或系统往会话里追加一条定稿的消息（时间取现在） */
export function appendMessage(store: EventStore, message: Omit<MessageEnvelope, "id" | "time"> & { id?: string }, options: AppendMessageOptions = {}): MessageEnvelope {
  const built = buildMessage(message, options);
  const { event } = store.append(built.event);
  return (event.payload as MessageEventPayload).message;
}

/**
 * 交给 agent 时，运行时的通知（agentInput 的系统消息）前面加的标记，免得模型当成用户说的。
 * 秘书的系统提示里也照这个写法告诉它
 */
export const SYSTEM_NOTICE_TAG = "[系统通知]";

/**
 * 往会话里追加一条交给 agent 的通知（系统消息，排进它的输入队列），比如"某某已获批准，可以重试""已被用户拒绝"
 * "交给我做的事用户已完成"。同一件事按 key 只追加一次
 */
export function appendAgentNotice(store: EventStore, conversation: ConversationId, text: string, key: string, scope: MessageScope = {}): void {
  store.append(buildAgentNotice(conversation, text, key, scope).event);
}

/** 交给 agent 的通知和它的事件（不追加）：和别的事件一起放进 appendBatch。维护者会话里的带上所属的任务 */
export function buildAgentNotice(conversation: ConversationId, text: string, key: string, scope: MessageScope = {}): { message: MessageEnvelope; event: NewEvent } {
  return buildMessage({ conversation, speaker: "system", parts: [{ type: "text", text }] }, { agentInput: true, idempotencyKey: key, ...scope });
}
