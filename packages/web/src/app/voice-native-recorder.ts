// 鸿蒙 App 里录一段语音（63 号票，用户 2026-10-09 要求：用系统自带的录音能力，"准备好但不使用"）：
// 录音交给 App 的 AudioCapturer（经原生桥，见 native-voice.ts），这里是它在网页这一侧的状态，和浏览器的 VoiceRecorder 同一个接口
// （VoiceCaptureBackend），手势、预热的时机、诊断都沿用 voice-session.ts。
// - open：让 App 备好录音器（createAudioCapturer → PREPARED）：不采集、不申请音频焦点、麦克风指示灯不亮，不挡系统输入法的语音；
// - begin：按下时让 App 开始（start），就在按下这一步发出去；stop：App 停下（录音器回到备好的状态，留给下一条），交出 PCM，
//   这里加上 WAV 头（voice-wav.ts）；cancel：App 丢掉这一段；
// - close：App 放掉录音器（release）；还在备的，App 备好了也马上放掉（那次 open 以 AbortError 结束）。
// App 推过来的：录着的时候的实时音量（level() 交给录音面板）；录音器出错、被系统打断（来电）、App 自己放掉了（切到后台）——
// 这个录音器就失效了（stale，按下时重新备好），正在录的这一段告诉 voice-session.ts（onTrouble），由它提示、歇着。
// 诊断：按下 → 第一块数据（网页调进 App 之前的那一截 + App 里 start 到第一块数据）、备好用了多久、整段最大振幅，记进 capture。
import { t, VOICE_SILENT_PEAK, type VoiceCapture, type VoiceMicCloseReason, type VoiceMicOpenReason } from "../state/index.ts";
import type { NativeVoice, NativeVoiceEvent } from "./native-voice.ts";
import type { VoiceMicLog } from "./voice-mic-log.ts";
import { MicError, type Recording, type VoiceCaptureBackend } from "./voice-recorder.ts";
import { pcmPeak, wavOf } from "./voice-wav.ts";

/** 没有麦克风权限时给用户看的话（App 里没有地址栏，权限在手机的设置里） */
export const nativeDeniedText = (): string => t("app.voiceNative.denied");

/** 备好的录音器：App 给的编号、为什么备的、备好用了多久；dead 是失效了（出错、被打断、App 放掉了） */
interface Prepared {
  id: number;
  reason: VoiceMicOpenReason;
  prepareMs: number;
  dead: boolean;
}

/** 一次备好（close 先到了就作废） */
interface Opening {
  promise: Promise<void>;
  cancelled: boolean;
}

/** 按下到抬手这一段 */
interface Take {
  pressedAt: number;
  prewarmed: boolean;
  prepared: Prepared;
  /** 网页调 App 开始的那一刻 */
  calledAt: number;
}

export interface NativeVoiceRecorderOptions {
  log: VoiceMicLog;
  /** 正在录的这一段录不下去了（开始不了、出错、被打断、App 放掉了录音器）：录音器已经当作失效，由调用方提示、结束这一段 */
  onTrouble(err: MicError): void;
}

/** 录着的时候 App 说出了事：给用户看的话 */
function troubleText(event: Extract<NativeVoiceEvent, { type: "error" | "released" }>): string {
  if (event.type === "released") return t("app.voiceNative.released");
  if (event.reason === "interrupted") return t("app.voiceNative.interrupted");
  return event.message ? t("app.voiceNative.errorWithMessage", { message: event.message }) : t("app.voiceNative.error");
}

export class NativeVoiceRecorder implements VoiceCaptureBackend {
  readonly backend = "native";
  private readonly voice: NativeVoice;
  private readonly now: () => number;
  private readonly options: NativeVoiceRecorderOptions;
  private prepared: Prepared | undefined;
  private opening: Opening | undefined;
  private take: Take | undefined;
  /** 这一段 App 最近推过来的音量（均方根） */
  private rms = 0;
  /** 收 App 推送的订阅：备着、在备的时候才订（输入框卸下、换一个会话对象时不留着） */
  private unsubscribe: (() => void) | undefined;

  constructor(voice: NativeVoice, now: () => number, options: NativeVoiceRecorderOptions) {
    this.voice = voice;
    this.now = now;
    this.options = options;
  }

  /** 录音器备好了、没失效 */
  get live(): boolean {
    return this.prepared !== undefined && !this.prepared.dead;
  }

  /** 按下就能录：录音器备好了 */
  get warm(): boolean {
    return this.live;
  }

  /** 留着的录音器失效了：按下时放掉、重新备好 */
  get stale(): boolean {
    return this.prepared !== undefined && this.prepared.dead;
  }

  /**
   * 让 App 备好录音器（不采集）。已经备好、正在备就沿用；失效的先放掉。
   * userAction：按下引起的——App 在用户拒过麦克风权限时再弹一次系统的授权框
   */
  open(reason: VoiceMicOpenReason = "enter", options: { userAction?: boolean } = {}): Promise<void> {
    if (this.live) return Promise.resolve();
    if (this.opening) return this.opening.promise;
    if (this.prepared) {
      this.options.log.add(this.now(), "close", { reason: "stale" });
      this.prepared = undefined;
      this.voice.release();
    }
    const opening: Opening = { promise: Promise.resolve(), cancelled: false };
    this.unsubscribe ??= this.voice.subscribe((event) => this.heard(event));
    this.options.log.add(this.now(), "open", { reason });
    opening.promise = this.voice.prepare(options.userAction === true).then((result) => {
      if (this.opening === opening) this.opening = undefined;
      // 已经 close 了：App 那边也放掉了（备好的马上放掉），这次作废
      if (opening.cancelled) throw new DOMException(t("app.voiceNative.releasedBeforeReady"), "AbortError");
      if (!result.ok) {
        const denied = result.reason === "denied";
        this.options.log.add(this.now(), "fail", { reason: denied ? "denied" : `${result.reason}: ${result.message}` });
        // cancelled 而网页没放：App 自己放掉了（切到后台、页面重新加载），先歇着，回到前台、按下时再备好
        const text = denied ? nativeDeniedText() : result.reason === "cancelled" ? t("app.voiceNative.appReleasedBeforeReady") : t("app.voice.cantRecord", { reason: result.message });
        throw new MicError(denied ? "denied" : "failed", text);
      }
      this.prepared = { id: result.id, reason, prepareMs: result.prepareMs, dead: false };
      this.options.log.add(this.now(), "ready", { reason: result.state, ms: Math.round(result.prepareMs) });
    });
    this.opening = opening;
    return opening.promise;
  }

  /** 按下：让 App 开始（录音器要已经备好）；就在按下的那个事件里调用。开始不了由 onTrouble 告诉调用方 */
  begin(press: { pressedAt: number; prewarmed: boolean }): void {
    const prepared = this.prepared;
    if (!prepared || prepared.dead) throw new Error(t("app.voiceNative.notReady"));
    this.cancel();
    const take: Take = { ...press, prepared, calledAt: this.now() };
    this.take = take;
    this.rms = 0;
    void this.voice.start().then((result) => {
      if (result.ok || this.take !== take) return;
      this.take = undefined;
      this.options.log.add(this.now(), "fail", { reason: `start: ${result.message}` });
      this.options.onTrouble(new MicError("failed", t("app.voice.cantRecord", { reason: result.message })));
    });
  }

  /** 当前音量（0–1）：App 推过来的均方根，和浏览器一样放大一些好看出起伏 */
  level(): number {
    return this.take ? Math.min(1, this.rms * 4) : 0;
  }

  /** 抬手：App 停下，交出这一段的 PCM，加上 WAV 头；录音器留着给下一条 */
  stop(): Promise<Recording> {
    const take = this.take;
    this.take = undefined;
    if (!take) return Promise.reject(new Error(t("app.voice.notRecording")));
    return this.voice.stop().then((result) => {
      if (!result.ok) throw new Error(result.message);
      if (result.pcm.length === 0) throw new Error(t("app.voice.nothingRecorded"));
      const peak = pcmPeak(result.pcm, result.format);
      return {
        blob: new Blob([wavOf(result.pcm, result.format)], { type: "audio/wav" }),
        mime: "audio/wav",
        capture: { ...captureOf(take, result.firstDataMs, peak), micLog: this.options.log.relativeTo(take.pressedAt) },
        // 61 号票的不发空白语音：原生录音直接看样本
        silent: peak < VOICE_SILENT_PEAK,
      };
    });
  }

  /** 丢掉这一段（上划松开、太短、出错）：App 停下、扔掉；录音器留着 */
  cancel(): void {
    if (!this.take) return;
    this.take = undefined;
    this.voice.discard();
  }

  /** 放掉录音器（离开语音模式、切到后台……）：正在录的丢掉；还在备的，备好了也马上放掉。没备、没在备的不记 */
  close(reason: VoiceMicCloseReason = "leave"): void {
    this.take = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (!this.prepared && !this.opening) return;
    this.options.log.add(this.now(), "close", { reason });
    if (this.opening) {
      this.opening.cancelled = true;
      this.opening = undefined;
    }
    this.prepared = undefined;
    this.voice.release();
  }

  /** App 推过来的：只认现在这个录音器的 */
  private heard(event: NativeVoiceEvent): void {
    const prepared = this.prepared;
    if (!prepared || prepared.dead || event.id !== prepared.id) return;
    if (event.type === "level") {
      if (this.take) this.rms = event.rms;
      return;
    }
    // 出错、被打断、App 放掉了：这个录音器失效了，按下时重新备好；正在录的这一段录不下去了
    prepared.dead = true;
    this.options.log.add(this.now(), event.type, { reason: event.reason });
    if (!this.take) return;
    this.take = undefined;
    this.options.onTrouble(new MicError("failed", troubleText(event)));
  }
}

/** 一段原生录音的诊断：按下 → 第一块数据（App 报了第一块数据才有）、备好用了多久、整段最大振幅 */
function captureOf(take: Take, firstDataMs: number | undefined, peak: number): VoiceCapture {
  return {
    backend: "native",
    prewarmed: take.prewarmed,
    ...(firstDataMs === undefined ? {} : { startDelayMs: Math.max(0, Math.round(take.calledAt - take.pressedAt + firstDataMs)), firstDataMs: Math.round(firstDataMs) }),
    openReason: take.prepared.reason,
    prepareMs: Math.round(take.prepared.prepareMs),
    peak: Math.round(peak * 10_000) / 10_000,
  };
}
