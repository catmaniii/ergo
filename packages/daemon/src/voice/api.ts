// 语音插件对外的接口（214 号票，ADR-0027，照提醒插件的 reminders/api.ts）：内核和别的插件只从这里拿语音插件的东西——服务名
// （经插件宿主按名字取：plugins.service(VOICE)，插件没启用、没装上时取到 undefined）和它的类型；不 import 语音插件的别的文件
// （test/voice/boundary.test.ts 检查，例外写在那里）。语音的数据契约（语音对象的视图、投影、素材来源、改写函数）在内核的 voice-records/，
// 插件停用了照样在，不经这里。
// - 内核用它的：组合根把语音回复、输入队列的挡板接进每个会话都配的那一份（conversation/session-tools.ts），本机接口（gateway/http-api.ts）
//   经它取设置 · 语音（参考音色、两个模型的状态）、分段合成的段、Debug 工具集的语音组；悬浮按钮上按住说的一段送识别（page-commands/page-voice.ts）
//   也经它（recognize）。发消息时收下语音 part、气泡菜单里的"重新识别"是插件在数据契约里登记的前端请求，不经这里。
// - 别的插件要用语音（比如 212 号票的内置浏览器：悬浮按钮上说话）：定义里 wants 写 VOICE，用的时候 ctx.optional(VOICE) 现取（不要存起来），
//   取到 undefined（语音插件停用了）给人看 voiceOffReason()。
import { type DebugRecognizeResult, type DebugSpeakResult, type MessageEnvelope, type RetryVoiceParams, type RetryVoiceResult, t, type VoiceModelsView } from "@ergo/protocol";
import type { AgentVoiceReplies } from "../conversation/agent-session.ts";
import type { InputGate } from "../conversation/input-gate.ts";
import type { VoiceIntake } from "../conversation/messages.ts";
import { serviceKey } from "../plugins/host.ts";
import type { ReferenceVoices } from "./reference-voices.ts";

export type { ReferenceVoiceOptions, ReferenceVoices, ResolvedReferenceVoice } from "./reference-voices.ts";
// 230 号票：导入参考音色时网关要按失败的种类回状态码（ffmpeg 不在、识别不可用回 503，转不了回 400）
export { AudioConvertError, type AudioConvertFailure, type AudioConverter, type ConvertedAudio } from "./audio-convert.ts";
export { ReferenceVoiceTranscribeFailed } from "./reference-voices.ts";
export { SEND_VOICE_TOOL } from "../voice-records/index.ts";

/** 语音插件提供的服务（插件在运行时才有；每次现取） */
export interface VoiceApi {
  /** 发消息时收下语音 part（插件在数据契约里登记成前端请求 voiceIntake） */
  readonly intake: VoiceIntake;
  /** 气泡菜单里的"重新识别"：只有识别失败的能重新识别（插件在数据契约里登记成前端请求 retryVoice） */
  retry(params: RetryVoiceParams, idempotencyKey: string): RetryVoiceResult;
  /** 输入队列的挡板（31、208、210 号票的规矩）：这条消息里的语音这时挡不挡 agent 的输入队列 */
  gate(message: Pick<MessageEnvelope, "parts">): InputGate;
  /** 语音回复（32、86 号票）：口语总结和发语音工具、用户发语音时跟在输入后面的说明、一轮完成之后的追问 */
  readonly replies: AgentVoiceReplies;
  /** 参考音色（设置 · 语音：导入、选用、删除、试听） */
  readonly referenceVoices: ReferenceVoices;
  /** 分段合成里合成好的一段的文件（前端边收边播）；没有是 undefined */
  segmentFile(voiceId: string, index: number): string | undefined;
  /** 识别模型、合成模型现在的状态（设置 · 语音；变了另经活动状态频道推 voice_models） */
  models(): VoiceModelsView;
  /** 录的一段送识别，不经会话（Debug 工具集；149 号票的悬浮按钮上说话）：识别不了不抛错，回原因 */
  recognize(audio: Buffer, mime: string): Promise<DebugRecognizeResult>;
  /** 用当前参考音色合成念一句，不经会话（Debug 工具集）：合成不了不抛错，回原因 */
  speak(text: string): Promise<DebugSpeakResult>;
  /** 识别、合成的队列都空了（测试用） */
  whenIdle(): Promise<void>;
}

/** 语音插件提供的服务 */
export const VOICE = serviceKey<VoiceApi>("voice");

/** 语音插件没在运行时给人看的那句："语音插件没启用"（跟着当前语言） */
export const voiceOffReason = () => t("plugins.notEnabled", { title: t("voice.plugin.title") });
