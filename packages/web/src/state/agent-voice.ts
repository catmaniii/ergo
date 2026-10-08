// agent 发的语音（规格第 22 节，32 号票）：用户发语音时，agent 这一轮的回复由运行时合成语音，在 agent 一侧显示成和用户语音一样的气泡。
// 每条 agent 语音（AgentVoiceRecord）跟着会话频道上的 agent_voice 事件走（ui-state.ts 按版本归并进 UiState.agentVoices），
// 气泡要的东西从这里取：时长和宽度、"转文字"展开的送进 TTS 的原文（不默认展开）。
// 用户 2026-10-08 定的显示：
// - 这一轮还在回复（replying）：不流式显示回复的文字，这一轮 agent 发的消息也不显示文字，会话末尾只显示"正在回复…"；
// - 整段合成的（回复短）：合成中显示"正在合成语音…"，合成好只出语音气泡——那几条回复的文字收进语音里，长按"转文字"才看；
// - 口语总结的（回复长）：回合结束后文字和附件照常显示，合成好再加一条语音气泡；
// - 没合成出来、最后没用语音的：文字照常显示（没合成出来的会话里另有一条说明）。
// 往上翻取回的历史、断线重连补发的都按同一套规则（语音对象随页、随补发的事件到来）。
import { agentVoiceCoversReply, type AgentVoiceRecord, type ConversationId, type MessageEnvelope, type MessagePart, voiceDurationLabel } from "./protocol.ts";
import type { UiState } from "./ui-state.ts";
import { voiceBubbleWidth } from "./voice.ts";

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
  const voice = agentVoiceOf(state, part.voiceId);
  return {
    duration: voiceDurationLabel(part.durationMs),
    width: voiceBubbleWidth(part.durationMs),
    text: voice?.text?.trim() ? voice.text : undefined,
    mode: voice?.mode,
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
 * 在准备口语稿或合成（"正在合成语音…"）；都没有是 undefined
 */
export function agentVoicePhase(state: UiState, conversation: ConversationId): "replying" | "synthesizing" | undefined {
  const voices = voicesIn(state, conversation);
  if (voices.some((v) => v.status === "replying")) return "replying";
  if (voices.some((v) => v.status === "summarizing" || v.status === "synthesizing")) return "synthesizing";
  return undefined;
}
