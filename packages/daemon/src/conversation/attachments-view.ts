// 派生视图：每个会话里出现过的附件（消息里的图片 part 和文件 part，不论谁发的）。随消息事件在同一事务里更新，
// 可以从事件日志重建。"读取附件"工具据此保证 agent 只能读自己会话里的附件。
// 09 号票之前的消息只有文本，所以这张表在已有的数据目录里从空开始也不缺东西。
import { type ConversationId, EVENT_TYPES, type MessageEventPayload } from "@ergou/protocol";
import type { DerivedView } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";

export const conversationAttachmentsView: DerivedView = {
  name: "conversation_attachments",
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_attachments (
        conversation TEXT NOT NULL,
        media_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER,
        message_id TEXT NOT NULL,
        global_seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_attachments_by_media ON conversation_attachments (media_id, conversation);
    `),
  clear: (db) => db.exec("DELETE FROM conversation_attachments"),
  apply(db, event) {
    if (event.type !== EVENT_TYPES.message) return;
    const { message } = event.payload as MessageEventPayload;
    for (const part of message.parts) {
      if (part.type !== "image" && part.type !== "file") continue;
      db.run(
        "INSERT INTO conversation_attachments (conversation, media_id, kind, name, mime, size, message_id, global_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        message.conversation,
        part.mediaId,
        part.type,
        part.name,
        part.mime,
        part.type === "file" ? part.size : null,
        message.id,
        event.globalSeq,
      );
    }
  },
};

/** 会话里的一个附件 */
export interface ConversationAttachment {
  mediaId: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  /** 文件附件的大小（图片没有记） */
  size: number | undefined;
}

interface AttachmentRow {
  media_id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number | null;
}

/**
 * 在某个会话里按附件引用找附件：完整的媒体 id，或者在这个会话里唯一的前缀（至少 8 位，模型抄长哈希时常截短）。
 * 同一份媒体在会话里出现过几次，取最近一次的名字和类型。找不到、或者前缀不唯一时为 undefined。
 */
export function findConversationAttachment(db: ReadonlyDatabase, conversation: ConversationId, ref: string): ConversationAttachment | undefined {
  const clean = refPrefix(ref);
  if (clean === undefined) return undefined;
  const rows = db.all<AttachmentRow>(
    `SELECT media_id, kind, name, mime, size FROM conversation_attachments
     WHERE conversation = ? AND media_id LIKE ? ORDER BY global_seq DESC`,
    conversation,
    `${clean}%`,
  );
  const ids = new Set(rows.map((r) => r.media_id));
  if (ids.size !== 1) return undefined;
  const row = rows[0]!;
  return { mediaId: row.media_id, kind: row.kind, name: row.name, mime: row.mime, size: row.size ?? undefined };
}

/** 还有没有消息引用这份媒体（任何会话）：彻底删除后决定能不能删媒体文件 */
export function mediaInUse(db: ReadonlyDatabase, mediaId: string): boolean {
  return db.get("SELECT 1 AS found FROM conversation_attachments WHERE media_id = ? LIMIT 1", mediaId) !== undefined;
}

/** 这份媒体出现在别的会话里（不在 conversation 里）吗 */
export function attachmentElsewhere(db: ReadonlyDatabase, conversation: ConversationId, ref: string): boolean {
  const clean = refPrefix(ref);
  if (clean === undefined) return false;
  return db.get("SELECT 1 AS found FROM conversation_attachments WHERE conversation <> ? AND media_id LIKE ? LIMIT 1", conversation, `${clean}%`) !== undefined;
}

/** 附件引用规整成媒体 id 的前缀：至少 8 位的十六进制（大小写都认）；不像附件引用时为 undefined */
function refPrefix(ref: string): string | undefined {
  const clean = ref.trim().toLowerCase();
  return /^[0-9a-f]{8,64}$/.test(clean) ? clean : undefined;
}
