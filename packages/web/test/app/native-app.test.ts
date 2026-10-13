// 鸿蒙 App（62 号票）：App 用 ArkWeb 的 javaScriptProxy 往页面里注入 window.ergouNative。网页检测到它时，
// 设置里显示"在鸿蒙 App 里运行"和 App 版本，外观告诉 App（状态栏、窗口底色跟着变），设置里能回到 App 的地址页；
// 没有时什么都不变。原生桥换成假的。
import { describe, expect, test } from "vitest";
import { createBackRegistry } from "../../src/app/back-registry.ts";
import { appBottomReserve, detectNativeApp, followBackInApp, followInsetsInApp, followThemeInApp, type InsetsScope, type NativeInsets, parseNativeInsets } from "../../src/app/native-app.ts";
import { followNotifyInApp, type NativeNotifyOpened, type NativeNotifyState, type NotifyOpenScope, parseNotifyOpened, parseNotifyState } from "../../src/app/native-notify.ts";
import type { ThemeChoice } from "../../src/state/index.ts";

/** 假的原生桥：记下网页调了什么；version 是 App 回的版本号（来源不对时 App 回空串） */
function fakeBridge(version = "0.1.0") {
  const calls: string[] = [];
  return {
    calls,
    appVersion: () => version,
    log: (message: string) => void calls.push(`log ${message}`),
    editServer: () => void calls.push("editServer"),
    setColorMode: (mode: string) => void calls.push(`setColorMode ${mode}`),
    setCanGoBack: (flag: boolean) => void calls.push(`setCanGoBack ${flag}`),
  };
}

/** 假的外观：能在测试里换选择、让系统切深浅色（只通知，选择不变） */
function fakeTheme(initial: ThemeChoice) {
  let choice = initial;
  const listeners = new Set<() => void>();
  return {
    choice: () => choice,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    choose(next: ThemeChoice) {
      choice = next;
      for (const fn of listeners) fn();
    },
    systemFlipped() {
      for (const fn of listeners) fn();
    },
    listenerCount: () => listeners.size,
  };
}

describe("检测原生桥", () => {
  test("页面里没有 ergouNative（手机浏览器、电脑）：不是在 App 里", () => {
    expect(detectNativeApp({})).toBeUndefined();
  });

  test("有 ergouNative：认出是鸿蒙 App，带上 App 的版本号", () => {
    const app = detectNativeApp({ ergouNative: fakeBridge("0.1.0") });
    expect(app).toMatchObject({ platform: "harmony", version: "0.1.0" });
  });

  test.each([
    ["不是对象", 1],
    ["null", null],
    ["没有 appVersion", { log() {} }],
    ["appVersion 不是函数", { appVersion: "0.1.0" }],
  ])("ergouNative 不像原生桥（%s）：当没有", (_name, ergouNative) => {
    expect(detectNativeApp({ ergouNative })).toBeUndefined();
  });

  test("原生桥拒绝了这个页面（来源不是 App 里配好的那个，版本号回空串）：当没有", () => {
    expect(detectNativeApp({ ergouNative: fakeBridge("") })).toBeUndefined();
  });

  test("问版本号时出错：当没有，不抛错", () => {
    const broken = {
      appVersion() {
        throw new Error("Error: bridge gone");
      },
    };
    expect(detectNativeApp({ ergouNative: broken })).toBeUndefined();
  });
});

describe("在 App 里", () => {
  test("设置里点换地址：回到 App 的地址页", () => {
    const bridge = fakeBridge();
    detectNativeApp({ ergouNative: bridge })?.editServer();
    expect(bridge.calls).toEqual(["editServer"]);
  });

  test("日志交给 App（写进 hilog）", () => {
    const bridge = fakeBridge();
    detectNativeApp({ ergouNative: bridge })?.log("语音：按下到开录 120ms");
    expect(bridge.calls).toEqual(["log 语音：按下到开录 120ms"]);
  });

  test("App 没有某个方法或调用出错：网页照常，不抛错", () => {
    const app = detectNativeApp({
      ergouNative: {
        appVersion: () => "0.1.0",
        setColorMode() {
          throw new Error("Error: refused");
        },
      },
    });
    expect(app).toBeDefined();
    expect(() => app?.setColorMode("dark")).not.toThrow();
    expect(() => app?.editServer()).not.toThrow();
    expect(() => app?.log("x")).not.toThrow();
  });
});

describe("返回键（照搬 AgentSense）", () => {
  test("一认出 App 就登记返回函数、告诉 App 现在能不能返回；之后变了再告诉", () => {
    const bridge = fakeBridge();
    const back = createBackRegistry();
    const scope: { __ergouBack?: () => boolean } = {};
    followBackInApp(detectNativeApp({ ergouNative: bridge })!, back, scope);
    const closeDetail = back.open("page", () => {});
    back.open("overlay", () => {});
    closeDetail();
    expect(bridge.calls).toEqual(["setCanGoBack false", "setCanGoBack true"]);
    expect(typeof scope.__ergouBack).toBe("function");
  });

  test("App 按返回键调网页登记的返回函数：退一级；到了顶层返回 false", () => {
    const back = createBackRegistry();
    const scope: { __ergouBack?: () => boolean } = {};
    followBackInApp(detectNativeApp({ ergouNative: fakeBridge() })!, back, scope);
    const done: string[] = [];
    const close = back.open("overlay", () => {
      done.push("关弹窗");
      close();
    });
    expect(scope.__ergouBack?.()).toBe(true);
    expect(done).toEqual(["关弹窗"]);
    expect(scope.__ergouBack?.()).toBe(false);
  });

  test("停下之后：拿掉返回函数，不再告诉 App", () => {
    const bridge = fakeBridge();
    const back = createBackRegistry();
    const scope: { __ergouBack?: () => boolean } = {};
    const stop = followBackInApp(detectNativeApp({ ergouNative: bridge })!, back, scope);
    stop();
    back.open("page", () => {});
    expect(scope.__ergouBack).toBeUndefined();
    expect(bridge.calls).toEqual(["setCanGoBack false"]);
  });
});

describe("外观跟着网页走", () => {
  test("一认出 App 就把现在的外观告诉它；之后每换一次告诉一次", () => {
    const bridge = fakeBridge();
    const app = detectNativeApp({ ergouNative: bridge });
    const theme = fakeTheme("dark");
    followThemeInApp(app!, theme);
    theme.choose("light");
    theme.choose("system");
    expect(bridge.calls).toEqual(["setColorMode dark", "setColorMode light", "setColorMode system"]);
  });

  test("跟随系统时系统切了深浅色：选择没变，不再告诉 App（App 自己跟着系统）", () => {
    const bridge = fakeBridge();
    const theme = fakeTheme("system");
    followThemeInApp(detectNativeApp({ ergouNative: bridge })!, theme);
    theme.systemFlipped();
    theme.systemFlipped();
    expect(bridge.calls).toEqual(["setColorMode system"]);
  });

  test("停下之后外观再变也不告诉 App", () => {
    const bridge = fakeBridge();
    const theme = fakeTheme("light");
    const stop = followThemeInApp(detectNativeApp({ ergouNative: bridge })!, theme);
    stop();
    theme.choose("dark");
    expect(bridge.calls).toEqual(["setColorMode light"]);
    expect(theme.listenerCount()).toBe(0);
  });
});

// 63 号票：App 的原生录音（AudioCapturer）也挂在 ergouNative 上。要等结果的方法（备好、开始、停止）回 Promise<string>（JSON），
// 丢弃、释放立即返回；App 往网页推的（实时音量、出错、App 自己放掉了录音器）调网页登记的 window.__ergouVoice(json)。
// 这里只测包装：认出来、解析、出错时不抛；录音的状态机在 test/app/voice-session.test.ts 的"原生录音"。

/** 假的原生录音接口：记下调了什么，回 replies 里排好的（ArkWeb 里同步方法回的 Promise 到网页还是 Promise） */
function fakeVoiceBridge(replies: Partial<Record<"voicePrepare" | "voiceStart" | "voiceStop", unknown>> = {}) {
  const bridge = fakeBridge();
  return {
    ...bridge,
    voicePrepare: (userAction: boolean) => {
      bridge.calls.push(`voicePrepare ${userAction}`);
      return replies.voicePrepare ?? Promise.resolve(JSON.stringify({ ok: true, id: 1, prepareMs: 12, state: "PREPARED" }));
    },
    voiceStart: () => {
      bridge.calls.push("voiceStart");
      return replies.voiceStart ?? Promise.resolve(JSON.stringify({ ok: true, id: 1 }));
    },
    voiceStop: () => {
      bridge.calls.push("voiceStop");
      return replies.voiceStop ?? Promise.resolve(JSON.stringify({ ok: true, id: 1, pcm: "AAEC/w==", sampleRate: 16000, channels: 1, bitsPerSample: 16, firstDataMs: 31 }));
    },
    voiceDiscard: () => void bridge.calls.push("voiceDiscard"),
    voiceRelease: () => void bridge.calls.push("voiceRelease"),
  };
}

describe("原生录音的接口（63 号票）", () => {
  test("App 有录音这一组方法：认出来；旧版 App 没有：没有原生录音，照旧用浏览器录", () => {
    expect(detectNativeApp({ ergouNative: fakeVoiceBridge() })?.voice).toBeDefined();
    expect(detectNativeApp({ ergouNative: fakeBridge() })?.voice).toBeUndefined();
    const partial = { ...fakeVoiceBridge(), voiceStop: undefined };
    expect(detectNativeApp({ ergouNative: partial })?.voice).toBeUndefined();
  });

  test("备好、开始、停止：调 App 的方法，解析回的结果；停止交出的 PCM 从 base64 解出来；丢弃、释放直接转给 App", async () => {
    const bridge = fakeVoiceBridge();
    const voice = detectNativeApp({ ergouNative: bridge })!.voice!;
    expect(await voice.prepare(false)).toEqual({ ok: true, id: 1, prepareMs: 12, state: "PREPARED" });
    expect(await voice.start()).toEqual({ ok: true, id: 1 });
    const take = await voice.stop();
    expect(take).toMatchObject({ ok: true, id: 1, format: { sampleRate: 16000, channels: 1, bitsPerSample: 16 }, firstDataMs: 31 });
    expect(take.ok && [...take.pcm]).toEqual([0, 1, 2, 255]);
    voice.discard();
    voice.release();
    await voice.prepare(true);
    expect(bridge.calls).toEqual(["voicePrepare false", "voiceStart", "voiceStop", "voiceDiscard", "voiceRelease", "voicePrepare true"]);
  });

  test("App 回的是失败：原样交出原因和说明", async () => {
    const voice = detectNativeApp({
      ergouNative: fakeVoiceBridge({
        voicePrepare: Promise.resolve(JSON.stringify({ ok: false, reason: "denied", message: "用户没给麦克风权限" })),
        voiceStart: Promise.resolve(JSON.stringify({ ok: false, reason: "failed", message: "音频焦点被拒" })),
      }),
    })!.voice!;
    expect(await voice.prepare(false)).toEqual({ ok: false, reason: "denied", message: "用户没给麦克风权限" });
    expect(await voice.start()).toEqual({ ok: false, reason: "failed", message: "音频焦点被拒" });
  });

  test.each<[string, () => unknown]>([
    ["不是 JSON", () => Promise.resolve("not json")],
    ["形状不对", () => Promise.resolve(JSON.stringify({ ok: true }))],
    ["Promise 失败了", () => Promise.reject(new Error("bridge gone"))],
    ["回的不是字符串", () => Promise.resolve(42)],
    ["App 拒绝了这次调用（来源不对时回空串）", () => ""],
  ])("App 回的不对（%s）：当失败，不抛错", async (_name, reply) => {
    const voice = detectNativeApp({ ergouNative: fakeVoiceBridge({ voicePrepare: reply(), voiceStop: reply() }) })!.voice!;
    expect(await voice.prepare(false)).toMatchObject({ ok: false, reason: "failed" });
    expect(await voice.stop()).toMatchObject({ ok: false, reason: "failed" });
  });

  test("调 App 的方法时直接抛错：当失败，不抛错", async () => {
    const bridge = {
      ...fakeVoiceBridge(),
      voiceStart() {
        throw new Error("Error: refused");
      },
      voiceRelease() {
        throw new Error("Error: refused");
      },
    };
    const voice = detectNativeApp({ ergouNative: bridge })!.voice!;
    expect(await voice.start()).toMatchObject({ ok: false, reason: "failed" });
    expect(() => voice.release()).not.toThrow();
  });

  test("App 推过来的（实时音量、出错、App 自己放掉了录音器）：经 window.__ergouVoice 交给订阅者；坏的不理；退订后不再收到", () => {
    const scope: { ergouNative?: unknown; __ergouVoice?: (json: string) => void } = { ergouNative: fakeVoiceBridge() };
    const voice = detectNativeApp(scope)!.voice!;
    const seen: unknown[] = [];
    const off = voice.subscribe((event) => seen.push(event));
    scope.__ergouVoice!(JSON.stringify({ type: "level", id: 1, rms: 0.2 }));
    scope.__ergouVoice!(JSON.stringify({ type: "error", id: 1, reason: "interrupted", message: "来电" }));
    scope.__ergouVoice!(JSON.stringify({ type: "released", id: 1, reason: "background" }));
    scope.__ergouVoice!("not json");
    scope.__ergouVoice!(JSON.stringify({ type: "level", id: "x", rms: 0.2 }));
    scope.__ergouVoice!(JSON.stringify({ type: "unknown", id: 1 }));
    off();
    scope.__ergouVoice!(JSON.stringify({ type: "level", id: 1, rms: 0.5 }));
    expect(seen).toEqual([
      { type: "level", id: 1, rms: 0.2 },
      { type: "error", id: 1, reason: "interrupted", message: "来电" },
      { type: "released", id: 1, reason: "background" },
    ]);
  });

  test("不在 App 里、旧版 App：不登记 window.__ergouVoice", () => {
    const scope: { ergouNative?: unknown; __ergouVoice?: (json: string) => void } = { ergouNative: fakeBridge() };
    detectNativeApp(scope);
    expect(scope.__ergouVoice).toBeUndefined();
  });
});

// 105 号票：App 把网页延伸到了底部手势条底下，告诉页面那一截多高（物理像素）；页面底部只让开四分之一（CSS 像素，用户 10-13 要再往下），不留整条白边
describe("底部避让", () => {
  test.each<[string, number, number, number]>([
    ["手势条 84 像素、3 倍屏：那一截 28，让开 7", 84, 3, 7],
    ["平板 2 倍屏", 56, 2, 7],
    ["没有手势条", 0, 3, 0],
    ["App 报错了数", -10, 3, 0],
    ["倍率不对", 84, 0, 0],
  ])("%s", (_what, bottom, dpr, reserve) => {
    expect(appBottomReserve(bottom, dpr)).toBe(reserve);
  });

  test.each<[string, unknown, NativeInsets | undefined]>([
    ["对的", '{"bottom":84}', { bottom: 84 }],
    ["0 也算", '{"bottom":0}', { bottom: 0 }],
    ["App 还没量到（空串）", "", undefined],
    ["不是 JSON", "{bottom", undefined],
    ["没有 bottom", "{}", undefined],
    ["负数", '{"bottom":-1}', undefined],
    ["不是字符串", 84, undefined],
  ])("App 回的避让区：%s", (_what, json, insets) => {
    expect(parseNativeInsets(json)).toEqual(insets);
  });

  test("新版 App：开场问一次，之后 App 推过来（量到了、转屏）就换；停下后不再收", () => {
    let current = "";
    const app = detectNativeApp({ ergouNative: { ...fakeBridge(), safeArea: () => current } })!;
    const scope: InsetsScope = {};
    const got: NativeInsets[] = [];
    // App 还没量到：先不动
    const stop = followInsetsInApp(app, scope, (insets) => got.push(insets));
    expect(got).toEqual([]);
    current = '{"bottom":84}';
    scope.__ergouInsets!('{"bottom":84}');
    scope.__ergouInsets!("坏的");
    scope.__ergouInsets!('{"bottom":60}');
    expect(got).toEqual([{ bottom: 84 }, { bottom: 60 }]);
    expect(app.safeArea!()).toEqual({ bottom: 84 });
    stop();
    expect(scope.__ergouInsets).toBeUndefined();
  });

  test("开场就量到了：马上交给页面", () => {
    const app = detectNativeApp({ ergouNative: { ...fakeBridge(), safeArea: () => '{"bottom":96}' } })!;
    const got: NativeInsets[] = [];
    followInsetsInApp(app, {}, (insets) => got.push(insets));
    expect(got).toEqual([{ bottom: 96 }]);
  });

  test("旧版 App 没有 safeArea：什么都不做（页面照旧用系统的安全区）", () => {
    const app = detectNativeApp({ ergouNative: fakeBridge() })!;
    expect(app.safeArea).toBeUndefined();
    const scope: InsetsScope = {};
    const got: NativeInsets[] = [];
    followInsetsInApp(app, scope, (insets) => got.push(insets))();
    expect(got).toEqual([]);
    expect(scope.__ergouInsets).toBeUndefined();
  });
});

// 110 号票：App 的系统通知（Notification Kit 本地通知）也挂在 ergouNative 上：notifyState 开没开、问没问过；
// notifyPrepare(userAction) 第一次向用户要授权（拒过的、用户点"去打开"时拉起系统的通知设置），回要过之后的状态；
// notifyShow(id, title, body, route) 发一条；notifyTakeOpen() 取用户点开的那一条（取一次就清掉）。
// App 被点开的通知拉起来时调网页登记的 window.__ergouNotifyOpen()，网页再来取。这里测包装和开场；走哪条路在 system-notify.test.ts。

/** App 拒绝了这次调用、桥断了：调过去直接抛错 */
function boom(): never {
  throw new Error("Error: refused");
}

/** 假的通知接口：state 是 App 回的状态，opened 是排着等网页取的点开的那一条（取了就清掉） */
function fakeNotifyBridge(init: { state?: unknown; opened?: string; prepare?: () => unknown } = {}) {
  const bridge = fakeBridge();
  let opened = init.opened ?? "";
  return {
    ...bridge,
    notifyState: () => init.state ?? JSON.stringify({ enabled: false, asked: false }),
    notifyPrepare: (userAction: boolean) => {
      bridge.calls.push(`notifyPrepare ${userAction}`);
      return init.prepare ? init.prepare() : Promise.resolve(JSON.stringify({ enabled: true, asked: true }));
    },
    notifyShow: (id: string, title: string, body: string, route: string) => void bridge.calls.push(`notifyShow ${id}|${title}|${body}|${route}`),
    notifyTakeOpen: () => {
      bridge.calls.push("notifyTakeOpen");
      const now = opened;
      opened = "";
      return now;
    },
    /** 用户点了通知栏里的一条（App 记下，等网页来取） */
    tap(json: string) {
      opened = json;
    },
  };
}

describe("系统通知的接口（110 号票）", () => {
  test("App 有通知这一组方法：认出来；旧版 App 没有、缺一个：没有（照旧走浏览器通知）", () => {
    expect(detectNativeApp({ ergouNative: fakeNotifyBridge() })?.notify).toBeDefined();
    expect(detectNativeApp({ ergouNative: fakeBridge() })?.notify).toBeUndefined();
    expect(detectNativeApp({ ergouNative: { ...fakeNotifyBridge(), notifyTakeOpen: undefined } })?.notify).toBeUndefined();
  });

  test("发一条：标题、正文、点了去哪交给 App", () => {
    const bridge = fakeNotifyBridge();
    detectNativeApp({ ergouNative: bridge })!.notify!.show({ id: "n-1", title: "到点了", body: "", route: "#/inbox/i-1" });
    expect(bridge.calls).toEqual(["notifyShow n-1|到点了||#/inbox/i-1"]);
  });

  test.each<[string, unknown, NativeNotifyState | undefined]>([
    ["开着", '{"enabled":true,"asked":true}', { enabled: true, asked: true }],
    ["没问过", '{"enabled":false,"asked":false}', { enabled: false, asked: false }],
    ["拒过", '{"enabled":false,"asked":true}', { enabled: false, asked: true }],
    ["App 拒绝了这次调用（空串）", "", undefined],
    ["不是 JSON", "{", undefined],
    ["缺字段", '{"enabled":true}', undefined],
    ["不是字符串", 1, undefined],
  ])("通知开没开：%s", (_what, json, state) => {
    expect(parseNotifyState(json)).toEqual(state);
    expect(detectNativeApp({ ergouNative: fakeNotifyBridge({ state: json }) })!.notify!.state()).toEqual(state);
  });

  test("要授权、去打开：调 App 的 notifyPrepare，回要过之后的状态；App 回的不对、失败了当不知道，不抛错", async () => {
    const bridge = fakeNotifyBridge();
    const notify = detectNativeApp({ ergouNative: bridge })!.notify!;
    expect(await notify.prepare(true)).toEqual({ enabled: true, asked: true });
    expect(bridge.calls).toEqual(["notifyPrepare true"]);
    const broken = detectNativeApp({ ergouNative: fakeNotifyBridge({ prepare: () => Promise.reject(new Error("bridge gone")) }) })!.notify!;
    expect(await broken.prepare(false)).toBeUndefined();
    const refused = detectNativeApp({ ergouNative: fakeNotifyBridge({ prepare: () => "" }) })!.notify!;
    expect(await refused.prepare(false)).toBeUndefined();
  });

  test.each<[string, unknown, NativeNotifyOpened | undefined]>([
    ["待办里那一项", '{"id":"n-1","route":"#/inbox/i-1"}', { id: "n-1", route: "#/inbox/i-1" }],
    ["秘书会话里那条消息", '{"id":"n-2","route":"#/secretary/at/m-9"}', { id: "n-2", route: "#/secretary/at/m-9" }],
    ["没有点开的（空串）", "", undefined],
    ["地址不是页面地址（别的应用拉起 App 时带来的）", '{"id":"n-1","route":"https://evil.example/"}', undefined],
    ["没有 id", '{"route":"#/inbox"}', undefined],
    ["不是 JSON", "#/inbox", undefined],
  ])("点开的那一条：%s", (_what, json, opened) => {
    expect(parseNotifyOpened(json)).toEqual(opened);
  });

  test("开场取一次（点通知把 App 拉起来的）；之后 App 推过来（App 在跑时点了通知）再取；取到空的不动；停下后拿掉", () => {
    const bridge = fakeNotifyBridge({ state: '{"enabled":true,"asked":true}', opened: '{"id":"n-1","route":"#/inbox/i-1"}' });
    const notify = detectNativeApp({ ergouNative: bridge })!.notify!;
    const scope: NotifyOpenScope = {};
    const got: NativeNotifyOpened[] = [];
    const stop = followNotifyInApp(notify, scope, (opened) => got.push(opened), () => true);
    expect(got).toEqual([{ id: "n-1", route: "#/inbox/i-1" }]);
    bridge.tap('{"id":"n-2","route":"#/secretary/at/m-9"}');
    scope.__ergouNotifyOpen!();
    // 推了两次（App 回到前台时又推了一次）：第二次取到空的
    scope.__ergouNotifyOpen!();
    expect(got).toEqual([
      { id: "n-1", route: "#/inbox/i-1" },
      { id: "n-2", route: "#/secretary/at/m-9" },
    ]);
    stop();
    expect(scope.__ergouNotifyOpen).toBeUndefined();
  });

  test("第一次：还没问过、页面在前台，开场向用户要通知授权（只此一次，之后由 App 记着问过了）", () => {
    const bridge = fakeNotifyBridge({ state: '{"enabled":false,"asked":false}' });
    followNotifyInApp(detectNativeApp({ ergouNative: bridge })!.notify!, {}, () => {}, () => true);
    expect(bridge.calls).toContain("notifyPrepare false");
  });

  test.each<[string, string, boolean]>([
    ["问过了、用户拒了", '{"enabled":false,"asked":true}', true],
    ["已经开着", '{"enabled":true,"asked":false}', true],
    ["页面在后台（系统的授权框要 App 在前台）", '{"enabled":false,"asked":false}', false],
    ["App 回的不对", "", true],
  ])("开场不问授权：%s", (_what, state, visible) => {
    const bridge = fakeNotifyBridge({ state });
    followNotifyInApp(detectNativeApp({ ergouNative: bridge })!.notify!, {}, () => {}, () => visible);
    expect(bridge.calls.filter((c) => c.startsWith("notifyPrepare"))).toEqual([]);
  });

  test("调 App 的方法时直接抛错：当没有，不抛错", async () => {
    const notify = detectNativeApp({ ergouNative: { ...fakeNotifyBridge(), notifyState: boom, notifyPrepare: boom, notifyShow: boom, notifyTakeOpen: boom } })!.notify!;
    expect(notify.state()).toBeUndefined();
    expect(await notify.prepare(true)).toBeUndefined();
    expect(() => notify.show({ id: "n-1", title: "t", body: "", route: "#/inbox" })).not.toThrow();
    expect(notify.takeOpened()).toBeUndefined();
  });
});
