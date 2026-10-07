// 流式增量的推送（规格第 5 节）：agent 回复的中间增量只推送、不落盘，每个会话每 100 毫秒最多推一帧
// （换了一条消息也一样：间隔按会话算，不按消息算）。
// 一帧里是这段时间攒下的增量，每段写明落在第几个 part、从第几个字符起，前端据此发现漏掉的增量。
// 消息定稿（或回合结束）时，还没推出去的增量直接丢掉：定稿消息取而代之。
import { type ConversationId, EVENT_TYPES, type EventFrame, type StreamDelta, type StreamEventPayload } from "@ergou/protocol";

export type StreamPartType = StreamDelta["type"];

export interface StreamHub {
  /** 会话里某条正在生成的消息来了一段增量 */
  delta(conversation: ConversationId, messageId: string, type: StreamPartType, text: string): void;
  /** 这条消息不再流式（定稿了、或者回合结束了）：丢掉还没推出去的增量 */
  end(conversation: ConversationId, messageId: string): void;
  /** 订阅推出去的临时事件帧；返回取消订阅的函数 */
  onFrame(listener: (frame: EventFrame) => void): () => void;
  /** 停掉所有计时器 */
  close(): void;
}

export interface StreamHubOptions {
  /** 临时事件的序号：它所在频道当时最后一条落盘事件的序号 */
  lastSeq(channel: string): number;
  /** 同一会话两帧之间的最短间隔，默认 100 毫秒 */
  intervalMs?: number;
  /** 钟（测试换成假的） */
  now?: () => number;
}

/** 一条正在流式的消息 */
interface ActiveStream {
  messageId: string;
  /** 已经收到的各 part 的文字（含还没推出去的） */
  parts: Array<{ type: StreamPartType; text: string }>;
  /** 攒着、还没推出去的增量 */
  pending: StreamDelta[];
}

/** 一个会话的推送状态：上一帧什么时候推的（跨消息保留），等着推的计时器，正在流式的消息 */
interface ConversationStream {
  lastFlushAt: number;
  timer: NodeJS.Timeout | undefined;
  active: ActiveStream | undefined;
}

export function createStreamHub(options: StreamHubOptions): StreamHub {
  const intervalMs = options.intervalMs ?? 100;
  const now = options.now ?? Date.now;
  const listeners = new Set<(frame: EventFrame) => void>();
  const conversations = new Map<ConversationId, ConversationStream>();

  const stateOf = (conversation: ConversationId): ConversationStream => {
    let state = conversations.get(conversation);
    if (!state) {
      state = { lastFlushAt: Number.NEGATIVE_INFINITY, timer: undefined, active: undefined };
      conversations.set(conversation, state);
    }
    return state;
  };

  const flush = (conversation: ConversationId, state: ConversationStream) => {
    state.timer = undefined;
    const active = state.active;
    if (!active || active.pending.length === 0) return;
    const payload: StreamEventPayload = { messageId: active.messageId, deltas: active.pending };
    active.pending = [];
    state.lastFlushAt = now();
    const frame: EventFrame = { channel: conversation, seq: options.lastSeq(conversation), type: EVENT_TYPES.stream, payload };
    for (const listener of listeners) listener(frame);
  };

  /** 不再流式这条消息；lastFlushAt 留着，下一条消息的第一帧照样要和上一帧隔开 */
  const stop = (state: ConversationStream) => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.active = undefined;
  };

  return {
    delta(conversation, messageId, type, text) {
      if (text.length === 0) return;
      const state = stateOf(conversation);
      let active = state.active;
      if (active?.messageId !== messageId) {
        stop(state);
        active = { messageId, parts: [], pending: [] };
        state.active = active;
      }
      // 和上一个 part 同类就接着写，否则开一个新 part
      let index = active.parts.length - 1;
      if (index < 0 || active.parts[index]!.type !== type) {
        active.parts.push({ type, text: "" });
        index += 1;
      }
      const part = active.parts[index]!;
      const last = active.pending.at(-1);
      if (last && last.part === index) last.text += text;
      else active.pending.push({ part: index, type, offset: part.text.length, text });
      part.text += text;

      const wait = state.lastFlushAt + intervalMs - now();
      if (wait <= 0) flush(conversation, state);
      else state.timer ??= setTimeout(() => flush(conversation, state), wait);
    },
    end(conversation, messageId) {
      const state = conversations.get(conversation);
      if (state?.active?.messageId === messageId) stop(state);
    },
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      for (const state of conversations.values()) stop(state);
      conversations.clear();
      listeners.clear();
    },
  };
}
