// agent 用语音回复（32 号票）给模型和给人看的话，都在这里组织（编排在 voice-reply.ts，合成和失败说明在 86 号票抽出的 voice-synthesis.ts，只给结构化的数据）：
// 交给 agent 的语音输入后面跟的说明、口语总结工具的说明和结果、回复长又没写总结时追问的那句、运行时兜底截的总结最后那句、
// 退回只发文字时会话里的说明、最后没用语音的原因、"还没有参考音色"的待我处理事项；
// 45 号票：模型预热时合成模型的状态里给人看的说明（设置 · 语音里显示，编排在 warmup.ts）；
// 86 号票：用户打字时 agent 发语音的工具（send_voice）的说明、参数、结果，和没有参考音色时的待我处理事项（编排在 send-voice.ts）。
// 173 号票：给模型看的（交给 agent 的说明、工具说明和结果）标 @i18n-ignore model；给人看的（工具的名字、会话里的说明、没用语音的原因、
// 待我处理事项、预热状态、兜底总结最后那句）走 t()，生成时按当时的语言
import { t, tTable, VOICE_REFERENCE_IMPORT_ACTION } from "@ergo/protocol";
import { INTERRUPTED_PREFIX } from "../runtime/host-protocol.ts";
import type { SpokenPace } from "./spoken-text.ts";

/** agent 写口语总结的工具，和它在调用记录里的名字 */
export const SPOKEN_SUMMARY_TOOL = "spoken_summary";
export const spokenSummaryTitle = () => t("voice.tools.spokenSummary");

/** 大约多少个字念得完 */
const charsOf = (pace: SpokenPace) => Math.round(pace.maxSeconds * pace.charsPerSecond);

// @i18n-ignore-start model：交给 agent 的说明、口语总结工具的说明和结果
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

// @i18n-ignore-end

/** 运行时兜底截的口语总结最后加的一句（追问了 agent 还是没写总结时；念给用户听） */
export const runtimeSummaryTail = () => t("voice.spoken.tail");

/** 没合成出来，退回只发文字时会话里的说明 */
export function synthesisFailedNote(reason: string): string {
  return t("voice.notes.synthesisFailed", { reason });
}

/** 分段合成到一半没合成下去（38 号票）：已经合成的几段照常能播，会话里的说明 */
export function synthesisPartialNote(reason: string): string {
  return t("voice.notes.synthesisPartial", { reason });
}

/**
 * 发语音工具发的语音（86 号票）没合成出来时会话里的说明：只说这一条没发出去和原因（agent 拿到原因会自己用文字说；
 * 同一轮后面再发成了也不矛盾），不说"这次只发文字"
 */
export function toolVoiceFailedNote(reason: string): string {
  return t("voice.notes.toolVoiceFailed", { reason });
}

/** 发语音工具发的语音分段合成到一半没合成下去（86 号票）：已经发出去的几段照常能播 */
export function toolVoicePartialNote(reason: string): string {
  return t("voice.notes.toolVoicePartial", { reason });
}

/**
 * 没合成成的原因（会话里的说明、设置 · 语音里显示，也交回模型）：
 * - segmentFormatMismatch：分段合成出的各段格式（采样率、声道、位深）对不上，没法拼成一条；
 * - speechBusy：语音服务忙（显卡在给别的任务用、或者服务说忙）——不等超时，直接退回只发文字；
 * - notWav：服务回的不是 WAV
 */
export const VOICE_REASON = tTable({
  segmentFormatMismatch: "voice.reason.segmentFormatMismatch",
  speechBusy: "voice.reason.speechBusy",
  notWav: "voice.reason.notWav",
});

/** 最后没用语音回复的原因（记在 agent 语音对象上） */
export const SKIPPED = {
  turnNotCompleted: (outcome: string) => t("voice.skipped.turnNotCompleted", { outcome }),
  lastInputNotVoice: () => t("voice.skipped.lastInputNotVoice"),
  nothingToSay: () => t("voice.skipped.nothingToSay"),
  noReference: () => t("voice.skipped.noReference"),
  restarted: () => t("voice.skipped.restarted"),
} as const;

/** 合成好的音频存不进去时的原因 */
export function storeFailedReason(detail: string): string {
  return t("voice.reason.storeFailed", { detail });
}

/** 参考音色被删了 */
export function referenceGoneReason(name: string): string {
  return t("voice.reason.referenceGone", { name });
}

/**
 * "还没有参考音色"的待我处理事项：语音回复（用户发了语音）和发语音工具（86 号票，agent 想发语音）共用这一条
 * （同一种事项开着的只留一条，所以不分是谁报的）
 */
export const missingReferenceNotice = () => ({
  title: t("voice.missingReference.title"),
  body: t("voice.missingReference.body"),
  source: t("voice.missingReference.source"),
  // 动作既是按钮上的字也是处理时认的值（网页按 VOICE_REFERENCE_IMPORT_ACTION 认"去导入"），不翻；按钮上的译法归网页
  actions: [VOICE_REFERENCE_IMPORT_ACTION, "知道了"], // @i18n-ignore fixed
});

// ───────────── 用户打字时 agent 也能发语音（86 号票，send-voice.ts） ─────────────

/** "发语音"工具，和它在调用记录里的名字（214 号票起名字是数据契约，在内核的 voice-records/names.ts） */
export { SEND_VOICE_TOOL } from "../voice-records/index.ts";
export const sendVoiceTitle = () => t("voice.tools.sendVoice");

// @i18n-ignore-start model：发语音工具的说明、参数、结果

/**
 * 发语音工具的说明（用户 2026-10-11 定"要说的都放进语音"：要让用户听到的都写进口语稿，文字里只留念不出来的东西；
 * 这一轮另写的普通的话只该是"好的，念给你听"这类引子，会收进语音气泡）
 */
export function sendVoiceToolDescription(pace: SpokenPace, waitMinutes: number): string {
  return (
    "用声音跟用户说话：把一段口语稿合成成语音（用户在设置里选的参考音色），作为你的一条消息发进当前会话，用户那边是一个语音气泡，长按「转文字」能看到原文。" +
    "用户打字、但想让他听见的时候用（比如他说「念给我听」「用语音说」）。要让用户听到的话都写进口语稿：像说话一样写，不用 Markdown，" +
    `念出来不超过约 ${pace.maxSeconds} 秒（大约 ${charsOf(pace)} 个字），放不下就分几次发。` +
    "文字里只放念不出来的东西（代码、表格、链接这类），别的话都放进语音；这一轮另写的普通的话只该是「好的，念给你听」这类引子，会收进语音气泡，不单独显示。" +
    `工具等语音合成完才回（最多等约 ${waitMinutes} 分钟，再久就先告诉你还在合成，语音合成好会自己发出去）：发出去了、只发了一部分、没发出去（和原因）都会告诉你，没发出去时照常用文字回复。` +
    "只在用户直接和你说话的那一轮能用；用户发语音的那一轮你的回复本来就会合成语音，不用调。"
  );
}

/** 发语音工具参数的说明 */
export const SEND_VOICE_PARAM = "要念给用户听的口语稿（要让用户听到的话都写在这里，像说话一样，不用 Markdown）";

/** 发语音工具的结果 */
export const SEND_VOICE_RESULT = {
  /** 用户这一轮发的是语音（语音轮）、有参考音色：回复本来就会合成 */
  voiceTurn: "用户这一轮发的是语音，你的回复会由运行时合成语音发给用户（已经在合成了），不用再发语音；照常回复就行。",
  /** 这一轮不是用户直接在说话 */
  notDirect: "这一轮不是用户在和你直接说话（是后台在做的任务、定时或事件触发的运行、运行时的通知），发不了语音；要告诉用户的照常写文字。",
  nothingToSay: "口语稿里没有念得出来的字，没有发。",
  unspeakable: "口语稿里有代码块、表格、图片或者链接地址这类念不出来的内容，没有发：去掉它们再发（念不出来的照常用文字发）。",
  tooLong: (estimated: number, pace: SpokenPace) => `太长了，没有发：念出来约 ${Math.ceil(estimated)} 秒，缩到 ${pace.maxSeconds} 秒以内（大约 ${charsOf(pace)} 个字）再发，放不下就分几次发。`,
  noReference: "还没有参考音色（用户要先在设置 · 语音里导入一段参考录音），这次发不了语音，已经在待我处理里提示用户去导入；照常用文字回复。",
  done: (seconds: number) => `已经把这段话合成语音发给用户了（约 ${seconds} 秒）：聊天里是一个语音气泡，长按「转文字」能看到原文。文字里只放念不出来的东西（代码、表格、链接），别的话不用再写一遍。`,
  partial: (seconds: number, reason: string) => `语音只发出去了前面一部分（约 ${seconds} 秒；${reason}）。后面没念到的内容要让用户知道的话，照常用文字发。`,
  failed: (reason: string) => `语音没发出去：${reason}。照常用文字回复用户。`,
  /** 这次调用被中止了、守护进程在停：语音照样合成 */
  aborted: "没等到语音合成完（这次调用被中止了）：语音照样在合成，合成好会自己出现在聊天里，不要重发。",
  /** 等了很久（排在别的语音后面、合成得慢）还没合成完：先交回，语音照样合成 */
  stillSynthesizing: "语音还在合成（排在别的语音后面，或者合成得慢）：合成好会自己出现在聊天里，不要重发，接着做别的就行。",
  /** 同一次调用又执行了一遍（幂等键撞了）：语音只发一条 */
  alreadySent: "这次调用的语音已经交给合成了（同一次调用只发一条），合成好会自己出现在聊天里，不要重发。",
} as const;

/**
 * 语音插件运行中停用了（214 号票），还没按新的装配重新拉起的 agent 在正在跑的一轮里再调口语总结、发语音：交回模型的话
 * （照插件宿主给别的插件的工具包的那层，plugins/host.ts）
 */
export const voiceToolOff = (title: string, tool: string) => `${title}插件没启用：现在用不了 ${tool}（用户停用了这个插件）。如实告诉用户，不要说已经做好了。`;

/** 守护进程（或 agent 子进程）在发语音的调用执行到一半时重启了：会话里补上的结果（86 号票，经 interruptedToolResults） */
export const SEND_VOICE_INTERRUPTED = `${INTERRUPTED_PREFIX}这条语音已经交给运行时合成，会自己补发出来（发不出去时会话里有说明），不要重发。`;
// @i18n-ignore-end

/**
 * 模型预热（45 号票）：合成模型的状态里的说明（设置 · 语音里显示）。queued：合成的预热排在识别模型的后面（不同时往显卡里加载）；
 * needsReference：还没有参考音色，没法用实际会用的音色试合成；busy：试合成碰上服务忙（503），隔一会儿（按探活的间隔）再试
 */
export const SPEECH_WARMUP_TEXT = tTable({
  queued: "voice.warmup.queued",
  needsReference: "voice.warmup.needsReference",
  busy: "voice.warmup.busy",
});