// 鸿蒙 App（62 号票）：App 用 ArkWeb 的 javaScriptProxy 往页面里注入 window.ergoNative。网页检测到它时，
// 设置里显示"在鸿蒙 App 里运行"和 App 版本，外观告诉 App（状态栏、窗口底色跟着变），设置里能回到 App 的地址页；
// 没有时什么都不变。原生桥换成假的。
import { describe, expect, test } from "vitest";
import { createBackRegistry } from "../../src/app/back-registry.ts";
import {
  appBottomReserve,
  appTexts,
  detectNativeApp,
  followBackInApp,
  followInsetsInApp,
  followLocaleInApp,
  followThemeInApp,
  type InsetsScope,
  type NativeInsets,
  parseNativeInsets,
} from "../../src/app/native-app.ts";
import {
  followNotifyInApp,
  type NativeNotifyOpened,
  type NativeNotifyShown,
  type NativeNotifyState,
  type NotifyOpenScope,
  parseNotifyOpened,
  parseNotifyShown,
  parseNotifyState,
} from "../../src/app/native-notify.ts";
import { activeLocaleFrom, DEFAULT_LANGUAGE, setActiveLocale, type ThemeChoice } from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

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
  test("页面里没有 ergoNative（手机浏览器、电脑）：不是在 App 里", () => {
    expect(detectNativeApp({})).toBeUndefined();
  });

  test("有 ergoNative：认出是鸿蒙 App，带上 App 的版本号", () => {
    const app = detectNativeApp({ ergoNative: fakeBridge("0.1.0") });
    expect(app).toMatchObject({ platform: "harmony", version: "0.1.0" });
  });

  test.each([
    ["不是对象", 1],
    ["null", null],
    ["没有 appVersion", { log() {} }],
    ["appVersion 不是函数", { appVersion: "0.1.0" }],
  ])("ergoNative 不像原生桥（%s）：当没有", (_name, ergoNative) => {
    expect(detectNativeApp({ ergoNative })).toBeUndefined();
  });

  test("原生桥拒绝了这个页面（来源不是 App 里配好的那个，版本号回空串）：当没有", () => {
    expect(detectNativeApp({ ergoNative: fakeBridge("") })).toBeUndefined();
  });

  test("问版本号时出错：当没有，不抛错", () => {
    const broken = {
      appVersion() {
        throw new Error("Error: bridge gone");
      },
    };
    expect(detectNativeApp({ ergoNative: broken })).toBeUndefined();
  });
});

describe("在 App 里", () => {
  test("设置里点换地址：回到 App 的地址页", () => {
    const bridge = fakeBridge();
    detectNativeApp({ ergoNative: bridge })?.editServer();
    expect(bridge.calls).toEqual(["editServer"]);
  });

  test("日志交给 App（写进 hilog）", () => {
    const bridge = fakeBridge();
    detectNativeApp({ ergoNative: bridge })?.log("语音：按下到开录 120ms");
    expect(bridge.calls).toEqual(["log 语音：按下到开录 120ms"]);
  });

  test("App 没有某个方法或调用出错：网页照常，不抛错", () => {
    const app = detectNativeApp({
      ergoNative: {
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

describe("返回键", () => {
  test("一认出 App 就登记返回函数、告诉 App 现在能不能返回；之后变了再告诉", () => {
    const bridge = fakeBridge();
    const back = createBackRegistry();
    const scope: { __ergoBack?: () => boolean } = {};
    followBackInApp(detectNativeApp({ ergoNative: bridge })!, back, scope);
    const closeDetail = back.open("page", () => {});
    back.open("overlay", () => {});
    closeDetail();
    expect(bridge.calls).toEqual(["setCanGoBack false", "setCanGoBack true"]);
    expect(typeof scope.__ergoBack).toBe("function");
  });

  test("App 按返回键调网页登记的返回函数：退一级；到了顶层返回 false", () => {
    const back = createBackRegistry();
    const scope: { __ergoBack?: () => boolean } = {};
    followBackInApp(detectNativeApp({ ergoNative: fakeBridge() })!, back, scope);
    const done: string[] = [];
    const close = back.open("overlay", () => {
      done.push("关弹窗");
      close();
    });
    expect(scope.__ergoBack?.()).toBe(true);
    expect(done).toEqual(["关弹窗"]);
    expect(scope.__ergoBack?.()).toBe(false);
  });

  test("停下之后：拿掉返回函数，不再告诉 App", () => {
    const bridge = fakeBridge();
    const back = createBackRegistry();
    const scope: { __ergoBack?: () => boolean } = {};
    const stop = followBackInApp(detectNativeApp({ ergoNative: bridge })!, back, scope);
    stop();
    back.open("page", () => {});
    expect(scope.__ergoBack).toBeUndefined();
    expect(bridge.calls).toEqual(["setCanGoBack false"]);
  });
});

describe("外观跟着网页走", () => {
  test("一认出 App 就把现在的外观告诉它；之后每换一次告诉一次", () => {
    const bridge = fakeBridge();
    const app = detectNativeApp({ ergoNative: bridge });
    const theme = fakeTheme("dark");
    followThemeInApp(app!, theme);
    theme.choose("light");
    theme.choose("system");
    expect(bridge.calls).toEqual(["setColorMode dark", "setColorMode light", "setColorMode system"]);
  });

  test("跟随系统时系统切了深浅色：选择没变，不再告诉 App（App 自己跟着系统）", () => {
    const bridge = fakeBridge();
    const theme = fakeTheme("system");
    followThemeInApp(detectNativeApp({ ergoNative: bridge })!, theme);
    theme.systemFlipped();
    theme.systemFlipped();
    expect(bridge.calls).toEqual(["setColorMode system"]);
  });

  test("停下之后外观再变也不告诉 App", () => {
    const bridge = fakeBridge();
    const theme = fakeTheme("light");
    const stop = followThemeInApp(detectNativeApp({ ergoNative: bridge })!, theme);
    stop();
    theme.choose("dark");
    expect(bridge.calls).toEqual(["setColorMode light"]);
    expect(theme.listenerCount()).toBe(0);
  });
});

// 63 号票：App 的原生录音（AudioCapturer）也挂在 ergoNative 上。要等结果的方法（备好、开始、停止）回 Promise<string>（JSON），
// 丢弃、释放立即返回；App 往网页推的（实时音量、出错、App 自己放掉了录音器）调网页登记的 window.__ergoVoice(json)。
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
  test("浏览侧边栏那份原生桥（147 号票，只有版本号、日志和录音那一组）：认出在 App 里、有原生录音；没有通知、浏览器、避让区，外观、返回键、换地址调了也不出错", () => {
    const { calls, appVersion, log, voicePrepare, voiceStart, voiceStop, voiceDiscard, voiceRelease } = fakeVoiceBridge();
    const app = detectNativeApp({ ergoNative: { appVersion, log, voicePrepare, voiceStart, voiceStop, voiceDiscard, voiceRelease } });
    expect(app?.version).toBe("0.1.0");
    expect(app?.voice).toBeDefined();
    expect(app?.notify).toBeUndefined();
    expect(app?.browser).toBeUndefined();
    expect(app?.safeArea).toBeUndefined();
    app!.setColorMode("dark");
    app!.setCanGoBack(true);
    app!.editServer();
    app!.log("侧边栏");
    expect(calls).toEqual(["log 侧边栏"]);
  });

  test("App 有录音这一组方法：认出来；旧版 App 没有：没有原生录音，照旧用浏览器录", () => {
    expect(detectNativeApp({ ergoNative: fakeVoiceBridge() })?.voice).toBeDefined();
    expect(detectNativeApp({ ergoNative: fakeBridge() })?.voice).toBeUndefined();
    const partial = { ...fakeVoiceBridge(), voiceStop: undefined };
    expect(detectNativeApp({ ergoNative: partial })?.voice).toBeUndefined();
  });

  test("备好、开始、停止：调 App 的方法，解析回的结果；停止交出的 PCM 从 base64 解出来；丢弃、释放直接转给 App", async () => {
    const bridge = fakeVoiceBridge();
    const voice = detectNativeApp({ ergoNative: bridge })!.voice!;
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
      ergoNative: fakeVoiceBridge({
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
    const voice = detectNativeApp({ ergoNative: fakeVoiceBridge({ voicePrepare: reply(), voiceStop: reply() }) })!.voice!;
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
    const voice = detectNativeApp({ ergoNative: bridge })!.voice!;
    expect(await voice.start()).toMatchObject({ ok: false, reason: "failed" });
    expect(() => voice.release()).not.toThrow();
  });

  test("App 推过来的（实时音量、出错、App 自己放掉了录音器）：经 window.__ergoVoice 交给订阅者；坏的不理；退订后不再收到", () => {
    const scope: { ergoNative?: unknown; __ergoVoice?: (json: string) => void } = { ergoNative: fakeVoiceBridge() };
    const voice = detectNativeApp(scope)!.voice!;
    const seen: unknown[] = [];
    const off = voice.subscribe((event) => seen.push(event));
    scope.__ergoVoice!(JSON.stringify({ type: "level", id: 1, rms: 0.2 }));
    scope.__ergoVoice!(JSON.stringify({ type: "error", id: 1, reason: "interrupted", message: "来电" }));
    scope.__ergoVoice!(JSON.stringify({ type: "released", id: 1, reason: "background" }));
    scope.__ergoVoice!("not json");
    scope.__ergoVoice!(JSON.stringify({ type: "level", id: "x", rms: 0.2 }));
    scope.__ergoVoice!(JSON.stringify({ type: "unknown", id: 1 }));
    off();
    scope.__ergoVoice!(JSON.stringify({ type: "level", id: 1, rms: 0.5 }));
    expect(seen).toEqual([
      { type: "level", id: 1, rms: 0.2 },
      { type: "error", id: 1, reason: "interrupted", message: "来电" },
      { type: "released", id: 1, reason: "background" },
    ]);
  });

  test("不在 App 里、旧版 App：不登记 window.__ergoVoice", () => {
    const scope: { ergoNative?: unknown; __ergoVoice?: (json: string) => void } = { ergoNative: fakeBridge() };
    detectNativeApp(scope);
    expect(scope.__ergoVoice).toBeUndefined();
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
    const app = detectNativeApp({ ergoNative: { ...fakeBridge(), safeArea: () => current } })!;
    const scope: InsetsScope = {};
    const got: NativeInsets[] = [];
    // App 还没量到：先不动
    const stop = followInsetsInApp(app, scope, (insets) => got.push(insets));
    expect(got).toEqual([]);
    current = '{"bottom":84}';
    scope.__ergoInsets!('{"bottom":84}');
    scope.__ergoInsets!("坏的");
    scope.__ergoInsets!('{"bottom":60}');
    expect(got).toEqual([{ bottom: 84 }, { bottom: 60 }]);
    expect(app.safeArea!()).toEqual({ bottom: 84 });
    stop();
    expect(scope.__ergoInsets).toBeUndefined();
  });

  test("开场就量到了：马上交给页面", () => {
    const app = detectNativeApp({ ergoNative: { ...fakeBridge(), safeArea: () => '{"bottom":96}' } })!;
    const got: NativeInsets[] = [];
    followInsetsInApp(app, {}, (insets) => got.push(insets));
    expect(got).toEqual([{ bottom: 96 }]);
  });

  test("旧版 App 没有 safeArea：什么都不做（页面照旧用系统的安全区）", () => {
    const app = detectNativeApp({ ergoNative: fakeBridge() })!;
    expect(app.safeArea).toBeUndefined();
    const scope: InsetsScope = {};
    const got: NativeInsets[] = [];
    followInsetsInApp(app, scope, (insets) => got.push(insets))();
    expect(got).toEqual([]);
    expect(scope.__ergoInsets).toBeUndefined();
  });
});

// 110 号票：App 的系统通知（Notification Kit 本地通知）也挂在 ergoNative 上：notifyState 开没开、问没问过；
// notifyPrepare(userAction) 第一次向用户要授权（拒过的、用户点"去打开"时拉起系统的通知设置），回要过之后的状态；
// notifyShow(id, title, body, route) 发一条；notifyTakeOpen() 取用户点开的那一条（取一次就清掉）。
// App 被点开的通知拉起来时调网页登记的 window.__ergoNotifyOpen()，网页再来取。这里测包装和开场；走哪条路在 system-notify.test.ts。

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
    expect(detectNativeApp({ ergoNative: fakeNotifyBridge() })?.notify).toBeDefined();
    expect(detectNativeApp({ ergoNative: fakeBridge() })?.notify).toBeUndefined();
    expect(detectNativeApp({ ergoNative: { ...fakeNotifyBridge(), notifyTakeOpen: undefined } })?.notify).toBeUndefined();
  });

  test("发一条：标题、正文、点了去哪交给 App", () => {
    const bridge = fakeNotifyBridge();
    detectNativeApp({ ergoNative: bridge })!.notify!.show({ id: "n-1", title: "到点了", body: "", route: "#/inbox/i-1" });
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
    expect(detectNativeApp({ ergoNative: fakeNotifyBridge({ state: json }) })!.notify!.state()).toEqual(state);
  });

  test("要授权、去打开：调 App 的 notifyPrepare，回要过之后的状态；App 回的不对、失败了当不知道，不抛错", async () => {
    const bridge = fakeNotifyBridge();
    const notify = detectNativeApp({ ergoNative: bridge })!.notify!;
    expect(await notify.prepare(true)).toEqual({ enabled: true, asked: true });
    expect(bridge.calls).toEqual(["notifyPrepare true"]);
    const broken = detectNativeApp({ ergoNative: fakeNotifyBridge({ prepare: () => Promise.reject(new Error("bridge gone")) }) })!.notify!;
    expect(await broken.prepare(false)).toBeUndefined();
    const refused = detectNativeApp({ ergoNative: fakeNotifyBridge({ prepare: () => "" }) })!.notify!;
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
    const notify = detectNativeApp({ ergoNative: bridge })!.notify!;
    const scope: NotifyOpenScope = {};
    const got: NativeNotifyOpened[] = [];
    const stop = followNotifyInApp(notify, scope, (opened) => got.push(opened), () => true);
    expect(got).toEqual([{ id: "n-1", route: "#/inbox/i-1" }]);
    bridge.tap('{"id":"n-2","route":"#/secretary/at/m-9"}');
    scope.__ergoNotifyOpen!();
    // 推了两次（App 回到前台时又推了一次）：第二次取到空的
    scope.__ergoNotifyOpen!();
    expect(got).toEqual([
      { id: "n-1", route: "#/inbox/i-1" },
      { id: "n-2", route: "#/secretary/at/m-9" },
    ]);
    stop();
    expect(scope.__ergoNotifyOpen).toBeUndefined();
  });

  test("第一次：还没问过、页面在前台，开场向用户要通知授权（只此一次，之后由 App 记着问过了）", () => {
    const bridge = fakeNotifyBridge({ state: '{"enabled":false,"asked":false}' });
    followNotifyInApp(detectNativeApp({ ergoNative: bridge })!.notify!, {}, () => {}, () => true);
    expect(bridge.calls).toContain("notifyPrepare false");
  });

  test.each<[string, string, boolean]>([
    ["问过了、用户拒了", '{"enabled":false,"asked":true}', true],
    ["已经开着", '{"enabled":true,"asked":false}', true],
    ["页面在后台（系统的授权框要 App 在前台）", '{"enabled":false,"asked":false}', false],
    ["App 回的不对", "", true],
  ])("开场不问授权：%s", (_what, state, visible) => {
    const bridge = fakeNotifyBridge({ state });
    followNotifyInApp(detectNativeApp({ ergoNative: bridge })!.notify!, {}, () => {}, () => visible);
    expect(bridge.calls.filter((c) => c.startsWith("notifyPrepare"))).toEqual([]);
  });

  test("调 App 的方法时直接抛错：当没有，不抛错", async () => {
    const notify = detectNativeApp({ ergoNative: { ...fakeNotifyBridge(), notifyState: boom, notifyPrepare: boom, notifyShow: boom, notifyTakeOpen: boom } })!.notify!;
    expect(notify.state()).toBeUndefined();
    expect(await notify.prepare(true)).toBeUndefined();
    expect(() => notify.show({ id: "n-1", title: "t", body: "", route: "#/inbox" })).not.toThrow();
    expect(notify.takeOpened()).toBeUndefined();
  });
});

/**
 * 新版 App（124 号票）：notifyShow 回结果（Promise<string>）、认第 5 个参数"前台也强制发"，notifyState 带前后台，
 * 多一个 notifyResetAsked（清掉"问过了"）
 */
function fakeDebugNotifyBridge(init: { state?: unknown; reply?: unknown } = {}) {
  const bridge = fakeNotifyBridge({ state: init.state ?? '{"enabled":true,"asked":true,"foreground":true}' });
  return {
    ...bridge,
    notifyShow: (...args: unknown[]) => {
      bridge.calls.push(`notifyShow ${args.join("|")}`);
      return "reply" in init ? init.reply : Promise.resolve('{"result":"published","number":42}');
    },
    notifyResetAsked: () => {
      bridge.calls.push("notifyResetAsked");
      return '{"enabled":false,"asked":false,"foreground":true}';
    },
  };
}

describe("Debug 工具集要的通知接口（124 号票）", () => {
  test("新版 App：能强制发、能重置问过了；旧版 App 两样都没有", () => {
    const fresh = detectNativeApp({ ergoNative: fakeDebugNotifyBridge() })!.notify!;
    expect(fresh.canForce).toBe(true);
    expect(fresh.resetAsked).toBeDefined();
    const old = detectNativeApp({ ergoNative: fakeNotifyBridge() })!.notify!;
    expect(old.canForce).toBe(false);
    expect(old.resetAsked).toBeUndefined();
  });

  test("前台也强制发：第 5 个参数带 true；平常照旧只给 4 个（旧版 App 一样认）", async () => {
    const bridge = fakeDebugNotifyBridge();
    const notify = detectNativeApp({ ergoNative: bridge })!.notify!;
    expect(await notify.show({ id: "n-1", title: "测试", body: "正文", route: "#/more/debug" }, { force: true })).toEqual({ outcome: "sent", detail: "通知编号 42" });
    await notify.show({ id: "n-2", title: "到点了", body: "", route: "#/inbox" });
    expect(bridge.calls).toEqual(["notifyShow n-1|测试|正文|#/more/debug|true", "notifyShow n-2|到点了||#/inbox"]);
  });

  test.each<[string, unknown, NativeNotifyShown | undefined]>([
    ["发出去了", '{"result":"published","number":42}', { outcome: "sent", detail: "通知编号 42" }],
    ["App 在前台不发", '{"result":"foreground"}', { outcome: "foreground" }],
    ["通知没打开", '{"result":"disabled","message":"notifications disabled（1600004）"}', { outcome: "denied", detail: "notifications disabled（1600004）" }],
    ["出错", '{"result":"failed","message":"bad arguments"}', { outcome: "error", detail: "bad arguments" }],
    ["不认识的结果", '{"result":"maybe"}', undefined],
    ["App 拒绝了这次调用（空串）", "", undefined],
    ["不是 JSON", "{", undefined],
  ])("App 回的发送结果：%s", (_what, json, shown) => {
    expect(parseNotifyShown(json)).toEqual(shown);
  });

  test("旧版 App 的 notifyShow 什么都不回：当 App 没回结果（undefined）；回的 Promise 失败了记出错，不抛", async () => {
    expect(await detectNativeApp({ ergoNative: fakeNotifyBridge() })!.notify!.show({ id: "n-1", title: "t", body: "", route: "#/inbox" })).toBeUndefined();
    const broken = detectNativeApp({ ergoNative: fakeDebugNotifyBridge({ reply: Promise.reject(new Error("bridge gone")) }) })!.notify!;
    expect(await broken.show({ id: "n-1", title: "t", body: "", route: "#/inbox" })).toEqual({ outcome: "error", detail: "bridge gone" });
  });

  test("通知状态带前后台（新版 App）；旧版 App 没有这一项", () => {
    expect(parseNotifyState('{"enabled":true,"asked":true,"foreground":false}')).toEqual({ enabled: true, asked: true, foreground: false });
    expect(parseNotifyState('{"enabled":true,"asked":true}')).toEqual({ enabled: true, asked: true });
  });

  test("重置问过了：调 App 的 notifyResetAsked，回之后的状态", () => {
    const bridge = fakeDebugNotifyBridge();
    expect(detectNativeApp({ ergoNative: bridge })!.notify!.resetAsked!()).toEqual({ enabled: false, asked: false, foreground: true });
    expect(bridge.calls).toEqual(["notifyResetAsked"]);
  });
});

/** 有 setTexts 的新版 App（175 号票）：记下交来的 JSON */
function textsBridge() {
  const told: string[] = [];
  return { told, bridge: { ...fakeBridge(), setTexts: (json: string) => void told.push(json) } };
}

describe("App 原生的字跟着二狗的语言（175 号票）", () => {

  test("交过去的是当前语言的每一句 harmony.*（中文下和语言文件一字不差，{name} 原样留给 App 换）", () => {
    const zh = appTexts();
    expect(zh.language).toBe("zh-CN");
    expect(zh.texts["harmony.address.heading"]).toBe("填二狗的地址");
    expect(zh.texts["harmony.downloads.saved"]).toBe("已保存「{name}」");
    expect(Object.keys(zh.texts).every((k) => k.startsWith("harmony."))).toBe(true);
    expect(Object.keys(zh.texts).length).toBeGreaterThan(50);
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    try {
      const en = appTexts();
      expect(en.language).toBe("en");
      expect(en.texts["harmony.address.heading"]).toBe("Enter Ergo's address");
      expect(Object.keys(en.texts).toSorted()).toEqual(Object.keys(zh.texts).toSorted());
      expect(Object.values(en.texts).some((v) => /[一-鿿]/.test(v))).toBe(false);
    } finally {
      setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE));
    }
  });

  test("开场交一次，换了语言再交；字没变不重复交；停下后不再交", () => {
    const { told, bridge } = textsBridge();
    const app = detectNativeApp({ ergoNative: bridge })!;
    expect(app.setTexts).toBeDefined();
    let language = "zh-CN";
    const listeners = new Set<() => void>();
    const stop = followLocaleInApp(
      app,
      () => ({ language, texts: { "harmony.index.retry": language === "en" ? "Retry" : "重试" } }),
      (fn) => {
        listeners.add(fn);
        return () => void listeners.delete(fn);
      },
    );
    expect(told.map((j) => JSON.parse(j))).toEqual([{ language: "zh-CN", texts: { "harmony.index.retry": "重试" } }]);
    for (const fn of listeners) fn();
    expect(told).toHaveLength(1);
    language = "en";
    for (const fn of listeners) fn();
    expect(JSON.parse(told[1]!)).toEqual({ language: "en", texts: { "harmony.index.retry": "Retry" } });
    stop();
    expect(listeners.size).toBe(0);
  });

  test("旧版 App 没有 setTexts：什么都不交，不抛错", () => {
    const app = detectNativeApp({ ergoNative: fakeBridge() })!;
    expect(app.setTexts).toBeUndefined();
    expect(() => followLocaleInApp(app)()).not.toThrow();
  });
});
