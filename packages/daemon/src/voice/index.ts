// 语音消息（规格第 21、22 节，31、32 号票）对外的东西。别的模块只从这里取：
// - 守护进程装配：createVoiceService、voicesView（派生视图）、voiceMaterialSource（素材来源）、voicePurge（彻底删除的改写函数）、
//   设置里彻底删除一个范围时没有素材的语音（voicePurgeTargets）、
//   识别进程（createProcessRecognizer、unavailableRecognizer、RECOGNIZER_SCRIPT、RECOGNIZER_ENV）；
// - 会话和历史分页用的读取函数在 views.ts（voicesSettled、getVoice、voicesOfMessages），conversation/ 直接从那里取；
// - 32 号票：参考音色（openReferenceVoices，设置里的语音页经 HTTP 用它）、agent 用语音回复（createVoiceReplies：
//   跟着会话频道上的回合走，经 audio.cpp 合成，createAudioCppSynthesizer；给模型和人看的话在 texts.ts）、
//   agent 语音对象的派生视图（agentVoicesView）；和 31 号票共用的版本、队列、开着只留一条的说明在 shared.ts；
//   历史分页用的 agentVoicesOfMessages 在 agent-voice-views.ts，conversation/ 直接从那里取。
// - 38 号票：分段合成（切段在 spoken-text.ts 的 speechSegments，拼接在 wav.ts，段的临时文件在 segment-files.ts，
//   都在 voice-reply.ts 里用）；HTTP 接口经 VoiceReplies.segmentFile 取一段的文件。
// - 45 号票：模型预热（createVoiceWarmup，warmup.ts）：启动后先加载识别模型、再试合成一句让 audio.cpp 加载合成模型；
//   识别进程常驻、意外退出后重拉；合成服务后来才开的开了再预热。语音回复用它包过的合成（试合成在做时等它）；
//   两个模型的状态经 VoiceWarmup.view 给本机接口，变了交给 onChange 推给前端。
import { fileURLToPath } from "node:url";

export { createVoiceService, type VoiceService, voiceRetryNoticeKey } from "./voice.ts";
export { voicesView } from "./views.ts";
export { VOICE_TRANSCRIPT_CONTEXT, voiceMaterialSource, voicePurge, voicePurgeTargets } from "./material-source.ts";
export { createProcessRecognizer, type Recognizer, RecognizerUnavailable, unavailableRecognizer } from "./recognizer.ts";
export { openReferenceVoices, type ReferenceVoices, type ResolvedReferenceVoice } from "./reference-voices.ts";
export { agentVoicesView } from "./agent-voice-views.ts";
export { createAudioCppSynthesizer, type SpeechSynthesizer } from "./speech.ts";
export { createVoiceWarmup, type VoiceWarmup } from "./warmup.ts";
export { createVoiceReplies, type VoiceReplies } from "./voice-reply.ts";
export { SPOKEN_SUMMARY_TOOL } from "./texts.ts";

/** 识别进程的 Python 脚本（随仓库分发；守护进程用配置里的 Python 跑它） */
export const RECOGNIZER_SCRIPT = fileURLToPath(new URL("./recognizer.py", import.meta.url));

/**
 * 识别进程的环境里，在系统变量白名单之外固定加的：模型只从 Hugging Face 的本机缓存加载（不联网下载、不报统计），
 * Python 的输入输出用 UTF-8
 */
export const RECOGNIZER_ENV: Readonly<Record<string, string>> = Object.freeze({
  HF_HUB_OFFLINE: "1",
  HF_HUB_DISABLE_TELEMETRY: "1",
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
});

/** 识别进程不可用时，待我处理的说明里写的怎么修 */
export const RECOGNIZER_HINT =
  "检查数据目录配置里的 voice.recognizer.python 是不是装了 faster-whisper 的 Python，模型（默认 large-v3，退回用的 small）在不在 Hugging Face 的本机缓存里。";
