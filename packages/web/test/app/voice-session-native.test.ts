// 鸿蒙 App 的原生录音（63 号票，app/voice-session.ts 的原生后端，app/voice-native-recorder.ts）：
// 进语音模式时 App 备好录音器（AudioCapturer 的 PREPARED：不采集、不占麦克风），按下才开始，松手停下交出这一段（PCM），
// 网页做成 WAV 照常上传；离开语音模式、切到后台放掉录音器。备好的录音器不挡系统输入法，所以打字、分屏时不用让路。
// 手势（上划取消、太短、60 秒、准备中、计时）、不发空白语音、诊断记录都沿用浏览器的那一套，只换掉底下的采集。
// App 换成假的（FakeApp 实现 native-voice.ts 的 NativeVoice），页面的前后台、焦点、计时器和时钟也是假的。
import { describe, expect, test } from "vitest";
import type { NativeVoice, NativeVoiceEvent, NativeVoicePrepared, NativeVoiceStarted, NativeVoiceTake } from "../../src/app/native-voice.ts";
import { VoiceMicLog } from "../../src/app/voice-mic-log.ts";
import type { VoiceMedia } from "../../src/app/voice-recorder.ts";
import { type RecordedVoice, VoiceSession, type VoiceSessionEnv } from "../../src/app/voice-session.ts";

/** 16 位小端 PCM */
function pcm16(samples: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return bytes;
}

/** 假的 App：记下网页调了什么；备好可以马上回、等测试来回、失败；开始可以失败；能往网页推音量、出错、放掉 */
class FakeApp implements NativeVoice {
  readonly calls: string[] = [];
  /** 现在备好的录音器编号；没有是 undefined */
  capturer: number | undefined;
  recording = false;
  private lastId = 0;
  /** 每放掉一次加一：放掉之前还没备好的那次回 cancelled（真的 App 建好后马上放掉） */
  private generation = 0;
  prepareMode: "auto" | "manual" = "auto";
  readonly pendingPrepares: Array<() => void> = [];
  /** 备好时回失败（没有权限、建不起来） */
  failPrepare: NativeVoicePrepared | undefined;
  /** 开始时回失败（音频焦点被拒） */
  failStart: NativeVoiceStarted | undefined;
  /** 停下时交出的样本（16 位） */
  samples: number[] = [1000, -2000, 3000, -4000, 2000];
  firstDataMs = 30;
  private readonly listeners = new Set<(event: NativeVoiceEvent) => void>();

  prepare(userAction: boolean): Promise<NativeVoicePrepared> {
    this.calls.push(userAction ? "prepare（按下）" : "prepare");
    const generation = this.generation;
    return new Promise((resolve) => {
      const done = () => {
        if (generation !== this.generation) return resolve({ ok: false, reason: "cancelled", message: "还没备好就被放掉了" });
        if (this.failPrepare) return resolve(this.failPrepare);
        this.lastId += 1;
        this.capturer = this.lastId;
        resolve({ ok: true, id: this.capturer, prepareMs: 12.4, state: "PREPARED" });
      };
      if (this.prepareMode === "auto") done();
      else this.pendingPrepares.push(done);
    });
  }

  start(): Promise<NativeVoiceStarted> {
    this.calls.push("start");
    if (this.failStart) return Promise.resolve(this.failStart);
    if (this.capturer === undefined) return Promise.resolve({ ok: false, reason: "failed", message: "录音器还没备好" });
    this.recording = true;
    return Promise.resolve({ ok: true, id: this.capturer });
  }

  stop(): Promise<NativeVoiceTake> {
    this.calls.push("stop");
    if (!this.recording || this.capturer === undefined) return Promise.resolve({ ok: false, reason: "failed", message: "没有在录音" });
    this.recording = false;
    return Promise.resolve({ ok: true, id: this.capturer, pcm: pcm16(this.samples), format: { sampleRate: 16000, channels: 1, bitsPerSample: 16 }, firstDataMs: this.firstDataMs });
  }

  discard(): void {
    this.calls.push("discard");
    this.recording = false;
  }

  release(): void {
    this.calls.push("release");
    this.generation += 1;
    this.capturer = undefined;
    this.recording = false;
  }

  subscribe(listener: (event: NativeVoiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** App 往网页推一条 */
  emit(event: NativeVoiceEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** 备好了、还没开始：录音器在、没在录 */
  get prepared(): boolean {
    return this.capturer !== undefined && !this.recording;
  }
}

interface FakeTimer {
  at: number;
  fn: () => void;
  cancelled: boolean;
}

/** 假的页面：前后台、窗口焦点、输入框焦点、计时器、时钟；浏览器的 getUserMedia 只记下有没有被调 */
class FakePage {
  clock = 1_000_000;
  hidden = false;
  focused = true;
  editing = false;
  getUserMediaCalls = 0;
  private readonly timers: FakeTimer[] = [];
  private readonly visibility = new Set<() => void>();
  private readonly focusListeners = new Set<() => void>();
  readonly micLog = new VoiceMicLog(() => ({ hasFocus: this.focused, visibility: this.hidden ? "hidden" : "visible" }));

  readonly media: VoiceMedia = {
    getUserMedia: () => {
      this.getUserMediaCalls += 1;
      return new Promise(() => undefined);
    },
    createRecorder: () => {
      throw new Error("不该用浏览器的录音器");
    },
    isTypeSupported: () => true,
    createMeter: () => {
      throw new Error("不该用浏览器的音量分析");
    },
  };

  env(native: NativeVoice | undefined, permission = { denied: false }): VoiceSessionEnv {
    return {
      media: this.media,
      ...(native ? { native } : {}),
      micLog: this.micLog,
      userAgent: "Mozilla/5.0 (Phone; OpenHarmony 6.1) Chrome/132.0.0.0 ArkWeb/6.1.0.0 Mobile",
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

  pendingTimers(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.visibility) listener();
  }

  setEditing(editing: boolean): void {
    this.editing = editing;
    for (const listener of this.focusListeners) listener();
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    for (const listener of this.focusListeners) listener();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function setup(options: { permission?: { denied: boolean }; prepareMode?: "auto" | "manual" } = {}) {
  const page = new FakePage();
  const app = new FakeApp();
  app.prepareMode = options.prepareMode ?? "auto";
  const recorded: RecordedVoice[] = [];
  const session = new VoiceSession(page.env(app, options.permission));
  session.onRecorded((voice) => recorded.push(voice));
  return { page, app, session, recorded };
}

/** 按住 ms 毫秒再抬手 */
async function hold(page: FakePage, session: VoiceSession, ms: number): Promise<void> {
  session.press(500, page.clock);
  await settle();
  page.advance(ms);
  session.release(page.clock);
  await settle();
}

/** 读 WAV 头 */
async function wavInfo(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const text = (at: number) => String.fromCharCode(...bytes.slice(at, at + 4));
  return {
    riff: text(0),
    riffSize: view.getUint32(4, true),
    wave: text(8),
    fmt: text(12),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: text(36),
    dataSize: view.getUint32(40, true),
    pcm: bytes.slice(44),
  };
}

describe("原生录音：进语音模式只备好，按下才开始，松手交出这一段", () => {
  test("进语音模式：让 App 备好录音器，不开始，也不用浏览器的 getUserMedia；放着很久也不开始", async () => {
    const { page, app, session, recorded } = setup();
    session.enter();
    await settle();
    expect(app.calls).toEqual(["prepare"]);
    expect(app.prepared).toBe(true);
    page.advance(5 * 60_000);
    await settle();
    expect(app.calls).toEqual(["prepare"]);
    expect(page.getUserMediaCalls).toBe(0);
    expect(recorded).toEqual([]);
    expect(session.getState().phase).toBe("idle");
  });

  test("按下：就在按下这一步让 App 开始，不出「准备中」，计时从按下算起；抬手：App 停下交出 PCM，做成 WAV 发出去；录音器留着，下一条不再备好", async () => {
    const { page, app, session, recorded } = setup();
    session.enter();
    await settle();
    const pressedAt = page.clock - 12;
    session.press(500, pressedAt);
    expect(app.calls).toEqual(["prepare", "start"]);
    expect(session.getState()).toMatchObject({ phase: "recording", startedAt: pressedAt });
    await settle();
    page.advance(2000);
    session.release(page.clock);
    await settle();

    expect(app.calls).toEqual(["prepare", "start", "stop"]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ mime: "audio/wav", durationMs: 2012 });
    const wav = await wavInfo(recorded[0]!.blob);
    expect(recorded[0]!.blob.type).toBe("audio/wav");
    expect(wav).toMatchObject({ riff: "RIFF", riffSize: 36 + 10, wave: "WAVE", fmt: "fmt ", format: 1, channels: 1, sampleRate: 16000, byteRate: 32000, blockAlign: 2, bitsPerSample: 16, data: "data", dataSize: 10 });
    expect([...wav.pcm]).toEqual([...pcm16([1000, -2000, 3000, -4000, 2000])]);
    // 录音器留着：还是备好的，下一条直接开始
    expect(app.prepared).toBe(true);
    await hold(page, session, 1500);
    expect(app.calls).toEqual(["prepare", "start", "stop", "start", "stop"]);
    expect(recorded).toHaveLength(2);
  });

  test("上划取消、太短：App 丢掉这一段，录音器留着", async () => {
    const { page, app, session, recorded } = setup();
    session.enter();
    await settle();
    session.press(500, page.clock);
    session.move(400);
    page.advance(2000);
    session.release(page.clock);
    await settle();
    await hold(page, session, 300);
    expect(app.calls).toEqual(["prepare", "start", "discard", "start", "discard"]);
    expect(session.getState().notice?.kind).toBe("too_short");
    expect(recorded).toEqual([]);
    expect(app.prepared).toBe(true);
  });

  test("录着的时候：App 推过来的音量进录音面板；别的录音器（旧的）推的不算", async () => {
    const { page, app, session } = setup();
    session.enter();
    await settle();
    session.press(500, page.clock);
    await settle();
    app.emit({ type: "level", id: app.capturer!, rms: 0.1 });
    page.advance(100);
    session.frame(page.clock);
    expect(session.getState().level).toBeCloseTo(0.4);
    app.emit({ type: "level", id: app.capturer! + 7, rms: 0.2 });
    page.advance(100);
    session.frame(page.clock);
    expect(session.getState().level).toBeCloseTo(0.4);
    app.emit({ type: "level", id: app.capturer!, rms: 0.5 });
    page.advance(100);
    session.frame(page.clock);
    expect(session.getState().level).toBe(1);
    expect(session.getState().live).toHaveLength(3);
  });
});

describe("原生录音：什么时候放掉录音器", () => {
  test("离开语音模式：放掉；再进来再备好", async () => {
    const { app, session } = setup();
    session.enter();
    await settle();
    session.leave();
    expect(app.calls).toEqual(["prepare", "release"]);
    expect(app.capturer).toBeUndefined();
    session.enter();
    await settle();
    expect(app.calls).toEqual(["prepare", "release", "prepare"]);
  });

  test("切到后台：放掉；回到前台再备好（还是不开始）", async () => {
    const { page, app, session } = setup();
    session.enter();
    await settle();
    page.setHidden(true);
    expect(app.calls).toEqual(["prepare", "release"]);
    page.setHidden(false);
    await settle();
    expect(app.calls).toEqual(["prepare", "release", "prepare"]);
    expect(app.prepared).toBe(true);
  });

  test("按着的时候切到后台：这一段丢掉不发，放掉录音器", async () => {
    const { page, app, session, recorded } = setup();
    session.enter();
    await settle();
    session.press(500, page.clock);
    await settle();
    page.advance(1500);
    page.setHidden(true);
    await settle();
    expect(app.calls).toEqual(["prepare", "start", "release"]);
    expect(recorded).toEqual([]);
    expect(session.getState().phase).toBe("idle");
  });

  test("不用让路：输入框拿到焦点、窗口失去焦点（分屏）时录音器照样备着，没有等回来的计时；按下即录", async () => {
    const { page, app, session, recorded } = setup();
    session.enter();
    await settle();
    page.setEditing(true);
    page.setFocused(false);
    page.setFocused(true);
    page.setEditing(false);
    await settle();
    expect(app.calls).toEqual(["prepare"]);
    expect(page.pendingTimers()).toBe(0);
    page.setEditing(true);
    await hold(page, session, 1500);
    expect(app.calls).toEqual(["prepare", "start", "stop"]);
    expect(recorded[0]!.capture).toMatchObject({ prewarmed: true });
  });

  test("进语音模式时焦点在输入框里（「发起任务」开着）：照样备好", async () => {
    const page = new FakePage();
    page.editing = true;
    page.focused = false;
    const app = new FakeApp();
    const session = new VoiceSession(page.env(app));
    session.enter();
    await settle();
    expect(app.calls).toEqual(["prepare"]);
  });
});

describe("原生录音：还没备好、录音器失效", () => {
  test("刚进语音模式就按（App 还在备）：「准备中」，不重复备；备好了马上开始，从那一刻计时；量出按下到第一块数据", async () => {
    const { page, app, session, recorded } = setup({ prepareMode: "manual" });
    session.enter();
    const pressedAt = page.clock;
    session.press(500, pressedAt);
    expect(session.getState().phase).toBe("starting");
    expect(app.calls).toEqual(["prepare"]);
    page.advance(40);
    app.pendingPrepares[0]!();
    await settle();
    expect(app.calls).toEqual(["prepare", "start"]);
    expect(session.getState()).toMatchObject({ phase: "recording", startedAt: pressedAt + 40 });
    page.advance(1500);
    session.release(page.clock);
    await settle();
    expect(recorded[0]!.capture).toMatchObject({ backend: "native", prewarmed: false, startDelayMs: 40 + 30, firstDataMs: 30 });
  });

  test("还在备的时候离开语音模式：备好了也不开始（App 那边已经放掉）", async () => {
    const { app, session } = setup({ prepareMode: "manual" });
    session.enter();
    session.leave();
    app.pendingPrepares[0]!();
    await settle();
    expect(app.calls).toEqual(["prepare", "release"]);
    expect(session.getState()).toMatchObject({ phase: "idle", notice: undefined });
  });

  test("App 自己放掉了录音器（切到后台时页面没收到、被系统收走）：按下时重新备好（「准备中」），之后照常；旧录音器推过来的不再算", async () => {
    const { page, app, session, recorded } = setup();
    session.enter();
    await settle();
    const old = app.capturer!;
    app.release();
    app.emit({ type: "released", id: old, reason: "background" });
    app.calls.length = 0;
    session.press(500, page.clock);
    expect(session.getState().phase).toBe("starting");
    await settle();
    expect(app.calls).toEqual(["release", "prepare（按下）", "start"]);
    expect(session.getState().phase).toBe("recording");
    app.emit({ type: "error", id: old, reason: "interrupted", message: "旧的" });
    page.advance(1500);
    session.release(page.clock);
    await settle();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.capture.openReason).toBe("stale");
  });

  test("录着的时候 App 说被系统打断了（来电）：这一段不发，提示；放掉录音器，下一次按下再备好", async () => {
    const { page, app, session, recorded } = setup();
    session.enter();
    await settle();
    session.press(500, page.clock);
    await settle();
    page.advance(800);
    app.emit({ type: "error", id: app.capturer!, reason: "interrupted", message: "INTERRUPT_HINT_STOP" });
    await settle();
    expect(session.getState()).toMatchObject({ phase: "idle", notice: { kind: "failed" } });
    expect(session.getState().notice!.text).toContain("打断");
    expect(app.calls).toEqual(["prepare", "start", "release"]);
    session.release(page.clock);
    await settle();
    expect(recorded).toEqual([]);
    // 歇着：不自动重备；按下再备
    page.advance(5000);
    expect(app.calls).toEqual(["prepare", "start", "release"]);
    await hold(page, session, 1500);
    expect(app.calls).toEqual(["prepare", "start", "release", "prepare（按下）", "start", "stop"]);
    expect(recorded).toHaveLength(1);
  });

  test("按下时 App 开始不了（音频焦点被拒，比如在通话）：提示，这一段结束；之后按下再试", async () => {
    const { page, app, session, recorded } = setup();
    session.enter();
    await settle();
    app.failStart = { ok: false, reason: "failed", message: "音频焦点被拒" };
    session.press(500, page.clock);
    await settle();
    expect(session.getState()).toMatchObject({ phase: "idle", notice: { kind: "failed" } });
    expect(session.getState().notice!.text).toContain("音频焦点被拒");
    session.release(page.clock);
    app.failStart = undefined;
    await hold(page, session, 1500);
    expect(recorded).toHaveLength(1);
  });

  test("整段是静音：不发，提示再按一次；放掉这个录音器马上重新备好", async () => {
    const { page, app, session, recorded } = setup();
    session.enter();
    await settle();
    app.samples = [0, 0, 1, -1, 0];
    await hold(page, session, 1500);
    expect(recorded).toEqual([]);
    expect(session.getState().notice).toMatchObject({ kind: "failed", text: "没录到声音，再按一次试试" });
    expect(app.calls).toEqual(["prepare", "start", "stop", "release", "prepare"]);
    app.samples = [0, 900, -1200];
    await hold(page, session, 1500);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.capture.peak).toBe(0.0366);
  });
});

describe("原生录音：权限和出错", () => {
  test("没有麦克风权限：提示到手机设置里打开；之后不再自动要（离开再进语音模式、切后台再回来）；按下时让 App 再要一次", async () => {
    const permission = { denied: false };
    const { page, app, session } = setup({ permission });
    app.failPrepare = { ok: false, reason: "denied", message: "用户拒绝了麦克风权限" };
    session.enter();
    await settle();
    expect(session.getState().notice).toMatchObject({ kind: "denied" });
    expect(session.getState().notice!.text).toContain("设置");
    expect(permission.denied).toBe(true);
    session.leave();
    session.enter();
    page.setHidden(true);
    page.setHidden(false);
    await settle();
    expect(app.calls).toEqual(["prepare"]);
    // 按下：用户自己的动作，App 再要一次（被拒过的，弹系统的"去设置里打开"框）
    app.failPrepare = undefined;
    session.press(500, page.clock);
    await settle();
    expect(app.calls).toEqual(["prepare", "prepare（按下）", "start"]);
    expect(session.getState().phase).toBe("recording");
    expect(permission.denied).toBe(false);
  });

  test("录音器建不起来：提示，先歇着不反复试；按下再试", async () => {
    const { page, app, session } = setup();
    app.failPrepare = { ok: false, reason: "failed", message: "createAudioCapturer 失败（6800301）" };
    session.enter();
    await settle();
    expect(session.getState().notice).toMatchObject({ kind: "failed" });
    expect(session.getState().notice!.text).toContain("6800301");
    page.advance(10_000);
    expect(app.calls).toEqual(["prepare"]);
    session.press(500, page.clock);
    await settle();
    expect(app.calls).toEqual(["prepare", "prepare（按下）"]);
  });

  test("不在 App 里、旧版 App 没有原生录音：照旧用浏览器的 getUserMedia", async () => {
    const page = new FakePage();
    const session = new VoiceSession(page.env(undefined));
    session.enter();
    await settle();
    expect(page.getUserMediaCalls).toBe(1);
  });
});

describe("原生录音：诊断", () => {
  test("一条语音带上：原生录的、备好用了多久、按下到第一块数据、App 里开录到第一块数据、最大振幅、开关记录（App 报的录音器状态）、UA", async () => {
    const { page, app, session, recorded } = setup();
    const t0 = page.clock;
    session.enter();
    await settle();
    page.advance(3000);
    page.setHidden(true);
    page.setHidden(false);
    await settle();
    page.advance(2000);
    const pressedAt = page.clock - 5;
    session.press(500, pressedAt);
    await settle();
    page.advance(1500);
    session.release(page.clock);
    await settle();
    expect(page.clock - t0).toBe(6500);
    expect(app.calls).toEqual(["prepare", "release", "prepare", "start", "stop"]);
    expect(recorded[0]!.capture).toEqual({
      backend: "native",
      prewarmed: true,
      startDelayMs: 5 + 30,
      firstDataMs: 30,
      prepareMs: 12,
      openReason: "visible",
      peak: 0.1221,
      micLog: [
        { atMs: -4995, event: "open", reason: "enter", hasFocus: true, visibility: "visible" },
        { atMs: -4995, event: "ready", reason: "PREPARED", ms: 12, hasFocus: true, visibility: "visible" },
        { atMs: -1995, event: "close", reason: "hidden", hasFocus: true, visibility: "hidden" },
        { atMs: -1995, event: "open", reason: "visible", hasFocus: true, visibility: "visible" },
        { atMs: -1995, event: "ready", reason: "PREPARED", ms: 12, hasFocus: true, visibility: "visible" },
      ],
      browser: "Mozilla/5.0 (Phone; OpenHarmony 6.1) Chrome/132.0.0.0 ArkWeb/6.1.0.0 Mobile",
    });
  });

  test("App 放掉录音器、录音器出错、备不好、开始不了也记下来", async () => {
    const { page, app, session, recorded } = setup();
    session.enter();
    await settle();
    app.release();
    app.emit({ type: "released", id: 1, reason: "background" });
    app.failStart = { ok: false, reason: "failed", message: "音频焦点被拒" };
    session.press(500, page.clock);
    await settle();
    session.release(page.clock);
    app.failStart = undefined;
    await hold(page, session, 800);
    app.emit({ type: "error", id: app.capturer!, reason: "interrupted", message: "来电" });
    await hold(page, session, 1500);
    expect(recorded).toHaveLength(1);
    const events = recorded[0]!.capture.micLog!.map((e) => [e.event, e.reason ?? ""].join(" ").trim());
    expect(events).toEqual([
      "open enter",
      "ready PREPARED",
      "released background",
      "close stale",
      "open stale",
      "ready PREPARED",
      "fail start: 音频焦点被拒",
      "close failed",
      "open press",
      "ready PREPARED",
      "error interrupted",
      "close stale",
      "open stale",
      "ready PREPARED",
    ]);
  });
});
