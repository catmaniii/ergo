// "按住 说话"在浏览器里的那一半（规格第 22 节，31 号票；37 号票起麦克风预热）：把手势（state/voice-gesture.ts）、
// 麦克风的开关时机（state/voice-mic.ts）、录音（voice-recorder.ts）、页面的前后台接在一起。
// - 进语音模式（输入框挂上，enter）就打开麦克风流、接好音量分析，但不录；离开语音模式（leave）、页面切到后台
//   立刻停掉所有音轨；回到前台且仍在语音模式时重新预热；语音模式里闲置不关（44 号票）；
// - 按下时流已就绪就在按下这一步同步启动录音器（按下即录，不出"准备中"，计时从按下算起）；没就绪就"准备中"，
//   要到麦克风就开始录。抬手发送、上划取消、太短、60 秒自动发送照旧；录完一条流不关，接着下一条；
// - 第一次进语音模式时自动要麦克风；被拒了提示怎么开，之后不再自动要（拒过的记在页面上：env.permission），按下照样要。
// - 让路（61 号票）：页面里可输入的元素拿到焦点、窗口失去焦点（分屏）时立刻停掉音轨，让系统输入法的语音能用；焦点回来
//   0.5 秒后再预热（规则在 state/voice-mic.ts，这里盯着焦点、到点送 tick）；按着的时候焦点怎么变都不打断；
// - 不发空白语音（61 号票）：按下时预热的音轨失效了（结束、被系统静音）就重新打开（"准备中"）；录完的一段整段是静音就不发，
//   提示再按一次，放掉这个流马上重开；
// - 诊断（61 号票）：麦克风的开关、音轨事件记在页面上的 env.micLog，随每条语音带上（连同开麦原因、冷启动耗时、UA）。
// - 鸿蒙 App 里（63 号票，env.native）：录音走 App 的原生录音器（voice-native-recorder.ts），"预热"是让 App 备好录音器
//   （PREPARED，不占麦克风），按下才开始；所以不用让路（state/voice-mic.ts 按后端区分），别的规矩（手势、准备中、不发空白语音、
//   诊断、权限）照旧。录着的时候 App 说录不下去了（开始不了、被系统打断）就提示、这一段结束、录音器歇着，下一次用到再备好。
// 界面（ui/conversation/VoiceInput.tsx）只管画和转发 pointer 事件；浏览器的接口经 env 注入，测试换成假的。
import {
  initialVoiceGesture,
  initialVoiceMic,
  VOICE_CAPTURE_TEXT_MAX,
  voiceGesture,
  type VoiceGestureInput,
  type VoiceGestureState,
  voiceHeld,
  voiceMic,
  voiceMicCloseReason,
  type VoiceMicInput,
  type VoiceMicOpenReason,
  voiceMicOpenReason,
  voiceMicReturnAt,
  type VoiceMicState,
  voiceMicWanted,
} from "../state/index.ts";
import type { NativeVoice } from "./native-voice.ts";
import type { VoiceFallbacks } from "./voice-fallbacks.ts";
import type { VoiceMicLog } from "./voice-mic-log.ts";
import { NativeVoiceRecorder } from "./voice-native-recorder.ts";
import { isRecordingCancelled, type MicError, micConstraints, micErrorOf, type Recording, type VoiceCaptureBackend, type VoiceMedia, VoiceRecorder } from "./voice-recorder.ts";

/** 多久采一次音量（毫秒）：滚动的波形一格 */
const LEVEL_INTERVAL_MS = 100;

/** 录好的一条：录音、时长、波形摘要（上传后作为语音 part 发出去）；整段是静音的不交出来 */
export interface RecordedVoice extends Omit<Recording, "silent"> {
  durationMs: number;
  waveform: number[];
}

/** 录完的一段整段是静音时的提示 */
const SILENT_TEXT = "没录到声音，再按一次试试";

/** 页面在不在前台（document.hidden 和 visibilitychange）、窗口有没有焦点、焦点在不在可输入的元素上 */
export interface VoicePage {
  hidden(): boolean;
  /** 前后台变了时通知；返回退订 */
  onVisibilityChange(listener: () => void): () => void;
  /** 窗口有系统焦点（document.hasFocus()；分屏切到另一边时没有） */
  focused(): boolean;
  /** 焦点在页面里可输入的元素上（state/voice-mic.ts 的 isTextEntry） */
  editing(): boolean;
  /** 焦点可能变了（focusin / focusout、窗口 blur / focus……）时通知，多通知几次不要紧；返回退订 */
  onFocusChange(listener: () => void): () => void;
}

export interface VoiceSessionEnv {
  media: VoiceMedia;
  /** 鸿蒙 App 的原生录音（63 号票）：有就用它，不用浏览器的 getUserMedia */
  native?: NativeVoice;
  page: VoicePage;
  /** 时钟（毫秒，和 pointer 事件的 timeStamp 同一个起点：performance.now） */
  now(): number;
  /** 过 ms 毫秒调一次 callback（焦点回来之后等 0.5 秒再预热）；返回取消 */
  setTimer(callback: () => void, ms: number): () => void;
  /** 这个页面上要麦克风被拒过：离开、重新进语音模式时还记着，不再自动要 */
  permission: { denied: boolean };
  /** 开着的麦克风影响播放时的兜底（36 号票，见 voice-fallbacks.ts）；不给就是都不开 */
  fallbacks?: VoiceFallbacks;
  /** 麦克风诊断记录（61 号票）：一个页面一份，离开、重新进语音模式时接着记 */
  micLog: VoiceMicLog;
  /** 浏览器（navigator.userAgent），随诊断一起带上 */
  userAgent: string;
}

export class VoiceSession {
  private readonly env: VoiceSessionEnv;
  private readonly recorder: VoiceCaptureBackend;
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
  /** 等焦点回来的那 0.5 秒（到点送 tick） */
  private cancelReturn: (() => void) | undefined;

  constructor(env: VoiceSessionEnv) {
    this.env = env;
    this.recorder = env.native
      ? new NativeVoiceRecorder(env.native, env.now, { log: env.micLog, onTrouble: (err) => this.captureFailed(err) })
      : new VoiceRecorder(env.media, env.now, { constraints: micConstraints(!env.fallbacks?.disableEchoCancellation), log: env.micLog });
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

  /** 进语音模式（输入框挂上）：页面在前台、没在打字、窗口有焦点就预热 */
  enter(): void {
    if (this.mic.entered) return;
    const { page } = this.env;
    const unwatchVisibility = page.onVisibilityChange(() => this.visibilityChanged());
    const unwatchFocus = page.onFocusChange(() => this.focusChanged());
    this.unwatchPage = () => {
      unwatchVisibility();
      unwatchFocus();
    };
    this.updateMic({
      kind: "enter",
      visible: !page.hidden(),
      focused: page.focused(),
      editing: page.editing(),
      denied: this.env.permission.denied,
      backend: this.recorder.backend,
    });
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
    const warm = this.recorder.warm;
    // 预热的音轨已经失效（系统收走了、静音了，比如 iOS 听写打断过）：当作没预热，放掉，接着按下照常重新打开
    // （"准备中"；本来就该开着的麦克风重开，原因记 stale）
    if (!warm && this.recorder.stale) {
      this.opening = undefined;
      this.recorder.close("stale");
    }
    this.apply({ kind: "press", y, time, warm });
  }

  /** 手指移动 */
  move(y: number): void {
    this.apply({ kind: "move", y });
  }

  /** 抬手（pointerup / pointercancel） */
  release(time: number): void {
    this.apply({ kind: "release", time });
  }

  /**
   * 不算这一段：按着的时候又落下第二根手指（54 号票：那是在捏合缩放会话，不是在说话），录的丢掉、不发，
   * 和上划取消一样；之后的抬手不再发送。没按着时什么也不做
   */
  abort(): void {
    this.apply({ kind: "abort" });
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
      ({ silent, ...recording }) => {
        if (silent) return this.takeSilent(sent.durationMs);
        const voice: RecordedVoice = { ...recording, ...sent, capture: { ...recording.capture, browser: this.env.userAgent.slice(0, VOICE_CAPTURE_TEXT_MAX.browser) } };
        for (const listener of this.recordedListeners) listener(voice);
      },
      (err: unknown) => this.apply({ kind: "error", reason: "failed", text: `没录下来：${err instanceof Error ? err.message : String(err)}` }),
    );
  }

  /**
   * 录完的一段整段是静音（被别的应用占着、系统静音了流）：不发，提示再按一次；这个流多半已经录不到声音了，放掉、马上重新打开。
   * 已经又按下了（新的一段在录）就不提示也不换流，免得打断它
   */
  private takeSilent(durationMs: number): void {
    this.env.micLog.add(this.env.now(), "silent", { ms: Math.round(durationMs) });
    if (voiceHeld(this.gesture)) return;
    this.apply({ kind: "error", reason: "failed", text: SILENT_TEXT });
    this.opening = undefined;
    this.recorder.close("silent");
    if (voiceMicWanted(this.mic)) this.openMic("silent");
  }

  private visibilityChanged(): void {
    const visible = !this.env.page.hidden();
    this.updateMic({ kind: "visibility", visible });
    // 按着的时候切到后台：这一段丢掉不发（麦克风上一步已经关了）
    if (!visible) this.apply({ kind: "abort" });
  }

  /** 焦点可能变了：进出可输入的元素、窗口得到或失去焦点（按着的时候也照记，只是不打断这一段） */
  private focusChanged(): void {
    const { page } = this.env;
    const focused = page.focused();
    if (focused !== this.mic.focused) this.updateMic({ kind: "focus", focused, time: this.env.now() });
    const editing = page.editing();
    if (editing !== this.mic.editing) this.updateMic({ kind: "editing", editing, time: this.env.now() });
  }

  /** 麦克风的开关时机变了：该开着就开（预热），不该开着就立刻关；焦点回来的要等一会儿，到点再看 */
  private updateMic(input: VoiceMicInput): void {
    const before = this.mic;
    this.mic = voiceMic(before, input);
    const closeReason = voiceMicCloseReason(this.mic);
    if (closeReason === undefined) {
      // 没有开着的流就开（静音了的流只在按下时才放掉重开，见 press：不然一直静音的系统会开了又开）
      if (!this.recorder.live) this.openMic(voiceMicOpenReason(before, input));
    } else {
      this.opening = undefined;
      this.recorder.close(closeReason);
    }
    this.scheduleReturn();
  }

  /** 等焦点回来的那一刻：到点送 tick（时刻往后挪了就重新定） */
  private scheduleReturn(): void {
    this.cancelReturn?.();
    this.cancelReturn = undefined;
    const at = voiceMicReturnAt(this.mic);
    if (at === undefined) return;
    this.cancelReturn = this.env.setTimer(
      () => {
        this.cancelReturn = undefined;
        this.updateMic({ kind: "tick", time: this.env.now() });
      },
      Math.max(0, at - this.env.now()),
    );
  }

  /** 要麦克风（reason：这次开麦的原因，诊断用）；正在要就沿用。按着的时候要的算用户自己的动作（原生录音据此再要权限） */
  private openMic(reason: VoiceMicOpenReason): void {
    if (this.opening) return;
    const opening = this.recorder.open(reason, { userAction: this.mic.held });
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

  /**
   * 正在录的这一段录不下去了（原生录音：开始不了、被系统打断、App 放掉了录音器）：录音器歇着（放掉），等下一次用到再备好；
   * 提示，这一段结束。先告诉麦克风再结束这一段：免得这一段结束时又去要一次
   */
  private captureFailed(err: MicError): void {
    this.opening = undefined;
    this.updateMic({ kind: "failed" });
    this.apply({ kind: "error", reason: "failed", text: err.message });
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
