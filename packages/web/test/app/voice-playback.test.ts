// 语音气泡的播放（31 号票起；36 号票加了自动播放）：整个页面共用一个播放器，同一时间只播一条。
// - 点气泡：播放或暂停；点另一条，正在播的停下；
// - 自动播放新到的 agent 语音：没在播就马上播，在播别的就排在后面（不打断）；正按着"按住 说话"时等松手；
// - 开始语音输入（209 号票：聊天窗口按住说话、网页悬浮按钮按下）：正在播的暂停在那里（不然会录进去），松手后不自动接着放，
//   点气泡从暂停的地方接着放；边收边播的整条停下；聊天窗口和悬浮按钮各算各的，都松手了才算说完；
// - 手机浏览器要有用户手势才允许出声：在用户手势里（按住说话松手、点发送）先让播放器静音出一次声，之后的自动播放才不被拦；
//   仍被拦就标成"被拦下"（气泡上提示"点一下播放"），不报错，点一下就播。
// - 38 号票：分段合成的 agent 语音边收边播（Web Audio 按时间排程），见最后一组。
// 浏览器的 <audio> 和 Web Audio 都换成假的。
import { beforeEach, describe, expect, test } from "vitest";
import { type AudioLike, type LoadedSegment, type SegmentScheduler, type SegmentStream, type VoicePlayer, voicePlayerIn } from "../../src/app/voice-playback.ts";
import type { AgentVoicePlayback } from "../../src/state/index.ts";

/** 假的 <audio>：play() 的结果由测试定（浏览器拦了是 NotAllowedError，放不了的文件是 NotSupportedError） */
class FakeAudio implements AudioLike {
  private source = "";
  paused = true;
  /** 播到哪了（秒）；换地址时回到 0（和浏览器一样） */
  currentTime = 0;
  get src() {
    return this.source;
  }
  set src(value: string) {
    this.source = value;
    this.currentTime = 0;
  }
  /** 接下来的 play() 被浏览器拦下 */
  outcome: "ok" | "blocked" = "ok";
  /** 这些地址的文件放不了 */
  readonly broken = new Set<string>();
  /** 每次 play() 时的 src */
  readonly played: string[] = [];
  private readonly listeners: Record<string, Array<() => void>> = {};
  addEventListener(type: string, listener: () => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  private emit(type: string) {
    for (const listener of this.listeners[type] ?? []) listener();
  }
  play(): Promise<void> {
    this.played.push(this.src);
    if (this.outcome === "blocked") return Promise.reject(Object.assign(new Error("play() failed because the user didn't interact with the document first"), { name: "NotAllowedError" }));
    if (this.broken.has(this.src)) return Promise.reject(Object.assign(new Error("no supported sources"), { name: "NotSupportedError" }));
    this.paused = false;
    this.emit("play");
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.emit("pause");
  }
  // ── 测试里扮演浏览器 ──
  /** 播完了：先 pause 再 ended（和浏览器一样） */
  finish() {
    this.paused = true;
    this.emit("pause");
    this.emit("ended");
  }
}

/** 等 play() 的 Promise 落定 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 段排上时离现在至少多久（秒）：和播放器里的一样 */
const LEAD = 0.05;

/** 假的 Web Audio：时间由测试拨，取段、解码什么时候好由测试定 */
class FakeScheduler implements SegmentScheduler {
  time = 0;
  state: "running" | "suspended" = "running";
  /** resume() 能不能让它出声（手势里能；手机浏览器在手势外不能） */
  resumable = true;
  /** 取过的段（按先后） */
  readonly loads: string[] = [];
  private readonly pending = new Map<string, { resolve(seg: LoadedSegment): void; reject(err: Error): void }>();
  private readonly started: Array<{ url: string; when: number; duration: number; stopped: boolean; ended: boolean; onEnded(): void }> = [];
  now() {
    return this.time;
  }
  running() {
    return this.state === "running";
  }
  resume() {
    if (!this.resumable) return Promise.reject(Object.assign(new Error("not allowed"), { name: "NotAllowedError" }));
    this.state = "running";
    return Promise.resolve();
  }
  load(url: string): Promise<LoadedSegment> {
    this.loads.push(url);
    return new Promise((resolve, reject) => this.pending.set(url, { resolve, reject }));
  }
  play(segment: LoadedSegment, when: number, onEnded: () => void): () => void {
    const entry = { url: (segment as FakeSegment).url, when, duration: segment.duration, stopped: false, ended: false, onEnded };
    this.started.push(entry);
    // 和 Web Audio 一样：停下的也发 ended
    return () => {
      if (entry.stopped || entry.ended) return;
      entry.stopped = true;
      onEnded();
    };
  }
  // ── 测试里扮演浏览器 ──
  /** 这一段取来、解码好了（时长，秒） */
  async arrive(url: string, duration: number) {
    const load = this.pending.get(url);
    this.pending.delete(url);
    load?.resolve({ url, duration } as FakeSegment);
    await settle();
  }
  /** 这一段取不到 */
  async fail(url: string) {
    this.pending.get(url)?.reject(new Error("404"));
    this.pending.delete(url);
    await settle();
  }
  /** 排上过的段：[地址, 从几秒起] */
  starts(): Array<[string, number]> {
    return this.started.map((e) => [e.url, round(e.when)]);
  }
  /** 排上了、还没停也没播完的 */
  playing(): Array<[string, number]> {
    return this.started.filter((e) => !e.stopped && !e.ended).map((e) => [e.url, round(e.when)]);
  }
  /** 时间走到 t：到点播完的段发 ended */
  advance(t: number) {
    this.time = t;
    for (const e of this.started) {
      if (e.stopped || e.ended || e.when + e.duration > t) continue;
      e.ended = true;
      e.onEnded();
    }
  }
}
interface FakeSegment extends LoadedSegment {
  url: string;
}
const round = (x: number) => Math.round(x * 1000) / 1000;

let audio: FakeAudio;
let scheduler: FakeScheduler;
let player: VoicePlayer;
let created: number;

beforeEach(() => {
  created = 0;
  scheduler = new FakeScheduler();
  player = voicePlayerIn({
    createAudio: () => {
      created++;
      audio = new FakeAudio();
      return audio;
    },
    createScheduler: () => scheduler,
  });
});

/** 现在在播的（没有是 undefined） */
const playingNow = (ids: string[]) => ids.find((id) => player.isPlaying(id));

describe("点气泡", () => {
  test("点一下播放，再点暂停，再点接着播；整个页面只用一个播放器", async () => {
    player.toggle("a", "/media/a");
    await settle();
    expect(player.isPlaying("a")).toBe(true);
    player.toggle("a", "/media/a");
    expect(player.isPlaying("a")).toBe(false);
    player.toggle("a", "/media/a");
    await settle();
    expect(player.isPlaying("a")).toBe(true);
    expect(audio.played).toEqual(["/media/a", "/media/a"]);
    expect(created).toBe(1);
  });

  test("点另一条：正在播的停下，播这一条", async () => {
    player.toggle("a", "/media/a");
    player.toggle("b", "/media/b");
    await settle();
    expect(playingNow(["a", "b"])).toBe("b");
    expect(audio.src).toBe("/media/b");
  });

  test("播完了：不在播了", async () => {
    player.toggle("a", "/media/a");
    await settle();
    audio.finish();
    expect(player.isPlaying("a")).toBe(false);
  });
});

describe("自动播放新到的 agent 语音", () => {
  test("没在播：马上播", async () => {
    player.autoplay("a", "/media/a");
    await settle();
    expect(player.isPlaying("a")).toBe(true);
  });

  test("正在播别的：排在后面，播完了接着播（不打断）；同一条不排两次", async () => {
    player.toggle("old", "/media/old");
    await settle();
    player.autoplay("a", "/media/a");
    player.autoplay("b", "/media/b");
    player.autoplay("a", "/media/a");
    await settle();
    expect(playingNow(["old", "a", "b"])).toBe("old");
    audio.finish();
    await settle();
    expect(playingNow(["old", "a", "b"])).toBe("a");
    audio.finish();
    await settle();
    expect(playingNow(["old", "a", "b"])).toBe("b");
    audio.finish();
    await settle();
    expect(audio.played).toEqual(["/media/old", "/media/a", "/media/b"]);
  });

  test("用户把在播的暂停在半路：新到的直接播（暂停的那条不算在播）", async () => {
    player.toggle("old", "/media/old");
    await settle();
    player.toggle("old", "/media/old");
    player.autoplay("a", "/media/a");
    await settle();
    expect(playingNow(["old", "a"])).toBe("a");
  });

  test("用户自己点了别的气泡：排着的自动播放不再播（用户挑了要听的）", async () => {
    player.toggle("old", "/media/old");
    await settle();
    player.autoplay("a", "/media/a");
    player.toggle("mine", "/media/mine");
    await settle();
    audio.finish();
    await settle();
    expect(audio.played).toEqual(["/media/old", "/media/mine"]);
  });

  test("播放放不了（格式不支持、文件坏了）：跳过它接着播排着的，不报错", async () => {
    player.toggle("old", "/media/old");
    await settle();
    player.autoplay("bad", "/media/bad");
    player.autoplay("a", "/media/a");
    audio.broken.add("/media/bad");
    audio.finish();
    await settle();
    // 坏的那条放不了，接着是 a
    expect(audio.played.slice(1)).toEqual(["/media/bad", "/media/a"]);
    expect(player.isPlaying("a")).toBe(true);
    expect(player.isBlocked("bad")).toBe(false);
  });
});

describe("开始语音输入（按住说话；209 号票起悬浮按钮按下也算）", () => {
  test("按下时正在播的暂停在那里（不然会录进去），松手后不自动接着放；点气泡从暂停的地方接着放", async () => {
    player.toggle("old", "/media/old");
    await settle();
    audio.currentTime = 4.2;
    player.setCapturing(true);
    expect(player.isPlaying("old")).toBe(false);
    expect(player.isPaused("old")).toBe(true);
    expect(audio.paused).toBe(true);
    player.setCapturing(false);
    await settle();
    expect(player.isPlaying("old")).toBe(false);
    expect(player.isPaused("old")).toBe(true);
    expect(audio.played).toEqual(["/media/old"]);
    player.toggle("old", "/media/old");
    await settle();
    expect(player.isPlaying("old")).toBe(true);
    expect(player.isPaused("old")).toBe(false);
    expect(audio.currentTime).toBe(4.2);
    expect(audio.played).toEqual(["/media/old", "/media/old"]);
  });

  test("自动播放的也暂停；松手后排着的接着播，被暂停的那条不自动放；之后点它照样从暂停的地方接着放", async () => {
    player.autoplay("a", "/media/a");
    await settle();
    audio.currentTime = 2.5;
    player.autoplay("b", "/media/b");
    player.setCapturing(true);
    expect(playingNow(["a", "b"])).toBeUndefined();
    expect(player.isPaused("a")).toBe(true);
    player.setCapturing(false);
    await settle();
    expect(playingNow(["a", "b"])).toBe("b");
    expect(player.isPaused("a")).toBe(true);
    audio.finish();
    await settle();
    expect(playingNow(["a", "b"])).toBeUndefined();
    player.toggle("a", "/media/a");
    await settle();
    expect(player.isPlaying("a")).toBe(true);
    expect(audio.currentTime).toBe(2.5);
    expect(audio.played).toEqual(["/media/a", "/media/b", "/media/a"]);
  });

  test("松手后新到的 agent 语音照常自动播放；暂停的那条照旧等着用户点", async () => {
    player.toggle("old", "/media/old");
    await settle();
    audio.currentTime = 1;
    player.setCapturing(true);
    player.setCapturing(false);
    player.autoplay("reply", "/media/reply");
    await settle();
    expect(playingNow(["old", "reply"])).toBe("reply");
    expect(player.isPaused("old")).toBe(true);
  });

  test("用户点了别的气泡：暂停的那条不再记着位置（用户挑了要听的），之后点它从头放", async () => {
    player.toggle("old", "/media/old");
    await settle();
    audio.currentTime = 3;
    player.setCapturing(true);
    player.setCapturing(false);
    player.toggle("mine", "/media/mine");
    await settle();
    expect(player.isPaused("old")).toBe(false);
    player.toggle("old", "/media/old");
    await settle();
    expect(player.isPlaying("old")).toBe(true);
    expect(audio.currentTime).toBe(0);
  });

  test("没在播（用户自己暂停在半路的、播完了的）：按下不动它，不标成被暂停", async () => {
    player.toggle("old", "/media/old");
    await settle();
    player.toggle("old", "/media/old");
    player.setCapturing(true);
    expect(player.isPaused("old")).toBe(false);
  });

  test("按着的时候排着的不播，松手后再播", async () => {
    player.setCapturing(true);
    expect(player.capturing()).toBe(true);
    player.autoplay("a", "/media/a");
    await settle();
    expect(player.isPlaying("a")).toBe(false);
    player.setCapturing(false);
    await settle();
    expect(player.isPlaying("a")).toBe(true);
  });

  test("聊天窗口和悬浮按钮各算各的：都松手了才算说完，这时排着的才播", async () => {
    player.toggle("old", "/media/old");
    await settle();
    player.autoplay("a", "/media/a");
    player.setCapturing(true, "composer");
    player.setCapturing(true, "page-button");
    player.setCapturing(false, "page-button");
    await settle();
    expect(player.capturing()).toBe(true);
    expect(playingNow(["old", "a"])).toBeUndefined();
    player.setCapturing(false, "composer");
    await settle();
    expect(player.capturing()).toBe(false);
    expect(playingNow(["old", "a"])).toBe("a");
  });
});

describe("浏览器拦截自动播放（手机要有用户手势才允许出声）", () => {
  test("被拦下：不报错，标成被拦下（气泡上提示点一下播放），排在后面的也一样；点一下就播，标记去掉", async () => {
    player.toggle("old", "/media/old");
    await settle();
    audio.outcome = "blocked";
    player.autoplay("a", "/media/a");
    player.autoplay("b", "/media/b");
    audio.finish();
    await settle();
    expect(player.isBlocked("a")).toBe(true);
    expect(player.isBlocked("b")).toBe(true);
    expect(playingNow(["a", "b"])).toBeUndefined();
    // 用户点了一下（手势里）：浏览器放行
    audio.outcome = "ok";
    player.toggle("a", "/media/a");
    await settle();
    expect(player.isPlaying("a")).toBe(true);
    expect(player.isBlocked("a")).toBe(false);
    expect(player.isBlocked("b")).toBe(true);
  });

  test("在用户手势里先静音出一次声：播放器解了锁，之后的自动播放照常；解锁不算在播哪一条", async () => {
    player.unlock();
    await settle();
    expect(audio.played).toHaveLength(1);
    expect(audio.played[0]).toMatch(/^data:audio\/wav;base64,/);
    // 解锁那一下出完声就停
    expect(audio.paused).toBe(true);
    expect(player.isPlaying("a")).toBe(false);
    player.autoplay("a", "/media/a");
    await settle();
    expect(player.isPlaying("a")).toBe(true);
  });

  test("解过锁、或者已经出过声（点过气泡）：不再解锁", async () => {
    player.unlock();
    await settle();
    player.unlock();
    await settle();
    expect(audio.played).toHaveLength(1);

    const other = voicePlayerIn({ createAudio: () => (audio = new FakeAudio()), createScheduler: () => scheduler });
    other.toggle("a", "/media/a");
    await settle();
    audio.finish();
    other.unlock();
    await settle();
    expect(audio.played).toEqual(["/media/a"]);
  });

  test("解锁也被拦了（这次手势不算数）：下一次手势再试", async () => {
    const fake = new FakeAudio();
    fake.outcome = "blocked";
    const other = voicePlayerIn({ createAudio: () => fake, createScheduler: () => scheduler });
    other.unlock();
    await settle();
    fake.outcome = "ok";
    other.unlock();
    await settle();
    expect(fake.played).toHaveLength(2);
    expect(fake.paused).toBe(true);
  });

  test("解锁那一下还没出完声就来了新语音：直接播新的，解锁的那一下落定时不去停它", async () => {
    const fake = new FakeAudio();
    const play = fake.play.bind(fake);
    let resolveUnlock: (() => void) | undefined;
    // 解锁的那次 play() 慢一点落定
    fake.play = () => {
      fake.play = play;
      fake.played.push(fake.src);
      fake.paused = false;
      return new Promise<void>((resolve) => (resolveUnlock = resolve));
    };
    const other = voicePlayerIn({ createAudio: () => fake, createScheduler: () => scheduler });
    other.unlock();
    other.autoplay("a", "/media/a");
    resolveUnlock?.();
    await settle();
    expect(fake.src).toBe("/media/a");
    expect(other.isPlaying("a")).toBe(true);
  });
});

test("有没有语音在播（语音模式里麦克风的兜底 (a) 看它）：在播是；暂停、播完、解锁静音出声的那一下都不是", async () => {
  player.unlock();
  expect(player.anyPlaying()).toBe(false);
  await settle();
  player.toggle("a", "/media/a");
  await settle();
  expect(player.anyPlaying()).toBe(true);
  player.toggle("a", "/media/a");
  expect(player.anyPlaying()).toBe(false);
  player.toggle("a", "/media/a");
  await settle();
  audio.finish();
  expect(player.anyPlaying()).toBe(false);
});

test("订阅：在播哪一条、被拦下变了时通知界面；退订之后不再通知", async () => {
  let notified = 0;
  const unsubscribe = player.subscribe(() => notified++);
  player.toggle("a", "/media/a");
  await settle();
  expect(notified).toBeGreaterThan(0);
  unsubscribe();
  const before = notified;
  player.toggle("a", "/media/a");
  expect(notified).toBe(before);
});

// ───────────────────────── 分段合成的语音边收边播（38 号票） ─────────────────────────
// agent 的语音分段合成，第一段到了就开始播，后面的段到了接着排：用 Web Audio 按时间排程（段在整条里从第几毫秒起），
// 段与段首尾相接、不出空白；段来晚了（前一段已经播完）就到了马上播，后面的跟着往后挪。合成完了点气泡播完整音频。
// 这条语音变了由 update 告诉播放器（状态层 agentVoicePlayback 算好的：边收边播的段、完整音频，或者没有能播的）。

/** 测试里各段的时长（毫秒），段间停顿 200 毫秒：第 0、1、2 段从 0、3200、5200 毫秒起 */
const SEGMENT_MS = [3000, 1800, 2800];
/** 第 i 段：地址、在整条里从第几毫秒起、多长 */
const seg = (i: number, offsetMs: number) => ({ url: `/seg/${i}`, offsetMs, durationMs: SEGMENT_MS[i] ?? 1000 });
const stream = (segments: SegmentStream["segments"], complete = false): SegmentStream => ({ segments, complete });
/** update 给的：边收边播的段（合成好了带完整音频的地址） */
const live = (s: SegmentStream, file?: string): AgentVoicePlayback => ({ kind: "stream", stream: s, file });

describe("分段合成的语音：边收边播（Web Audio 按时间排程）", () => {

  test("第一段到了就开始播；后面的段到了按它在整条里的位置首尾相接地排", async () => {
    player.autoplay("v", stream([seg(0, 0)]));
    expect(scheduler.loads).toEqual(["/seg/0"]);
    // 取来、解码好之前还没出声，但这一条算在播（不让别的插进来）
    expect(player.isPlaying("v")).toBe(true);
    scheduler.time = 1;
    await scheduler.arrive("/seg/0", 3);
    expect(scheduler.starts()).toEqual([["/seg/0", 1 + LEAD]]);
    player.update("v", live(stream([seg(0, 0), seg(1, 3200)])));
    await scheduler.arrive("/seg/1", 1.8);
    player.update("v", live(stream([seg(0, 0), seg(1, 3200), seg(2, 5200)])));
    await scheduler.arrive("/seg/2", 2.8);
    expect(scheduler.starts()).toEqual([
      ["/seg/0", 1 + LEAD],
      ["/seg/1", 1 + LEAD + 3.2],
      ["/seg/2", 1 + LEAD + 5.2],
    ]);
    expect(player.isPlaying("v")).toBe(true);
  });

  test("段来晚了（前一段已经播完）：到了马上播，后面的段跟着往后挪", async () => {
    player.autoplay("v", stream([seg(0, 0)]));
    await scheduler.arrive("/seg/0", 3);
    scheduler.advance(4);
    // 第一段播完了，这一条还没完（段没到齐），还算在播
    expect(player.isPlaying("v")).toBe(true);
    player.update("v", live(stream([seg(0, 0), seg(1, 3200), seg(2, 5200)])));
    await scheduler.arrive("/seg/1", 1.8);
    await scheduler.arrive("/seg/2", 2.8);
    expect(scheduler.starts().slice(1)).toEqual([
      ["/seg/1", 4 + LEAD],
      ["/seg/2", 4 + LEAD + 2],
    ]);
  });

  test("后面的段先取到了：等前面的排上再排（按顺序）", async () => {
    player.autoplay("v", stream([seg(0, 0), seg(1, 3200)]));
    await scheduler.arrive("/seg/1", 1.8);
    expect(scheduler.starts()).toEqual([]);
    await scheduler.arrive("/seg/0", 3);
    expect(scheduler.starts()).toEqual([
      ["/seg/0", LEAD],
      ["/seg/1", LEAD + 3.2],
    ]);
  });

  test("段到齐、最后一段播完：这一条播完了，接着播排着的", async () => {
    player.autoplay("v", stream([seg(0, 0)]));
    player.autoplay("a", "/media/a");
    await scheduler.arrive("/seg/0", 3);
    player.update("v", live(stream([seg(0, 0), seg(1, 3200)], true)));
    await scheduler.arrive("/seg/1", 1.8);
    scheduler.advance(3.1);
    expect(player.isPlaying("v")).toBe(true);
    scheduler.advance(5.1);
    await settle();
    expect(player.isPlaying("v")).toBe(false);
    expect(player.isPlaying("a")).toBe(true);
  });

  test("段到齐时已经都播完了：这一条也就播完了", async () => {
    player.autoplay("v", stream([seg(0, 0)]));
    await scheduler.arrive("/seg/0", 3);
    scheduler.advance(4);
    player.update("v", live(stream([seg(0, 0)], true)));
    expect(player.isPlaying("v")).toBe(false);
  });

  test("用户点暂停：停掉整条（排好的段都停），后面再到的段也不播；再点从头播", async () => {
    player.autoplay("v", stream([seg(0, 0), seg(1, 3200)]));
    await scheduler.arrive("/seg/0", 3);
    await scheduler.arrive("/seg/1", 1.8);
    player.toggle("v", stream([seg(0, 0), seg(1, 3200)]));
    expect(player.isPlaying("v")).toBe(false);
    expect(scheduler.playing()).toEqual([]);
    player.update("v", live(stream([seg(0, 0), seg(1, 3200), seg(2, 5200)])));
    expect(scheduler.loads).toEqual(["/seg/0", "/seg/1"]);
    // 再点：从第一段起重新播（已经到了的三段）
    scheduler.time = 10;
    player.toggle("v", stream([seg(0, 0), seg(1, 3200), seg(2, 5200)]));
    expect(player.isPlaying("v")).toBe(true);
    await scheduler.arrive("/seg/0", 3);
    expect(scheduler.playing()).toEqual([["/seg/0", 10 + LEAD]]);
  });

  test("点别的语音：停掉整条，播那一条", async () => {
    player.autoplay("v", stream([seg(0, 0)]));
    await scheduler.arrive("/seg/0", 3);
    player.toggle("other", "/media/other");
    await settle();
    expect(scheduler.playing()).toEqual([]);
    expect(playingNow(["v", "other"])).toBe("other");
  });

  test("开始语音输入：在播的整条停下（边收边播接不上，不标成被暂停）；松手不自动放，再点从头播", async () => {
    player.autoplay("v", stream([seg(0, 0), seg(1, 3200)]));
    await scheduler.arrive("/seg/0", 3);
    scheduler.time = 1;
    player.setCapturing(true);
    expect(player.isPlaying("v")).toBe(false);
    expect(player.isPaused("v")).toBe(false);
    expect(scheduler.playing()).toEqual([]);
    player.setCapturing(false);
    expect(player.isPlaying("v")).toBe(false);
    scheduler.time = 5;
    player.toggle("v", stream([seg(0, 0), seg(1, 3200)]));
    await scheduler.arrive("/seg/0", 3);
    expect(scheduler.playing()).toEqual([["/seg/0", 5 + LEAD]]);
  });

  test("合成完了点气泡（同一条，完整音频）：正在边收边播就停；没在播就播完整音频", async () => {
    player.autoplay("v", stream([seg(0, 0)]));
    await scheduler.arrive("/seg/0", 3);
    player.toggle("v", "/media/full");
    expect(player.isPlaying("v")).toBe(false);
    expect(scheduler.playing()).toEqual([]);
    player.toggle("v", "/media/full");
    await settle();
    expect(player.isPlaying("v")).toBe(true);
    expect(audio.src).toBe("/media/full");
  });

  test("排着还没轮到、这期间合成好了：轮到它时播完整音频", async () => {
    player.toggle("old", "/media/old");
    await settle();
    player.autoplay("v", stream([seg(0, 0)]));
    player.update("v", live(stream([seg(0, 0), seg(1, 3200)], true), "/media/v"));
    audio.finish();
    await settle();
    expect(player.isPlaying("v")).toBe(true);
    expect(audio.src).toBe("/media/v");
    expect(scheduler.loads).toEqual([]);
  });

  test("取不到的段重试一次；还取不到就跳过，后面的段往前补（不留一整段静音）", async () => {
    player.autoplay("v", stream([seg(0, 0), seg(1, 3200), seg(2, 5200)]));
    await scheduler.arrive("/seg/0", 3);
    await scheduler.fail("/seg/1");
    await scheduler.fail("/seg/1");
    await scheduler.arrive("/seg/2", 2.8);
    expect(scheduler.loads).toEqual(["/seg/0", "/seg/1", "/seg/2", "/seg/1"]);
    // 第 2 段接在第 0 段后面（3 秒，加 0.2 秒停顿），不在它原来的 5.2 秒
    expect(scheduler.starts()).toEqual([
      ["/seg/0", LEAD],
      ["/seg/2", LEAD + 3.2],
    ]);
  });

  test("取不到的段重试一次就取到了：照它的位置排", async () => {
    player.autoplay("v", stream([seg(0, 0), seg(1, 3200)]));
    await scheduler.arrive("/seg/0", 3);
    await scheduler.fail("/seg/1");
    await scheduler.arrive("/seg/1", 1.8);
    expect(scheduler.starts()).toEqual([
      ["/seg/0", LEAD],
      ["/seg/1", LEAD + 3.2],
    ]);
  });

  test("推过的段被收回（守护进程重启后从头重做）：停掉、放开这一条，接着播排着的；重做的第一段到了照常自动播放", async () => {
    player.autoplay("v", stream([seg(0, 0), seg(1, 3200)]));
    player.autoplay("a", "/media/a");
    await scheduler.arrive("/seg/0", 3);
    player.update("v", { kind: "none" });
    await settle();
    expect(player.isPlaying("v")).toBe(false);
    expect(scheduler.playing()).toEqual([]);
    expect(player.isPlaying("a")).toBe(true);
    audio.finish();
    await settle();
    // 重做的第一段到了：按新到的自动播放
    scheduler.time = 20;
    player.autoplay("v", stream([seg(0, 0)]));
    expect(player.isPlaying("v")).toBe(true);
    await scheduler.arrive("/seg/0", 3);
    expect(scheduler.playing()).toEqual([["/seg/0", 20 + LEAD]]);
  });

  test("收回后重做又到了几段、才告诉播放器（段比手里的少）：同样停掉放开", async () => {
    player.autoplay("v", stream([seg(0, 0), seg(1, 3200)]));
    await scheduler.arrive("/seg/0", 3);
    player.update("v", live(stream([seg(0, 0)])));
    expect(player.isPlaying("v")).toBe(false);
    expect(scheduler.playing()).toEqual([]);
  });

  test("重做时第一段就失败了（没有能播的）：在播的停掉放开，之后的自动播放不被它占着", async () => {
    player.autoplay("v", stream([seg(0, 0)]));
    await scheduler.arrive("/seg/0", 3);
    player.update("v", { kind: "none" });
    player.autoplay("b", "/media/b");
    await settle();
    expect(player.isPlaying("b")).toBe(true);
  });

  test("排着还没轮到的没有能播的了：拿掉，不播", async () => {
    player.toggle("old", "/media/old");
    await settle();
    player.autoplay("v", stream([seg(0, 0)]));
    player.update("v", { kind: "none" });
    audio.finish();
    await settle();
    expect(player.isPlaying("v")).toBe(false);
    expect(scheduler.loads).toEqual([]);
  });

  test("在播完整音频的：别的变化（合成完了的那条）不打断它", async () => {
    player.toggle("v", "/media/v");
    await settle();
    player.update("v", live(stream([seg(0, 0), seg(1, 3200)], true), "/media/v"));
    expect(player.isPlaying("v")).toBe(true);
    expect(audio.src).toBe("/media/v");
  });

  test("Web Audio 没被手势开过（手机浏览器不让出声）：标成被拦下，不报错；点一下（手势里）就播", async () => {
    scheduler.state = "suspended";
    scheduler.resumable = false;
    player.autoplay("v", stream([seg(0, 0)]));
    await scheduler.arrive("/seg/0", 3);
    expect(player.isBlocked("v")).toBe(true);
    expect(player.isPlaying("v")).toBe(false);
    expect(scheduler.starts()).toEqual([]);
    scheduler.resumable = true;
    player.toggle("v", stream([seg(0, 0)]));
    await scheduler.arrive("/seg/0", 3);
    expect(player.isBlocked("v")).toBe(false);
    expect(scheduler.starts()).toEqual([["/seg/0", LEAD]]);
  });

  test("在用户手势里解锁时也让 Web Audio 能出声", async () => {
    scheduler.state = "suspended";
    player.unlock();
    await settle();
    expect(scheduler.state).toBe("running");
  });
});
