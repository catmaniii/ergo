// agent 语音对象的派生视图（32 号票）：会话频道上 agent_voice 事件里每条 agent 语音的最新状态，随事件在同一事务里更新，
// 可从事件日志重建（被删掉的项目的维护者会话里的，事件换成"已删除"标记，重建后就没有了）。读取函数只拿只读连接。
import { agentVoiceIdsOf, type AgentVoiceEventPayload, type AgentVoiceRecord, EVENT_TYPES, type MessageEnvelope } from "@ergou/protocol";
import type { DerivedView } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";

export const agentVoicesView: DerivedView = {
  name: "agent_voices",
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_voices (
        voice_id TEXT PRIMARY KEY,
        conversation TEXT NOT NULL,
        status TEXT NOT NULL,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_voices_by_status ON agent_voices (status);
    `),
  clear: (db) => db.exec("DELETE FROM agent_voices"),
  apply(db, event) {
    if (event.type !== EVENT_TYPES.agentVoice) return;
    const { voice } = event.payload as AgentVoiceEventPayload;
    db.run(
      `INSERT INTO agent_voices (voice_id, conversation, status, record) VALUES (?, ?, ?, ?)
       ON CONFLICT (voice_id) DO UPDATE SET status = excluded.status, record = excluded.record`,
      voice.id,
      voice.conversation,
      voice.status,
      JSON.stringify(voice),
    );
  },
};

/** 一条 agent 语音的最新状态（没有是 undefined） */
export function getAgentVoice(db: ReadonlyDatabase, voiceId: string): AgentVoiceRecord | undefined {
  const row = db.get<{ record: string }>("SELECT record FROM agent_voices WHERE voice_id = ?", voiceId);
  return row && (JSON.parse(row.record) as AgentVoiceRecord);
}

/** 还没有结局的 agent 语音（还在回复、在追问口语总结、在合成），先建的在前：守护进程重启后接着处理 */
export function unsettledAgentVoices(db: ReadonlyDatabase): AgentVoiceRecord[] {
  return db
    .all<{ record: string }>("SELECT record FROM agent_voices WHERE status IN ('replying', 'summarizing', 'synthesizing') ORDER BY rowid")
    .map((row) => JSON.parse(row.record) as AgentVoiceRecord);
}

/** 一组消息里 agent 的语音 part 引用的 agent 语音对象（历史分页带上它们：送进 TTS 的原文在这里） */
export function agentVoicesOfMessages(db: ReadonlyDatabase, messages: readonly MessageEnvelope[]): AgentVoiceRecord[] {
  return messages.flatMap((message) => agentVoiceIdsOf(message.parts).flatMap((id) => getAgentVoice(db, id) ?? []));
}
