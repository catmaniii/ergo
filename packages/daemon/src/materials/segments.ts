// 切段与来源标记（规格第 15 节）：入库时按确定的规则切段，不靠模型判断。纯函数：同样的输入永远切出同样的段。
// - 用户自己打的字：本人；判断不了的纯文本：默认本人；
// - 引用块、附件、抓取的网页：外部、不可信；
// - 用户接受了 agent 的提议：算用户的选择（本人），注明"agent 先提出"；
// - 语音转写：本人，注明"转写"（第一阶段只预留）；
// - agent 的产出：agent。
// 只有本人的切段留下文字（素材模块另存原文副本）；其余只留引用（位置、媒体、网址、卡片）加内容哈希。
import { createHash } from "node:crypto";
import { isMediaId, type MessagePart } from "@ergou/protocol";
import type { MaterialSegment, MediaRef, SegmentLocator } from "./types.ts";

/** 切段的输入：一段来历清楚的内容。采集规则把原始记录拆成这些，再交给 segmentPieces 标来源 */
export type MaterialPiece =
  /** 用户自己打的字 */
  | { kind: "typed"; text: string; locator: SegmentLocator }
  /** 来历判断不了的纯文本 */
  | { kind: "text"; text: string; locator: SegmentLocator }
  /** 引用块（别人的话） */
  | { kind: "quote"; text: string; locator: SegmentLocator }
  /** 附件（图片、文件、视频） */
  | { kind: "attachment"; media: MediaRef; locator: SegmentLocator }
  /** 抓取的网页 */
  | { kind: "web_page"; url: string; text?: string; locator: SegmentLocator }
  /** 语音（附转写） */
  | { kind: "voice"; mediaId: string; transcript: string; locator: SegmentLocator }
  /** 用户接受的 agent 提议（比如点了建议卡上的"发起任务"）：text 是被接受的内容 */
  | { kind: "accepted_proposal"; text: string; locator: SegmentLocator }
  /** agent 的产出（卡片、计划草稿……）：只留引用和哈希 */
  | { kind: "agent_output"; text?: string; cardId?: string; locator: SegmentLocator };

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const isBlank = (text: string | undefined) => text === undefined || text.trim().length === 0;

/** 给每段内容标来源；只有空白的段丢掉 */
export function segmentPieces(pieces: readonly MaterialPiece[]): MaterialSegment[] {
  const segments: MaterialSegment[] = [];
  for (const piece of pieces) {
    const segment = segmentOf(piece);
    if (segment) segments.push(segment);
  }
  return segments;
}

function segmentOf(piece: MaterialPiece): MaterialSegment | undefined {
  const { locator } = piece;
  switch (piece.kind) {
    case "typed":
    case "text":
      if (isBlank(piece.text)) return undefined;
      return selfSegment(piece.kind, piece.text, locator, []);
    case "accepted_proposal":
      if (isBlank(piece.text)) return undefined;
      return selfSegment("choice", piece.text, locator, ["agent_proposed"]);
    case "voice":
      if (isBlank(piece.transcript)) return undefined;
      return { ...selfSegment("voice", piece.transcript, locator, ["transcribed"]), media: { mediaId: piece.mediaId } };
    case "quote":
      if (isBlank(piece.text)) return undefined;
      return { form: "quote", source: "external_untrusted", notes: [], locator, sha256: sha256Hex(piece.text) };
    case "attachment": {
      // 媒体 id 就是入库版本的 sha256（09 号票）；不是哈希形状的就不写内容哈希
      const hash = isMediaId(piece.media.mediaId) ? piece.media.mediaId : undefined;
      return { form: "attachment", source: "external_untrusted", notes: [], locator, media: { ...piece.media }, ...(hash === undefined ? {} : { sha256: hash }) };
    }
    case "web_page":
      return {
        form: "web_page",
        source: "external_untrusted",
        notes: [],
        locator,
        url: piece.url,
        sha256: sha256Hex(piece.text ?? piece.url),
      };
    case "agent_output":
      return {
        form: "agent_output",
        source: "agent",
        notes: [],
        locator,
        ...(piece.text === undefined ? {} : { sha256: sha256Hex(piece.text) }),
        ...(piece.cardId === undefined ? {} : { cardId: piece.cardId }),
      };
  }
}

function selfSegment(form: MaterialSegment["form"], text: string, locator: SegmentLocator, notes: MaterialSegment["notes"]): MaterialSegment {
  return { form, source: "self", notes, locator, text, sha256: sha256Hex(text) };
}

/** 用户消息切段：消息的每个 part 拆成内容段，再标来源 */
export function segmentMessage(parts: readonly MessagePart[]): MaterialSegment[] {
  return segmentPieces(messagePieces(parts));
}

/** 用户消息的 part → 内容段。文字 part 里的引用块单独成段，其余的字是用户自己打的 */
export function messagePieces(parts: readonly MessagePart[]): MaterialPiece[] {
  const pieces: MaterialPiece[] = [];
  parts.forEach((part, index) => {
    switch (part.type) {
      case "text":
        pieces.push(...splitQuotes(part.text, index));
        break;
      case "image":
      case "file":
        pieces.push({ kind: "attachment", media: { mediaId: part.mediaId, name: part.name, mime: part.mime }, locator: { part: index } });
        break;
      case "video":
        pieces.push({ kind: "attachment", media: { mediaId: part.mediaId }, locator: { part: index } });
        break;
      case "voice":
        pieces.push({ kind: "voice", mediaId: part.mediaId, transcript: part.transcript, locator: { part: index } });
        break;
      case "card_ref":
        pieces.push({ kind: "agent_output", cardId: part.cardId, locator: { part: index } });
        break;
      default:
        // 推理、工具调用、TTS 音频、工单分隔线不会出现在用户消息里；出现了也不算用户的内容
        break;
    }
  });
  return pieces;
}

/** Markdown 引用块的行：行首最多三个空格，接着是 > */
const QUOTE_LINE = /^ {0,3}>/;

/**
 * 把一段文字按引用块切开：连续的引用行成一段引用，其余（含空行）是用户打的字。
 * 空行和不以 > 开头的行都结束引用块（不做 Markdown 的惰性续行：拿不准的算本人）。
 * 每段去掉首尾空白，位置指向去掉之后的范围。
 */
function splitQuotes(text: string, part: number): MaterialPiece[] {
  const pieces: MaterialPiece[] = [];
  let groupStart = 0;
  let groupIsQuote: boolean | undefined;
  const flush = (end: number) => {
    if (groupIsQuote === undefined) return;
    const range = trimmedRange(text, groupStart, end);
    if (range) {
      const slice = text.slice(range.start, range.end);
      const locator = { part, start: range.start, end: range.end };
      pieces.push(groupIsQuote ? { kind: "quote", text: slice, locator } : { kind: "typed", text: slice, locator });
    }
  };
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const quote = QUOTE_LINE.test(line);
    if (quote !== groupIsQuote) {
      flush(offset);
      groupStart = offset;
      groupIsQuote = quote;
    }
    offset += line.length;
  }
  flush(offset);
  return pieces;
}

function trimmedRange(text: string, start: number, end: number): { start: number; end: number } | undefined {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  return s < e ? { start: s, end: e } : undefined;
}
