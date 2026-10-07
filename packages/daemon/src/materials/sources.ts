// 本票接上的素材来源：用户发言（04 号票的消息事件）、卡片被关闭（06 号票）、建议卡和提问卡长期没处理（本票计时）。
// 其余来源由产生它们的票按 capture.ts 的接口登记。
import {
  type CardDismissedEventPayload,
  type CardStaleEventPayload,
  type CardType,
  EVENT_TYPES,
  MAINTAINER_CHANNEL_PREFIX,
  type MessageEventPayload,
  type MessagePart,
} from "@ergou/protocol";
import type { MaterialSource } from "./capture.ts";
import { type MaterialPiece, segmentMessage, segmentPieces } from "./segments.ts";

/** 不算素材的卡片：批准设备配对不算（规格第 21 节），关掉配对请求也不算回避 */
const NON_MATERIAL_CARD_TYPES: readonly CardType[] = ["pairing"];

/** 会话的种类，作为情境标签 */
function conversationKind(conversation: string): string {
  return conversation.startsWith(MAINTAINER_CHANNEL_PREFIX) ? "maintainer" : conversation;
}

/** 用户主动投喂的：附件菜单里"作为材料投喂"发出的 part 带 asMaterial */
function isFed(part: MessagePart): boolean {
  return "asMaterial" in part && part.asMaterial === true;
}

/** 被关掉、没处理的那张卡：只留引用和说明（类型和标题进关键词索引），卡片内容是 agent 的产出 */
function cardPiece(p: { cardId: string; cardType: string; cardText?: string | undefined }): MaterialPiece {
  return { form: "agent_output", cardId: p.cardId, label: p.cardText ?? p.cardType, locator: { field: "cardText" } };
}

/**
 * 用户发言：任何会话里（秘书、维护者）用户发的消息，包括附件引用。
 * agent 的回复、系统说明（以及以后的工单、召回的记忆）都不是用户的话，不算。
 * 带"作为材料投喂"标记的消息记成用户主动投喂的材料。消息事件带了任务、项目 id（维护者会话）就记上。
 */
const userMessageSource: MaterialSource = {
  name: "user-message",
  eventType: EVENT_TYPES.message,
  capture(event) {
    const payload = event.payload as Partial<MessageEventPayload>;
    const message = payload.message;
    if (message?.speaker !== "user") return [];
    const segments = segmentMessage(message.parts);
    const context = [conversationKind(message.conversation)];
    if (segments.some((s) => s.form === "quote")) context.push("with_quote");
    if (segments.some((s) => s.form === "attachment")) context.push("with_attachment");
    if (segments.some((s) => s.form === "voice")) context.push("voice");
    return [
      {
        kind: message.parts.some(isFed) ? "fed_material" : "user_utterance",
        source: "self",
        time: message.time,
        conversation: message.conversation,
        ...(payload.taskId === undefined ? {} : { task: payload.taskId }),
        ...(payload.projectId === undefined ? {} : { project: payload.projectId }),
        context,
        segments,
        ref: { messageId: message.id },
      },
    ];
  },
};

/** 回避信号：用户关掉了一张卡（不处理）。关掉是用户做的（本人）；关掉时写的说明是用户自己的话 */
const cardDismissedSource: MaterialSource = {
  name: "card-dismissed",
  eventType: EVENT_TYPES.cardDismissed,
  capture(event) {
    const p = event.payload as CardDismissedEventPayload;
    if ((NON_MATERIAL_CARD_TYPES as readonly string[]).includes(p.cardType)) return [];
    const pieces: MaterialPiece[] = [cardPiece(p)];
    if (p.note !== undefined) pieces.push({ form: "typed", text: p.note, locator: { field: "note" } });
    return [
      {
        kind: "avoidance_signal",
        source: "self",
        time: p.time,
        context: ["dismissed", `card:${p.cardType}`, `action:${p.action}`],
        segments: segmentPieces(pieces),
        ref: { cardId: p.cardId },
      },
    ];
  },
};

/** 回避信号：建议卡、提问卡长期没处理。这是系统观察到的（来源：系统） */
const cardStaleSource: MaterialSource = {
  name: "card-stale",
  eventType: EVENT_TYPES.cardStale,
  capture(event) {
    const p = event.payload as CardStaleEventPayload;
    return [{ kind: "avoidance_signal", source: "system", time: p.time, context: ["stale", `card:${p.cardType}`], segments: segmentPieces([cardPiece(p)]), ref: { cardId: p.cardId } }];
  },
};

export const BUILTIN_SOURCES: readonly MaterialSource[] = [userMessageSource, cardDismissedSource, cardStaleSource];
