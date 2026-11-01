// 用户打字时 agent 也能发语音（86 号票，规格第 22 节"用户打字时也能发语音"）："发语音"工具 send_voice({ text })。
// 和用户直接对话的 agent 把一段口语稿合成成和语音回复一样的语音气泡（同一个合成服务、参考音色、分段推送、长按"转文字"）。
// "发语音"的行为都在这里：工具本身、回合结束时这一轮另写的文字收不收进气泡、重启时的收尾、被中断的调用补什么结果。
// 回合从哪儿开始、回复了哪些消息由语音回复（voice-reply.ts）跟着会话频道上的回合记下，交给这里（openTurn、closeTurn）。
// - 装配：和口语总结工具一样经 conversationTools 放进每个和用户说话的会话（秘书、负责人起草和执行、项目负责人各段、定时作业的运行），
//   工具列表固定（提示词前缀缓存不受影响）；用不用得了在调用时看这一轮（用户 2026-10-11 定"只给和用户直接对话的地方"）：
//   这一轮处理的用户消息（交给 agent 的那条输入，和子进程收下、已经进了上下文的插话：HostToolCall.interjected，宿主协议 16）里
//   有用户说的话才能发——个人助理、用户直接跟项目负责人说话、用户在任务详情里说话（负责人在忙时作为插话送进去）的那一轮；
//   后台在做的任务、定时 / 事件触发的运行、运行时的通知引起的一轮返回清楚的原因——只有一类通知例外（100 号票）：开了"跑完自动播报"的
//   任务做完的通知（secretary/notice-tags.ts 的 isAutoAnnounceNotice），开关是用户事先给的授权，秘书处理它的那一轮能发；
//   审批已批准、状态变化、开关关着的任务做完这些照旧不行。用户最后说的一句是语音（语音轮）、有参考音色时
//   直接返回"已经在合成了"（用户定：回复本来就由语音回复合成）；语音轮没有参考音色的照"没有参考音色"回。
// - 口语稿：去掉 Markdown 标记后送进 TTS（spoken-text.ts 的 speakable）；有代码、表格、图片、链接地址这类念不出来的不发，让 agent 去掉；
//   长度按 voice.reply 的 maxSeconds / charsPerSecond 算（estimateSpeechSeconds），超了返回"太长了，缩到 N 秒以内"，工具里不截。
//   工具说明照用户定的"要说的都放进语音"：要让用户听到的都写进口语稿，文字里只留念不出来的。
// - 没有参考音色：返回原因（不静默改走文字），待我处理里提示去导入（和语音回复同一条，开着的只有一条）。
// - 建出 agent 语音对象（mode 是 tool，直接是"合成中"，带上这一轮开始的序号 turnSeq 和工具调用 id），交给 voice-synthesis.ts 排队合成——
//   分段推送、入库、追加 tts_audio 消息、失败说明、重启重做都和语音回复共用；等合成有了结局，把结局（发出去了、只发了一部分、
//   没发出去和原因）交回 agent。最多等 SEND_VOICE_WAIT_MS：串行队列前面可能还排着别的语音（语音回复、别的会话发的），等不完就先交回
//   "还在合成"，语音照样合成、合成好自己出现在聊天里——不让单次工具调用的超时（默认 10 分钟）中止整轮。
// - 这一轮另写的文字（closeTurn，回合结束时）：照语音轮整段合成的判定——这一轮回复的文字去掉 Markdown 标记后念得完、又没有念不出来的，
//   语音也还在合成或合成好了，就收进气泡（coversReply: true），否则照常显示；这一轮的回复记在最后一条工具发的语音上。马上记
//   （合成那边在最新的一版上接着写，不会冲掉）。守护进程在回合结束之前停了的：重启时那一轮已经被打断，start 定成照常显示。
// - 守卫：不落入任何关注类别、不弹审批；每次多发一条消息，不是只读或幂等；被杀时语音由合成那边重启重做（recoveredByController，
//   不当成"中断不确定"），agent 的会话里那次调用补上"会自己补发、不要重发"（interruptedResults，经 interruptedToolResults）。
// - 日志只写字数、参考音色的 id、参考录音的文件名；不写要合成的正文、不写参考录音的完整路径。
// - 转述负责人的进展（354 号票，用户 2026-11-01 定，可选参数 relay：转述谁 source、负责人那段的稿子 text）：不增加打扰，跟现有规矩走，只是换声音——
//   秘书写两段，运行时合成一条语音：开场用秘书的声音，那段用发信人自己的声音。声音只能是运行时查的：工具没有指定音色、agent 的参数；
//   source 只认通知上记的（MessageEnvelope.relaySources，发信人也记在那里）——通知引起的一轮只认这条通知的，用户问的一轮认交给秘书过的通知，
//   写别的、还没来过信的任务都不发、交回原因；只有秘书的会话能带（负责人不能直接发）。发信人没有自己的声音（没配、和秘书一样、被删了，
//   ownVoiceOf）：不分两段，文字连起来就是一条秘书的语音。两段加起来算长度。用户发语音的那一轮记到这一轮上（relayThisTurn），语音回复念它们。
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  type AgentVoiceEventPayload,
  type AgentVoicePart,
  type AgentVoiceRecord,
  CHANNELS,
  type ConversationId,
  EVENT_TYPES,
  isDeletedEventPayload,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessageScope,
  nowIso,
  type TurnEndEventPayload,
  Type,
} from "@ergo/protocol";
import { defineHostTool, type HostTool, type HostToolOutput } from "../agent-manager/host-tools.ts";
import { getMessage } from "../conversation/views.ts";
import type { EventStore } from "../events/event-store.ts";
import type { InterruptedToolResult } from "../runtime/index.ts";
import { isAutoAnnounceNotice, MAINTAINER_LETTER_TAG, TASK_DONE_TAG } from "../secretary/notice-tags.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { getAgentVoice, recentToolVoices, toolVoicesAwaitingTurnEnd } from "../voice-records/index.ts";
import type { OwnVoice } from "./agent-voice-ref.ts";
import type { ReferenceVoices, ResolvedReferenceVoice } from "./reference-voices.ts";
import { estimateSpeechSeconds, fitsPace, type SpokenPace, speakable } from "./spoken-text.ts";
import {
  SEND_VOICE_INTERRUPTED,
  SEND_VOICE_PARAM,
  SEND_VOICE_RELAY_PARAM,
  SEND_VOICE_RELAY_SOURCE_PARAM,
  SEND_VOICE_RELAY_TEXT_PARAM,
  SEND_VOICE_RESULT,
  SEND_VOICE_TOOL,
  sendVoiceTitle,
  sendVoiceToolDescription,
} from "./texts.ts";
import type { VoiceSynthesis } from "./voice-synthesis.ts";

/**
 * 发语音工具最多等合成多久（毫秒）就先交回"还在合成"：比单次工具调用的默认超时（10 分钟）短得多，留出余量。
 * 一条 60 秒的语音合成约 55 秒，第一次用到时 audio.cpp 加载模型最多 90 秒，前面再排一两条语音，5 分钟够平常用
 */
export const SEND_VOICE_WAIT_MS = 5 * 60_000;

/** 守护进程重启后给 agent 的会话补结果时，看这个会话里最近几条工具发的语音（被中断的那次调用一定在最后一轮里） */
const INTERRUPTED_LOOKBACK = 20;

/** 会话里正在进行的一轮（语音回复跟着回合记下的）：这一轮开始的序号、回复此刻的归属 */
export interface SendVoiceTurn {
  seq: number;
  scope: MessageScope;
}

export interface SendVoiceOptions {
  store: EventStore;
  references: ReferenceVoices;
  /**
   * 这个会话里说话的 agent 现在用哪个参考音色（241 号票：自己配的覆盖全局，没配 / 被删了跟全局默认）；
   * 不给时用 references.current()（和以前一样）
   */
  voiceOf?: (conversation: ConversationId) => ResolvedReferenceVoice | undefined;
  /** 念多快、多长算长（配置里的 voice.reply） */
  pace: SpokenPace;
  synthesis: VoiceSynthesis;
  /** 这条输入是用户的语音吗（语音回复的判定：用户的语音，或者重新识别后交给 agent 的那条通知） */
  isVoiceInput(message: MessageEnvelope): boolean;
  /** 会话里正在进行的一轮；没有是 undefined */
  openTurn(conversation: ConversationId): SendVoiceTurn | undefined;
  /** 没有参考音色：待我处理里提示去导入 */
  announceMissing(): void;
  /** 语音轮里秘书写了两段（354 号票）：记到这一轮上，语音回复念它们；没有在进行的一轮（不该发生）回 false */
  relayThisTurn(conversation: ConversationId, relay: RelayedSpeech): boolean;
  /** 一个 agent 的角色名（354 号票，转文字时写）；不给时用 agent id */
  speakerName?: (agentId: string) => string;
  /** 这个 agent 自己的声音（354 号票）：没有是 undefined，这时退回一条秘书的语音；不给就是都没有 */
  ownVoiceOf?: (agentId: string) => OwnVoice | undefined;
  /** 最多等合成多久就先交回"还在合成"（毫秒）；不给是 SEND_VOICE_WAIT_MS */
  waitMs?: number;
  log(line: string): void;
}

/**
 * 一次转述合成什么（354 号票）：text 是连起来的（老的读者照常读得到，退回一条秘书的语音时念的也是它）；parts 是各段的声音和说话的人，
 * 发信人没有自己的声音时没有
 */
export interface RelayedSpeech {
  text: string;
  parts?: AgentVoicePart[];
}

export interface SendVoice {
  tool: HostTool;
  /**
   * 一轮结束（语音回复跟着回合走时调）：这一轮里工具发的语音定下另写的文字收不收进气泡、记下这一轮的回复。
   * seq 是这一轮开始的序号，replies 是 agent 这一轮发出的有内容的消息
   */
  closeTurn(conversation: ConversationId, turn: { seq: number; replies: readonly string[]; outcome: TurnEndEventPayload["outcome"] }): void;
  /** 启动（先于重新排队合成）：回合还没结束就停了的，那一轮已经被打断，另写的文字照常显示 */
  start(): void;
}

/** 一条工具调用只建一条语音 */
const createdKey = (toolCallId: string) => `agent-voice:tool:${toolCallId}`;

/** 秒数（结果里给 agent 看的，一位小数） */
const secondsOf = (ms: number | undefined) => Math.round((ms ?? 0) / 100) / 10;

/**
 * 合成的结局交回 agent 的话；undefined 是没等到（调用被中止、守护进程在停），still 是等了很久还在合成。
 * merged：这次带了 relay、但发信人没有自己的声音，合成的是一条秘书的语音（354 号票）
 */
function outcomeText(voice: AgentVoiceRecord | undefined | "still", merged = false): HostToolOutput {
  if (voice === "still") return { text: SEND_VOICE_RESULT.stillSynthesizing };
  switch (voice?.status) {
    case "done": {
      const seconds = secondsOf(voice.durationMs);
      const speaker = voice.parts?.at(-1)?.speaker.name;
      if (speaker !== undefined) return { text: SEND_VOICE_RESULT.relayDone(seconds, speaker) };
      return { text: merged ? SEND_VOICE_RESULT.relaySingle(seconds) : SEND_VOICE_RESULT.done(seconds) };
    }
    case "partial":
      return { text: voice.parts ? SEND_VOICE_RESULT.relayPartial(secondsOf(voice.durationMs), voice.error ?? "") : SEND_VOICE_RESULT.partial(secondsOf(voice.durationMs), voice.error ?? "") };
    case "failed":
      return { text: SEND_VOICE_RESULT.failed(voice.error ?? ""), isError: true };
    default:
      return { text: SEND_VOICE_RESULT.aborted };
  }
}

/** 等合成有了结局，最多等 ms 毫秒（等不完是 "still"） */
async function settledWithin(synthesis: VoiceSynthesis, voiceId: string, signal: AbortSignal | undefined, ms: number): Promise<AgentVoiceRecord | undefined | "still"> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), ms);
  try {
    const voice = await synthesis.settled(voiceId, signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal);
    return voice === undefined && deadline.signal.aborted && !signal?.aborted ? "still" : voice;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 守护进程（或 agent 子进程）重启后，给这个会话里被中断的发语音调用补上的结果（经 interruptedToolResults 交给子进程）：
 * 键是工具调用 id。子进程只给会话最后一轮里没有结果的调用补，多给的不用
 */
export function sendVoiceInterruptedResults(db: ReadonlyDatabase, conversation: string): Record<string, InterruptedToolResult> {
  return Object.fromEntries(recentToolVoices(db, conversation, INTERRUPTED_LOOKBACK).flatMap((v) => (v.toolCallId === undefined ? [] : [[v.toolCallId, { text: SEND_VOICE_INTERRUPTED, isError: false }]])));
}

export function createSendVoice(options: SendVoiceOptions): SendVoice {
  const { store, references, pace, synthesis, log } = options;
  const waitMs = options.waitMs ?? SEND_VOICE_WAIT_MS;
  /** 会话 → 正在进行的那一轮里工具发的语音（这一轮开始的序号） */
  const open = new Map<string, { seq: number; voices: string[] }>();

  /** 这一轮的回复里的文字（按先后，空行隔开） */
  const replyTextOf = (messageIds: readonly string[]) =>
    messageIds
      .flatMap((id) => getMessage(store.reader, id)?.parts ?? [])
      .flatMap((p) => (p.type === "text" && p.text.trim() ? [p.text] : []))
      .join("\n\n");

  /**
   * 这个来源是谁发的（354 号票）：只认通知上记的（MessageEnvelope.relaySources）。通知引起的一轮只认这条通知的；
   * 用户问的一轮认交给秘书过的通知（任务做完的、来信的）。同一个来源有几个发信人的（负责人和它的子 agent 的信并在一条里、
   * 来过好几次）：按最近的在前，有自己声音的优先（relayedSpeech 取第一个有声音的）。没有是空的
   */
  const relaySenders = (said: MessageEnvelope, source: string): string[] => {
    // 通知上记的在事件里（会话视图只有显示要的那几列）
    const delivered = [TASK_DONE_TAG, MAINTAINER_LETTER_TAG]
      .flatMap((tag) => store.mentioning(EVENT_TYPES.message, tag))
      .filter((e) => e.channel === CHANNELS.secretary && !isDeletedEventPayload(e.payload))
      .toSorted((a, b) => b.globalSeq - a.globalSeq)
      .map((e) => (e.payload as MessageEventPayload).message);
    const notices = isAutoAnnounceNotice(said) ? delivered.filter((m) => m.id === said.id) : delivered;
    return notices.flatMap((m) => (m.relaySources ?? []).filter((s) => s.source === source).map((s) => s.agentId));
  };

  /** 秘书写的两段 → 这次合成什么（354 号票）：发信人没有自己的声音的连成一条秘书的语音 */
  const relayedSpeech = (conversation: ConversationId, reference: ResolvedReferenceVoice, senders: readonly string[], opening: string, relayed: string): RelayedSpeech => {
    const text = `${opening}\n${relayed}`;
    const owner = senders.flatMap((agentId) => {
      const voice = options.ownVoiceOf?.(agentId);
      return voice ? [{ agentId, voice }] : [];
    })[0];
    if (!owner) return { text };
    return {
      text,
      parts: [
        { text: opening, referenceVoice: { id: reference.id, name: reference.name }, speaker: { agentId: conversation, name: options.speakerName?.(conversation) ?? conversation } },
        { text: relayed, referenceVoice: { id: owner.voice.reference.id, name: owner.voice.reference.name }, speaker: { agentId: owner.agentId, name: owner.voice.name } },
      ],
    };
  };

  const tool = defineHostTool({
    name: SEND_VOICE_TOOL,
    title: sendVoiceTitle(),
    description: sendVoiceToolDescription(pace, Math.max(1, Math.round(waitMs / 60_000))),
    parameters: Type.Object(
      {
        text: Type.String({ minLength: 1, description: SEND_VOICE_PARAM }),
        relay: Type.Optional(
          Type.Object(
            { source: Type.String({ minLength: 1, description: SEND_VOICE_RELAY_SOURCE_PARAM }), text: Type.String({ minLength: 1, description: SEND_VOICE_RELAY_TEXT_PARAM }) },
            { additionalProperties: false, description: SEND_VOICE_RELAY_PARAM },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    // 每调用一次多发一条语音消息；被杀时由合成那边重启重做（不当成说不清做没做完）
    readOnlyOrIdempotent: false,
    recoveredByController: true,
    async run({ text, relay }, call) {
      // 这一轮处理的用户消息：交给 agent 的那条输入，和子进程收下的插话；用户最后说的一句决定能不能发。
      // 开了"跑完自动播报"的任务做完的通知（100 号票）是用户事先给的授权：这一轮也能发（语音落在那条通知的回复里）
      // 144 号票：排队交出的一批里另外几条（moreInputMessageIds）也是这一轮处理的
      const handled = [call.inputMessageId, ...(call.moreInputMessageIds ?? []), ...(call.interjected ?? [])].flatMap((id) => (id === undefined ? [] : (getMessage(store.reader, id) ?? [])));
      // 秘书转达的话（103 号票）不算用户在和它直接说话：用户在秘书那里，不在这个会话里
      const said = handled.findLast((m) => (m.speaker === "user" && m.relayedBy === undefined) || options.isVoiceInput(m) || isAutoAnnounceNotice(m));
      if (!said) return { text: SEND_VOICE_RESULT.notDirect, isError: true };
      // 说话的是哪个 agent 用它的音色（241 号票）：自己配的，没配跟全局默认
      const reference = options.voiceOf?.(said.conversation) ?? references.current();
      if (!reference) {
        log("agent 想发语音，但还没有导入任何参考音色：这次没发");
        options.announceMissing();
        return { text: SEND_VOICE_RESULT.noReference, isError: true };
      }
      if (options.isVoiceInput(said) && !relay) return { text: SEND_VOICE_RESULT.voiceTurn };
      const conversation = said.conversation;
      // 转述（354 号票）：只有秘书能转述；转述谁只认通知上记的
      if (relay && conversation !== CHANNELS.secretary) return { text: SEND_VOICE_RESULT.relayNotSecretary, isError: true };
      const senders = relay ? relaySenders(said, relay.source.trim()) : [];
      if (relay && senders.length === 0) return { text: isAutoAnnounceNotice(said) ? SEND_VOICE_RESULT.relayNotInNotice(relay.source) : SEND_VOICE_RESULT.relayNothing(relay.source), isError: true };
      const spoken = speakable(text);
      const relayed = relay ? speakable(relay.text) : undefined;
      if (spoken.unspeakable || relayed?.unspeakable) return { text: SEND_VOICE_RESULT.unspeakable, isError: true };
      if (!spoken.text || relayed?.text === "") return { text: SEND_VOICE_RESULT.nothingToSay, isError: true };
      // 两段加起来算长度
      const estimated = estimateSpeechSeconds(`${spoken.text}${relayed?.text ?? ""}`, pace);
      if (estimated > pace.maxSeconds) return { text: SEND_VOICE_RESULT.tooLong(estimated, pace), isError: true };
      const speech: RelayedSpeech = relayed ? relayedSpeech(conversation, reference, senders, spoken.text, relayed.text) : { text: spoken.text };
      // 用户发语音的那一轮：语音回复本来就会合成，这一轮念这两段（不另建一条）
      if (options.isVoiceInput(said)) {
        if (!options.relayThisTurn(conversation, speech)) return { text: SEND_VOICE_RESULT.voiceTurn };
        log(`agent 在语音轮里转述：${[...speech.text].length} 字，${speech.parts ? "分两段的声音" : "一条的声音"}`);
        return { text: SEND_VOICE_RESULT.relayVoiceTurn };
      }
      const turn = options.openTurn(conversation);
      const time = nowIso();
      const voice: AgentVoiceRecord = {
        id: `av-${randomUUID()}`,
        conversation,
        scope: turn?.scope ?? {},
        inputMessageId: said.id,
        ...(turn ? { turnSeq: turn.seq } : {}),
        replyMessageIds: [],
        mode: "tool",
        // 不在一轮里（不该发生）：没有回合结束来定，这一轮另写的文字照常显示
        ...(turn ? {} : { coversReply: false }),
        toolCallId: call.toolCallId,
        text: speech.text,
        referenceVoice: { id: reference.id, name: reference.name },
        ...(speech.parts ? { parts: speech.parts } : {}),
        status: "synthesizing",
        createdAt: time,
        updatedAt: time,
        version: 1,
      };
      const payload: AgentVoiceEventPayload = { voice };
      if (store.append({ channel: conversation, type: EVENT_TYPES.agentVoice, payload, idempotencyKey: createdKey(call.toolCallId) }).duplicate) {
        return { text: SEND_VOICE_RESULT.alreadySent };
      }
      log(`agent 用发语音工具发语音（agent 语音 ${voice.id}）：${[...speech.text].length} 字，参考音色 ${reference.id}（${path.basename(reference.audioPath)}）${speech.parts ? `，后面一段用 ${speech.parts[1]!.referenceVoice.id}` : ""}`);
      if (turn) {
        const current = open.get(conversation);
        if (current?.seq === turn.seq) current.voices.push(voice.id);
        else open.set(conversation, { seq: turn.seq, voices: [voice.id] });
      }
      synthesis.enqueue(voice.id);
      return outcomeText(await settledWithin(synthesis, voice.id, call.signal, waitMs), relay !== undefined && !speech.parts);
    },
  });

  return {
    tool,
    closeTurn(conversation, turn) {
      const current = open.get(conversation);
      if (current?.seq !== turn.seq) return;
      open.delete(conversation);
      const last = current.voices.at(-1);
      const plain = speakable(replyTextOf(turn.replies));
      const speakableReply = turn.outcome === "completed" && plain.text !== "" && !plain.unspeakable && fitsPace(plain.text, pace);
      for (const voiceId of current.voices) {
        const voice = getAgentVoice(store.reader, voiceId);
        if (!voice) continue;
        // 已经没合成出来、只合成了一部分的没有气泡可收：文字照常显示（和语音轮一样）；还在合成的先按收进去记，之后没合成出来的按状态不收
        const coversReply = speakableReply && (voice.status === "synthesizing" || voice.status === "done");
        synthesis.advance(voice, { coversReply, replyMessageIds: voiceId === last ? [...turn.replies] : [] });
      }
    },
    start() {
      for (const voice of toolVoicesAwaitingTurnEnd(store.reader)) synthesis.advance(voice, { coversReply: false });
    },
  };
}
