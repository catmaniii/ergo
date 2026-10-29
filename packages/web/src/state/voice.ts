// 语音消息的气泡（规格第 22 节，31 号票）：每条语音（VoiceRecord）跟着会话频道上的 voice 事件走（ui-state.ts 按版本归并进 UiState.voices），
// 气泡要的东西从这里取：时长和宽度（宽度随时长变）、识别状态、文字那一行（用户发的语音默认显示识别出的文字）、
// 能不能重新识别。第一阶段不用大模型修正，识别出的文字就是 faster-whisper 的结果（用户 2026-10-08 定）。
// 36 号票起文字那一行和语音在同一个框里（播放条和时长在上、文字在下），框的样子见 voiceBubbleLook。
import { type MessagePart, settledVoiceText, VOICE_MAX_MS, VOICE_STATUS_LABEL, t, voiceDurationLabel, type VoiceRecord, type VoiceStatus } from "./protocol.ts";
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
// 几格按时长定：随时长的宽度里，除去框的左右内边距和边线、播放键、两处间隔和时长那几个字，剩下的放得下几格就画几格，
// 所以没有文字时波形差不多填满播放条，有文字时也不把框撑宽。
// 42 号票起这些尺寸每套风格可以不一样（软糖圆角的播放键是 36 的圆、竖条 4 像素）：是风格的 voice-* token，styles/voice.css
// 按同样的 token 画，页面把现在这套风格的换算成数（src/visual-styles/voice.ts）传进来。随时长的宽度（上面 76–236 的曲线）
// 按经典的尺寸定，曲线减去经典的边就是"波形那一段"的长度——各套风格一样长；框的宽度 = 这套风格自己的边 + 这一段 + 时长，
// 波形在这一段里按这套风格的竖条、间隔放得下几格画几格。经典的尺寸代进去，宽度、格数和原来一模一样。

/** 播放条的尺寸（像素）：风格的 voice-* token 换算来的（src/visual-styles/voice.ts） */
export interface VoiceBarSizes {
  /** 框的左右内边距（各一份，--voice-pad） */
  readonly pad: number;
  /** agent 一侧框左边的竖线（--voice-line）；用户一侧没有，也按它留，两边算法一样 */
  readonly line: number;
  /** 播放键的宽（--voice-key） */
  readonly key: number;
  /** 播放键和波形、波形和时长之间的间隔（各一份，--voice-gap） */
  readonly gap: number;
  /** 波形一格竖条的宽（--voice-bar） */
  readonly bar: number;
  /** 竖条之间的间隔（--voice-bar-gap） */
  readonly barGap: number;
}

/**
 * 经典的尺寸（69 号票定的那一套：内边距 13、竖线 3、播放键 16、间隔 8、竖条 2、竖条间隔 2）：随时长的宽度按它定，
 * 没传尺寸时也按它。和 classic/style.ts 的 voice-* token 一样（test/visual-styles/voice.test.ts 查）
 */
export const BASE_VOICE_BAR: VoiceBarSizes = { pad: 13, line: 3, key: 16, gap: 8, bar: 2, barGap: 2 };

/** 播放条里除了波形和时长的部分：左右内边距、竖线、播放键、两处间隔（经典 61） */
function barEdges(sizes: VoiceBarSizes): number {
  return 2 * sizes.pad + sizes.line + sizes.key + 2 * sizes.gap;
}

/** 时长那几个字（数字、′、″）每个最多多宽 */
const DURATION_CHAR = 7;

/** 随时长的宽度（经典的框宽）换成这套尺寸下的框宽：波形那一段一样长，边比经典多出来多少，框就宽多少 */
export function voiceWidthIn(width: number, sizes: VoiceBarSizes = BASE_VOICE_BAR): number {
  return width + barEdges(sizes) - barEdges(BASE_VOICE_BAR);
}

/** 这么长的语音，播放条里的波形画几格（至少 1 格）：波形那一段（各风格一样长）里按这套风格的竖条、间隔放得下几格 */
function waveBarCount(durationMs: number, sizes: VoiceBarSizes): number {
  const room = voiceBubbleWidth(durationMs) - barEdges(BASE_VOICE_BAR) - voiceDurationLabel(durationMs).length * DURATION_CHAR;
  return Math.max(1, Math.floor((room + sizes.barGap) / (sizes.bar + sizes.barGap)));
}

/**
 * 播放条里画的波形（69 号票）：把波形摘要（每格 0–100）缩放成按时长定的格数（42 号票起按这套风格的尺寸算）。比摘要少时
 * 每格取它盖住的那几格里最大的（和录音时做摘要一样留住峰），比摘要多时按位置插值；没有波形（分段合成中）就不画
 */
export function voiceWave(waveform: readonly number[], durationMs: number, sizes: VoiceBarSizes = BASE_VOICE_BAR): number[] {
  if (waveform.length === 0) return [];
  const bars = waveBarCount(durationMs, sizes);
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
   * 还在发送、排队、识别的（pending）是"发送中…""识别中…"，识别没做成、等着或正在自动重试的（208 号票）是"识别中（第 N 次重试）…"；
   * 识别失败的（failed，自动重试完了还不行）是"识别失败"，长按菜单里能重新识别；
   * 识别完了但没有文字的（empty，比如只录到了噪声）是"没有识别出文字"
   */
  caption: { kind: "text" | "pending" | "failed" | "empty"; text: string };
  /** 菜单里有"重新识别"：识别失败的才有 */
  canRetry: boolean;
}

/** 框里播放条下面那一行；autoRetry 是第几次自动重试（208 号票，排队、识别中时才看） */
function captionOf(status: VoiceBubble["status"], text: string | undefined, autoRetry?: number): VoiceBubble["caption"] {
  if (status === "sending") return { kind: "pending", text: t("state.voice.sendingEllipsis") };
  if (status === "failed") return { kind: "failed", text: VOICE_STATUS_LABEL.failed };
  if (status !== "done" && autoRetry !== undefined) return { kind: "pending", text: t("state.voice.retryingEllipsis", { status: VOICE_STATUS_LABEL.recognizing, n: autoRetry }) };
  if (status !== "done") return { kind: "pending", text: t("state.voice.pendingEllipsis", { status: VOICE_STATUS_LABEL.recognizing }) };
  return text?.trim() ? { kind: "text", text } : { kind: "empty", text: t("state.voice.empty") };
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

/**
 * 用户发的语音：框里总有下半截——识别出的文字（识别完成就直接显示），或者识别中、失败、没识别出文字的说法。
 * 宽度按这套风格的播放条尺寸（42 号票，voiceWidthIn；不传是经典的）
 */
export function voiceBubbleLook(bubble: VoiceBubble, sizes: VoiceBarSizes = BASE_VOICE_BAR): VoiceBubbleLook {
  return { body: bubble.caption, width: { min: voiceWidthIn(bubble.width, sizes) } };
}

/**
 * 已经识别出文字的语音 part 的气泡，文字由别处给（158 号票：设置里素材的详情——素材里记着识别出的文字，那条语音不一定在手里的会话状态里）
 */
export function transcribedVoiceBubble(part: VoicePart, text: string): VoiceBubble {
  return {
    status: "done",
    label: VOICE_STATUS_LABEL.done,
    duration: voiceDurationLabel(part.durationMs),
    width: voiceBubbleWidth(part.durationMs),
    text: text.trim() ? text : undefined,
    caption: captionOf("done", text),
    canRetry: false,
  };
}

/** 一个语音 part 的气泡 */
export function voiceBubble(state: UiState, part: VoicePart): VoiceBubble {
  const voice = part.voiceId === undefined ? undefined : voiceOf(state, part.voiceId);
  const status = part.voiceId === undefined ? "sending" : (voice?.status ?? "queued");
  const text = voice && settledVoiceText(voice);
  return {
    status,
    label: status === "sending" ? t("state.voice.sending") : VOICE_STATUS_LABEL[status],
    duration: voiceDurationLabel(part.durationMs),
    width: voiceBubbleWidth(part.durationMs),
    text: text?.trim() ? text : undefined,
    caption: captionOf(status, text, voice?.autoRetry),
    canRetry: voice?.status === "failed",
  };
}
