// 临时事件的推送（只推给正连着的前端，不落盘、不补发）：到点的提醒这类"马上告诉用户"的通知走这里。
// 流式增量有自己的节流推送（conversation/stream-hub.ts）；两者都由网关推给订阅了那个频道的前端。
import type { EventFrame } from "@ergo/protocol";

export interface EphemeralSource {
  /** 订阅推出去的临时事件帧；返回取消订阅的函数 */
  onFrame(listener: (frame: EventFrame) => void): () => void;
}

export interface EphemeralBus extends EphemeralSource {
  /** 推一帧（序号由调用方给：它所在频道当时最后一条落盘事件的序号） */
  publish(frame: EventFrame): void;
}

export function createEphemeralBus(): EphemeralBus {
  const listeners = new Set<(frame: EventFrame) => void>();
  return {
    publish(frame) {
      for (const listener of listeners) listener(frame);
    },
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
