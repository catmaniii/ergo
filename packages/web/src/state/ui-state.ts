// 前端状态层：把事件流归并成界面状态。全部是纯函数，不依赖 React 和 DOM。
//
// 两类输入：
// - 事件帧：服务端在某个频道上推来的权威事件。按频道记下最后收到的序号，重复或更旧的直接丢掉。
//   临时事件（流式增量）不占序号，只归并成"正在生成的回复"，定稿消息到了就被它替换。
// - 本地动作：用户刚做、服务端还没确认的事（发消息）。先乐观显示在会话末尾，
//   收到带同一个幂等键的权威事件后被替换；请求失败就标成失败，留着原文好重发。
// - 连接状态：连接告诉状态层的（连接中、在线、断开、页面版本过旧）；以及"重新同步某个频道"
//   （前端的序号比服务端还大，比如数据目录恢复成了旧快照：清掉这个频道，服务端从头补发）。
// - 往上翻取回的一页历史（HTTP）：会话频道第一次只补发最近一页，更早的消息按序号并进来，不推进游标。
// 06 号票起还有：待我处理事项（inbox_item）、简单提醒（看板频道上的 reminder）、到点的通知（临时的 notify，
// 界面显示过就用 alert_seen 去掉）、和消息与卡片对不上的被拒请求（比如卡着任务的事项不能删，界面提示过就用 failure_seen 去掉）。
// 待我处理的排序和 tab 上的提示见 inbox.ts，卡片的纯文本降级见 cards.ts。
// 10 号票起还有：已配对设备（devices 频道上的 device 事件，列表和分组见 devices.ts）；连接状态多了 unpaired
// （外网端口上这台设备的凭证失效了：被吊销或过期，界面回到配对等待页，开场方式见 pairing-gate.ts）。
// 21 号票起：被彻底删除的消息（事件改写成"已删除"标记，或者 messages_purged 说手里的哪几条被删了）在原来的位置只剩一条
// "已删除"，原话不留；带原话的工具调用记录换成改写后的样子（messages_purged 里的 replacement）。
// 输入框里引用的卡片（quote_card / unquote_card）也在这里：发消息时带上，发出去就清掉。
import {
  type Card,
  type CardAction,
  type CardEventPayload,
  CHANNELS,
  type ConversationId,
  type CredentialRejection,
  type DeletedEventPayload,
  type DeviceEventPayload,
  EVENT_TYPES,
  type EventFrame,
  type HistoryPage,
  type InboxItem,
  type InboxItemEventPayload,
  isDeletedEventPayload,
  isEphemeralEventType,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  type MessagesPurgedEventPayload,
  type NotifyEventPayload,
  type PairedDevice,
  type Reminder,
  type ReminderEventPayload,
  type StreamDelta,
  type StreamEventPayload,
} from "./protocol.ts";

export interface UiState {
  /** 每个频道最后收到的序号 */
  readonly cursors: Readonly<Record<string, number>>;
  /** 会话（键是会话 id，也就是频道名） */
  readonly conversations: Readonly<Record<string, ConversationState>>;
  /** 卡片（键是卡片 id） */
  readonly cards: Readonly<Record<string, CardState>>;
  /** 每个会话里正在生成的回复（键是会话 id）：由流式增量拼成，定稿消息到了就去掉 */
  readonly streams: Readonly<Record<string, StreamingMessage>>;
  /** 待我处理事项（键是事项 id；删掉的不在这里） */
  readonly inbox: Readonly<Record<string, InboxItem>>;
  /** 简单提醒（键是提醒 id） */
  readonly reminders: Readonly<Record<string, Reminder>>;
  /** 已配对设备（键是设备 id；吊销了的也在，标着 revoked） */
  readonly devices: Readonly<Record<string, PairedDevice>>;
  /** 要马上告诉用户的通知（到点的提醒）：界面在任意页面提示，显示过就去掉 */
  readonly alerts: readonly NotifyEventPayload[];
  /** 被拒的请求里和消息、卡片对不上的那些（比如卡着任务的事项不能删）：界面提示原因，提示过就去掉 */
  readonly failures: readonly RequestFailure[];
  readonly connection: ConnectionStatus;
  /** 连接报 unpaired 时知道的原因（被吊销、过期）；不知道或者不是 unpaired 时没有 */
  readonly unpairedReason: CredentialRejection | undefined;
  /** 输入框里引用的卡片（键是会话 id）：发消息时作为卡片引用带上，发出去就清掉（21 号票） */
  readonly quotes: Readonly<Record<string, readonly string[]>>;
}

/** 一个被拒的请求：幂等键和原因 */
export interface RequestFailure {
  readonly idempotencyKey: string;
  readonly error: string;
}

/**
 * 和服务端的连接：连接中、在线、断开（正在重连）、页面版本过旧（要刷新）、
 * 这台设备的凭证失效了（外网端口上被吊销或太久没用：不再重连，回到配对等待页）
 */
export type ConnectionStatus = "connecting" | "online" | "offline" | "outdated" | "unpaired";

/** 正在生成的一条回复 */
interface StreamingMessage {
  readonly messageId: string;
  readonly parts: readonly { readonly type: StreamDelta["type"]; readonly text: string }[];
  /** 漏掉了中间的增量（断线重连、或者说到一半才打开页面）：不再拼文字，等定稿消息 */
  readonly broken: boolean;
}

/** 一个已发出、还没得到结果的请求：在路上，或者失败了（带错误说明） */
export type RequestStatus = { readonly status: "sending" } | { readonly status: "failed"; readonly error: string };

/** 会话里的一条权威消息；被彻底删除的只剩"已删除"标记（消息 id 和时间） */
type ConversationEntry =
  | { readonly seq: number; readonly message: MessageEnvelope; readonly idempotencyKey?: string }
  | { readonly seq: number; readonly deleted: DeletedEventPayload };

interface ConversationState {
  /** 权威消息，按序号从早到晚（往上翻取回的更早消息插在前面）；用户自己发的带着发送请求的幂等键 */
  readonly messages: readonly ConversationEntry[];
  /** 乐观显示的尾巴：已发出、还没收到权威事件的消息，按发出顺序 */
  readonly tail: readonly PendingMessage[];
  /** 往上翻已经翻到头了（服务端说更早没有了） */
  readonly olderExhausted: boolean;
}

type PendingMessage = { readonly idempotencyKey: string; readonly message: MessageEnvelope } & RequestStatus;

/** 一张卡片的状态：权威版本，加上本地点了按钮、还没得到结果的动作。 */
export interface CardState {
  readonly card: Card;
  readonly pending?: { readonly action: CardAction; readonly idempotencyKey: string } & RequestStatus;
}

/**
 * 会话视图里的一条：权威消息，或者本地乐观显示、还没得到确认的消息。
 * 乐观显示的那条被权威消息替换后，权威消息带着同一个幂等键，界面可以拿它当 key，原地换掉不闪。
 */
export type ConversationItem =
  | { kind: "message"; message: MessageEnvelope; idempotencyKey?: string }
  /** 被彻底删除的消息：原来的位置只显示"已删除"；key 是消息 id（没有时用序号） */
  | { kind: "deleted"; key: string; time: string | undefined; idempotencyKey?: undefined }
  /** 正在生成的回复：message.id 就是定稿后那条消息的 id，界面拿它当 key，定稿时原地换掉；broken 时只显示"正在回复" */
  | { kind: "streaming"; message: MessageEnvelope; broken: boolean; idempotencyKey?: undefined }
  | ({ kind: "pending"; idempotencyKey: string; message: MessageEnvelope } & RequestStatus);

/** 状态层的输入。 */
export type UiInput =
  /** 服务端推来的事件帧 */
  | { kind: "frame"; frame: EventFrame }
  /** 用户发出一条消息（请求已发出，等权威事件） */
  | { kind: "send_message"; conversation: ConversationId; idempotencyKey: string; parts: MessagePart[]; time: string }
  /** 用户点了卡片上的按钮（"对卡片做动作"的请求已发出，等卡片更新事件） */
  | { kind: "card_action"; cardId: string; action: CardAction; idempotencyKey: string }
  /** 某个带幂等键的请求失败了（响应帧里的错误，或者连接断了没发出去） */
  | { kind: "request_failed"; idempotencyKey: string; error: string }
  /** 连接状态变了 */
  | { kind: "connection"; status: ConnectionStatus; reason?: CredentialRejection }
  /** 重新同步一个频道：清掉它的序号和归并出来的状态（还没确认的乐观显示留着），接下来服务端从头补发 */
  | { kind: "resync"; channel: string }
  /** 界面已经提示过这条通知 */
  | { kind: "alert_seen"; id: string }
  /** 界面已经提示过这个被拒的请求 */
  | { kind: "failure_seen"; idempotencyKey: string }
  /** 经 HTTP 取回的一页更早的历史（往上翻时） */
  | { kind: "history_page"; conversation: ConversationId; page: HistoryPage }
  /** 聊天里的一张卡片"引用"到输入框（同一张只引用一次） */
  | { kind: "quote_card"; conversation: ConversationId; cardId: string }
  /** 去掉输入框里引用的一张卡片 */
  | { kind: "unquote_card"; conversation: ConversationId; cardId: string };

export const initialUiState: UiState = {
  cursors: {},
  conversations: {},
  cards: {},
  streams: {},
  inbox: {},
  reminders: {},
  devices: {},
  alerts: [],
  failures: [],
  connection: "connecting",
  quotes: {},
  unpairedReason: undefined,
};

const emptyConversation: ConversationState = { messages: [], tail: [], olderExhausted: false };

/** 各事件类型的归并函数。后面的票往这张表里加；不认识的类型只推进序号。 */
const eventHandlers: Record<string, (state: UiState, frame: EventFrame) => UiState> = {
  [EVENT_TYPES.message]: (state, frame) => {
    if (isDeletedEventPayload(frame.payload)) {
      const deleted = frame.payload;
      return updateConversation(state, frame.channel, (conv) => ({ ...conv, messages: [...conv.messages, { seq: frame.seq, deleted }] }));
    }
    const { message, idempotencyKey } = frame.payload as MessageEventPayload;
    const next = updateConversation(state, frame.channel, (conv) => ({
      ...conv,
      messages: [...conv.messages, { seq: frame.seq, message, idempotencyKey }],
      tail: idempotencyKey === undefined ? conv.tail : conv.tail.filter((p) => p.idempotencyKey !== idempotencyKey),
    }));
    // 正在生成的那条定稿了：换成这条权威消息
    return next.streams[frame.channel]?.messageId === message.id ? withoutStream(next, frame.channel) : next;
  },
  // 这些消息被彻底删除了：手里的原话换成"已删除"
  [EVENT_TYPES.messagesPurged]: (state, frame) => {
    const { messages, deletedAt } = frame.payload as MessagesPurgedEventPayload;
    const purged = new Map(messages.map((m) => [m.messageId, m.replacement]));
    return updateConversation(state, frame.channel, (conv) => ({
      ...conv,
      messages: conv.messages.map((m): ConversationEntry => {
        if (!("message" in m) || !purged.has(m.message.id)) return m;
        const replacement = purged.get(m.message.id);
        // 字段级改写过的（工具调用记录）：换成改写后的样子；整条删掉的：只留"已删除"
        if (replacement) return { ...m, message: replacement };
        return { seq: m.seq, deleted: { deleted: true, deletedAt, messageId: m.message.id, messageTime: m.message.time } };
      }),
    }));
  },
  // 回合结束：不管有没有定稿消息（出错、中止），正在生成的都收起
  [EVENT_TYPES.turnEnd]: (state, frame) => withoutStream(state, frame.channel),
  [EVENT_TYPES.card]: (state, frame) => {
    // 彻底删除改写过的旧版本卡片：忽略（之后有去掉原话的新版本）
    if (isDeletedEventPayload(frame.payload)) return state;
    const { card } = frame.payload as CardEventPayload;
    const old = state.cards[card.id];
    if (old && old.card.version >= card.version) return state;
    // 卡片有了新的权威版本：不管是自己点的生效了还是别处先处理了，处理中的标记都结束
    return { ...state, cards: { ...state.cards, [card.id]: { card } } };
  },
  [EVENT_TYPES.inboxItem]: (state, frame) => {
    const { item } = frame.payload as InboxItemEventPayload;
    const inbox = { ...state.inbox };
    if (item.deleted) delete inbox[item.id];
    else inbox[item.id] = item;
    return { ...state, inbox };
  },
  [EVENT_TYPES.reminder]: (state, frame) => {
    const { reminder } = frame.payload as ReminderEventPayload;
    return { ...state, reminders: { ...state.reminders, [reminder.id]: reminder } };
  },
  [EVENT_TYPES.device]: (state, frame) => {
    const { device } = frame.payload as DeviceEventPayload;
    return { ...state, devices: { ...state.devices, [device.id]: device } };
  },
};

function updateConversation(state: UiState, id: string, f: (conv: ConversationState) => ConversationState): UiState {
  const conv = f(state.conversations[id] ?? emptyConversation);
  return { ...state, conversations: { ...state.conversations, [id]: conv } };
}

function resyncChannel(state: UiState, channel: string): UiState {
  const cursors = { ...state.cursors };
  delete cursors[channel];
  const conv = state.conversations[channel];
  const conversations = conv ? { ...state.conversations, [channel]: { ...emptyConversation, tail: conv.tail } } : state.conversations;
  const cards = channel === CHANNELS.cards ? {} : state.cards;
  const inbox = channel === CHANNELS.inbox ? {} : state.inbox;
  const reminders = channel === CHANNELS.board ? {} : state.reminders;
  const devices = channel === CHANNELS.devices ? {} : state.devices;
  return withoutStream({ ...state, cursors, conversations, cards, inbox, reminders, devices }, channel);
}

function withoutStream(state: UiState, channel: string): UiState {
  if (!state.streams[channel]) return state;
  const streams = { ...state.streams };
  delete streams[channel];
  return { ...state, streams };
}

/** 临时事件：不占序号。比已收到的落盘事件还旧的（迟到的增量、迟到的通知）丢掉 */
function reduceEphemeral(state: UiState, frame: EventFrame): UiState {
  if (frame.seq < (state.cursors[frame.channel] ?? 0)) return state;
  if (frame.type === EVENT_TYPES.notify) {
    const alert = frame.payload as NotifyEventPayload;
    return state.alerts.some((a) => a.id === alert.id) ? state : { ...state, alerts: [...state.alerts, alert] };
  }
  if (frame.type !== EVENT_TYPES.stream) return state;
  const { messageId, deltas } = frame.payload as StreamEventPayload;
  const old = state.streams[frame.channel];
  let stream: StreamingMessage = old?.messageId === messageId ? old : { messageId, parts: [], broken: false };
  for (const d of deltas) stream = appendDelta(stream, d);
  return { ...state, streams: { ...state.streams, [frame.channel]: stream } };
}

/** 接上一段增量；位置对不上（漏了中间的）就标成残缺，不再拼 */
function appendDelta(stream: StreamingMessage, d: StreamDelta): StreamingMessage {
  if (stream.broken) return stream;
  const part = stream.parts[d.part];
  if (part && part.text.length === d.offset) {
    return { ...stream, parts: stream.parts.map((p, i) => (i === d.part ? { type: p.type, text: p.text + d.text } : p)) };
  }
  if (!part && d.part === stream.parts.length && d.offset === 0) return { ...stream, parts: [...stream.parts, { type: d.type, text: d.text }] };
  return { ...stream, broken: true };
}

function reduceFrame(state: UiState, frame: EventFrame): UiState {
  if (isEphemeralEventType(frame.type)) return reduceEphemeral(state, frame);
  // 重复或更旧的序号：重连补发、或者同一事件收到两次，直接丢掉
  if (frame.seq <= (state.cursors[frame.channel] ?? 0)) return state;
  const next = { ...state, cursors: { ...state.cursors, [frame.channel]: frame.seq } };
  const handler = eventHandlers[frame.type];
  return handler ? handler(next, frame) : next;
}

export function reduce(state: UiState, input: UiInput): UiState {
  switch (input.kind) {
    case "frame":
      return reduceFrame(state, input.frame);
    case "send_message": {
      const message: MessageEnvelope = {
        id: `pending:${input.idempotencyKey}`,
        conversation: input.conversation,
        speaker: "user",
        time: input.time,
        parts: input.parts,
      };
      const sent = updateConversation(state, input.conversation, (conv) => ({
        ...conv,
        tail: [...conv.tail, { idempotencyKey: input.idempotencyKey, message, status: "sending" }],
      }));
      // 输入框里引用的卡片随这条消息发出去了
      return input.conversation in sent.quotes ? { ...sent, quotes: withoutKey(sent.quotes, input.conversation) } : sent;
    }
    case "quote_card": {
      const quoted = state.quotes[input.conversation] ?? [];
      if (quoted.includes(input.cardId)) return state;
      return { ...state, quotes: { ...state.quotes, [input.conversation]: [...quoted, input.cardId] } };
    }
    case "unquote_card": {
      const rest = (state.quotes[input.conversation] ?? []).filter((id) => id !== input.cardId);
      return { ...state, quotes: rest.length > 0 ? { ...state.quotes, [input.conversation]: rest } : withoutKey(state.quotes, input.conversation) };
    }
    case "card_action": {
      const view = state.cards[input.cardId];
      if (!view) return state;
      const pending: CardState["pending"] = { action: input.action, idempotencyKey: input.idempotencyKey, status: "sending" };
      return { ...state, cards: { ...state.cards, [input.cardId]: { ...view, pending } } };
    }
    case "request_failed": {
      const matched =
        Object.values(state.cards).some((view) => view.pending?.idempotencyKey === input.idempotencyKey) ||
        Object.values(state.conversations).some((conv) => conv.tail.some((p) => p.idempotencyKey === input.idempotencyKey));
      // 不是消息也不是卡片按钮（比如待我处理的动作）：记下原因，界面提示
      if (!matched) return { ...state, failures: [...state.failures, { idempotencyKey: input.idempotencyKey, error: input.error }] };
      let next = state;
      for (const [id, view] of Object.entries(state.cards)) {
        if (view.pending?.idempotencyKey !== input.idempotencyKey) continue;
        const pending: CardState["pending"] = { action: view.pending.action, idempotencyKey: view.pending.idempotencyKey, status: "failed", error: input.error };
        next = { ...next, cards: { ...next.cards, [id]: { ...view, pending } } };
      }
      for (const [id, conv] of Object.entries(state.conversations)) {
        if (!conv.tail.some((p) => p.idempotencyKey === input.idempotencyKey)) continue;
        next = updateConversation(next, id, (c) => ({
          ...c,
          tail: c.tail.map((p): PendingMessage => (p.idempotencyKey === input.idempotencyKey ? { idempotencyKey: p.idempotencyKey, message: p.message, status: "failed", error: input.error } : p)),
        }));
      }
      return next;
    }
    case "connection": {
      const unpairedReason = input.status === "unpaired" ? input.reason : undefined;
      return state.connection === input.status && state.unpairedReason === unpairedReason ? state : { ...state, connection: input.status, unpairedReason };
    }
    case "resync":
      return resyncChannel(state, input.channel);
    case "alert_seen":
      return { ...state, alerts: state.alerts.filter((a) => a.id !== input.id) };
    case "failure_seen":
      return { ...state, failures: state.failures.filter((f) => f.idempotencyKey !== input.idempotencyKey) };
    case "history_page":
      return mergeHistoryPage(state, input.conversation, input.page);
  }
}

/**
 * 往上翻取回的一页更早的消息：按序号并进权威消息（手里已有的同一条不重复），不推进游标
 * （游标只跟 WebSocket 上的落盘事件走）。服务端说更早没有了，就记下翻到头了。
 */
function mergeHistoryPage(state: UiState, conversation: ConversationId, page: HistoryPage): UiState {
  return updateConversation(state, conversation, (conv) => {
    const known = new Set(conv.messages.map((m) => m.seq));
    const older = page.messages
      .filter((m) => !known.has(m.seq))
      .map((m): ConversationEntry => ("deleted" in m ? { seq: m.seq, deleted: m.deleted } : { seq: m.seq, message: m.message, ...(m.idempotencyKey === undefined ? {} : { idempotencyKey: m.idempotencyKey }) }));
    const messages = [...older, ...conv.messages].toSorted((a, b) => a.seq - b.seq);
    return { ...conv, messages, olderExhausted: conv.olderExhausted || !page.hasMore };
  });
}

/** 回放：把一串输入依次归并。直接给事件帧也行。 */
export function replay(inputs: readonly (EventFrame | UiInput)[], from: UiState = initialUiState): UiState {
  return inputs.reduce<UiState>((s, x) => reduce(s, "kind" in x ? x : { kind: "frame", frame: x }), from);
}

/** 重连时带给服务端的"每个频道最后收到的序号"。 */
export function resumeCursors(state: UiState): Record<string, number> {
  return { ...state.cursors };
}

/**
 * 某个会话还能不能往上翻：before 是手里最早那条消息的序号（取更早的一页时带给服务端）。
 * 手里没有消息、最早那条就是序号 1、或者服务端说过更早没有了，就不能再翻。
 */
export function olderHistory(state: UiState, conversation: ConversationId): { canLoadOlder: boolean; before: number | undefined } {
  const conv = state.conversations[conversation] ?? emptyConversation;
  const before = conv.messages[0]?.seq;
  return { canLoadOlder: before !== undefined && before > 1 && !conv.olderExhausted, before };
}

/** 某张卡片的状态；没收到过这张卡就是 undefined。 */
export function selectCard(state: UiState, cardId: string): CardState | undefined {
  return state.cards[cardId];
}

/** 某条简单提醒的最新状态 */
export function selectReminder(state: UiState, reminderId: string): Reminder | undefined {
  return state.reminders[reminderId];
}

/** 某个会话要显示的条目：权威消息在前，然后是正在生成的回复，乐观显示的尾巴在最后。 */
export function conversationView(state: UiState, conversation: ConversationId): ConversationItem[] {
  const conv = state.conversations[conversation] ?? emptyConversation;
  const stream = state.streams[conversation];
  return [
    ...conv.messages.map(
      (m): ConversationItem =>
        "deleted" in m
          ? { kind: "deleted", key: m.deleted.messageId ?? `deleted:${m.seq}`, time: m.deleted.messageTime }
          : { kind: "message", message: m.message, idempotencyKey: m.idempotencyKey },
    ),
    ...(stream ? [streamingItem(conversation, stream)] : []),
    ...conv.tail.map((p): ConversationItem => ({ kind: "pending", ...p })),
  ];
}

function streamingItem(conversation: ConversationId, stream: StreamingMessage): ConversationItem {
  // 时间留空：定稿消息带着服务端的时间到来
  const parts: MessagePart[] = stream.parts.map((p) => ({ type: p.type, text: p.text }));
  return { kind: "streaming", broken: stream.broken, message: { id: stream.messageId, conversation, speaker: "agent", time: "", parts } };
}

/** 输入框里引用的卡片（按引用的先后） */
export function quotedCards(state: UiState, conversation: ConversationId): readonly string[] {
  return state.quotes[conversation] ?? [];
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}
