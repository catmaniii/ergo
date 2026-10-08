// 语音消息的 schema（规格第 22 节，31 号票）：一条语音 = 一个数据对象，音频和它的文字绑在一起。
// 消息里的语音 part（schema.ts 的 VoicePart）只引用它（voiceId）并带上画气泡要的时长和波形；
// 识别的结果和识别状态在 VoiceRecord 里，随会话频道上的 voice 事件更新。
// （用户 2026-10-08 改：第一阶段不用大模型修正，识别出的文字就是 faster-whisper 的结果。）
import { type Static, Type } from "typebox";
import { ConversationId, VoiceDurationMs, VoiceWaveform } from "./schema.ts";
import { VOICE_STATUSES } from "./voice.ts";

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
