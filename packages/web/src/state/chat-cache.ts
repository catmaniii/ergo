// 手机本机存的聊天记录（457）：往上翻时本机存着的直接用，没有才向电脑要，要来的存下。这里是纯函数那一半——存什么、一段段怎么拼、
// 能不能拼出一页、哪些事件让它作废；存在哪、什么时候写、信不信得过见 app/chat-cache.ts。
// - 存的是协议里的样子，不是状态层折出来的：历史分页的一条消息（HistoryMessage）、时间线记录（HistoryRecord）、阶段开始的记号、
//   语音对象、agent 语音对象。本机拼出来的是一页 HistoryPage，和向电脑要来的一样交给状态层（history_page），
//   所以网页换了一版照样能用（协议版本变了才作废）。
// - 来源两处：WebSocket 上会话频道的事件（补发的最近一页、实时收到的），向电脑要来的一页（往上翻）。
// - 一段（CachedSpan）：序号 lo..hi 里当前分支上的消息、记录、阶段记号本机一条不缺（lo 是 1 就是从头起，再往前没有了）。
//   向电脑要来的一页给一段：这一页第一条消息（更早没有了的从 1）到 before - 1（守护进程 conversation/history.ts 的 historyPage
//   就是按这个范围取的）；WebSocket 上一条不漏收到的那一段整段都在（不分分支，什么树都对）。
// - 会话树变了（回退、切换分支）：两棵树的当前路径从哪个序号起不一样（pathDivergence），各段截到它之前——那之前哪些在当前分支上
//   两棵树说的一样，之后的要重新向电脑要。
// - 拼一页（cachedPage）照守护进程的 historyPage：before 之前当前分支上最近 limit 条消息；这一段里不够 limit 条、又不是从头起的，
//   交回有的那几条、说"更早还有"，下次往上翻向电脑要缺的那一截（before 是本机最早那条，守护进程交回的正好是缺的）。
//   消息引用的语音对象本机缺了（又不知道它本来就没有）就不拼，向电脑要。
// 纯函数，不依赖 React 和 DOM。
import {
  agentVoiceIdsOf,
  type AgentVoiceEventPayload,
  type AgentVoiceRecord,
  CHANNELS,
  type ConversationBranches,
  EVENT_TYPES,
  type EventFrame,
  hasOwnMaintainer,
  type HistoryMessage,
  type HistoryPage,
  type HistoryRecord,
  type HistoryStageStart,
  isDeletedEventPayload,
  MAINTAINER_CHANNEL_PREFIX,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  onBranchPath,
  pathRanges,
  pickMessageScope,
  type ProjectEventPayload,
  type SessionBranchEventPayload,
  SINGLE_BRANCH,
  type StageStartEventPayload,
  type TaskEventPayload,
  type VoiceEventPayload,
  voiceIdsOf,
  type VoiceRecord,
} from "./protocol.ts";

/** 本机存的聊天记录的格式（存的样子、键）：变了就加一，旧的整份删掉 */
export const CHAT_CACHE_FORMAT = 1;

/** 发语音的工具（守护进程 voice-records/names.ts 的 SEND_VOICE_TOOL）：它的调用记录引用它建出的 agent 语音（按调用 id 找） */
const SEND_VOICE_TOOL = "send_voice";

/** 存的几样：消息（m）、时间线记录（r）、阶段开始的记号（s）按序号存；语音对象（v）、agent 语音对象（a）按 id 存 */
export type ChatCacheKind = "m" | "r" | "s" | "v" | "a";

/** 存进本机的一条 */
export type ChatCacheEntry =
  | { readonly kind: "m"; readonly key: number; readonly value: HistoryMessage }
  | { readonly kind: "r"; readonly key: number; readonly value: HistoryRecord }
  | { readonly kind: "s"; readonly key: number; readonly value: HistoryStageStart }
  /** 语音对象：版本新的才盖掉旧的 */
  | { readonly kind: "v"; readonly key: string; readonly value: VoiceRecord; readonly version: number }
  | { readonly kind: "a"; readonly key: string; readonly value: AgentVoiceRecord; readonly version: number };

/**
 * 一段：序号 lo..hi（都含）里当前分支上的消息、记录、阶段记号本机一条不缺。lo 是 1 就是从头起；
 * more：知道 lo 之前当前分支上还有消息（向电脑要来的一页说过"更早还有"）
 */
export interface CachedSpan {
  readonly lo: number;
  readonly hi: number;
  readonly more: boolean;
}

/** 是不是一个会话频道（秘书会话、某个负责人的会话） */
export function isConversationChannel(channel: string): boolean {
  return channel === CHANNELS.secretary || channel.startsWith(MAINTAINER_CHANNEL_PREFIX);
}

/**
 * 第一次订阅（游标为 0）时守护进程先补发的几种（history.ts 的 replayPins：最新那条会话树、这一页的消息引用的语音对象），
 * 序号在这一页之前；这一页本身从一条消息、排队或者回合开始起。看到别的种类就知道补发的那一页开始了
 */
const PIN_TYPES: ReadonlySet<string> = new Set([EVENT_TYPES.sessionBranch, EVENT_TYPES.voice, EVENT_TYPES.agentVoice]);

export function isReplayPinType(type: string): boolean {
  return PIN_TYPES.has(type);
}

/** 一条消息事件在历史分页里的样子（照守护进程 history.ts 的 historyMessageOf）：被彻底删除的只有"已删除"标记 */
function historyMessageOf(seq: number, payload: unknown): HistoryMessage {
  if (isDeletedEventPayload(payload)) return { seq, deleted: payload };
  const p = payload as MessageEventPayload;
  return {
    seq,
    message: p.message,
    ...(p.idempotencyKey === undefined ? {} : { idempotencyKey: p.idempotencyKey }),
    ...pickMessageScope(p),
    ...(p.queueDelivery === undefined ? {} : { queueDelivery: p.queueDelivery }),
    ...(p.agentInput === true ? { agentInput: true as const } : {}),
  };
}

/** 会话频道上的一条事件存成什么（消息、记录、阶段记号、语音对象）；不存的是 undefined */
export function cacheEntryOf(frame: EventFrame): ChatCacheEntry | undefined {
  switch (frame.type) {
    case EVENT_TYPES.message:
      return { kind: "m", key: frame.seq, value: historyMessageOf(frame.seq, frame.payload) };
    case EVENT_TYPES.timelineRecord:
    case EVENT_TYPES.quickActionExecuted:
      return { kind: "r", key: frame.seq, value: { seq: frame.seq, type: frame.type, payload: frame.payload } as HistoryRecord };
    case EVENT_TYPES.stageStart:
      return { kind: "s", key: frame.seq, value: { seq: frame.seq, payload: frame.payload as StageStartEventPayload } };
    case EVENT_TYPES.voice: {
      if (isDeletedEventPayload(frame.payload)) return undefined;
      const { voice } = frame.payload as VoiceEventPayload;
      return { kind: "v", key: voice.id, value: voice, version: voice.version };
    }
    case EVENT_TYPES.agentVoice: {
      if (isDeletedEventPayload(frame.payload)) return undefined;
      const { voice } = frame.payload as AgentVoiceEventPayload;
      return { kind: "a", key: voice.id, value: voice, version: voice.version };
    }
    default:
      return undefined;
  }
}

/** 向电脑要来的一页存成哪几条 */
export function cacheEntriesOfPage(page: HistoryPage): ChatCacheEntry[] {
  return [
    ...page.messages.map((m): ChatCacheEntry => ({ kind: "m", key: m.seq, value: m })),
    ...page.records.map((r): ChatCacheEntry => ({ kind: "r", key: r.seq, value: r })),
    ...(page.stageStarts ?? []).map((s): ChatCacheEntry => ({ kind: "s", key: s.seq, value: s })),
    ...(page.voices ?? []).map((v): ChatCacheEntry => ({ kind: "v", key: v.id, value: v, version: v.version })),
    ...(page.agentVoices ?? []).map((v): ChatCacheEntry => ({ kind: "a", key: v.id, value: v, version: v.version })),
  ];
}

/** 向电脑要来的一页（before 之前的）给的一段：这一页第一条消息（更早没有了的从 1）到 before - 1 */
export function spanOfPage(before: number, page: HistoryPage): CachedSpan | undefined {
  const lo = page.hasMore ? page.messages[0]?.seq : 1;
  if (lo === undefined || lo > before - 1) return undefined;
  return { lo, hi: before - 1, more: page.hasMore };
}

/** 并进一段：交叠、挨着的并成一段（起点更早的那段说了算"之前还有没有"） */
export function withSpan(spans: readonly CachedSpan[], span: CachedSpan): CachedSpan[] {
  if (span.hi < span.lo) return [...spans];
  const out: CachedSpan[] = [];
  let merged = span;
  for (const s of spans) {
    if (s.hi + 1 < merged.lo || merged.hi + 1 < s.lo) {
      out.push(s);
      continue;
    }
    const lo = Math.min(s.lo, merged.lo);
    const more = s.lo === merged.lo ? s.more || merged.more : s.lo < merged.lo ? s.more : merged.more;
    merged = { lo, hi: Math.max(s.hi, merged.hi), more: lo > 1 && more };
  }
  return [...out, merged].toSorted((a, b) => a.lo - b.lo);
}

/** 只留 end 之前（不含 end）的：会话树变了，end 起当前分支上有哪些说不准了 */
export function spansBefore(spans: readonly CachedSpan[], end: number): CachedSpan[] {
  return spans.flatMap((s) => (s.lo >= end ? [] : [{ ...s, hi: Math.min(s.hi, end - 1) }]));
}

/** 盖住这个序号的那一段 */
export function spanAt(spans: readonly CachedSpan[], seq: number): CachedSpan | undefined {
  return spans.find((s) => s.lo <= seq && seq <= s.hi);
}

/** 这个序号的事件在不在这棵树的当前分支上（没回退过的都在；照守护进程 historyPage 的 onPath） */
export function onPathOf(tree: ConversationBranches | undefined): (seq: number) => boolean {
  return tree === undefined || tree.branches.length <= 1 ? () => true : (seq) => onBranchPath(tree, seq);
}

/** 两棵会话树的当前路径从哪个序号起不一样（那之前每个序号在不在当前分支上，两棵树说的一样）；完全一样是 Infinity */
export function pathDivergence(a: ConversationBranches | undefined, b: ConversationBranches | undefined): number {
  const ra = pathRanges(a ?? SINGLE_BRANCH);
  const rb = pathRanges(b ?? SINGLE_BRANCH);
  const inA = (seq: number) => ra.some((r) => r.from <= seq && seq < r.to);
  const inB = (seq: number) => rb.some((r) => r.from <= seq && seq < r.to);
  // 路径是几段序号：各段的头尾把序号切成几截，每一截里在不在路径上不变，看每一截的开头就够了
  const points = [...new Set([0, ...ra, ...rb].flatMap((r) => (typeof r === "number" ? [r] : [r.from, r.to])))].filter(Number.isFinite).toSorted((x, y) => x - y);
  return points.find((p) => inA(p) !== inB(p)) ?? Number.POSITIVE_INFINITY;
}

/** 没回退过的会话树 */
const singleBranch = (t: ConversationBranches | undefined) => t === undefined || t.branches.length <= 1;

/** 一样的会话树（没回退过的都算一样） */
export function sameTree(a: ConversationBranches | undefined, b: ConversationBranches | undefined): boolean {
  if (singleBranch(a) && singleBranch(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 一页里的消息引用的语音：用户的语音（v:）、agent 的语音（a:）、发语音的调用建出的（c:，按调用 id 找） */
export interface VoiceRefs {
  readonly voices: readonly string[];
  readonly agentVoices: readonly string[];
  readonly calls: readonly string[];
}

/** 这几条消息引用的语音（照守护进程 history.ts 的 pageExtras：被彻底删除的不算） */
export function voiceRefsOf(messages: readonly HistoryMessage[]): VoiceRefs {
  const parts: MessagePart[] = messages.flatMap((m) => ("message" in m ? m.message.parts : []));
  return {
    voices: [...new Set(voiceIdsOf(parts))],
    agentVoices: [...new Set(agentVoiceIdsOf(parts))],
    calls: [...new Set(parts.flatMap((p) => (p.type === "tool_call" && p.tool === SEND_VOICE_TOOL ? [p.callId] : [])))],
  };
}

/** 发语音的调用建出的 agent 语音：调用 id → 语音 id */
export function cachedToolVoices(voices: readonly AgentVoiceRecord[]): Record<string, string> {
  return Object.fromEntries(voices.flatMap((v) => (v.mode === "tool" && v.toolCallId !== undefined ? [[v.toolCallId, v.id]] : [])));
}

/** 向电脑要来的一页里，消息引用了、守护进程却没有带回的语音（它本来就没有：发语音失败的调用、没建出来的）——以后本机拼这一页时不用等它 */
export function absentRefsOf(page: HistoryPage): string[] {
  const refs = voiceRefsOf(page.messages);
  const voices = new Set((page.voices ?? []).map((v) => v.id));
  const agentVoices = new Set((page.agentVoices ?? []).map((v) => v.id));
  const calls = cachedToolVoices(page.agentVoices ?? []);
  return [
    ...refs.voices.filter((id) => !voices.has(id)).map((id) => `v:${id}`),
    ...refs.agentVoices.filter((id) => !agentVoices.has(id)).map((id) => `a:${id}`),
    ...refs.calls.filter((id) => calls[id] === undefined).map((id) => `c:${id}`),
  ];
}

/** 从本机读出来、拼一页用的 */
export interface CachedRead {
  /** before 之前、这一段里当前分支上的消息，新的在前，最多 limit + 1 条 */
  readonly newest: readonly HistoryMessage[];
  /** 这一段里 before 之前的时间线记录、阶段记号（不分分支），按序号从早到晚 */
  readonly records: readonly HistoryRecord[];
  readonly stageStarts: readonly HistoryStageStart[];
  /** 读到的语音对象（按 id） */
  readonly voices: ReadonlyMap<string, VoiceRecord>;
  readonly agentVoices: ReadonlyMap<string, AgentVoiceRecord>;
}

/** 拼一页要知道的：会话、盖住 before - 1 的那一段、一页多少条、当前分支、发语音的调用建出的语音、知道本来就没有的语音 */
export interface CachedPageQuery {
  readonly conversation: string;
  readonly span: CachedSpan;
  readonly limit: number;
  readonly onPath: (seq: number) => boolean;
  readonly toolVoices: Readonly<Record<string, string>>;
  readonly absent: ReadonlySet<string>;
}

/**
 * 用本机存的拼一页（照守护进程 history.ts 的 historyPage）。拼不出来（这一段里 before 之前没有当前分支上的消息、
 * 引用的语音对象本机缺了又不知道它本来就没有）是 undefined，向电脑要
 */
export function cachedPage(query: CachedPageQuery, read: CachedRead): HistoryPage | undefined {
  const { span, limit, onPath } = query;
  if (read.newest.length === 0) return undefined;
  const messages = read.newest.slice(0, limit).toReversed();
  // 本机多读出一条就知道更早还有；不够 limit 条时，从头起的就是到头了，不是从头起的说"更早还有"（下次向电脑要缺的那一截）
  const hasMore = read.newest.length > limit || span.lo > 1;
  const from = hasMore ? messages[0]!.seq : 1;
  const records = read.records.filter((r) => r.seq >= from && onPath(r.seq));
  const stageStarts = read.stageStarts.filter((s) => s.seq >= from && onPath(s.seq));
  const refs = voiceRefsOf(messages);
  const voices: VoiceRecord[] = [];
  for (const id of refs.voices) {
    const voice = read.voices.get(id);
    if (voice) voices.push(voice);
    else if (!query.absent.has(`v:${id}`)) return undefined;
  }
  const agentVoices = new Map<string, AgentVoiceRecord>();
  for (const id of refs.agentVoices) {
    const voice = read.agentVoices.get(id);
    if (voice) agentVoices.set(id, voice);
    else if (!query.absent.has(`a:${id}`)) return undefined;
  }
  for (const callId of refs.calls) {
    const id = query.toolVoices[callId];
    const voice = id === undefined ? undefined : read.agentVoices.get(id);
    if (voice) agentVoices.set(voice.id, voice);
    else if (id !== undefined || !query.absent.has(`c:${callId}`)) return undefined;
  }
  return {
    conversation: query.conversation,
    messages,
    records,
    hasMore,
    ...(voices.length > 0 ? { voices } : {}),
    ...(agentVoices.size > 0 ? { agentVoices: [...agentVoices.values()] } : {}),
    ...(stageStarts.length > 0 ? { stageStarts } : {}),
  };
}

/** 拼这一页要读哪些语音对象（消息读出来之后才知道） */
export function voiceIdsToRead(messages: readonly HistoryMessage[], toolVoices: Readonly<Record<string, string>>): { voices: string[]; agentVoices: string[] } {
  const refs = voiceRefsOf(messages);
  return { voices: [...refs.voices], agentVoices: [...new Set([...refs.agentVoices, ...refs.calls.flatMap((c) => toolVoices[c] ?? [])])] };
}

/** 别的频道上让本机存的聊天记录作废的事 */
export type ChatCacheSignal =
  /** 会话里有消息被彻底删除了（彻底删除、删项目连带的工具调用记录……）：整份作废（宁可多向电脑要一次） */
  | { readonly kind: "purged" }
  /** 会话树换了一棵（回退、切换分支） */
  | { readonly kind: "tree"; readonly tree: ConversationBranches }
  /** 移除插件时连它的数据一起删了（语音插件的语音对象就在会话频道上）：整份作废 */
  | { readonly kind: "plugin_purged" }
  /** 这个会话整个删了（删任务、删项目时负责人会话一起删） */
  | { readonly kind: "conversation_deleted"; readonly conversation: string };

/** 一条事件让本机存的聊天记录怎么作废；不相干的是 undefined */
export function chatCacheSignalOf(frame: EventFrame): ChatCacheSignal | undefined {
  switch (frame.type) {
    case EVENT_TYPES.messagesPurged:
      return isConversationChannel(frame.channel) ? { kind: "purged" } : undefined;
    case EVENT_TYPES.sessionBranch:
      return isConversationChannel(frame.channel) && !isDeletedEventPayload(frame.payload) ? { kind: "tree", tree: (frame.payload as SessionBranchEventPayload).branches } : undefined;
    case EVENT_TYPES.pluginDataPurged:
      return { kind: "plugin_purged" };
    case EVENT_TYPES.task: {
      if (isDeletedEventPayload(frame.payload)) return undefined;
      const { task } = frame.payload as TaskEventPayload;
      // 照状态层的 withoutTask：任务自己的负责人（迁移来的作业负责人也算）的会话随任务删了
      if (!task.deleted || (!hasOwnMaintainer(task) && !task.maintainerId.startsWith("jm-"))) return undefined;
      return { kind: "conversation_deleted", conversation: maintainerChannel(task.maintainerId) };
    }
    case EVENT_TYPES.project: {
      if (isDeletedEventPayload(frame.payload)) return undefined;
      const { project, change } = frame.payload as ProjectEventPayload;
      return change === "deleted" ? { kind: "conversation_deleted", conversation: maintainerChannel(project.maintainerId) } : undefined;
    }
    default:
      return undefined;
  }
}

/** 一样东西存成 JSON 大约多少字节（UTF-8）：本机存了多少、上限按它算 */
export function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value) ?? "";
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}
