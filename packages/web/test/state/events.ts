// 手写事件序列用的小工具：造事件帧、消息信封、卡片和待我处理事项。
import type { Card, CardInboxItem, ConversationId, ConversationItem, EventFrame, MessageEnvelope, NoticeInboxItem, Speaker } from "../../src/state/index.ts";

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

const itemBase = {
  version: 1,
  source: "系统",
  urgency: "non_blocking" as const,
  pinned: false,
  createdAt: "2026-10-07T09:00:00.000+08:00",
  read: false,
  archived: false,
  deleted: false,
};

/** 一条通知类事项（默认不卡任务、未读、没置顶） */
export function inboxItem(id: string, overrides: Partial<NoticeInboxItem> = {}): NoticeInboxItem {
  return { ...itemBase, id, kind: "notice", notice: "backup_failed", title: id, actions: ["知道了"], ...overrides };
}

/** 一条卡片事项 */
export function cardInboxItem(id: string, cardId: string, overrides: Partial<CardInboxItem> = {}): CardInboxItem {
  return { ...itemBase, id, kind: "card", cardId, title: id, ...overrides };
}

/** 会话视图里一条的消息（被彻底删除的条目没有消息，测试里遇到就是错） */
export function msg(item: ConversationItem): MessageEnvelope {
  if (item.kind === "deleted") throw new Error(`这一条已被彻底删除：${item.key}`);
  return item.message;
}
