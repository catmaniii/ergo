// 彻底删除（21 号票）时会话里的消息事件怎么改写（登记进记忆模块的改写函数表）：
// - 用户的消息（以及别的带原话的消息）：整条换成"已删除"标记，原文一个字不留；
// - 工具调用记录（07 的守卫接入：只有工具调用 part 的消息）：只把参数摘要、结果摘要换成删除标记，
//   工具名、命中的类别、判定、结果（done / blocked……）不变——界面上仍是一次工具调用，只是看不到原话。
import { EVENT_TYPES, type MessageEventPayload, type MessagePart, PURGED_TEXT } from "@ergou/protocol";
import { deletedMarker, purgedField, type PurgeRewriter } from "../events/purge.ts";

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

/** 只有工具调用 part 的消息：守卫接入追加的工具调用记录 */
export function isToolCallRecord(parts: readonly MessagePart[]): parts is ToolCallPart[] {
  return parts.length > 0 && parts.every((p) => p.type === "tool_call");
}

export const messagePurge: PurgeRewriter = {
  eventType: EVENT_TYPES.message,
  rewrite(event, context) {
    const p = event.payload as MessageEventPayload;
    if (!isToolCallRecord(p.message.parts)) return deletedMarker(event, context.deletedAt);
    const parts = p.message.parts.map((part): ToolCallPart => ({ ...part, argsSummary: PURGED_TEXT, ...purgedField(part, "resultSummary") }));
    return { ...p, message: { ...p.message, parts } } satisfies MessageEventPayload;
  },
};
