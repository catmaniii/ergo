// 每晚整理判顺口问的回答要的"问过以后用户说的话"（271 号票）：守护进程这一侧的 ReplyFollowUpSource（@ergo/memory 的 rg/reply-judge.ts 调它）。
//
// - 从哪算起：秘书标了这个问题的那一轮（会话里最近一次 mark_woven_question 的工具调用，编号对得上、做成了的）；
//   找不到那一轮（271 以前按原样带那一句问的、会话被清掉了）就按问题记的"最近一次问的时间"算；
// - 取哪些：同一个会话（秘书主会话）里那之后用户本人说的话（秘书转达的不算），问过以后 REPLY_WINDOW_HOURS 小时内（按消息上记的时间），
//   按先后；每句给它的素材 id（整理时这条素材已经读成证据，@ergo/memory 按 sourceRef 对回去；没有素材、别推断、敏感类别没打开的，
//   @ergo/memory 对不上证据，就不交给模型）；
// - 秘书那一轮的回话（问在里面，用的是它自己的话）一起给，模型判的时候知道当时是怎么问的。
// 只读：读会话的派生视图和素材库，不写。
import { REPLY_FOLLOW_UPS, REPLY_WINDOW_HOURS, type ReplyContext, type ReplyFollowUp, type QuestionView } from "@ergo/memory";
import { CHANNELS, type MessageEnvelope } from "@ergo/protocol";
import { agentRepliesAround, lastToolCallMessage, userMessagesAfter, userMessagesSince } from "../conversation/views.ts";
import type { Materials } from "../materials/materials.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { MARK_WOVEN_QUESTION } from "./tool-names.ts";

/** 多取几句候选（有的没有素材、对不上证据，@ergo/memory 那边丢掉以后最多留 REPLY_FOLLOW_UPS 句） */
const CANDIDATES = REPLY_FOLLOW_UPS * 2;

export interface ConversationFollowUpsOptions {
  /** 事件日志的只读连接（会话消息的派生视图） */
  reader: ReadonlyDatabase;
  /** 素材库：这句话的素材（素材 id 是证据的 sourceRef） */
  materials: Pick<Materials, "list">;
}

/** 用户本人说的（秘书转达的不算） */
const userSaid = (message: MessageEnvelope) => message.speaker === "user" && message.relayedBy === undefined;

/** agent 一条回话里的文字（工具调用、卡片不算） */
const replyText = (message: MessageEnvelope) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

/** 取问过以后用户说的话（第二个参数是整理的时间，ReplyFollowUpSource 的约定；这里按消息上记的时间开窗，用不着它） */
export type ConversationFollowUps = (question: Pick<QuestionView, "id" | "lastAskedAt">, options?: { at: string }) => ReplyContext;

export function conversationFollowUps(options: ConversationFollowUpsOptions): ConversationFollowUps {
  const conversation = CHANNELS.secretary;
  /** 这句话的素材（本人的；一条消息带着附件、语音时可能有几条，取第一条） */
  const sourceRefOf = (message: MessageEnvelope): string | undefined => options.materials.list({ messageId: message.id }).find((material) => material.source === "self")?.id;
  const followUp = (message: MessageEnvelope): ReplyFollowUp => {
    const sourceRef = sourceRefOf(message);
    return { at: message.time, ...(sourceRef === undefined ? {} : { sourceRef }) };
  };

  return (question) => {
    const asked = lastToolCallMessage(options.reader, conversation, MARK_WOVEN_QUESTION, question.id);
    if (asked !== undefined) {
      const until = Date.parse(asked.message.time) + REPLY_WINDOW_HOURS * 3_600_000;
      const said = agentRepliesAround(options.reader, conversation, asked.globalSeq).map(replyText).join("\n").trim();
      const followUps = userMessagesAfter(options.reader, conversation, asked.globalSeq, CANDIDATES)
        .filter((message) => userSaid(message) && Date.parse(message.time) <= until)
        .map(followUp);
      return { ...(said === "" ? {} : { askedAs: said }), followUps };
    }
    // 找不到秘书标的那一轮：按问过的时间算
    if (question.lastAskedAt === null) return { followUps: [] };
    const until = Date.parse(question.lastAskedAt) + REPLY_WINDOW_HOURS * 3_600_000;
    const followUps = userMessagesSince(options.reader, conversation, question.lastAskedAt, CANDIDATES)
      .filter((message) => userSaid(message) && Date.parse(message.time) <= until)
      .map(followUp);
    return { followUps };
  };
}
