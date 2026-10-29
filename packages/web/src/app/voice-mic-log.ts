// 麦克风诊断记录（61 号票）：最近的麦克风开关和音轨事件的时刻和原因，随每条语音带给守护进程（VoiceCapture.micLog），
// 用户在真机上试完（输入法的语音、分屏、iOS 听写……）之后在本机接口看，证实或推翻调研 docs/research/16 的推断。
// 每条带上那一刻的页面信号（document.hasFocus()、visibilityState）：鸿蒙浏览器、原生壳里焦点或前后台报得不对时能查出来。
// 一个页面一份（app/voice-browser.ts），离开、重新进语音模式时接着记；只在内存里，刷新就没了。
// 只留最近 VOICE_MIC_LOG_MAX（40）条：一次完整的开关是 open、ready、close 三条，放得下最近 10 次以上。
// 时刻用和 pointer 事件同一个起点的时钟（performance.now）记，交出去时换成相对这一段按下的毫秒数（负数是按下之前）。
import { VOICE_CAPTURE_TEXT_MAX, VOICE_MIC_LOG_MAX, type VoiceMicLogEntry } from "../state/index.ts";

/**
 * 记什么：open 开始要麦克风、ready 要到了（ms：getUserMedia 的毫秒数）、fail 没要到（reason：错误名）、close 停掉音轨，
 * mute / unmute / ended 音轨被系统静音、恢复、收走，silent 录完一段整段是静音（ms：这一段的毫秒数）。
 * 原生录音（63 号票）：open 让 App 备好录音器、ready 备好了（ms：createAudioCapturer 的毫秒数，reason：App 报的录音器状态）、
 * fail 备不好（reason：denied、failed: 说明）或开始不了（reason：start: 说明）、close 放掉录音器；
 * released App 自己放掉了录音器（reason：background 切到后台……）、error 录音器出错或被系统打断（reason：interrupted……）
 */
export type VoiceMicLogEvent = "open" | "ready" | "fail" | "close" | "mute" | "unmute" | "ended" | "silent" | "released" | "error";

/** 页面信号：document.hasFocus()、document.visibilityState */
export interface VoicePageSignals {
  hasFocus: boolean;
  visibility: string;
}

interface Logged {
  time: number;
  event: VoiceMicLogEvent;
  reason?: string;
  ms?: number;
  page?: VoicePageSignals;
}

export class VoiceMicLog {
  private readonly events: Logged[] = [];
  private readonly signals: (() => VoicePageSignals) | undefined;

  /** signals：读此刻的页面信号（不给就不记） */
  constructor(signals?: () => VoicePageSignals) {
    this.signals = signals;
  }

  /** 记一条（time：这一刻；reason：开关的原因或错误名） */
  add(time: number, event: VoiceMicLogEvent, extra: { reason?: string; ms?: number } = {}): void {
    const reason = extra.reason?.slice(0, VOICE_CAPTURE_TEXT_MAX.logReason);
    this.events.push({ time, event, ...(reason === undefined ? {} : { reason }), ...(extra.ms === undefined ? {} : { ms: extra.ms }), ...(this.signals ? { page: this.signals() } : {}) });
    if (this.events.length > VOICE_MIC_LOG_MAX) this.events.splice(0, this.events.length - VOICE_MIC_LOG_MAX);
  }

  /** 最近的几条（旧的在前），时刻换成相对 origin 的毫秒数（负数在它之前） */
  relativeTo(origin: number): VoiceMicLogEntry[] {
    return this.events.map(({ time, event, reason, ms, page }) => ({
      atMs: Math.round(time - origin),
      event,
      ...(reason === undefined ? {} : { reason }),
      ...(ms === undefined ? {} : { ms }),
      ...(page ? { hasFocus: page.hasFocus, visibility: page.visibility.slice(0, VOICE_CAPTURE_TEXT_MAX.visibility) } : {}),
    }));
  }
}
