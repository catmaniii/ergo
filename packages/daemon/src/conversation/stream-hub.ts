// 流式增量的推送（规格第 5 节）：agent 回复的中间增量只推送、不落盘，每个会话每 100 毫秒最多推一帧
// （换了一条消息也一样：间隔按会话算，不按消息算）。
// 一帧里是这段时间攒下的增量，每段写明落在第几个 part、从第几个字符起，前端据此发现漏掉的增量。
// 消息定稿（或回合结束）时，还没推出去的增量直接丢掉：定稿消息取而代之。
// 节流用 util/throttle.ts（活动状态的进度也用它）。
import { type ConversationId, EVENT_TYPES, type EventFrame, type StreamDelta, type StreamEventPayload } from "@ergou/protocol";
import { createKeyedThrottle } from "../util/throttle.ts";

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

export function createStreamHub(options: StreamHubOptions): StreamHub {
  const listeners = new Set<(frame: EventFrame) => void>();
  /** 每个会话正在流式的消息（间隔按会话算：换了一条消息，上一帧的时刻照样留着） */
  const active = new Map<ConversationId, ActiveStream>();

  const throttle = createKeyedThrottle<ConversationId>({
    intervalMs: options.intervalMs ?? 100,
    ...(options.now ? { now: options.now } : {}),
    flush(conversation) {
      const stream = active.get(conversation);
      if (!stream || stream.pending.length === 0) return false;
      const payload: StreamEventPayload = { messageId: stream.messageId, deltas: stream.pending };
      stream.pending = [];
      const frame: EventFrame = { channel: conversation, seq: options.lastSeq(conversation), type: EVENT_TYPES.stream, payload };
      for (const listener of listeners) listener(frame);
      return true;
    },
  });

  /** 不再流式这条消息（没推出去的丢掉）；上一帧的时刻留着，下一条消息的第一帧照样要和它隔开 */
  const stop = (conversation: ConversationId) => {
    throttle.cancel(conversation);
    active.delete(conversation);
  };

  return {
    delta(conversation, messageId, type, text) {
      if (text.length === 0) return;
      let stream = active.get(conversation);
      if (stream?.messageId !== messageId) {
        stop(conversation);
        stream = { messageId, parts: [], pending: [] };
        active.set(conversation, stream);
      }
      // 和上一个 part 同类就接着写，否则开一个新 part
      let index = stream.parts.length - 1;
      if (index < 0 || stream.parts[index]!.type !== type) {
        stream.parts.push({ type, text: "" });
        index += 1;
      }
      const part = stream.parts[index]!;
      const last = stream.pending.at(-1);
      if (last && last.part === index) last.text += text;
      else stream.pending.push({ part: index, type, offset: part.text.length, text });
      part.text += text;
      throttle.schedule(conversation);
    },
    end(conversation, messageId) {
      if (active.get(conversation)?.messageId === messageId) stop(conversation);
    },
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      throttle.close();
      active.clear();
      listeners.clear();
    },
  };
}
