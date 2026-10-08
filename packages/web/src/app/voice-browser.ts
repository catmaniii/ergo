// "按住 说话"接到真的浏览器上（31、37 号票）：getUserMedia、MediaRecorder、AudioContext 加 AnalyserNode、页面的前后台和计时器。
// 录音和预热的逻辑在 voice-recorder.ts、voice-session.ts（测试里换成假的浏览器），这里只做转接。
// 外网（经 HTTPS）和本机 http://127.0.0.1 都是安全上下文，浏览器才给麦克风。
import { VOICE_FALLBACKS } from "./voice-fallbacks.ts";
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

const page: VoiceSessionEnv["page"] = {
  hidden: () => document.hidden,
  onVisibilityChange(listener) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

/** 真的浏览器 */
export function browserVoiceEnv(): VoiceSessionEnv {
  return {
    media,
    page,
    now: () => performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    permission,
    fallbacks: VOICE_FALLBACKS,
  };
}
