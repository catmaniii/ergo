// 语音消息（规格第 21、22 节，31 号票）对外的东西。别的模块只从这里取：
// - 守护进程装配：createVoiceService、voicesView（派生视图）、voiceMaterialSource（素材来源）、voicePurge（彻底删除的改写函数）、
//   设置里彻底删除一个范围时没有素材的语音（voicePurgeTargets）、
//   识别进程（createProcessRecognizer、unavailableRecognizer、RECOGNIZER_SCRIPT、RECOGNIZER_ENV）；
// - 会话和历史分页用的读取函数在 views.ts（voicesSettled、getVoice、voicesOfMessages），conversation/ 直接从那里取。
import { fileURLToPath } from "node:url";

export { createVoiceService, type VoiceService, voiceRetryNoticeKey } from "./voice.ts";
export { voicesView } from "./views.ts";
export { VOICE_TRANSCRIPT_CONTEXT, voiceMaterialSource, voicePurge, voicePurgeTargets } from "./material-source.ts";
export { createProcessRecognizer, type Recognizer, RecognizerUnavailable, unavailableRecognizer } from "./recognizer.ts";

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
