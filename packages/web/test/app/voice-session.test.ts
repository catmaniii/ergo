// "按住 说话"在浏览器里的那一半（37 号票，app/voice-session.ts）：麦克风预热——进语音模式就打开麦克风流、接好音量分析，
// 但不录（录音器按下才开始）；离开语音模式、页面切到后台时停掉所有音轨，回到前台再预热；语音模式里闲置不关（44 号票）。
// 61 号票：打字、分屏时让路，焦点回来 0.5 秒后再预热；按下时音轨失效了就重开、录完整段是静音就不发；麦克风诊断记录。
// 浏览器的 getUserMedia、MediaRecorder、AudioContext、音轨事件、页面的前后台、焦点、计时器和时钟都换成假的。
import { describe, expect, test } from "vitest";
import { VoiceMicLog } from "../../src/app/voice-mic-log.ts";
import type { MicMeter, MicRecorder, MicStream, MicTrack, VoiceMedia } from "../../src/app/voice-recorder.ts";
import { type RecordedVoice, VoiceSession, type VoiceSessionEnv } from "../../src/app/voice-session.ts";

class FakeTrack implements MicTrack {
  readyState: "live" | "ended" = "live";
  muted = false;
  private readonly listeners = new Map<string, Array<() => void>>();
  stop(): void {
    this.readyState = "ended";
  }
  addEventListener(type: "mute" | "unmute" | "ended", listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  /** 系统把音轨静音了（iOS 听写打断录音、被优先级更高的应用拿走）或者恢复了 */
  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const l of this.listeners.get(muted ? "mute" : "unmute") ?? []) l();
  }
  /** 系统收走了麦克风（音轨结束了；页面自己 stop 不发这个事件） */
  end(): void {
    this.readyState = "ended";
    for (const l of this.listeners.get("ended") ?? []) l();
  }
}

class FakeStream implements MicStream {
  readonly tracks: FakeTrack[];
  constructor(muted = false) {
    const track = new FakeTrack();
    track.muted = muted;
    this.tracks = [track];
  }
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
  /** 唤醒不了（按下不算用户手势时，iOS 上的 AudioContext 一直挂着） */
  stuck = false;
  /** 流里的声音（振幅）：0 是数字静音 */
  amplitude = 0.1;
  woken = 0;
  closed = false;
  readonly stream: MicStream;
  constructor(stream: MicStream, suspended: boolean) {
    this.stream = stream;
    this.suspended = suspended;
  }
  get running(): boolean {
    return !this.suspended;
  }
  read(buffer: Float32Array<ArrayBuffer>): void {
    // 挂起时读到的全是 0
    buffer.fill(this.suspended ? 0 : this.amplitude);
  }
  wake(): void {
    this.woken += 1;
    if (!this.stuck) this.suspended = false;
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

/** 一个计时器（到点由 advance 触发） */
interface FakeTimer {
  at: number;
  fn: () => void;
  cancelled: boolean;
}

class FakeBrowser {
  clock = 1_000_000;
  hidden = false;
  /** 窗口有系统焦点 */
  focused = true;
  /** 焦点在可输入的元素上 */
  editing = false;
  private readonly timers: FakeTimer[] = [];
  private readonly focusListeners = new Set<() => void>();
  /** 要麦克风的请求：自动给（auto）还是等测试来给 */
  grant: "auto" | "manual" = "auto";
  readonly requests: MicRequest[] = [];
  readonly streams: FakeStream[] = [];
  readonly recorders: FakeRecorder[] = [];
  readonly meters: FakeMeter[] = [];
  /** 建出来的音量分析是挂起的（iOS 上没有用户手势时） */
  suspendedMeters = false;
  /** 新打开的流一开始就是静音的（系统层面把麦克风静音了） */
  mutedStreams = false;
  private readonly visibility = new Set<() => void>();

  readonly media: VoiceMedia = {
    getUserMedia: (constraints) =>
      new Promise<MicStream>((resolve, reject) => {
        const request: MicRequest = {
          constraints,
          resolve: () => {
            const stream = new FakeStream(this.mutedStreams);
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

  /** 页面上的麦克风诊断记录（离开、重新进语音模式时接着记），每条带上那一刻的页面信号 */
  readonly micLog = new VoiceMicLog(() => ({ hasFocus: this.focused, visibility: this.hidden ? "hidden" : "visible" }));

  env(permission = { denied: false }): VoiceSessionEnv {
    return {
      media: this.media,
      micLog: this.micLog,
      userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/149.0.0.0 Mobile",
      page: {
        hidden: () => this.hidden,
        onVisibilityChange: (listener) => {
          this.visibility.add(listener);
          return () => this.visibility.delete(listener);
        },
        focused: () => this.focused,
        editing: () => this.editing,
        onFocusChange: (listener) => {
          this.focusListeners.add(listener);
          return () => this.focusListeners.delete(listener);
        },
      },
      now: () => this.clock,
      setTimer: (fn, ms) => {
        const timer: FakeTimer = { at: this.clock + ms, fn, cancelled: false };
        this.timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      permission,
    };
  }

  /** 时间往前走：到点的计时器依次触发 */
  advance(ms: number): void {
    const until = this.clock + ms;
    for (;;) {
      const due = this.timers.filter((t) => !t.cancelled && t.at <= until).toSorted((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.cancelled = true;
      this.clock = Math.max(this.clock, due.at);
      due.fn();
    }
    this.clock = until;
  }

  /** 还没到点的计时器有几个 */
  pendingTimers(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.visibility) listener();
  }

  /** 焦点进出可输入的元素（输入框、textarea、contenteditable） */
  setEditing(editing: boolean): void {
    this.editing = editing;
    for (const listener of this.focusListeners) listener();
  }

  /** 窗口得到或失去系统焦点（分屏切到另一边） */
  setFocused(focused: boolean): void {
    this.focused = focused;
    for (const listener of this.focusListeners) listener();
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
    expect(recorded[1]!.capture).toMatchObject({ prewarmed: true, startDelayMs: 0, openReason: "enter", gumMs: 0 });
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

// 61 号票（用户 2026-10-09 反馈"麦克风被占用"）：页面里可输入的元素拿到焦点、窗口失去焦点（分屏）时真正停掉音轨，
// 让系统输入法的语音能用；焦点回来 0.5 秒后（仍在语音模式、页面在前台）重新预热。
describe("让路：打字、分屏时放开麦克风，回来再预热", () => {
  test("输入框拿到焦点：立即停掉所有音轨、关掉音量分析；离开 0.5 秒后重新打开（新的流），还是不录", async () => {
    const { browser, session } = setup();
    session.enter();
    await settle();
    browser.setEditing(true);
    expect(browser.liveStreams()).toEqual([]);
    expect(browser.meters[0]!.closed).toBe(true);
    // 打字打了一会儿
    browser.advance(10_000);
    await settle();
    expect(browser.requests).toHaveLength(1);

    browser.setEditing(false);
    browser.advance(499);
    await settle();
    expect(browser.requests).toHaveLength(1);
    expect(browser.liveStreams()).toEqual([]);
    browser.advance(1);
    await settle();
    expect(browser.requests).toHaveLength(2);
    expect(browser.liveStreams()).toEqual([browser.streams[1]]);
    expect(browser.startedRecorders()).toEqual([]);
    // 回来之后按下即录
    session.press(500, browser.clock);
    expect(session.getState().phase).toBe("recording");
  });

  test("焦点在输入框之间跳（离开又马上进另一个）：一直放着，最后一次离开 0.5 秒后才开", async () => {
    const { browser, session } = setup();
    session.enter();
    await settle();
    browser.setEditing(true);
    browser.setEditing(false);
    browser.advance(100);
    browser.setEditing(true);
    browser.advance(1000);
    await settle();
    expect(browser.requests).toHaveLength(1);
    browser.setEditing(false);
    browser.advance(400);
    await settle();
    expect(browser.requests).toHaveLength(1);
    browser.advance(100);
    await settle();
    expect(browser.requests).toHaveLength(2);
    expect(browser.liveStreams()).toHaveLength(1);
  });

  test("窗口失去焦点（分屏切到另一边，页面还看得见）：放开；窗口回来 0.5 秒后重新预热", async () => {
    const { browser, session } = setup();
    session.enter();
    await settle();
    browser.setFocused(false);
    expect(browser.liveStreams()).toEqual([]);
    browser.advance(5000);
    browser.setFocused(true);
    browser.advance(499);
    await settle();
    expect(browser.requests).toHaveLength(1);
    browser.advance(1);
    await settle();
    expect(browser.requests).toHaveLength(2);
    expect(browser.liveStreams()).toHaveLength(1);
  });

  test("从后台回来、窗口同时拿回焦点（两种先后）：按回到前台算，马上预热，原因记 visible，不等 0.5 秒", async () => {
    // 走的时候先失焦、后切后台；回来时 visibilitychange 先到、窗口的 focus 后到
    const a = setup();
    a.session.enter();
    await settle();
    a.browser.setFocused(false);
    a.browser.setHidden(true);
    a.browser.advance(5000);
    a.browser.setHidden(false);
    await settle();
    expect(a.browser.liveStreams()).toHaveLength(1);
    a.browser.setFocused(true);
    a.browser.advance(1000);
    await settle();
    expect(a.browser.requests).toHaveLength(2);
    await hold(a.browser, a.session, 1500);
    expect(a.recorded[0]!.capture).toMatchObject({ prewarmed: true, openReason: "visible" });

    // 走的时候先切后台、后失焦；回来时窗口的 focus 先到
    const b = setup();
    b.session.enter();
    await settle();
    b.browser.setHidden(true);
    b.browser.setFocused(false);
    b.browser.advance(5000);
    b.browser.setFocused(true);
    b.browser.setHidden(false);
    await settle();
    expect(b.browser.liveStreams()).toHaveLength(1);
    b.browser.advance(1000);
    await settle();
    expect(b.browser.requests).toHaveLength(2);
    await hold(b.browser, b.session, 1500);
    expect(b.recorded[0]!.capture).toMatchObject({ prewarmed: true, openReason: "visible" });
  });

  test("回来的 0.5 秒里离开了语音模式或切到后台：不开", async () => {
    const { browser, session } = setup();
    session.enter();
    await settle();
    browser.setEditing(true);
    browser.setEditing(false);
    session.leave();
    browser.advance(1000);
    await settle();
    expect(browser.requests).toHaveLength(1);
    expect(browser.pendingTimers()).toBe(0);

    const other = setup();
    other.session.enter();
    await settle();
    other.browser.setFocused(false);
    other.browser.setFocused(true);
    other.browser.setHidden(true);
    other.browser.advance(1000);
    await settle();
    expect(other.browser.requests).toHaveLength(1);
    expect(other.browser.liveStreams()).toEqual([]);
  });

  test("按住说话的时候焦点变了不打断：照样录完发出去；抬手时焦点还在输入框里就放开", async () => {
    const { browser, session, recorded } = setup();
    session.enter();
    await settle();
    session.press(500, browser.clock);
    browser.advance(500);
    browser.setEditing(true);
    browser.setFocused(false);
    browser.setFocused(true);
    expect(browser.liveStreams()).toHaveLength(1);
    expect(browser.recorders[0]!.state).toBe("recording");
    browser.advance(1500);
    session.release(browser.clock);
    await settle();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.capture.prewarmed).toBe(true);
    // 抬手了，焦点还在输入框里：让给输入法
    expect(browser.liveStreams()).toEqual([]);
  });

  test("「按住 说话」不是输入元素：焦点从输入框移到它上面（按下）时马上要麦克风，抬手后接着开着，不用再等", async () => {
    const { browser, session, recorded } = setup();
    session.enter();
    await settle();
    browser.setEditing(true);
    expect(browser.liveStreams()).toEqual([]);
    // 按下：先到的是 pointerdown（要麦克风，「准备中」），焦点随后离开输入框
    session.press(500, browser.clock);
    browser.setEditing(false);
    expect(session.getState().phase).toBe("starting");
    await settle();
    expect(session.getState().phase).toBe("recording");
    browser.advance(2000);
    session.release(browser.clock);
    await settle();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.capture.prewarmed).toBe(false);
    expect(browser.liveStreams()).toHaveLength(1);
    browser.advance(1000);
    await settle();
    expect(browser.requests).toHaveLength(2);
  });

  test("进语音模式时焦点在输入框里（比如「发起任务」对话框开着）或窗口没有焦点：先不要麦克风", async () => {
    const editing = setup();
    editing.browser.editing = true;
    editing.session.enter();
    await settle();
    expect(editing.browser.requests).toEqual([]);
    editing.browser.setEditing(false);
    editing.browser.advance(500);
    await settle();
    expect(editing.browser.liveStreams()).toHaveLength(1);

    const blurred = setup();
    blurred.browser.focused = false;
    blurred.session.enter();
    await settle();
    expect(blurred.browser.requests).toEqual([]);
  });

  test("离开语音模式之后：焦点怎么变都不再要麦克风", async () => {
    const { browser, session } = setup();
    session.enter();
    await settle();
    session.leave();
    browser.setEditing(true);
    browser.setEditing(false);
    browser.setFocused(false);
    browser.setFocused(true);
    browser.advance(1000);
    await settle();
    expect(browser.requests).toHaveLength(1);
    expect(browser.liveStreams()).toEqual([]);
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
    // 冷启动：getUserMedia 从调用到返回 300 毫秒，这个流是进语音模式时要的
    expect(recorded[0]!.capture).toMatchObject({ prewarmed: false, startDelayMs: 300, openReason: "enter", gumMs: 300 });
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
    browser.streams[0]!.tracks[0]!.end();
    session.press(500, browser.clock);
    expect(session.getState().phase).toBe("starting");
    await settle();
    expect(browser.requests).toHaveLength(2);
    expect(session.getState().phase).toBe("recording");
    expect(browser.recorders[0]!.stream).toBe(browser.streams[1]);
  });

  test("预热的音轨被系统静音了（iOS 听写打断过、被别的应用拿走）：按下时当作没预热，放掉旧的、重新打开，照旧「准备中」，录的是新的流", async () => {
    const { browser, session, recorded } = setup();
    session.enter();
    await settle();
    browser.streams[0]!.tracks[0]!.setMuted(true);
    session.press(500, browser.clock);
    expect(session.getState().phase).toBe("starting");
    expect(browser.streams[0]!.live).toBe(false);
    await settle();
    expect(browser.requests).toHaveLength(2);
    expect(session.getState().phase).toBe("recording");
    expect(browser.recorders[0]!.stream).toBe(browser.streams[1]);
    browser.advance(2000);
    session.release(browser.clock);
    await settle();
    expect(recorded[0]!.capture).toMatchObject({ prewarmed: false, openReason: "stale" });
  });

  test("新打开的流一开始就是静音的（系统层面把麦克风静音了）：不会反复重开；按下时重开一次，照样能录", async () => {
    const { browser, session, recorded } = setup();
    browser.mutedStreams = true;
    session.enter();
    await settle();
    expect(browser.requests).toHaveLength(1);
    expect(browser.liveStreams()).toHaveLength(1);
    browser.setHidden(true);
    browser.setHidden(false);
    await settle();
    expect(browser.requests).toHaveLength(2);
    session.press(500, browser.clock);
    await settle();
    expect(browser.requests).toHaveLength(3);
    expect(session.getState().phase).toBe("recording");
    browser.advance(1500);
    session.release(browser.clock);
    await settle();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.capture).toMatchObject({ prewarmed: false, openReason: "stale" });
    expect(browser.requests).toHaveLength(3);
  });

  test("静音后又恢复了（unmute）：照旧按下即录", async () => {
    const { browser, session } = setup();
    session.enter();
    await settle();
    browser.streams[0]!.tracks[0]!.setMuted(true);
    browser.streams[0]!.tracks[0]!.setMuted(false);
    session.press(500, browser.clock);
    expect(session.getState().phase).toBe("recording");
    expect(browser.requests).toHaveLength(1);
  });
});

/** 按住（没预热好的等麦克风就绪）录 ms 毫秒（每一帧走一次时钟、采音量），然后抬手 */
async function hold(browser: FakeBrowser, session: VoiceSession, ms: number): Promise<void> {
  session.press(500, browser.clock);
  await settle();
  for (let t = 0; t < ms; t += 50) {
    browser.advance(50);
    session.frame(browser.clock);
  }
  session.release(browser.clock);
  await settle();
}

describe("不发空白语音：录完的一段整段是静音就不发", () => {
  test("整段全零（安卓上麦克风被别的应用占着时 Chrome 收到的）：不发送，提示「没录到声音，再按一次试试」；放掉这个流马上重新打开，下一条照常发", async () => {
    const { browser, session, recorded } = setup();
    session.enter();
    await settle();
    browser.meters[0]!.amplitude = 0;
    await hold(browser, session, 2000);
    expect(recorded).toEqual([]);
    expect(session.getState().notice).toMatchObject({ text: "没录到声音，再按一次试试" });
    // 这个流可能已经被系统静音了：换一个新的
    expect(browser.streams[0]!.live).toBe(false);
    expect(browser.requests).toHaveLength(2);
    expect(browser.liveStreams()).toEqual([browser.streams[1]]);

    await hold(browser, session, 2000);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.capture).toMatchObject({ prewarmed: true, openReason: "silent", peak: 0.1 });
  });

  test("不是全零、但音量一直低于阈值：同样不发", async () => {
    const { browser, session, recorded } = setup();
    session.enter();
    await settle();
    browser.meters[0]!.amplitude = 0.0005;
    await hold(browser, session, 1500);
    expect(recorded).toEqual([]);
    expect(session.getState().notice?.text).toBe("没录到声音，再按一次试试");
  });

  test("音量分析没在跑（iOS 上挂起、唤醒不了，读到的全是 0）：判断不了，照常发送", async () => {
    const { browser, session, recorded } = setup();
    browser.suspendedMeters = true;
    session.enter();
    await settle();
    browser.meters[0]!.stuck = true;
    await hold(browser, session, 2000);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.capture).not.toHaveProperty("peak");
    expect(browser.requests).toHaveLength(1);
  });

  test("有声音的照常发送，带上这一段量到的最大振幅", async () => {
    const { browser, session, recorded } = setup();
    session.enter();
    await settle();
    browser.meters[0]!.amplitude = 0.02;
    await hold(browser, session, 2000);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.capture.peak).toBe(0.02);
    expect(session.getState().notice).toBeUndefined();
  });
});

// 61 号票：随每条语音带上麦克风的诊断，守护进程存进语音对象的 capture，用户在真机上试完后在本机接口看
describe("诊断记录：这次开麦的原因、冷启动耗时、最近的麦克风开关、浏览器", () => {
  test("一条语音带上：录它的流为什么开、getUserMedia 花了多久、最近的开关（相对按下的毫秒数和原因）、UA", async () => {
    const { browser, session, recorded } = setup({ grant: "manual" });
    const t0 = browser.clock;
    session.enter();
    browser.advance(200);
    browser.requests[0]!.resolve();
    await settle();
    // 打开"发起任务"打字，3 秒后关掉
    browser.advance(1000);
    browser.setEditing(true);
    browser.advance(3000);
    browser.setEditing(false);
    browser.advance(500);
    browser.advance(120);
    browser.requests[1]!.resolve();
    await settle();
    browser.advance(2000);
    const pressedAt = browser.clock;
    expect(pressedAt - t0).toBe(6820);
    session.press(500, pressedAt);
    await settle();
    browser.advance(1500);
    session.release(browser.clock);
    await settle();

    expect(recorded[0]!.capture).toEqual({
      prewarmed: true,
      startDelayMs: 0,
      openReason: "edit-out",
      gumMs: 120,
      // 每条带上那一刻的页面信号（document.hasFocus()、visibilityState）
      micLog: [
        { atMs: -6820, event: "open", reason: "enter", hasFocus: true, visibility: "visible" },
        { atMs: -6620, event: "ready", ms: 200, hasFocus: true, visibility: "visible" },
        { atMs: -5620, event: "close", reason: "edit-in", hasFocus: true, visibility: "visible" },
        { atMs: -2120, event: "open", reason: "edit-out", hasFocus: true, visibility: "visible" },
        { atMs: -2000, event: "ready", ms: 120, hasFocus: true, visibility: "visible" },
      ],
      browser: "Mozilla/5.0 (Linux; Android 14) Chrome/149.0.0.0 Mobile",
    });
  });

  test("分屏、切后台、离开语音模式的关和开；音轨被系统静音、恢复、收走；按下时重开记成 stale；整段静音记 silent", async () => {
    const { browser, session, recorded } = setup();
    session.enter();
    await settle();
    browser.setFocused(false);
    browser.setFocused(true);
    browser.advance(500);
    await settle();
    browser.setHidden(true);
    browser.setHidden(false);
    await settle();
    browser.streams[2]!.tracks[0]!.setMuted(true);
    browser.streams[2]!.tracks[0]!.setMuted(false);
    browser.streams[2]!.tracks[0]!.setMuted(true);
    browser.advance(1000);
    // 静音的流按下：放掉重开
    await hold(browser, session, 1500);
    browser.meters[3]!.amplitude = 0;
    browser.advance(1000);
    await hold(browser, session, 1500);
    await settle();
    browser.advance(1000);
    browser.meters[4]!.amplitude = 0.3;
    browser.streams[4]!.tracks[0]!.end();
    await hold(browser, session, 1500);

    expect(recorded).toHaveLength(2);
    const events = (n: number) => recorded[n]!.capture.micLog!.map((e) => [e.event, e.reason ?? e.ms ?? ""].join(" ").trim());
    expect(events(0)).toEqual([
      "open enter",
      "ready 0",
      "close blur",
      "open focus",
      "ready 0",
      "close hidden",
      "open visible",
      "ready 0",
      "mute",
      "unmute",
      "mute",
      "close stale",
      "open stale",
      "ready 0",
    ]);
    expect(recorded[0]!.capture.openReason).toBe("stale");
    // 页面信号：窗口失焦关的那一条 hasFocus 为假，切后台关的那一条 visibility 是 hidden
    expect(recorded[0]!.capture.micLog![2]).toMatchObject({ event: "close", reason: "blur", hasFocus: false, visibility: "visible" });
    expect(recorded[0]!.capture.micLog![5]).toMatchObject({ event: "close", reason: "hidden", visibility: "hidden" });
    expect(events(1)).toEqual([...events(0), "silent 1500", "close silent", "open silent", "ready 0", "ended", "close stale", "open stale", "ready 0"]);
    expect(recorded[1]!.capture.openReason).toBe("stale");
  });

  test("只留最近 40 条：放得下最近 10 次以上完整的开关（每次 open、ready、close 三条）", async () => {
    const { browser, session } = setup();
    for (let i = 0; i < 15; i++) {
      session.enter();
      await settle();
      session.leave();
    }
    const again = new VoiceSession(browser.env());
    const recorded: RecordedVoice[] = [];
    again.onRecorded((v) => recorded.push(v));
    again.enter();
    await settle();
    await hold(browser, again, 1500);
    const log = recorded[0]!.capture.micLog!;
    expect(log).toHaveLength(40);
    expect(log.filter((e) => e.event === "close")).toHaveLength(13);
    expect(log.slice(-2).map((e) => [e.event, e.reason])).toEqual([
      ["open", "enter"],
      ["ready", undefined],
    ]);
  });

  test("记录是页面上的：离开语音模式再进来（输入框重新挂上，换了一个会话对象）接着记", async () => {
    const { browser, session } = setup();
    session.enter();
    await settle();
    session.leave();
    const again = new VoiceSession(browser.env());
    const recorded: RecordedVoice[] = [];
    again.onRecorded((v) => recorded.push(v));
    again.enter();
    await settle();
    await hold(browser, again, 1500);
    expect(recorded[0]!.capture.micLog!.map((e) => [e.event, e.reason])).toEqual([
      ["open", "enter"],
      ["ready", undefined],
      ["close", "leave"],
      ["open", "enter"],
      ["ready", undefined],
    ]);
  });

  test("要不到麦克风记 fail（错误名）；没开着的时候关不记", async () => {
    const { browser, session, recorded } = setup({ grant: "manual" });
    session.enter();
    browser.requests[0]!.reject(new DOMException("Permission denied", "NotAllowedError"));
    await settle();
    browser.setHidden(true);
    browser.setHidden(false);
    browser.setEditing(true);
    browser.setEditing(false);
    browser.advance(1000);
    session.press(500, browser.clock);
    browser.advance(100);
    browser.requests[1]!.resolve();
    await settle();
    browser.advance(1500);
    session.release(browser.clock);
    await settle();
    expect(recorded[0]!.capture.micLog!.map((e) => [e.event, e.reason ?? e.ms])).toEqual([
      ["open", "enter"],
      ["fail", "NotAllowedError"],
      ["open", "press"],
      ["ready", 100],
    ]);
    expect(recorded[0]!.capture).toMatchObject({ openReason: "press", gumMs: 100, prewarmed: false });
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
