// 语音对象的派生视图（31 号票）：会话频道上 voice 事件里每条语音的最新状态，随事件在同一事务里更新，可从事件日志重建。
// 读取函数只拿只读连接。
import { EVENT_TYPES, isVoiceSettled, type MessageEnvelope, VOICE_STATUSES, type VoiceEventPayload, voiceIdsOf, type VoiceRecord } from "@ergou/protocol";
import type { DerivedView } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";

export const voicesView: DerivedView = {
  name: "voices",
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS voices (
        voice_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        conversation TEXT NOT NULL,
        status TEXT NOT NULL,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS voices_by_status ON voices (status);
      CREATE INDEX IF NOT EXISTS voices_by_message ON voices (message_id);
    `),
  clear: (db) => db.exec("DELETE FROM voices"),
  apply(db, event) {
    if (event.type !== EVENT_TYPES.voice) return;
    const { voice } = event.payload as VoiceEventPayload;
    db.run(
      `INSERT INTO voices (voice_id, message_id, conversation, status, record) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (voice_id) DO UPDATE SET status = excluded.status, record = excluded.record`,
      voice.id,
      voice.messageId,
      voice.conversation,
      voice.status,
      JSON.stringify(voice),
    );
  },
};

/** 一条语音的最新状态（没有是 undefined） */
export function getVoice(db: ReadonlyDatabase, voiceId: string): VoiceRecord | undefined {
  const row = db.get<{ record: string }>("SELECT record FROM voices WHERE voice_id = ?", voiceId);
  return row && (JSON.parse(row.record) as VoiceRecord);
}

/** 还没有结局的识别状态（排队、识别中） */
const UNSETTLED = VOICE_STATUSES.filter((status) => !isVoiceSettled(status));

/** 还没有结局（排队、识别中）的语音，先建的在前：守护进程重启后接着识别 */
export function unsettledVoices(db: ReadonlyDatabase): VoiceRecord[] {
  return db
    .all<{ record: string }>(`SELECT record FROM voices WHERE status IN (${UNSETTLED.map(() => "?").join(", ")}) ORDER BY rowid`, ...UNSETTLED)
    .map((row) => JSON.parse(row.record) as VoiceRecord);
}

/** 一个会话（不给是全部会话）里的语音，先建的在前 */
export function voicesIn(db: ReadonlyDatabase, conversation?: string): VoiceRecord[] {
  const rows =
    conversation === undefined
      ? db.all<{ record: string }>("SELECT record FROM voices ORDER BY rowid")
      : db.all<{ record: string }>("SELECT record FROM voices WHERE conversation = ? ORDER BY rowid", conversation);
  return rows.map((row) => JSON.parse(row.record) as VoiceRecord);
}

/** 一组消息里的语音 part 引用的语音对象（历史分页带上它们） */
export function voicesOfMessages(db: ReadonlyDatabase, messages: readonly MessageEnvelope[]): VoiceRecord[] {
  const out: VoiceRecord[] = [];
  for (const message of messages) {
    for (const voiceId of voiceIdsOf(message.parts)) {
      const voice = getVoice(db, voiceId);
      if (voice) out.push(voice);
    }
  }
  return out;
}

/**
 * 这条消息现在能不能交给 agent：里面的语音都识别出了结局（完成或失败）才行（31 号票："识别完成前这条输入在输入队列里等着"）。
 * 没有语音的消息总是能；语音对象找不到的（不该发生）不拦着，交给 agent 时按识别失败投影
 */
export function voicesSettled(db: ReadonlyDatabase, message: Pick<MessageEnvelope, "parts">): boolean {
  return voiceIdsOf(message.parts).every((voiceId) => {
    const voice = getVoice(db, voiceId);
    return !voice || isVoiceSettled(voice.status);
  });
}
