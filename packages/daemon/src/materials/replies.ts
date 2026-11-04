// 素材的"回的是什么"在素材库这一侧（判它的在记忆插件里，memory/reply-context.ts）：
// - 素材频道上的 material_replies 事件怎么变成素材上的标记（replyRecordsOf）：同"别推断"由记忆命令事件派生——
//   不进原文副本，materials.db 重建、从原文副本补回时照样标上；同一条素材后来的覆盖先前的；
//   总结换成了删除标记的（彻底删除过）、种类不认得的不挂；
// - 彻底删除时怎么改写（materialRepliesPurge）：这次删的素材那几项的总结换成删除标记，别的项、种类、前文是哪条消息不变；
//   删任务、删项目时连会话一起删的，那个会话里的几项同样换掉（cleared，memory/deletion-participants.ts）。
// 读的时候总结就在素材的 reply 上（memory-db.ts 的 material_replies）。
import { EVENT_TYPES, isDeletedEventPayload, MATERIAL_REPLY_VERDICTS, type MaterialRepliesEventPayload, type MaterialReplyItem, PURGED_TEXT } from "@ergo/protocol";
import type { StoredEvent } from "../events/event-store.ts";
import type { PurgeRewriter } from "../events/purge.ts";
import type { ReplyRecord } from "./memory-db.ts";

const VERDICTS: ReadonlySet<string> = new Set(MATERIAL_REPLY_VERDICTS);

/** 一条 material_replies 事件对素材的作用（不是这类事件、彻底删除整条改写过的，没有） */
export function replyRecordsOf(event: StoredEvent): ReplyRecord[] | undefined {
  if (event.type !== EVENT_TYPES.materialReplies || isDeletedEventPayload(event.payload)) return undefined;
  const items = (event.payload as Partial<MaterialRepliesEventPayload>).items;
  if (!Array.isArray(items)) return undefined;
  return items.flatMap((item): ReplyRecord[] => {
    if (typeof item?.materialId !== "string" || !VERDICTS.has(item.verdict)) return [];
    // 总结被彻底删除换成了标记：当没挂（判过了，不再判）
    const summary = typeof item.summary === "string" && item.summary !== PURGED_TEXT && item.summary.trim() !== "" ? item.summary : undefined;
    const verdict = item.verdict === "reply" && summary === undefined ? "cleared" : item.verdict;
    return [{ materialId: item.materialId, verdict, ...(summary === undefined ? {} : { summary }), ...(item.fromMessageId === undefined ? {} : { fromMessageId: item.fromMessageId }) }];
  });
}

/** 一项的总结换成删除标记（别的不变） */
export function purgedReplyItem(item: MaterialReplyItem): MaterialReplyItem {
  return item.summary === undefined ? item : { ...item, summary: PURGED_TEXT };
}

/** 彻底删除：这次删的素材那几项的总结换成删除标记（彻底删除那一套按素材 id 找到这类事件，memory/purge.ts） */
export const materialRepliesPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.materialReplies,
  rewrite(event, context) {
    const p = event.payload as MaterialRepliesEventPayload;
    return { ...p, items: p.items.map((item) => (context.materialIds.has(item.materialId) ? purgedReplyItem(item) : item)) } satisfies MaterialRepliesEventPayload;
  },
};
