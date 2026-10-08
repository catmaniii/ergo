// "按住 说话"的手势（规格第 22 节，31 号票），照微信：按住开始录、录音面板显示当前音量和最近一小段滚动的波形；
// 抬手发送；按住时上划超过一段距离进"松开取消"、抬手不发送；不到 1 秒提示"说话时间太短"、不发送；
// 单条最长 60 秒，最后 10 秒倒计时，到 60 秒自动发送；没有麦克风权限时提示怎么开。
// 麦克风预热（37 号票，用户 2026-10-08 定）：进语音模式就打开麦克风流、备好音量分析，但不录（什么时候开、什么时候关见
// voice-mic.ts）。按下时流已就绪（warm）就在按下那一刻开始录、计时从按下算起，不出"准备中"；
// 没就绪（刚进语音模式就按、预热被关掉了）照旧"准备中"、时钟不走，麦克风就绪（ready）之后才开始计时，所以开头不会被吞掉。
// 抬手、取消、太短、出错、切到后台都停下录音器（send / discard），麦克风留着给下一条。
// 纯函数：输入是手势（按下、移动、抬手）、麦克风（开始录了、音量、出错）和时钟，输出新状态和要做的事（开始录、发送、丢掉）。
// 录音本身（MediaRecorder、音量）在 app/voice-recorder.ts，把这些接起来的在 app/voice-session.ts，界面在 ui/conversation/VoiceInput.tsx。
import { VOICE_COUNTDOWN_MS, VOICE_MAX_MS, VOICE_MIN_MS, VOICE_WAVEFORM_MAX } from "./protocol.ts";

/** 上划多远（像素）进"松开取消" */
export const VOICE_CANCEL_DISTANCE_PX = 60;
/** 录音面板上滚动的波形留最近多少格（每格是一次音量采样，约 0.1 秒） */
export const VOICE_LIVE_BARS = 40;
/** 波形摘要最多多少格（画气泡用，存进语音对象） */
export const VOICE_SUMMARY_BARS = 32;

export interface VoiceGestureState {
  /** 空闲、按下了在等麦克风（没预热好）、正在录 */
  phase: "idle" | "starting" | "recording";
  /** 按下时手指的位置（上划多远按它算） */
  pressY: number;
  /** 在"松开取消"区里 */
  cancelZone: boolean;
  /** 开始计时的时刻（毫秒）：预热命中是按下的那一刻，没命中是麦克风就绪的那一刻 */
  startedAt: number | undefined;
  elapsedMs: number;
  /** 当前音量 0–1 */
  level: number;
  /** 最近一小段的音量（滚动的波形，新的在后） */
  live: readonly number[];
  /** 这一段全部的音量采样（发送时做成波形摘要） */
  samples: readonly number[];
  /** 刚发出去的这一段：时长和波形摘要（effect 是 send 时有） */
  sent: { durationMs: number; waveform: number[] } | undefined;
  /** 要提示的：说话时间太短、没有麦克风权限、录音出错 */
  notice: { kind: "too_short" | "denied" | "failed"; text: string } | undefined;
}

export type VoiceGestureInput =
  /** 按下"按住 说话"（y：手指的位置；time：按下的时刻；warm：这时麦克风已经预热好，按下就录） */
  | { kind: "press"; y: number; time: number; warm: boolean }
  /** 没预热好的麦克风就绪了，开始录了 */
  | { kind: "ready"; time: number }
  /** 手指移动 */
  | { kind: "move"; y: number }
  /** 一次音量采样（0–1） */
  | { kind: "level"; level: number }
  /** 时钟走了（录音面板每一帧送一次） */
  | { kind: "tick"; time: number }
  /** 抬手 */
  | { kind: "release"; time: number }
  /** 放弃这一段（页面切到后台、离开语音模式）：不发送，也不提示 */
  | { kind: "abort" }
  /** 录不了：没有麦克风权限、录音出错 */
  | { kind: "error"; reason: "denied" | "failed"; text: string }
  /** 提示看过了 */
  | { kind: "dismiss_notice" };

/** 要做的事：开始录（没预热好就先要麦克风）、停下录音器并发送、停下录音器并丢掉（两者都不关麦克风） */
export type VoiceGestureEffect = "start" | "send" | "discard";

export const initialVoiceGesture: VoiceGestureState = {
  phase: "idle",
  pressY: 0,
  cancelZone: false,
  startedAt: undefined,
  elapsedMs: 0,
  level: 0,
  live: [],
  samples: [],
  sent: undefined,
  notice: undefined,
};

const TOO_SHORT = { kind: "too_short", text: "说话时间太短" } as const;

export function voiceGesture(state: VoiceGestureState, input: VoiceGestureInput): { state: VoiceGestureState; effect?: VoiceGestureEffect } {
  const active = state.phase !== "idle";
  switch (input.kind) {
    case "press":
      if (active) return { state };
      if (input.warm) return { state: { ...initialVoiceGesture, phase: "recording", pressY: input.y, startedAt: input.time }, effect: "start" };
      return { state: { ...initialVoiceGesture, phase: "starting", pressY: input.y }, effect: "start" };
    case "ready":
      if (state.phase !== "starting") return { state };
      return { state: { ...state, phase: "recording", startedAt: input.time, elapsedMs: 0 } };
    case "move":
      if (!active) return { state };
      return { state: { ...state, cancelZone: state.pressY - input.y >= VOICE_CANCEL_DISTANCE_PX } };
    case "level": {
      if (state.phase !== "recording") return { state };
      const level = Math.min(1, Math.max(0, input.level));
      return { state: { ...state, level, live: [...state.live, level].slice(-VOICE_LIVE_BARS), samples: [...state.samples, level] } };
    }
    case "tick": {
      if (state.phase !== "recording" || state.startedAt === undefined) return { state };
      const elapsedMs = input.time - state.startedAt;
      // 到 60 秒自动发送（手指在取消区里就丢掉）
      if (elapsedMs >= VOICE_MAX_MS) return finish({ ...state, elapsedMs: VOICE_MAX_MS });
      return { state: { ...state, elapsedMs } };
    }
    case "release": {
      if (!active) return { state };
      if (state.cancelZone) return { state: { ...initialVoiceGesture }, effect: "discard" };
      // 麦克风还没开始录就抬手了，或者不到 1 秒
      if (state.phase === "starting" || state.startedAt === undefined || input.time - state.startedAt < VOICE_MIN_MS) {
        return { state: { ...initialVoiceGesture, notice: TOO_SHORT }, effect: "discard" };
      }
      return finish({ ...state, elapsedMs: Math.min(input.time - state.startedAt, VOICE_MAX_MS) });
    }
    case "abort":
      return active ? { state: { ...initialVoiceGesture }, effect: "discard" } : { state };
    case "error":
      return { state: { ...initialVoiceGesture, notice: { kind: input.reason, text: input.text } }, ...(active ? { effect: "discard" as const } : {}) };
    case "dismiss_notice":
      return { state: { ...state, notice: undefined } };
  }
}

/** 录完了：在取消区里就丢掉，否则发送（带上时长和波形摘要） */
function finish(state: VoiceGestureState): { state: VoiceGestureState; effect: VoiceGestureEffect } {
  if (state.cancelZone) return { state: { ...initialVoiceGesture }, effect: "discard" };
  return { state: { ...initialVoiceGesture, sent: { durationMs: state.elapsedMs, waveform: waveformSummary(state.samples) } }, effect: "send" };
}

/** 最后 10 秒的倒计时（还剩几秒）；不在最后 10 秒时没有 */
export function voiceCountdown(state: VoiceGestureState): number | undefined {
  if (state.phase !== "recording") return undefined;
  const remaining = VOICE_MAX_MS - state.elapsedMs;
  return remaining <= VOICE_COUNTDOWN_MS ? Math.max(0, Math.ceil(remaining / 1000)) : undefined;
}

/** 正按着：按下到抬手、取消之间（这时麦克风一定要开着，闲置太久也不关） */
export function voiceHeld(state: VoiceGestureState): boolean {
  return state.phase !== "idle";
}

/** 录音面板顶上那一行：麦克风还没就绪是"准备中"，最后 10 秒是倒计时，平时是已经录了多久（0:05） */
export function voicePanelStatus(state: VoiceGestureState): string {
  if (state.phase === "starting") return "准备中";
  const countdown = voiceCountdown(state);
  if (countdown !== undefined) return `还可以说 ${countdown} 秒`;
  const seconds = Math.floor(state.elapsedMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** 录音面板上的提示 */
export function voiceGestureHint(state: VoiceGestureState): string {
  return state.cancelZone ? "松开手指，取消发送" : "手指上划，取消发送";
}

/** 波形摘要：把音量采样分成最多 32 格，每格取最大的，换成 0–100 的整数 */
export function waveformSummary(samples: readonly number[], bars = VOICE_SUMMARY_BARS): number[] {
  if (samples.length === 0) return [];
  const count = Math.min(bars, samples.length);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const slice = samples.slice(Math.floor((i * samples.length) / count), Math.floor(((i + 1) * samples.length) / count));
    out.push(Math.round(Math.min(1, Math.max(0, ...slice)) * VOICE_WAVEFORM_MAX));
  }
  return out;
}
