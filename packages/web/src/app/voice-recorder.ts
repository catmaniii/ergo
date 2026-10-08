// 在浏览器里录一段语音（规格第 22 节，31 号票）：录音只在本地，抬手后整段交给上传（录的过程中不往服务器发任何音频）。
// 麦克风预热（37 号票，用户 2026-10-08 定：提前加载麦克风但不记录）：
// - open：打开麦克风流、接好音量分析，不建录音器、不录、不存（什么时候开、什么时候关由 voice-session.ts 按 state/voice-mic.ts 定）；
// - begin：按下时流已就绪就在这一步同步建好 MediaRecorder 并 start，开头不丢；stop / cancel 只停下这一段的录音器，流留着给下一条；
// - close：停掉所有音轨、关掉音量分析（浏览器的麦克风指示灯随之熄灭）；还在要麦克风的，要到了也马上停掉。
// 每一段量出"按下 → 录音器真正开始（start 事件）"的毫秒数和是不是预热命中，随录音交出去（Recording.capture）。
// 处理（回声消除、降噪、自动增益）照旧开着（回声消除可以由 36 号票的兜底 (b) 关掉，默认不关，见 voice-fallbacks.ts）：预热时它们有时间先收敛，按下时不再从头起步；音轨一直 enabled
// （部分浏览器在音轨 disabled 时会关设备，重开又有延迟）。
// 浏览器能录什么格式就用什么格式（Chrome、Edge 是 webm/opus，Firefox 是 ogg/opus，Safari 是 mp4/aac），服务端按内容认。
// 这里不写 DOM 的类型（测试在 Node 里跑，浏览器的接口换成假的）：用到的那部分见下面的 Mic* 接口，真的浏览器接在 voice-browser.ts。
import type { VoiceCapture } from "../state/index.ts";

/** 依次试的录音格式 */
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];

/** 要麦克风时的约束；回声消除默认开着（关掉是 36 号票的兜底 (b)，见 voice-fallbacks.ts） */
export function micConstraints(echoCancellation = true): { audio: { echoCancellation: boolean; noiseSuppression: true; autoGainControl: true } } {
  return { audio: { echoCancellation, noiseSuppression: true, autoGainControl: true } };
}

export type MicConstraints = ReturnType<typeof micConstraints>;

export const MIC_CONSTRAINTS: MicConstraints = micConstraints();

/** 录音器每隔多久交一块数据（毫秒） */
const TIMESLICE_MS = 250;

/** 录音还没开始就被取消了（open 以它结束，调用方不用提示） */
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

/** 麦克风的一条音轨（MediaStreamTrack 用到的部分） */
export interface MicTrack {
  readonly readyState: string;
  stop(): void;
}

/** 麦克风流（MediaStream 用到的部分） */
export interface MicStream {
  getTracks(): MicTrack[];
}

/** 录音器（MediaRecorder 用到的部分） */
export interface MicRecorder {
  readonly state: string;
  readonly mimeType: string;
  start(timeslice?: number): void;
  stop(): void;
  addEventListener(type: "dataavailable" | "start" | "stop" | "error", listener: (event: { data: Blob }) => void, options?: { once?: boolean }): void;
}

/** 接在麦克风流上的音量分析（浏览器里是 AudioContext 加 AnalyserNode） */
export interface MicMeter {
  /** 一小段时域数据（-1 到 1）的长度 */
  readonly size: number;
  /** 读最新的一小段时域数据 */
  read(buffer: Float32Array<ArrayBuffer>): void;
  /** iOS 上没有用户手势时建的 AudioContext 是挂起的（读到的一直是 0）：按下（用户手势）时唤醒 */
  wake(): void;
  close(): void;
}

/** 浏览器里录音要用的几样东西（真的见 voice-browser.ts，测试里是假的） */
export interface VoiceMedia {
  getUserMedia(constraints: MicConstraints): Promise<MicStream>;
  createRecorder(stream: MicStream, mimeType: string | undefined): MicRecorder;
  isTypeSupported(mime: string): boolean;
  createMeter(stream: MicStream): MicMeter;
}

export interface Recording {
  blob: Blob;
  /** 录音的格式（MediaRecorder 给的类型） */
  mime: string;
  /** 这一段的诊断：按下 → 录音器真正开始的毫秒数、是不是预热命中 */
  capture: VoiceCapture;
}

/** 开着的麦克风：流和接在它上面的音量分析 */
interface Mic {
  stream: MicStream;
  meter: MicMeter;
  buffer: Float32Array<ArrayBuffer>;
}

/** 一次要麦克风（close 先到了就作废：要到了也马上停掉） */
interface Opening {
  promise: Promise<void>;
  cancelled: boolean;
}

/** 按下到抬手这一段：录音器和录到的块 */
interface Take {
  recorder: MicRecorder;
  chunks: Blob[];
  /** 按下的时刻 */
  pressedAt: number;
  /** 按下时流已经就绪 */
  prewarmed: boolean;
  /** 录音器真正开始（start 事件）的时刻 */
  startedAt?: number;
}

function stopTracks(stream: MicStream): void {
  for (const track of stream.getTracks()) track.stop();
}

export class VoiceRecorder {
  private readonly media: VoiceMedia;
  private readonly now: () => number;
  private mic: Mic | undefined;
  private opening: Opening | undefined;
  private take: Take | undefined;
  private readonly constraints: MicConstraints;

  constructor(media: VoiceMedia, now: () => number, constraints: MicConstraints = MIC_CONSTRAINTS) {
    this.media = media;
    this.now = now;
    this.constraints = constraints;
  }

  /** 麦克风流开着、音量分析就绪（音轨都还活着：系统收走了麦克风的不算） */
  get warm(): boolean {
    const tracks = this.mic?.stream.getTracks() ?? [];
    return tracks.length > 0 && tracks.every((t) => t.readyState === "live");
  }

  /** 预热：打开麦克风、接好音量分析，不录。已经开着、正在开就沿用；开之前被 close 了以 AbortError 结束（流已经停掉） */
  open(): Promise<void> {
    if (this.warm) return Promise.resolve();
    if (this.opening) return this.opening.promise;
    // 留着的流已经死了（系统收走了麦克风）：先放掉
    this.releaseMic();
    const opening: Opening = { promise: Promise.resolve(), cancelled: false };
    opening.promise = this.media.getUserMedia(this.constraints).then(
      (stream) => {
        if (this.opening === opening) this.opening = undefined;
        if (opening.cancelled) {
          stopTracks(stream);
          throw new DOMException("麦克风还没打开就关掉了", "AbortError");
        }
        try {
          const meter = this.media.createMeter(stream);
          this.mic = { stream, meter, buffer: new Float32Array(meter.size) };
        } catch (err) {
          stopTracks(stream);
          throw err;
        }
      },
      (err: unknown) => {
        if (this.opening === opening) this.opening = undefined;
        throw opening.cancelled ? new DOMException("麦克风还没打开就关掉了", "AbortError") : err;
      },
    );
    this.opening = opening;
    return opening.promise;
  }

  /**
   * 开始录这一段（流要已经就绪）：同步建好录音器并 start，所以在按下的那个事件里调用就是按下即录。
   * pressedAt 是按下的时刻，prewarmed 是按下时流是不是已经就绪；两者用来量"按下 → 录音器真正开始"
   */
  begin(press: { pressedAt: number; prewarmed: boolean }): void {
    const mic = this.mic;
    if (!mic || !this.warm) throw new Error("麦克风还没打开");
    this.cancel();
    // 预热时建的音量分析可能是挂起的（iOS 上没有用户手势时）：按下是用户手势，在这里唤醒
    mic.meter.wake();
    const mimeType = MIME_CANDIDATES.find((m) => this.media.isTypeSupported(m));
    const recorder = this.media.createRecorder(mic.stream, mimeType);
    const take: Take = { recorder, chunks: [], ...press };
    recorder.addEventListener("dataavailable", (e) => {
      if (e.data.size > 0) take.chunks.push(e.data);
    });
    recorder.addEventListener("start", () => (take.startedAt = this.now()), { once: true });
    recorder.start(TIMESLICE_MS);
    this.take = take;
  }

  /** 当前音量（0–1）：一小段时域数据的均方根，放大一些好看出起伏 */
  level(): number {
    const mic = this.mic;
    if (!mic) return 0;
    mic.meter.read(mic.buffer);
    let sum = 0;
    for (const v of mic.buffer) sum += v * v;
    return Math.min(1, Math.sqrt(sum / mic.buffer.length) * 4);
  }

  /** 抬手：停下这一段的录音器，拿到整段录音；麦克风流留着给下一条 */
  stop(): Promise<Recording> {
    const take = this.take;
    this.take = undefined;
    const recorder = take?.recorder;
    if (!take || !recorder || recorder.state === "inactive") return Promise.reject(new Error("没有在录音"));
    return new Promise((resolve, reject) => {
      // 停下时最后一块先到（dataavailable），然后才是 stop
      recorder.addEventListener(
        "stop",
        () => {
          const mime = recorder.mimeType || take.chunks[0]?.type || "audio/webm";
          const blob = new Blob(take.chunks, { type: mime });
          if (blob.size === 0) reject(new Error("没录到声音"));
          else resolve({ blob, mime, capture: captureOf(take) });
        },
        { once: true },
      );
      recorder.addEventListener("error", () => reject(new Error("录音出错")), { once: true });
      recorder.stop();
    });
  }

  /** 丢掉这一段（上划松开、太短、出错）：停下录音器、扔掉录到的；麦克风流留着 */
  cancel(): void {
    const take = this.take;
    this.take = undefined;
    if (!take) return;
    take.chunks = [];
    if (take.recorder.state !== "inactive") take.recorder.stop();
  }

  /** 关掉麦克风（离开语音模式、切到后台）：丢掉正在录的，停掉所有音轨、关掉音量分析；还在要的，要到了也马上停掉 */
  close(): void {
    this.cancel();
    if (this.opening) {
      this.opening.cancelled = true;
      this.opening = undefined;
    }
    this.releaseMic();
  }

  private releaseMic(): void {
    const mic = this.mic;
    this.mic = undefined;
    if (!mic) return;
    stopTracks(mic.stream);
    mic.meter.close();
  }
}

/** 一段录音的诊断：录音器报了开始才有毫秒数 */
function captureOf(take: Take): VoiceCapture {
  return {
    prewarmed: take.prewarmed,
    ...(take.startedAt === undefined ? {} : { startDelayMs: Math.max(0, Math.round(take.startedAt - take.pressedAt)) }),
  };
}
