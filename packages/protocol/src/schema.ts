// 前端协议的 schema（规格第 5 节），用 TypeBox 定义。守护进程和 Web 都用这里生成的类型；
// 守护进程还拿它校验收到的请求（见 request.ts）。
import { type Static, Type } from "typebox";
import {
  CARD_ACTIONS,
  CARD_STATUSES,
  CHANNELS,
  DISPOSITIONS,
  ERROR_CODES,
  INBOX_ACTIONS,
  MAINTAINER_CHANNEL_PREFIX,
  REMINDER_CHANGES,
  REMINDER_STATUSES,
  SPEAKERS,
  TOOL_CALL_OUTCOMES,
  TURN_OUTCOMES,
  URGENCIES,
} from "./constants.ts";
import { ReminderSchedule } from "./reminder-schedule.ts";

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
  /** 负载的版本（卡片类型注册表登记的版本）；前端认识的版本比它低时，和不认识的类型一样处理 */
  typeVersion: Type.Integer({ minimum: 1 }),
  /** 每次状态变化加 1；按钮动作带上期望版本，服务端按版本条件更新 */
  version: Type.Integer({ minimum: 1 }),
  status: CardStatus,
  /** 按卡片类型注册表里的 schema 校验过的负载 */
  payload: Type.Unknown(),
  /** 纯文本降级版本（注册表按负载生成）：不认识这种卡的前端显示它，加上"去 Web 处理"的链接 */
  text: Type.String(),
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
  /** 动作附带的结构化输入（比如改提醒的新时间），按卡片类型注册表里这个动作的 schema 校验 */
  input: Type.Optional(Type.Unknown()),
});
export type CardActionParams = Static<typeof CardActionParams>;

/** 卡片动作的 ack：生效后卡片的版本（同一幂等键重发拿到同一个结果）；卡片本身随后在卡片频道推送 */
export const CardActionResult = Type.Object({ cardId: Type.String(), version: Type.Integer({ minimum: 1 }) });
export type CardActionResult = Static<typeof CardActionResult>;

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

/** `card_dismissed` 事件：用户关掉了一张卡（不处理）。回避信号的素材 */
export const CardDismissedEventPayload = Type.Object({
  cardId: Type.String(),
  cardType: Type.String(),
  /** 关掉用的是哪个动作（"不用了"、"取消"……） */
  action: CardAction,
  /** 用户关掉时附带的说明（用户自己的话，素材里记成本人） */
  note: Type.Optional(Type.String()),
  time: Type.String(),
});
export type CardDismissedEventPayload = Static<typeof CardDismissedEventPayload>;

/** `card_stale` 事件：建议卡、提问卡长期没处理（08 号票计时并产生）。回避信号的素材 */
export const CardStaleEventPayload = Type.Object({
  cardId: Type.String(),
  cardType: Type.String(),
  /** 从什么时候起一直待处理 */
  pendingSince: Type.String(),
  time: Type.String(),
});
export type CardStaleEventPayload = Static<typeof CardStaleEventPayload>;

// ───────────────────────── 待我处理 ─────────────────────────

/** 两种事项共有的字段 */
const inboxItemBase = {
  id: Type.String(),
  /** 每次变化加 1 */
  version: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  /** 来自哪里："简单提醒"、"任务「…」"、"项目「…」"、"系统" */
  source: Type.String(),
  urgency: Urgency,
  /** 置顶（到点的提醒） */
  pinned: Type.Boolean(),
  createdAt: Type.String(),
  read: Type.Boolean(),
  archived: Type.Boolean(),
  deleted: Type.Boolean(),
};

/** 卡片事项：要处理的那张卡。处理没处理看卡片本身的状态（在聊天里处理了，这里同步） */
export const CardInboxItem = Type.Object({ ...inboxItemBase, kind: Type.Literal("card"), cardId: Type.String() });
export type CardInboxItem = Static<typeof CardInboxItem>;

/** 通知类事项：点了它的某个动作就算处理了 */
export const NoticeInboxItem = Type.Object({
  ...inboxItemBase,
  kind: Type.Literal("notice"),
  /** 通知的种类（NOTICE_TYPES）；前端可能还不认识 */
  notice: Type.String(),
  body: Type.Optional(Type.String()),
  /** 可选的处理动作；点了任意一个就算处理了 */
  actions: Type.Array(Type.String()),
  /** 处理结果：点了哪个动作 */
  handled: Type.Optional(Type.String()),
  handledAt: Type.Optional(Type.String()),
  /** 相关的卡（比如到点的提醒对应的提醒卡），可以没有 */
  cardId: Type.Optional(Type.String()),
  /** 某种通知自己的结构化内容（比如归档清单的每一项），由产生它的票定 */
  data: Type.Optional(Type.Unknown()),
});
export type NoticeInboxItem = Static<typeof NoticeInboxItem>;

/**
 * 待我处理事项：要处理的卡片，或者通知类事项。按紧急度三档排序，置顶的排在最前；
 * 可标已读、归档、删除（删除也是一次更新：deleted 为 true，前端把它拿掉）。
 * 处理过没有用 inbox.ts 的 isInboxItemProcessed 判断（守护进程和前端共用）。
 */
export const InboxItem = Type.Union([CardInboxItem, NoticeInboxItem]);
export type InboxItem = Static<typeof InboxItem>;

export const InboxAction = Type.Enum(INBOX_ACTIONS);
export type InboxAction = Static<typeof InboxAction>;

/**
 * 对待我处理事项的动作。一次可以对多项做同一个动作（"全部标已读"），要么全部生效、要么全部不生效：
 * 卡着任务（紧急度前两档）的事项处理之前归档或删除会被拒（not_allowed），message 写明原因。
 */
export const InboxActionParams = Type.Object({
  itemIds: Type.Array(Type.String(), { minItems: 1, maxItems: 500 }),
  action: InboxAction,
  /** 处理通知类事项时选的动作（必须是事项的 actions 之一） */
  choice: Type.Optional(Type.String()),
});
export type InboxActionParams = Static<typeof InboxActionParams>;

/** 动作生效后各事项的版本（没有变化的事项版本不变）；事项本身随后在待我处理频道推送 */
export const InboxActionResult = Type.Object({ items: Type.Array(Type.Object({ id: Type.String(), version: Type.Integer({ minimum: 1 }) })) });
export type InboxActionResult = Static<typeof InboxActionResult>;

/** `inbox_item` 事件：一条事项的最新状态 */
export const InboxItemEventPayload = Type.Object({ item: InboxItem });
export type InboxItemEventPayload = Static<typeof InboxItemEventPayload>;

/** `notify` 事件（临时）：马上告诉用户的一件事。前端在任意页面给出页面内提示，用户允许时再发浏览器通知 */
export const NotifyEventPayload = Type.Object({
  /** 这次通知的 id（浏览器通知用它去重：同一件事在几个窗口里只弹一条） */
  id: Type.String(),
  title: Type.String(),
  body: Type.Optional(Type.String()),
  /** 对应的待我处理事项 */
  itemId: Type.Optional(Type.String()),
});
export type NotifyEventPayload = Static<typeof NotifyEventPayload>;

// ───────────────────────── 简单提醒 ─────────────────────────

export const ReminderStatus = Type.Enum(REMINDER_STATUSES);
export type ReminderStatus = Static<typeof ReminderStatus>;

/** 简单提醒（任务看板上"运营中 · 待触发"；已触发的一次性提醒归"最近结束"） */
export const Reminder = Type.Object({
  id: Type.String(),
  /** 提醒什么 */
  text: Type.String(),
  schedule: ReminderSchedule,
  status: ReminderStatus,
  /** 下一次响的时间；已触发的一次性提醒和已取消的没有 */
  nextAt: Type.Optional(Type.String()),
  /** 最近一次响的时间 */
  lastFiredAt: Type.Optional(Type.String()),
  /** 它的提醒卡 */
  cardId: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type Reminder = Static<typeof Reminder>;

/**
 * `reminder` 事件：一条简单提醒的最新状态，以及这次是什么变化、谁做的（秘书是 agent，用户点卡上的按钮，调度器是 system）。
 * 到点时守护进程没在运行（或者机器睡着了）、晚了才响的，带上晚了多少分钟：60 分钟以内照发（fired），更晚的改放进待我处理（missed）。
 */
export const ReminderEventPayload = Type.Object({
  reminder: Reminder,
  change: Type.Enum(REMINDER_CHANGES),
  by: Speaker,
  lateMinutes: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type ReminderEventPayload = Static<typeof ReminderEventPayload>;

/** 简单提醒卡的负载（卡片类型注册表里 reminder 的 schema） */
export const ReminderCardPayload = Type.Object({
  reminderId: Type.String(),
  text: Type.String(),
  schedule: ReminderSchedule,
  status: ReminderStatus,
  nextAt: Type.Optional(Type.String()),
  lastFiredAt: Type.Optional(Type.String()),
});
export type ReminderCardPayload = Static<typeof ReminderCardPayload>;

/** 提醒卡上"改"（动作 save）的输入：新的时间或重复规则，可以连内容一起改 */
export const ReminderEditInput = Type.Object({
  schedule: ReminderSchedule,
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
});
export type ReminderEditInput = Static<typeof ReminderEditInput>;

