// 彻底删除（规格第 14、15 节，21 号票）在事件这一层的约定：一条事件改写成什么，由拥有这类事件的模块写一个改写函数，
// 登记进记忆模块的改写函数表（memory/rewriters.ts）。规矩只有两条：
// - 消息事件（用户的消息）整条换成"已删除"标记（共享协议包的 DeletedEventPayload，08 号票定的格式）；
// - 别的事件只把带原话的文本字段（说明、参数里的原话、结果摘录）换成删除标记文字 PURGED_TEXT，
//   id、状态、决定这些结构字段原样保留：改写后派生视图整体重放，状态不能变（审批还是已批准、卡片还是已处理）。
import { type DeletedEventPayload, EVENT_TYPES, type MessageEventPayload, PURGED_TEXT } from "@ergou/protocol";
import type { StoredEvent } from "./event-store.ts";

/** 改写时知道的：什么时候删的、这次彻底删除了哪些素材（卡片上的摘录按它挑） */
export interface PurgeContext {
  deletedAt: string;
  materialIds: ReadonlySet<string>;
}

/** 一类事件的改写函数：给出改写后的负载 */
export interface PurgeRewriter {
  eventType: string;
  rewrite(event: StoredEvent, context: PurgeContext): unknown;
}

/** "已删除"标记：原来是消息的，留下消息 id 和发送时间（界面在原来的位置显示"已删除"），内容一个字不留 */
export function deletedMarker(event: StoredEvent, deletedAt: string): DeletedEventPayload {
  const message = event.type === EVENT_TYPES.message ? (event.payload as Partial<MessageEventPayload>).message : undefined;
  return { deleted: true, deletedAt, ...(message ? { messageId: message.id, messageTime: message.time } : {}) };
}

/** 一个值里的全部文字换成删除标记，结构（键、数组长度、数字、真假）不变：参数里的原话用 */
export function purgedStrings(value: unknown): unknown {
  if (typeof value === "string") return PURGED_TEXT;
  if (Array.isArray(value)) return value.map(purgedStrings);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, purgedStrings(v)]));
  return value;
}

/** 可选的文本字段：有就换成删除标记，没有就不加 */
export function purgedField<T extends object, K extends keyof T>(value: T, key: K): Partial<T> {
  return value[key] === undefined ? {} : ({ [key]: PURGED_TEXT } as unknown as Partial<T>);
}
