// agent 的回复落进会话时的两个小规矩（秘书和维护者共用）。
import { type MessagePart, partLabel } from "@ergo/protocol";
import type { FinalPart } from "../runtime/index.ts";

/**
 * 定稿消息里落盘的 part：正文和推理。工具调用 part 要等守卫判定、执行完才知道结果，
 * 由守卫接入在调用结束时另追加一条（guard-runtime/guard-runtime.ts）
 */
export function finalParts(parts: readonly FinalPart[]): MessagePart[] {
  const out: MessagePart[] = [];
  for (const part of parts) {
    if (part.type === "thinking" && part.text.length > 0) out.push({ type: "reasoning", text: part.text });
    else if (part.type === "text" && part.text.length > 0) out.push({ type: "text", text: part.text });
  }
  return out;
}

/** 系统说明里引用被打断的那条消息时，最多引这么多字 */
const QUOTE_MAX = 30;

/** 引用一条消息的开头（系统说明里用）：文字原样，附件写成文件名 */
export function quoteMessage(parts: readonly MessagePart[]): string {
  const text = parts.map(partLabel).join(" ").replace(/\s+/g, " ").trim();
  return text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX)}…` : text;
}
