// 卡片的派生视图（ergou.db）：每张卡的最新版本，以及用户动作的幂等键用在了哪张卡、得到了哪个版本。
// 卡片频道上的 card 事件就是卡片的最新版本，视图只是按 id 留最后一条。读取函数只拿只读连接。
import { type Card, type CardEventPayload, CHANNELS, EVENT_TYPES } from "@ergou/protocol";
import type { DerivedView } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";

export const cardsView: DerivedView = {
  name: "cards",
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        card_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        card TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS card_action_keys (
        idempotency_key TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        version INTEGER NOT NULL
      );
    `),
  clear: (db) => db.exec("DELETE FROM cards; DELETE FROM card_action_keys;"),
  apply(db, event) {
    if (event.channel !== CHANNELS.cards || event.type !== EVENT_TYPES.card) return;
    const { card } = event.payload as CardEventPayload;
    db.run(
      `INSERT INTO cards (card_id, type, status, version, card) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (card_id) DO UPDATE SET type = excluded.type, status = excluded.status, version = excluded.version, card = excluded.card`,
      card.id,
      card.type,
      card.status,
      card.version,
      JSON.stringify(card),
    );
    // 带幂等键的卡片事件是用户动作的结果：记下来，同一个键重发时直接回这次的结果
    if (event.idempotencyKey !== null) {
      db.run("INSERT OR IGNORE INTO card_action_keys (idempotency_key, card_id, version) VALUES (?, ?, ?)", event.idempotencyKey, card.id, card.version);
    }
  },
};

/** 某张卡的最新版本（不存在是 undefined） */
export function getCard(db: ReadonlyDatabase, cardId: string): Card | undefined {
  const row = db.get<{ card: string }>("SELECT card FROM cards WHERE card_id = ?", cardId);
  return row && (JSON.parse(row.card) as Card);
}

/** 某个幂等键对应的卡片动作结果（这个键还没用过是 undefined） */
export function cardActionByKey(db: ReadonlyDatabase, idempotencyKey: string): { cardId: string; version: number } | undefined {
  const row = db.get<{ card_id: string; version: number }>("SELECT card_id, version FROM card_action_keys WHERE idempotency_key = ?", idempotencyKey);
  return row && { cardId: row.card_id, version: Number(row.version) };
}
