// 语音插件（214 号票，plugin.ts）里几处共用的常量，和插件内部各模块的总览（插件之外只经 api.ts 拿语音插件的东西，
// 语音的数据契约——语音对象的视图、投影、素材来源、改写函数——在内核的 voice-records/）：
// - 语音消息（规格第 21、22 节，31、32 号票）：识别（voice.ts：收下语音 part、后台识别、重新识别、208 号票的自动重试）、
//   挡不挡输入队列（gate.ts：31、210 号票的规矩，经 VOICE.gate 回答内核的挡板）、识别进程（recognizer.ts、recognizer.py）；
// - 32 号票：参考音色（reference-voices.ts，设置里的语音页经 HTTP 用它）、agent 用语音回复（voice-reply.ts：跟着会话频道上的回合走，
//   经 audio.cpp 合成，speech.ts；给模型和人看的话在 texts.ts）；和 31 号票共用的版本、队列、开着只留一条的说明在 shared.ts；
// - 38 号票：分段合成（切段在 spoken-text.ts 的 speechSegments，拼接在 wav.ts，段的临时文件在 segment-files.ts，
//   都在 voice-reply.ts 里用，86 号票起在 voice-synthesis.ts）；HTTP 接口经 VOICE.segmentFile 取一段的文件；
// - 86 号票：用户打字时 agent 也能发语音（send-voice.ts 的发语音工具，随 createVoiceReplies 的 tools 一起给装配）；
//   口语稿定了之后的那一半（排队、分段合成、入库、追加消息、失败说明、重启重做）抽进 voice-synthesis.ts，语音回复和它共用；
// - 45 号票：模型预热（warmup.ts）：启动后先加载识别模型、再试合成一句让 audio.cpp 加载合成模型；识别进程常驻、意外退出后重拉；
//   合成服务后来才开的开了再预热。语音回复用它包过的合成（试合成在做时等它）；两个模型的状态经 VOICE.models 给本机接口，变了推给前端；
// - 124 号票：Debug 工具集的语音组（debug-voice.ts）：录一段送识别、用当前参考音色合成念一句，不经会话；
// - 180 号票：识别结果里剔掉模型自带的串词（transcript-filter.ts 的 compileStripRules 编译配置里的规则，交给识别进程的宿主）。
// 这里不再转出别的模块（214 号票之前内核从这里取，现在一律经 api.ts）。
import { fileURLToPath } from "node:url";
import { t } from "@ergo/protocol";
import type { RecognizeMode } from "../config/config.ts";

export { createHttpRecognizer, type HttpRecognizerOptions } from "./recognizer-client.ts";
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

/**
 * 识别不可用时，待我处理的说明里写的怎么修（173 号票：按当前语言现取）。250 号票起按接入方式分开：
 * 自己拉起的说 Python 和模型缓存，调 LSM 托管的那条说 LSM 里的服务开没开、配置里的地址对不对
 */
export const recognizerHint = (mode: RecognizeMode) => t(mode === "lsm" ? "voice.recognizer.lsmHint" : "voice.recognizer.hint");
