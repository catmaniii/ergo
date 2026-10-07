// 前端协议的 schema（规格第 5 节），用 TypeBox 定义。守护进程和 Web 都用这里生成的类型；
// 守护进程还拿它校验收到的请求（见 request.ts）。
import { type Static, Type } from "typebox";
import {
  CARD_ACTIONS,
  CARD_STATUSES,
  CHANNELS,
  DISPOSITIONS,
  ERROR_CODES,
  MAINTAINER_CHANNEL_PREFIX,
  SPEAKERS,
  TOOL_CALL_OUTCOMES,
  TURN_OUTCOMES,
  URGENCIES,
} from "./constants.ts";

// ───────────────────────── 频道 ─────────────────────────

/** 会话 id（也是会话频道名）：秘书会话，或某个维护者的会话 */
export const ConversationId = Type.Union([Type.Literal(CHANNELS.secretary), Type.TemplateLiteral(`${MAINTAINER_CHANNEL_PREFIX}\${string}`)]);
export type ConversationId = Static<typeof ConversationId>;

/** 全部频道：两类会话频道，加上任务看板、项目列表、待我处理、卡片、活动状态 */
export const Channel = Type.Union([
  ConversationId,
  Type.Literal(CHANNELS.board),
  Type.Literal(CHANNELS.projects),
  Type.Literal(CHANNELS.inbox),
  Type.Literal(CHANNELS.cards),
  Type.Literal(CHANNELS.activity),
]);
export type Channel = Static<typeof Channel>;

// ───────────────────────── 消息 ─────────────────────────

export const Speaker = Type.Enum(SPEAKERS);
export type Speaker = Static<typeof Speaker>;

export const Disposition = Type.Enum(DISPOSITIONS);
export type Disposition = Static<typeof Disposition>;

export const ToolCallOutcome = Type.Enum(TOOL_CALL_OUTCOMES);
export type ToolCallOutcome = Static<typeof ToolCallOutcome>;

/**
 * 消息的 part：形状对齐 AI SDK 的 UIMessage parts，但类型自己定义。
 * 语音、TTS 音频、视频第一阶段只预留，界面上显示为"第二阶段"的占位。
 */
export const TextPart = Type.Object({ type: Type.Literal("text"), text: Type.String() });
/** 推理：界面上默认折叠 */
export const ReasoningPart = Type.Object({ type: Type.Literal("reasoning"), text: Type.String() });
export const ImagePart = Type.Object({
  type: Type.Literal("image"),
  mediaId: Type.String(),
  name: Type.String(),
  mime: Type.String(),
  width: Type.Optional(Type.Integer()),
  height: Type.Optional(Type.Integer()),
});
export const FilePart = Type.Object({
  type: Type.Literal("file"),
  mediaId: Type.String(),
  name: Type.String(),
  mime: Type.String(),
  size: Type.Integer({ minimum: 0 }),
  /** 用户"作为材料投喂"发的 */
  asMaterial: Type.Optional(Type.Boolean()),
});
/** 语音（附转写；第一阶段只预留） */
export const VoicePart = Type.Object({ type: Type.Literal("voice"), mediaId: Type.String(), transcript: Type.String() });
/** TTS 音频（预留） */
export const TtsAudioPart = Type.Object({ type: Type.Literal("tts_audio"), mediaId: Type.String() });
/** 视频（预留） */
export const VideoPart = Type.Object({ type: Type.Literal("video"), mediaId: Type.String() });
export const ToolCallPart = Type.Object({
  type: Type.Literal("tool_call"),
  callId: Type.String(),
  /** 工具名（真实工具或从 bash 拆出的伪工具） */
  tool: Type.String(),
  /** 参数摘要（一行） */
  argsSummary: Type.String(),
  /** 命中的关注类别 id */
  watchCategories: Type.Array(Type.String()),
  /** 守卫的判定 */
  disposition: Disposition,
  /** 是否属于授权内 */
  withinGrant: Type.Boolean(),
  /** 是否通用 bash（没有事先规定类型的 bash 调用） */
  genericBash: Type.Boolean(),
  outcome: ToolCallOutcome,
  /** 结果摘要 */
  resultSummary: Type.Optional(Type.String()),
});
export const CardRefPart = Type.Object({ type: Type.Literal("card_ref"), cardId: Type.String() });
/** 维护者会话的分段线：工单段带工单号；用户直接对话（含立项问答）开的"对话段"工单号为空 */
export const WorkOrderDividerPart = Type.Object({
  type: Type.Literal("work_order_divider"),
  workOrderId: Type.String(),
  title: Type.String(),
  from: Type.String(),
});

export const MessagePart = Type.Union([
  TextPart,
  ReasoningPart,
  ImagePart,
  FilePart,
  VoicePart,
  TtsAudioPart,
  VideoPart,
  ToolCallPart,
  CardRefPart,
  WorkOrderDividerPart,
]);
export type MessagePart = Static<typeof MessagePart>;

/** 消息信封：一条消息由若干 part 组成。 */
export const MessageEnvelope = Type.Object({
  id: Type.String(),
  /** 所属会话，同时也是它所在的频道名 */
  conversation: ConversationId,
  speaker: Speaker,
  /** 带时区偏移的 ISO 时间 */
  time: Type.String(),
  parts: Type.Array(MessagePart),
});
export type MessageEnvelope = Static<typeof MessageEnvelope>;

// ───────────────────────── 卡片 ─────────────────────────

export const CardAction = Type.Enum(CARD_ACTIONS);
export type CardAction = Static<typeof CardAction>;

export const CardStatus = Type.Enum(CARD_STATUSES);
export type CardStatus = Static<typeof CardStatus>;

export const Urgency = Type.Enum(URGENCIES);
export type Urgency = Static<typeof Urgency>;

/** 卡片实体：消息里只放引用，状态只有一份，在聊天、待我处理、时间线里同步。 */
export const Card = Type.Object({
  id: Type.String(),
  /** 卡片类型；前端可能还不认识，用 isCardType 收窄 */
  type: Type.String(),
  /** 每次状态变化加 1；按钮动作带上期望版本，服务端按版本条件更新 */
  version: Type.Integer({ minimum: 1 }),
  status: CardStatus,
  payload: Type.Unknown(),
  urgency: Type.Optional(Urgency),
  createdAt: Type.String(),
  handledAt: Type.Optional(Type.String()),
  /** 处理结果：点了哪个动作，附带的说明（打回意见、勾掉了哪几项授权……） */
  outcome: Type.Optional(Type.Object({ action: CardAction, note: Type.Optional(Type.String()) })),
});
export type Card = Static<typeof Card>;

// ───────────────────────── 帧 ─────────────────────────

/** 请求帧 `{id, 方法, 参数, 幂等键?}`。有副作用的方法必须带幂等键，重发不会做两次。 */
export const RequestFrame = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  method: Type.String({ minLength: 1 }),
  params: Type.Unknown(),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});
export type RequestFrame = Static<typeof RequestFrame>;

export const ErrorBody = Type.Object({ code: Type.Enum(ERROR_CODES), message: Type.String() });
export type ErrorBody = Static<typeof ErrorBody>;

/** 响应帧 `{id, 成功与否, 结果或错误}`。请求帧连 id 都读不出来时，id 为 null。 */
export const ResponseFrame = Type.Union([
  Type.Object({ id: Type.Union([Type.String(), Type.Null()]), ok: Type.Literal(true), result: Type.Unknown() }),
  Type.Object({ id: Type.Union([Type.String(), Type.Null()]), ok: Type.Literal(false), error: ErrorBody }),
]);
export type ResponseFrame = Static<typeof ResponseFrame>;

/**
 * 事件帧 `{频道, 序号, 类型, 负载}`：守护进程在某个频道上推给前端的一条事件。
 * 落盘事件的序号在频道内从 1 起连续递增；临时事件（流式增量）的序号是它所在频道当时最后一条落盘事件的序号。
 */
export const EventFrame = Type.Object({
  channel: Type.String(),
  seq: Type.Integer({ minimum: 0 }),
  type: Type.String(),
  payload: Type.Unknown(),
});
export type EventFrame = Static<typeof EventFrame>;

// ───────────────────────── 方法的参数与结果 ─────────────────────────

export const SubscribeParams = Type.Object({
  protocolVersion: Type.Integer(),
  /** 每个要订阅的频道，以及前端在这个频道上最后收到的序号（没收到过是 0） */
  cursors: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
});
export type SubscribeParams = Static<typeof SubscribeParams>;

export const SubscribeResult = Type.Object({
  protocolVersion: Type.Integer(),
  /**
   * 要重新同步的频道：前端带来的序号比服务端这个频道的最后序号还大（比如数据目录恢复成了旧快照）。
   * 前端清掉这些频道的状态；服务端从头补发它们的事件。
   */
  resync: Type.Array(Type.String()),
});
export type SubscribeResult = Static<typeof SubscribeResult>;

export const SendMessageParams = Type.Object({
  conversation: ConversationId,
  parts: Type.Array(MessagePart, { minItems: 1, maxItems: 64 }),
});
export type SendMessageParams = Static<typeof SendMessageParams>;

/** 发消息的结果：落盘后的消息 id 和它在会话频道里的序号（同一幂等键重发拿到同一个结果） */
export const SendMessageResult = Type.Object({ messageId: Type.String(), seq: Type.Integer() });
export type SendMessageResult = Static<typeof SendMessageResult>;

/** 对卡片做动作：`{卡片 id, 动作, 期望版本, 幂等键}`；服务端按版本条件更新，先到先得 */
export const CardActionParams = Type.Object({
  cardId: Type.String(),
  action: CardAction,
  expectedVersion: Type.Integer({ minimum: 1 }),
  /** 动作附带的说明（打回意见、勾掉了哪几项授权、选了哪些答案） */
  note: Type.Optional(Type.String()),
});
export type CardActionParams = Static<typeof CardActionParams>;

// ───────────────────────── 事件负载 ─────────────────────────

/** `message` 事件：定稿的消息；是用户自己发的就带上发送请求的幂等键（乐观显示的消息靠它被替换）。 */
export const MessageEventPayload = Type.Object({
  message: MessageEnvelope,
  idempotencyKey: Type.Optional(Type.String()),
});
export type MessageEventPayload = Static<typeof MessageEventPayload>;

/** `turn_start` 事件：agent 开始处理会话里的一条用户消息 */
export const TurnStartEventPayload = Type.Object({ inputMessageId: Type.String() });
export type TurnStartEventPayload = Static<typeof TurnStartEventPayload>;

/** `turn_end` 事件：agent 处理完会话里的一条用户消息（出队） */
export const TurnEndEventPayload = Type.Object({
  /** 处理的是哪条用户消息 */
  inputMessageId: Type.String(),
  outcome: Type.Enum(TURN_OUTCOMES),
  error: Type.Optional(Type.String()),
});
export type TurnEndEventPayload = Static<typeof TurnEndEventPayload>;

/**
 * `stream` 事件（临时）：agent 回复的流式增量。messageId 就是定稿后那条消息的 id。
 * 每段增量写明落在第几个 part、从这个 part 的第几个字符起（UTF-16 下标），
 * 前端据此判断有没有漏掉中间的增量（比如断线重连、或者回复说到一半才打开页面）。
 */
export const StreamDelta = Type.Object({
  part: Type.Integer({ minimum: 0 }),
  type: Type.Union([Type.Literal("text"), Type.Literal("reasoning")]),
  offset: Type.Integer({ minimum: 0 }),
  text: Type.String(),
});
export type StreamDelta = Static<typeof StreamDelta>;

export const StreamEventPayload = Type.Object({ messageId: Type.String(), deltas: Type.Array(StreamDelta) });
export type StreamEventPayload = Static<typeof StreamEventPayload>;

/** `card` 事件：卡片的最新版本 */
export const CardEventPayload = Type.Object({ card: Card });
export type CardEventPayload = Static<typeof CardEventPayload>;
