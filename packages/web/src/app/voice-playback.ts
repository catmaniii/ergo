// 语音气泡的播放（规格第 22 节；31 号票起，36 号票加了自动播放）：整个页面共用一个播放器（一个 <audio>），同一时间只播一条。
// - 点气泡：播放或暂停；点另一条，正在播的停下。用户自己点了气泡，排着的自动播放就不播了（用户挑了要听的）；
// - 自动播放新到的 agent 语音（播不播由 state/voice-autoplay.ts 定）：没在播就马上播；在播别的就排在后面，播完一条接一条，
//   不打断正在播的。暂停在半路的不算在播；
// - 按住说话（setCapturing）：按下时正在播的停下（不然会录进去，松手后也不接着放它），排着的等松手再播；
// - 手机浏览器要有用户手势才允许出声：iOS 上同一个 <audio> 在手势里出过一次声，之后换地址、在手势之外播也放行。
//   所以在用户手势里（按住说话松手、点发送）调 unlock，静音出一次声；页面一直用这一个 <audio>。
//   仍被拦下（NotAllowedError）就标成"被拦下"，气泡上提示"点一下播放"，不报错；排在后面的也一样标上。
// 放不了的（格式不支持、文件坏了）跳过，接着播排着的。
// - 38 号票：分段合成的 agent 语音边收边播。要播的除了一条完整音频的地址，还可以是"已经到了的段"（SegmentStream）：
//   用 Web Audio 按时间排程，每段排在"整条开始的时刻 + 它在整条里的位置"，段与段首尾相接、不出空白（接缝的淡入淡出由
//   SegmentScheduler 做）；段来晚了（前一段已经播完）就到了马上播，后面的跟着往后挪；取不到的段重试一次，还取不到就跳过，
//   后面的段往前补（不留一整段静音）。段到齐、最后一段播完就算播完。
//   这条语音变了（后面的段到了、合成完了、推过的段被收回了）由 update 告诉播放器（状态层的 agentVoicePlayback 算好的）：
//   在边收边播的接着排；排着的换成此刻能播的；没有能播的了（收回了）就停掉、放开这一条，排着的拿掉。
//   边收边播时点暂停、点别的语音、按住说话都停掉整条（再点从头播）。
//   Web Audio 同样要手势开过才能出声：unlock 时一并开；没开过的（自动播放时）标成"被拦下"。
// 浏览器的 <audio> 和 Web Audio 由外面给（createAudio、createScheduler），测试换成假的；页面上用的在 app/page-voice.ts。
import { type AgentVoicePlayback, playbackSource, type SegmentStream } from "../state/index.ts";

export type { SegmentStream } from "../state/index.ts";

/** <audio> 里用到的那部分 */
export interface AudioLike {
  src: string;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: "play" | "pause" | "ended" | "error", listener: () => void): void;
}

/** 取来、解码好的一段 */
export interface LoadedSegment {
  /** 时长（秒） */
  readonly duration: number;
}

/** Web Audio 里用到的那部分（38 号票）：按时间排程地放解码好的段 */
export interface SegmentScheduler {
  /** 现在的时间（秒，Web Audio 的时钟） */
  now(): number;
  /** 能出声吗（手机浏览器上没在手势里开过时不能） */
  running(): boolean;
  /** 让它能出声（在手势里调才管用）；不让就 reject */
  resume(): Promise<void>;
  /** 取来一段、解码；取不到、解不了就 reject */
  load(url: string): Promise<LoadedSegment>;
  /** 在 when（秒）开始放这一段，头尾淡入淡出几毫秒；放完或者被停下时调 onEnded。返回停下它的函数 */
  play(segment: LoadedSegment, when: number, onEnded: () => void): () => void;
}

/** 要播的：一条完整音频的地址，或者分段合成的语音边收边播 */
export type VoiceSource = string | SegmentStream;

export interface VoicePlayerEnv {
  /** 第一次要播时才建 */
  createAudio(): AudioLike;
  /** 第一次要边收边播（或者解锁）时才建 */
  createScheduler(): SegmentScheduler;
}

export interface VoicePlayer {
  /** 点气泡：播放或暂停这一条（边收边播的暂停就是停掉整条）；在播别的就先停下那条 */
  toggle(id: string, source: VoiceSource): void;
  /** 自动播放新到的一条：没在播就马上播，在播别的就排在后面；正按着"按住 说话"时等松手 */
  autoplay(id: string, source: VoiceSource): void;
  /**
   * 分段合成的 agent 语音此刻能播的（状态层的 agentVoicePlayback）：正在边收边播的接着排新到的段；排着还没轮到的换成
   * 此刻从头播时播的（合成好了就是完整音频）；没有能播的了（推过的段被收回了）——在播的停掉、放开这一条，排着的拿掉。
   * 不在播也没排着的不管
   */
  update(id: string, playback: AgentVoicePlayback): void;
  /** 在用户手势里调：静音出一次声、开 Web Audio，之后在手势之外的自动播放才不被手机浏览器拦下 */
  unlock(): void;
  /** 正按着"按住 说话"：在播的停下，排着的等松手 */
  setCapturing(on: boolean): void;
  capturing(): boolean;
  /** 这一条在不在播（用户的语音按媒体 id 认，agent 的语音按语音 id 认） */
  isPlaying(id: string): boolean;
  /** 有没有哪一条在播（解锁时静音出声的那一下不算） */
  anyPlaying(): boolean;
  /** 这一条的自动播放被浏览器拦下了（点一下才能播） */
  isBlocked(id: string): boolean;
  /** 在播哪一条、被拦下的、按没按着变了时通知；返回退订 */
  subscribe(listener: () => void): () => void;
}

/** 段排上时离现在至少多久（秒）：给浏览器一点余量，免得排在已经过去的时刻 */
const LEAD_SECONDS = 0.05;

/** 静音的一小段 WAV（0.05 秒，8 kHz、8 位单声道），解锁用 */
const SILENCE = silentWav(400);

function silentWav(samples: number): string {
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, 8000, true); // 采样率
  view.setUint32(28, 8000, true); // 每秒字节数
  view.setUint16(32, 1, true); // 每个采样的字节数
  view.setUint16(34, 8, true); // 位深
  text(36, "data");
  view.setUint32(40, samples, true);
  bytes.fill(128, 44); // 8 位无符号的静音是 128
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

const errorName = (err: unknown) => (typeof err === "object" && err !== null && "name" in err ? String(err.name) : "");

/** 正在边收边播的一条 */
interface Playing {
  id: string;
  stream: SegmentStream;
  /** 开始取了的段 */
  requested: Set<number>;
  /** 跳过的段（取不到） */
  skipped: number;
  /** 取完了的段：取好的、取不到的（跳过） */
  loaded: Map<number, LoadedSegment | "failed">;
  /** 下一个要排的段 */
  next: number;
  /** 整条从几秒开始（第一段排上时定；段来晚了往后挪） */
  start: number | undefined;
  /** 排上了的段：停下它们的函数 */
  stops: Array<() => void>;
  /** 排上了、还没放完的段有几个 */
  sounding: number;
}

export function voicePlayerIn(env: VoicePlayerEnv): VoicePlayer {
  let audio: AudioLike | undefined;
  let scheduler: SegmentScheduler | undefined;
  /** 正在播（或者暂停在半路）的那一条 */
  let current: string | undefined;
  /** current 是边收边播的：它的段 */
  let streaming: Playing | undefined;
  /** 排着等自动播放的 */
  let queue: { id: string; source: VoiceSource }[] = [];
  const blocked = new Set<string>();
  let capturing = false;
  /** 这个 <audio> 出过声了（浏览器放行过） */
  let unlocked = false;
  /** 每次换地址加 1：迟到的 play() 结果只认最新的那次 */
  let generation = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const element = (): AudioLike => {
    if (audio) return audio;
    const a = env.createAudio();
    a.addEventListener("play", notify);
    a.addEventListener("pause", notify);
    a.addEventListener("ended", () => {
      if (current !== undefined && !streaming) finished();
    });
    a.addEventListener("error", () => {
      if (current !== undefined && !streaming) finished();
    });
    audio = a;
    return a;
  };

  const webAudio = (): SegmentScheduler => (scheduler ??= env.createScheduler());

  const busy = () => current !== undefined && (streaming !== undefined || (audio !== undefined && !audio.paused));

  /** 这一条播完了（或者放不了）：接着播排着的 */
  const finished = () => {
    current = undefined;
    streaming = undefined;
    next();
    notify();
  };

  const next = () => {
    if (capturing || busy()) return;
    const item = queue.shift();
    if (item) start(item.id, item.source);
  };

  /** 这一条连同排在后面的都标成被浏览器拦下（点一下才能播） */
  const block = (id: string) => {
    blocked.add(id);
    for (const item of queue) blocked.add(item.id);
    queue = [];
    current = undefined;
    notify();
  };

  /** 让播放器出声：放行了记下；被拦下的标上（连同排在后面的）；被我们自己打断的（换了地址、暂停）不管 */
  const play = (a: AudioLike, id: string) => {
    const token = generation;
    a.play().then(
      () => {
        if (token === generation) unlocked = true;
      },
      (err: unknown) => {
        if (token !== generation || current !== id) return;
        const name = errorName(err);
        if (name === "AbortError") return;
        if (name === "NotAllowedError") return block(id);
        finished();
      },
    );
  };

  /** 停下正在播的（整条完整音频暂停、边收边播的段全停），不接着播排着的 */
  const halt = () => {
    generation++;
    if (streaming) {
      const stops = streaming.stops;
      streaming = undefined;
      for (const stop of stops) stop();
    }
    audio?.pause();
  };

  const start = (id: string, source: VoiceSource) => {
    blocked.delete(id);
    if (typeof source !== "string") return startStream(id, source);
    const a = element();
    generation++;
    current = id;
    a.src = source;
    play(a, id);
    notify();
  };

  // ───────────── 边收边播（38 号票） ─────────────

  const startStream = (id: string, stream: SegmentStream) => {
    const s = webAudio();
    generation++;
    current = id;
    streaming = { id, stream, requested: new Set(), skipped: 0, loaded: new Map(), next: 0, start: undefined, stops: [], sounding: 0 };
    // 在手势里（点气泡）这一下就开了；手势外开不了的，排第一段时再看
    if (!s.running()) s.resume().catch(() => undefined);
    fetchSegments(streaming);
    notify();
  };

  /** 把还没取的段都取来，取完一段排一段；取不到的重试一次，还取不到就跳过 */
  const fetchSegments = (p: Playing) => {
    const s = webAudio();
    p.stream.segments.forEach((segment, index) => {
      if (p.requested.has(index)) return;
      p.requested.add(index);
      const done = (loaded: LoadedSegment | "failed") => {
        p.loaded.set(index, loaded);
        schedule(p);
      };
      s.load(segment.url).then(done, () => s.load(segment.url).then(done, () => done("failed")));
    });
  };

  /** 按顺序把取好的段排上：每段排在"整条开始的时刻 + 它在整条里的位置"，来晚了的到了马上播、后面的跟着挪 */
  const schedule = (p: Playing) => {
    if (streaming !== p) return;
    const s = webAudio();
    for (;;) {
      const loaded = p.loaded.get(p.next);
      if (loaded === undefined) break;
      if (!s.running()) {
        // Web Audio 没被手势开过（手机浏览器在手势外不让出声）：标成被拦下，点一下再播
        streaming = undefined;
        return block(p.id);
      }
      const segment = p.stream.segments[p.next]!;
      const previous = p.stream.segments[p.next - 1];
      p.next++;
      if (loaded === "failed") {
        // 跳过取不到的段，后面的往前补：整条的开始往前挪这一段和它前面的停顿（还没排上过段的不用挪）
        if (p.start !== undefined && previous) p.start -= (segment.offsetMs + segment.durationMs - (previous.offsetMs + previous.durationMs)) / 1000;
        continue;
      }
      const earliest = s.now() + LEAD_SECONDS;
      p.start ??= earliest - segment.offsetMs / 1000;
      // 来晚了：到了马上播，整条的开始往后挪（后面的段跟着挪）
      if (p.start + segment.offsetMs / 1000 < earliest) p.start = earliest - segment.offsetMs / 1000;
      p.sounding++;
      p.stops.push(
        s.play(loaded, p.start + segment.offsetMs / 1000, () => {
          if (streaming !== p) return;
          p.sounding--;
          checkEnd(p);
        }),
      );
    }
    checkEnd(p);
  };

  /** 段到齐、都排上了、都放完了：这一条播完了 */
  const checkEnd = (p: Playing) => {
    if (streaming === p && p.stream.complete && p.next >= p.stream.segments.length && p.sounding === 0) finished();
  };

  return {
    toggle(id, source) {
      queue = [];
      if (current === id && streaming) {
        // 边收边播的暂停：停掉整条（再点从头播）
        halt();
        current = undefined;
        notify();
        return;
      }
      if (current === id && audio && typeof source === "string") {
        if (audio.paused) {
          blocked.delete(id);
          play(audio, id);
        } else {
          audio.pause();
        }
        notify();
        return;
      }
      halt();
      start(id, source);
    },
    autoplay(id, source) {
      if (current === id || queue.some((item) => item.id === id)) return;
      queue.push({ id, source });
      next();
      notify();
    },
    update(id, playback) {
      // 排着还没轮到的：换成此刻从头播时播的；没有能播的了就拿掉
      const at = queue.findIndex((item) => item.id === id);
      if (at >= 0) {
        const source = playbackSource(playback);
        if (source === undefined) queue.splice(at, 1);
        else queue[at] = { id, source };
      }
      if (current !== id) return;
      const p = streaming;
      // 没有能播的了（推过的段被收回了），或者段比边收边播手里的少（收回后重做又到了几段）：停掉、放开这一条，
      // 接着播排着的；重做的第一段到了按新到的再自动播放
      const release = playback.kind === "none" || (p !== undefined && (playback.kind !== "stream" || playback.stream.segments.length < p.stream.segments.length));
      if (release) {
        halt();
        finished();
        return;
      }
      if (!p || playback.kind !== "stream") return;
      p.stream = playback.stream;
      fetchSegments(p);
      schedule(p);
    },
    unlock() {
      // Web Audio：手势里开一下
      const s = webAudio();
      if (!s.running()) s.resume().catch(() => undefined);
      if (unlocked || current !== undefined) return;
      const a = element();
      const token = ++generation;
      a.src = SILENCE;
      a.play().then(
        () => {
          if (token !== generation) return;
          unlocked = true;
          a.pause();
        },
        () => {
          // 这次手势不算数：下一次手势再试
        },
      );
    },
    setCapturing(on) {
      if (capturing === on) return;
      capturing = on;
      if (on && busy()) {
        halt();
        current = undefined;
      }
      if (!on) next();
      notify();
    },
    capturing: () => capturing,
    isPlaying: (id) => current === id && (streaming !== undefined || (audio !== undefined && !audio.paused)),
    anyPlaying: busy,
    isBlocked: (id) => blocked.has(id),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
