// 语音识别的第三条接入（ADR-0039）：调 audio.cpp 服务上的语音识别模型（POST /v1/audio/transcriptions），不用 Python。
// 服务和语音合成是同一个（组件页装的 ergo-daemon--audiocpp，或者手动配的），模型 id 固定是 asr。对上层是同一个接口（recognizer.ts 的 Recognizer）；
// 状态机、超时语义、串词过滤和调 LSM 那条共用（recognizer-client.ts 的 createServiceRecognizer），这里只写这个服务的接口。下面这些都是拿真服务试出来的：
// - **只收 WAV**（文件名不是 .wav 回 400，内容不是 WAV 回 500；webm 在 v0.9.3 也不收）。浏览器录的是 webm、ogg、mp4，所以网页在这种接入下先转成 WAV 再传
//   （VoiceModelsView.recognizerInput，app/voice-browser.ts）；传来的不是 WAV（旧录音重新识别、老版本页面）用本机的 ffmpeg 转，没有 ffmpeg 就这一条失败、写明原因，服务还算好的；
// - 服务没有"模型加载了没有"的接口（/health 和 /v1/models 加没加载都一样，模型文件不在也照样通），所以预热是发一小段静音，它顺势加载，结果扔掉（静音会识别出个"我"之类的字）；
//   check() 问 /v1/models 看服务活着、配了这个模型。服务被服务管家重启过的话模型要重新加载，看不出来，所以一次识别的超时总是留着冷启动的时间；
// - 语言只认 auto、zh、en、ja，别的回 500，所以 zh-CN 算 zh，认不得的（yue……）不传，让它自己判断；给模型的提示（initialPrompt）模型不支持，不传；
// - 回的只有文字和时长，没有分段和时间戳（模型不支持），所以整段算一个分段；
// - 同时发的在模型锁上排队；卡住太久回 503（server_busy，默认 5 分钟），这一次算没做成；
// - 错误的状态码不规矩（模型 id 不对、模型文件不在都是 500）：400、503 和"不是 WAV"是这一次没做成，别的 5xx 和 404 算这个服务不能用了（模型没了、加载不了），这一代作废、预热按退避再试。
import fs from "node:fs";
import { t } from "@ergo/protocol";
import type { RecognizeTimeoutConfig } from "../config/config.ts";
import { AudioConvertError, type AudioConverter } from "./audio-convert.ts";
import { CALL_TIMEOUT_MS, type CallResult, createServiceRecognizer, failureOf, type ServiceCall } from "./recognizer-client.ts";
import { type Recognizer, type RecognizerLoaded, RecognizerUnavailable, type RecognizeRequest, type RecognizeResult, recognizeTimeoutMs } from "./recognizer.ts";
import type { StripRule } from "./transcript-filter.ts";
import { readWav } from "./wav.ts";

/** 服务上语音识别模型的 id（清单 components/manifest.json 里 asr 组件的 serve.id，有测试核对两边一样） */
export const AUDIOCPP_RECOGNIZER_MODEL = "asr";

/** 设置 · 语音里显示的识别引擎 */
export const AUDIOCPP_RECOGNIZER_ENGINE = "Fun-ASR Nano";

export interface AudioCppRecognizerOptions {
  /** 服务的地址（不带末尾的斜杠），和语音合成的是同一个 */
  url: string;
  timeout: RecognizeTimeoutConfig;
  /** 录音不是 WAV 时转成 WAV（正式的是本机的 ffmpeg）；不给的话不是 WAV 的这一条失败 */
  convert?: AudioConverter;
  /** 识别结果里要剔掉的模型自带串词（编译好的规则）；不给不剔 */
  stripRules?: readonly StripRule[];
  /** check()问服务一句最多等多久（毫秒）；不给是 CHECK_TIMEOUT_MS */
  checkTimeoutMs?: number;
  log: (line: string) => void;
}

const TRANSCRIPTIONS = "/v1/audio/transcriptions";
/** 模型认的语言提示 */
const LANGUAGES: ReadonlySet<string> = new Set(["auto", "zh", "en", "ja"]);
/** 预热时模型锁被占着（别处在识别、卡住了），隔多久再试 */
const BUSY_RETRY_MS = 1000;
/** 预热发的静音（16 kHz、单声道、16 位，0.3 秒）：只为让它加载模型，越短越好 */
const SILENCE_SAMPLES = 4800;

/** 配置里的语言 → 模型认的；认不得的不传（undefined，模型自己判断）。zh-CN 这种算 zh */
export function audiocppLanguage(language: string | undefined): string | undefined {
  const base = language?.trim().toLowerCase().split(/[-_]/)[0];
  return base !== undefined && LANGUAGES.has(base) ? base : undefined;
}

/** 一小段静音的 WAV */
function silenceWav(): Buffer {
  const bytes = SILENCE_SAMPLES * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + bytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(bytes, 40);
  return wav;
}

const isWav = (bytes: Buffer): boolean => bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WAVE";

/** 上传的表单：文件名一定要 .wav（服务按文件名认） */
function formOf(wav: Buffer, language: string | undefined): FormData {
  const form = new FormData();
  form.set("model", AUDIOCPP_RECOGNIZER_MODEL);
  if (language !== undefined) form.set("language", language);
  form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
  return form;
}

/** 服务回的错误里的那句话（{ error: { message, type } }） */
function errorMessage(result: Extract<CallResult, { ok: false }>): string {
  const error = result.body?.error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") return (error as { message: string }).message;
  return t("voice.recognizer.lsmStatus", { status: result.status ?? 0, url: "audio.cpp" });
}

/** 模型列表里的这个模型（配置里写了就有，加没加载都一样）；没有是 undefined */
function modelEntry(body: Record<string, unknown>): { family?: unknown } | undefined {
  const data = body.data;
  if (!Array.isArray(data)) return undefined;
  return (data as { id?: unknown; family?: unknown }[]).find((m) => m.id === AUDIOCPP_RECOGNIZER_MODEL);
}

export function createAudioCppRecognizer(options: AudioCppRecognizerOptions): Recognizer {
  const { url, timeout } = options;
  return createServiceRecognizer(url, options, (call: ServiceCall) => {
    const noModel = () => new RecognizerUnavailable(t("voice.recognizer.audiocppNoModel", { url, model: AUDIOCPP_RECOGNIZER_MODEL }));
    /** 这一代加载好的模型（识别结果里带上） */
    let current: RecognizerLoaded | undefined;

    /** 识别、预热时服务回的错误 */
    const serviceFailure = (result: Extract<CallResult, { ok: false }>, timed: () => Error): Error => {
      if (result.cause !== "status") return failureOf(result, url, timed);
      const message = errorMessage(result);
      if (result.status === 503) return new Error(t("voice.recognizer.audiocppBusy", { url }));
      if (result.status === 404 || /unknown model id/i.test(message)) return noModel();
      if ((result.status ?? 0) < 500 || /invalid WAV/i.test(message)) return new Error(t("voice.recognizer.audiocppRejected", { reason: message }));
      return new RecognizerUnavailable(t("voice.recognizer.audiocppLoadFailed", { reason: message }));
    };

    /** 录音 → WAV：是 WAV 的不动；不是的转一下，转不了这一条失败（服务没问题，不作废） */
    const wavOf = async (path: string): Promise<Buffer> => {
      const audio = await fs.promises.readFile(path);
      if (isWav(audio)) return audio;
      if (!options.convert) throw new Error(t("voice.recognizer.audiocppNotWav"));
      try {
        const converted = await options.convert.convert(audio);
        try {
          return converted.wav;
        } finally {
          converted.cleanup();
        }
      } catch (err) {
        if (err instanceof AudioConvertError && err.kind === "missing") throw new Error(t("voice.recognizer.audiocppNoFfmpeg"), { cause: err });
        throw new Error(err instanceof Error ? err.message : String(err), { cause: err });
      }
    };

    return {
      async load(alive) {
        const loadTimeoutMs = timeout.baseMs + timeout.coldStartMs;
        const seconds = Math.max(1, Math.round(loadTimeoutMs / 1000));
        const deadline = Date.now() + loadTimeoutMs;
        const left = () => Math.max(1, deadline - Date.now());
        const short = () => Math.min(CALL_TIMEOUT_MS, left());
        const tooLong = () => new RecognizerUnavailable(t("voice.recognizer.loadTimeout", { seconds }));
        // 服务在不在、配了这个模型没有（lazy_load：配了不等于加载了）
        const models = await call("/v1/models", { method: "GET", timeoutMs: short() });
        if (!models.ok) throw failureOf(models, url, tooLong);
        const entry = modelEntry(models.body);
        if (!entry) throw noModel();
        const health = await call("/health", { method: "GET", timeoutMs: short() });
        if (!health.ok) throw failureOf(health, url, tooLong);
        // 让它加载：发一小段静音，等到回话就是加载好了。模型锁被占着（503）时过一会儿再试
        const started = performance.now();
        for (;;) {
          if (!alive()) throw new Error(t("voice.recognizer.stopped"));
          const answer = await call(TRANSCRIPTIONS, { method: "POST", form: formOf(silenceWav(), undefined), timeoutMs: left() });
          if (answer.ok) break;
          if (answer.cause !== "status" || answer.status !== 503) {
            const err = serviceFailure(answer, tooLong);
            throw err instanceof RecognizerUnavailable ? err : new RecognizerUnavailable(err.message);
          }
          if (Date.now() >= deadline) throw tooLong();
          await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS).unref());
        }
        current = {
          model: typeof entry.family === "string" && entry.family ? `${entry.family}（audio.cpp/${AUDIOCPP_RECOGNIZER_MODEL}）` : `audio.cpp/${AUDIOCPP_RECOGNIZER_MODEL}`, // @i18n-ignore data：记下的模型名（和语音合成的写法一样）
          device: typeof health.body.backend === "string" && health.body.backend ? health.body.backend : "audio.cpp",
          computeType: "",
          loadMs: Math.round(performance.now() - started),
        };
        return current;
      },
      async probe(timeoutMs) {
        const seconds = Math.max(1, Math.round(timeoutMs / 1000));
        const answer = await call("/v1/models", { method: "GET", timeoutMs });
        if (!answer.ok) return failureOf(answer, url, () => new RecognizerUnavailable(t("voice.recognizer.lsmNoAnswer", { seconds, url })));
        return modelEntry(answer.body) ? undefined : noModel();
      },
      async recognize(request: RecognizeRequest, { timeoutMs, signal, timeoutError }): Promise<RecognizeResult> {
        const started = Date.now();
        const wav = await wavOf(request.path);
        const language = audiocppLanguage(request.language);
        // initialPrompt 不传：模型不支持
        const answer = await call(TRANSCRIPTIONS, { method: "POST", form: formOf(wav, language), timeoutMs: Math.max(1, timeoutMs - (Date.now() - started)), signal });
        if (!answer.ok) throw serviceFailure(answer, () => timeoutError);
        const { text: raw, timing } = answer.body as { text?: unknown; timing?: { audio_duration_ms?: unknown } };
        if (typeof raw !== "string") throw new Error(t("voice.recognizer.lsmBadReply"));
        const text = raw.trim();
        const durationMs = typeof timing?.audio_duration_ms === "number" ? timing.audio_duration_ms : readWav(wav)?.durationMs;
        const duration = durationMs === undefined ? 0 : durationMs / 1000;
        return {
          text,
          language: language ?? "auto",
          // 模型没有时间戳：整段算一个分段
          segments: text === "" ? [] : [{ start: 0, end: duration, text }],
          duration,
          model: current?.model ?? `audio.cpp/${AUDIOCPP_RECOGNIZER_MODEL}`,
          device: current?.device ?? "audio.cpp",
          computeType: current?.computeType ?? "",
        };
      },
      // 服务可能刚被服务管家重启过（加模型、崩溃），模型要重新加载，从外面看不出来：总是留着冷启动的时间
      timeoutMs: (audioMs, loaded) => recognizeTimeoutMs(timeout, TIMEOUT_INIT, audioMs, loaded?.device) + (loaded ? timeout.coldStartMs : 0),
    };
  });
}

/** 算超时用：还不知道落在显卡还是 CPU 时按宽的（CPU）算 */
const TIMEOUT_INIT = { primary: { device: "cuda", model: AUDIOCPP_RECOGNIZER_MODEL, computeType: "" }, fallback: { device: "cpu", model: AUDIOCPP_RECOGNIZER_MODEL, computeType: "" } };
