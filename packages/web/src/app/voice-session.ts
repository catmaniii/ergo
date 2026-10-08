// "按住 说话"在浏览器里的那一半（规格第 22 节，31 号票；37 号票起麦克风预热）：把手势（state/voice-gesture.ts）、
// 麦克风的开关时机（state/voice-mic.ts）、录音（voice-recorder.ts）、页面的前后台接在一起。
// - 进语音模式（输入框挂上，enter）就打开麦克风流、接好音量分析，但不录；离开语音模式（leave）、页面切到后台
//   立刻停掉所有音轨；回到前台且仍在语音模式时重新预热；语音模式里闲置不关（44 号票）；
// - 按下时流已就绪就在按下这一步同步启动录音器（按下即录，不出"准备中"，计时从按下算起）；没就绪就"准备中"，
//   要到麦克风就开始录。抬手发送、上划取消、太短、60 秒自动发送照旧；录完一条流不关，接着下一条；
// - 第一次进语音模式时自动要麦克风；被拒了提示怎么开，之后不再自动要（拒过的记在页面上：env.permission），按下照样要。
// 界面（ui/conversation/VoiceInput.tsx）只管画和转发 pointer 事件；浏览器的接口经 env 注入，测试换成假的。
import {
  initialVoiceGesture,
  initialVoiceMic,
  voiceGesture,
  type VoiceGestureInput,
  type VoiceGestureState,
  voiceHeld,
  voiceMic,
  type VoiceMicInput,
  type VoiceMicState,
  voiceMicWanted,
} from "../state/index.ts";
import type { VoiceFallbacks } from "./voice-fallbacks.ts";
import { isRecordingCancelled, micConstraints, micErrorOf, type Recording, type VoiceMedia, VoiceRecorder } from "./voice-recorder.ts";

/** 多久采一次音量（毫秒）：滚动的波形一格 */
const LEVEL_INTERVAL_MS = 100;

/** 录好的一条：录音、时长、波形摘要（上传后作为语音 part 发出去） */
export interface RecordedVoice extends Recording {
  durationMs: number;
  waveform: number[];
}

/** 页面在不在前台（document.hidden 和 visibilitychange） */
export interface VoicePage {
  hidden(): boolean;
  /** 前后台变了时通知；返回退订 */
  onVisibilityChange(listener: () => void): () => void;
}

export interface VoiceSessionEnv {
  media: VoiceMedia;
  page: VoicePage;
  /** 时钟（毫秒，和 pointer 事件的 timeStamp 同一个起点：performance.now） */
  now(): number;
  /** 这个页面上要麦克风被拒过：离开、重新进语音模式时还记着，不再自动要 */
  permission: { denied: boolean };
  /** 开着的麦克风影响播放时的兜底（36 号票，见 voice-fallbacks.ts）；不给就是都不开 */
  fallbacks?: VoiceFallbacks;
}

export class VoiceSession {
  private readonly env: VoiceSessionEnv;
  private readonly recorder: VoiceRecorder;
  private gesture: VoiceGestureState = initialVoiceGesture;
  private mic: VoiceMicState = initialVoiceMic;
  private readonly listeners = new Set<() => void>();
  private readonly recordedListeners = new Set<(voice: RecordedVoice) => void>();
  /** 正在要麦克风（同一次只要一回） */
  private opening: Promise<void> | undefined;
  /** 这一段按下的时刻（没预热好时，要到麦克风才开始录，按下到开录的毫秒数从这里算） */
  private pressedAt = 0;
  private lastLevelAt = -Infinity;
  private unwatchPage: (() => void) | undefined;

  constructor(env: VoiceSessionEnv) {
    this.env = env;
    this.recorder = new VoiceRecorder(env.media, env.now, micConstraints(!env.fallbacks?.disableEchoCancellation));
  }

  /** 手势的当前状态（界面据此画录音面板、按钮和提示） */
  getState = (): VoiceGestureState => this.gesture;

  /** 状态变了时通知界面；返回退订 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 录好一条（抬手发送、60 秒自动发送）时交给 listener（上传后发消息）；返回退订 */
  onRecorded(listener: (voice: RecordedVoice) => void): () => void {
    this.recordedListeners.add(listener);
    return () => this.recordedListeners.delete(listener);
  }

  /** 进语音模式（输入框挂上）：页面在前台就预热 */
  enter(): void {
    if (this.mic.entered) return;
    this.unwatchPage = this.env.page.onVisibilityChange(() => this.visibilityChanged());
    this.updateMic({ kind: "enter", visible: !this.env.page.hidden(), denied: this.env.permission.denied });
  }

  /** 离开语音模式（输入框卸下）：正在录的丢掉，停掉所有音轨 */
  leave(): void {
    if (!this.mic.entered) return;
    this.unwatchPage?.();
    this.unwatchPage = undefined;
    // 先关麦克风（连同正在录的），再结束这一段：免得这一段结束时又去要一次
    this.updateMic({ kind: "leave" });
    this.apply({ kind: "abort" });
  }

  /** 按下（y：手指的位置；time：按下的时刻，pointer 事件的 timeStamp） */
  press(y: number, time: number): void {
    // 已经按着（多指）：不算新的一段
    if (voiceHeld(this.gesture)) return;
    this.pressedAt = time;
    this.apply({ kind: "press", y, time, warm: this.recorder.warm });
  }

  /** 手指移动 */
  move(y: number): void {
    this.apply({ kind: "move", y });
  }

  /** 抬手（pointerup / pointercancel） */
  release(time: number): void {
    this.apply({ kind: "release", time });
  }

  /** 录着的时候每一帧调一次：走时钟（倒计时、60 秒自动发送），每 0.1 秒采一次音量 */
  frame(time: number): void {
    if (this.gesture.phase !== "recording") return;
    if (time - this.lastLevelAt >= LEVEL_INTERVAL_MS) {
      this.lastLevelAt = time;
      this.apply({ kind: "level", level: this.recorder.level() });
    }
    this.apply({ kind: "tick", time });
  }

  /**
   * 页面上有没有语音在播（点气泡、自动播放）。兜底 (a) 开着时：在播就先关麦克风，播完再预热（这期间按下要等"准备中"）；
   * 没开时什么也不做，麦克风照旧开着、按下即录
   */
  setPlayback(playing: boolean): void {
    if (!this.env.fallbacks?.releaseMicWhilePlaying || this.mic.playing === playing) return;
    this.updateMic({ kind: "playback", playing });
  }

  /** 提示看过了 */
  dismissNotice(): void {
    this.apply({ kind: "dismiss_notice" });
  }

  /** 喂一个输入给手势状态机，执行它要做的事（开始录、停下发送、停下丢掉）；按住与否变了告诉麦克风 */
  private apply(input: VoiceGestureInput): void {
    const before = this.gesture;
    const step = voiceGesture(before, input);
    this.gesture = step.state;
    if (step.effect === "start") this.startTake();
    else if (step.effect === "discard") this.recorder.cancel();
    else if (step.effect === "send") this.sendTake(step.state.sent!);
    if (step.state !== before) this.notify();
    if (voiceHeld(before) !== voiceHeld(this.gesture)) this.updateMic({ kind: "hold", held: voiceHeld(this.gesture) });
  }

  /** 按下了：预热命中就在这一步开始录；没命中等麦克风（"准备中"），要到了再开始（见 micOpened） */
  private startTake(): void {
    if (this.gesture.phase !== "recording") return;
    try {
      this.recorder.begin({ pressedAt: this.pressedAt, prewarmed: true });
    } catch (err) {
      this.apply({ kind: "error", reason: "failed", text: `录不了音：${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private sendTake(sent: { durationMs: number; waveform: number[] }): void {
    this.recorder.stop().then(
      (recording) => {
        for (const listener of this.recordedListeners) listener({ ...recording, ...sent });
      },
      (err: unknown) => this.apply({ kind: "error", reason: "failed", text: `没录下来：${err instanceof Error ? err.message : String(err)}` }),
    );
  }

  private visibilityChanged(): void {
    const visible = !this.env.page.hidden();
    this.updateMic({ kind: "visibility", visible });
    // 按着的时候切到后台：这一段丢掉不发（麦克风上一步已经关了）
    if (!visible) this.apply({ kind: "abort" });
  }

  /** 麦克风的开关时机变了：该开着就开（预热），不该开着就立刻关 */
  private updateMic(input: VoiceMicInput): void {
    this.mic = voiceMic(this.mic, input);
    if (voiceMicWanted(this.mic)) {
      if (!this.recorder.warm) this.openMic();
    } else {
      this.opening = undefined;
      this.recorder.close();
    }
  }

  private openMic(): void {
    if (this.opening) return;
    const opening = this.recorder.open();
    this.opening = opening;
    opening.then(
      () => {
        if (this.opening === opening) this.micOpened();
      },
      (err: unknown) => {
        if (this.opening === opening) this.micFailed(err);
      },
    );
  }

  /** 要到麦克风了：按着在等的（"准备中"）现在开始录，从这一刻计时 */
  private micOpened(): void {
    this.opening = undefined;
    this.env.permission.denied = false;
    this.updateMic({ kind: "granted" });
    if (this.gesture.phase !== "starting") return;
    try {
      this.recorder.begin({ pressedAt: this.pressedAt, prewarmed: false });
    } catch (err) {
      this.apply({ kind: "error", reason: "failed", text: `录不了音：${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    this.apply({ kind: "ready", time: this.env.now() });
  }

  /** 要不到麦克风：提示（没有权限的告诉怎么开）；被拒了不再自动要，别的原因先歇着等下一次用到 */
  private micFailed(err: unknown): void {
    this.opening = undefined;
    if (isRecordingCancelled(err)) return;
    const { reason, text } = micErrorOf(err);
    if (reason === "denied") this.env.permission.denied = true;
    // 先告诉麦克风（被拒、失败，按着的这一段也随之结束），再结束这一段：免得这一段结束时又去要一次
    this.updateMic({ kind: reason });
    this.apply({ kind: "error", reason, text });
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
