// 语音对象的派生视图（31 号票）：会话频道上 voice 事件里每条语音的最新状态，随事件在同一事务里更新，可从事件日志重建。
// 读取函数只拿只读连接。
// 214 号票起语音是插件（voice/），这里是内核的数据契约（voice-records/index.ts）：语音插件停用了也照样登记、照样更新——
// 历史里的语音气泡照样投影成识别出的文字，彻底删除照样重放。语音挡不挡输入队列（208、210 号票的规矩）是插件的（voice/gate.ts），
// 插件不在时内核的挡板（conversation/input-gate.ts）只用这里的读取函数。
import { EVENT_TYPES, isVoiceSettled, type MessageEnvelope, VOICE_STATUSES, type VoiceEventPayload, voiceIdsOf, type VoiceRecord } from "@ergo/protocol";
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

/** 一条消息里还没有结局（排队、识别中）的语音（214 号票：语音插件不在时内核的挡板据此放开队列） */
export function unsettledVoicesOf(db: ReadonlyDatabase, message: Pick<MessageEnvelope, "parts">): VoiceRecord[] {
  return voiceIdsOf(message.parts).flatMap((voiceId) => {
    const voice = getVoice(db, voiceId);
    return voice && !isVoiceSettled(voice.status) ? [voice] : [];
  });
}

/**
 * 进过自动重试、有了结局的语音（210 号票：重试成功的，重试完了还不行的）：这条消息晚交给了 agent，交的时候带一句几点说的、识别晚了。
 * 手动重新识别时去掉了自动重试的次数，不算（照 208 号票的规矩交，不带这句）
 */
export function lateVoicesIn(db: ReadonlyDatabase, message: Pick<MessageEnvelope, "parts">): VoiceRecord[] {
  return voiceIdsOf(message.parts).flatMap((voiceId) => {
    const voice = getVoice(db, voiceId);
    return voice && voice.autoRetry !== undefined && isVoiceSettled(voice.status) ? [voice] : [];
  });
}

/** 消息里只有语音（没有附件、引用的卡片、文字）：只有这样的消息在语音识别失败时不交给 agent（180 号票起只管串词，208 号票起识别失败的都是） */
export function onlyVoiceParts(message: Pick<MessageEnvelope, "parts">): boolean {
  return message.parts.length > 0 && message.parts.every((part) => part.type === "voice");
}

/**
 * 这条消息不该交给 agent：消息里只有语音，而且都识别失败了（208 号票：自动重试完了还不行、静音之类重试也没用的；
 * 180 号票起只管只识别出模型自带串词的）——等同于没发。排队交出去时（message-queue.ts）据此不让它进 agent 的输入队列。
 * 还在识别、等着自动重试的不算（交出去，在输入队列里等它有结局；210 号票起等着自动重试的不挡后面的，见 voice/gate.ts）
 */
export function failedVoiceOnlyMessage(db: ReadonlyDatabase, message: Pick<MessageEnvelope, "parts">): boolean {
  return onlyVoiceParts(message) && voiceIdsOf(message.parts).every((voiceId) => getVoice(db, voiceId)?.status === "failed");
}
