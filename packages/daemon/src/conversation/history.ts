// 会话历史分页（规格第 5 节 HTTP）。会话频道的历史可能很长，前端第一次订阅时 WebSocket 只补发最近一页
// （最近 HISTORY_PAGE_SIZE 条消息起的全部事件），往上翻时经 HTTP 按页取更早的消息：
// - 第一页的起点是第 HISTORY_PAGE_SIZE 新的那条消息的序号 S，WebSocket 补发序号 ≥ S 的事件；
// - HTTP 的 before 是前端手里最早那条消息的序号，返回序号 < before 的最近若干条消息。
// 两边按同一个序号切开，所以交界处不重不漏。带着游标重连的照旧补发缺的全部事件。
// 25 号票起一页里还带着落在这一页里的时间线记录（timeline_record、快速动作的操作记录 quick_action_executed）：
// 序号从这一页第一条消息起、小于 before（更早没有了的从头起），往上翻时要点层、全局层也看得到旧页里的偏离和操作记录。
// 144 号票：第一次订阅的补发还要盖住排队的消息（最新那条 message_queue）和正在回复的这一轮的开头（turn_start）。
// 150 号票：会话回退过的，一页只取当前分支上的消息和记录（废弃分支上的跳过，session-branches.ts 的 pathEventsBefore），
// 第一次订阅的那一页也按当前分支数；最新那条 session_branch 落在那一页之前时网关另外先补发它（pinnedReplay）。
// 179 号票：第一次订阅的那一页里的消息引用的语音对象，最新那一版的事件落在这一页之前的，网关同样先补发（replayPins）——
// 回复中发的语音排队时就建出、识别完了，这一轮做完才交出去成为消息，中间 agent 又说了一页多时就是这样。
import {
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  HISTORY_PAGE_SIZE,
  type HistoryMessage,
  type HistoryPage,
  type HistoryRecord,
  type HistoryStageStart,
  type StageStartEventPayload,
  isChannel,
  isDeletedEventPayload,
  MAINTAINER_CHANNEL_PREFIX,
  type MessageEventPayload,
  onBranchPath,
  pickMessageScope,
  type QuickActionExecutedEventPayload,
  type SeqRange,
  type TimelineRecordEventPayload,
} from "@ergo/protocol";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import { queuedMessages, queueEventSeq } from "./message-queue.ts";
import { branchTreeOf, pathEventsBefore, pinnedReplay } from "./session-branches.ts";
import { replying } from "./views.ts";
import { agentVoicesOfMessages } from "../voice-records/agent-views.ts";
import { voicesOfMessages } from "../voice-records/views.ts";

/** 一页最多取多少条 */
export const MAX_HISTORY_LIMIT = 200;

/** 是不是一个会话频道（秘书会话、某个维护者的会话） */
export function isConversationChannel(channel: string): channel is ConversationId {
  return isChannel(channel) && (channel === CHANNELS.secretary || channel.startsWith(MAINTAINER_CHANNEL_PREFIX));
}

/**
 * 前端第一次订阅（游标为 0）时从哪个序号之后补发：会话频道从最近一页的第一条消息起，其他频道从头。
 * 返回的是"之后"的序号，和订阅游标同义。
 */
export function firstReplayAfter(store: EventStore, channel: string): number {
  if (!isConversationChannel(channel)) return 0;
  const recent = pathEventsBefore(store, channel, Number.MAX_SAFE_INTEGER, HISTORY_PAGE_SIZE, EVENT_TYPES.message);
  if (recent.length < HISTORY_PAGE_SIZE) return 0;
  // 144 号票：排队的消息（最新那条 message_queue 事件）、正在回复的这一轮的开头（turn_start）落在这一页之前时从它们起补发，
  // 前端才知道现在排着什么、有没有在回复
  const queued = queueEventSeq(store.reader, channel);
  const open = openTurnSeq(store, channel);
  return Math.min(recent[0]!.seq, queued ?? Infinity, open ?? Infinity) - 1;
}

/**
 * 第一次订阅时，补发这一页（序号大于 from 的事件 replay）之前要先补发的几条事件，按序号从早到晚（序号都不大于 from）：
 * - 最新那条 session_branch 落在这一页之前时就是它（150 号票，session-branches.ts 的 pinnedReplay）；
 * - 这一页里的消息、现在排着的消息引用的语音对象（用户的语音、agent 的语音），最新那一版的事件落在这一页之前的（179 号票）。
 *   语音对象的事件一般紧跟在它那条消息后面，可回复中发的语音排队时就建出、识别（voice 事件在前），这一轮做完才交出去成为消息
 *   （message 事件在后，144 号票）；中间 agent 又说了一页多，消息在这一页里、语音对象的事件却在前面，前端拿不到它，气泡一直是
 *   "识别中…"。agent 语音最后那一版也在它那条语音消息前面，这一页正好从那条起时一样。往上翻的一页由 pageExtras 带上语音对象
 */
export function replayPins(store: EventStore, conversation: string, from: number, replay: readonly StoredEvent[]): StoredEvent[] {
  const branch = pinnedReplay(store, conversation, from);
  if (from === 0 || !isConversationChannel(conversation)) return branch;
  return [...branch, ...voicePins(store, conversation, from, replay)].toSorted((a, b) => a.seq - b.seq);
}

/** 往前找语音对象的事件时一批读几条 */
const PIN_SCAN_BATCH = 200;

/** 语音事件（voice、agent_voice）说的是哪个语音对象；被彻底删除的没有 */
function voiceIdOf(event: StoredEvent): string | undefined {
  if (isDeletedEventPayload(event.payload)) return undefined;
  return (event.payload as { voice?: { id?: string } }).voice?.id;
}

/** 这一页里的消息、排着的消息引用的语音对象，在这一页里一条事件都没有的：各自最新那一版的事件 */
function voicePins(store: EventStore, conversation: ConversationId, from: number, replay: readonly StoredEvent[]): StoredEvent[] {
  const envelopes = [
    ...replay.flatMap((event) => (event.type === EVENT_TYPES.message && !isDeletedEventPayload(event.payload) ? [(event.payload as MessageEventPayload).message] : [])),
    ...queuedMessages(store.reader, conversation).map((queued) => queued.message),
  ];
  if (envelopes.length === 0) return [];
  const inPage = new Set(replay.flatMap((event) => (event.type === EVENT_TYPES.voice || event.type === EVENT_TYPES.agentVoice ? (voiceIdOf(event) ?? []) : [])));
  const missing = (voices: readonly { id: string }[]) => new Set(voices.map((v) => v.id).filter((id) => !inPage.has(id)));
  return [
    ...latestVoiceEvents(store, conversation, EVENT_TYPES.voice, missing(voicesOfMessages(store.reader, envelopes)), from),
    ...latestVoiceEvents(store, conversation, EVENT_TYPES.agentVoice, missing(agentVoicesOfMessages(store.reader, envelopes)), from),
  ];
}

/** 这几个语音对象各自最新那一版的事件（序号不大于 from）：从 from 往前按类型一批批找，找齐了或者到头了为止 */
function latestVoiceEvents(store: EventStore, conversation: ConversationId, type: string, ids: Set<string>, from: number): StoredEvent[] {
  const found: StoredEvent[] = [];
  for (let before = from + 1; ids.size > 0; ) {
    const batch = store.readBefore(conversation, before, PIN_SCAN_BATCH, type);
    for (const event of batch.toReversed()) {
      const id = voiceIdOf(event);
      if (id !== undefined && ids.delete(id)) found.push(event);
    }
    if (batch.length < PIN_SCAN_BATCH) break;
    before = batch[0]!.seq;
  }
  return found;
}

/** 正在回复的这一轮开头的 turn_start 在会话频道上的序号；没在回复是 undefined */
function openTurnSeq(store: EventStore, conversation: ConversationId): number | undefined {
  if (!replying(store.reader, conversation)) return undefined;
  const last = store.readBefore(conversation, Number.MAX_SAFE_INTEGER, 1, EVENT_TYPES.turnStart)[0];
  return last?.seq;
}

/** 时间线记录的事件类型：历史分页里跟着消息一起带回 */
const RECORD_TYPES: readonly string[] = [EVENT_TYPES.timelineRecord, EVENT_TYPES.quickActionExecuted];

/**
 * 一页历史：序号小于 before（不给就是最新）的最近 limit 条消息，按序号从早到晚；被彻底删除的只有"已删除"标记。
 * 连同落在这一页里的时间线记录（序号从这一页第一条消息起、小于 before；更早没有了的从头起）
 */
export function historyPage(store: EventStore, conversation: ConversationId, options: { before?: number; limit?: number }): HistoryPage {
  const limit = Math.min(options.limit ?? HISTORY_PAGE_SIZE, MAX_HISTORY_LIMIT);
  const tree = branchTreeOf(store.reader, conversation);
  const onPath = (seq: number) => tree.branches.length === 1 || onBranchPath(tree, seq);
  const before = options.before ?? Number.MAX_SAFE_INTEGER;
  const events = pathEventsBefore(store, conversation, before, limit + 1, EVENT_TYPES.message);
  const hasMore = events.length > limit;
  const page = hasMore ? events.slice(1) : events;
  // 这一页覆盖的序号：更早还有的，从这一页第一条消息起；没有了的从头起
  const from = hasMore ? page[0]!.seq : 1;
  const messages = page.map(historyMessageOf);
  // 长程任务阶段开始的记号（152 号票）：和记录同一个范围
  const stageStarts = store
    .readBefore(conversation, before, Number.MAX_SAFE_INTEGER, EVENT_TYPES.stageStart)
    .filter((event) => event.seq >= from && onPath(event.seq))
    .map(historyStageStartOf);
  return {
    conversation,
    ...pageExtras(store, messages),
    messages,
    // 记录很稀：按类型取 before 之前的，留下落在这一页里的（回退过的只留当前分支上的，150 号票）
    records: RECORD_TYPES.flatMap((type) => store.readBefore(conversation, before, Number.MAX_SAFE_INTEGER, type))
      .filter((event) => event.seq >= from && onPath(event.seq))
      .toSorted((a, b) => a.seq - b.seq)
      .map(historyRecordOf),
    hasMore,
    ...(stageStarts.length > 0 ? { stageStarts } : {}),
  };
}

/** 一条消息事件在历史页里的样子：被彻底删除的只有"已删除"标记 */
function historyMessageOf(event: StoredEvent): HistoryMessage {
  if (isDeletedEventPayload(event.payload)) return { seq: event.seq, deleted: event.payload };
  const payload = event.payload as MessageEventPayload;
  return {
    seq: event.seq,
    message: payload.message,
    ...(payload.idempotencyKey === undefined ? {} : { idempotencyKey: payload.idempotencyKey }),
    ...pickMessageScope(payload),
    // 排队交出的那一批（150 号票：第一条之后的不是回退点）
    ...(payload.queueDelivery === undefined ? {} : { queueDelivery: payload.queueDelivery }),
  };
}

/** 一条阶段开始的记号在历史页里的样子（152 号票） */
function historyStageStartOf(event: StoredEvent): HistoryStageStart {
  return { seq: event.seq, payload: event.payload as StageStartEventPayload };
}

/** 一条时间线记录的事件在历史页里的样子 */
function historyRecordOf(event: StoredEvent): HistoryRecord {
  return event.type === EVENT_TYPES.timelineRecord
    ? { seq: event.seq, type: EVENT_TYPES.timelineRecord, payload: event.payload as TimelineRecordEventPayload }
    : { seq: event.seq, type: EVENT_TYPES.quickActionExecuted, payload: event.payload as QuickActionExecutedEventPayload };
}

/**
 * 一页里的消息引用的语音对象：语音消息的（31 号票，它们的 voice 事件可能早于 WebSocket 第一次补发的那一页）、agent 的语音消息的
 * （32 号票：送进 TTS 的原文在它们那里；发语音调用记录建出的语音也带上，87 号票：前端据此认出发出了气泡的调用，不单独显示）
 */
function pageExtras(store: EventStore, messages: readonly HistoryMessage[]): Pick<HistoryPage, "voices" | "agentVoices"> {
  const envelopes = messages.flatMap((m) => ("message" in m ? [m.message] : []));
  const voices = voicesOfMessages(store.reader, envelopes);
  const agentVoices = agentVoicesOfMessages(store.reader, envelopes);
  return { ...(voices.length > 0 ? { voices } : {}), ...(agentVoices.length > 0 ? { agentVoices } : {}) };
}

/**
 * 几段序号里的消息和时间线记录（151 号票：一条废弃分支自己的那一段，session-branches.ts 的 branchOwnRanges），按序号从早到晚，
 * 和一页历史同一个形状（前端照样按序号并进来）
 */
export function rangePage(store: EventStore, conversation: ConversationId, ranges: readonly SeqRange[]): Omit<HistoryPage, "hasMore"> {
  const within = (type: string) =>
    ranges.flatMap((range) => {
      const out: StoredEvent[] = [];
      for (const event of store.read(conversation, range.from - 1, type)) {
        if (event.seq >= range.to) break;
        out.push(event);
      }
      return out;
    });
  const messages = within(EVENT_TYPES.message).map(historyMessageOf);
  const records = RECORD_TYPES.flatMap(within)
    .toSorted((a, b) => a.seq - b.seq)
    .map(historyRecordOf);
  // 阶段开始的记号（152 号票）：切换分支之后补进来的那一段上也要有阶段开始的回退点
  const stageStarts = within(EVENT_TYPES.stageStart).map(historyStageStartOf);
  return { conversation, ...pageExtras(store, messages), messages, records, ...(stageStarts.length > 0 ? { stageStarts } : {}) };
}
