// 彻底删除提交之后要做的、不在事件日志里的事，都由会话频道上的 messages_purged 驱动：
// - 附件的媒体文件：被删的消息引用过的媒体，没有别的（未删的）消息、也没有素材还引用它，就删掉媒体文件
//   （含派生文件）。启动时把以前的 messages_purged 再对一遍（上次删到一半被杀也补上；删过的不在了就跳过）；
// - 会话文件：要改写哪些原话由这里从 messages_purged 生成（sessionRewriteFor），拉起 agent 的模块只负责停、改、拉起。
// 记下来的文件（"这张图记下来"）不在消息里，由忘掉、彻底删除的记忆命令带着（mediaIds），走同一份清理；草稿区里放的那一份（取元素内容时放的）一起删。
import { EVENT_TYPES, isDeletedEventPayload, type MemoryCommandEventPayload, type MessagesPurgedEventPayload, PURGED_SUMMARY_TEXT, PURGED_TEXT } from "@ergo/protocol";
import { removeElementScratch } from "../browsing/api.ts";
import { mediaInUse } from "../conversation/attachments-view.ts";
import { isConversationChannel } from "../conversation/history.ts";
import type { EventStore } from "../events/event-store.ts";
import type { MediaStore } from "../media/media-store.ts";
import { MATERIALS_CHANNEL, type Materials } from "../materials/index.ts";
import { INPUT_CONTEXT_TYPE, SCOPE_REVIEW_ENTRY, type SessionRewriteRequest } from "../runtime/index.ts";
import { ASK_CURATOR, ASK_MEMORY, SEARCH_MATERIALS } from "./tool-names.ts";

export interface SessionRewriteSources {
  /**
   * 被删素材在推理库里的证据编号（purged-evidence.ts 的 purgedEvidenceIds）：问记忆的结果按证据编号引原话。
   * 不给（老的装配、测试）就不改问记忆的结果
   */
  evidenceOf?: (materialIds: readonly string[]) => readonly string[];
}

/**
 * 会话文件里要改写的原话（会话目录由调用方定）：被删的用户输入、提议"记住"的工具调用、素材检索结果里提到被删素材的行；
 * 问记忆（ask_memory）结果里提到被删素材的证据编号的行，连同这一条下面的续行（记录的原话、精炼）；
 * 问记忆管理员（ask_curator）的回答里提到这些证据编号、被删素材 id 的行，同样连同续行；
 * 每条消息的记忆简报（跟在用户输入后面的上下文消息）里提到这些证据编号的行，同样连同续行；
 * 负责人会话里范围审视结果的副本（副本里可能引着被删的话，整个换掉）
 */
export function sessionRewriteFor(purges: readonly MessagesPurgedEventPayload[], sources: SessionRewriteSources = {}): Omit<SessionRewriteRequest, "sessionDir"> {
  const materialIds = [...new Set(purges.flatMap((p) => p.materialIds))];
  const evidenceIds = materialIds.length === 0 ? [] : [...new Set(sources.evidenceOf?.(materialIds) ?? [])];
  return {
    inputIds: [...new Set(purges.flatMap((p) => p.messages.filter((m) => m.replacement === undefined).map((m) => m.messageId)))],
    toolCallIds: [...new Set(purges.flatMap((p) => p.toolCallIds))],
    toolResultLines: [
      ...(materialIds.length === 0 ? [] : [{ toolName: SEARCH_MATERIALS, needles: materialIds }]),
      ...(evidenceIds.length === 0 ? [] : [{ toolName: ASK_MEMORY, needles: evidenceIds, continuation: true }]),
      // 问记忆管理员的回答是它自己写的话，按提示词引证据编号，也可能提素材 id（要忘掉哪一条）
      ...(materialIds.length === 0 ? [] : [{ toolName: ASK_CURATOR, needles: [...evidenceIds, ...materialIds], continuation: true }]),
    ],
    contextLines: evidenceIds.length === 0 ? [] : [{ customType: INPUT_CONTEXT_TYPE, needles: evidenceIds, continuation: true }],
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
  /** 草稿区（取元素内容时放在这里的一份随媒体一起删） */
  scratchDir?: string;
  log: (line: string) => void;
}

/**
 * 这条事件说要清理的媒体：会话频道上的 messages_purged（被删的消息引用过的）；素材频道上忘掉、彻底删除的记忆命令（记下来的文件）。
 * 素材库先于这里订阅事件日志，到这里时这些素材已经不算引用了
 */
function mediaToClean(event: { channel: string; type: string; payload: unknown }): readonly string[] {
  if (isPurge(event)) return (event.payload as MessagesPurgedEventPayload).mediaIds;
  if (event.type !== EVENT_TYPES.memoryCommand || event.channel !== MATERIALS_CHANNEL || isDeletedEventPayload(event.payload)) return [];
  const command = event.payload as MemoryCommandEventPayload;
  return command.command === "remember" ? [] : (command.mediaIds ?? []);
}

/** 删掉彻底删除（还有忘掉）之后没人引用的媒体文件：先对一遍以前的，再跟着新的事件；返回停止的函数 */
export function startPurgedMediaCleanup(options: PurgedMediaCleanupOptions): () => void {
  const { store, media, materials, scratchDir, log } = options;
  const cleanup = (mediaIds: readonly string[]) => {
    for (const mediaId of mediaIds) {
      if (mediaInUse(store.reader, mediaId) || materials.referencesMedia(mediaId)) continue;
      try {
        // 先删草稿区的：中途被杀时媒体还在，下次启动再来一遍
        if (scratchDir !== undefined) removeElementScratch(scratchDir, mediaId);
        if (!media.info(mediaId)) continue;
        media.remove(mediaId);
        log(`彻底删除：删掉了没人引用的媒体 ${mediaId}`);
      } catch (err) {
        log(`彻底删除：删媒体 ${mediaId} 出错，下次启动时再删：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  const unsubscribe = store.onAppend((event) => cleanup(mediaToClean(event)));
  for (const type of [EVENT_TYPES.messagesPurged, EVENT_TYPES.memoryCommand]) for (const event of store.ofType(type)) cleanup(mediaToClean(event));
  return unsubscribe;
}
