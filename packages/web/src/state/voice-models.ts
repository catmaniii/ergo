// 设置 · 语音里两个语音模型的状态（45 号票：模型预热）。守护进程在后台提前加载识别模型和合成模型；状态经本机接口取
// （GET /api/voice-models，打开页面时取一次，UiInput 的 voice_models），变了经活动状态频道推临时事件 voice_models。
// 两条路来的都并进状态层（UiState.voiceModels），留新的：同一次启动里 revision 大的新；守护进程重启过的（startedAt 不同）取后启动的。
// 识别引擎的清单也在里面（现在只有 faster-whisper 一项，由守护进程给，前端不写死）。
import { VOICE_MODEL_STATUS_LABEL, type VoiceModelState, type VoiceModelsView } from "./protocol.ts";

/** 并进一份状态：留新的那一个 */
export function newerVoiceModels(known: VoiceModelsView | undefined, incoming: VoiceModelsView): VoiceModelsView {
  if (!known) return incoming;
  // 启动时间是同一时区的 ISO 时间，按字面比就是先后
  if (known.startedAt !== incoming.startedAt) return incoming.startedAt > known.startedAt ? incoming : known;
  return incoming.revision >= known.revision ? incoming : known;
}

export interface VoiceModelSummary {
  /** 状态的说法：加载中、已就绪、没开…… */
  label: string;
  /** 好坏：ok 已就绪；pending 等待、加载中、忙（稍后再试）；problem 没开、出错；idle 已卸载 */
  tone: "ok" | "pending" | "problem" | "idle";
  /** 说明：已就绪的是用的模型、设备、加载耗时；别的是原因 */
  detail: string;
}

const TONE: Readonly<Record<VoiceModelState["status"], VoiceModelSummary["tone"]>> = {
  waiting: "pending",
  loading: "pending",
  ready: "ok",
  off: "problem",
  busy: "pending",
  error: "problem",
  unloaded: "idle",
};

/** 没给原因时的说明 */
const DEFAULT_DETAIL: Readonly<Record<Exclude<VoiceModelState["status"], "ready">, string>> = {
  waiting: "还没开始加载",
  loading: "正在加载模型",
  off: "服务没开",
  busy: "服务正忙，稍后再试",
  error: "出错了",
  unloaded: "闲置退出了，下一条语音来了再加载",
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

/** 一个模型的状态怎么显示 */
export function voiceModelSummary(state: VoiceModelState): VoiceModelSummary {
  const label = VOICE_MODEL_STATUS_LABEL[state.status];
  const tone = TONE[state.status];
  if (state.status !== "ready") return { label, tone, detail: state.reason ?? DEFAULT_DETAIL[state.status] };
  const timing =
    state.loadMs === undefined ? undefined : state.alreadyLoaded === true ? `试合成用了 ${seconds(state.loadMs)}，模型之前已经加载好了` : `加载用了 ${seconds(state.loadMs)}`;
  const parts = [state.model, state.device, state.computeType, timing, state.fallbackReason === undefined ? undefined : `退回的原因：${state.fallbackReason}`];
  return { label, tone, detail: parts.filter((p) => p !== undefined && p !== "").join(" · ") };
}
