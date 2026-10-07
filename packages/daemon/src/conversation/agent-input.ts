// 会话里的一条输入交给 agent 之前的样子（秘书和维护者共用）：带版本号的投影（conversation/model-projection.ts：
// 时间标记、卡片换成一行摘要、附件按规则内联或只给名字），支持视觉的模型另外收到图片；
// 运行时的通知（发言方是 system 的 agentInput 消息）开头标 SYSTEM_NOTICE_TAG，免得模型当成用户说的。
import fs from "node:fs";
import type { MessageEnvelope, MessagePart } from "@ergou/protocol";
import { getCard } from "../cards/views.ts";
import type { EventStore } from "../events/event-store.ts";
import { loadAttachmentContents } from "../media/attachment-content.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { InputImage } from "../runtime/index.ts";
import { SYSTEM_NOTICE_TAG } from "./messages.ts";
import { MODEL_PROJECTION_VERSION, projectForModel } from "./model-projection.ts";

export interface AgentInputContext {
  store: EventStore;
  media: MediaStore;
  /** 消息前的时间标记按它换算（配置的 timeZone） */
  timeZone: string;
  /** 模型支不支持图片输入 */
  vision: boolean;
}

/** 消息里引用的卡片的一行摘要：卡片的纯文本降级版本（卡片类型注册表的 toText 生成、存在卡片里的 text） */
function cardSummaries(store: EventStore, parts: readonly MessagePart[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "card_ref") continue;
    const card = getCard(store.reader, part.cardId);
    if (card) out[part.cardId] = card.text;
  }
  return out;
}

/** 一条输入交给 agent 时的文字和图片（附件的内容要读文件、PDF 还要抽文本，所以是异步的） */
export async function prepareAgentInput(ctx: AgentInputContext, message: MessageEnvelope): Promise<{ text: string; images: InputImage[] }> {
  const attachments = await loadAttachmentContents(ctx.media, message.parts, MODEL_PROJECTION_VERSION);
  const projected = projectForModel({
    version: MODEL_PROJECTION_VERSION,
    parts: message.parts,
    sentAt: message.time,
    timeZone: ctx.timeZone,
    vision: ctx.vision,
    attachments,
    cards: cardSummaries(ctx.store, message.parts),
  });
  const images: InputImage[] = [];
  for (const image of projected.images) {
    if (!ctx.media.info(image.mediaId)) continue;
    images.push({ mime: image.mime, data: fs.readFileSync(ctx.media.filePath(image.mediaId)).toString("base64") });
  }
  const text = message.speaker === "system" ? `${SYSTEM_NOTICE_TAG}\n${projected.text}` : projected.text;
  return { text, images };
}
