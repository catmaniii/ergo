// 会话的两个派生视图（随事件在同一事务里更新，可从事件日志重建）：
// - 会话消息：每个会话里定稿的消息（只有定稿后的 part，流式增量不落盘）；
// - agent 的输入队列：会话里用户发来（以及运行时给 agent 的通知）、agent 还没处理完的消息。队列就是事件日志本身：
//   用户消息事件进队（等着），turn_start 事件标记"开始处理"，turn_end 事件出队。不放内存。
//   每条输入记着它所属的任务、项目、定时作业（24 号票：agent 处理它时的用量记在谁名下）。
// 读取函数只拿只读连接。
import {
  type ConversationId,
  EVENT_TYPES,
  type MessageEnvelope,
  type MessageEventPayload,
  pickMessageScope,
  type TurnEndEventPayload,
  type TurnStartEventPayload,
} from "@ergou/protocol";
import type { DerivedView, StoredEvent } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { conversationAttachmentsView } from "./attachments-view.ts";
import type { MessageScope } from "./messages.ts";

export const conversationMessagesView: DerivedView = {
  name: "conversation_messages",
  create: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        message_id TEXT PRIMARY KEY,
        conversation TEXT NOT NULL,
        speaker TEXT NOT NULL,
        time TEXT NOT NULL,
        parts TEXT NOT NULL,
        global_seq INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_messages_by_conversation ON conversation_messages (conversation, global_seq);
    `),
  clear: (db) => db.exec("DELETE FROM conversation_messages"),
  apply(db, event) {
    const message = messageOf(event);
    if (!message) return;
    db.run(
      "INSERT INTO conversation_messages (message_id, conversation, speaker, time, parts, global_seq) VALUES (?, ?, ?, ?, ?, ?)",
      message.id,
      message.conversation,
      message.speaker,
      message.time,
      JSON.stringify(message.parts),
      event.globalSeq,
    );
  },
};

/** 输入的状态：等着、正在处理（agent 已经拿到）、处理完了（不论结局） */
type InputStatus = "pending" | "started" | "done";

export const agentInputsView: DerivedView = {
  name: "agent_inputs",
  create: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_inputs (
        message_id TEXT PRIMARY KEY,
        conversation TEXT NOT NULL,
        global_seq INTEGER NOT NULL,
        status TEXT NOT NULL,
        scope TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_inputs_by_status ON agent_inputs (conversation, status, global_seq);
    `);
    // 24 号票之前建的表没有 scope：补上这一列（之前的输入当作没有归属，agent 按会话的 scope 记账）
    if (!db.all<{ name: string }>("PRAGMA table_info(agent_inputs)").some((c) => c.name === "scope")) db.exec("ALTER TABLE agent_inputs ADD COLUMN scope TEXT");
  },
  clear: (db) => db.exec("DELETE FROM agent_inputs"),
  apply(db, event) {
    const message = messageOf(event);
    // 用户消息，和运行时给 agent 的通知（agentInput 的系统消息）进队
    const payload = event.payload as MessageEventPayload;
    if (message && (message.speaker === "user" || payload.agentInput === true)) {
      db.run(
        "INSERT INTO agent_inputs (message_id, conversation, global_seq, status, scope) VALUES (?, ?, ?, 'pending', ?)",
        message.id,
        message.conversation,
        event.globalSeq,
        JSON.stringify(pickMessageScope(payload)),
      );
    } else if (event.type === EVENT_TYPES.turnStart) {
      const { inputMessageId } = event.payload as TurnStartEventPayload;
      db.run("UPDATE agent_inputs SET status = 'started' WHERE message_id = ?", inputMessageId);
    } else if (event.type === EVENT_TYPES.turnEnd) {
      const { inputMessageId } = event.payload as TurnEndEventPayload;
      db.run("UPDATE agent_inputs SET status = 'done' WHERE message_id = ?", inputMessageId);
    }
  },
};

/** 会话相关的全部派生视图（会话里的附件见 attachments-view.ts） */
export const conversationViews: readonly DerivedView[] = [conversationMessagesView, agentInputsView, conversationAttachmentsView];

function messageOf(event: StoredEvent): MessageEnvelope | undefined {
  if (event.type !== EVENT_TYPES.message) return undefined;
  return (event.payload as MessageEventPayload).message;
}

interface MessageRow {
  message_id: string;
  conversation: ConversationId;
  speaker: MessageEnvelope["speaker"];
  time: string;
  parts: string;
}

const MESSAGE_COLUMNS = "message_id, conversation, speaker, time, parts";

function toMessage(row: MessageRow): MessageEnvelope {
  return { id: row.message_id, conversation: row.conversation, speaker: row.speaker, time: row.time, parts: JSON.parse(row.parts) as MessageEnvelope["parts"] };
}

/** 某个会话里定稿的消息，按事件顺序 */
export function listMessages(db: ReadonlyDatabase, conversation: ConversationId): MessageEnvelope[] {
  return db.all<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM conversation_messages WHERE conversation = ? ORDER BY global_seq`, conversation).map(toMessage);
}

/** 某个会话里某个发言方最近的几条消息，越早的在前（18 号票：范围审视的对照物里"用户在会话里直接说的话"） */
export function recentMessagesOf(db: ReadonlyDatabase, conversation: ConversationId, speaker: MessageEnvelope["speaker"], limit: number): MessageEnvelope[] {
  return db
    .all<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM conversation_messages WHERE conversation = ? AND speaker = ? ORDER BY global_seq DESC LIMIT ?`, conversation, speaker, limit)
    .map(toMessage)
    .toReversed();
}

/** 某条消息（不存在是 undefined） */
export function getMessage(db: ReadonlyDatabase, messageId: string): MessageEnvelope | undefined {
  const row = db.get<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM conversation_messages WHERE message_id = ?`, messageId);
  return row && toMessage(row);
}

export interface QueuedInput {
  messageId: string;
  globalSeq: number;
  /** 这条输入所属的任务、项目、定时作业（消息事件里带的；没有就是空的） */
  scope: MessageScope;
}

function inputsWithStatus(db: ReadonlyDatabase, conversation: ConversationId, status: InputStatus): QueuedInput[] {
  return db
    .all<{ message_id: string; global_seq: number; scope: string | null }>(
      "SELECT message_id, global_seq, scope FROM agent_inputs WHERE conversation = ? AND status = ? ORDER BY global_seq",
      conversation,
      status,
    )
    .map((row) => ({ messageId: row.message_id, globalSeq: Number(row.global_seq), scope: row.scope === null ? {} : (JSON.parse(row.scope) as MessageScope) }));
}

/** 会话里等着 agent 处理的用户消息，先来的在前 */
export function pendingInputs(db: ReadonlyDatabase, conversation: ConversationId): QueuedInput[] {
  return inputsWithStatus(db, conversation, "pending");
}

/** 已经交给 agent、还没有结局的用户消息（正常时最多一条；守护进程重启或子进程崩溃后，它就是被打断的那条） */
export function startedInputs(db: ReadonlyDatabase, conversation: ConversationId): QueuedInput[] {
  return inputsWithStatus(db, conversation, "started");
}
