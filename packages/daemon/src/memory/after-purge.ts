// 彻底删除（21 号票）提交之后要做的、不在事件日志里的事，都由会话频道上的 messages_purged 驱动：
// - 附件的媒体文件：被删的消息引用过的媒体，没有别的（未删的）消息、也没有素材还引用它，就删掉媒体文件
//   （含派生文件）。启动时把以前的 messages_purged 再对一遍（上次删到一半被杀也补上；删过的不在了就跳过）；
// - 会话文件：要改写哪些原话由这里从 messages_purged 生成（sessionRewriteFor），拉起 agent 的模块只负责停、改、拉起。
import { EVENT_TYPES, type MessagesPurgedEventPayload, PURGED_SUMMARY_TEXT, PURGED_TEXT } from "@ergou/protocol";
import { mediaInUse } from "../conversation/attachments-view.ts";
import { isConversationChannel } from "../conversation/history.ts";
import type { EventStore } from "../events/event-store.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { Materials } from "../materials/index.ts";
import { SCOPE_REVIEW_ENTRY, type SessionRewriteRequest } from "../runtime/index.ts";
import { SEARCH_MATERIALS } from "./tool-names.ts";

/**
 * 会话文件里要改写的原话（会话目录由调用方定）：被删的用户输入、提议"记住"的工具调用、素材检索结果里提到被删素材的行；
 * 维护者会话里范围审视结果的副本（18 号票：副本里可能引着被删的话，整个换掉）
 */
export function sessionRewriteFor(purges: readonly MessagesPurgedEventPayload[]): Omit<SessionRewriteRequest, "sessionDir"> {
  const materialIds = [...new Set(purges.flatMap((p) => p.materialIds))];
  return {
    inputIds: [...new Set(purges.flatMap((p) => p.messages.filter((m) => m.replacement === undefined).map((m) => m.messageId)))],
    toolCallIds: [...new Set(purges.flatMap((p) => p.toolCallIds))],
    toolResultLines: materialIds.length === 0 ? [] : [{ toolName: SEARCH_MATERIALS, needles: materialIds }],
    marker: PURGED_TEXT,
    summaryMarker: PURGED_SUMMARY_TEXT,
    customTypes: [SCOPE_REVIEW_ENTRY],
  };
}

/** 会话频道上的 messages_purged */
function isPurge(event: { channel: string; type: string }): boolean {
  return event.type === EVENT_TYPES.messagesPurged && isConversationChannel(event.channel);
}

export interface PurgedMediaCleanupOptions {
  store: EventStore;
  media: MediaStore;
  materials: Materials;
  log: (line: string) => void;
}

/** 删掉彻底删除之后没人引用的媒体文件：先对一遍以前的，再跟着新的 messages_purged；返回停止的函数 */
export function startPurgedMediaCleanup(options: PurgedMediaCleanupOptions): () => void {
  const { store, media, materials, log } = options;
  const cleanup = (payload: MessagesPurgedEventPayload) => {
    for (const mediaId of payload.mediaIds) {
      if (!media.info(mediaId) || mediaInUse(store.reader, mediaId) || materials.referencesMedia(mediaId)) continue;
      try {
        media.remove(mediaId);
        log(`彻底删除：删掉了没人引用的媒体 ${mediaId}`);
      } catch (err) {
        log(`彻底删除：删媒体 ${mediaId} 出错，下次启动时再删：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  const unsubscribe = store.onAppend((event) => {
    if (isPurge(event)) cleanup(event.payload as MessagesPurgedEventPayload);
  });
  for (const event of store.ofType(EVENT_TYPES.messagesPurged)) if (isPurge(event)) cleanup(event.payload as MessagesPurgedEventPayload);
  return unsubscribe;
}
