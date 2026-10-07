// 前端状态层：把事件流归并成界面状态。全部是纯函数，不依赖 React 和 DOM。
//
// 两类输入：
// - 事件帧：服务端在某个频道上推来的权威事件。按频道记下最后收到的序号，重复或更旧的直接丢掉。
// - 本地动作：用户刚做、服务端还没确认的事（发消息）。先乐观显示在会话末尾，
//   收到带同一个幂等键的权威事件后被替换；请求失败就标成失败，留着原文好重发。
import { type Card, type CardAction, EVENT_TYPES, type EventFrame, type MessageEnvelope, type MessagePart } from "./protocol.ts";

export interface UiState {
  /** 每个频道最后收到的序号 */
  readonly cursors: Readonly<Record<string, number>>;
  /** 会话（键是会话 id，也就是频道名） */
  readonly conversations: Readonly<Record<string, ConversationState>>;
  /** 卡片（键是卡片 id） */
  readonly cards: Readonly<Record<string, CardState>>;
}

/** 一个已发出、还没得到结果的请求：在路上，或者失败了（带错误说明） */
export type RequestStatus = { readonly status: "sending" } | { readonly status: "failed"; readonly error: string };

interface ConversationState {
  /** 权威消息，按到达顺序；用户自己发的带着发送请求的幂等键 */
  readonly messages: readonly { readonly message: MessageEnvelope; readonly idempotencyKey?: string }[];
  /** 乐观显示的尾巴：已发出、还没收到权威事件的消息，按发出顺序 */
  readonly tail: readonly PendingMessage[];
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
  | ({ kind: "pending"; idempotencyKey: string; message: MessageEnvelope } & RequestStatus);

/** 状态层的输入。 */
export type UiInput =
  /** 服务端推来的事件帧 */
  | { kind: "frame"; frame: EventFrame }
  /** 用户发出一条消息（请求已发出，等权威事件） */
  | { kind: "send_message"; conversation: string; idempotencyKey: string; parts: MessagePart[]; time: string }
  /** 用户点了卡片上的按钮（"对卡片做动作"的请求已发出，等卡片更新事件） */
  | { kind: "card_action"; cardId: string; action: CardAction; idempotencyKey: string }
  /** 某个带幂等键的请求失败了（响应帧里的错误，或者连接断了没发出去） */
  | { kind: "request_failed"; idempotencyKey: string; error: string };

/** `message` 事件的负载：定稿的消息；是用户自己发的就带上发送请求的幂等键。 */
export interface MessageEventPayload {
  message: MessageEnvelope;
  idempotencyKey?: string;
}

/** `card` 事件的负载：卡片的最新版本。 */
export interface CardEventPayload {
  card: Card;
}

export const initialUiState: UiState = { cursors: {}, conversations: {}, cards: {} };

const emptyConversation: ConversationState = { messages: [], tail: [] };

/** 各事件类型的归并函数。后面的票往这张表里加；不认识的类型只推进序号。 */
const eventHandlers: Record<string, (state: UiState, frame: EventFrame) => UiState> = {
  [EVENT_TYPES.message]: (state, frame) => {
    const { message, idempotencyKey } = frame.payload as MessageEventPayload;
    return updateConversation(state, frame.channel, (conv) => ({
      messages: [...conv.messages, { message, idempotencyKey }],
      tail: idempotencyKey === undefined ? conv.tail : conv.tail.filter((p) => p.idempotencyKey !== idempotencyKey),
    }));
  },
  [EVENT_TYPES.card]: (state, frame) => {
    const { card } = frame.payload as CardEventPayload;
    const old = state.cards[card.id];
    if (old && old.card.version >= card.version) return state;
    // 卡片有了新的权威版本：不管是自己点的生效了还是别处先处理了，处理中的标记都结束
    return { ...state, cards: { ...state.cards, [card.id]: { card } } };
  },
};

function updateConversation(state: UiState, id: string, f: (conv: ConversationState) => ConversationState): UiState {
  const conv = f(state.conversations[id] ?? emptyConversation);
  return { ...state, conversations: { ...state.conversations, [id]: conv } };
}

function reduceFrame(state: UiState, frame: EventFrame): UiState {
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
      return updateConversation(state, input.conversation, (conv) => ({
        ...conv,
        tail: [...conv.tail, { idempotencyKey: input.idempotencyKey, message, status: "sending" }],
      }));
    }
    case "card_action": {
      const view = state.cards[input.cardId];
      if (!view) return state;
      const pending: CardState["pending"] = { action: input.action, idempotencyKey: input.idempotencyKey, status: "sending" };
      return { ...state, cards: { ...state.cards, [input.cardId]: { ...view, pending } } };
    }
    case "request_failed": {
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
  }
}

/** 回放：把一串输入依次归并。直接给事件帧也行。 */
export function replay(inputs: readonly (EventFrame | UiInput)[], from: UiState = initialUiState): UiState {
  return inputs.reduce<UiState>((s, x) => reduce(s, "kind" in x ? x : { kind: "frame", frame: x }), from);
}

/** 重连时带给服务端的"每个频道最后收到的序号"。 */
export function resumeCursors(state: UiState): Record<string, number> {
  return { ...state.cursors };
}

/** 某张卡片的状态；没收到过这张卡就是 undefined。 */
export function selectCard(state: UiState, cardId: string): CardState | undefined {
  return state.cards[cardId];
}

/** 某个会话要显示的条目：权威消息在前，乐观显示的尾巴在后。 */
export function conversationView(state: UiState, conversation: string): ConversationItem[] {
  const conv = state.conversations[conversation] ?? emptyConversation;
  return [
    ...conv.messages.map((m): ConversationItem => ({ kind: "message", message: m.message, idempotencyKey: m.idempotencyKey })),
    ...conv.tail.map((p): ConversationItem => ({ kind: "pending", ...p })),
  ];
}
