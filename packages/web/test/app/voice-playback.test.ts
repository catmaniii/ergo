// 语音气泡的播放（31 号票起；36 号票加了自动播放）：整个页面共用一个播放器，同一时间只播一条。
// - 点气泡：播放或暂停；点另一条，正在播的停下；
// - 自动播放新到的 agent 语音：没在播就马上播，在播别的就排在后面（不打断）；正按着"按住 说话"时等松手，
//   按下时正在播的停下（不然会录进去）；
// - 手机浏览器要有用户手势才允许出声：在用户手势里（按住说话松手、点发送）先让播放器静音出一次声，之后的自动播放才不被拦；
//   仍被拦就标成"被拦下"（气泡上提示"点一下播放"），不报错，点一下就播。
// 浏览器的 <audio> 换成假的。
import { beforeEach, describe, expect, test } from "vitest";
import { type AudioLike, type VoicePlayer, voicePlayerIn } from "../../src/app/voice-playback.ts";

/** 假的 <audio>：play() 的结果由测试定（浏览器拦了是 NotAllowedError，放不了的文件是 NotSupportedError） */
class FakeAudio implements AudioLike {
  src = "";
  paused = true;
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

let audio: FakeAudio;
let player: VoicePlayer;
let created: number;

beforeEach(() => {
  created = 0;
  player = voicePlayerIn({
    createAudio: () => {
      created++;
      audio = new FakeAudio();
      return audio;
    },
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

describe("按住说话", () => {
  test("按下时正在播的停下（不然会录进去），松手后不接着放它", async () => {
    player.toggle("old", "/media/old");
    await settle();
    player.setCapturing(true);
    expect(player.isPlaying("old")).toBe(false);
    player.setCapturing(false);
    await settle();
    expect(player.isPlaying("old")).toBe(false);
    expect(audio.played).toEqual(["/media/old"]);
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

  test("正在播的时候按下：排着的也等松手", async () => {
    player.toggle("old", "/media/old");
    await settle();
    player.autoplay("a", "/media/a");
    player.setCapturing(true);
    await settle();
    expect(playingNow(["old", "a"])).toBeUndefined();
    player.setCapturing(false);
    await settle();
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

    const other = voicePlayerIn({ createAudio: () => (audio = new FakeAudio()) });
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
    const other = voicePlayerIn({ createAudio: () => fake });
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
    const other = voicePlayerIn({ createAudio: () => fake });
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
