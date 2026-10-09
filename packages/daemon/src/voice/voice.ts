// 语音消息（规格第 22 节，31 号票）：一条语音 = 一个语音对象。用户在浏览器里录好整段，经可续传上传入库后发一条带语音 part 的消息；
// 这里收下语音 part、建出语音对象（和消息同一事务），然后在后台识别：
// 1. faster-whisper 识别出文字（识别进程见 recognizer.ts；用户 2026-10-08 改：第一阶段不再用大模型修正）；
// 2. 识别状态的每次变化是会话频道上的一条 voice 事件（排队 → 识别中 → 完成 / 失败），前端经频道收到，
//    识别出的文字默认直接显示在气泡下方（就算用户对识别结果的确认）；
// 3. 识别完成前，这条消息在 agent 的输入队列里等着（conversation/agent-session.ts）；完成后交给 agent 的是识别出的文字，
//    失败的是"[语音，识别失败]"。用户可以在气泡菜单里重新识别失败的语音（retry_voice）：那条输入已经交给过 agent 的，
//    重新识别成功后另追加一条交给 agent 的通知（带识别出的文字）；还没交过去的照常排队等着。
// 识别一次一条，按排队的先后；守护进程重启时排队、识别中的接着识别。识别进程不可用（没装、加载失败）时这条语音记成失败，
// 待我处理里放一条说明（开着的只有一条），之后识别成功就把它收进归档。
import { randomUUID } from "node:crypto";
import {
  EVENT_TYPES,
  isVoiceSettled,
  type MessageEnvelope,
  type MessageEventPayload,
  nowIso,
  type RetryVoiceParams,
  type RetryVoiceResult,
  settledVoiceText,
  VOICE_CAPTURE_TEXT_MAX,
  VOICE_MIC_LOG_MAX,
  VOICE_MIN_MS,
  VOICE_TRANSCRIPT_LABEL,
  type VoiceCapture,
  type VoiceEventPayload,
  type VoiceMicLogEntry,
  type VoiceRecognition,
  type VoiceRecord,
} from "@ergou/protocol";
import { buildAgentNotice, type VoiceIntake } from "../conversation/messages.ts";
import { getMessage, pendingInputs } from "../conversation/views.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { MediaStore } from "../media/media-store.ts";
import { type Recognizer, RecognizerUnavailable } from "./recognizer.ts";
import { createSerialQueue, nextVersion as nextVersionOf, standingNotice } from "./shared.ts";
import { getVoice, unsettledVoices, voicesIn } from "./views.ts";

export interface VoiceServiceOptions {
  store: EventStore;
  media: MediaStore;
  inbox: InboxService;
  recognizer: Recognizer;
  /** 交给识别进程的语言和提示 */
  recognition: { language?: string; initialPrompt?: string };
  /** 识别进程不可用时，待我处理里的说明后面接的"怎么修" */
  unavailableHint: string;
  log: (line: string) => void;
}

export interface VoiceService {
  /** 发消息时收下语音 part（网关的 send_message 经 postUserMessage 交过来） */
  readonly intake: VoiceIntake;
  /** 开始识别：上次没识别完的（排队、识别中）接着识别，之后来一条识别一条 */
  start(): void;
  /** 气泡菜单里的"重新识别"：只有识别失败的能重新识别（同一个幂等键重发拿到同一个结果） */
  retry(params: RetryVoiceParams, idempotencyKey: string): RetryVoiceResult;
  /** 识别队列空了（测试用） */
  whenIdle(): Promise<void>;
  stop(): Promise<void>;
}

/** 不是负数的有限数，取整（毫秒数） */
const msOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
/** 字符串，超长的截断 */
const textOf = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);
/** 只留有值的字段 */
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** 麦克风诊断记录的一条：时刻（相对按下，可以是负数）和事件名要有，原因、毫秒数、页面信号不对就丢掉这一项 */
function micLogEntryOf(entry: unknown): VoiceMicLogEntry | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const { atMs, event, reason, ms, hasFocus, visibility } = entry as Record<string, unknown>;
  const name = textOf(event, VOICE_CAPTURE_TEXT_MAX.reason);
  if (typeof atMs !== "number" || !Number.isFinite(atMs) || !name) return undefined;
  return defined({
    atMs: Math.round(atMs),
    event: name,
    reason: textOf(reason, VOICE_CAPTURE_TEXT_MAX.logReason),
    ms: msOf(ms),
    hasFocus: typeof hasFocus === "boolean" ? hasFocus : undefined,
    visibility: textOf(visibility, VOICE_CAPTURE_TEXT_MAX.visibility),
  });
}

/**
 * 前端随语音带来的录音诊断（37 号票；61 号票加了开麦原因、冷启动耗时、最大振幅、麦克风诊断记录和浏览器）整理成存进语音对象的样子：
 * 只取认得的、类型对的字段，毫秒数取整，负数、非有限数丢掉，字符串超长的截断（VOICE_CAPTURE_TEXT_MAX），
 * 记录里坏掉的条目丢掉、只留最后 VOICE_MIC_LOG_MAX 条；
 * 什么都没剩（或者前端没带）就没有。只用来看实际数字，带得不对也不拒收这条语音
 */
function captureOf(report: unknown): VoiceCapture | undefined {
  if (typeof report !== "object" || report === null) return undefined;
  const { startDelayMs, prewarmed, openReason, gumMs, peak, micLog, browser } = report as Record<string, unknown>;
  const log = Array.isArray(micLog) ? micLog.flatMap((e) => micLogEntryOf(e) ?? []).slice(-VOICE_MIC_LOG_MAX) : [];
  const capture: VoiceCapture = defined({
    startDelayMs: msOf(startDelayMs),
    prewarmed: typeof prewarmed === "boolean" ? prewarmed : undefined,
    openReason: textOf(openReason, VOICE_CAPTURE_TEXT_MAX.reason) || undefined,
    gumMs: msOf(gumMs),
    peak: typeof peak === "number" && peak >= 0 && peak <= 1 ? peak : undefined,
    micLog: log.length > 0 ? log : undefined,
    browser: textOf(browser, VOICE_CAPTURE_TEXT_MAX.browser) || undefined,
  });
  return Object.keys(capture).length > 0 ? capture : undefined;
}

/** 建出语音对象的事件的幂等键：由发送请求的幂等键推出，消息重发时一起去重 */
const createdKey = (idempotencyKey: string) => `voice-created:${idempotencyKey}`;
/** 重新识别请求的幂等键 */
const retryKey = (idempotencyKey: string) => `voice-retry:${idempotencyKey}`;
/** 重新识别成功后交给 agent 的通知（每条语音最多一条：识别完成之后不能再重新识别） */
export const voiceRetryNoticeKey = (voiceId: string) => `voice-retry-notice:${voiceId}`;

/** 语音对象的下一个版本（时间、版本号跟着变，drop 里的字段去掉）和它的事件 */
function nextVersion(voice: VoiceRecord, change: Partial<VoiceRecord>, drop: ReadonlyArray<keyof VoiceRecord> = []) {
  const { record, event } = nextVersionOf(EVENT_TYPES.voice, voice, change, drop);
  return { voice: record, event };
}

/**
 * 这条消息是不是用户重新识别了语音之后、运行时交给 agent 的那条通知（带着识别出的文字）：
 * 它其实就是用户的语音（32 号票的语音回复据此把这一轮也当成用户发了语音）
 */
export function isVoiceRetryNotice(store: EventStore, message: MessageEnvelope): boolean {
  if (message.speaker !== "system") return false;
  return voicesIn(store.reader, message.conversation).some((voice) => {
    if (voice.attempt < 2) return false;
    const notice = store.eventByIdempotencyKey(voiceRetryNoticeKey(voice.id));
    return (notice?.payload as Partial<MessageEventPayload> | undefined)?.message?.id === message.id;
  });
}

export function createVoiceService(options: VoiceServiceOptions): VoiceService {
  const { store, media, inbox, recognizer, log } = options;
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  const queue = createSerialQueue((id) => recognize(id), { label: "识别语音", log });
  const unavailable = standingNotice({ store, inbox, notice: "voice_recognizer_unavailable" });

  const intake: VoiceIntake = {
    accept(part, message) {
      const info = media.info(part.mediaId);
      if (!info) throw new RequestRejected("bad_params", `录音不存在：媒体 ${part.mediaId} 没有入库（先上传、收尾，再发消息）`);
      if (!info.audio) throw new RequestRejected("bad_params", "这段录音不是认得的音频格式（webm、ogg、mp4、wav……），不能作为语音发出");
      if (part.durationMs < VOICE_MIN_MS) throw new RequestRejected("bad_params", "说话时间太短");
      const capture = captureOf(part.capture);
      const voice: VoiceRecord = {
        id: `v-${randomUUID()}`,
        messageId: message.id,
        conversation: message.conversation,
        ...(message.scope.taskId === undefined ? {} : { taskId: message.scope.taskId }),
        ...(message.scope.projectId === undefined ? {} : { projectId: message.scope.projectId }),
        mediaId: part.mediaId,
        mime: info.audio.mime,
        durationMs: part.durationMs,
        waveform: [...part.waveform],
        status: "queued",
        attempt: 1,
        ...(capture ? { capture } : {}),
        createdAt: message.time,
        updatedAt: message.time,
        version: 1,
      };
      const payload: VoiceEventPayload = { voice };
      return {
        part: { type: "voice", voiceId: voice.id, mediaId: voice.mediaId, mime: voice.mime, durationMs: voice.durationMs, waveform: voice.waveform },
        events: [{ channel: message.conversation, type: EVENT_TYPES.voice, payload, idempotencyKey: createdKey(message.idempotencyKey) }],
      };
    },
  };

  const enqueue = (voiceId: string) => queue.enqueue(voiceId);

  /** 这条语音的消息还在（没被彻底删除、项目没被删；会话消息的视图里没有"已删除"的）：不在了就不再写它的文字 */
  const messageExists = (voice: VoiceRecord) => getMessage(store.reader, voice.messageId) !== undefined;

  /** 一条语音识别有了结局：追加它（连同重新识别成功后交给 agent 的通知）；消息已经不在了就什么都不写 */
  const settle = (voice: VoiceRecord, change: Partial<VoiceRecord>, drop: ReadonlyArray<keyof VoiceRecord> = []) => {
    const latest = getVoice(store.reader, voice.id);
    if (!latest || latest.version !== voice.version) return;
    if (!messageExists(latest)) {
      log(`语音 ${voice.id} 的消息已经不在了（被彻底删除了，或者会话被删了），识别结果不再写进去`);
      return;
    }
    const next = nextVersion(latest, change, drop);
    const events = [next.event];
    // 重新识别成功，而那条输入已经交给过 agent（当时是"识别失败"）：另外交给 agent 一条通知，带上识别出的文字
    const text = settledVoiceText(next.voice);
    const delivered = !pendingInputs(store.reader, latest.conversation).some((q) => q.messageId === latest.messageId);
    if (text !== undefined && latest.attempt > 1 && delivered) {
      const notice = `用户重新识别了之前没识别出来的那条语音，转写如下：\n${VOICE_TRANSCRIPT_LABEL}：${text}`;
      events.push(
        buildAgentNotice(latest.conversation, notice, voiceRetryNoticeKey(latest.id), {
          ...(latest.taskId === undefined ? {} : { taskId: latest.taskId }),
          ...(latest.projectId === undefined ? {} : { projectId: latest.projectId }),
        }).event,
      );
    }
    store.appendBatch(events);
  };

  const recognize = async (voiceId: string) => {
    const queued = getVoice(store.reader, voiceId);
    if (!queued || isVoiceSettled(queued.status)) return;
    const started = performance.now();
    const marked = nextVersion(queued, { status: "recognizing" }, ["recognition", "error"]);
    store.append(marked.event);
    const voice = marked.voice;
    const fail = (reason: string) => {
      log(`语音 ${voice.id} 识别失败：${reason}`);
      settle(voice, { status: "failed", error: reason });
    };
    if (!media.info(voice.mediaId)) return fail("录音不在媒体库里了");

    let result;
    try {
      result = await recognizer.transcribe(
        {
          path: media.filePath(voice.mediaId),
          ...(options.recognition.language ? { language: options.recognition.language } : {}),
          ...(options.recognition.initialPrompt ? { initialPrompt: options.recognition.initialPrompt } : {}),
        },
        voice.durationMs,
      );
    } catch (err) {
      // 守护进程在停：这条留在"识别中"，下次启动接着识别
      if (stopped) return;
      const reason = err instanceof Error ? err.message : String(err);
      if (!(err instanceof RecognizerUnavailable)) return fail(reason);
      announceUnavailable(reason);
      return fail(`语音识别不可用：${reason}`);
    }
    if (stopped) return;
    retireUnavailableNotice();
    if (!result.text.trim()) return fail("没有识别出说话的内容");
    const recognition: VoiceRecognition = {
      text: result.text.trim(),
      language: result.language,
      segments: result.segments,
      model: result.model,
      device: result.device,
      computeType: result.computeType,
      ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
      ...(typeof result.duration === "number" ? { audioSeconds: result.duration } : {}),
      elapsedMs: Math.round(performance.now() - started),
      time: nowIso(),
    };
    settle(voice, { status: "done", recognition }, ["error"]);
  };

  /** 识别进程不可用：待我处理里放一条说明（开着的只有一条） */
  const announceUnavailable = (reason: string) => {
    log(`语音识别进程不可用：${reason}`);
    unavailable.raise({
      title: "语音识别不可用",
      body: `语音照常收下，但识别不出文字（识别状态记成失败）：${reason}。${options.unavailableHint}修好后在语音气泡的菜单里点"重新识别"。`,
      source: "系统",
      urgency: "non_blocking",
      actions: ["知道了"],
    });
  };

  /** 识别又能用了：那条说明还开着就收进归档 */
  const retireUnavailableNotice = () => unavailable.retire();

  return {
    intake,
    start() {
      unsubscribe = store.onAppend((event) => {
        if (event.type !== EVENT_TYPES.voice) return;
        const { voice } = event.payload as Partial<VoiceEventPayload>;
        if (voice?.status === "queued") enqueue(voice.id);
      });
      // 上次没识别完的（守护进程停的时候在排队、在识别）接着识别
      for (const voice of unsettledVoices(store.reader)) enqueue(voice.id);
    },
    retry({ voiceId }, idempotencyKey) {
      const earlier = store.eventByIdempotencyKey(retryKey(idempotencyKey));
      if (earlier) {
        const { voice } = earlier.payload as VoiceEventPayload;
        if (voice?.id !== voiceId) throw new RequestRejected("bad_params", "这个幂等键已经用在别的请求上了");
        return { voiceId, version: voice.version };
      }
      const voice = getVoice(store.reader, voiceId);
      if (!voice) throw new RequestRejected("not_found", `没有这条语音：${voiceId}`);
      if (voice.status !== "failed") throw new RequestRejected("not_allowed", "只有识别失败的语音能重新识别");
      const next = nextVersion(voice, { status: "queued", attempt: voice.attempt + 1 }, ["recognition", "error"]);
      store.append({ ...next.event, idempotencyKey: retryKey(idempotencyKey) });
      return { voiceId, version: next.voice.version };
    },
    whenIdle: () => queue.whenIdle(),
    async stop() {
      stopped = true;
      unsubscribe?.();
      const draining = queue.stop();
      await recognizer.close();
      await draining;
    },
  };
}
