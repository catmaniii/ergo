// 往会话里追加消息：用户发来的消息、agent 定稿的回复、系统说明。消息 id 由守护进程生成。
// 用户消息事件的负载里有会话、发言方、时间和原文（08 号票据此采集"用户发言"素材），带着发送请求的幂等键。
import { randomUUID } from "node:crypto";
import {
  type BrowsingContext,
  browsingMarkOf,
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  firstSentence,
  imagePartFrom,
  isMediaId,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  type MessageScope,
  nowIso,
  pickMessageScope,
  type SendMessageResult,
  type SentFrom,
  type TimelineRecord,
  type TimelineRecordEventPayload,
  type TimelineRecordKind,
  t,
} from "@ergo/protocol";
import { getCard } from "../cards/views.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { mimeFromName } from "../media/file-types.ts";
import { sanitizeName } from "../media/media-store.ts";
import { enqueueMessage, queuedResult } from "./message-queue.ts";
import { replying } from "./views.ts";

export function newMessageId(): string {
  return `m-${randomUUID()}`;
}

/** 发消息时核对附件用：媒体库里有没有这份媒体、是不是图片（MediaStore 满足它） */
export interface AttachmentLookup {
  info(mediaId: string): { size: number; image: { mime: string; width: number | undefined; height: number | undefined } | undefined } | undefined;
}

type VoicePartValue = Extract<MessagePart, { type: "voice" }>;

/**
 * 发消息时收下语音 part（31 号票，语音模块实现）：核对录音（在媒体库里、是认得的音频、时长合理），
 * 给出存进消息的 part（带上语音对象的 id）和同一事务里建出语音对象的事件。不收就抛 RequestRejected
 */
export interface VoiceIntake {
  accept(
    part: VoicePartValue,
    message: { id: string; conversation: ConversationId; time: string; scope: MessageScope; idempotencyKey: string },
  ): { part: VoicePartValue; events: NewEvent[] };
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
 * 语音（31）由语音模块收下（voices）：核对录音、建出语音对象（和消息同一事务），识别在后台做；语音消息里只有这一段语音，
 * 可以带引用的卡片和附件（2026-10-10 用户改：附件不再单独自动发，等下一条消息带走，所以说完的语音连同等着的附件是一条消息），
 * 不能和打的字、别的语音一起发。
 * 144 号票：这个会话的 agent 正在回复（有交给它、还没有结局的输入）时，这句话不进会话，排进这个会话的队列（message-queue.ts），
 * 这一轮做完再一起交给它；核对附件、收下语音照旧在这里做（识别马上开始），归属、要先开的对话段到交出去时再认。
 */
export function postUserMessage(
  store: EventStore,
  request: { conversation: ConversationId; parts: readonly MessagePart[]; idempotencyKey: string; sentFrom?: SentFrom; taskId?: string | undefined; browsing?: BrowsingContext | undefined },
  attachments: AttachmentLookup,
  scopeOf?: (conversation: ConversationId) => MessageScope | undefined,
  voices?: VoiceIntake,
  preludeOf?: (conversation: ConversationId) => NewEvent[],
): SendMessageResult {
  // 同一个幂等键重发：拿到第一次的结果（发出去的消息，或者排进队的那条）
  const done = store.eventByIdempotencyKey(request.idempotencyKey);
  if (done) {
    const stored = done.type === EVENT_TYPES.message ? (done.payload as Partial<MessageEventPayload>).message : undefined;
    const result = stored ? { messageId: stored.id, seq: done.seq } : queuedResult(done);
    if (!result) throw new RequestRejected("bad_params", t("conversation.messages.keyReused"));
    return result;
  }
  // 秘书会话之外：认得的会话（15 号票起是项目维护者的会话）给出消息所属的任务、项目（不让发的在这里就抛出原因）
  const scope = request.conversation === CHANNELS.secretary ? {} : scopeOf?.(request.conversation);
  if (!scope) throw new RequestRejected("not_implemented", t("conversation.messages.cannotSendTo", { conversation: request.conversation }));
  const id = newMessageId();
  // 用户说这句话的时间取守护进程的时钟（和事件时间同一个钟）：素材、记忆的证据都按它记"什么时候说的"
  const time = store.now();
  const parts: MessagePart[] = [];
  /** 和消息同一事务追加的事件（语音消息建出的语音对象） */
  const extra: NewEvent[] = [];
  for (const part of request.parts) {
    // 只取认识的字段，前端多带的东西不进事件日志
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text });
        break;
      case "image": {
        const name = sanitizeName(part.name);
        const image = existing(attachments, part.mediaId, name).image;
        if (!image) throw new RequestRejected("bad_params", t("conversation.messages.notImage", { name }));
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
        if (!getCard(store.reader, part.cardId)) throw new RequestRejected("bad_params", t("conversation.messages.noCard", { id: part.cardId }));
        parts.push({ type: "card_ref", cardId: part.cardId });
        break;
      case "voice": {
        // 语音消息（31 号票）：整段录音先上传入库，消息里只有这一段语音（可以带用户引用的卡片："引用这张卡，说'把这个取消'"；
        // 2026-10-10 起也可以带附件："发一张图，说'帮我看看这个'"）；服务端建出语音对象，识别在后台做。
        // 交给 agent 时语音换成识别出的文字，和附件的投影在同一条输入里（conversation/agent-input.ts）
        if (!voices) throw new RequestRejected("not_implemented", t("conversation.messages.noVoice"));
        if (request.parts.some((p) => p !== part && p.type !== "card_ref" && p.type !== "image" && p.type !== "file")) {
          throw new RequestRejected("bad_params", t("conversation.messages.voiceAlone"));
        }
        const accepted = voices.accept(part, { id, conversation: request.conversation, time, scope, idempotencyKey: request.idempotencyKey });
        parts.push(accepted.part);
        extra.push(...accepted.events);
        break;
      }
      default:
        throw new RequestRejected("not_implemented", t("conversation.messages.cannotSendPart", { type: part.type }));
    }
  }
  const hasText = parts.some((p) => p.type === "text" && p.text.trim().length > 0);
  if (!hasText && !parts.some((p) => p.type === "image" || p.type === "file" || p.type === "voice")) throw new RequestRejected("bad_params", t("conversation.messages.empty"));

  // 浏览侧边栏里发的（147 号票）：只认秘书会话，记下当时的网页、选中的框、哪个浏览器
  if (request.browsing && request.conversation !== CHANNELS.secretary) throw new RequestRejected("bad_params", t("conversation.messages.browsingSecretaryOnly"));
  const message: MessageEnvelope = { id, conversation: request.conversation, speaker: "user", time, parts, ...(request.browsing ? { browsing: browsingMarkOf(request.browsing) } : {}) };
  // 正在回复（144 号票）：排队，这一轮做完一起交出去（语音对象和排进来的那条同一事务）
  if (replying(store.reader, request.conversation)) {
    return enqueueMessage(
      store,
      {
        message,
        idempotencyKey: request.idempotencyKey,
        ...pickMessageScope(scope),
        ...(request.taskId === undefined ? {} : { inTask: request.taskId }),
        ...(request.sentFrom ? { sentFrom: request.sentFrom } : {}),
      },
      extra,
    );
  }
  const payload: MessageEventPayload = {
    message,
    idempotencyKey: request.idempotencyKey,
    ...pickMessageScope(scope),
    // 从哪台设备发来的（125 号票：运行时核实用户原话时写"从哪台设备来的"）：网关按连接给（本机端口、外网端口上的已配对设备）
    ...(request.sentFrom ? { sentFrom: request.sentFrom } : {}),
  };
  // 同一事务：先追加的事件（16 号票：开一个对话段，分隔线排在这句话之前）、消息、语音对象（31 号票）；
  // 它们各带自己的幂等键（语音的由发送请求的幂等键推出），重发时一起去重
  const prelude = preludeOf?.(request.conversation) ?? [];
  const results = store.appendBatch([...prelude, { channel: request.conversation, type: EVENT_TYPES.message, payload, idempotencyKey: request.idempotencyKey }, ...extra]);
  const { event } = results[prelude.length]!;
  const stored = (event.payload as Partial<MessageEventPayload>).message;
  if (event.type !== EVENT_TYPES.message || !stored) throw new RequestRejected("bad_params", t("conversation.messages.keyReused"));
  return { messageId: stored.id, seq: event.seq };
}

/** "作为材料投喂"的标记：带了才记 */
function fed(part: { asMaterial?: boolean | undefined }): { asMaterial?: true } {
  return part.asMaterial === true ? { asMaterial: true } : {};
}

function existing(attachments: AttachmentLookup, mediaId: string, name: string) {
  const info = isMediaId(mediaId) ? attachments.info(mediaId) : undefined;
  if (!info) throw new RequestRejected("bad_params", t("conversation.messages.noAttachment", { name, mediaId }));
  return info;
}

/**
 * 消息的归属（共享协议包里唯一的一份）：维护者会话里的消息所属的任务、项目（素材的"任务或项目"取自这里，12 号票起），
 * 属于任务的那时任务在哪个阶段（25 号票：时间线的全局层按阶段聚色块；任务里的取 tasks/stages.ts 的 taskMessageScope），
 * 定时作业的一次运行（24 号票：维护者处理它时的用量记在作业名下，19 号票交给维护者执行作业时带上）
 */
export type { MessageScope };

export interface AppendMessageOptions extends MessageScope {
  /**
   * 运行时给 agent 的通知：系统消息同时排进 agent 的输入队列（"某某已获批准，可以重试"这类）。
   * 只用于发言方是 system 的消息
   */
  agentInput?: boolean;
  /** 同一件事只追加一次（比如同一个审批的"可以重试"） */
  idempotencyKey?: string;
  /** agent 正在干活时以插话送达，不等这一轮结束（14 号票：现在只有无进展的催促这样送）；只用于 agentInput 的通知 */
  interject?: boolean;
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
    ...(options.agentInput && options.interject ? { interject: true } : {}),
    ...pickMessageScope(options),
  };
  const event: NewEvent = { channel: full.conversation, type: EVENT_TYPES.message, payload, ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }) };
  return { message: full, event };
}

/**
 * 时间线上的一条记录和它的事件（不追加：调用方和别的事件一起放进 appendBatch；25 号票定形状）。
 * 偏离（14 号票）、范围变更和越界（18 号票）照这个追加；和消息一样带上归属（任务里的用 taskMessageScope 取当时的阶段）。
 * 记录的 id、时间由这里给；同一件事只记一次的给幂等键
 */
export function buildTimelineRecord(
  conversation: ConversationId,
  record: { kind: TimelineRecordKind; summary: string; detail?: string; workOrderId?: string; noticeId?: string },
  scope: MessageScope = {},
  options: { idempotencyKey?: string } = {},
): { record: TimelineRecord; event: NewEvent } {
  const full: TimelineRecord = { id: `r-${randomUUID()}`, ...record, time: nowIso() };
  const payload: TimelineRecordEventPayload = { record: full, ...pickMessageScope(scope) };
  const event: NewEvent = { channel: conversation, type: EVENT_TYPES.timelineRecord, payload, ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }) };
  return { record: full, event };
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
export const SYSTEM_NOTICE_TAG = "[系统通知]"; // @i18n-ignore model：交给 agent 的标记

/**
 * 秘书转达的话（103 号票）交给 agent 时开头的标记：对方看得出这句是用户在和秘书说话时让秘书转告的，不是用户在这里打的字
 */
export const SECRETARY_RELAY_TAG = "【秘书转达】"; // @i18n-ignore model：交给 agent 的标记

/** 秘书转达的话交给 agent 时开头那一行（标记加一句说明，下面接着是时间标记和转达的话） */
export const SECRETARY_RELAY_HEAD = `${SECRETARY_RELAY_TAG}用户在和秘书的对话里让秘书把下面这句话转告你（不是用户在这里直接打的字），照用户在这里说的话一样处理：`; // @i18n-ignore model

/**
 * 秘书按用户的话往任务、项目维护者的会话里转达的一句（103 号票）和它的事件（不追加：和快速动作卡、操作记录同一事务）。
 * 走用户在任务详情、项目维护者会话里直接说话的那条路：发言方是用户，归属（scope）和要先追加的事件（开对话段）由调用方
 * 照网关发消息时的算法给；只多一个 relayedBy 标记。幂等键由快速动作的动作 id 推出，同一个动作只转一次。
 * 115 号票：对方会话里这一句折成一行，一句话总结是转达的话本身的第一句（截到 30 字）。
 * 125 号票：relayOf 是用户在秘书那里说的那句（秘书处理它时提出的转达）：维护者引用这一句，运行时按它换成用户的原话核实
 */
export function buildRelayedMessage(
  conversation: ConversationId,
  text: string,
  key: string,
  scope: MessageScope,
  relayOf?: string,
): { message: MessageEnvelope; event: NewEvent } {
  const summary = firstSentence(text);
  const message: MessageEnvelope = {
    id: newMessageId(),
    conversation,
    speaker: "user",
    time: nowIso(),
    parts: [{ type: "text", text }],
    relayedBy: "secretary",
    ...(relayOf === undefined ? {} : { relayOf }),
    ...(summary ? { summary } : {}),
  };
  // 幂等键只记在事件上（同一个动作只追加一次）：负载里的幂等键是给用户自己发的、乐观显示的消息换成权威消息用的，这条没有乐观显示
  const payload: MessageEventPayload = { message, ...pickMessageScope(scope) };
  return { message, event: { channel: conversation, type: EVENT_TYPES.message, payload, idempotencyKey: key } };
}

/**
 * 往会话里追加一条交给 agent 的通知（系统消息，排进它的输入队列），比如"某某已获批准，可以重试""已被用户拒绝"
 * "交给我做的事用户已完成"。同一件事按 key 只追加一次
 */
export function appendAgentNotice(store: EventStore, conversation: ConversationId, text: string, key: string, scope: MessageScope = {}): void {
  store.append(buildAgentNotice(conversation, text, key, scope).event);
}

/**
 * 交给 agent 的通知和它的事件（不追加）：和别的事件一起放进 appendBatch。维护者会话里的带上所属的任务。
 * interject：agent 正在干活时以插话送达，不等这一轮结束（14 号票：现在只有无进展的催促这样送）。
 * summary：会话里折成一行时显示的一句话总结（115 号票，来信才有：任务做完、维护者来信），只给界面看，交给 agent 的照旧是全文
 */
export function buildAgentNotice(
  conversation: ConversationId,
  text: string,
  key: string,
  scope: MessageScope = {},
  options: { interject?: boolean; summary?: string | undefined } = {},
): { message: MessageEnvelope; event: NewEvent } {
  return buildMessage(
    { conversation, speaker: "system", parts: [{ type: "text", text }], ...(options.summary ? { summary: options.summary } : {}) },
    { agentInput: true, idempotencyKey: key, ...scope, ...(options.interject ? { interject: true } : {}) },
  );
}
