// 按二狗自己记下的事件整理一段会话（293 号票）：给"另起一次生成"用（runtime/recorded-generation.ts：Claude Code 撤回时给被放弃的那段写分支摘要；
// 309 号票起还有 Claude Code 的范围审视——审视哪段由 unreviewedRanges 定，整理时另记下里面交给 agent 的输入，recordedSegment）。运行时自己的会话记录（Claude Code 的是内部格式）不读——二狗这一侧全程有记录（288 号票起每条消息、
// 每次工具调用都记），够写摘要、做审视。
// 怎么整理（会话频道上给定的序号段里的消息，按先后）：
// - 用户说的（文字、语音识别出的字）、运行时交给 agent 的通知（系统消息里的文字）→ user；
// - agent 的回复：文字、思考、这条回复里的工具调用 → assistant，每次调用后面跟一条 tool_result（结果按完整内容记的，取不到用结果摘要；
//   参数按完整内容记的原样参数，长字符串截短）；Claude Code 的文件路径参数（file_path）另抄一份成 path，pi 写摘要时据此列出读过、改过的文件；
// - 之前的分支摘要 → branch_summary；分隔线、卡片、清空这些不算会话内容，不带。
// 交给 agent 的输入（309 号票，recordedSegment 的 inputIds）：整理进来的用户消息（不交给 agent 的、接管时导进来的前情不算）和运行时给 agent 的通知
// （agentInput）的消息 id——范围审视的工作记录里有它们的原话，范围记录记着，彻底删除其中一条时连带改写（同 pi 子进程报的 inputIds）。
import {
  agentSessionStart,
  EVENT_TYPES,
  isDeletedEventPayload,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  pathRanges,
  rangesFrom,
  type SeqRange,
  settledVoiceText,
  type TimelineRecordEventPayload,
  voiceIdsOf,
} from "@ergo/protocol";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import { findToolCallDetail } from "../guard-runtime/tool-call-details.ts";
import type { RecordedCall, RecordedTurn } from "../runtime/index.ts";
import { getVoice } from "../voice-records/views.ts";
import { branchTreeOf, pathEventsBefore } from "./session-branches.ts";

/** 参数里一个字符串最多留多少字（写摘要、审视不需要整份文件内容） */
const ARG_MAX = 2000;
/** 一条工具结果最多留多少字（pi 把会话转成文字时还会再截） */
const RESULT_MAX = 4000;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 参数里的长字符串截短（嵌套的也截） */
function shorten(value: unknown): unknown {
  if (typeof value === "string") return clip(value, ARG_MAX);
  if (Array.isArray(value)) return value.map(shorten);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v)]));
  return value;
}

/** 记下的参数：长字符串截短，文件路径参数另抄一份成 path；不是对象的（清掉了只剩摘要的）用参数摘要 */
function recordedArgs(args: unknown, summary: string): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { summary };
  const out = shorten(args) as Record<string, unknown>;
  if (out.path === undefined && typeof out.file_path === "string") out.path = out.file_path;
  return out;
}

/** 一条消息里的文字：文字段，加上语音识别出的字 */
function messageText(store: Pick<EventStore, "reader">, message: MessageEnvelope): string {
  const texts = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
  for (const voiceId of voiceIdsOf(message.parts)) {
    const voice = getVoice(store.reader, voiceId);
    const text = voice && settledVoiceText(voice);
    if (text) texts.push(text);
  }
  return texts.join("\n").trim();
}

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

/** agent 的一条回复：文字、思考、工具调用和它们的结果（子代理里的调用不算：它们的结果已经在派它的那次调用里了） */
function replyTurns(store: EventStore, message: MessageEnvelope): RecordedTurn[] {
  const text = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
  const thinking = message.parts.flatMap((p) => (p.type === "reasoning" ? [p.text] : [])).join("\n");
  const parts = message.parts.filter((p): p is ToolCallPart => p.type === "tool_call" && p.parentCallId === undefined);
  const calls: RecordedCall[] = [];
  const results: RecordedTurn[] = [];
  for (const part of parts) {
    const detail = findToolCallDetail(store, part.callId);
    calls.push({ id: part.callId, tool: part.tool, args: recordedArgs(detail?.args, part.argsSummary) });
    results.push({ role: "tool_result", callId: part.callId, tool: part.tool, text: clip(detail?.result ?? part.resultSummary ?? "", RESULT_MAX), isError: part.outcome !== "done" });
  }
  if (!text.trim() && !thinking.trim() && calls.length === 0) return [];
  return [{ role: "assistant", text, ...(thinking.trim() ? { thinking } : {}), calls }, ...results];
}

/** 整理好的一段会话，和里面交给 agent 的输入（消息 id，按先后） */
export interface RecordedSegment {
  turns: RecordedTurn[];
  inputIds: string[];
}

/** 这条消息是不是交给 agent 的输入：用户自己发的（不交给 agent 的、接管时的前情不算），运行时给 agent 的通知 */
function agentInputOf(payload: MessageEventPayload): boolean {
  const { message } = payload;
  if (message.speaker === "user") return payload.dropInput !== true && message.prelude !== true;
  return payload.agentInput === true;
}

/** 会话频道上这几段序号里的会话内容，按先后（见文件开头） */
export function recordedTranscript(store: EventStore, conversation: string, ranges: readonly SeqRange[]): RecordedTurn[] {
  return recordedSegment(store, conversation, ranges).turns;
}

/** 会话频道上这几段序号里的会话内容，连同交给 agent 的输入（309 号票：范围审视的结果记着它们） */
export function recordedSegment(store: EventStore, conversation: string, ranges: readonly SeqRange[]): RecordedSegment {
  const turns: RecordedTurn[] = [];
  const inputIds: string[] = [];
  for (const range of ranges) {
    for (const event of store.read(conversation, range.from - 1, EVENT_TYPES.message)) {
      if (event.seq >= range.to) break;
      if (isDeletedEventPayload(event.payload)) continue;
      const payload = event.payload as MessageEventPayload;
      const { message } = payload;
      if (message.speaker === "agent") {
        turns.push(...replyTurns(store, message));
        continue;
      }
      const branch = message.parts.find((p) => p.type === "branch_summary");
      if (branch) {
        turns.push({ role: "branch_summary", text: branch.summary });
        continue;
      }
      const text = messageText(store, message);
      if (!text) continue;
      turns.push({ role: "user", text });
      if (agentInputOf(payload)) inputIds.push(message.id);
    }
  }
  return { turns, inputIds };
}

/** 当前路径上最后一条合 match 的事件（只看 type 这一类）的序号；没有是 -1 */
function lastOnPath(store: EventStore, conversation: string, type: string, match: (event: StoredEvent) => boolean): number {
  let before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const page = pathEventsBefore(store, conversation, before, 200, type);
    for (let i = page.length - 1; i >= 0; i--) {
      const event = page[i]!;
      if (!isDeletedEventPayload(event.payload) && match(event)) return event.seq;
    }
    if (page.length < 200) return -1;
    before = page[0]!.seq;
  }
}

/**
 * 这段会话里还没审视过的部分（309 号票：Claude Code 的范围审视，压缩之前、工单结束时）：当前路径上，这段会话开始（agent 新开一段会话的地方：
 * 清空、换模型换运行时、项目维护者的会话分段线，agentSessionStart）和最近一次压缩（时间线上"这里压缩过一次"，压缩时审视过了）之后的序号段。
 * Claude Code 压缩时整段写进摘要（不像 pi 留着最近的一截），所以压缩过的都审视过了
 */
export function unreviewedRanges(store: EventStore, conversation: string): SeqRange[] {
  const started = lastOnPath(store, conversation, EVENT_TYPES.message, (e) => agentSessionStart((e.payload as MessageEventPayload).message));
  const compacted = lastOnPath(store, conversation, EVENT_TYPES.timelineRecord, (e) => (e.payload as TimelineRecordEventPayload).record.kind === "compaction");
  return rangesFrom(pathRanges(branchTreeOf(store.reader, conversation)), Math.max(started, compacted) + 1);
}
