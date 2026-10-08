// 在浏览器里录一段语音（规格第 22 节，31 号票）：录音只在本地，抬手后整段交给上传（录的过程中不往服务器发任何音频）。
// - 麦克风只在按住的时候开着：按下时才要麦克风（第一次会弹权限请求）、接上音量分析、开 MediaRecorder；抬手、取消、
//   出错、页面切到后台、组件卸下时立刻停掉所有音轨（浏览器的麦克风指示灯随之熄灭）。流就绪之前录音面板显示"准备中"，
//   就绪之后才开始计时（状态层 voice-gesture.ts 的 ready），所以开头不会被吞掉；
// - 浏览器能录什么格式就用什么格式（Chrome、Edge 是 webm/opus，Firefox 是 ogg/opus，Safari 是 mp4/aac），服务端按内容认；
// - 外网（经 HTTPS）和本机 http://127.0.0.1 都是安全上下文，浏览器才给麦克风。

/** 依次试的录音格式 */
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];

/** 这个页面能不能录音；不能时说明原因 */
export function voiceSupport(): { ok: true } | { ok: false; text: string } {
  if (typeof window === "undefined" || !window.isSecureContext) return { ok: false, text: "这个地址不能用麦克风：要从 HTTPS 地址（手机）或本机的 http://127.0.0.1 打开" };
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return { ok: false, text: "这个浏览器不支持录音" };
  return { ok: true };
}

/** 录音还没开始就被取消了（start 以它结束，调用方不用提示） */
export function isRecordingCancelled(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** 要不到麦克风时给用户看的话：没有权限（告诉怎么开），或者别的问题 */
export function micErrorOf(err: unknown): { reason: "denied" | "failed"; text: string } {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return { reason: "denied", text: "没有麦克风权限：点地址栏左边的网站设置，把麦克风改成允许，再回来按住说话" };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return { reason: "failed", text: "没找到麦克风" };
  if (name === "NotReadableError") return { reason: "failed", text: "麦克风被别的程序占着，录不了" };
  return { reason: "failed", text: `录不了音：${err instanceof Error ? err.message : String(err)}` };
}

export interface Recording {
  blob: Blob;
  /** 录音的格式（MediaRecorder 给的类型） */
  mime: string;
}

/** 按住时这一段：麦克风、音量分析、录音和录到的块 */
interface Take {
  stream?: MediaStream;
  context?: AudioContext;
  analyser?: AnalyserNode;
  buffer?: Float32Array<ArrayBuffer>;
  recorder?: MediaRecorder;
  chunks: Blob[];
  /** 还没开始就被取消了 */
  cancelled: boolean;
}

/** 停掉麦克风的所有音轨、关掉音量分析 */
function release(take: Take): void {
  for (const track of take.stream?.getTracks() ?? []) track.stop();
  if (take.context && take.context.state !== "closed") void take.context.close();
  take.stream = undefined;
  take.context = undefined;
  take.analyser = undefined;
}

export class VoiceRecorder {
  private take: Take | undefined;

  /** 按下：要麦克风、接上音量分析、开始录；开始了才返回（之前被取消了就以 AbortError 结束，麦克风已经停掉） */
  async start(): Promise<void> {
    this.cancel();
    const take: Take = { chunks: [], cancelled: false };
    this.take = take;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    take.stream = stream;
    if (take.cancelled) {
      release(take);
      throw new DOMException("还没开始录就松开了", "AbortError");
    }
    try {
      // 在按下这个手势里建：iOS 上没有用户手势时 AudioContext 是挂起的
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      take.context = context;
      take.analyser = analyser;
      take.buffer = new Float32Array(analyser.fftSize);
      const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      recorder.addEventListener("dataavailable", (e) => {
        if (e.data.size > 0) take.chunks.push(e.data);
      });
      take.recorder = recorder;
      recorder.start(250);
    } catch (err) {
      release(take);
      if (this.take === take) this.take = undefined;
      throw err;
    }
  }

  /** 当前音量（0–1）：一小段时域数据的均方根，放大一些好看出起伏 */
  level(): number {
    const { analyser, buffer } = this.take ?? {};
    if (!analyser || !buffer) return 0;
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (const v of buffer) sum += v * v;
    return Math.min(1, Math.sqrt(sum / buffer.length) * 4);
  }

  /** 抬手：停下，拿到整段录音；麦克风随即停掉 */
  stop(): Promise<Recording> {
    const take = this.take;
    this.take = undefined;
    const recorder = take?.recorder;
    if (!take || !recorder || recorder.state === "inactive") {
      if (take) release(take);
      return Promise.reject(new Error("没有在录音"));
    }
    return new Promise((resolve, reject) => {
      // 停下时最后一块先到（dataavailable），然后才是 stop
      recorder.addEventListener(
        "stop",
        () => {
          release(take);
          const mime = recorder.mimeType || take.chunks[0]?.type || "audio/webm";
          const blob = new Blob(take.chunks, { type: mime });
          if (blob.size === 0) reject(new Error("没录到声音"));
          else resolve({ blob, mime });
        },
        { once: true },
      );
      recorder.addEventListener(
        "error",
        () => {
          release(take);
          reject(new Error("录音出错"));
        },
        { once: true },
      );
      recorder.stop();
    });
  }

  /** 取消（上划松开、太短、切到后台、离开语音模式）：丢掉录到的，立刻停掉麦克风；还在要麦克风的，要到了也马上停掉 */
  cancel(): void {
    const take = this.take;
    this.take = undefined;
    if (!take) return;
    take.cancelled = true;
    take.chunks = [];
    if (take.recorder && take.recorder.state !== "inactive") take.recorder.stop();
    release(take);
  }
}
