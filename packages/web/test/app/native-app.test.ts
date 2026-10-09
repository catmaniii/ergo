// 鸿蒙 App（62 号票）：App 用 ArkWeb 的 javaScriptProxy 往页面里注入 window.ergouNative。网页检测到它时，
// 设置里显示"在鸿蒙 App 里运行"和 App 版本，外观告诉 App（状态栏、窗口底色跟着变），设置里能回到 App 的地址页；
// 没有时什么都不变。原生桥换成假的。
import { describe, expect, test } from "vitest";
import { createBackRegistry } from "../../src/app/back-registry.ts";
import { detectNativeApp, followBackInApp, followThemeInApp } from "../../src/app/native-app.ts";
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
