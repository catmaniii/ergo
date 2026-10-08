// 语音气泡的播放（规格第 22 节；31 号票起，36 号票加了自动播放）：整个页面共用一个播放器（一个 <audio>），同一时间只播一条。
// - 点气泡：播放或暂停；点另一条，正在播的停下。用户自己点了气泡，排着的自动播放就不播了（用户挑了要听的）；
// - 自动播放新到的 agent 语音（播不播由 state/voice-autoplay.ts 定）：没在播就马上播；在播别的就排在后面，播完一条接一条，
//   不打断正在播的。暂停在半路的不算在播；
// - 按住说话（setCapturing）：按下时正在播的停下（不然会录进去，松手后也不接着放它），排着的等松手再播；
// - 手机浏览器要有用户手势才允许出声：iOS 上同一个 <audio> 在手势里出过一次声，之后换地址、在手势之外播也放行。
//   所以在用户手势里（按住说话松手、点发送）调 unlock，静音出一次声；页面一直用这一个 <audio>。
//   仍被拦下（NotAllowedError）就标成"被拦下"，气泡上提示"点一下播放"，不报错；排在后面的也一样标上。
// 放不了的（格式不支持、文件坏了）跳过，接着播排着的。
// 浏览器的 <audio> 由外面给（createAudio），测试换成假的；页面上用的那一个在 app/page-voice.ts。

/** <audio> 里用到的那部分 */
export interface AudioLike {
  src: string;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: "play" | "pause" | "ended" | "error", listener: () => void): void;
}

export interface VoicePlayerEnv {
  /** 第一次要播时才建 */
  createAudio(): AudioLike;
}

export interface VoicePlayer {
  /** 点气泡：播放或暂停这一条；在播别的就先停下那条 */
  toggle(id: string, url: string): void;
  /** 自动播放新到的一条：没在播就马上播，在播别的就排在后面；正按着"按住 说话"时等松手 */
  autoplay(id: string, url: string): void;
  /** 在用户手势里调：静音出一次声，之后在手势之外的自动播放才不被手机浏览器拦下 */
  unlock(): void;
  /** 正按着"按住 说话"：在播的停下，排着的等松手 */
  setCapturing(on: boolean): void;
  capturing(): boolean;
  /** 这一条在不在播（按语音的媒体 id 认） */
  isPlaying(id: string): boolean;
  /** 有没有哪一条在播（解锁时静音出声的那一下不算） */
  anyPlaying(): boolean;
  /** 这一条的自动播放被浏览器拦下了（点一下才能播） */
  isBlocked(id: string): boolean;
  /** 在播哪一条、被拦下的、按没按着变了时通知；返回退订 */
  subscribe(listener: () => void): () => void;
}

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

export function voicePlayerIn(env: VoicePlayerEnv): VoicePlayer {
  let audio: AudioLike | undefined;
  /** 正在播（或者暂停在半路）的那一条 */
  let current: string | undefined;
  /** 排着等自动播放的 */
  let queue: { id: string; url: string }[] = [];
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
      if (current !== undefined) finished();
    });
    a.addEventListener("error", () => {
      if (current !== undefined) finished();
    });
    audio = a;
    return a;
  };

  const busy = () => current !== undefined && audio !== undefined && !audio.paused;

  /** 这一条播完了（或者放不了）：接着播排着的 */
  const finished = () => {
    current = undefined;
    next();
    notify();
  };

  const next = () => {
    if (capturing || busy()) return;
    const item = queue.shift();
    if (item) start(item.id, item.url);
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
        if (name === "NotAllowedError") {
          blocked.add(id);
          for (const item of queue) blocked.add(item.id);
          queue = [];
          current = undefined;
          notify();
          return;
        }
        finished();
      },
    );
  };

  const start = (id: string, url: string) => {
    const a = element();
    generation++;
    current = id;
    blocked.delete(id);
    a.src = url;
    play(a, id);
    notify();
  };

  return {
    toggle(id, url) {
      queue = [];
      if (current === id && audio) {
        if (audio.paused) {
          blocked.delete(id);
          play(audio, id);
        } else {
          audio.pause();
        }
        notify();
        return;
      }
      audio?.pause();
      start(id, url);
    },
    autoplay(id, url) {
      if (current === id || queue.some((item) => item.id === id)) return;
      queue.push({ id, url });
      next();
      notify();
    },
    unlock() {
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
        generation++;
        current = undefined;
        audio?.pause();
      }
      if (!on) next();
      notify();
    },
    capturing: () => capturing,
    isPlaying: (id) => current === id && audio !== undefined && !audio.paused,
    anyPlaying: busy,
    isBlocked: (id) => blocked.has(id),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
