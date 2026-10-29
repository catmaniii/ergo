// Debug 工具集的语音组（124 号票）：录一段送识别、用当前参考音色合成念一句。设置里的 Debug 页用它测麦克风、识别和合成通不通、多快。
// - 不经任何会话、不记事件：识别直接交给语音消息用的那个识别进程（它按到达顺序一条条处理，排在正在识别的语音后面），
//   合成交给语音回复用的那个合成（预热的试合成在做时等它做完）——不往秘书的会话里写东西，也就不进秘书的上下文；
// - 送来的录音写成临时目录里的一个文件交给识别进程，识别完（成没成都）就删掉；
// - 识别不了、合成不了不抛错，回原因（Debug 页照原样显示），耗时照样带上；
// - 180 号票：识别结果是识别进程的宿主剔掉模型自带串词之后的，剔了几个字一起带上（Debug 页写"已丢弃（N 字）"，不显示被剔的原文）。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type DebugRecognizeResult, type DebugSpeakResult, t } from "@ergo/protocol";
import type { ReferenceVoices } from "./reference-voices.ts";
import type { Recognizer } from "./recognizer.ts";
import { type SpeechSynthesizer, SpeechServiceBusy } from "./speech.ts";
import { estimateSpeechSeconds, type SpokenPace } from "./spoken-text.ts";
import { VOICE_REASON } from "./texts.ts";
import { readWav } from "./wav.ts";

export interface DebugVoiceOptions {
  recognizer: Pick<Recognizer, "transcribe">;
  /** 识别的语言、给模型的提示：和语音消息一样（配置里的 voice.recognizer） */
  recognition: { language?: string; initialPrompt?: string };
  speech: Pick<SpeechSynthesizer, "synthesize">;
  references: Pick<ReferenceVoices, "current">;
  /** 估语音时长（算合成的超时）用的语速 */
  pace: SpokenPace;
  /** 临时文件放哪（数据目录的 tmp 区） */
  tmpDir: string;
  log: (line: string) => void;
}

export interface DebugVoice {
  /** 识别一段录音（mime 是它的类型：浏览器录的 audio/webm…，App 录的 audio/wav） */
  recognize(audio: Buffer, mime: string): Promise<DebugRecognizeResult>;
  /** 用当前参考音色合成念一句 */
  speak(text: string): Promise<DebugSpeakResult>;
}

/** 没有参考音色时的原因 */
export const noReferenceVoice = () => t("voice.debug.noReference");

/** 临时文件的扩展名：识别进程按内容认格式，扩展名只是方便看 */
function extensionOf(mime: string): string {
  const type = mime.split(";")[0]!.trim().toLowerCase();
  if (type === "audio/wav" || type === "audio/x-wav" || type === "audio/wave") return ".wav";
  if (type === "audio/ogg") return ".ogg";
  if (type === "audio/mp4" || type === "audio/aac") return ".m4a";
  return ".webm";
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createDebugVoice(options: DebugVoiceOptions): DebugVoice {
  const { recognizer, speech, references, log } = options;
  return {
    async recognize(audio, mime) {
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      fs.mkdirSync(options.tmpDir, { recursive: true });
      const file = path.join(options.tmpDir, `debug-recognize-${randomUUID()}${extensionOf(mime)}`);
      try {
        fs.writeFileSync(file, audio);
        // WAV 量得出时长（算超时用）；别的格式按最长的算
        const wav = readWav(audio);
        const result = await recognizer.transcribe(
          {
            path: file,
            ...(options.recognition.language ? { language: options.recognition.language } : {}),
            ...(options.recognition.initialPrompt ? { initialPrompt: options.recognition.initialPrompt } : {}),
          },
          wav ? wav.durationMs : undefined,
        );
        return {
          ok: true,
          text: result.text.trim(),
          ms: elapsed(),
          model: result.model,
          device: result.device,
          ...(result.language ? { language: result.language } : {}),
          ...(result.strippedChars ? { strippedChars: result.strippedChars } : {}),
        };
      } catch (err) {
        log(`Debug 工具集的识别没成：${errorText(err)}`);
        return { ok: false, reason: errorText(err), ms: elapsed() };
      } finally {
        fs.rmSync(file, { force: true });
      }
    },
    async speak(text) {
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      const reference = references.current();
      if (!reference) return { ok: false, reason: noReferenceVoice(), ms: elapsed() };
      try {
        const { wav, model } = await speech.synthesize(
          { text, voiceId: reference.id, voiceRef: reference.audioPath, referenceText: reference.referenceText },
          { estimatedSeconds: estimateSpeechSeconds(text, options.pace) },
        );
        if (!readWav(wav)) return { ok: false, reason: VOICE_REASON.notWav, ms: elapsed() };
        return { ok: true, audioBase64: wav.toString("base64"), mime: "audio/wav", ms: elapsed(), model, voiceName: reference.name };
      } catch (err) {
        const reason = err instanceof SpeechServiceBusy ? VOICE_REASON.speechBusy : errorText(err);
        log(`Debug 工具集的合成没成：${reason}`);
        return { ok: false, reason, ms: elapsed() };
      }
    },
  };
}
