// agent 语音对象的派生视图（32 号票）：会话频道上 agent_voice 事件里每条 agent 语音的最新状态，随事件在同一事务里更新，
// 可从事件日志重建（被删掉的项目的维护者会话里的，事件换成"已删除"标记，重建后就没有了）。读取函数只拿只读连接。
import { agentVoiceIdsOf, type AgentVoiceEventPayload, type AgentVoiceRecord, EVENT_TYPES, type MessageEnvelope } from "@ergou/protocol";
import type { DerivedView } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { SEND_VOICE_TOOL } from "./texts.ts";

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

/**
 * 工具发的、这一轮另写的文字收不收进气泡还没定的 agent 语音（86 号票），先建的在前：守护进程重启时那一轮已经被打断了，
 * 定成照常显示
 */
export function toolVoicesAwaitingTurnEnd(db: ReadonlyDatabase): AgentVoiceRecord[] {
  return db
    .all<{ record: string }>("SELECT record FROM agent_voices WHERE json_extract(record, '$.mode') = 'tool' AND json_extract(record, '$.coversReply') IS NULL ORDER BY rowid")
    .map((row) => JSON.parse(row.record) as AgentVoiceRecord);
}

/** 一个会话里最近的几条工具发的 agent 语音（86 号票），后建的在前 */
export function recentToolVoices(db: ReadonlyDatabase, conversation: string, limit: number): AgentVoiceRecord[] {
  return db
    .all<{ record: string }>("SELECT record FROM agent_voices WHERE conversation = ? AND json_extract(record, '$.mode') = 'tool' ORDER BY rowid DESC LIMIT ?", conversation, limit)
    .map((row) => JSON.parse(row.record) as AgentVoiceRecord);
}

/**
 * 某一轮（turnSeq 是这一轮开始的 turn_start 在会话频道上的序号）里发语音工具建出的 agent 语音，先建的在前（100 号票：任务做完的通知
 * 被打断后重新交时，看上次那一轮念过没有；语音记在这一轮收下的插话那条上的也在里面）
 */
export function toolVoicesOfTurn(db: ReadonlyDatabase, conversation: string, turnSeq: number): AgentVoiceRecord[] {
  return db
    .all<{ record: string }>(
      "SELECT record FROM agent_voices WHERE conversation = ? AND json_extract(record, '$.mode') = 'tool' AND json_extract(record, '$.turnSeq') = ? ORDER BY rowid",
      conversation,
      turnSeq,
    )
    .map((row) => JSON.parse(row.record) as AgentVoiceRecord);
}

/** 发语音工具的某次调用建出的 agent 语音（86 号票，按语音对象上记的工具调用 id；没建出的是 undefined） */
function toolVoiceOfCall(db: ReadonlyDatabase, conversation: string, toolCallId: string): AgentVoiceRecord | undefined {
  const row = db.get<{ record: string }>(
    "SELECT record FROM agent_voices WHERE conversation = ? AND json_extract(record, '$.mode') = 'tool' AND json_extract(record, '$.toolCallId') = ?",
    conversation,
    toolCallId,
  );
  return row && (JSON.parse(row.record) as AgentVoiceRecord);
}

/**
 * 一组消息里 agent 的语音 part 引用的 agent 语音对象（历史分页带上它们：送进 TTS 的原文在这里），
 * 和发语音调用（工具调用记录）建出的语音（87 号票：前端按它认出这次调用发出了气泡、不单独显示——分页正好切在气泡和调用记录之间时，
 * 只有调用记录的那一页也要带上），同一条只带一次
 */
export function agentVoicesOfMessages(db: ReadonlyDatabase, messages: readonly MessageEnvelope[]): AgentVoiceRecord[] {
  const found = messages.flatMap((message) => [
    ...agentVoiceIdsOf(message.parts).flatMap((id) => getAgentVoice(db, id) ?? []),
    ...message.parts.flatMap((p) => (p.type === "tool_call" && p.tool === SEND_VOICE_TOOL ? (toolVoiceOfCall(db, message.conversation, p.callId) ?? []) : [])),
  ]);
  return [...new Map(found.map((v) => [v.id, v])).values()];
}
