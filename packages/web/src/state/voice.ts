// 语音消息的气泡（规格第 22 节，31 号票）：每条语音（VoiceRecord）跟着会话频道上的 voice 事件走（ui-state.ts 按版本归并进 UiState.voices），
// 气泡要的东西从这里取：时长和宽度（宽度随时长变）、识别状态、气泡下方显示的那一行（用户发的语音默认显示识别出的文字）、
// 能不能重新识别。第一阶段不用大模型修正，识别出的文字就是 faster-whisper 的结果（用户 2026-10-08 定）。
import { type MessagePart, settledVoiceText, VOICE_MAX_MS, VOICE_STATUS_LABEL, voiceDurationLabel, type VoiceRecord, type VoiceStatus } from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

type VoicePart = Extract<MessagePart, { type: "voice" }>;

/** 一条语音的最新状态（还没收到是 undefined） */
export function voiceOf(state: UiState, voiceId: string): VoiceRecord | undefined {
  return state.voices[voiceId];
}

/** 气泡最窄、最宽（像素）：1 秒的最窄，60 秒的最宽 */
const MIN_WIDTH = 76;
const MAX_WIDTH = 236;

/** 气泡的宽度随时长变（先快后慢：短语音之间也看得出长短） */
export function voiceBubbleWidth(durationMs: number): number {
  const seconds = Math.min(Math.max(durationMs, 1000), VOICE_MAX_MS) / 1000;
  return Math.round(MIN_WIDTH + (MAX_WIDTH - MIN_WIDTH) * Math.sqrt((seconds - 1) / (VOICE_MAX_MS / 1000 - 1)));
}

export interface VoiceBubble {
  /** 发送中（还没有语音对象），或者识别状态 */
  status: "sending" | VoiceStatus;
  label: string;
  /** 时长的说法（5″） */
  duration: string;
  width: number;
  /** 识别出的文字（"复制文字"复制它）；还没识别出来、识别失败时没有 */
  text: string | undefined;
  /**
   * 用户发的语音，气泡下方默认显示的一行（这段文字就算用户对识别结果的确认）：识别出的文字（text）；
   * 还在发送、排队、识别的（pending）是"发送中…""识别中…"；识别失败的（failed）是"识别失败"，长按菜单里能重新识别；
   * 识别完了但没有文字的（empty，比如只录到了噪声）是"没有识别出文字"
   */
  caption: { kind: "text" | "pending" | "failed" | "empty"; text: string };
  /** 菜单里有"重新识别"：识别失败的才有 */
  canRetry: boolean;
}

/** 气泡下方那一行 */
function captionOf(status: VoiceBubble["status"], text: string | undefined): VoiceBubble["caption"] {
  if (status === "sending") return { kind: "pending", text: "发送中…" };
  if (status === "failed") return { kind: "failed", text: VOICE_STATUS_LABEL.failed };
  if (status !== "done") return { kind: "pending", text: `${VOICE_STATUS_LABEL.recognizing}…` };
  return text?.trim() ? { kind: "text", text } : { kind: "empty", text: "没有识别出文字" };
}

/** 一个语音 part 的气泡 */
export function voiceBubble(state: UiState, part: VoicePart): VoiceBubble {
  const voice = part.voiceId === undefined ? undefined : voiceOf(state, part.voiceId);
  const status = part.voiceId === undefined ? "sending" : (voice?.status ?? "queued");
  const text = voice && settledVoiceText(voice);
  return {
    status,
    label: status === "sending" ? "发送中" : VOICE_STATUS_LABEL[status],
    duration: voiceDurationLabel(part.durationMs),
    width: voiceBubbleWidth(part.durationMs),
    text: text?.trim() ? text : undefined,
    caption: captionOf(status, text),
    canRetry: voice?.status === "failed",
  };
}
