// agent 用语音回复（规格第 22 节，32 号票）。用户发的是语音，agent 这一轮的回复就由运行时合成语音（秘书和维护者的会话都一样）：
//
// - 是否用语音：运行时按"用户上一条是不是语音"判定，不只靠提示词。看的是这一轮处理的用户消息（交给 agent 的那条输入，
//   和这一轮里收下的插话）里最后一条：它是语音就用语音回复。用户重新识别了之前没识别出来的语音、运行时交给 agent 的那条通知
//   （31 号票，isVoiceRetryNotice）也算用户的语音。别的运行时通知引起的一轮不用语音（比如任务执行中的阶段通知）。
// - 交给 agent 的这条语音输入后面跟一条说明（输入后面的上下文消息，有参考音色时才带）：这次的回复会合成语音，
//   回复长或有念不出来的内容时用"口语总结"工具另写一段适合听的。口语总结工具由各处的装配放进代为执行的工具
//   （秘书、维护者起草和执行、项目维护者的各段都有；守卫照常判定，不落入任何关注类别）。
// - 这一轮开始（turn_start）时输入是语音、有参考音色：建出 agent 语音对象（replying，记下这一轮开始的序号）。
//   用户 2026-10-08 定：这一轮前端不流式显示回复的文字，只显示"正在回复…"。
// - 一轮结束（完成）时定口语稿：回复的文字去掉 Markdown 标记后估出来念得完（maxSeconds 内）、又没有代码表格链接这类
//   念不出来的，整段合成（合成好只出语音气泡，文字收进语音，长按"转文字"才看）；否则合成口语总结，详细内容照常是这一轮的
//   文字和附件——agent 用工具写了就用它（太长的截到念得完）；没写的先追问它一次（followUp：会话在处理下一条输入之前交给它，
//   这次不算新回复，它说的不进会话，用量照常记账），追问了还没写才由运行时兜底（回复开头念得完的几句，加一句
//   "详细内容我发在聊天里了"）。口语稿定了就排队合成（一次一条：显卡和 drama 共用）。
// - 分段合成（38 号票）：口语稿按句切成几段（spoken-text.ts 的 speechSegments，第一段短），一段一次请求依次合成；
//   每合成好一段（最后一段除外）存进临时区（segment-files.ts，前端经 HTTP 取）、追加一个新版本带上已合成的段（时长、在整条里的
//   位置），前端第一段到了就出气泡、接着播。全部合成好拼成一条完整音频（同样的格式，段间留 SEGMENT_GAP_MS 的停顿）入库。
//   只有一段的不推段，合成好直接完成。语音对象记第一段出来用了多久（firstSegmentMs）和整条用了多久（elapsedMs）。
//   段的文件在这条语音有了结局之后再留 SEGMENT_KEEP_MS 才删（前端可能还在取最后一段），守护进程启动时全删。
// - 合成完成时同一事务追加它的新版本和载着它的消息（tts_audio part，带上合成出的音频、时长、波形、实际的模型）；
//   不论在哪一步失败（服务没开、忙、出错、超时、回的不是 WAV、存不进去、参考音色被删了）都记成失败，会话里追加一条说明，
//   这一轮退回只发文字。服务忙（503）不等超时，说明里写"语音服务忙"。分段合成到一半失败的（已经推出去了几段）：
//   推出去的几段拼成一条，记成"只合成了一部分"（partial），同样追加载着它的消息，会话里一条说明，回复的文字照常显示。
// - 这一轮最后没用语音（没回复完、最后一句不是语音、没有要念的文字、没有参考音色）的记成 skipped，文字照常显示。
//   没有任何参考音色时不建语音对象，待我处理里放一条"去导入参考音色"（开着的只有一条），导入之后自动归档。
// - 守护进程在途中停了（被杀了），重启后：还在回复的记成 skipped（那条输入由会话标成中断，不重送）；在追问口语总结的
//   直接由运行时兜底；还在合成的重做一遍（合成只是几次 HTTP 调用，不算"中断不确定"）：推过的段先收回，从第一段重新合成。
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AGENT_VOICE_SEGMENT_FADE_MS,
  type AgentVoiceEventPayload,
  type AgentVoiceRecord,
  type AgentVoiceSegment,
  type ConversationId,
  EVENT_TYPES,
  type MessageEnvelope,
  type MessageEventPayload,
  type MessagePart,
  type MessageScope,
  nowIso,
  pickMessageScope,
  type TurnEndEventPayload,
  type TurnStartEventPayload,
  Type,
} from "@ergou/protocol";
import { defineHostTool } from "../agent-manager/host-tools.ts";
import type { AgentVoiceReplies } from "../conversation/agent-session.ts";
import { buildMessage, newMessageId } from "../conversation/messages.ts";
import { getMessage, startedInputs } from "../conversation/views.ts";
import type { EventStore, NewEvent, StoredEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { Clock } from "../scheduler/clock.ts";
import { getAgentVoice, unsettledAgentVoices } from "./agent-voice-views.ts";
import type { ReferenceVoices } from "./reference-voices.ts";
import { openSegmentFiles } from "./segment-files.ts";
import { createSerialQueue, nextVersion, standingNotice } from "./shared.ts";
import { type SpeechSynthesizer, SpeechServiceBusy } from "./speech.ts";
import { estimateSpeechSeconds, fitsPace, leadingSentences, runtimeSummary, type SpokenPace, speakable, speechSegments } from "./spoken-text.ts";
import {
  MISSING_REFERENCE_NOTICE,
  NOT_WAV,
  referenceGoneReason,
  SKIPPED,
  SEGMENT_FORMAT_MISMATCH,
  SPEECH_BUSY,
  SPOKEN_SUMMARY_NOT_NEEDED,
  SPOKEN_SUMMARY_PARAM,
  SPOKEN_SUMMARY_TAKEN,
  SPOKEN_SUMMARY_TITLE,
  SPOKEN_SUMMARY_TOOL,
  spokenSummaryToolDescription,
  storeFailedReason,
  summaryFollowUpText,
  synthesisFailedNote,
  synthesisPartialNote,
  voiceInputContext,
} from "./texts.ts";
import { isVoiceRetryNotice } from "./voice.ts";
import { joinWavs, readWav, sameWavFormat, type WavInfo, wavOffsetsMs, wavWaveform } from "./wav.ts";

/** 合成出的语音的波形摘要有几格（和 Web 录音的一样） */
const WAVEFORM_BARS = 32;
/** 分段合成的段间停顿（毫秒）：拼成完整音频时留，前端边收边播时按各段的位置排，听起来一样 */
const SEGMENT_GAP_MS = 200;
/** 一条语音有了结局之后，它的段的文件再留多久才删（毫秒）：前端可能还在取最后一段 */
const SEGMENT_KEEP_MS = 5 * 60_000;

/** 分段合成里合成好的一段 */
type Piece = { bytes: Buffer; info: WavInfo };

/** 各段在语音对象里的样子：时长、在整条里的位置 */
function segmentsOf(pieces: readonly Piece[]): AgentVoiceSegment[] {
  const offsets = wavOffsetsMs(
    pieces.map((p) => p.info),
    SEGMENT_GAP_MS,
  );
  return pieces.map((p, i) => ({ durationMs: p.info.durationMs, offsetMs: offsets[i]! }));
}

/** 日志里的秒数 */
const seconds = (ms: number) => (ms / 1000).toFixed(1);

export interface VoiceRepliesOptions {
  store: EventStore;
  media: MediaStore;
  inbox: InboxService;
  references: ReferenceVoices;
  speech: SpeechSynthesizer;
  /** 念多快、多长算长（配置里的 voice.reply） */
  pace: SpokenPace;
  /** 段的文件什么时候删按它算（测试里换成手动拨的） */
  clock: Clock;
  /** 合成出的 WAV 先写在这里再入库，分段合成的段也放在这里（数据目录的临时区） */
  tmpDir: string;
  log: (line: string) => void;
}

/** 语音回复：给 agent 的（口语总结工具、输入后面的说明、追问）加上自己的启停 */
export interface VoiceReplies extends AgentVoiceReplies {
  /** 开始跟着会话频道上的回合走；上次没处理完的接着处理 */
  start(): void;
  /** 分段合成里合成好的一段的文件（HTTP 接口发给前端）；没有是 undefined */
  segmentFile(voiceId: string, index: number): string | undefined;
  /** 合成队列空了（测试用） */
  whenIdle(): Promise<void>;
  stop(): Promise<void>;
}

/** 一个会话里正在进行的一轮 */
interface OpenTurn {
  inputMessageId: string;
  /** 这一轮处理的输入：交给 agent 的那条，和这一轮里收下的插话（按先后） */
  handled: string[];
  /** agent 这一轮发出的、有内容的消息（文字、图片、文件、卡片……） */
  replies: string[];
  /** 这一轮的回复带着的归属（最后一条回复的；还没有回复时是输入的） */
  scope: MessageScope;
  /** 这一轮开始时就建出的 agent 语音对象（输入是语音、有参考音色时） */
  voiceId?: string;
}

/** 回复里算"内容"的 part：工具调用记录、推理不算 */
const CONTENT_PARTS: ReadonlySet<MessagePart["type"]> = new Set(["text", "image", "file", "video", "card_ref"]);

/** 一轮只回一条语音：agent 语音对象由这条输入的幂等键建出 */
const createdKey = (inputMessageId: string) => `agent-voice:${inputMessageId}`;

/** 口语稿怎么定：整段合成、用 agent 写的口语总结，或者还得追问它 */
type SpokenPlan = { mode: "whole"; summaryBy?: undefined; text: string } | { mode: "summary"; summaryBy: "agent"; text: string } | { mode: "summary"; summaryBy?: undefined; text?: undefined };

export function createVoiceReplies(options: VoiceRepliesOptions): VoiceReplies {
  const { store, media, inbox, references, speech, pace, clock, log } = options;
  /** 会话 → 正在进行的一轮 */
  const turns = new Map<string, OpenTurn>();
  /** 输入的消息 id → agent 写的口语总结（最后一次为准） */
  const summaries = new Map<string, string>();
  /** 在追问口语总结的：输入的消息 id → agent 语音 id，会话接了追问没有 */
  const asking = new Map<string, { voiceId: string; asked: boolean }>();
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let unwatchReferences: (() => void) | undefined;
  const aborter = new AbortController();
  const queue = createSerialQueue((id) => synthesize(id), { label: "合成语音", log });
  const segmentFiles = openSegmentFiles(path.join(options.tmpDir, "tts-segments"));
  /** 等着删段的文件的计时器（停的时候取消；没删的下次启动时全删） */
  const removals = new Set<() => void>();
  /** 这条语音有了结局：它的段再留 SEGMENT_KEEP_MS 才删 */
  const removeSegmentsLater = (voiceId: string) => {
    const cancel = clock.setTimer(clock.now() + SEGMENT_KEEP_MS, () => {
      removals.delete(cancel);
      segmentFiles.remove(voiceId);
    });
    removals.add(cancel);
  };
  const missing = standingNotice({ store, inbox, notice: "voice_reference_missing" });

  /** 这条输入是用户的语音吗 */
  const isVoiceInput = (message: MessageEnvelope) => (message.speaker === "user" && message.parts.some((p) => p.type === "voice")) || isVoiceRetryNotice(store, message);

  /** 这一轮要不要用语音回复：处理的用户消息里最后一条是语音 */
  const voiceTurn = (turn: OpenTurn): boolean => {
    for (const id of turn.handled.toReversed()) {
      const message = getMessage(store.reader, id);
      if (!message) continue;
      if (isVoiceInput(message)) return true;
      if (message.speaker === "user") return false;
    }
    return false;
  };

  const tool = defineHostTool({
    name: SPOKEN_SUMMARY_TOOL,
    title: SPOKEN_SUMMARY_TITLE,
    description: spokenSummaryToolDescription(pace),
    parameters: Type.Object({ text: Type.String({ minLength: 1, description: SPOKEN_SUMMARY_PARAM }) }, { additionalProperties: false }),
    readOnlyOrIdempotent: true,
    run({ text }, call) {
      const inputMessageId = call.inputMessageId;
      const message = inputMessageId === undefined ? undefined : getMessage(store.reader, inputMessageId);
      const turn = message && turns.get(message.conversation);
      const replying = turn !== undefined && turn.inputMessageId === inputMessageId && voiceTurn(turn);
      if (!message || (!replying && !asking.has(message.id))) return { text: SPOKEN_SUMMARY_NOT_NEEDED };
      summaries.set(message.id, text.trim());
      return { text: SPOKEN_SUMMARY_TAKEN };
    },
  });

  // ───────────── agent 语音对象的变化 ─────────────

  /**
   * 追加下一个版本（还是 from 这一版才写：没被删掉、没被别处改过）；写了返回新的一版。
   * extra 是同一事务追加的事件，drop 是要去掉的字段
   */
  const advance = (
    from: AgentVoiceRecord,
    change: Partial<AgentVoiceRecord>,
    { extra = () => [], drop = [] }: { extra?: (next: AgentVoiceRecord) => NewEvent[]; drop?: ReadonlyArray<keyof AgentVoiceRecord> } = {},
  ): AgentVoiceRecord | undefined => {
    const latest = getAgentVoice(store.reader, from.id);
    if (!latest || latest.version !== from.version) return undefined;
    const { record, event } = nextVersion(EVENT_TYPES.agentVoice, latest, change, drop);
    store.appendBatch([event, ...extra(record)]);
    return record;
  };

  /** 建出一条 agent 语音（一条输入只建一次） */
  const create = (conversation: ConversationId, inputMessageId: string, fields: Omit<AgentVoiceRecord, "id" | "conversation" | "inputMessageId" | "createdAt" | "updatedAt" | "version">): AgentVoiceRecord | undefined => {
    const time = nowIso();
    const voice: AgentVoiceRecord = { id: `av-${randomUUID()}`, conversation, inputMessageId, ...fields, createdAt: time, updatedAt: time, version: 1 };
    const payload: AgentVoiceEventPayload = { voice };
    const result = store.append({ channel: conversation, type: EVENT_TYPES.agentVoice, payload, idempotencyKey: createdKey(inputMessageId) });
    return result.duplicate ? undefined : voice;
  };

  /** 这一轮最后没用语音回复 */
  const skip = (voice: AgentVoiceRecord | undefined, reason: string) => {
    if (voice) advance(voice, { status: "skipped", error: reason });
  };

  /** 口语稿定了：排队合成 */
  const toSynthesis = (voice: AgentVoiceRecord, change: Partial<AgentVoiceRecord>) => {
    const next = advance(voice, { ...change, status: "synthesizing" });
    if (next) queue.enqueue(next.id);
  };

  // ───────────── 跟着会话频道上的回合走 ─────────────

  const onEvent = (event: StoredEvent) => {
    switch (event.type) {
      case EVENT_TYPES.turnStart: {
        const { inputMessageId } = event.payload as TurnStartEventPayload;
        const open = turns.get(event.channel);
        // 一轮里收下的插话：回合结束前补上它们的 turn_start、turn_end
        if (open && open.inputMessageId !== inputMessageId) {
          open.handled.push(inputMessageId);
          return;
        }
        // 这一轮回复的归属先取输入的（agent 发了消息就换成它的）
        const conversation = event.channel as ConversationId;
        const input = startedInputs(store.reader, conversation).find((q) => q.messageId === inputMessageId);
        const turn: OpenTurn = { inputMessageId, handled: [inputMessageId], replies: [], scope: input?.scope ?? {} };
        turns.set(event.channel, turn);
        // 输入是语音、有参考音色：这一轮用语音回复，回复的文字不流式显示
        const message = getMessage(store.reader, inputMessageId);
        if (message && isVoiceInput(message) && references.current()) {
          turn.voiceId = create(conversation, inputMessageId, { scope: turn.scope, turnSeq: event.seq, replyMessageIds: [], status: "replying" })?.id;
        }
        return;
      }
      case EVENT_TYPES.message: {
        const turn = turns.get(event.channel);
        const payload = event.payload as Partial<MessageEventPayload>;
        const message = payload.message;
        // 会话里别的 agent（子 agent，带 agentId）发的不算这一轮的回复
        if (!turn || message?.speaker !== "agent" || payload.agentId !== undefined || !message.parts.some((p) => CONTENT_PARTS.has(p.type))) return;
        turn.replies.push(message.id);
        turn.scope = pickMessageScope(payload as MessageEventPayload);
        return;
      }
      case EVENT_TYPES.turnEnd: {
        const { inputMessageId, outcome } = event.payload as TurnEndEventPayload;
        const turn = turns.get(event.channel);
        if (turn?.inputMessageId === inputMessageId) endTurn(event.channel as ConversationId, turn, outcome);
        return;
      }
      default:
        return;
    }
  };

  /** 这一轮的回复里的文字（按先后，空行隔开） */
  const replyTextOf = (messageIds: readonly string[]) =>
    messageIds
      .flatMap((id) => getMessage(store.reader, id)?.parts ?? [])
      .flatMap((p) => (p.type === "text" && p.text.trim() ? [p.text] : []))
      .join("\n\n");

  /** agent 写的口语总结念出来的样子（太长的截到念得完；念不出东西的是 undefined） */
  const agentSummary = (summary: string | undefined): string | undefined => {
    const spoken = summary === undefined ? "" : speakable(summary).text;
    if (!spoken) return undefined;
    return fitsPace(spoken, pace) ? spoken : leadingSentences(spoken, pace);
  };

  /** 定口语稿：短的、念得出来的整段合成；不然用 agent 写的口语总结；它没写就得追问 */
  const planSpoken = (replyText: string, summary: string | undefined): SpokenPlan => {
    const plain = speakable(replyText);
    if (plain.text && !plain.unspeakable && fitsPace(plain.text, pace)) return { mode: "whole", text: plain.text };
    const written = agentSummary(summary);
    return written ? { mode: "summary", summaryBy: "agent", text: written } : { mode: "summary" };
  };

  /** 一轮结束：定这一轮用不用语音、口语稿是什么；回复长又没写口语总结的，等会话追问 agent（followUp） */
  const endTurn = (conversation: ConversationId, turn: OpenTurn, outcome: TurnEndEventPayload["outcome"]) => {
    turns.delete(conversation);
    const summary = summaries.get(turn.inputMessageId);
    summaries.delete(turn.inputMessageId);
    const replying = turn.voiceId === undefined ? undefined : getAgentVoice(store.reader, turn.voiceId);
    if (outcome !== "completed") return skip(replying, SKIPPED.turnNotCompleted(outcome));
    if (!voiceTurn(turn)) return skip(replying, SKIPPED.lastInputNotVoice);
    const replyText = replyTextOf(turn.replies);
    if (!replyText.trim() && !summary) return skip(replying, SKIPPED.nothingToSay);
    const reference = references.current();
    if (!reference) {
      announceMissing();
      return skip(replying, SKIPPED.noReference);
    }
    const plan = planSpoken(replyText, summary);
    const decided = {
      scope: turn.scope,
      replyMessageIds: [...turn.replies],
      mode: plan.mode,
      ...(plan.summaryBy === undefined ? {} : { summaryBy: plan.summaryBy }),
      ...(plan.text === undefined ? {} : { text: plan.text }),
      referenceVoice: { id: reference.id, name: reference.name },
    } satisfies Partial<AgentVoiceRecord>;
    const status = plan.text === undefined ? "summarizing" : "synthesizing";
    // 插话里的语音让这一轮用了语音：回合结束时才建出
    const voice = replying ? advance(replying, { ...decided, status }) : create(conversation, turn.inputMessageId, { ...decided, status });
    if (!voice) return;
    if (status === "synthesizing") return queue.enqueue(voice.id);
    // 回复长、agent 没写口语总结：等会话追问它一次（会话在追加 turn_end 之后同一刻接过去）；没有会话接（不该发生）就直接兜底
    asking.set(turn.inputMessageId, { voiceId: voice.id, asked: false });
    setImmediate(() => {
      if (asking.get(turn.inputMessageId)?.asked === false) afterFollowUp(turn.inputMessageId);
    });
  };

  /** 追问结束（或者没法追问）：agent 补写了口语总结就用它，还是没写由运行时从回复开头截 */
  const afterFollowUp = (inputMessageId: string) => {
    const pending = asking.get(inputMessageId);
    asking.delete(inputMessageId);
    const summary = summaries.get(inputMessageId);
    summaries.delete(inputMessageId);
    const voice = pending && getAgentVoice(store.reader, pending.voiceId);
    if (!voice || voice.status !== "summarizing" || stopped) return;
    settleSummary(voice, summary);
  };

  /** 定下口语总结（agent 写的，或者运行时截的）去合成 */
  const settleSummary = (voice: AgentVoiceRecord, summary: string | undefined) => {
    const written = agentSummary(summary);
    if (written) return toSynthesis(voice, { summaryBy: "agent", text: written });
    toSynthesis(voice, { summaryBy: "runtime", text: runtimeSummary(speakable(replyTextOf(voice.replyMessageIds)).text, pace) });
  };

  // ───────────── 合成 ─────────────

  /** 没合成出来：记成失败，会话里追加一条说明（这一轮只发文字） */
  const fail = (voice: AgentVoiceRecord, reason: string) => {
    log(`agent 语音 ${voice.id} 没合成出来：${reason}`);
    advance(voice, { status: "failed", error: reason }, {
      extra: (next) => [buildMessage({ conversation: next.conversation, speaker: "system", parts: [{ type: "text", text: synthesisFailedNote(reason) }] }, next.scope).event],
    });
    removeSegmentsLater(voice.id);
  };

  /** 合成出的 WAV 入库：先写进临时区，再按内容哈希收进媒体库 */
  const ingest = async (voice: AgentVoiceRecord, wav: Buffer): Promise<{ mediaId: string; mime: string }> => {
    fs.mkdirSync(options.tmpDir, { recursive: true });
    const tmp = path.join(options.tmpDir, `tts-${voice.id}-${randomUUID()}.wav`);
    try {
      fs.writeFileSync(tmp, wav);
      const { mediaId } = await media.ingestFile(tmp, { name: `${voice.id}.wav`, mime: "audio/wav" });
      return { mediaId, mime: media.info(mediaId)?.audio?.mime ?? "audio/wav" };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  };

  const synthesize = async (voiceId: string) => {
    let voice = getAgentVoice(store.reader, voiceId);
    if (!voice || voice.status !== "synthesizing" || voice.text === undefined || voice.referenceVoice === undefined) return;
    const reference = references.get(voice.referenceVoice.id);
    if (!reference) return fail(voice, referenceGoneReason(voice.referenceVoice.name));
    // 上次合成到一半守护进程停了：推过的段收回（它们的文件启动时已经删了），从第一段重做
    if (voice.segments !== undefined) {
      voice = advance(voice, {}, { drop: ["segments", "segmentCount", "firstSegmentMs"] });
      if (!voice?.text) return;
    }
    const texts = speechSegments(voice.text);
    const plan = texts.length > 0 ? texts : [voice.text];
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const pieces: Piece[] = [];
    let model = speech.model;
    let firstSegmentMs: number | undefined;
    /** 没合成下去：推出去了几段的拼成一条，记成只合成了一部分；一段都没有的记成失败 */
    const giveUp = (reason: string) => (pieces.length === 0 ? fail(voice!, reason) : settle(voice!, pieces, { model, firstSegmentMs, elapsed }, { status: "partial", reason }));
    for (const [index, text] of plan.entries()) {
      let wav: Buffer;
      try {
        ({ wav, model } = await speech.synthesize(
          { text, voiceId: reference.id, voiceRef: reference.audioPath, referenceText: reference.referenceText },
          { estimatedSeconds: estimateSpeechSeconds(text, pace), signal: aborter.signal },
        ));
      } catch (err) {
        // 守护进程在停：这条留在"合成中"，下次启动重做
        if (stopped) return;
        return giveUp(err instanceof SpeechServiceBusy ? SPEECH_BUSY : err instanceof Error ? err.message : String(err));
      }
      if (stopped) return;
      const info = readWav(wav);
      if (!info) return giveUp(NOT_WAV);
      if (pieces[0] && !sameWavFormat(pieces[0].info, info)) return giveUp(SEGMENT_FORMAT_MISMATCH);
      if (plan.length === 1) {
        pieces.push({ bytes: wav, info });
        break;
      }
      // 不止一段：存下这一段给前端取；不是最后一段的推一次（最后一段随完成一起推）
      try {
        segmentFiles.write(voice.id, index, wav);
      } catch (err) {
        return giveUp(storeFailedReason(err instanceof Error ? err.message : String(err)));
      }
      pieces.push({ bytes: wav, info });
      firstSegmentMs ??= elapsed();
      if (index === plan.length - 1) break;
      const next = advance(voice, { segmentCount: plan.length, segments: segmentsOf(pieces), firstSegmentMs, model });
      // 语音对象被别处改了（比如所在的项目删了）：不再合成
      if (!next) return;
      voice = next;
    }
    await settle(voice, pieces, { model, firstSegmentMs, elapsed, segmentCount: plan.length }, { status: "done" });
  };

  /**
   * 合成出了音频的结局：拼成一条入库，和载着它的消息同一事务追加。全部合成好是完成（done）；没合成下去、
   * 但已经推出去了几段的是只合成了一部分（partial，带原因，会话里另有一条说明）。
   * pieces 是要拼的段（不止一段的是推出去的那几段，只有一段的是合成好的那一段），至少一段
   */
  const settle = async (
    voice: AgentVoiceRecord,
    pieces: readonly Piece[],
    timing: { model: string; firstSegmentMs: number | undefined; elapsed: () => number; segmentCount?: number },
    outcome: { status: "done" } | { status: "partial"; reason: string },
  ) => {
    let stored: { mediaId: string; mime: string; durationMs: number; waveform: number[] };
    try {
      const wav = pieces.length === 1 ? pieces[0]!.bytes : joinWavs(pieces, { gapMs: SEGMENT_GAP_MS, fadeMs: AGENT_VOICE_SEGMENT_FADE_MS });
      const info = readWav(wav)!;
      stored = { ...(await ingest(voice, wav)), durationMs: info.durationMs, waveform: wavWaveform(wav, info, WAVEFORM_BARS) };
    } catch (err) {
      return fail(voice, storeFailedReason(err instanceof Error ? err.message : String(err)));
    }
    const { mediaId, mime, durationMs, waveform } = stored;
    const messageId = newMessageId();
    const segmentCount = timing.segmentCount ?? voice.segmentCount ?? 1;
    // 只有一段的不推段：第一声就是整条合成好的时候
    const segmented = segmentCount > 1;
    // 整条的耗时算到拼好入库
    const elapsedMs = timing.elapsed();
    const firstSegmentMs = segmented ? (timing.firstSegmentMs ?? elapsedMs) : elapsedMs;
    const reason = outcome.status === "partial" ? outcome.reason : undefined;
    const change: Partial<AgentVoiceRecord> = {
      status: outcome.status,
      model: timing.model,
      segmentCount,
      ...(segmented ? { segments: segmentsOf(pieces) } : {}),
      mediaId,
      mime,
      durationMs,
      waveform,
      messageId,
      firstSegmentMs,
      elapsedMs,
      ...(reason === undefined ? {} : { error: reason }),
    };
    log(
      reason === undefined
        ? `agent 语音 ${voice.id} 合成好了：${segmentCount} 段，语音 ${seconds(durationMs)} 秒，第一段用了 ${seconds(firstSegmentMs)} 秒，整条用了 ${seconds(elapsedMs)} 秒`
        : `agent 语音 ${voice.id} 只合成了 ${segmentCount} 段里的前 ${pieces.length} 段：${reason}`,
    );
    advance(voice, change, {
      extra: (next) => [
        buildMessage({ id: messageId, conversation: next.conversation, speaker: "agent", parts: [{ type: "tts_audio", voiceId: next.id, mediaId, mime, durationMs, waveform }] }, next.scope).event,
        ...(reason === undefined ? [] : [buildMessage({ conversation: next.conversation, speaker: "system", parts: [{ type: "text", text: synthesisPartialNote(reason) }] }, next.scope).event]),
      ],
    });
    removeSegmentsLater(voice.id);
  };

  // ───────────── 没有参考音色 ─────────────

  const announceMissing = () => {
    log("用户发了语音，但还没有导入任何参考音色：这次只发文字");
    missing.raise({ ...MISSING_REFERENCE_NOTICE, urgency: "non_blocking", actions: [...MISSING_REFERENCE_NOTICE.actions] });
  };

  return {
    tool,
    inputContext(message) {
      if (!isVoiceInput(message) || !references.current()) return undefined;
      return voiceInputContext(pace);
    },
    followUp(conversation, inputMessageId) {
      // 会话在追加 turn_end 之后同一刻来接；这一轮的结束还没经订阅处理到（嵌套追加时）就现在处理
      const turn = turns.get(conversation);
      if (turn?.inputMessageId === inputMessageId) endTurn(conversation, turn, "completed");
      const pending = asking.get(inputMessageId);
      if (!pending || pending.asked) return undefined;
      pending.asked = true;
      return { text: summaryFollowUpText(pace), done: () => afterFollowUp(inputMessageId) };
    },
    start() {
      unsubscribe = store.onAppend((event) => {
        if (stopped) return;
        try {
          onEvent(event);
        } catch (err) {
          log(`语音回复跟回合出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      });
      unwatchReferences = references.onChange(() => {
        if (references.current()) missing.retire();
      });
      // 上次没处理完的：还在回复的那一轮已经被打断（会话把那条输入标成中断，不重送）；在追问口语总结的直接兜底；
      // 还在合成的重做一遍（合成只是几次 HTTP 调用）。分段合成的段都是临时的：全删，重做的从头再推
      segmentFiles.clear();
      for (const voice of unsettledAgentVoices(store.reader)) {
        if (voice.status === "replying") skip(voice, SKIPPED.restarted);
        else if (voice.status === "summarizing") settleSummary(voice, undefined);
        else queue.enqueue(voice.id);
      }
    },
    segmentFile: (voiceId, index) => segmentFiles.file(voiceId, index),
    whenIdle: () => queue.whenIdle(),
    async stop() {
      stopped = true;
      unsubscribe?.();
      unwatchReferences?.();
      aborter.abort();
      for (const cancel of removals) cancel();
      removals.clear();
      await queue.stop();
    },
  };
}
