// 会话的两个派生视图（随事件在同一事务里更新，可从事件日志重建）：
// - 会话消息：每个会话里定稿的消息（只有定稿后的 part，流式增量不落盘；103 号票起连同"秘书转达"的标记，125 号票起连同转达的是
//   用户在秘书那里哪句话、用户的消息从哪台设备来）；
// - agent 的输入队列：会话里用户发来（以及运行时给 agent 的通知）、agent 还没处理完的消息。队列就是事件日志本身：
//   用户消息事件进队（等着），turn_start 事件标记"开始处理"，turn_end 事件出队。不放内存。
//   180 号票：只识别出模型自带串词的语音消息不交给 agent——voice 事件带 dropInput 时这条直接出队（记成没交 dropped），排队交出去的带
//   dropInput 的进来就是没交的。208 号票起识别失败、只有这段语音的都这样；之后用户手动重新识别成功了，voice 事件带 restoreInput，
//   没交的这条回到队里（pending，位置照旧按消息的先后），作为一条正常的输入交给 agent。
//   210 号票：进过自动重试的语音等着重试时不挡后面的（agent-session.ts 跳过它，voice/views.ts 的 voiceGateOf），有了结局还在等着的
//   （重试成功的，重试完了还不行、带着附件或卡片的）排到那时队列的末尾：queue_seq 记成那条 voice 事件的序号，队列按它排（没有的按消息的序号）。
//   每条输入记着它所属的任务、项目、定时作业（24 号票：agent 处理它时的用量记在谁名下）。
// 读取函数只拿只读连接。
import {
  type ConversationId,
  EVENT_TYPES,
  isVoiceSettled,
  type MessageEnvelope,
  type MessageEventPayload,
  pickMessageScope,
  type SentFrom,
  type SessionBranchEventPayload,
  type TurnEndEventPayload,
  type TurnStartEventPayload,
  type VoiceEventPayload,
} from "@ergo/protocol";
import type { DerivedView, StoredEvent } from "../events/event-store.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { conversationAttachmentsView } from "./attachments-view.ts";
import { messageQueueView } from "./message-queue.ts";
import { sessionBranchesView } from "./session-branches.ts";
import type { MessageScope } from "./messages.ts";

export const conversationMessagesView: DerivedView = {
  name: "conversation_messages",
  create: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        message_id TEXT PRIMARY KEY,
        conversation TEXT NOT NULL,
        speaker TEXT NOT NULL,
        time TEXT NOT NULL,
        parts TEXT NOT NULL,
        global_seq INTEGER NOT NULL,
        relayed_by TEXT,
        relay_of TEXT,
        sent_from TEXT,
        browsing TEXT
      );
      CREATE INDEX IF NOT EXISTS conversation_messages_by_conversation ON conversation_messages (conversation, global_seq);
    `);
    // 之前建的表少几列就补上：relayed_by（103 号票之前没有秘书转达的消息）、relay_of、sent_from（125 号票之前没记）、
    // browsing（147 号票之前没有浏览侧边栏）
    const columns = db.all<{ name: string }>("PRAGMA table_info(conversation_messages)").map((c) => c.name);
    for (const column of ["relayed_by", "relay_of", "sent_from", "browsing"]) if (!columns.includes(column)) db.exec(`ALTER TABLE conversation_messages ADD COLUMN ${column} TEXT`);
  },
  clear: (db) => db.exec("DELETE FROM conversation_messages"),
  apply(db, event) {
    const message = messageOf(event);
    if (!message) return;
    const { sentFrom } = event.payload as MessageEventPayload;
    db.run(
      "INSERT INTO conversation_messages (message_id, conversation, speaker, time, parts, global_seq, relayed_by, relay_of, sent_from, browsing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      message.id,
      message.conversation,
      message.speaker,
      message.time,
      JSON.stringify(message.parts),
      event.globalSeq,
      message.relayedBy ?? null,
      message.relayOf ?? null,
      sentFrom ? JSON.stringify(sentFrom) : null,
      message.browsing ? JSON.stringify(message.browsing) : null,
    );
  },
};

/**
 * 输入的状态：等着、正在处理（agent 已经拿到）、处理完了（不论结局）、没交（180、208 号票：只有语音、识别失败的，等同于没发；
 * 手动重新识别成功了回到等着）
 */
type InputStatus = "pending" | "started" | "done" | "dropped";

export const agentInputsView: DerivedView = {
  name: "agent_inputs",
  create: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_inputs (
        message_id TEXT PRIMARY KEY,
        conversation TEXT NOT NULL,
        global_seq INTEGER NOT NULL,
        status TEXT NOT NULL,
        scope TEXT,
        queue_seq INTEGER
      );
      CREATE INDEX IF NOT EXISTS agent_inputs_by_status ON agent_inputs (conversation, status, global_seq);
    `);
    // 24 号票之前建的表没有 scope：补上这一列（之前的输入当作没有归属，agent 按会话的 scope 记账）
    const columns = db.all<{ name: string }>("PRAGMA table_info(agent_inputs)").map((c) => c.name);
    if (!columns.includes("scope")) db.exec("ALTER TABLE agent_inputs ADD COLUMN scope TEXT");
    // 210 号票之前建的表没有 queue_seq：补上（之前的输入都按消息的序号排）
    if (!columns.includes("queue_seq")) db.exec("ALTER TABLE agent_inputs ADD COLUMN queue_seq INTEGER");
  },
  clear: (db) => db.exec("DELETE FROM agent_inputs"),
  apply(db, event) {
    const message = messageOf(event);
    // 用户消息，和运行时给 agent 的通知（agentInput 的系统消息）进队；网页上的指令（134–148 号票的 pageCommand，以前的记录）已经由页面助手处理过，不进队。
    // 180 号票：排队时就只识别出串词的语音消息（dropInput；208 号票起识别失败的都是）交出去时直接记成没交，不交给 agent
    // 290 号票：前情（接管时从运行时自己的记录导进来的，prelude）运行时那边本来就有，不进队；292 号票：在官方 App 里发生的（只读跟随补记的，remote）也一样
    const payload = event.payload as MessageEventPayload;
    if (message && message.prelude !== true && message.remote !== true && ((message.speaker === "user" && message.pageCommand === undefined) || payload.agentInput === true)) {
      db.run(
        "INSERT INTO agent_inputs (message_id, conversation, global_seq, status, scope) VALUES (?, ?, ?, ?, ?)",
        message.id,
        message.conversation,
        event.globalSeq,
        payload.dropInput === true ? "dropped" : "pending",
        JSON.stringify(pickMessageScope(payload)),
      );
    } else if (event.type === EVENT_TYPES.voice) {
      const { voice, dropInput, restoreInput } = event.payload as VoiceEventPayload;
      // 180、208 号票：语音识别失败、消息里只有这段语音：还等着的这条输入出队、记成没交，不交给 agent（等同于没发）
      if (dropInput === true) db.run("UPDATE agent_inputs SET status = 'dropped' WHERE message_id = ? AND status = 'pending'", voice.messageId);
      // 208 号票：手动重新识别成功了：没交的这条回到队里
      if (restoreInput === true) db.run("UPDATE agent_inputs SET status = 'pending' WHERE message_id = ? AND status = 'dropped'", voice.messageId);
      // 210 号票：进过自动重试的语音有了结局，这条还等着：作为一条新输入排到此刻队列的末尾（等着重试时后面的已经越过它先交了）
      if (voice.autoRetry !== undefined && isVoiceSettled(voice.status)) {
        db.run("UPDATE agent_inputs SET queue_seq = ? WHERE message_id = ? AND status = 'pending'", event.globalSeq, voice.messageId);
      }
    } else if (event.type === EVENT_TYPES.turnStart) {
      // 一起交出的一批（144 号票）同时开始、同时出队
      const { inputMessageId, moreInputMessageIds = [] } = event.payload as TurnStartEventPayload;
      for (const id of [inputMessageId, ...moreInputMessageIds]) db.run("UPDATE agent_inputs SET status = 'started' WHERE message_id = ?", id);
    } else if (event.type === EVENT_TYPES.turnEnd) {
      const { inputMessageId, moreInputMessageIds = [] } = event.payload as TurnEndEventPayload;
      for (const id of [inputMessageId, ...moreInputMessageIds]) db.run("UPDATE agent_inputs SET status = 'done' WHERE message_id = ?", id);
    } else if (event.type === EVENT_TYPES.sessionBranch) {
      // 会话回退（150 号票）：被放弃的那段里还排着的输入带到新分支上（同一事务里追加成新的一条），原来那条出队、不再交给 agent
      for (const { from } of (event.payload as SessionBranchEventPayload).carried ?? []) db.run("UPDATE agent_inputs SET status = 'done' WHERE message_id = ? AND status = 'pending'", from);
    }
  },
};

/** 会话相关的全部派生视图（会话里的附件见 attachments-view.ts，排队的消息见 message-queue.ts，会话树见 session-branches.ts） */
export const conversationViews: readonly DerivedView[] = [conversationMessagesView, agentInputsView, conversationAttachmentsView, messageQueueView, sessionBranchesView];

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
  relayed_by: MessageEnvelope["relayedBy"] | null;
  relay_of: string | null;
  browsing: string | null;
}

const MESSAGE_COLUMNS = "message_id, conversation, speaker, time, parts, relayed_by, relay_of, browsing";

function toMessage(row: MessageRow): MessageEnvelope {
  return {
    id: row.message_id,
    conversation: row.conversation,
    speaker: row.speaker,
    time: row.time,
    parts: JSON.parse(row.parts) as MessageEnvelope["parts"],
    ...(row.relayed_by ? { relayedBy: row.relayed_by } : {}),
    ...(row.relay_of ? { relayOf: row.relay_of } : {}),
    ...(row.browsing ? { browsing: JSON.parse(row.browsing) as NonNullable<MessageEnvelope["browsing"]> } : {}),
  };
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

/**
 * 某个会话里某个发言方在某个全局序号之前最近的几条消息，越早的在前（75 号票：项目内部的普通任务续派工单时，
 * 上一轮做完那一刻之前它最后说的话）
 */
export function recentMessagesBefore(db: ReadonlyDatabase, conversation: ConversationId, speaker: MessageEnvelope["speaker"], beforeGlobalSeq: number, limit: number): MessageEnvelope[] {
  return db
    .all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM conversation_messages WHERE conversation = ? AND speaker = ? AND global_seq < ? ORDER BY global_seq DESC LIMIT ?`,
      conversation,
      speaker,
      beforeGlobalSeq,
      limit,
    )
    .map(toMessage)
    .toReversed();
}

/**
 * 会话里最近一次"清空当前对话"的分隔线（114 号票，conversation_cleared part 的系统消息）：消息 id、全局序号、时间；没清空过是 undefined。
 * agent 的会话据此知道这一段会话叫什么（新开时的名字）、⚙ 里的用量从哪算起
 */
export function lastClearMarker(db: ReadonlyDatabase, conversation: ConversationId): { messageId: string; globalSeq: number; time: string } | undefined {
  const row = db.get<{ message_id: string; global_seq: number; time: string }>(
    `SELECT message_id, global_seq, time FROM conversation_messages WHERE conversation = ? AND speaker = 'system' AND parts LIKE '%"conversation_cleared"%' ORDER BY global_seq DESC LIMIT 1`,
    conversation,
  );
  return row && { messageId: row.message_id, globalSeq: Number(row.global_seq), time: row.time };
}

/** 换运行时时会话里那条说明的消息 id 的前缀（289 号票）：按它认出最近一次换运行时（新开的那段会话的名字由它定） */
export const RUNTIME_SWITCH_MESSAGE_PREFIX = "m-rt-";

/**
 * 会话里最近一次换运行时的那条说明（289 号票，消息 id 以 RUNTIME_SWITCH_MESSAGE_PREFIX 开头的系统消息）：消息 id、全局序号；没换过是 undefined。
 * agent 的会话据此知道换过去之后那一段会话叫什么（和清空的分隔线谁在后用谁）
 */
export function lastRuntimeSwitchMarker(db: ReadonlyDatabase, conversation: ConversationId): { messageId: string; globalSeq: number } | undefined {
  const row = db.get<{ message_id: string; global_seq: number }>(
    `SELECT message_id, global_seq FROM conversation_messages WHERE conversation = ? AND speaker = 'system' AND message_id LIKE ? ORDER BY global_seq DESC LIMIT 1`,
    conversation,
    `${RUNTIME_SWITCH_MESSAGE_PREFIX}%`,
  );
  return row && { messageId: row.message_id, globalSeq: Number(row.global_seq) };
}

/** 这个全局序号之后 agent 在会话里说过话没有（289 号票：换运行时之前有没有要交接的） */
export function agentSpokeAfter(db: ReadonlyDatabase, conversation: ConversationId, globalSeq: number): boolean {
  const row = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation = ? AND speaker = 'agent' AND global_seq > ?`, conversation, globalSeq);
  return Number(row?.n ?? 0) > 0;
}

/**
 * 这条消息之后、下一条用户消息之前（没有就到现在）agent 说的话，越早的在前（264 号票：秘书这一轮的回话里有没有带上顺口问的那一句）。
 * 这条消息不在是空的
 */
export function agentRepliesAfter(db: ReadonlyDatabase, conversation: ConversationId, messageId: string): MessageEnvelope[] {
  return db
    .all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM conversation_messages AS m
       WHERE m.conversation = ? AND m.speaker = 'agent'
         AND m.global_seq > (SELECT global_seq FROM conversation_messages WHERE message_id = ?)
         AND m.global_seq < COALESCE(
           (SELECT MIN(u.global_seq) FROM conversation_messages AS u
             WHERE u.conversation = ? AND u.speaker = 'user' AND u.global_seq > (SELECT global_seq FROM conversation_messages WHERE message_id = ?)),
           9223372036854775807)
       ORDER BY m.global_seq`,
      conversation,
      messageId,
      conversation,
      messageId,
    )
    .map(toMessage);
}

/**
 * 这条消息之前、上一条用户消息之后 agent 说的话，越早的在前（264 号票：用户这句是不是紧接着秘书顺口问的那一轮）。
 * 这条消息不在是空的
 */
export function agentRepliesBefore(db: ReadonlyDatabase, conversation: ConversationId, messageId: string): MessageEnvelope[] {
  return db
    .all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM conversation_messages AS m
       WHERE m.conversation = ? AND m.speaker = 'agent'
         AND m.global_seq < (SELECT global_seq FROM conversation_messages WHERE message_id = ?)
         AND m.global_seq > COALESCE(
           (SELECT MAX(u.global_seq) FROM conversation_messages AS u
             WHERE u.conversation = ? AND u.speaker = 'user' AND u.global_seq < (SELECT global_seq FROM conversation_messages WHERE message_id = ?)),
           0)
       ORDER BY m.global_seq`,
      conversation,
      messageId,
      conversation,
      messageId,
    )
    .map(toMessage);
}

/**
 * 271 号票：某个会话里最近一条带着某次工具调用（工具名对得上、参数摘要里有 needle）的 agent 消息和它的全局序号（秘书标了哪个顺口问）；
 * 没有是 undefined。先按存下的 JSON 粗筛，再逐个 part 核对
 */
export function lastToolCallMessage(db: ReadonlyDatabase, conversation: ConversationId, tool: string, needle: string): { message: MessageEnvelope; globalSeq: number } | undefined {
  const rows = db.all<MessageRow & { global_seq: number }>(
    `SELECT ${MESSAGE_COLUMNS}, global_seq FROM conversation_messages
     WHERE conversation = ? AND speaker = 'agent' AND instr(parts, ?) > 0 AND instr(parts, ?) > 0
     ORDER BY global_seq DESC LIMIT 20`,
    conversation,
    `"tool":${JSON.stringify(tool)}`,
    needle,
  );
  for (const row of rows) {
    const message = toMessage(row);
    if (message.parts.some((part) => part.type === "tool_call" && part.tool === tool && part.argsSummary.includes(needle))) return { message, globalSeq: row.global_seq };
  }
  return undefined;
}

/** 271 号票：某个全局序号之后、同一个会话里用户说的话（越早的在前，最多 limit 条） */
export function userMessagesAfter(db: ReadonlyDatabase, conversation: ConversationId, afterGlobalSeq: number, limit: number): MessageEnvelope[] {
  return db
    .all<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM conversation_messages WHERE conversation = ? AND speaker = 'user' AND global_seq > ? ORDER BY global_seq LIMIT ?`, conversation, afterGlobalSeq, limit)
    .map(toMessage);
}

/** 271 号票：某个时间之后、同一个会话里用户说的话（越早的在前，最多 limit 条；按消息上记的时间比） */
export function userMessagesSince(db: ReadonlyDatabase, conversation: ConversationId, since: string, limit: number): MessageEnvelope[] {
  const from = Date.parse(since);
  return db
    .all<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM conversation_messages WHERE conversation = ? AND speaker = 'user' ORDER BY global_seq`, conversation)
    .map(toMessage)
    .filter((message) => Date.parse(message.time) > from)
    .slice(0, limit);
}

/** 271 号票：某个全局序号所在的那一轮（前一条用户消息之后、后一条用户消息之前）agent 说的话，越早的在前 */
export function agentRepliesAround(db: ReadonlyDatabase, conversation: ConversationId, globalSeq: number): MessageEnvelope[] {
  return db
    .all<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM conversation_messages AS m
       WHERE m.conversation = ? AND m.speaker = 'agent'
         AND m.global_seq > COALESCE((SELECT MAX(u.global_seq) FROM conversation_messages AS u WHERE u.conversation = ? AND u.speaker = 'user' AND u.global_seq < ?), 0)
         AND m.global_seq < COALESCE((SELECT MIN(u.global_seq) FROM conversation_messages AS u WHERE u.conversation = ? AND u.speaker = 'user' AND u.global_seq > ?), 9223372036854775807)
       ORDER BY m.global_seq`,
      conversation,
      conversation,
      globalSeq,
      conversation,
      globalSeq,
    )
    .map(toMessage);
}

/** 某条消息（不存在是 undefined） */
export function getMessage(db: ReadonlyDatabase, messageId: string): MessageEnvelope | undefined {
  const row = db.get<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM conversation_messages WHERE message_id = ?`, messageId);
  return row && toMessage(row);
}

/** 用户自己发的一条消息从哪来（125 号票：本机端口、已配对设备）；没记的（之前的、不是用户发的）是 undefined */
export function messageSentFrom(db: ReadonlyDatabase, messageId: string): SentFrom | undefined {
  const row = db.get<{ sent_from: string | null }>("SELECT sent_from FROM conversation_messages WHERE message_id = ?", messageId);
  return row?.sent_from ? (JSON.parse(row.sent_from) as SentFrom) : undefined;
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
      "SELECT message_id, global_seq, scope FROM agent_inputs WHERE conversation = ? AND status = ? ORDER BY COALESCE(queue_seq, global_seq)",
      conversation,
      status,
    )
    .map((row) => ({ messageId: row.message_id, globalSeq: Number(row.global_seq), scope: row.scope === null ? {} : (JSON.parse(row.scope) as MessageScope) }));
}

/** 会话里等着 agent 处理的用户消息，先来的在前（210 号票：进过自动重试的语音按有结局的时刻算） */
export function pendingInputs(db: ReadonlyDatabase, conversation: ConversationId): QueuedInput[] {
  return inputsWithStatus(db, conversation, "pending");
}

/** 输入队列里的某一条（按消息 id）：在哪个会话、状态、所属的任务、项目、定时作业（19 号票：认出一轮处理的是不是作业的一次运行）；不是输入时没有 */
export function inputOf(db: ReadonlyDatabase, messageId: string): { conversation: ConversationId; status: InputStatus; scope: MessageScope } | undefined {
  const row = db.get<{ conversation: ConversationId; status: InputStatus; scope: string | null }>("SELECT conversation, status, scope FROM agent_inputs WHERE message_id = ?", messageId);
  return row && { conversation: row.conversation, status: row.status, scope: row.scope === null ? {} : (JSON.parse(row.scope) as MessageScope) };
}

/**
 * 已经交给 agent、还没有结局的用户消息（正常时是一轮的那一条，144 号票起可以是一起交出的一批；守护进程重启或子进程崩溃后，
 * 它们就是被打断的那一轮）
 */
export function startedInputs(db: ReadonlyDatabase, conversation: ConversationId): QueuedInput[] {
  return inputsWithStatus(db, conversation, "started");
}

/**
 * 这个会话的 agent 正在回复（144 号票：有交给它、还没有结局的输入，也就是 turn_start 之后还没有 turn_end）：这时用户发的话排队，
 * 输入框上有"停止"。追问口语总结、手动压缩不算（没有 turn_start）
 */
export function replying(db: ReadonlyDatabase, conversation: ConversationId): boolean {
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_inputs WHERE conversation = ? AND status = 'started'", conversation)!.n > 0;
}
