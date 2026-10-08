// "按住 说话"在浏览器里的那一半（37 号票，app/voice-session.ts）：麦克风预热——进语音模式就打开麦克风流、接好音量分析，
// 但不录（录音器按下才开始）；离开语音模式、页面切到后台时停掉所有音轨，回到前台再预热；语音模式里闲置不关（44 号票）。
// 浏览器的 getUserMedia、MediaRecorder、AudioContext、页面的前后台和时钟都换成假的。
import { describe, expect, test } from "vitest";
import type { MicMeter, MicRecorder, MicStream, MicTrack, VoiceMedia } from "../../src/app/voice-recorder.ts";
import { type RecordedVoice, VoiceSession, type VoiceSessionEnv } from "../../src/app/voice-session.ts";

class FakeTrack implements MicTrack {
  readyState: "live" | "ended" = "live";
  stop(): void {
    this.readyState = "ended";
  }
}

class FakeStream implements MicStream {
  readonly tracks = [new FakeTrack()];
  getTracks(): MicTrack[] {
    return this.tracks;
  }
  get live(): boolean {
    return this.tracks.every((t) => t.readyState === "live");
  }
}

type Listener = (event: { data: Blob }) => void;

class FakeRecorder implements MicRecorder {
  state: "inactive" | "recording" = "inactive";
  readonly startCalls: number[] = [];
  private readonly listeners = new Map<string, Array<{ fn: Listener; once: boolean }>>();
  readonly stream: FakeStream;
  readonly mimeType: string;
  private readonly browser: FakeBrowser;
  constructor(stream: FakeStream, mimeType: string, browser: FakeBrowser) {
    this.stream = stream;
    this.mimeType = mimeType;
    this.browser = browser;
  }
  addEventListener(type: string, fn: Listener, options?: { once?: boolean }): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), { fn, once: options?.once === true }]);
  }
  private emit(type: string, event: { data: Blob } = { data: new Blob([]) }): void {
    for (const l of this.listeners.get(type) ?? []) {
      if (l.once) this.listeners.set(type, (this.listeners.get(type) ?? []).filter((x) => x !== l));
      l.fn(event);
    }
  }
  start(): void {
    this.state = "recording";
    this.startCalls.push(this.browser.clock);
    // 真的浏览器里 start 事件是排进任务队列的，晚一点才到
    queueMicrotask(() => this.emit("start"));
  }
  stop(): void {
    this.state = "inactive";
    queueMicrotask(() => {
      this.emit("dataavailable", { data: new Blob(["opus-audio"], { type: this.mimeType }) });
      this.emit("stop");
    });
  }
}

class FakeMeter implements MicMeter {
  readonly size = 256;
  suspended: boolean;
  woken = 0;
  closed = false;
  readonly stream: MicStream;
  constructor(stream: MicStream, suspended: boolean) {
    this.stream = stream;
    this.suspended = suspended;
  }
  read(buffer: Float32Array<ArrayBuffer>): void {
    buffer.fill(this.suspended ? 0 : 0.1);
  }
  wake(): void {
    this.woken += 1;
    this.suspended = false;
  }
  close(): void {
    this.closed = true;
  }
}

/** 一次 getUserMedia：可以让它晚一点到、被拒、出错 */
interface MicRequest {
  constraints: unknown;
  resolve(): FakeStream;
  reject(err: unknown): void;
}

class FakeBrowser {
  clock = 1_000_000;
  hidden = false;
  /** 要麦克风的请求：自动给（auto）还是等测试来给 */
  grant: "auto" | "manual" = "auto";
  readonly requests: MicRequest[] = [];
  readonly streams: FakeStream[] = [];
  readonly recorders: FakeRecorder[] = [];
  readonly meters: FakeMeter[] = [];
  /** 建出来的音量分析是挂起的（iOS 上没有用户手势时） */
  suspendedMeters = false;
  private readonly visibility = new Set<() => void>();

  readonly media: VoiceMedia = {
    getUserMedia: (constraints) =>
      new Promise<MicStream>((resolve, reject) => {
        const request: MicRequest = {
          constraints,
          resolve: () => {
            const stream = new FakeStream();
            this.streams.push(stream);
            resolve(stream);
            return stream;
          },
          reject,
        };
        this.requests.push(request);
        if (this.grant === "auto") request.resolve();
      }),
    createRecorder: (stream, mimeType) => {
      const recorder = new FakeRecorder(stream as FakeStream, mimeType ?? "audio/webm", this);
      this.recorders.push(recorder);
      return recorder;
    },
    isTypeSupported: (mime) => mime === "audio/webm;codecs=opus",
    createMeter: (stream) => {
      const meter = new FakeMeter(stream, this.suspendedMeters);
      this.meters.push(meter);
      return meter;
    },
  };

  env(permission = { denied: false }): VoiceSessionEnv {
    return {
      media: this.media,
      page: {
        hidden: () => this.hidden,
        onVisibilityChange: (listener) => {
          this.visibility.add(listener);
          return () => this.visibility.delete(listener);
        },
      },
      now: () => this.clock,
      permission,
    };
  }

  /** 时间往前走 */
  advance(ms: number): void {
    this.clock += ms;
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.visibility) listener();
  }

  /** 开着的麦克风流（音轨还活着的） */
  liveStreams(): FakeStream[] {
    return this.streams.filter((s) => s.live);
  }

  /** 启动过的录音器 */
  startedRecorders(): FakeRecorder[] {
    return this.recorders.filter((r) => r.startCalls.length > 0);
  }
}

/** 等排进队列的事（getUserMedia 的结果、录音器的事件）都到了 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function setup(options: { grant?: "auto" | "manual"; permission?: { denied: boolean }; hidden?: boolean } = {}) {
  const browser = new FakeBrowser();
  browser.grant = options.grant ?? "auto";
  browser.hidden = options.hidden ?? false;
  const recorded: RecordedVoice[] = [];
  const session = new VoiceSession(browser.env(options.permission));
  session.onRecorded((voice) => recorded.push(voice));
  return { browser, session, recorded };
}

describe("预热：进语音模式就备好麦克风，但不录", () => {
  test("进语音模式：要麦克风、接好音量分析，不建也不启动录音器，不产生录音数据", async () => {
    const { browser, session, recorded } = setup();
    session.enter();
    await settle();
    expect(browser.requests).toHaveLength(1);
    expect(browser.requests[0]!.constraints).toEqual({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    expect(browser.liveStreams()).toHaveLength(1);
    expect(browser.meters[0]!.stream).toBe(browser.streams[0]);
    expect(browser.recorders).toEqual([]);
    expect(recorded).toEqual([]);
    // 一直放着也不录；音量面板只在按住时显示
    browser.advance(5 * 60_000);
    await settle();
    expect(browser.startedRecorders()).toEqual([]);
    expect(session.getState().phase).toBe("idle");
  });

  test("按下：就在按下这一步同步启动录音器，不出「准备中」，计时从按下算起；抬手发送，麦克风不关，接着录下一条", async () => {
    const { browser, session, recorded } = setup();
    session.enter();
    await settle();
    // 按下事件的时刻比处理它时早一点（手指落下 → 事件到达）
    const pressedAt = browser.clock - 12;
    session.press(500, pressedAt);
    // 不用等：这一步里录音器已经开始了
    expect(browser.startedRecorders()).toHaveLength(1);
    expect(browser.recorders[0]!.stream).toBe(browser.streams[0]);
    expect(session.getState()).toMatchObject({ phase: "recording", startedAt: pressedAt });
    await settle();

    browser.advance(2000);
    session.release(browser.clock);
    await settle();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ mime: "audio/webm;codecs=opus", durationMs: 2012, capture: { prewarmed: true, startDelayMs: 12 } });
    expect(await recorded[0]!.blob.text()).toBe("opus-audio");
    // 录完一条，流不关
    expect(browser.liveStreams()).toHaveLength(1);

    // 下一条：还是同一个流，不再要麦克风
    session.press(500, browser.clock);
    expect(browser.startedRecorders()).toHaveLength(2);
    await settle();
    browser.advance(1500);
    session.release(browser.clock);
    await settle();
    expect(recorded).toHaveLength(2);
    expect(recorded[1]!.capture).toEqual({ prewarmed: true, startDelayMs: 0 });
    expect(browser.requests).toHaveLength(1);
  });

  test("上划取消、太短：这一段丢掉，麦克风不关", async () => {
    const { browser, session, recorded } = setup();
    session.enter();
    await settle();
    session.press(500, browser.clock);
    session.move(400);
    browser.advance(2000);
    session.release(browser.clock);
    session.press(500, browser.clock);
    browser.advance(300);
    session.release(browser.clock);
    await settle();
    expect(recorded).toEqual([]);
    expect(session.getState().notice?.kind).toBe("too_short");
    expect(browser.recorders.map((r) => r.state)).toEqual(["inactive", "inactive"]);
    expect(browser.liveStreams()).toHaveLength(1);
  });

  test("iOS 上没有用户手势时建的音量分析是挂起的：按下时把它唤醒，录着的时候音量才有起伏", async () => {
    const { browser, session } = setup();
    browser.suspendedMeters = true;
    session.enter();
    await settle();
    expect(browser.meters[0]!.woken).toBe(0);
    session.press(500, browser.clock);
    expect(browser.meters[0]!.woken).toBe(1);
    session.frame(browser.clock);
    expect(session.getState().level).toBeGreaterThan(0);
  });
});

describe("关掉麦克风：所有音轨停掉（指示灯熄灭）", () => {
  test("离开语音模式（切回文字、输入框卸下）", async () => {
    const { browser, session } = setup();
    session.enter();
    await settle();
    session.leave();
    expect(browser.liveStreams()).toEqual([]);
    expect(browser.meters[0]!.closed).toBe(true);
  });

  test("页面切到后台；回到前台且仍在语音模式时重新预热（还是不录）", async () => {
    const { browser, session } = setup();
    session.enter();
    await settle();
    browser.setHidden(true);
    expect(browser.liveStreams()).toEqual([]);
    expect(browser.meters[0]!.closed).toBe(true);
    browser.setHidden(false);
    await settle();
    expect(browser.requests).toHaveLength(2);
    expect(browser.liveStreams()).toHaveLength(1);
    expect(browser.startedRecorders()).toEqual([]);
    // 离开语音模式之后再切前后台：不再要
    session.leave();
    browser.setHidden(true);
    browser.setHidden(false);
    await settle();
    expect(browser.requests).toHaveLength(2);
    expect(browser.liveStreams()).toEqual([]);
  });

  test("按着的时候切到后台：这一段丢掉不发，音轨停掉", async () => {
    const { browser, session, recorded } = setup();
    session.enter();
    await settle();
    session.press(500, browser.clock);
    browser.advance(3000);
    browser.setHidden(true);
    await settle();
    expect(session.getState().phase).toBe("idle");
    expect(recorded).toEqual([]);
    expect(browser.liveStreams()).toEqual([]);
  });

  test("语音模式里很久不按也不关（44 号票）：放着几个小时、录完一条后再放着，麦克风一直开着，按下即录", async () => {
    const { browser, session, recorded } = setup();
    session.enter();
    await settle();
    browser.advance(3 * 60 * 60_000);
    await settle();
    expect(browser.liveStreams()).toHaveLength(1);
    expect(browser.meters[0]!.closed).toBe(false);

    session.press(500, browser.clock);
    browser.advance(2000);
    session.release(browser.clock);
    await settle();
    browser.advance(3 * 60 * 60_000);
    await settle();
    expect(browser.liveStreams()).toHaveLength(1);
    session.press(500, browser.clock);
    expect(session.getState().phase).toBe("recording");
    browser.advance(1500);
    session.release(browser.clock);
    await settle();
    expect(recorded.map((v) => v.capture.prewarmed)).toEqual([true, true]);
    // 一直是进语音模式时打开的那一个流，没有关了再要
    expect(browser.requests).toHaveLength(1);
  });

});

describe("流还没就绪", () => {
  test("刚进语音模式就按（预热还没好）：「准备中」，不重复要麦克风，就绪就开始录，量出按下到开录的毫秒数", async () => {
    const { browser, session, recorded } = setup({ grant: "manual" });
    session.enter();
    const pressedAt = browser.clock;
    session.press(500, pressedAt);
    expect(session.getState().phase).toBe("starting");
    expect(browser.recorders).toEqual([]);
    expect(browser.requests).toHaveLength(1);
    browser.advance(300);
    browser.requests[0]!.resolve();
    await settle();
    expect(session.getState()).toMatchObject({ phase: "recording", startedAt: pressedAt + 300 });
    expect(browser.startedRecorders()).toHaveLength(1);
    browser.advance(2000);
    session.release(browser.clock);
    await settle();
    expect(recorded[0]!.capture).toEqual({ prewarmed: false, startDelayMs: 300 });
    // 录完照常预热着
    expect(browser.liveStreams()).toHaveLength(1);
  });

  test("要麦克风的时候离开了语音模式：要到了也马上停掉，不录", async () => {
    const { browser, session } = setup({ grant: "manual" });
    session.enter();
    session.leave();
    browser.requests[0]!.resolve();
    await settle();
    expect(browser.liveStreams()).toEqual([]);
    expect(browser.recorders).toEqual([]);
  });

  test("麦克风被系统收走了（音轨结束了）：按下时重新打开，照旧「准备中」", async () => {
    const { browser, session } = setup();
    session.enter();
    await settle();
    browser.streams[0]!.tracks[0]!.readyState = "ended";
    session.press(500, browser.clock);
    expect(session.getState().phase).toBe("starting");
    await settle();
    expect(browser.requests).toHaveLength(2);
    expect(session.getState().phase).toBe("recording");
    expect(browser.recorders[0]!.stream).toBe(browser.streams[1]);
  });
});

describe("权限", () => {
  test("第一次进语音模式时要麦克风；被拒了提示怎么开，之后不反复弹（切后台再回来、重新进语音模式）；按下时照样要", async () => {
    const permission = { denied: false };
    const { browser, session } = setup({ grant: "manual", permission });
    session.enter();
    browser.requests[0]!.reject(new DOMException("Permission denied", "NotAllowedError"));
    await settle();
    expect(session.getState().notice).toMatchObject({ kind: "denied", text: expect.stringMatching(/没有麦克风权限/) });
    expect(browser.liveStreams()).toEqual([]);

    browser.setHidden(true);
    browser.setHidden(false);
    session.leave();
    const again = new VoiceSession(browser.env(permission));
    again.enter();
    await settle();
    expect(browser.requests).toHaveLength(1);

    // 按下是用户自己的动作：照样要；要到了就录，之后照常预热
    again.press(500, browser.clock);
    expect(browser.requests).toHaveLength(2);
    browser.requests[1]!.resolve();
    await settle();
    expect(again.getState().phase).toBe("recording");
    expect(permission.denied).toBe(false);
  });

  test("按下时又被拒：这一段不录，提示怎么开", async () => {
    const { browser, session } = setup({ grant: "manual", permission: { denied: true } });
    session.enter();
    expect(browser.requests).toEqual([]);
    session.press(500, browser.clock);
    browser.requests[0]!.reject(new DOMException("Permission denied", "NotAllowedError"));
    await settle();
    expect(session.getState()).toMatchObject({ phase: "idle", notice: { kind: "denied" } });
    expect(browser.recorders).toEqual([]);
    session.release(browser.clock);
    await settle();
    expect(browser.requests).toHaveLength(1);
  });

  test("没有麦克风、被别的程序占着：提示，先歇着不反复试；按下时再试一次，又失败也只试这一次", async () => {
    const { browser, session } = setup({ grant: "manual" });
    session.enter();
    browser.requests[0]!.reject(new DOMException("Requested device not found", "NotFoundError"));
    await settle();
    expect(session.getState().notice).toMatchObject({ kind: "failed", text: "没找到麦克风" });
    browser.advance(20 * 60_000);
    await settle();
    expect(browser.requests).toHaveLength(1);
    session.press(500, browser.clock);
    expect(browser.requests).toHaveLength(2);
    browser.requests[1]!.reject(new DOMException("Could not start audio source", "NotReadableError"));
    await settle();
    expect(session.getState()).toMatchObject({ phase: "idle", notice: { kind: "failed", text: expect.stringMatching(/被别的程序占着/) } });
    session.release(browser.clock);
    await settle();
    expect(browser.requests).toHaveLength(2);
  });

  test("进语音模式时页面在后台：等回到前台再要", async () => {
    const { browser, session } = setup({ hidden: true });
    session.enter();
    await settle();
    expect(browser.requests).toEqual([]);
    browser.setHidden(false);
    await settle();
    expect(browser.liveStreams()).toHaveLength(1);
  });
});

// 36 号票评审加的两种兜底（app/voice-fallbacks.ts，默认都不开）：语音模式里麦克风一直开着、回声消除开着，
// 可能把 agent 语音的播放拖进通话模式（通话音量、听筒、蓝牙切到 SCO）。真机对比后再定开哪个。
/** 开着某种兜底的会话 */
function setupWith(fallbacks: { releaseMicWhilePlaying: boolean; disableEchoCancellation: boolean }) {
  const browser = new FakeBrowser();
  const session = new VoiceSession({ ...browser.env(), fallbacks });
  return { browser, session };
}

describe("兜底：语音模式里开着的麦克风影响播放", () => {
  test("默认（都不开）：有语音在播时麦克风照样开着，按下即录；要麦克风时回声消除开着", async () => {
    const { browser, session } = setup();
    session.enter();
    await settle();
    session.setPlayback(true);
    await settle();
    expect(browser.liveStreams()).toHaveLength(1);
    session.press(500, browser.clock);
    expect(session.getState().phase).toBe("recording");
    expect(browser.requests[0]!.constraints).toMatchObject({ audio: { echoCancellation: true } });
  });

  test("(a) 播放时关麦：有语音在播就停掉所有音轨，播完再预热；播放期间按下要等「准备中」", async () => {
    const { browser, session } = setupWith({ releaseMicWhilePlaying: true, disableEchoCancellation: false });
    session.enter();
    await settle();
    session.setPlayback(true);
    expect(browser.liveStreams()).toEqual([]);
    session.setPlayback(false);
    await settle();
    expect(browser.liveStreams()).toHaveLength(1);
    expect(browser.requests).toHaveLength(2);

    session.setPlayback(true);
    browser.grant = "manual";
    session.press(500, browser.clock);
    expect(session.getState().phase).toBe("starting");
    browser.advance(300);
    browser.requests[2]!.resolve();
    await settle();
    expect(session.getState().phase).toBe("recording");
    expect(browser.startedRecorders()).toHaveLength(1);
  });

  test("(b) 关掉回声消除：要麦克风时 echoCancellation 是 false（降噪、自动增益照旧开着），按下即录不变", async () => {
    const { browser, session } = setupWith({ releaseMicWhilePlaying: false, disableEchoCancellation: true });
    session.enter();
    await settle();
    expect(browser.requests[0]!.constraints).toEqual({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
    session.setPlayback(true);
    expect(browser.liveStreams()).toHaveLength(1);
    session.press(500, browser.clock);
    expect(session.getState().phase).toBe("recording");
  });
});
