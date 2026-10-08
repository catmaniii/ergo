// agent 的语音自动播放（纯函数，36 号票；规格第 22 节"气泡和自动播放"）：会话里新到一条 agent 的语音（有了能播的音频：
// 38 号票起分段合成的是第一段到了，只有一段的是合成完成），
// 页面在前台、开着这个会话、设置里的开关开着，就自动播放这一条；用户正按着"按住 说话"时不播，松手后再播。
// 打开页面、翻历史、断线重连补发的旧语音不自动播。
//
// "新到的"由归并时记下（ui-state.ts 的 agentVoiceArrivals）：有了音频的那一版 agent_voice 是实时推来的——连接把订阅之后
// 补发的帧标成 catchUp（app/ws-connection.ts），往上翻取回的一页不经事件帧。界面对每条新到的问一次这里，
// 播了或者不播都用 agent_voice_arrival_seen 去掉；"松手后再播"的先留着，松手时再问一次。
// 真的去播（同一时间只播一条、浏览器拦截自动播放时提示"点一下播放"）在 app/voice-playback.ts。
//
// 设置里的"自动播放 agent 的语音"开关按设备记住（和外观一样存在这台设备的浏览器里，不经协议），默认开；
// 这里只认记住的值，读写浏览器存储在 app/voice-autoplay-setting.ts。
import type { ConversationId } from "./protocol.ts";
import type { UiState } from "./ui-state.ts";

/**
 * 新到的、还没决定播不播的 agent 语音（语音 id，按到的先后）。会话重新同步时清掉；语音对象因为别的缘故不在了的
 * （比如项目删了）还留着，问 agentVoiceAutoplay 时是不播
 */
export function agentVoiceArrivals(state: UiState): readonly string[] {
  return state.agentVoiceArrivals;
}

/** 决定自动播不播时页面的样子 */
export interface AutoplayEnv {
  /** 设置里的"自动播放 agent 的语音"开着 */
  enabled: boolean;
  /** 页面在前台（看得见） */
  foreground: boolean;
  /** 开着的会话（宽屏上可能同时开着不止一个） */
  openConversations: readonly ConversationId[];
  /** 用户正按着"按住 说话" */
  recording: boolean;
}

/** 现在就播、松手后再问一次、不播 */
export type AutoplayDecision = "play" | "after_recording" | "skip";

/** 这条 agent 语音该不该自动播 */
export function agentVoiceAutoplay(state: UiState, voiceId: string, env: AutoplayEnv): AutoplayDecision {
  const voice = state.agentVoices[voiceId];
  if (!voice || !state.agentVoiceArrivals.includes(voiceId)) return "skip";
  if (!env.enabled || !env.foreground || !env.openConversations.includes(voice.conversation)) return "skip";
  return env.recording ? "after_recording" : "play";
}

/** 记住的开关：只有明确关过（off）才是关，没记过、不认识的都按默认（开） */
export function autoplaySettingOf(raw: string | null): boolean {
  return raw !== "off";
}
