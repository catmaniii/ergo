// 语音消息（规格第 22 节，31 号票）：一条语音 = 一个语音对象。用户在浏览器里录好整段，经可续传上传入库后发一条带语音 part 的消息；
// 这里收下语音 part、建出语音对象（和消息同一事务），然后在后台识别：
// 1. faster-whisper 识别出文字（识别进程见 recognizer.ts；用户 2026-10-08 改：第一阶段不再用大模型修正）；
// 2. 识别状态的每次变化是会话频道上的一条 voice 事件（排队 → 识别中 → 完成 / 失败），前端经频道收到，
//    识别出的文字默认直接显示在气泡下方（就算用户对识别结果的确认）；
// 3. 识别完成前，这条消息在 agent 的输入队列里等着（conversation/agent-session.ts）；完成后交给 agent 的是识别出的文字。
// 4. 识别没做成（识别进程出错、超时、退出、不可用；208 号票，用户 2026-10-20：别再把空白交给二狗）时先不判失败：回到排队、
//    记下第几次自动重试（autoRetry）和到点的时刻（retryAt），隔一会儿再试（voice.recognizer.autoRetrySeconds，默认 15 秒、60 秒、
//    3 分钟，最多 3 次），每次重试前先看识别服务正不正常（Recognizer.check：不在就拉起、卡住了就重启）。等着重试时这条消息照旧在
//    agent 的输入队列里等着，气泡上是"识别中（第 N 次重试）"。识别成功但没有文字的（静音、太短、只有串词）
//    重试也没用，不自动重试。只有第一次识别会自动重试，手动重新识别的一次就是一次。
//    210 号票（用户 2026-10-20："语音重试期间，我发的文字可以先发给二狗"）：只有第一次识别挡着后面的输入；进了自动重试的从那一刻起
//    不挡了，排在它后面的照先后先交给 agent（gate.ts 的 voiceGateOf，conversation/agent-session.ts 跳过它）。重试有了结局还等着的
//    （成功的；重试完了还不行、带着附件或卡片的）作为一条新输入排到那时输入队列的末尾（conversation/views.ts 的 agent_inputs），
//    交过去时后面带一句"这条语音是 14:05 说的，识别晚了"（conversation/agent-input.ts）。这里不用多写什么：autoRetry 留在有了结局的那一版里。
// 5. 识别失败（重试完了还不行，或者重试也没用）的语音当作没说过：消息里只有这段语音的不交给 agent——还在输入队列里等着的随这条
//    voice 事件出队（dropInput，记成没交），不唤起、不回话；回复中发的、还排在会话的队列里的，交出去时不进输入队列（message-queue.ts）。
//    带附件、引用卡片的照旧交，语音那段是"[语音，识别失败]"。（180 号票起只识别出模型自带串词的这样，208 号票起识别失败的都这样；
//    只有串词的另标 onlyFiller、写明理由。）
// 6. 用户可以在气泡菜单里重新识别失败的语音（retry_voice），试之前同样先看识别服务：成功了，没交过的（识别失败时出了队）回到输入
//    队列，作为一条正常的用户输入交给 agent（restoreInput）；那条输入已经交给过 agent 的（带附件、卡片的，当时是"识别失败"），
//    另追加一条交给 agent 的通知（带识别出的文字）；还没交过去的照常排队等着。
// 识别一次一条，按排队的先后（等着重试的不占着，到点再排）；守护进程重启时排队、识别中的接着识别，等着重试的到点接着试、次数接着算。
// 214 号票起这是语音插件的（plugin.ts）：插件运行中停用时和守护进程停一样（排队、识别中的留着），启用回来（新的一次装配）接着识别；
// 停用期间带附件、卡片的消息已经照交（语音那段是"识别失败"），接着识别成功了另交一条带文字的通知（见 settle）。
// 识别进程不可用（没装、加载失败）、重试完了还是这样时，待我处理里放一条说明（开着的只有一条），之后识别成功就把它收进归档；
// 单条语音识别失败不进待我处理。
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
  t,
} from "@ergo/protocol";
import { buildAgentNotice, type VoiceIntake } from "../conversation/messages.ts";
import { isQueued } from "../conversation/message-queue.ts";
import { getMessage, inputOf } from "../conversation/views.ts";
import { RequestRejected } from "../errors.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { MediaStore } from "../media/media-store.ts";
import { type Recognizer, RecognizerUnavailable } from "./recognizer.ts";
import { createSerialQueue, nextVersion as nextVersionOf, standingNotice } from "./shared.ts";
import { getVoice, onlyVoiceParts, unsettledVoices, voiceRetryNoticeKey, voicesIn } from "../voice-records/index.ts";

export interface VoiceServiceOptions {
  store: EventStore;
  media: MediaStore;
  inbox: InboxService;
  recognizer: Recognizer;
  /** 交给识别进程的语言和提示 */
  recognition: { language?: string; initialPrompt?: string };
  /** 识别进程不可用时，待我处理里的说明后面接的"怎么修"（按当前语言现取） */
  unavailableHint: () => string;
  /** 识别没做成时第几次自动重试前等多久（毫秒，208 号票；配置 voice.recognizer.autoRetrySeconds）：几项就最多重试几次，空的不自动重试 */
  autoRetryMs: readonly number[];
  log: (line: string) => void;
}

export interface VoiceService {
  /** 发消息时收下语音 part（网关的 send_message 经 postUserMessage 交过来） */
  readonly intake: VoiceIntake;
  /** 开始识别：上次没识别完的（排队、识别中）接着识别、等着自动重试的到点接着试，之后来一条识别一条 */
  start(): void;
  /** 气泡菜单里的"重新识别"：只有识别失败的能重新识别，试一次（同一个幂等键重发拿到同一个结果） */
  retry(params: RetryVoiceParams, idempotencyKey: string): RetryVoiceResult;
  /** 识别队列空了（测试用） */
  whenIdle(): Promise<void>;
  stop(): Promise<void>;
}

/** 日志里的秒数：整秒的不带小数 */
const secondsOf = (ms: number) => (ms % 1000 === 0 ? String(ms / 1000) : (ms / 1000).toFixed(2));
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 等着自动重试的语音离到点还有多久（毫秒；不在等的是 0，208 号票） */
const dueIn = (voice: VoiceRecord) => (voice.retryAt === undefined ? 0 : Date.parse(voice.retryAt) - Date.now());

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
 * 前端随语音带来的录音诊断（37 号票；61 号票加了开麦原因、冷启动耗时、最大振幅、麦克风诊断记录和浏览器；
 * 63 号票加了录音走哪儿、原生录音器备好用了多久、原生开录到第一块数据）整理成存进语音对象的样子：
 * 只取认得的、类型对的字段，毫秒数取整，负数、非有限数丢掉，字符串超长的截断（VOICE_CAPTURE_TEXT_MAX），
 * 记录里坏掉的条目丢掉、只留最后 VOICE_MIC_LOG_MAX 条；
 * 什么都没剩（或者前端没带）就没有。只用来看实际数字，带得不对也不拒收这条语音
 */
function captureOf(report: unknown): VoiceCapture | undefined {
  if (typeof report !== "object" || report === null) return undefined;
  const { backend, startDelayMs, prewarmed, prepareMs, firstDataMs, openReason, gumMs, peak, micLog, browser } = report as Record<string, unknown>;
  const log = Array.isArray(micLog) ? micLog.flatMap((e) => micLogEntryOf(e) ?? []).slice(-VOICE_MIC_LOG_MAX) : [];
  const capture: VoiceCapture = defined({
    backend: textOf(backend, VOICE_CAPTURE_TEXT_MAX.reason) || undefined,
    startDelayMs: msOf(startDelayMs),
    prewarmed: typeof prewarmed === "boolean" ? prewarmed : undefined,
    prepareMs: msOf(prepareMs),
    firstDataMs: msOf(firstDataMs),
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
  const queue = createSerialQueue((id) => recognize(id), { label: "识别语音", log }); // @i18n-ignore log
  const unavailable = standingNotice({ store, inbox, notice: "voice_recognizer_unavailable" });
  /** 等着自动重试的语音：到点排进识别队列的计时器（208 号票） */
  const retryTimers = new Map<string, NodeJS.Timeout>();

  const intake: VoiceIntake = {
    accept(part, message) {
      const info = media.info(part.mediaId);
      if (!info) throw new RequestRejected("bad_params", t("voice.intake.missing", { mediaId: part.mediaId }));
      if (!info.audio) throw new RequestRejected("bad_params", t("voice.intake.notAudio"));
      if (part.durationMs < VOICE_MIN_MS) throw new RequestRejected("bad_params", t("voice.intake.tooShort"));
      const capture = captureOf(part.capture);
      const voice: VoiceRecord = {
        id: `v-${randomUUID()}`,
        messageId: message.id,
        conversation: message.conversation,
        ...(message.scope.taskId === undefined ? {} : { taskId: message.scope.taskId }),
        ...(message.scope.projectId === undefined ? {} : { projectId: message.scope.projectId }),
        // 284 号票：了解你访谈开着时在记忆管理员的会话里说的（语音转写的素材据此标上"来自访谈"）
        ...(message.scope.interviewId === undefined ? {} : { interviewId: message.scope.interviewId }),
        ...(message.scope.interviewQuestion === undefined ? {} : { interviewQuestion: message.scope.interviewQuestion }),
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

  /** 没有结局的语音排进识别队列：等着自动重试、还没到点的到点再排（208 号票） */
  const arrange = (voice: VoiceRecord) => {
    if (stopped || isVoiceSettled(voice.status)) return;
    clearTimeout(retryTimers.get(voice.id));
    retryTimers.delete(voice.id);
    const wait = voice.status === "queued" ? dueIn(voice) : 0;
    if (wait <= 0) return enqueue(voice.id);
    const timer = setTimeout(() => {
      retryTimers.delete(voice.id);
      enqueue(voice.id);
    }, wait);
    timer.unref();
    retryTimers.set(voice.id, timer);
  };

  /**
   * 这条语音的消息还在（没被彻底删除、项目没被删；会话消息的视图里没有"已删除"的），或者还排在队里（144 号票：回复中发的语音
   * 排队时就识别，交出去时才成为消息）：都不在了就不再写它的文字
   */
  const messageExists = (voice: VoiceRecord) => getMessage(store.reader, voice.messageId) !== undefined || isQueued(store.reader, voice.conversation, voice.messageId);

  /** 这条语音的新版本还能写进去：还是 voice 这一版、消息还在（被彻底删除了、会话被删了就不再写）。能写的回最新的这一版 */
  const writable = (voice: VoiceRecord): VoiceRecord | undefined => {
    const latest = getVoice(store.reader, voice.id);
    if (!latest || latest.version !== voice.version) return undefined;
    if (!messageExists(latest)) {
      log(`语音 ${voice.id} 的消息已经不在了（被彻底删除了，或者会话被删了），识别结果不再写进去`);
      return undefined;
    }
    return latest;
  };

  /**
   * 一条语音识别有了结局：追加它（连同重新识别成功后交给 agent 的通知）；消息已经不在了就什么都不写。
   * 识别失败、消息里只有这段语音的不交给 agent（dropInput）；手动重新识别成功、之前没交过的回到输入队列（restoreInput）
   */
  const settle = (voice: VoiceRecord, change: Partial<VoiceRecord>, drop: ReadonlyArray<keyof VoiceRecord> = []) => {
    const latest = writable(voice);
    if (!latest) return;
    const next = nextVersion(latest, change, drop);
    const message = getMessage(store.reader, latest.messageId);
    const input = message && inputOf(store.reader, latest.messageId);
    // 识别失败（自动重试完了还不行、静音之类重试也没用、只识别出串词）、消息已经进了会话而且里面只有这段语音：这条输入不交给 agent，
    // 等同于没发（还排在会话队列里的，交出去时再看，message-queue.ts）。180 号票起只管串词，208 号票起识别失败的都是
    const dropInput = next.voice.status === "failed" && message !== undefined && onlyVoiceParts(message);
    // 重新识别成功，这条输入之前没交给 agent（识别失败时出了队）：回到输入队列，作为一条正常的用户输入交过去（208 号票）
    const text = settledVoiceText(next.voice);
    const restoreInput = text !== undefined && input?.status === "dropped";
    const payload: VoiceEventPayload = { ...(next.event.payload as VoiceEventPayload), ...(dropInput ? { dropInput: true } : {}), ...(restoreInput ? { restoreInput: true } : {}) };
    const events: NewEvent[] = [{ ...next.event, payload }];
    // 重新识别成功，而那条输入已经交给过 agent（带附件、引用卡片的，当时是"识别失败"）：另外交给 agent 一条通知，带上识别出的文字
    const delivered = input?.status === "started" || input?.status === "done";
    // 214 号票：第一次识别还没完、那条输入就交给了 agent 的，只有语音插件停用期间（带附件、卡片的照交，语音那段是"识别失败"）；
    // 启用回来接着识别成功了，同样另交一条通知（每条语音最多一条）
    if (text !== undefined && delivered) {
      const notice =
        latest.attempt > 1
          ? `用户重新识别了之前没识别出来的那条语音，转写如下：\n${VOICE_TRANSCRIPT_LABEL}：${text}` // @i18n-ignore model：交给 agent 的通知
          : `用户之前发的那条语音（语音功能停用时交给你的，语音那段当时是"识别失败"）现在识别出来了，转写如下：\n${VOICE_TRANSCRIPT_LABEL}：${text}`; // @i18n-ignore model
      events.push(
        buildAgentNotice(latest.conversation, notice, voiceRetryNoticeKey(latest.id), {
          ...(latest.taskId === undefined ? {} : { taskId: latest.taskId }),
          ...(latest.projectId === undefined ? {} : { projectId: latest.projectId }),
        }).event,
      );
    }
    store.appendBatch(events);
  };

  /** 识别没做成：回到排队，记下第几次自动重试、到点的时刻（208 号票）；到点由 arrange 排进识别队列 */
  const retryLater = (voice: VoiceRecord, n: number, delayMs: number, reason: string) => {
    const latest = writable(voice);
    if (!latest) return;
    log(`语音 ${voice.id} 识别没做成（${reason}），${secondsOf(delayMs)} 秒后第 ${n} 次重试`);
    store.append(nextVersion(latest, { status: "queued", autoRetry: n, retryAt: nowIso(new Date(Date.now() + delayMs)) }, ["error"]).event);
  };

  const recognize = async (voiceId: string) => {
    const queued = getVoice(store.reader, voiceId);
    if (!queued || isVoiceSettled(queued.status)) return;
    // 排队时被叉掉了的语音（144 号票）：不会成为消息了，不用识别
    if (!messageExists(queued)) return;
    // 等着自动重试、还没到点（重复排进来的）：到点再来
    if (queued.status === "queued" && dueIn(queued) > 0) return arrange(queued);
    const started = performance.now();
    const marked = nextVersion(queued, { status: "recognizing" }, ["recognition", "error", "onlyFiller", "retryAt"]);
    store.append(marked.event);
    const voice = marked.voice;
    /** 有了结局：失败（不再自动重试） */
    const fail = (reason: string, change: Partial<VoiceRecord> = {}) => {
      log(`语音 ${voice.id} 识别失败${voice.autoRetry ? `（自动重试了 ${voice.autoRetry} 次）` : ""}：${reason}`);
      settle(voice, { status: "failed", error: reason, ...change });
    };
    /**
     * 识别没做成（识别进程出错、超时、退出、不可用）：第一次识别的还能自动重试就隔一会儿再试（208 号票）；
     * 不能的记成失败，是识别服务不可用的在待我处理里说明（单条语音识别出错不进待我处理）
     */
    const notDone = (err: unknown) => {
      const reason = messageOf(err);
      const delay = voice.attempt === 1 ? options.autoRetryMs[voice.autoRetry ?? 0] : undefined;
      if (delay !== undefined) return retryLater(voice, (voice.autoRetry ?? 0) + 1, delay, reason);
      if (!(err instanceof RecognizerUnavailable)) return fail(reason);
      announceUnavailable(reason);
      fail(t("voice.recognize.unavailable", { reason }));
    };
    if (!media.info(voice.mediaId)) return fail(t("voice.recognize.mediaGone"));
    // 重试（自动的、手动重新识别的）之前先看识别服务正不正常：不在就拉起，卡住了就重启（208 号票）
    if (voice.autoRetry !== undefined || voice.attempt > 1) {
      try {
        await recognizer.check();
      } catch (err) {
        if (stopped) return;
        return notDone(err);
      }
      if (stopped) return;
    }

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
      return notDone(err);
    }
    if (stopped) return;
    retireUnavailableNotice();
    // 识别成功但没有文字：重试也没用，不自动重试，记成失败（208 号票：只有这段语音的消息不交给 agent，见 settle）。
    // 180 号票：识别出来的只有模型自带的串词（识别进程的宿主已经剔掉、剩下空的）的另写明理由、标上 onlyFiller
    if (!result.text.trim()) return result.strippedChars ? fail(t("voice.recognize.onlyFiller"), { onlyFiller: true }) : fail(t("voice.recognize.empty"));
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
      title: t("voice.unavailableNotice.title"),
      body: t("voice.unavailableNotice.body", { reason, hint: options.unavailableHint() }),
      source: t("voice.unavailableNotice.source"),
      urgency: "non_blocking",
      // 动作既是按钮上的字也是处理时认的值，不翻（按钮上的译法归网页）
      actions: ["知道了"], // @i18n-ignore fixed
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
        if (voice?.status === "queued") arrange(voice);
      });
      // 上次没识别完的（守护进程停的时候在排队、在识别）接着识别；等着自动重试的到点接着试
      for (const voice of unsettledVoices(store.reader)) arrange(voice);
    },
    retry({ voiceId }, idempotencyKey) {
      const earlier = store.eventByIdempotencyKey(retryKey(idempotencyKey));
      if (earlier) {
        const { voice } = earlier.payload as VoiceEventPayload;
        if (voice?.id !== voiceId) throw new RequestRejected("bad_params", t("voice.retry.keyReused"));
        return { voiceId, version: voice.version };
      }
      const voice = getVoice(store.reader, voiceId);
      if (!voice) throw new RequestRejected("not_found", t("voice.retry.notFound", { id: voiceId }));
      if (voice.status !== "failed") throw new RequestRejected("not_allowed", t("voice.retry.notFailed"));
      // 手动重新识别试一次，不自动重试（208 号票）：去掉自动重试的次数
      const next = nextVersion(voice, { status: "queued", attempt: voice.attempt + 1 }, ["recognition", "error", "onlyFiller", "autoRetry", "retryAt"]);
      store.append({ ...next.event, idempotencyKey: retryKey(idempotencyKey) });
      return { voiceId, version: next.voice.version };
    },
    whenIdle: () => queue.whenIdle(),
    async stop() {
      stopped = true;
      unsubscribe?.();
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      const draining = queue.stop();
      await recognizer.close();
      await draining;
    },
  };
}
