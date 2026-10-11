// agent 发的语音（规格第 22 节，32 号票）：用户发语音时，agent 这一轮的回复由运行时合成语音，在 agent 一侧显示成和用户语音一样的气泡。
// 每条 agent 语音（AgentVoiceRecord）跟着会话频道上的 agent_voice 事件走（ui-state.ts 按版本归并进 UiState.agentVoices），
// 气泡要的东西从这里取：时长和宽度、"转文字"展开的送进 TTS 的原文（不默认展开）。
// 用户 2026-10-08 定的显示：
// - 这一轮还在回复（replying）：不流式显示回复的文字，这一轮 agent 发的消息也不显示文字，会话末尾只显示"正在回复…"；
// - 整段合成的（回复短）：合成中显示"正在合成语音…"，合成好只出语音气泡——那几条回复的文字收进语音里，长按"转文字"才看；
// - 口语总结的（回复长）：回合结束后文字和附件照常显示，合成好再加一条语音气泡；
// - 没合成出来、最后没用语音的：文字照常显示（没合成出来的会话里另有一条说明）。
// 往上翻取回的历史、断线重连补发的都按同一套规则（语音对象随页、随补发的事件到来）。
// 38 号票起分段合成：合成好一段推一段（语音对象的新版本带着已合成的段）。第一段到了就在会话末尾出 agent 的语音气泡
// （streamingAgentVoices，时长随已到的段增长、标"合成中"），不再显示"正在合成语音…"；合成完了换成载着完整音频的那条消息。
// 一条 agent 语音此刻交给播放器什么（边收边播的段、完整音频，还是没有能播的——推过的段被收回了也是这样）由
// agentVoicePlayback 给出，从头播时播什么由 playbackSource 给出；页面上只负责把它们转给播放器。
// 合成到一半没合成下去的（partial）：推出去的段拼成一条，同样有语音消息，回复的文字照常显示（整段合成的也补出来）。
import { agentVoiceCoversReply, type AgentVoiceRecord, type ConversationId, type MessageEnvelope, type MessagePart, voiceDurationLabel } from "./protocol.ts";
import type { UiState } from "./ui-state.ts";
import { BASE_VOICE_BAR, type VoiceBarSizes, voiceBubbleWidth, type VoiceBubbleLook, voiceWidthIn } from "./voice.ts";

type TtsAudioPart = Extract<MessagePart, { type: "tts_audio" }>;

/** agent 发的一条语音的最新状态（还没收到是 undefined） */
export function agentVoiceOf(state: UiState, voiceId: string): AgentVoiceRecord | undefined {
  return state.agentVoices[voiceId];
}

export interface AgentVoiceBubble {
  /** 时长的说法（5″） */
  duration: string;
  width: number;
  /** 送进 TTS 的原文（"转文字"展开它、"复制文字"复制它）；还没收到这条语音对象时没有 */
  text: string | undefined;
  /** 整段回复还是口语总结 */
  mode: AgentVoiceRecord["mode"] | undefined;
}

/** agent 语音 part 的气泡 */
export function agentVoiceBubble(state: UiState, part: TtsAudioPart): AgentVoiceBubble {
  return bubbleOf(agentVoiceOf(state, part.voiceId), part.durationMs);
}

function bubbleOf(voice: AgentVoiceRecord | undefined, durationMs: number): AgentVoiceBubble {
  return {
    duration: voiceDurationLabel(durationMs),
    width: voiceBubbleWidth(durationMs),
    text: voice?.text?.trim() ? voice.text : undefined,
    mode: voice?.mode,
  };
}

/** 已经到了的段一共多长（最后一段的起点加它的时长；还没有段是 0） */
function arrivedMs(voice: AgentVoiceRecord): number {
  const last = voice.segments?.at(-1);
  return last === undefined ? 0 : last.offsetMs + last.durationMs;
}

/**
 * 这个会话里正在分段合成、已经有段到了的 agent 语音（38 号票），按建出的先后：会话末尾显示成"合成中"的语音气泡，
 * 合成完了（完成或者只合成了一部分）换成载着完整音频的那条消息
 */
export function streamingAgentVoices(state: UiState, conversation: ConversationId): AgentVoiceRecord[] {
  return voicesIn(state, conversation).filter((v) => v.status === "synthesizing" && (v.segments?.length ?? 0) > 0);
}

/** 正在分段合成的 agent 语音的气泡：时长是已经到了的段 */
export function streamingAgentVoiceBubble(voice: AgentVoiceRecord): AgentVoiceBubble {
  return bubbleOf(voice, arrivedMs(voice));
}

/** 播放器要的地址怎么拼（页面上是 DaemonHttp 的两个方法；原型里没有真语音时为 undefined） */
export interface AgentVoiceUrls {
  /** 分段合成里第 index 段的音频 */
  segment(voiceId: string, index: number): string | undefined;
  /** 完整音频（入库的媒体） */
  media(mediaId: string): string | undefined;
}

/** 边收边播的一段：音频的地址、在整条里从第几毫秒起、多长 */
export interface PlayableSegment {
  readonly url: string;
  readonly offsetMs: number;
  readonly durationMs: number;
}

/** 边收边播：已经到了的段（按先后），段到齐了没有（合成完了，或者没合成下去） */
export interface SegmentStream {
  readonly segments: readonly PlayableSegment[];
  readonly complete: boolean;
}

/**
 * 一条 agent 语音此刻交给播放器的（38 号票）：
 * - none：没有能播的（还在回复、在准备口语稿、合成中还没有段、推过的段被守护进程重启收回了、一段都没合成出来就失败了）——
 *   播放器里在播的这一条停掉、放开，排着的拿掉；
 * - stream：分段合成的，边收边播已经到了的段；合成好了（完成、只合成了一部分）还带完整音频的地址 file；
 * - file：只有完整音频（只有一段的，不推段）
 */
export type AgentVoicePlayback =
  | { kind: "none" }
  | { kind: "stream"; stream: SegmentStream; file: string | undefined }
  | { kind: "file"; file: string };

/** 这条 agent 语音此刻交给播放器的（地址拼不出来的当没有） */
export function agentVoicePlayback(voice: AgentVoiceRecord, urls: AgentVoiceUrls): AgentVoicePlayback {
  const file = voice.mediaId === undefined ? undefined : urls.media(voice.mediaId);
  const segments = (voice.segments ?? []).flatMap((s, index) => {
    const url = urls.segment(voice.id, index);
    return url === undefined ? [] : [{ url, offsetMs: s.offsetMs, durationMs: s.durationMs }];
  });
  if (segments.length > 0 && segments.length === voice.segments?.length) return { kind: "stream", stream: { segments, complete: voice.status !== "synthesizing" }, file };
  return file === undefined ? { kind: "none" } : { kind: "file", file };
}

/** 从头播放时播什么：合成好了的播完整音频（地址），还在合成的边收边播；没有能播的是 undefined */
export function playbackSource(playback: AgentVoicePlayback): string | SegmentStream | undefined {
  if (playback.kind === "none") return undefined;
  if (playback.kind === "file") return playback.file;
  return playback.file ?? playback.stream;
}

/** 这条 agent 语音有能播的音频了吗：到了至少一段，或者合成好了 */
export function agentVoiceAudible(voice: AgentVoiceRecord | undefined): boolean {
  return voice !== undefined && ((voice.segments?.length ?? 0) > 0 || voice.mediaId !== undefined);
}

/** agent 语音气泡框的样子：框的那部分（VoiceBubbleLook），加上菜单里展开 / 收起文字的那一项 */
export interface AgentVoiceBubbleLook extends VoiceBubbleLook {
  /** 菜单里的"转文字"（收起时）或"收起文字"（展开时）；还没有原文时不能点 */
  textToggle: { label: "转文字" | "收起文字"; enabled: boolean };
}

/**
 * agent 发的语音（36 号票）：默认框里只有播放条和时长；长按"转文字"展开（expanded）后，送进 TTS 的原文在框里播放条下面，
 * 再点"收起文字"收起。口语总结的展开的是总结的原文（完整回复照常是单独的文字消息）
 */
export function agentVoiceBubbleLook(bubble: AgentVoiceBubble, expanded: boolean, sizes: VoiceBarSizes = BASE_VOICE_BAR): AgentVoiceBubbleLook {
  const text = expanded ? bubble.text : undefined;
  // 宽度按这套风格的播放条尺寸（42 号票，voiceWidthIn；不传是经典的）
  const width = voiceWidthIn(bubble.width, sizes);
  return {
    body: text === undefined ? undefined : { kind: "text", text },
    width: text === undefined ? { exact: width } : { min: width },
    textToggle: { label: text === undefined ? "转文字" : "收起文字", enabled: bubble.text !== undefined },
  };
}

function voicesIn(state: UiState, conversation: ConversationId): AgentVoiceRecord[] {
  return Object.values(state.agentVoices).filter((v) => v.conversation === conversation);
}

/**
 * 这个会话里一条权威消息的文字收进语音了吗（不显示）：整段合成、正在合成或合成好的语音对应的回复；
 * 还在回复的那一轮里 agent 发的消息（这一轮开始之后的）
 */
export function replyCoverage(state: UiState, conversation: ConversationId): (entry: { seq: number; message: MessageEnvelope }) => boolean {
  const covered = new Set<string>();
  const replyingSince: number[] = [];
  for (const voice of voicesIn(state, conversation)) {
    if (!agentVoiceCoversReply(voice)) continue;
    if (voice.status === "replying") {
      if (voice.turnSeq !== undefined) replyingSince.push(voice.turnSeq);
    } else {
      for (const id of voice.replyMessageIds) covered.add(id);
    }
  }
  const since = replyingSince.length > 0 ? Math.min(...replyingSince) : undefined;
  return ({ seq, message }) => covered.has(message.id) || (since !== undefined && message.speaker === "agent" && seq > since);
}

/**
 * 这个会话里 agent 语音此刻在哪一步（会话末尾的提示）：还在回复（"正在回复…"，回复的文字不流式显示）、
 * 在准备口语稿或合成、还没有段到（"正在合成语音…"；有段到了的显示成合成中的语音气泡）；都没有是 undefined
 */
export function agentVoicePhase(state: UiState, conversation: ConversationId): "replying" | "synthesizing" | undefined {
  const voices = voicesIn(state, conversation);
  if (voices.some((v) => v.status === "replying")) return "replying";
  if (voices.some((v) => v.status === "summarizing" || (v.status === "synthesizing" && !agentVoiceAudible(v)))) return "synthesizing";
  return undefined;
}
