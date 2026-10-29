// 语音消息的素材（规格第 15、22 节，31 号票）和彻底删除时怎么改写它的事件。
// - 用户的语音算用户发言（本人）：识别完成（voice 事件、状态完成）时产生一条素材。素材的文字是识别出的文字，
//   切段注明"转写"，信封的情境标签带 voice_transcript；切段里同时留着音频的引用，随原文副本一起存。
//   识别失败的没有文字，不产生素材（用户重新识别成功时才产生）。了解你访谈（284 号票）开着时在记忆管理员的会话里说的，
//   语音对象带着访谈编号（interviewId），情境标签多一个 interview（"来自访谈"）；带着管理员问的那一句（interviewQuestion）的，
//   那一句作为上下文切段排在转写前面。
//   消息事件本身不为语音产生素材（materials/sources.ts 不给语音切段）：那时还没有文字。语音连同附件一起发的（2026-10-10 起），
//   附件由消息事件另产生一条（情境标签 with_voice），两条素材指向同一条消息。
// - 彻底删除：素材的原始事件是识别完成的那条 voice 事件，改写成去掉文字的样子（识别出的文字、分段、失败原因换成删除标记，
//   状态、模型、时长这些不变）；连带改写（related）这条语音的消息（整条换成"已删除"，没有别的消息引用的音频随之删掉）、
//   这条语音的其余 voice 事件，以及重新识别成功后交给 agent 的那条通知（里面有转写）。
// - 设置里按会话、按时间段彻底删除时，没有素材的语音（识别失败的、还没识别完的、素材早先被忘掉了的）也要删掉消息和音频：
//   voicePurgeTargets 给出范围里这些语音的原始事件，记忆模块的批量删除把它们和素材的原始事件一起改写（连带的照上）。
// 214 号票起语音是插件（voice/），这里是内核的数据契约（voice-records/index.ts）：素材来源和改写函数由语音插件在它的数据契约里登记
// （ADR-0027：不管开没开都登记，停用也不撤），设置里成批删除时没有素材的语音（voicePurgeTargets）由内核直接用——语音插件停用了照样删得掉。
import {
  EVENT_TYPES,
  INTERVIEW_CONTEXT,
  isDeletedEventPayload,
  type MaterialScope,
  type MessageEventPayload,
  PURGED_TEXT,
  settledVoiceText,
  type VoiceEventPayload,
  type VoiceRecord,
} from "@ergo/protocol";
import { getMessage } from "../conversation/views.ts";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import type { PurgeRewriter } from "../events/purge.ts";
import { conversationKind, interviewQuestionSegments, type Material, type MaterialSource, segmentPieces } from "../materials/index.ts";
import { voicesIn } from "./views.ts";

/**
 * 用户重新识别成功后交给 agent 的那条通知的幂等键（31 号票，每条语音最多一条：识别完成之后不能再重新识别）：
 * 彻底删除时连带改写它（里面有转写）
 */
export const voiceRetryNoticeKey = (voiceId: string) => `voice-retry-notice:${voiceId}`;

/** 素材信封上表示"语音转写"的情境标签 */
export const VOICE_TRANSCRIPT_CONTEXT = "voice_transcript";

export const voiceMaterialSource: MaterialSource = {
  name: "user-voice",
  eventType: EVENT_TYPES.voice,
  capture(event) {
    const { voice } = event.payload as Partial<VoiceEventPayload>;
    if (!voice?.recognition) return [];
    const text = settledVoiceText(voice);
    if (text === undefined) return [];
    return [
      {
        kind: "user_utterance",
        source: "self",
        // 素材的时间是说话（发消息）的时间，不是识别完成的时间
        time: voice.createdAt,
        conversation: voice.conversation,
        ...(voice.taskId === undefined ? {} : { task: voice.taskId }),
        ...(voice.projectId === undefined ? {} : { project: voice.projectId }),
        context: [conversationKind(voice.conversation), VOICE_TRANSCRIPT_CONTEXT, ...(voice.interviewId === undefined ? [] : [INTERVIEW_CONTEXT])],
        // 访谈里的（284 号票）：管理员问的那一句排在转写前面（上下文，不是本人的话）
        segments: [
          ...(voice.interviewId === undefined ? [] : interviewQuestionSegments(voice.interviewQuestion)),
          ...segmentPieces([{ form: "voice", mediaId: voice.mediaId, transcript: text, locator: { part: 0 } }]),
        ],
        ref: { messageId: voice.messageId, recordId: voice.id },
      },
    ];
  },
};

/** 一条语音去掉文字：识别出的文字、分段的文字和识别失败的原因换成删除标记，别的不变 */
export function purgedVoice(voice: VoiceRecord): VoiceRecord {
  return {
    ...voice,
    ...(voice.recognition
      ? { recognition: { ...voice.recognition, text: PURGED_TEXT, segments: voice.recognition.segments.map((s) => ({ ...s, text: PURGED_TEXT })) } }
      : {}),
    ...(voice.error === undefined ? {} : { error: PURGED_TEXT }),
  };
}

/** 引用这条语音的消息：用户发的那条 */
function messagesOf(store: EventStore, voice: VoiceRecord): StoredEvent[] {
  return store.mentioning(EVENT_TYPES.message, voice.id).filter((e) => {
    if (e.channel !== voice.conversation || isDeletedEventPayload(e.payload)) return false;
    return (e.payload as MessageEventPayload).message.parts.some((p) => p.type === "voice" && p.voiceId === voice.id);
  });
}

export const voicePurge: PurgeRewriter = {
  eventType: EVENT_TYPES.voice,
  rewrite(event) {
    const payload = event.payload as VoiceEventPayload;
    // 别的字段（180 号票的 dropInput）照留
    return { ...payload, voice: purgedVoice(payload.voice) } satisfies VoiceEventPayload;
  },
  related(event, store) {
    const { voice } = event.payload as VoiceEventPayload;
    const others = store.mentioning(EVENT_TYPES.voice, voice.id).filter((e) => e.channel === voice.conversation && (e.payload as Partial<VoiceEventPayload>).voice?.id === voice.id);
    const notice = store.eventByIdempotencyKey(voiceRetryNoticeKey(voice.id));
    return [...messagesOf(store, voice), ...others, ...(notice && !isDeletedEventPayload(notice.payload) ? [notice] : [])];
  },
};

/**
 * 设置里彻底删除一个范围（会话、时间段）时，范围里没有素材的语音的原始事件（31 号票）：识别失败的、还没识别完的、
 * 素材早先被忘掉了的。消息已经不在了（删过了）的不算；时间按说话（发消息）的时间。
 * materials 是这次一起删的素材：有素材的语音由素材那边带上，这里不重复
 */
export function voicePurgeTargets(store: EventStore, scope: MaterialScope, materials: readonly Material[]): StoredEvent[] {
  // 只删一条素材（158 号票，设置里看过内容后删的）：不连带别的语音
  if (scope.kind === "material") return [];
  const covered = new Set(materials.map((m) => m.ref.recordId));
  const from = scope.kind === "time_range" ? Date.parse(scope.from) : Number.NEGATIVE_INFINITY;
  const to = scope.kind === "time_range" ? Date.parse(scope.to) : Number.POSITIVE_INFINITY;
  const out: StoredEvent[] = [];
  for (const voice of voicesIn(store.reader, scope.kind === "conversation" ? scope.conversation : undefined)) {
    const time = Date.parse(voice.createdAt);
    if (covered.has(voice.id) || time < from || time > to || !getMessage(store.reader, voice.messageId)) continue;
    const event = store.mentioning(EVENT_TYPES.voice, voice.id).find((e) => (e.payload as Partial<VoiceEventPayload>).voice?.id === voice.id);
    if (event) out.push(event);
  }
  return out;
}
