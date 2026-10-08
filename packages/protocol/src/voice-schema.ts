// 语音消息的 schema（规格第 22 节，31 号票）：一条语音 = 一个数据对象，音频和它的文字绑在一起。
// 消息里的语音 part（schema.ts 的 VoicePart）只引用它（voiceId）并带上画气泡要的时长和波形；
// 识别的结果和识别状态在 VoiceRecord 里，随会话频道上的 voice 事件更新。
// （用户 2026-10-08 改：第一阶段不用大模型修正，识别出的文字就是 faster-whisper 的结果。）
import { type Static, Type } from "typebox";
import { ConversationId, MessageScope, VoiceCapture, VoiceDurationMs, VoiceWaveform } from "./schema.ts";
import { AGENT_VOICE_MODES, AGENT_VOICE_STATUSES, REFERENCE_VOICE_NAME_MAX, REFERENCE_VOICE_TEXT_MAX, VOICE_STATUSES } from "./voice.ts";

/** faster-whisper 给出的一段：起止时间（秒）和这段的原文 */
export const VoiceSegment = Type.Object({ start: Type.Number(), end: Type.Number(), text: Type.String() });
export type VoiceSegment = Static<typeof VoiceSegment>;

/** faster-whisper 直接识别的结果 */
export const VoiceRecognition = Type.Object({
  /** 识别出的文字 */
  text: Type.String(),
  /** 识别出的语言（比如 zh） */
  language: Type.String(),
  segments: Type.Array(VoiceSegment),
  /** 实际用的模型、设备、计算精度（显卡不可用或显存不够时退回 CPU，记的是退回后的） */
  model: Type.String(),
  device: Type.String(),
  computeType: Type.String(),
  /** 退回 CPU 的原因（没退回没有） */
  fallbackReason: Type.Optional(Type.String()),
  /** 识别进程量出的音频时长（秒） */
  audioSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  /** 从开始识别到出结果花了多久（毫秒；含拉起识别进程、加载模型） */
  elapsedMs: Type.Integer({ minimum: 0 }),
  time: Type.String(),
});
export type VoiceRecognition = Static<typeof VoiceRecognition>;

export const VoiceStatus = Type.Enum(VOICE_STATUSES);
export type VoiceStatus = Static<typeof VoiceStatus>;

/** 一条语音（用户发的）：音频、时长、格式、波形摘要、识别出的文字、识别状态 */
export const VoiceRecord = Type.Object({
  id: Type.String(),
  /** 发这条语音的消息 */
  messageId: Type.String(),
  conversation: ConversationId,
  /** 消息所属的任务、项目（维护者会话里的；素材的"任务或项目"取自这里） */
  taskId: Type.Optional(Type.String()),
  projectId: Type.Optional(Type.String()),
  /** 音频：入库的媒体（按内容哈希） */
  mediaId: Type.String(),
  /** 格式：服务端按内容认出的音频类型（audio/webm、audio/mp4……） */
  mime: Type.String(),
  durationMs: VoiceDurationMs,
  waveform: VoiceWaveform,
  status: VoiceStatus,
  /** 第几次识别（重新识别加 1） */
  attempt: Type.Integer({ minimum: 1 }),
  recognition: Type.Optional(VoiceRecognition),
  /** 识别失败的原因 */
  error: Type.Optional(Type.String()),
  /**
   * 录音的诊断（37 号票）：前端随语音带来的"按下 → 录音器真正开始"的毫秒数（整数）和是不是预热命中；
   * 前端没带（旧版本）、带的不合理时没有。本机的历史分页接口（GET /api/conversations/<会话>/messages 的 voices）取得到
   */
  capture: Type.Optional(VoiceCapture),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  /** 每次变化加 1 */
  version: Type.Integer({ minimum: 1 }),
});
export type VoiceRecord = Static<typeof VoiceRecord>;

/** `voice` 事件（会话频道上）：一条语音的最新状态（建出、开始识别、识别完成或失败、重新识别） */
export const VoiceEventPayload = Type.Object({ voice: VoiceRecord });
export type VoiceEventPayload = Static<typeof VoiceEventPayload>;

/** 气泡菜单里的"重新识别"：只有识别失败的能重新识别 */
export const RetryVoiceParams = Type.Object({ voiceId: Type.String({ minLength: 1 }) });
export type RetryVoiceParams = Static<typeof RetryVoiceParams>;

/** 重新识别的结果：这条语音的新版本（随后在会话频道推送） */
export const RetryVoiceResult = Type.Object({ voiceId: Type.String(), version: Type.Integer({ minimum: 1 }) });
export type RetryVoiceResult = Static<typeof RetryVoiceResult>;

// ───────────────────────── agent 发的语音（32 号票） ─────────────────────────

export const AgentVoiceStatus = Type.Enum(AGENT_VOICE_STATUSES);
export type AgentVoiceStatus = Static<typeof AgentVoiceStatus>;

export const AgentVoiceMode = Type.Enum(AGENT_VOICE_MODES);
export type AgentVoiceMode = Static<typeof AgentVoiceMode>;

/**
 * agent 发的一条语音（语音回复）：用户发语音时，agent 这一轮的回复由运行时合成语音。
 * 绑定音频（入库的媒体，按内容哈希）、时长、送进 TTS 的原文、所用参考音色、TTS 模型，以及对应的完整回复在哪几条消息里
 */
export const AgentVoiceRecord = Type.Object({
  id: Type.String(),
  conversation: ConversationId,
  /** 这条语音所在的消息（和 agent 的回复一样）带上的归属：任务、项目、阶段…… */
  scope: MessageScope,
  /** 这一轮回复的是用户的哪条语音（或者重新识别后交给 agent 的那条通知） */
  inputMessageId: Type.String(),
  /**
   * 这一轮开始（turn_start 事件）在会话频道上的序号：回复还没定（replying）时，这之后 agent 发的消息都算这一轮的回复
   * （前端据此不显示它们的文字）；回合结束时 agent 用语音回复的那一轮才有（插话里有语音的、回合结束时才知道的没有）
   */
  turnSeq: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 对应的完整回复：agent 这一轮发出的文字、图片、文件、卡片所在的消息，按先后（回合结束时定；agent 只写了口语总结时可以为空） */
  replyMessageIds: Type.Array(Type.String()),
  /** 送进 TTS 的是整段回复，还是口语总结（回合结束时定） */
  mode: Type.Optional(AgentVoiceMode),
  /**
   * 口语总结是谁写的：agent 用工具写的（这一轮里写的，或者运行时追问后补写的），或者追问了还没写、运行时从回复开头截的
   * （只有 summary 有，口语稿定了才有）
   */
  summaryBy: Type.Optional(Type.Enum(["agent", "runtime"])),
  /** 送进 TTS 的原文（"转文字"展开的就是它；口语稿定了才有） */
  text: Type.Optional(Type.String()),
  /** 所用的参考音色：id 和当时的显示名（回合结束时定） */
  referenceVoice: Type.Optional(Type.Object({ id: Type.String(), name: Type.String() })),
  /** TTS 模型：合成服务报出来的实际模型（比如 fish_audio（audio.cpp/tts）），报不出来时是配置里写的模型名（合成时定） */
  model: Type.Optional(Type.String()),
  status: AgentVoiceStatus,
  /** 合成出的音频：入库的媒体（按内容哈希）、格式、时长、波形摘要（合成完成才有） */
  mediaId: Type.Optional(Type.String()),
  mime: Type.Optional(Type.String()),
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  waveform: Type.Optional(VoiceWaveform),
  /** 载着这条语音的消息（合成完成时追加的那条） */
  messageId: Type.Optional(Type.String()),
  /** 从开始合成到出结果花了多久（毫秒；含 audio.cpp 第一次用到时加载模型） */
  elapsedMs: Type.Optional(Type.Integer({ minimum: 0 })),
  /** 合成失败的原因，或者最后没用语音回复的原因 */
  error: Type.Optional(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  /** 每次变化加 1 */
  version: Type.Integer({ minimum: 1 }),
});
export type AgentVoiceRecord = Static<typeof AgentVoiceRecord>;

/** `agent_voice` 事件（会话频道上）：agent 的一条语音的最新状态（这一轮开始、回合结束、合成完成或失败……见 AGENT_VOICE_STATUSES） */
export const AgentVoiceEventPayload = Type.Object({ voice: AgentVoiceRecord });
export type AgentVoiceEventPayload = Static<typeof AgentVoiceEventPayload>;

// ───────────────────────── 参考音色（32 号票，设置里的语音页） ─────────────────────────

/** 一个参考音色（个人数据，存在数据目录的 voices 区，目录和文件用英文 id 命名，显示名另存） */
export const ReferenceVoice = Type.Object({
  id: Type.String(),
  name: Type.String(),
  /** 参考录音的逐字稿 */
  referenceText: Type.String(),
  durationMs: Type.Integer({ minimum: 0 }),
  /** 参考录音的 sha256 */
  sha256: Type.String(),
  importedAt: Type.String(),
});
export type ReferenceVoice = Static<typeof ReferenceVoice>;

/** 设置页的参考音色列表：按导入的先后；current 是语音回复现在用哪一个（没选过时，只有一个就是它） */
export const ReferenceVoiceList = Type.Object({
  voices: Type.Array(ReferenceVoice),
  currentId: Type.Optional(Type.String()),
});
export type ReferenceVoiceList = Static<typeof ReferenceVoiceList>;

/** 导入一个参考音色：名字、逐字稿、WAV 录音（base64） */
export const ImportReferenceVoiceBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: REFERENCE_VOICE_NAME_MAX }),
  referenceText: Type.String({ minLength: 1, maxLength: REFERENCE_VOICE_TEXT_MAX }),
  /** WAV 文件的内容，base64 */
  audioBase64: Type.String({ minLength: 1 }),
});
export type ImportReferenceVoiceBody = Static<typeof ImportReferenceVoiceBody>;
