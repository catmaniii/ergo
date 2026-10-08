// 语音合成（规格第 21、22 节，32 号票）：经本机 LSM 托管的 audio.cpp 服务（drama 的 TTS 引擎，Fish-Audio S2 Pro）的 HTTP 接口，
// 用参考音色克隆。二狗不自己启动它（LSM 里对它声明弱依赖），它没开时这次语音回复退回只发文字。
// 接口契约见 audio.cpp 仓库 app/server/README.md：POST /v1/audio/speech，{ model, input, voice_ref, reference_text }，回 audio/wav。
// Fish 克隆时 voice_ref（参考 WAV 的路径，服务读本机文件）和 reference_text（逐字稿）必须同时给。
// audio.cpp 读不了带中文的路径：参考音色的目录和文件名都是英文（reference-voices.ts），数据目录本身的路径里有非英文字符时
// 这里直接报清楚，不发请求。
// 服务第一次用到时才加载模型（冷启动几十秒），已加载时一句 4 秒的话约 3.3 秒：一次最多等多久按配置算（冷启动总算上）。
// 显卡和 drama 共用：服务说忙（HTTP 503，server_busy）时不等、不重试，直接报"忙"（SpeechServiceBusy），这次退回只发文字。
// 实际用的模型：合成成功后问服务一次 GET /v1/models（OpenAI 风格，每项带 family），记成"<family>（audio.cpp/<模型 id>）"；
// 问不到（出错、列表里没有）时记配置里写的模型名，下次合成成功后再问。示例配置里模型 id 是占位符（要填 Fish-Audio S2 Pro
// 在服务上的模型 id，drama 的配置里是 tts）：原样用时不发请求，每次都报清楚（退回只发文字）。
// 日志和报错里只写字数、参考音色的 id 和文件名，不写要合成的原文和参考录音的完整路径。
import path from "node:path";
import { isPlaceholder, type SpeechTimeoutConfig } from "../config/config.ts";
import { readWav } from "./wav.ts";

export interface SpeechRequest {
  /** 要合成的口语稿 */
  text: string;
  /** 参考音色的 id（日志和报错里用它，不写路径） */
  voiceId: string;
  /** 参考录音的绝对路径（WAV） */
  voiceRef: string;
  /** 参考录音的逐字稿 */
  referenceText: string;
}

export interface SpeechResult {
  /** 合成出的 WAV */
  wav: Buffer;
  /** 实际用的模型（服务报出来的；报不出来时是配置里写的） */
  model: string;
}

export interface SpeechSynthesizer {
  /** 配置里写的模型（audio.cpp/<模型 id>） */
  readonly model: string;
  /**
   * 合成一段；estimatedSeconds 是估出的语音时长（算超时用）。失败抛错，message 是给用户看的原因；
   * 服务忙抛 SpeechServiceBusy
   */
  synthesize(request: SpeechRequest, options: { estimatedSeconds: number; signal?: AbortSignal }): Promise<SpeechResult>;
}

/** 语音合成服务忙（显卡在给别的任务用）：不等超时，直接退回只发文字 */
export class SpeechServiceBusy extends Error {
  override readonly name = "SpeechServiceBusy";
}

export interface AudioCppOptions {
  /** 服务地址（不带末尾的斜杠），比如 http://127.0.0.1:8090 */
  url: string;
  /** 服务上的 TTS 模型 id（drama 的配置里是 tts） */
  model: string;
  timeout: SpeechTimeoutConfig;
  log: (line: string) => void;
}

/** 这次合成最多等多久（毫秒） */
export function speechTimeoutMs(timeout: SpeechTimeoutConfig, estimatedSeconds: number): number {
  return Math.round(timeout.baseMs + timeout.coldStartMs + Math.max(1, estimatedSeconds) * timeout.perSpeechSecond * 1000);
}

/** 模型 id 还是占位符时说怎么填 */
export const SPEECH_MODEL_HINT = "换成 audio.cpp 服务上 Fish-Audio S2 Pro 的模型 id（drama 的配置里是 tts）";

/** 出错时服务回的正文最多带多少字进原因 */
const ERROR_BODY_MAX = 160;
/** 问实际模型最多等多久（毫秒）：问不到就记配置里的 */
const MODELS_TIMEOUT_MS = 3_000;

export function createAudioCppSynthesizer(options: AudioCppOptions): SpeechSynthesizer {
  const { url, model, log } = options;
  const configured = `audio.cpp/${model}`;
  /** 问到过的实际模型（问到一次就不再问） */
  let actual: string | undefined;
  const actualModel = async (signal: AbortSignal | undefined): Promise<string> => {
    if (actual) return actual;
    try {
      actual = await describeModel(url, model, signal);
    } catch (err) {
      log(`问语音合成服务实际用的模型没问到，记配置里的 ${configured}：${err instanceof Error ? err.message : String(err)}`);
    }
    return actual ?? configured;
  };
  return {
    model: configured,
    async synthesize(request, { estimatedSeconds, signal }) {
      if (isPlaceholder(model)) throw new Error(`数据目录配置里的 voice.speech.model 还是示例里的占位符：${SPEECH_MODEL_HINT}`);
      if (/[^\x20-\x7e]/.test(request.voiceRef)) {
        throw new Error(`参考音色 ${request.voiceId} 的录音路径里有非英文字符，audio.cpp 读不了：把数据目录放到纯英文的路径下`);
      }
      const timeoutMs = speechTimeoutMs(options.timeout, estimatedSeconds);
      const timer = AbortSignal.timeout(timeoutMs);
      const body = { model, input: request.text, voice_ref: request.voiceRef, reference_text: request.referenceText };
      log(`语音合成 → ${url}：${[...request.text].length} 字，参考音色 ${request.voiceId}（${path.basename(request.voiceRef)}），最多等 ${Math.round(timeoutMs / 1000)} 秒`);
      let res: Response;
      try {
        res = await fetch(`${url}/v1/audio/speech`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "audio/wav" },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timer]) : timer,
        });
      } catch (err) {
        throw new Error(reasonOf(err, url, timeoutMs, timer), { cause: err });
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        throw new Error(reasonOf(err, url, timeoutMs, timer), { cause: err });
      }
      if (!res.ok) {
        const text = bytes.toString("utf8");
        const detail = text.replace(/\s+/g, " ").trim().slice(0, ERROR_BODY_MAX);
        const reason = `HTTP ${res.status}${detail ? `：${detail}` : ""}`;
        if (res.status === 503 || isBusyBody(text)) throw new SpeechServiceBusy(`语音合成服务正忙（${reason}）`);
        throw new Error(`语音合成服务出错（${reason}）`);
      }
      if (!readWav(bytes)) throw new Error("语音合成服务回的不是能播放的 WAV");
      return { wav: bytes, model: await actualModel(signal) };
    },
  };
}

/** 出错的正文说的是"忙"（audio.cpp 的 error.type 是 server_busy） */
function isBusyBody(text: string): boolean {
  try {
    if ((JSON.parse(text) as { error?: { type?: unknown } } | null)?.error?.type === "server_busy") return true;
  } catch {
    // 不是 JSON：按文字看
  }
  return /\bbusy\b/i.test(text);
}

/** 服务上这个模型 id 实际是什么模型：GET /v1/models 里它那一项的 family（没有 family 时就是模型 id） */
async function describeModel(url: string, model: string, signal: AbortSignal | undefined): Promise<string> {
  const timer = AbortSignal.timeout(MODELS_TIMEOUT_MS);
  const res = await fetch(`${url}/v1/models`, { signal: signal ? AbortSignal.any([signal, timer]) : timer });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const list = (await res.json()) as { data?: Array<{ id?: unknown; family?: unknown }> } | null;
  const entry = list?.data?.find((m) => m.id === model);
  if (!entry) throw new Error(`服务的模型列表里没有 ${model}`);
  return typeof entry.family === "string" && entry.family ? `${entry.family}（audio.cpp/${model}）` : `audio.cpp/${model}`;
}

/** 请求没成的原因：服务没开、超时、别的网络错误 */
function reasonOf(err: unknown, url: string, timeoutMs: number, timer: AbortSignal): string {
  if (timer.aborted) return `语音合成超时（等了 ${Math.round(timeoutMs / 1000)} 秒）`;
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
  const code = cause?.code ?? (err as { code?: string } | undefined)?.code;
  if (code === "ECONNREFUSED") return `语音合成服务没开（${url}）`;
  if (err instanceof Error && err.name === "AbortError") return "语音合成被中止了";
  return `连不上语音合成服务（${url}：${err instanceof Error ? err.message : String(err)}）`;
}
