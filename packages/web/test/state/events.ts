// 手写事件序列用的小工具：造事件帧、消息信封、卡片和待我处理事项。
import type { Card, ConversationId, EventFrame, InboxItem, MessageEnvelope, Speaker } from "../../src/state/index.ts";

export function frame(channel: string, seq: number, type: string, payload: unknown): EventFrame {
  return { channel, seq, type, payload };
}

export function textMessage(id: string, speaker: Speaker, text: string, conversation: ConversationId = "secretary"): MessageEnvelope {
  return { id, conversation, speaker, time: "2026-10-07T09:00:00+08:00", parts: [{ type: "text", text }] };
}

export function card(id: string, version: number, overrides: Partial<Card> = {}): Card {
  return {
    id,
    type: "quick_action",
    typeVersion: 1,
    version,
    status: "pending",
    payload: {},
    text: "一张卡",
    createdAt: "2026-10-07T09:00:00+08:00",
    ...overrides,
  };
}

/** 一条通知类事项（默认不卡任务、未读、没置顶） */
export function inboxItem(id: string, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    version: 1,
    kind: "notice",
    notice: "backup_failed",
    title: id,
    source: "系统",
    urgency: "non_blocking",
    pinned: false,
    actions: ["知道了"],
    createdAt: "2026-10-07T09:00:00.000+08:00",
    read: false,
    archived: false,
    deleted: false,
    ...overrides,
  };
}
