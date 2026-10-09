// 语音消息（规格第 22 节，31 号票）：时长和波形的限制、识别状态、交给 agent 的写法。
// 32 号票起还有 agent 发的语音（语音回复）：合成状态、整段还是口语总结、参考音色的限制。
// 只有常量和纯函数，不引用 TypeBox（类型用 import type 从 voice-schema.ts 取）：守护进程、Web 状态层和界面共用。
import type { MessagePart } from "./schema.ts";
import type { AgentVoiceMode, AgentVoiceStatus, VoiceRecord, VoiceStatus } from "./voice-schema.ts";

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
 * 录音诊断里的麦克风诊断记录最多留几条（61 号票：最近的麦克风开关和音轨事件）。
 * 一次完整的开关是 open、ready、close 三条，要放得下最近 10 次（30 条），再给音轨事件（mute、unmute、ended）、
 * 没要到（fail）、整段静音（silent）留些余量
 */
export const VOICE_MIC_LOG_MAX = 40;
/**
 * 录音诊断里各个字符串最长多少（61 号票）：前端截断、协议 schema、守护进程整理共用。
 * reason：开麦原因和记录里的事件名；logReason：记录里的原因（关麦原因、错误名）；visibility：页面的 visibilityState；browser：UA
 */
export const VOICE_CAPTURE_TEXT_MAX = { reason: 32, logReason: 64, visibility: 16, browser: 512 } as const;

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

// ───────────────────────── agent 发的语音（32 号票） ─────────────────────────

/**
 * agent 语音的状态（用户 2026-10-08 定：用户发语音的这一轮，回复不流式显示；短回复合成好只出语音）：
 * - replying：这一轮要用语音回复，agent 还在回复（回合开始时建出；前端不显示这一轮的回复文字，只显示"正在回复…"）；
 * - summarizing：回复长、agent 没写口语总结，运行时正在追问它补写一次（回复文字照常显示）；
 * - synthesizing：口语稿定了，正在合成（整段合成的回复文字收进语音里，不显示）。38 号票起分段合成：口语稿按句切成几段依次合成，
 *   每合成好一段（最后一段除外）追加一个新版本，带上已合成的段（AgentVoiceRecord.segments），前端第一段到了就出气泡、接着播；
 * - done：合成好了（分段的拼成了一条完整音频），同一事务追加载着它的消息（tts_audio part）；
 * - partial：分段合成到一半失败（服务出错、忙、超时……）：已经推出去的段拼成一条音频，同样追加载着它的消息；
 *   回复文字照常显示（整段合成的短回复也补出来），会话里另有一条说明（38 号票）；
 * - failed：没合成出来（服务没开、忙、出错、超时……，一段都没合成出来），回复文字照常显示，会话里另有一条说明；
 * - skipped：这一轮最后没有用语音回复（出错、中止、被打断，没有要念的文字，参考音色被删了），回复文字照常显示
 */
export const AGENT_VOICE_STATUSES = ["replying", "summarizing", "synthesizing", "done", "partial", "failed", "skipped"] as const;

/**
 * 送进 TTS 的是什么：whole 是整段回复（短、念得出来）；summary 是口语总结（回复太长或者有念不出来的内容，详细内容照常是那几条消息）。
 * 总结是 agent 用工具写的，或者 agent 没写时运行时兜底截的（AgentVoiceRecord.summaryBy）
 */
export const AGENT_VOICE_MODES = ["whole", "summary"] as const;

/**
 * 这条 agent 语音对应的回复，文字收进语音里（不单独显示）吗：这一轮还在回复（replying），或者整段合成、正在合成或合成好了。
 * 口语总结的、没合成出来的、最后没用语音的，回复文字照常显示
 */
export function agentVoiceCoversReply(voice: { status: AgentVoiceStatus; mode?: AgentVoiceMode | undefined }): boolean {
  return voice.status === "replying" || (voice.mode === "whole" && (voice.status === "synthesizing" || voice.status === "done"));
}

/**
 * 分段合成（38 号票）的接缝两边淡入淡出多久（毫秒）：守护进程把各段拼成完整音频、前端边收边播都用它，
 * 段的头尾不在零点上时接到静音不出爆音
 */
export const AGENT_VOICE_SEGMENT_FADE_MS = 5;

/** 一条消息里 agent 的语音 part 引用的 agent 语音对象（按出现的先后） */
export function agentVoiceIdsOf(parts: readonly MessagePart[]): string[] {
  return parts.flatMap((p) => (p.type === "tts_audio" ? [p.voiceId] : []));
}

/** 参考音色的录音：最短 1 秒、最长 30 秒（建议 5–15 秒干净的人声，drama 的经验是规范到 15 秒内） */
export const REFERENCE_VOICE_MIN_MS = 1_000;
export const REFERENCE_VOICE_MAX_MS = 30_000;
/** 参考音色录音文件的上限：20 MB（30 秒 48 kHz 双声道 16 位的 WAV 约 5.5 MB） */
export const REFERENCE_VOICE_MAX_BYTES = 20 * 1024 * 1024;
/** 参考音色的名字、逐字稿最长多少字 */
export const REFERENCE_VOICE_NAME_MAX = 40;
export const REFERENCE_VOICE_TEXT_MAX = 2_000;
