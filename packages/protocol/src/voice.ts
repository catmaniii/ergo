// 语音消息（规格第 22 节，31 号票）：时长和波形的限制、识别状态、交给 agent 的写法。
// 只有常量和纯函数，不引用 TypeBox（类型用 import type 从 voice-schema.ts 取）：守护进程、Web 状态层和界面共用。
import type { MessagePart } from "./schema.ts";
import type { VoiceRecord, VoiceStatus } from "./voice-schema.ts";

/** 单条语音最长 60 秒：录到 60 秒自动发送 */
export const VOICE_MAX_MS = 60_000;
/** 不到 1 秒的不发（"说话时间太短"） */
export const VOICE_MIN_MS = 1_000;
/** 最后 10 秒倒计时 */
export const VOICE_COUNTDOWN_MS = 10_000;
/** 服务端核对时长时多容忍的一点（浏览器量的时长和录下来的略有出入） */
export const VOICE_DURATION_SLACK_MS = 2_000;
/** 波形摘要最多多少格（每格 0–100 的音量，画气泡用） */
export const VOICE_WAVEFORM_MAX_BARS = 64;
/** 波形摘要每格的最大值 */
export const VOICE_WAVEFORM_MAX = 100;

/**
 * 识别状态：排队、识别中、完成、失败。
 * 完成和失败之后这条语音才交给 agent（识别完成前它在 agent 的输入队列里等着）；失败的可以重新识别，回到排队
 */
export const VOICE_STATUSES = ["queued", "recognizing", "done", "failed"] as const;

export const VOICE_STATUS_LABEL: Readonly<Record<VoiceStatus, string>> = {
  queued: "排队识别",
  recognizing: "识别中",
  done: "已识别",
  failed: "识别失败",
};

/** 识别有了结局（完成或失败）：可以交给 agent 了 */
export function isVoiceSettled(status: VoiceStatus): boolean {
  return status === "done" || status === "failed";
}

/** 交给 agent 的通知里语音的写法："语音转写：<识别出的文字>"（发给模型前的投影第 1 版自带同样的写法，不从这里取） */
export const VOICE_TRANSCRIPT_LABEL = "语音转写";

/** 识别完成的语音的文字（faster-whisper 识别出的）；还没识别完（排队、识别中）或者识别失败的没有文字 */
export function settledVoiceText(voice: Pick<VoiceRecord, "status" | "recognition">): string | undefined {
  return voice.status === "done" ? voice.recognition?.text : undefined;
}

/** 一条消息里的语音 part 引用的语音（按出现的先后；前端还没发出去的没有 id，不算） */
export function voiceIdsOf(parts: readonly MessagePart[]): string[] {
  return parts.flatMap((p) => (p.type === "voice" && p.voiceId !== undefined ? [p.voiceId] : []));
}

/** 时长的说法：气泡上的 5″、1′05″ */
export function voiceDurationLabel(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}″`;
  return `${Math.floor(seconds / 60)}′${String(seconds % 60).padStart(2, "0")}″`;
}
