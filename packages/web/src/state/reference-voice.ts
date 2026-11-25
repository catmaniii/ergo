// 设置 · 语音里参考音色的几句话（472）："参考录音如果太长，现在会报错，最长30秒，其实没必要。"
// 长于 REFERENCE_VOICE_MAX_MS 的录音导入时自动截一段当参考（守护进程截，交回的 trimmedFromMs 是原来多长）：
// - 音色那一行写"从 2 分 10 秒的录音里截了开头 14.6 秒"（没截过的照旧写时长）；
// - 导入成功的提示也说一句；
// - 导入框的说明写清长录音会自动截一段、文件最大多少 MB。
import {
  REFERENCE_VOICE_MAX_BYTES,
  REFERENCE_VOICE_MAX_MS,
  REFERENCE_VOICE_MIN_MS,
  REFERENCE_VOICE_TRIM_TARGET_MS,
  type ReferenceVoice,
  t,
} from "./protocol.ts";

/** 原来的录音多长：45 秒、2 分 10 秒、3 分钟；一小时起只写分钟（75 分钟） */
export function recordingLengthLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return t("pages.voice.length.seconds", { seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes >= 60) return t("pages.voice.length.minutes", { minutes: Math.round(seconds / 60) });
  return rest === 0 ? t("pages.voice.length.minutes", { minutes }) : t("pages.voice.length.minutesSeconds", { minutes, seconds: rest });
}

/** 截出来多长：一位小数（14.6 秒），和音色那一行的时长一样写 */
const keptLabel = (ms: number) => t("pages.voice.seconds", { seconds: (ms / 1000).toFixed(1) });

/** 截过的音色那一行写的话："从 2 分 10 秒的录音里截了开头 14.6 秒"；没截过的是 undefined */
export function referenceVoiceTrimNote(voice: Pick<ReferenceVoice, "durationMs" | "trimmedFromMs">): string | undefined {
  if (voice.trimmedFromMs === undefined) return undefined;
  return t("pages.voice.trimmed", { from: recordingLengthLabel(voice.trimmedFromMs), kept: keptLabel(voice.durationMs) });
}

/** 导入成功的提示：截过的说一句原来多长、截了多少 */
export function referenceVoiceImportedNote(voice: Pick<ReferenceVoice, "name" | "durationMs" | "trimmedFromMs">): string {
  if (voice.trimmedFromMs === undefined) return t("pages.voice.imported", { name: voice.name });
  return t("pages.voice.importedTrimmed", { name: voice.name, from: recordingLengthLabel(voice.trimmedFromMs), kept: keptLabel(voice.durationMs) });
}

/** 导入框里的说明：常见格式、文件最大多少 MB、长录音自动截一段（截多长）、最短多少 */
export function referenceVoiceImportHint(): string {
  return t("pages.voice.importHint", {
    min: REFERENCE_VOICE_MIN_MS / 1000,
    max: REFERENCE_VOICE_MAX_MS / 1000,
    target: REFERENCE_VOICE_TRIM_TARGET_MS / 1000,
    maxMb: Math.round(REFERENCE_VOICE_MAX_BYTES / 1024 / 1024),
  });
}
