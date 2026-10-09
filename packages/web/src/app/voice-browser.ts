// "按住 说话"接到真的浏览器上（31、37 号票）：getUserMedia、MediaRecorder、AudioContext 加 AnalyserNode、页面的前后台和时钟；
// 61 号票起还有焦点（可输入的元素、窗口）、计时器、麦克风诊断记录和 UA。
// 录音和预热的逻辑在 voice-recorder.ts、voice-session.ts（测试里换成假的浏览器），这里只做转接。
// 外网（经 HTTPS）和本机 http://127.0.0.1 都是安全上下文，浏览器才给麦克风。
import { isTextEntry } from "../state/index.ts";
import { VOICE_FALLBACKS } from "./voice-fallbacks.ts";
import { VoiceMicLog } from "./voice-mic-log.ts";
import type { MicMeter, MicRecorder, MicStream, VoiceMedia } from "./voice-recorder.ts";
import type { VoiceSessionEnv } from "./voice-session.ts";

/** 这个页面能不能录音；不能时说明原因 */
export function voiceSupport(): { ok: true } | { ok: false; text: string } {
  if (typeof window === "undefined" || !window.isSecureContext) return { ok: false, text: "这个地址不能用麦克风：要从 HTTPS 地址（手机）或本机的 http://127.0.0.1 打开" };
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return { ok: false, text: "这个浏览器不支持录音" };
  return { ok: true };
}

/** 音量分析：AudioContext 加 AnalyserNode，接在麦克风流上（只分析，不往扬声器放） */
function createMeter(stream: MicStream): MicMeter {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream as MediaStream).connect(analyser);
  return {
    size: analyser.fftSize,
    get running() {
      return context.state === "running";
    },
    read: (buffer) => analyser.getFloatTimeDomainData(buffer),
    wake: () => {
      if (context.state === "suspended") void context.resume().catch(() => undefined);
    },
    close: () => {
      if (context.state !== "closed") void context.close().catch(() => undefined);
    },
  };
}

const media: VoiceMedia = {
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  createRecorder: (stream, mimeType): MicRecorder => new MediaRecorder(stream as MediaStream, mimeType ? { mimeType } : {}),
  isTypeSupported: (mime) => MediaRecorder.isTypeSupported(mime),
  createMeter,
};

/** 这个页面上要麦克风被拒过：页面刷新之前一直记着（离开、重新进语音模式不再自动要） */
const permission = { denied: false };

/** 麦克风诊断记录（61 号票）：一个页面一份，刷新之前一直记着；每条带上那一刻的页面信号 */
const micLog = new VoiceMicLog(() => ({ hasFocus: document.hasFocus(), visibility: document.visibilityState }));

/**
 * 拿着焦点的输入框被移走（对话框关了）时，浏览器不一定发 focusout（焦点悄悄回到页面本身）；
 * 焦点也可能在没有事件的情况下变了。所以在语音模式里隔一会儿再看一眼（只读 activeElement 和 hasFocus，很便宜）
 */
const FOCUS_POLL_MS = 1000;

const page: VoiceSessionEnv["page"] = {
  hidden: () => document.hidden,
  onVisibilityChange(listener) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
  focused: () => document.hasFocus(),
  // 拿到焦点的元素已经不在页面上了（被移走了）也不算
  editing: () => {
    const el = document.activeElement as HTMLElement | null;
    return el !== null && el.isConnected && isTextEntry(el);
  },
  onFocusChange(listener) {
    // focusin / focusout 冒泡到 document：页面里任何元素拿到、失去焦点都知道；窗口的 blur / focus：分屏切到另一边、切回来
    document.addEventListener("focusin", listener);
    document.addEventListener("focusout", listener);
    window.addEventListener("blur", listener);
    window.addEventListener("focus", listener);
    const poll = setInterval(listener, FOCUS_POLL_MS);
    return () => {
      document.removeEventListener("focusin", listener);
      document.removeEventListener("focusout", listener);
      window.removeEventListener("blur", listener);
      window.removeEventListener("focus", listener);
      clearInterval(poll);
    };
  },
};

/** 真的浏览器 */
export function browserVoiceEnv(): VoiceSessionEnv {
  return {
    media,
    page,
    now: () => performance.now(),
    setTimer: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    permission,
    fallbacks: VOICE_FALLBACKS,
    micLog,
    userAgent: navigator.userAgent,
  };
}
