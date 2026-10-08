// agent 用语音回复（32 号票）给模型和给人看的话，都在这里组织（编排在 voice-reply.ts，只给结构化的数据）：
// 交给 agent 的语音输入后面跟的说明、口语总结工具的说明和结果、回复长又没写总结时追问的那句、运行时兜底截的总结最后那句、
// 退回只发文字时会话里的说明、最后没用语音的原因、"还没有参考音色"的待我处理事项。
import { VOICE_REFERENCE_IMPORT_ACTION } from "@ergou/protocol";
import type { SpokenPace } from "./spoken-text.ts";

/** agent 写口语总结的工具，和它在调用记录里的名字 */
export const SPOKEN_SUMMARY_TOOL = "spoken_summary";
export const SPOKEN_SUMMARY_TITLE = "口语总结";

/** 大约多少个字念得完 */
const charsOf = (pace: SpokenPace) => Math.round(pace.maxSeconds * pace.charsPerSecond);

/** 交给 agent 的语音输入后面跟的说明（输入后面的上下文消息，不改系统提示） */
export function voiceInputContext(pace: SpokenPace): string {
  return (
    "[运行时说明] 用户这条是语音。你这次的回复会由运行时合成语音发给用户（用户在设置里选的参考音色）。照常回复；" +
    `回复长（念出来超过约 ${pace.maxSeconds} 秒，大约 ${charsOf(pace)} 个字）或者有代码、表格、链接这类念不出来的内容时，` +
    `另外调用 ${SPOKEN_SUMMARY_TOOL} 工具写一段 ${pace.maxSeconds} 秒内念得完、适合听的口语总结（像说话一样，不用 Markdown），` +
    "运行时合成它，详细内容照常用文字和附件发。回复短的不用写。"
  );
}

/** 口语总结工具的说明 */
export function spokenSummaryToolDescription(pace: SpokenPace): string {
  return (
    `用户发的是语音、你的回复会由运行时合成语音时用：回复太长（念出来超过约 ${pace.maxSeconds} 秒）或者有代码、表格、链接这类念不出来的内容时，` +
    `写一段 ${pace.maxSeconds} 秒内念得完、适合听的口语总结（像说话一样，不用 Markdown），运行时把它合成语音发给用户，详细内容照常用文字和附件发。回复短的不用调。`
  );
}

/** 口语总结工具参数的说明 */
export const SPOKEN_SUMMARY_PARAM = "要念给用户听的口语总结";

/** 口语总结工具的结果：记下了 */
export const SPOKEN_SUMMARY_TAKEN = "记下了。回复长的话，运行时把这段口语总结合成语音发给用户；回复短的整段合成，这段不用。详细内容照常用文字和附件发。";

/** 口语总结工具的结果：这一轮不用语音回复 */
export const SPOKEN_SUMMARY_NOT_NEEDED = "用户这次发的不是语音，回复不会合成语音，不用写口语总结。";

/** 回复长、agent 又没写口语总结时，运行时追问它的那句（这一次不算新回复，它写的文字不出现在聊天里） */
export function summaryFollowUpText(pace: SpokenPace): string {
  return (
    `[运行时说明] 你刚才的回复要合成语音发给用户，但它太长（或者有念不出来的内容）。请调用 ${SPOKEN_SUMMARY_TOOL} 工具，` +
    `给刚才的回复写一段 ${pace.maxSeconds} 秒内念得完（大约 ${charsOf(pace)} 个字以内）、适合听的口语总结。只调用这个工具，不用再回复别的，用户看不到你这次写的文字。`
  );
}

/** 运行时兜底截的口语总结最后加的一句（追问了 agent 还是没写总结时） */
export const RUNTIME_SUMMARY_TAIL = "详细内容我发在聊天里了。";

/** 没合成出来，退回只发文字时会话里的说明 */
export function synthesisFailedNote(reason: string): string {
  return `语音没合成出来（${reason}），这次只发文字。`;
}

/** 语音服务忙（显卡在给别的任务用、或者服务说忙）时的原因：不等超时，直接退回只发文字 */
export const SPEECH_BUSY = "语音服务忙";

/** 最后没用语音回复的原因（记在 agent 语音对象上） */
export const SKIPPED = {
  turnNotCompleted: (outcome: string) => `这一轮没有回复完（${outcome}）`,
  lastInputNotVoice: "用户这一轮最后说的一句不是语音",
  nothingToSay: "这一轮没有要念的文字",
  noReference: "没有参考音色",
  restarted: "守护进程重启时这一轮还没回复完",
} as const;

/** 服务回的不是 WAV 时的原因 */
export const NOT_WAV = "语音合成服务回的不是能播放的 WAV";

/** 合成好的音频存不进去时的原因 */
export function storeFailedReason(detail: string): string {
  return `合成出的语音存不进去：${detail}`;
}

/** 参考音色被删了 */
export function referenceGoneReason(name: string): string {
  return `参考音色「${name}」不在了`;
}

/** "还没有参考音色"的待我处理事项 */
export const MISSING_REFERENCE_NOTICE = {
  title: "还没有参考音色，语音回复只发了文字",
  body: "你发了语音，agent 本来要用语音回复，但设置里还没有导入参考音色，这次只发了文字。去设置里的语音页导入一段干净的人声录音（WAV，5–15 秒）和它的逐字稿，之后就用这个声音回复。导入后这条自动归档。",
  source: "语音回复",
  actions: [VOICE_REFERENCE_IMPORT_ACTION, "知道了"],
} as const;
