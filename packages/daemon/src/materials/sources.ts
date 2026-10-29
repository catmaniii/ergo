// 本票接上的素材来源：用户发言（04 号票的消息事件）、卡片被关闭（06 号票）、建议卡和提问卡长期没处理（本票计时）。
// 其余来源由产生它们的票按 capture.ts 的接口登记。
// 129 号票起：用户发言、卡片被关闭是素材库自带的（BUILTIN_SOURCES，素材库打开时就登记）；长期没处理（card_stale 是记忆插件的回避信号计时
// 追加的）由记忆插件在它的数据契约里声明（memory/plugin.ts）。
// 彻底删除（21 号票）时这些事件怎么改写：用户的消息整条换成"已删除"标记（conversation/purge.ts）；
// 卡片被关闭、长期没处理的事件只把说明和卡片的纯文本降级换成删除标记，别的不变（cardDismissedPurge 内核登记，cardStalePurge 记忆插件的契约登记）。
import {
  type CardDismissedEventPayload,
  type CardStaleEventPayload,
  type CardType,
  EVENT_TYPES,
  INTERVIEW_CONTEXT,
  INTERVIEW_QUESTION_FIELD,
  MAINTAINER_CHANNEL_PREFIX,
  type MessageEventPayload,
  type MessagePart,
  t,
} from "@ergo/protocol";
import type { PurgeRewriter } from "../events/purge.ts";
import { purgedField } from "../events/purge.ts";
import type { MaterialSource } from "./capture.ts";
import { type MaterialPiece, segmentMessage, segmentPieces } from "./segments.ts";
import type { MaterialSegment } from "./types.ts";

/** 不算素材的卡片：批准设备配对不算（规格第 21 节），关掉配对请求也不算回避 */
const NON_MATERIAL_CARD_TYPES: readonly CardType[] = ["pairing"];

/** 会话的种类，作为情境标签（用户发言、显式记忆命令的素材都用它） */
export function conversationKind(conversation: string): string {
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
 * 访谈里的一句话（284 号票）：管理员问的那一句作为上下文排在用户的话前面——一段 agent 的产出，只记说明"记忆管理员问：……"
 * （进关键词索引、当晚整理时连着用户的话读），不算本人的话、不存进原文。没有问的那句（访谈以外、管理员还没开口）是空的
 */
export function interviewQuestionSegments(question: string | undefined): MaterialSegment[] {
  if (question === undefined || question.trim() === "") return [];
  return segmentPieces([{ form: "agent_output", text: question, label: t("materials.interviewQuestion", { question }), locator: { field: INTERVIEW_QUESTION_FIELD } }]);
}

/** 素材信封上表示"这条消息里还有一段语音（转写另成一条素材）"的情境标签 */
export const WITH_VOICE_CONTEXT = "with_voice";

/**
 * 用户发言：任何会话里（秘书、维护者）用户发的消息，包括附件引用。
 * agent 的回复、系统说明（以及以后的工单、召回的记忆）都不是用户的话，不算。
 * 带"作为材料投喂"标记的消息记成用户主动投喂的材料。消息事件带了任务、项目 id（维护者会话）就记上。
 * 语音消息（31 号票）的文字要等识别完成，由识别完成的语音对象另产生一条（voice/material-source.ts）；
 * 语音连同附件一起发的（2026-10-10 起），附件照常由消息产生一条（只有附件和引用的卡片的切段，情境标签带 with_voice），
 * 识别失败的语音不耽误附件记成素材、"作为材料投喂"照样算数。
 * 秘书转达进任务、项目维护者会话的话（103 号票，标着 relayedBy）不算：那是秘书写的，用户的原话已经在秘书会话里采过。
 * 接管时导进来的前情（290 号票，标着 prelude）不算：那是用户跟运行时（Claude Code）说的，原文留在运行时自己的记录里；
 * 交给官方 App 期间只读跟随补记的（292 号票，标着 remote）同样不算。
 * 了解你访谈（284 号票）开着时在记忆管理员的会话里说的：消息的归属里带着访谈编号（interviewId），情境标签多一个 interview（"来自访谈"）；
 * 归属里带着管理员问的那一句（interviewQuestion）的，那一句作为上下文切段排在用户的话前面（interviewQuestionSegments）。
 */
const userMessageSource: MaterialSource = {
  name: "user-message",
  eventType: EVENT_TYPES.message,
  capture(event) {
    const payload = event.payload as Partial<MessageEventPayload>;
    const message = payload.message;
    // 前情（290 号票）：接管时从运行时自己的记录导进来的，是用户跟运行时说的（原文在运行时那边），不采
    if (message?.speaker !== "user" || message.relayedBy !== undefined || message.prelude === true || message.remote === true) return [];
    const spoken = message.parts.some((p) => p.type === "voice");
    // 只有语音（可能带引用的卡片）的消息：素材全由识别完成的语音对象产生
    if (spoken && !message.parts.some((p) => p.type === "image" || p.type === "file")) return [];
    const own = segmentMessage(message.parts);
    const context = [conversationKind(message.conversation)];
    if (own.some((s) => s.form === "quote")) context.push("with_quote");
    if (own.some((s) => s.form === "attachment")) context.push("with_attachment");
    if (spoken) context.push(WITH_VOICE_CONTEXT);
    if (payload.interviewId !== undefined) context.push(INTERVIEW_CONTEXT);
    // 访谈里的：管理员问的那一句排在前面（上下文，不是本人的话）
    const segments = payload.interviewId === undefined ? own : [...interviewQuestionSegments(payload.interviewQuestion), ...own];
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

/** 回避信号：建议卡、提问卡长期没处理。这是系统观察到的（来源：系统）。记忆插件的数据契约声明它（129 号票） */
export const cardStaleSource: MaterialSource = {
  name: "card-stale",
  eventType: EVENT_TYPES.cardStale,
  capture(event) {
    const p = event.payload as CardStaleEventPayload;
    return [{ kind: "avoidance_signal", source: "system", time: p.time, context: ["stale", `card:${p.cardType}`], segments: segmentPieces([cardPiece(p)]), ref: { cardId: p.cardId } }];
  },
};

/** 素材库自带的来源：用户发言、卡片被关闭（会话、卡片是内核的；这两类事件不管记忆插件开没开都在） */
export const BUILTIN_SOURCES: readonly MaterialSource[] = [userMessageSource, cardDismissedSource];

/** 彻底删除：卡片被关闭、长期没处理的事件只换掉用户的说明和卡片的纯文本降级，卡片 id、类型、动作、时间不变 */
const cardSignalPurge = (eventType: typeof EVENT_TYPES.cardDismissed | typeof EVENT_TYPES.cardStale): PurgeRewriter => ({
  eventType,
  rewrite: (event) => {
    const p = event.payload as CardDismissedEventPayload | CardStaleEventPayload;
    return { ...p, ...("note" in p ? purgedField(p, "note") : {}), ...purgedField(p, "cardText") };
  },
});

/** 卡片被关闭（内核在组合根里登记） */
export const cardDismissedPurge: PurgeRewriter = cardSignalPurge(EVENT_TYPES.cardDismissed);
/** 卡片长期没处理（记忆插件的数据契约登记：停用也照样登记，彻底删除照常） */
export const cardStalePurge: PurgeRewriter = cardSignalPurge(EVENT_TYPES.cardStale);
