// 手写事件序列用的小工具：造事件帧、消息信封和卡片。
import type { Card, EventFrame, MessageEnvelope, Speaker } from "../../src/state/index.ts";

export function frame(channel: string, seq: number, type: string, payload: unknown): EventFrame {
  return { channel, seq, type, payload };
}

export function textMessage(id: string, speaker: Speaker, text: string, conversation = "secretary"): MessageEnvelope {
  return { id, conversation, speaker, time: "2026-10-07T09:00:00+08:00", parts: [{ type: "text", text }] };
}

export function card(id: string, version: number, overrides: Partial<Card> = {}): Card {
  return {
    id,
    type: "quick_action",
    version,
    status: "pending",
    payload: {},
    createdAt: "2026-10-07T09:00:00+08:00",
    ...overrides,
  };
}
