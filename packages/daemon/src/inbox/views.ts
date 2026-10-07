// 待我处理的派生视图（ergou.db）：每条事项的最新状态，以及动作的幂等键落在了哪条事项的哪个版本上。
// 待我处理频道上的 inbox_item 事件就是事项的最新状态，视图按 id 留最后一条。读取函数只拿只读连接。
import { CHANNELS, EVENT_TYPES, type InboxItem, type InboxItemEventPayload } from "@ergou/protocol";
import type { DerivedView } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";

export const inboxView: DerivedView = {
  name: "inbox_items",
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_items (
        item_id TEXT PRIMARY KEY,
        card_id TEXT,
        deleted INTEGER NOT NULL,
        item TEXT NOT NULL,
        global_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox_action_keys (
        idempotency_key TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        version INTEGER NOT NULL
      );
    `),
  clear: (db) => db.exec("DELETE FROM inbox_items; DELETE FROM inbox_action_keys;"),
  apply(db, event) {
    if (event.channel !== CHANNELS.inbox || event.type !== EVENT_TYPES.inboxItem) return;
    const { item } = event.payload as InboxItemEventPayload;
    db.run(
      `INSERT INTO inbox_items (item_id, card_id, deleted, item, global_seq) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (item_id) DO UPDATE SET card_id = excluded.card_id, deleted = excluded.deleted, item = excluded.item`,
      item.id,
      item.cardId ?? null,
      item.deleted ? 1 : 0,
      JSON.stringify(item),
      event.globalSeq,
    );
    if (event.idempotencyKey !== null) {
      db.run("INSERT OR IGNORE INTO inbox_action_keys (idempotency_key, item_id, version) VALUES (?, ?, ?)", event.idempotencyKey, item.id, item.version);
    }
  },
};

/** 某条事项的最新状态（不存在是 undefined；删掉了的也返回，deleted 为 true） */
export function getInboxItem(db: ReadonlyDatabase, itemId: string): InboxItem | undefined {
  const row = db.get<{ item: string }>("SELECT item FROM inbox_items WHERE item_id = ?", itemId);
  return row && (JSON.parse(row.item) as InboxItem);
}

/** 没删掉的事项，先来的在前 */
export function listInboxItems(db: ReadonlyDatabase): InboxItem[] {
  return db.all<{ item: string }>("SELECT item FROM inbox_items WHERE deleted = 0 ORDER BY global_seq").map((row) => JSON.parse(row.item) as InboxItem);
}

/** 和某张卡有关的、没删掉的事项，先来的在前 */
export function listInboxItemsForCard(db: ReadonlyDatabase, cardId: string): InboxItem[] {
  return db
    .all<{ item: string }>("SELECT item FROM inbox_items WHERE deleted = 0 AND card_id = ? ORDER BY global_seq", cardId)
    .map((row) => JSON.parse(row.item) as InboxItem);
}

/** 某个事件幂等键落在了哪条事项的哪个版本上 */
export function inboxActionByKey(db: ReadonlyDatabase, idempotencyKey: string): { itemId: string; version: number } | undefined {
  const row = db.get<{ item_id: string; version: number }>("SELECT item_id, version FROM inbox_action_keys WHERE idempotency_key = ?", idempotencyKey);
  return row && { itemId: row.item_id, version: Number(row.version) };
}
