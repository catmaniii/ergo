// 素材的"回的是什么"：每晚整理之前，记忆管理员把会话里本人还没判过的话批量判一遍——
// 接着对方（秘书、负责人、记忆管理员、通知、卡片）的话说的，挂上前文意思的一两句总结；自己开的新话题、会话第一句不挂。
//
// - 哪些素材：会话里本人说的话（用户发言、投喂的材料；秘书、负责人、记忆管理员的会话都算），出处是会话里的一条消息、有本人的文字。
//   不判的：数据源导入的（另开票）、标了别推断的（不用来推断；取消了再判）、了解你访谈里的（管理员问的那一句已经排在前面，
//   materials/sources.ts 的 interviewQuestionSegments）、澄清问题的回答（不在会话里，问题本来就写在回答里）；
// - 前文是哪句：这句之前、同一会话当前分支上最近的一条不是用户说的（agent 的回复、通知、卡片；用户连着发了几条的往前跳过用户自己的，
//   只有工具调用、推理这类看不见的跳过）；连着那一段对方说的一起给（问的、提议的常在前面一条），太长留结尾。
//   往前碰到"清空当前对话"的分隔线、翻了 LOOKBACK 条还没有的，算会话第一句。不按时间间隔判：隔几小时才回照样交给模型看；
// - 判：会话第一句不问模型，直接记 first；别的一批 REPLY_CONTEXT_BATCH 句问一次模型（@ergo/memory 的 llm/reply-context.ts），
//   接着回的记 reply 和前文的总结、新话题记 new_topic；模型没判出来的不记，下一夜再判；
// - 每晚上限 REPLY_CONTEXT_PER_NIGHT 句（交给模型的；按事件里记的那一夜数，手动整理一次也算进同一夜），新的先判，
//   超了的留到下一夜——以前的素材就这样分批补上；
// - 记下：素材频道上的 material_replies 事件（一批一条），素材库照它在素材上标（materials/replies.ts）。素材只由守护进程从事件日志产生，
//   materials.db 重建时照样标回来；
// - 读成证据时（evidence-source.ts）原文后面接前文那一行；还没判、REPLY_HOLD_DAYS 天以内的先不读成证据（等判完再读，免得读进去的原文
//   没有前文、之后又改不了——证据原文一个字不改），更早的照常读（判不过来时不一直压着）。
import { REPLY_CONTEXT_BATCH, type ChatModel, judgeReplyContexts, localDate, type ReplyContextInput } from "@ergo/memory";
import {
  CHANNELS,
  EVENT_TYPES,
  INTERVIEW_QUESTION_FIELD,
  isDeletedEventPayload,
  MAINTAINER_CHANNEL_PREFIX,
  MATERIAL_REPLY_SUMMARY_MAX,
  type MaterialRepliesEventPayload,
  type MaterialReplyItem,
  MEMORY_CURATOR_CONVERSATION,
  type MessageEnvelope,
  type MessageEventPayload,
} from "@ergo/protocol";
import { pathEventsBefore } from "../conversation/session-branches.ts";
import { messageGlobalSeq } from "../conversation/views.ts";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import { MATERIALS_CHANNEL } from "../materials/commands.ts";
import type { Materials } from "../materials/materials.ts";
import type { Material, MaterialKind } from "../materials/types.ts";
import { clockIso, type Clock } from "../scheduler/clock.ts";

/** 每晚最多交给模型判几句（新的先判，多的留到下一夜） */
export const REPLY_CONTEXT_PER_NIGHT = 240;
/** 还没判的、这么多天以内的先不读成证据（等判完带着前文读） */
export const REPLY_HOLD_DAYS = 2;
/** 往前最多翻多少条消息找前文 */
const LOOKBACK = 60;
/** 连着的那一段对方说的最多带几条 */
const TURN_MESSAGES = 4;
/** 会话第一句一条事件最多记多少句 */
const FIRST_PER_EVENT = 200;

/** 会话里本人说的话（"回的是什么"只判这两种） */
const CANDIDATE_KINDS: ReadonlySet<MaterialKind> = new Set(["user_utterance", "fed_material"]);

/** 要判的素材：会话里本人说的、出处是一条消息、有本人的文字；数据源的、别推断的、访谈里的不判 */
export function isReplyCandidate(m: Material): boolean {
  if (!CANDIDATE_KINDS.has(m.kind) || m.source !== "self" || m.conversation === null || m.origin !== undefined || m.noInfer) return false;
  if (m.ref.messageId === undefined) return false;
  if (m.segments.some((s) => s.locator.field === INTERVIEW_QUESTION_FIELD)) return false;
  return m.segments.some((s) => s.source === "self" && s.text !== undefined && s.text.trim() !== "");
}

/**
 * 读成证据时先压着的：还没判"回的是什么"、REPLY_HOLD_DAYS 天以内的候选（判完再带着前文读）。
 * judged 是素材库判过的素材 id（Materials.replyJudged）；tried 是这一夜交给了模型、没判出来的（模型出错时不压着：
 * 照常不带前文读进去，免得模型一直不好用时新的话一直进不了推理库）
 */
export function replyHeldBack(judged: ReadonlySet<string>, now: string, tried: ReadonlySet<string> = new Set()): (m: Material) => boolean {
  const since = Date.parse(now) - REPLY_HOLD_DAYS * 86_400_000;
  return (m) => isReplyCandidate(m) && !judged.has(m.id) && !tried.has(m.id) && Date.parse(m.time) > since;
}

/** 前文：最近那条不是用户说的消息（id）、是谁说的（给模型看的说法）、连着那一段对方说的话 */
export interface Preceding {
  messageId: string;
  by: string;
  text: string;
}

/** 给模型看的"谁说的"（模型据此写"秘书问……"；页面上"秘书"换成用户起的名字） */
function speakerOf(conversation: string, message: MessageEnvelope, onlyCard: boolean): string {
  // @i18n-ignore-start model：交给模型的"谁说的"
  if (message.speaker === "system") return "通知";
  if (onlyCard) return "卡片";
  if (conversation === MEMORY_CURATOR_CONVERSATION) return "记忆管理员";
  if (conversation === CHANNELS.secretary) return "秘书";
  if (conversation.startsWith(MAINTAINER_CHANNEL_PREFIX)) return "负责人";
  return "对方";
  // @i18n-ignore-end
}

/** 一条消息看得见的内容：文字、卡片（纯文本降级）；工具调用、推理、简报这类看不见的不算 */
function visibleText(message: MessageEnvelope, cardText: (cardId: string) => string | undefined): { text: string; onlyCard: boolean } {
  const texts: string[] = [];
  let cards = 0;
  for (const part of message.parts) {
    if (part.type === "text" && part.text.trim() !== "") texts.push(part.text.trim());
    if (part.type === "card_ref") {
      const text = cardText(part.cardId);
      if (text !== undefined && text.trim() !== "") {
        texts.push(`［卡片］${text.trim()}`); // @i18n-ignore model：交给模型的前文
        cards += 1;
      }
    }
  }
  return { text: texts.join("\n"), onlyCard: cards > 0 && cards === texts.length };
}

/** 用户自己的（含秘书转达的、接管前的前情、官方 App 里补记的）：找前文时跳过 */
const isUserSide = (message: MessageEnvelope) => message.speaker === "user";
/** "清空当前对话"的分隔线：前面的不算前文 */
const isClearMarker = (message: MessageEnvelope) => message.parts.some((p) => p.type === "conversation_cleared");

/** 找前文、记结果要的事件日志（会话树、往前翻消息、按消息 id 找、追加） */
export type ReplyContextStore = EventStore;

/** 素材出处的那条消息在会话频道上的序号（语音的素材由 voice 事件产生，按消息 id 找那条消息）；找不到是 undefined */
function messageSeqOf(store: ReplyContextStore, m: Material): number | undefined {
  const { event, messageId } = m.ref;
  if (m.conversation === null || messageId === undefined) return undefined;
  if (event.type === EVENT_TYPES.message && event.channel === m.conversation) return event.seq;
  // 会话消息的视图里记着这条消息的全局序号，按它取回那条事件
  const globalSeq = messageGlobalSeq(store.reader, messageId);
  const found = globalSeq === undefined ? undefined : store.readGlobal(globalSeq - 1, 1)[0];
  if (found === undefined || found.globalSeq !== globalSeq || found.channel !== m.conversation || isDeletedEventPayload(found.payload)) return undefined;
  return (found.payload as MessageEventPayload).message.id === messageId ? found.seq : undefined;
}

/** 这条素材的前文；会话第一句（前面没有对方的话、碰到清空的分隔线、出处的消息找不到）是 undefined */
export function precedingOf(store: ReplyContextStore, m: Material, cardText: (cardId: string) => string | undefined = () => undefined): Preceding | undefined {
  const seq = messageSeqOf(store, m);
  if (seq === undefined || m.conversation === null) return undefined;
  const conversation = m.conversation;
  const events: StoredEvent[] = pathEventsBefore(store, conversation, seq, LOOKBACK, EVENT_TYPES.message);
  const turn: Array<{ message: MessageEnvelope; text: string; onlyCard: boolean }> = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (isDeletedEventPayload(e.payload)) continue;
    const message = (e.payload as MessageEventPayload).message;
    if (isClearMarker(message)) break;
    if (isUserSide(message)) {
      // 用户连着说的几句：还没碰到对方的话就接着往前找；碰到过了，这一段对方说的到此为止
      if (turn.length > 0) break;
      continue;
    }
    const visible = visibleText(message, cardText);
    if (visible.text === "") continue;
    turn.unshift({ message, ...visible });
    if (turn.length >= TURN_MESSAGES) break;
  }
  const anchor = turn.at(-1);
  if (anchor === undefined) return undefined;
  return { messageId: anchor.message.id, by: speakerOf(conversation, anchor.message, anchor.onlyCard), text: turn.map((t) => t.text).join("\n") };
}

/** 这一夜已经交给模型判了几句（没判出来的也算；按事件里记的那一夜数：手动整理一次和 03:00 的那次算同一夜） */
function askedTonight(store: ReplyContextStore, night: string): number {
  let n = 0;
  for (const e of store.read(MATERIALS_CHANNEL, 0, EVENT_TYPES.materialReplies)) {
    if (isDeletedEventPayload(e.payload)) continue;
    const p = e.payload as MaterialRepliesEventPayload;
    if (p.night === night) n += p.asked ?? 0;
  }
  return n;
}

export interface ReplyContextReport {
  /** 问了几次模型 */
  calls: number;
  /** 挂上前文的 */
  attached: number;
  /** 新话题 */
  newTopic: number;
  /** 会话第一句（不问模型） */
  first: number;
  /** 交给了模型、没判出来的（下一夜再判） */
  failed: number;
  /** 超了每晚上限、留到下一夜的 */
  pending: number;
}

/** 判一遍的结果：数（进整理记录），和这一遍交给了模型的素材（没判出来的读成证据时不压着） */
export interface ReplyContextRun {
  report: ReplyContextReport;
  tried: ReadonlySet<string>;
}

export interface JudgeRepliesOptions {
  store: ReplyContextStore;
  materials: Pick<Materials, "list" | "replyJudged">;
  /** 判的模型（和整理同一个：DeepSeek，外面包了档案的那一层和中止） */
  chat: ChatModel;
  clock: Clock;
  /** 卡片的纯文本降级（前文是卡片时给模型看） */
  cardText?: (cardId: string) => string | undefined;
  /** 每晚上限（默认 REPLY_CONTEXT_PER_NIGHT） */
  limit?: number;
  /** 最多问几次模型（这一夜整理剩下的预算） */
  maxCalls?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

/** 判一遍还没判的（见文件开头）；追加 material_replies 事件，交回这一遍的数 */
export async function judgeMaterialReplies(options: JudgeRepliesOptions): Promise<ReplyContextRun> {
  const { store, chat } = options;
  const log = options.log ?? (() => {});
  const cardText = options.cardText ?? (() => undefined);
  const now = clockIso(options.clock);
  const night = localDate(now);
  const report: ReplyContextReport = { calls: 0, attached: 0, newTopic: 0, first: 0, failed: 0, pending: 0 };
  const tried = new Set<string>();
  const judged = options.materials.replyJudged();
  // 新的先判
  const candidates = options.materials
    .list()
    .filter((m) => isReplyCandidate(m) && !judged.has(m.id))
    .toSorted((a, b) => Date.parse(b.time) - Date.parse(a.time));
  if (candidates.length === 0) return { report, tried };

  let room = Math.max(0, (options.limit ?? REPLY_CONTEXT_PER_NIGHT) - askedTonight(store, night));
  const first: MaterialReplyItem[] = [];
  const asks: Array<{ material: Material; preceding: Preceding }> = [];
  for (const material of candidates) {
    options.signal?.throwIfAborted();
    const preceding = precedingOf(store, material, cardText);
    if (preceding === undefined) first.push({ materialId: material.id, conversation: material.conversation!, verdict: "first" });
    else if (room > 0) {
      asks.push({ material, preceding });
      room -= 1;
    } else report.pending += 1;
  }

  const append = (payload: MaterialRepliesEventPayload) => {
    if (payload.items.length > 0 || (payload.asked ?? 0) > 0) store.append({ channel: MATERIALS_CHANNEL, type: EVENT_TYPES.materialReplies, payload });
  };
  for (let i = 0; i < first.length; i += FIRST_PER_EVENT) append({ night, items: first.slice(i, i + FIRST_PER_EVENT) });
  report.first = first.length;

  const maxCalls = options.maxCalls ?? Number.POSITIVE_INFINITY;
  for (let i = 0; i < asks.length; i += REPLY_CONTEXT_BATCH) {
    const batch = asks.slice(i, i + REPLY_CONTEXT_BATCH);
    if (report.calls >= maxCalls) {
      report.pending += asks.length - i;
      break;
    }
    options.signal?.throwIfAborted();
    const inputs: ReplyContextInput[] = batch.map(({ material, preceding }, j) => ({ id: `r${j + 1}`, by: preceding.by, before: preceding.text, user: userText(material) }));
    report.calls += 1;
    for (const { material } of batch) tried.add(material.id);
    const { judgments, error } = await judgeReplyContexts(chat, inputs);
    options.signal?.throwIfAborted();
    if (error !== undefined) log(`判素材回的是什么：一批 ${batch.length} 句没判成（下一夜再判）：${error}`);
    const items: MaterialReplyItem[] = [];
    batch.forEach(({ material, preceding }, j) => {
      const judgment = judgments.find((x) => x.id === `r${j + 1}`);
      if (judgment === undefined) {
        report.failed += 1;
        return;
      }
      const base = { materialId: material.id, conversation: material.conversation!, fromMessageId: preceding.messageId };
      if (judgment.reply) {
        items.push({ ...base, verdict: "reply", summary: clip(judgment.summary, MATERIAL_REPLY_SUMMARY_MAX) });
        report.attached += 1;
      } else {
        items.push({ ...base, verdict: "new_topic" });
        report.newTopic += 1;
      }
    });
    // 一句都没判出来也记一条（asked 算进这一夜的上限）
    append({ night, model: chat.name, asked: batch.length, items });
  }
  if (report.calls + report.first > 0) {
    log(`判素材回的是什么：问了 ${report.calls} 次模型，挂上前文 ${report.attached} 条、新话题 ${report.newTopic} 条、会话第一句 ${report.first} 条，没判出来 ${report.failed} 条，留到下一夜 ${report.pending} 条`);
  }
  return { report, tried };
}

/** 用户这句：本人切段的文字（引用块、附件这些不是用户说的，不给） */
function userText(m: Material): string {
  return m.segments
    .filter((s) => s.source === "self" && s.text !== undefined)
    .map((s) => s.text!)
    .join("\n");
}

/** 超长的截到上限（按字） */
function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}
