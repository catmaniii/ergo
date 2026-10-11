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
// 86 号票起 agent 在用户打字的那一轮也能用"发语音"工具发语音（mode 是 tool），显示和语音回复的一样；这一轮 agent 另写的文字照语音轮的规矩
// （用户 2026-10-11 定"只出气泡、文字收进去"）：发语音之前写的照常流式显示（那时还不知道要发语音）；调用之后（语音对象建出来）到这一轮结束，
// 和"还在回复"一样不显示这一轮 agent 的文字、不显示正在生成的回复——合成中是"正在合成语音…"（第一段到了换成合成中的气泡），合成好了、
// 这一轮还没结束是"正在回复…"；回合结束时守护进程定（coversReply）：普通的话收进气泡（长按"转文字"接在原文后面），有代码、表格、
// 链接这类念不出来的照常显示。没合成出来、只合成了一部分的，文字照常显示。
// "收着"（协议包的 agentVoiceHoldsTurn，和 agentVoiceCoversReply 共用）只到下一轮开始为止（实时收到的下一个 turn_start，UiState.turnStarts）：
// 守护进程回合结束时马上定 coversReply，正常不会跨轮；万一这一版没到（守护进程在这之前停了），下一轮的回复照常显示。
// 87 号票：发出了气泡的那次"发语音"调用不在聊天里单独显示（toolVoiceCalls 给出是哪几次，会话条目层把它挂在气泡上，气泡的详情里看）。
import { agentVoiceCoversReply, agentVoiceHoldsTurn, type AgentVoiceRecord, type ConversationId, type MessageEnvelope, type MessagePart, voiceDurationLabel } from "./protocol.ts";
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

/**
 * agent 语音 part 的气泡。工具发的（86 号票）定了把这一轮另写的文字收进来的，"转文字"在送进 TTS 的原文后面接上那几句（按先后，空行隔开）
 */
export function agentVoiceBubble(state: UiState, part: TtsAudioPart): AgentVoiceBubble {
  const voice = agentVoiceOf(state, part.voiceId);
  return bubbleOf(voice, part.durationMs, voice && coveredReplyText(state, voice));
}

function bubbleOf(voice: AgentVoiceRecord | undefined, durationMs: number, covered?: string): AgentVoiceBubble {
  const text = [voice?.text?.trim() ? voice.text : undefined, covered].filter((t): t is string => t !== undefined);
  return {
    duration: voiceDurationLabel(durationMs),
    width: voiceBubbleWidth(durationMs),
    text: text.length > 0 ? text.join("\n\n") : undefined,
    mode: voice?.mode,
  };
}

/** 工具发的语音收进气泡的、这一轮 agent 另写的文字（86 号票；没收的、手里没有那几条消息的是 undefined） */
function coveredReplyText(state: UiState, voice: AgentVoiceRecord): string | undefined {
  if (voice.mode !== "tool" || !agentVoiceCoversReply(voice)) return undefined;
  const ids = new Set(voice.replyMessageIds);
  const texts = (state.conversations[voice.conversation]?.messages ?? []).flatMap((entry) =>
    "message" in entry && ids.has(entry.message.id) ? entry.message.parts.flatMap((p) => (p.type === "text" && p.text.trim() ? [p.text.trim()] : [])) : [],
  );
  return texts.length > 0 ? texts.join("\n\n") : undefined;
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

/** 工具发的语音发出了气泡（87 号票）：合成好了、只发出去了一部分；还在合成的气泡马上就来，也算（没合成出来时才不算） */
const SENT_OR_SENDING: ReadonlySet<AgentVoiceRecord["status"]> = new Set(["synthesizing", "done", "partial"]);

/**
 * 这个会话里"发语音"工具（86 号票）的哪几次调用发出了语音气泡（87 号票）：工具调用 id → 那条 agent 语音的 id。
 * 按语音对象上记的工具调用 id（toolCallId）对上；没合成出来的、没建出语音的（太长、没有参考音色、语音轮里调用……）不在里面。
 * 会话条目层据此不单独显示这几次调用（不算进"调用了 N 个工具"、缩小后不画），把它们挂在发出的气泡上
 */
export function toolVoiceCalls(state: UiState, conversation: ConversationId): ReadonlyMap<string, string> {
  return new Map(voicesIn(state, conversation).flatMap((v) => (v.mode === "tool" && v.toolCallId !== undefined && SENT_OR_SENDING.has(v.status) ? [[v.toolCallId, v.id] as const] : [])));
}

/**
 * 收着这一轮文字的 agent 语音收着哪一段（协议包的 agentVoiceHoldsTurn）：这一轮开始（turnSeq）之后、下一轮开始（实时收到的
 * 下一个 turn_start，86 号票）之前；还没收到下一轮开始的，until 是 undefined（此刻还收着）。不收着的、没有 turnSeq 的是 undefined
 */
function heldRange(state: UiState, voice: AgentVoiceRecord): { since: number; until: number | undefined } | undefined {
  if (!agentVoiceHoldsTurn(voice) || voice.turnSeq === undefined) return undefined;
  const since = voice.turnSeq;
  return { since, until: state.turnStarts[voice.conversation]?.find((seq) => seq > since) };
}

/** 这条 agent 语音此刻还收着它这一轮的文字吗（这一轮还没被下一轮开始截断） */
function holdsNow(state: UiState, voice: AgentVoiceRecord): boolean {
  return agentVoiceHoldsTurn(voice) && (voice.turnSeq === undefined || heldRange(state, voice)?.until === undefined);
}

/** 这个会话里有没有 agent 语音此刻收着它这一轮的文字（时间线据此不显示正在生成的回复） */
export function agentVoiceHoldsReplies(state: UiState, conversation: ConversationId): boolean {
  return voicesIn(state, conversation).some((v) => holdsNow(state, v));
}

/**
 * 这个会话里一条权威消息的文字收进语音了吗（不显示）：整段合成、正在合成或合成好的语音对应的回复，工具发的定了收进去的；
 * 还在回复的那一轮里 agent 发的消息（这一轮开始之后、下一轮开始之前的），工具发的这一轮还没结束时也是
 */
export function replyCoverage(state: UiState, conversation: ConversationId): (entry: { seq: number; message: MessageEnvelope }) => boolean {
  const covered = new Set<string>();
  const held: Array<{ since: number; until: number | undefined }> = [];
  for (const voice of voicesIn(state, conversation)) {
    const range = heldRange(state, voice);
    if (range) held.push(range);
    else if (!agentVoiceHoldsTurn(voice) && agentVoiceCoversReply(voice)) for (const id of voice.replyMessageIds) covered.add(id);
  }
  const inHeld = (seq: number) => held.some((r) => seq > r.since && (r.until === undefined || seq < r.until));
  return ({ seq, message }) => covered.has(message.id) || (message.speaker === "agent" && inHeld(seq));
}

/**
 * 这个会话里 agent 语音此刻在哪一步（会话末尾的提示）：还在回复（"正在回复…"，回复的文字不流式显示；工具发的合成好了、
 * 这一轮还没结束也是）、在准备口语稿或合成、还没有段到（"正在合成语音…"；有段到了的显示成合成中的语音气泡）；都没有是 undefined
 */
export function agentVoicePhase(state: UiState, conversation: ConversationId): "replying" | "synthesizing" | undefined {
  const voices = voicesIn(state, conversation);
  // 还在回复的照旧；工具发的合成好了、这一轮还没结束（没被下一轮开始截断）也是
  if (voices.some((v) => v.status === "replying" || (v.mode === "tool" && v.status === "done" && holdsNow(state, v)))) return "replying";
  if (voices.some((v) => v.status === "summarizing" || (v.status === "synthesizing" && !agentVoiceAudible(v)))) return "synthesizing";
  return undefined;
}
