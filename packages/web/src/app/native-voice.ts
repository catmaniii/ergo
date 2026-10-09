// 鸿蒙 App 的原生录音在网页这一侧的接口（63 号票，用户 2026-10-09 要求：用系统自带的录音能力，录音器备好但不占麦克风）。
// App 里的实现在 frontend/harmony/entry/src/main/ets/voice/NativeVoice.ets（AudioCapturer），经原生桥 ergouNative 的这一组方法调：
// - voicePrepare(userAction)：备好录音器（createAudioCapturer，PREPARED，不采集、不申请音频焦点、麦克风指示灯不亮）；
//   App 还没有麦克风权限就先向用户要（userAction 为真时，用户拒过的也弹系统的"去设置里打开"框）；
// - voiceStart()：开始采集（start）；voiceStop()：停下（stop，录音器回到备好的状态），交出这一段的 PCM（base64）；
// - voiceDiscard()：丢掉这一段；voiceRelease()：放掉录音器（release）。
// 要等结果的三个是同步方法、回 Promise<string>（JSON；ArkWeb 的 asyncMethodList 拿不到返回值，所以不放那里），
// 丢弃、释放立即返回。App 往网页推的（录着的时候每 50 毫秒的实时音量、录音器出错或被系统打断、App 自己放掉了录音器）
// 调网页登记的 window.__ergouVoice(json)。每次备好的录音器有个编号（id），推过来的都带着，网页据此丢掉旧录音器的消息。
// App 回的东西形状不一定对：一律核对，不对就当失败，不抛错。录音的状态机在 voice-native-recorder.ts。

/** 失败：denied 没有麦克风权限，failed 别的（建不起来、被占着、App 回的不对……），cancelled 还没备好就被放掉了 */
export interface NativeVoiceFailure {
  ok: false;
  reason: "denied" | "failed" | "cancelled";
  message: string;
}

/** 备好了：录音器的编号、createAudioCapturer 花了多久、录音器的状态（PREPARED……，诊断用） */
export type NativeVoicePrepared = { ok: true; id: number; prepareMs: number; state: string } | NativeVoiceFailure;

/** 开始了（按下到开录的计时看停下时交出的 firstDataMs） */
export type NativeVoiceStarted = { ok: true; id: number } | NativeVoiceFailure;

/** PCM 的格式 */
export interface PcmFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/** 停下交出的一段：PCM（小端）和格式；firstDataMs 是 App 里 start 到第一块数据的毫秒数（没收到数据就没有） */
export type NativeVoiceTake = { ok: true; id: number; pcm: Uint8Array; format: PcmFormat; firstDataMs?: number } | NativeVoiceFailure;

/**
 * App 推过来的：level 录着的时候的实时音量（这一小段的均方根，0–1）；error 录音器出错或被系统打断（来电……），
 * 这个录音器不能再用；released App 自己放掉了录音器（切到后台、页面重新加载）
 */
export type NativeVoiceEvent = { type: "level"; id: number; rms: number } | { type: "error"; id: number; reason: string; message: string } | { type: "released"; id: number; reason: string };

export interface NativeVoice {
  prepare(userAction: boolean): Promise<NativeVoicePrepared>;
  start(): Promise<NativeVoiceStarted>;
  stop(): Promise<NativeVoiceTake>;
  discard(): void;
  release(): void;
  /** 收 App 推过来的；返回退订 */
  subscribe(listener: (event: NativeVoiceEvent) => void): () => void;
}

/** 页面上登记推送回调的地方（window） */
export interface NativeVoiceScope {
  __ergouVoice?: (json: string) => void;
}

/** 原生桥上录音这一组方法的名字（NativeBridge.ets 的 NATIVE_BRIDGE_METHODS 里也是这几个） */
export const NATIVE_VOICE_METHODS = ["voicePrepare", "voiceStart", "voiceStop", "voiceDiscard", "voiceRelease"] as const;

type BridgeObject = Record<string, unknown>;
type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const failed = (message: string): NativeVoiceFailure => ({ ok: false, reason: "failed", message });

function parse(text: unknown): Json | undefined {
  if (typeof text !== "string" || text === "") return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** App 回的失败：原因只认三种，别的当 failed */
function failureOf(reply: Json): NativeVoiceFailure {
  const reason = reply.reason === "denied" || reply.reason === "cancelled" ? reply.reason : "failed";
  return { ok: false, reason, message: typeof reply.message === "string" ? reply.message : "App 没说原因" };
}

function fromBase64(text: string): Uint8Array | undefined {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

/** 调一个回 Promise<string> 的方法，解析出 JSON；抛错、失败、不是 JSON 都当 undefined */
async function ask(bridge: BridgeObject, method: string, ...args: boolean[]): Promise<Json | undefined> {
  try {
    const fn = bridge[method] as (...a: boolean[]) => unknown;
    return parse(await fn.apply(bridge, args));
  } catch {
    return undefined;
  }
}

function prepared(reply: Json | undefined): NativeVoicePrepared {
  if (!reply) return failed("App 没回备好的结果");
  if (reply.ok !== true) return failureOf(reply);
  if (!isCount(reply.id) || !isCount(reply.prepareMs)) return failed("App 回的备好结果不对");
  return { ok: true, id: reply.id, prepareMs: reply.prepareMs, state: typeof reply.state === "string" ? reply.state : "" };
}

function started(reply: Json | undefined): NativeVoiceStarted {
  if (!reply) return failed("App 没回开始的结果");
  if (reply.ok !== true) return failureOf(reply);
  if (!isCount(reply.id)) return failed("App 回的开始结果不对");
  return { ok: true, id: reply.id };
}

function take(reply: Json | undefined): NativeVoiceTake {
  if (!reply) return failed("App 没交出录音");
  if (reply.ok !== true) return failureOf(reply);
  const { id, pcm, sampleRate, channels, bitsPerSample, firstDataMs } = reply;
  if (!isCount(id) || typeof pcm !== "string" || !isCount(sampleRate) || !isCount(channels) || !isCount(bitsPerSample)) return failed("App 交出的录音不对");
  const bytes = fromBase64(pcm);
  if (!bytes) return failed("App 交出的录音不是 base64");
  return { ok: true, id, pcm: bytes, format: { sampleRate, channels, bitsPerSample }, ...(isCount(firstDataMs) ? { firstDataMs } : {}) };
}

function eventOf(json: unknown): NativeVoiceEvent | undefined {
  const e = parse(json);
  if (!e || !isCount(e.id)) return undefined;
  if (e.type === "level" && isCount(e.rms)) return { type: "level", id: e.id, rms: e.rms };
  if (e.type === "error") return { type: "error", id: e.id, reason: typeof e.reason === "string" ? e.reason : "failed", message: typeof e.message === "string" ? e.message : "" };
  if (e.type === "released") return { type: "released", id: e.id, reason: typeof e.reason === "string" ? e.reason : "" };
  return undefined;
}

/** 原生桥上有录音这一组方法就包装起来、在 scope 上登记推送回调；没有（旧版 App）返回 undefined */
export function wrapNativeVoice(bridge: BridgeObject, scope: NativeVoiceScope): NativeVoice | undefined {
  if (!NATIVE_VOICE_METHODS.every((m) => typeof bridge[m] === "function")) return undefined;
  const listeners = new Set<(event: NativeVoiceEvent) => void>();
  scope.__ergouVoice = (json) => {
    const event = eventOf(json);
    if (event) for (const listener of listeners) listener(event);
  };
  const tell = (method: string) => {
    try {
      (bridge[method] as () => unknown).call(bridge);
    } catch {
      // App 拒绝了或出错：网页照常
    }
  };
  return {
    prepare: async (userAction) => prepared(await ask(bridge, "voicePrepare", userAction)),
    start: async () => started(await ask(bridge, "voiceStart")),
    stop: async () => take(await ask(bridge, "voiceStop")),
    discard: () => tell("voiceDiscard"),
    release: () => tell("voiceRelease"),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
