// 一段口语稿变成 agent 的语音气泡（86 号票从 voice-reply.ts 抽出来）：语音回复（用户发语音的那一轮，voice-reply.ts）和
// "发语音"工具（用户打字的那一轮，send-voice.ts）共用这一半。口语稿怎么定、什么时候用语音由它们自己管，交到这里的是
// 一条已经定了口语稿和参考音色、状态是"合成中"（synthesizing）的 agent 语音对象：
// - 排队：一次一条（显卡和 drama 共用同一个 audio.cpp），在 agent 处理下一条输入时照常进行。
// - 分段合成（38 号票）：口语稿按句切成几段（spoken-text.ts 的 speechSegments，第一段短），一段一次请求依次合成；
//   每合成好一段（最后一段除外）存进临时区（segment-files.ts，前端经 HTTP 取）、追加一个新版本带上已合成的段（时长、在整条里的
//   位置），前端第一段到了就出气泡、接着播。全部合成好拼成一条完整音频（同样的格式，段间留 SEGMENT_GAP_MS 的停顿）入库。
//   只有一段的不推段，合成好直接完成。语音对象记第一段出来用了多久（firstSegmentMs）和整条用了多久（elapsedMs）。
//   段的文件在这条语音有了结局之后再留 SEGMENT_KEEP_MS 才删（前端可能还在取最后一段），守护进程启动时全删。
// - 合成（speech.ts 的 SpeechSynthesizer）：请求体、超时、服务忙 / 没开的错误分类都在那边；实际的模型合成成功后问一次 GET /v1/models。
// - 合成完成时同一事务追加它的新版本和载着它的消息（tts_audio part，带上合成出的音频、时长 readWav、WAVEFORM_BARS 格波形、实际的模型）；
//   不论在哪一步失败（服务没开、忙、出错、超时、回的不是 WAV、存不进去、参考音色被删了）都记成失败，会话里追加一条说明。
//   服务忙（503）不等超时，说明里写"语音服务忙"。分段合成到一半失败的（已经推出去了几段）：推出去的几段拼成一条，
//   记成"只合成了一部分"（partial），同样追加载着它的消息，会话里一条说明。说明的话：语音回复的照旧（"这次只发文字"、
//   "回复的文字照常显示"），发语音工具发的只说这一条语音没发出去 / 只发出去了一部分和原因（用户 2026-10-11 定）。
// - 合成这边追加版本时在最新的一版上改（还在合成才写）：发语音工具回合结束时另记的 coversReply、replyMessageIds 不会被冲掉。
// - 守护进程在途中停了（被杀了）：还在合成的由调用方在启动时重新排队（start 之后），这里重做一遍（合成只是几次 HTTP 调用，
//   不算"中断不确定"）：推过的段先收回，从第一段重新合成。
// - 等结局（settled）：发语音工具要把结局（发出去了、只发了一部分、没发出去和原因）交回 agent，排队之后等它。
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_VOICE_SEGMENT_FADE_MS, type AgentVoiceRecord, type AgentVoiceSegment, EVENT_TYPES } from "@ergou/protocol";
import { buildMessage, newMessageId } from "../conversation/messages.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { MediaStore } from "../media/media-store.ts";
import type { Clock } from "../scheduler/clock.ts";
import { getAgentVoice } from "./agent-voice-views.ts";
import type { ReferenceVoices } from "./reference-voices.ts";
import { openSegmentFiles } from "./segment-files.ts";
import { createSerialQueue, nextVersion } from "./shared.ts";
import { type SpeechSynthesizer, SpeechServiceBusy } from "./speech.ts";
import { estimateSpeechSeconds, type SpokenPace, speechSegments } from "./spoken-text.ts";
import {
  NOT_WAV,
  referenceGoneReason,
  SEGMENT_FORMAT_MISMATCH,
  SPEECH_BUSY,
  storeFailedReason,
  synthesisFailedNote,
  synthesisPartialNote,
  toolVoiceFailedNote,
  toolVoicePartialNote,
} from "./texts.ts";
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

/** 会话里的说明：发语音工具发的只说这一条没发出去（86 号票），语音回复的照旧说这次只发文字 */
const failedNote = (voice: AgentVoiceRecord, reason: string) => (voice.mode === "tool" ? toolVoiceFailedNote(reason) : synthesisFailedNote(reason));
const partialNote = (voice: AgentVoiceRecord, reason: string) => (voice.mode === "tool" ? toolVoicePartialNote(reason) : synthesisPartialNote(reason));

/** 日志里的秒数 */
const seconds = (ms: number) => (ms / 1000).toFixed(1);

export interface VoiceSynthesisOptions {
  store: EventStore;
  media: MediaStore;
  references: ReferenceVoices;
  speech: SpeechSynthesizer;
  /** 念多快（估每段的时长算超时用；配置里的 voice.reply） */
  pace: Pick<SpokenPace, "charsPerSecond">;
  /** 段的文件什么时候删按它算（测试里换成手动拨的） */
  clock: Clock;
  /** 合成出的 WAV 先写在这里再入库，分段合成的段也放在这里（数据目录的临时区） */
  tmpDir: string;
  log: (line: string) => void;
}

/** 追加下一个版本时同一事务追加的事件（extra）、要去掉的字段（drop） */
export interface AdvanceOptions {
  extra?: (next: AgentVoiceRecord) => NewEvent[];
  drop?: ReadonlyArray<keyof AgentVoiceRecord>;
}

export interface VoiceSynthesis {
  /**
   * 追加 agent 语音的下一个版本（还是 from 这一版才写：没被删掉、没被别处改过）；写了返回新的一版。
   * 语音回复和发语音工具用它（读了最新的一版马上写）；正在合成的也能改不归合成管的字段（合成那边在最新的一版上接着写）
   */
  advance(from: AgentVoiceRecord, change: Partial<AgentVoiceRecord>, options?: AdvanceOptions): AgentVoiceRecord | undefined;
  /** 排队合成（状态是合成中、定了口语稿和参考音色的；已经在队里的不重复） */
  enqueue(voiceId: string): void;
  /**
   * 等这条语音合成有了结局（完成、只合成了一部分、失败；或者被别处改了、不再合成），交回那时的最新状态。
   * 本来就不在合成的马上交回；signal 中止了、守护进程在停时交回 undefined
   */
  settled(voiceId: string, signal?: AbortSignal): Promise<AgentVoiceRecord | undefined>;
  /** 启动：分段合成的段都是临时的，全删（还在合成的由调用方接着重新排队，从头再推） */
  start(): void;
  /** 分段合成里合成好的一段的文件（HTTP 接口发给前端）；没有是 undefined */
  segmentFile(voiceId: string, index: number): string | undefined;
  /** 合成队列空了（测试用） */
  whenIdle(): Promise<void>;
  stop(): Promise<void>;
}

export function createVoiceSynthesis(options: VoiceSynthesisOptions): VoiceSynthesis {
  const { store, media, references, speech, pace, clock, log } = options;
  let stopped = false;
  const aborter = new AbortController();
  /** 等结局的：语音 id → 一合成完（不论结局）就叫 */
  const waiters = new Map<string, Set<() => void>>();
  const release = (voiceId: string) => {
    const waiting = waiters.get(voiceId);
    waiters.delete(voiceId);
    for (const wake of waiting ?? []) wake();
  };
  const queue = createSerialQueue(
    async (id) => {
      try {
        await synthesize(id);
      } finally {
        release(id);
      }
    },
    { label: "合成语音", log },
  );
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

  /** 在 latest 上追加下一个版本（同一事务追加 extra） */
  const append = (latest: AgentVoiceRecord, change: Partial<AgentVoiceRecord>, { extra = () => [], drop = [] }: AdvanceOptions): AgentVoiceRecord => {
    const { record, event } = nextVersion(EVENT_TYPES.agentVoice, latest, change, drop);
    store.appendBatch([event, ...extra(record)]);
    return record;
  };

  const advance = (from: AgentVoiceRecord, change: Partial<AgentVoiceRecord>, opts: AdvanceOptions = {}): AgentVoiceRecord | undefined => {
    const latest = getAgentVoice(store.reader, from.id);
    if (!latest || latest.version !== from.version) return undefined;
    return append(latest, change, opts);
  };

  /**
   * 合成这边追加版本：在最新的一版上改，只要它还在合成（发语音工具回合结束时另记的 coversReply、replyMessageIds 不被冲掉）；
   * 被删掉了（所在的项目删了）、或者已经不在合成了，不写
   */
  const advanceOwn = (voice: AgentVoiceRecord, change: Partial<AgentVoiceRecord>, opts: AdvanceOptions = {}): AgentVoiceRecord | undefined => {
    const latest = getAgentVoice(store.reader, voice.id);
    if (!latest || latest.status !== "synthesizing") return undefined;
    return append(latest, change, opts);
  };

  /** 没合成出来：记成失败，会话里追加一条说明 */
  const fail = (voice: AgentVoiceRecord, reason: string) => {
    log(`agent 语音 ${voice.id} 没合成出来：${reason}`);
    advanceOwn(voice, { status: "failed", error: reason }, {
      extra: (next) => [buildMessage({ conversation: next.conversation, speaker: "system", parts: [{ type: "text", text: failedNote(next, reason) }] }, next.scope).event],
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
      voice = advanceOwn(voice, {}, { drop: ["segments", "segmentCount", "firstSegmentMs"] });
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
      const next = advanceOwn(voice, { segmentCount: plan.length, segments: segmentsOf(pieces), firstSegmentMs, model });
      // 语音对象被删掉了（比如所在的项目删了）：不再合成
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
    advanceOwn(voice, change, {
      extra: (next) => [
        buildMessage({ id: messageId, conversation: next.conversation, speaker: "agent", parts: [{ type: "tts_audio", voiceId: next.id, mediaId, mime, durationMs, waveform }] }, next.scope).event,
        ...(reason === undefined ? [] : [buildMessage({ conversation: next.conversation, speaker: "system", parts: [{ type: "text", text: partialNote(next, reason) }] }, next.scope).event]),
      ],
    });
    removeSegmentsLater(voice.id);
  };

  return {
    advance,
    enqueue: (voiceId) => queue.enqueue(voiceId),
    settled(voiceId, signal) {
      const current = getAgentVoice(store.reader, voiceId);
      if (!current || current.status !== "synthesizing") return Promise.resolve(current);
      if (stopped || signal?.aborted) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        const done = (voice: AgentVoiceRecord | undefined) => {
          signal?.removeEventListener("abort", onAbort);
          waiters.get(voiceId)?.delete(wake);
          resolve(voice);
        };
        const wake = () => done(stopped ? undefined : getAgentVoice(store.reader, voiceId));
        const onAbort = () => done(undefined);
        signal?.addEventListener("abort", onAbort, { once: true });
        const waiting = waiters.get(voiceId) ?? new Set();
        waiting.add(wake);
        waiters.set(voiceId, waiting);
      });
    },
    start() {
      segmentFiles.clear();
    },
    segmentFile: (voiceId, index) => segmentFiles.file(voiceId, index),
    whenIdle: () => queue.whenIdle(),
    async stop() {
      stopped = true;
      aborter.abort();
      for (const cancel of removals) cancel();
      removals.clear();
      await queue.stop();
      // 排着还没合成的、手头这条：等它们的不再等
      for (const voiceId of waiters.keys()) release(voiceId);
    },
  };
}
