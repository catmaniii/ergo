// 语音消息的气泡（规格第 22 节，31 号票）：每条语音（VoiceRecord）跟着会话频道上的 voice 事件走（ui-state.ts 按版本归并进 UiState.voices），
// 气泡要的东西从这里取：时长和宽度（宽度随时长变）、识别状态、文字那一行（用户发的语音默认显示识别出的文字）、
// 能不能重新识别。第一阶段不用大模型修正，识别出的文字就是 faster-whisper 的结果（用户 2026-10-08 定）。
// 36 号票起文字那一行和语音在同一个框里（播放条和时长在上、文字在下），框的样子见 voiceBubbleLook。
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

// 播放条（69 号票）：波形只占它自己那几格，时长紧跟在后面，框因为文字变宽时多出来的空白留在行尾。
// 几格按时长定：随时长的宽度里，除去框的左右内边距和边线、播放图标、两处间隔和时长那几个字，剩下的放得下几格就画几格，
// 所以没有文字时波形差不多填满播放条，有文字时也不把框撑宽。下面这些像素要和 styles/voice.css 对得上（取各套风格里最宽的）。
/** 框的左右内边距（各 13）加上 agent 一侧左边的竖线（经典风格 3） */
const BAR_EDGE = 13 + 13 + 3;
/** 播放图标（16）加上它和波形、波形和时长之间的两处间隔（各 8） */
const BAR_ICON_AND_GAPS = 16 + 8 + 8;
/** 时长那几个字（数字、′、″）每个最多多宽 */
const DURATION_CHAR = 7;
/** 波形的一格：2 像素的竖条，格与格之间隔 2 像素 */
const WAVE_BAR = 2;
const WAVE_GAP = 2;

/** 这么长的语音，播放条里的波形画几格（至少 1 格） */
function waveBarCount(durationMs: number): number {
  const room = voiceBubbleWidth(durationMs) - BAR_EDGE - BAR_ICON_AND_GAPS - voiceDurationLabel(durationMs).length * DURATION_CHAR;
  return Math.max(1, Math.floor((room + WAVE_GAP) / (WAVE_BAR + WAVE_GAP)));
}

/**
 * 播放条里画的波形（69 号票）：把波形摘要（每格 0–100）缩放成按时长定的格数。比摘要少时每格取它盖住的那几格里最大的
 * （和录音时做摘要一样留住峰），比摘要多时按位置插值；没有波形（分段合成中）就不画
 */
export function voiceWave(waveform: readonly number[], durationMs: number): number[] {
  if (waveform.length === 0) return [];
  const bars = waveBarCount(durationMs);
  const per = waveform.length / bars;
  return Array.from({ length: bars }, (_, i) => {
    if (per >= 1) return Math.max(...waveform.slice(Math.floor(i * per), Math.ceil((i + 1) * per)));
    const at = Math.min(Math.max((i + 0.5) * per - 0.5, 0), waveform.length - 1);
    const lo = Math.floor(at);
    const hi = Math.min(lo + 1, waveform.length - 1);
    return Math.round(waveform[lo]! + (waveform[hi]! - waveform[lo]!) * (at - lo));
  });
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
   * 用户发的语音，框里播放条下面默认显示的一行（这段文字就算用户对识别结果的确认）：识别出的文字（text）；
   * 还在发送、排队、识别的（pending）是"发送中…""识别中…"；识别失败的（failed）是"识别失败"，长按菜单里能重新识别；
   * 识别完了但没有文字的（empty，比如只录到了噪声）是"没有识别出文字"
   */
  caption: { kind: "text" | "pending" | "failed" | "empty"; text: string };
  /** 菜单里有"重新识别"：识别失败的才有 */
  canRetry: boolean;
}

/** 框里播放条下面那一行 */
function captionOf(status: VoiceBubble["status"], text: string | undefined): VoiceBubble["caption"] {
  if (status === "sending") return { kind: "pending", text: "发送中…" };
  if (status === "failed") return { kind: "failed", text: VOICE_STATUS_LABEL.failed };
  if (status !== "done") return { kind: "pending", text: `${VOICE_STATUS_LABEL.recognizing}…` };
  return text?.trim() ? { kind: "text", text } : { kind: "empty", text: "没有识别出文字" };
}

/**
 * 语音气泡框的样子（36 号票，用户 2026-10-08 定）：语音和它的文字在同一个框里，播放条和时长在上，文字那一块在下。
 * 用户发的语音和 agent 发的语音（agent-voice.ts 的 agentVoiceBubbleLook）都这样
 */
export interface VoiceBubbleLook {
  /** 框里下半截：文字（text），或者"发送中…""识别中…""识别失败""没有识别出文字"这类说法；没有就只有播放条和时长 */
  body: VoiceBubble["caption"] | undefined;
  /** 宽度（像素，随时长变）：没有下半截时框就这么宽（exact）；有下半截时它是最小宽度，框按文字撑开（min，最宽到一行放满） */
  width: { exact: number } | { min: number };
}

/** 用户发的语音：框里总有下半截——识别出的文字（识别完成就直接显示），或者识别中、失败、没识别出文字的说法 */
export function voiceBubbleLook(bubble: VoiceBubble): VoiceBubbleLook {
  return { body: bubble.caption, width: { min: bubble.width } };
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
