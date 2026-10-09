// 语音模型预热（规格第 22 节"模型预热"，45 号票）：守护进程启动后在后台提前把识别模型和合成模型加载好，重启后的第一条语音
// 不用等加载（用户实测：large-v3 冷启动的那一条识别用了 36 秒，之后的都不到 1 秒）。
// - 两个预热依次做，先识别、后合成，不同时往显卡里加载（一次做一件的队列）；都在后台，不挡启动；失败只记日志、在状态里显示，
//   不影响别的功能（真的识别、合成照常按需做）。
// - 识别：让识别进程拉起并加载模型（recognizer.ts 的 load）。识别进程默认常驻。要不要重拉看识别进程宿主报的（onLifecycle），
//   不从状态的跳变倒推：
//   - 加载好、稳定下来（加载好之后 stableMs 没崩）之后意外没了（崩溃、被杀、卡住被结束）：马上在后台重新拉起并加载，不等下一条语音；
//   - 没加载起来，或者加载好了还没稳定就又没了（"加载好就崩"）：都算连续失败，按退避再试（retryMs，越隔越久），每次一行日志；
//     稳定下来之后才把连续失败清零；
//   - 闲置退出（配了 voice.recognizer.idleMinutes 正数的）：不重拉，下一条语音来了再拉起。
// - 合成：audio.cpp 没有"模型加载了没有"的接口（/health 只报就绪和配置了几个模型），所以先看 /health，开着就用实际会用的
//   模型和参考音色发一条极短的试合成（WARMUP_TEXT）：模型没加载时它顺势加载，已经加载时很快回来。结果丢掉，不进任何会话、
//   不留文件；按耗时判断之前是不是已经加载好，记进日志。没开时记"没开"；还没有参考音色时等导入了再做；服务回"忙"（503，
//   显卡在给别的任务用）时记"忙"，按探活的间隔再试（只在开始忙时记一行日志）。
//   之后每隔 probeMs 看一次 /health，只在"连不上 ↔ 连得上"变了的时候动作：变成连得上（比如被 LSM 重新拉起）再预热一次。
// - 预热和真请求撞上：真请求排在同一个模型的预热后面（预热做的正是它要等的加载），不排在另一个模型的预热后面。
//   识别：识别进程一次处理一条，"加载"那一行在前，真的识别排在它后面；合成：试合成在做时，语音回复的合成等它做完再发
//   （同时发过去也只是在 audio.cpp 的模型锁上排队，而且等过它的 busy_timeout_ms 会被回"忙"、退回只发文字）。
//   等试合成的这段时间不算进那次合成自己的超时：最坏多等一次试合成的超时（默认约 107 秒）。
// - 状态（VoiceModelsView）：识别引擎的清单（现在只有 faster-whisper）、两个模型各自的状态；变了就交给 onChange（守护进程推一条
//   临时事件 voice_models），本机接口 GET /api/voice-models 取得到同样的。给人看的说明在 texts.ts。
import { nowIso, type VoiceModelState, type VoiceModelsView } from "@ergou/protocol";
import type { Recognizer } from "./recognizer.ts";
import type { ReferenceVoices } from "./reference-voices.ts";
import { createSerialQueue } from "./shared.ts";
import { type SpeechSynthesizer, SpeechServiceBusy, SpeechServiceOff } from "./speech.ts";
import { SPEECH_WARMUP_TEXT } from "./texts.ts";

/** 识别引擎：现在只有这一个（以后加引擎时再加切换和存储） */
export const RECOGNIZER_ENGINE = "faster-whisper";

/** 试合成的稿子：极短，念出来不到一秒 */
export const WARMUP_TEXT = "你好。";

/** 试合成用了不到这么久，就算模型之前已经加载好了（已加载时一句话一两秒；冷启动要加载几十秒） */
export const ALREADY_LOADED_MS = 10_000;

/** 识别模型连续失败（没加载起来、加载好就崩）时，第几次之后隔多久再试（毫秒；用完了一直按最后一个） */
export const RECOGNIZER_RETRY_MS: readonly number[] = [5_000, 30_000, 2 * 60_000, 10 * 60_000];

/** 识别进程加载好之后多久没崩算稳定下来：稳定了才把连续失败清零，之后再意外退出就马上重拉 */
export const RECOGNIZER_STABLE_MS = 60_000;

export interface VoiceWarmupOptions {
  recognizer: Recognizer;
  /** 经 audio.cpp 的合成（语音回复用的那一个） */
  speech: SpeechSynthesizer;
  references: ReferenceVoices;
  /** 多久看一次合成服务的 /health（毫秒）；试合成碰上服务忙时也按它的间隔再试 */
  probeMs: number;
  /** 识别模型连续失败时的退避（毫秒）；不给是 RECOGNIZER_RETRY_MS（测试里配小） */
  retryMs?: readonly number[];
  /** 识别进程加载好之后多久没崩算稳定（毫秒）；不给是 RECOGNIZER_STABLE_MS（测试里配小） */
  stableMs?: number;
  /** 状态变了（推给前端） */
  onChange?: (view: VoiceModelsView) => void;
  log: (line: string) => void;
}

export interface VoiceWarmup {
  /** 给语音回复用的合成：试合成在做时等它做完再发；真合成的结果也用来更新合成模型的状态 */
  readonly speech: SpeechSynthesizer;
  /** 两个模型现在的状态 */
  view(): VoiceModelsView;
  /** 开始预热（后台做，马上返回） */
  start(): void;
  stop(): Promise<void>;
}

/** 队列里的两件事 */
const RECOGNIZER = "recognizer";
const SPEECH = "speech";

/** 日志里的秒数：整秒的不带小数 */
const seconds = (ms: number) => (ms % 1000 === 0 ? String(ms / 1000) : (ms / 1000).toFixed(1));

export function createVoiceWarmup(options: VoiceWarmupOptions): VoiceWarmup {
  const { recognizer, speech, references, log } = options;
  const retryMs = options.retryMs && options.retryMs.length > 0 ? options.retryMs : RECOGNIZER_RETRY_MS;
  const stableMs = options.stableMs ?? RECOGNIZER_STABLE_MS;
  const startedAt = nowIso();
  let revision = 1;
  let speechState: VoiceModelState = { status: "waiting", reason: SPEECH_WARMUP_TEXT.queued, since: startedAt };
  let stopped = false;
  const aborter = new AbortController();

  const view = (): VoiceModelsView => ({
    recognizerEngines: [RECOGNIZER_ENGINE],
    recognizerEngine: RECOGNIZER_ENGINE,
    recognizer: recognizer.state,
    speech: speechState,
    startedAt,
    revision,
  });
  const changed = () => {
    if (stopped) return;
    revision += 1;
    options.onChange?.(view());
  };
  const setSpeech = (next: Omit<VoiceModelState, "since">) => {
    speechState = { ...next, since: nowIso() };
    changed();
  };

  const queue = createSerialQueue((what) => (what === RECOGNIZER ? warmRecognizer() : warmSpeech()), { label: "预热语音模型", log });

  // ───────────── 识别 ─────────────

  /** 现在（或上一个）识别进程加载好之后稳定下来了（撑过了 stableMs） */
  let stable = false;
  /** 稳定下来之前连着退避了几次（决定下一次隔多久） */
  let backoffs = 0;
  let stableTimer: NodeJS.Timeout | undefined;
  let retryTimer: NodeJS.Timeout | undefined;

  const warmRecognizer = async () => {
    if (stopped) return;
    clearTimeout(retryTimer);
    // 结局（加载好、没了）经 onLifecycle 报来；这里只等它有结局，合成的预热排在后面。守护进程在停就不等了（加载可能要几十秒）
    const settled = recognizer.load().then(
      () => {},
      () => {},
    );
    await untilSettled(settled, aborter.signal).catch(() => {});
  };

  /** 按退避再拉：越隔越久，每次一行日志 */
  const retryLater = (what: string, reason: string) => {
    const delay = retryMs[Math.min(backoffs, retryMs.length - 1)]!;
    backoffs += 1;
    log(`${what}（${reason}）：${seconds(delay)} 秒后再试`);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => queue.enqueue(RECOGNIZER), delay);
    retryTimer.unref();
  };

  const unwatchState = recognizer.onState(() => changed());
  const unwatchLifecycle = recognizer.onLifecycle((event) => {
    if (stopped) return;
    if (event.type === "loaded") {
      const { info } = event;
      clearTimeout(retryTimer);
      const fallback = info.fallbackReason ? `，退回了这个（${info.fallbackReason}）` : "";
      log(`语音识别模型加载好了：${info.model}（${info.device}，${info.computeType}），加载用了 ${(info.loadMs / 1000).toFixed(1)} 秒${fallback}`);
      // 撑过 stableMs 没崩才算稳定：连续失败清零
      clearTimeout(stableTimer);
      stableTimer = setTimeout(() => {
        stable = true;
        backoffs = 0;
      }, stableMs);
      stableTimer.unref();
      return;
    }
    clearTimeout(stableTimer);
    const wasStable = stable;
    stable = false;
    // 闲置退出：不重拉，下一条语音来了再拉起
    if (event.cause === "idle") return;
    if (event.cause === "exited" && wasStable) {
      log(`语音识别进程意外退出（${event.reason}）：马上重新拉起、加载模型`);
      queue.enqueue(RECOGNIZER);
      return;
    }
    retryLater(event.cause === "exited" ? "语音识别进程加载好后很快又退出了" : "语音识别模型没加载起来", event.reason);
  });

  // ───────────── 合成 ─────────────

  /** 上次看到合成服务连得上吗（还没看过是 undefined） */
  let lastUp: boolean | undefined;
  /** 合成的预热排着或者正在做 */
  let speechPending = false;
  /** 还没有参考音色、等着导入 */
  let needsReference = false;
  /** 正在做的试合成：真的合成等它做完 */
  let inflight: Promise<void> | undefined;
  let probing = false;
  let probeTimer: NodeJS.Timeout | undefined;

  const enqueueSpeech = () => {
    if (stopped || speechPending) return;
    speechPending = true;
    queue.enqueue(SPEECH);
  };

  const warmSpeech = async () => {
    try {
      if (stopped) return;
      const health = await speech.health(aborter.signal);
      if (stopped) return;
      lastUp = health.up;
      if (!health.up) {
        log(`语音合成预热：${health.reason}，开了再预热`);
        setSpeech({ status: "off", reason: health.reason });
        return;
      }
      const reference = references.current();
      needsReference = reference === undefined;
      if (!reference) {
        log(`语音合成预热：${SPEECH_WARMUP_TEXT.needsReference}`);
        setSpeech({ status: "waiting", reason: SPEECH_WARMUP_TEXT.needsReference });
        return;
      }
      // 忙着时再试：状态留在"忙"，不来回闪"加载中"
      const wasBusy = speechState.status === "busy";
      if (!wasBusy) setSpeech({ status: "loading" });
      let settle!: () => void;
      inflight = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const started = performance.now();
      try {
        const result = await speech.synthesize(
          { text: WARMUP_TEXT, voiceId: reference.id, voiceRef: reference.audioPath, referenceText: reference.referenceText },
          { estimatedSeconds: 1, signal: aborter.signal },
        );
        if (stopped) return;
        const loadMs = Math.round(performance.now() - started);
        const alreadyLoaded = loadMs < ALREADY_LOADED_MS;
        log(`语音合成预热：试合成用了 ${(loadMs / 1000).toFixed(1)} 秒，${alreadyLoaded ? "模型之前已经加载好了" : "模型是这次加载的"}（${result.model}）`);
        setSpeech({ status: "ready", model: result.model, loadMs, alreadyLoaded });
      } catch (err) {
        if (stopped) return;
        const reason = err instanceof Error ? err.message : String(err);
        if (err instanceof SpeechServiceBusy) {
          // 显卡在给别的任务用（和 drama 共用，启动时常见）：按探活的间隔再试；只在开始忙时记一行
          if (!wasBusy) {
            log(`语音合成预热：${reason}，每 ${seconds(options.probeMs)} 秒再试`);
            setSpeech({ status: "busy", reason: SPEECH_WARMUP_TEXT.busy });
          }
          return;
        }
        log(`语音合成预热没做成：${reason}`);
        if (err instanceof SpeechServiceOff) {
          lastUp = false;
          setSpeech({ status: "off", reason });
        } else setSpeech({ status: "error", reason });
      } finally {
        inflight = undefined;
        settle();
      }
    } finally {
      speechPending = false;
    }
  };

  /** 低频探活：只在连不上 ↔ 连得上变了的时候动作；服务忙着的，连得上就再试一次合成的预热 */
  const probe = async () => {
    if (stopped || probing || speechPending || lastUp === undefined) return;
    probing = true;
    try {
      const health = await speech.health(aborter.signal);
      if (stopped || speechPending) return;
      const flipped = health.up !== lastUp;
      lastUp = health.up;
      if (!health.up) {
        if (!flipped) return;
        log(`语音合成服务连不上了（${health.reason}）`);
        setSpeech({ status: "off", reason: health.reason });
      } else if (flipped) {
        log("语音合成服务连得上了：再预热一次");
        enqueueSpeech();
      } else if (speechState.status === "busy") enqueueSpeech();
    } finally {
      probing = false;
    }
  };

  const unwatchReferences = references.onChange(() => {
    if (needsReference && references.current() && lastUp) enqueueSpeech();
  });

  /** 真合成的结果：成了说明模型加载好了；连不上说明服务没开 */
  const gated: SpeechSynthesizer = {
    get model() {
      return speech.model;
    },
    health: (signal) => speech.health(signal),
    async synthesize(request, opts) {
      // 试合成在做：等它做完再发（它做的正是这次要等的加载）。等的这段不算进这次合成自己的超时
      for (let trial = inflight; trial; trial = inflight) await untilSettled(trial, opts.signal);
      try {
        const result = await speech.synthesize(request, opts);
        lastUp = true;
        if (speechState.status !== "ready" && !stopped) setSpeech({ status: "ready", model: result.model });
        return result;
      } catch (err) {
        if (err instanceof SpeechServiceOff && !stopped) {
          lastUp = false;
          if (speechState.status !== "off") setSpeech({ status: "off", reason: err.message });
        }
        throw err;
      }
    },
  };

  return {
    speech: gated,
    view,
    start() {
      // 识别进程不可用（比如配置里的 Python 还是占位符）：不预热，状态里是原因
      if (recognizer.state.status === "error") log(`语音识别不可用，不预热识别模型：${recognizer.state.reason ?? "原因不明"}`);
      else queue.enqueue(RECOGNIZER);
      enqueueSpeech();
      probeTimer = setInterval(() => void probe(), options.probeMs);
      probeTimer.unref();
    },
    async stop() {
      stopped = true;
      clearInterval(probeTimer);
      clearTimeout(retryTimer);
      clearTimeout(stableTimer);
      unwatchState();
      unwatchLifecycle();
      unwatchReferences();
      aborter.abort();
      await queue.stop();
    },
  };
}

/** 等 p 有结局；signal 中止了就不等了（抛出中止） */
function untilSettled(p: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return p;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("语音合成被中止了"));
    signal.addEventListener("abort", onAbort, { once: true });
    void p.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}
