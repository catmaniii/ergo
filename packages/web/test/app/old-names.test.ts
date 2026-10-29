// 312 号票：系统里的 ergou 换成了 ergo，网页这边认旧名字的地方——
// - 这台设备上记着的旧名字的键（localStorage、sessionStorage 的 ergou-*、ergou.*）：index.html 的内联脚本第一次打开时搬成新名字、删掉旧的；
// - 鸿蒙原生桥：ergoNative 优先，没有就用旧 App 挂的旧名字；网页挂给 App 调的函数新旧两个名字都挂；
// - 侧边栏模式的地址参数、地址栏历史里记的来处：旧名字照样认。
// 这里刻意写着旧名字（ergou），是兼容的测试。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { appObject, exposeToApp } from "../../src/app/app-names.ts";
import { createBackRegistry } from "../../src/app/back-registry.ts";
import { cameFrom, type HistoryEnv } from "../../src/app/history-nav.ts";
import { detectNativeApp, followBackInApp, followInsetsInApp } from "../../src/app/native-app.ts";
import { followNotifyInApp } from "../../src/app/native-notify.ts";
import { isSideMode } from "../../src/app/side-mode.ts";

/** 有 length / key 的假存储（浏览器的 Storage 那几个方法） */
function fakeStorage(initial: Record<string, string>) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    get length() {
      return items.size;
    },
    key: (i: number) => [...items.keys()][i] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, String(value)),
    removeItem: (key: string) => void items.delete(key),
  };
}

/** index.html 里那段在页面脚本之前跑的内联脚本（风格清单的表留空），在假页面、假存储上跑一遍 */
function runBootScript(storages: { localStorage: unknown; sessionStorage: unknown }) {
  const html = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const attrs = new Map<string, string>();
  const meta = { setAttribute: () => {} };
  const document = { documentElement: { setAttribute: (k: string, v: string) => void attrs.set(k, v) }, querySelector: () => meta, createElement: () => meta, head: { appendChild: () => {} } };
  const globals = {
    document,
    get localStorage() {
      return storages.localStorage;
    },
    get sessionStorage() {
      return storages.sessionStorage;
    },
    matchMedia: () => ({ matches: false }),
  };
  new Function("globals", `with (globals) {${script}}`)(globals);
  return attrs;
}

describe("这台设备上记着的旧名字的键", () => {
  test("第一次打开时搬成新名字、删掉旧的；新名字已经有了的不盖；别的键不动；外观照搬过来的定", () => {
    const local = fakeStorage({ "ergou-theme": "dark", "ergou-style": "classic", "ergou.input_mode": "voice", "ergou-locale": "{}", "ergo-accent": "red", "ergou-accent": "blue", other: "x" });
    const session = fakeStorage({ "ergou.reload_drafts": '{"secretary":"打了一半"}' });
    const attrs = runBootScript({ localStorage: local, sessionStorage: session });
    expect(Object.fromEntries(local.items)).toEqual({ "ergo-theme": "dark", "ergo-style": "classic", "ergo.input_mode": "voice", "ergo-locale": "{}", "ergo-accent": "red", other: "x" });
    expect(Object.fromEntries(session.items)).toEqual({ "ergo.reload_drafts": '{"secretary":"打了一半"}' });
    expect(attrs.get("data-theme")).toBe("dark");
  });

  test("再打开一次什么都不变；存储用不了（一碰就抛错）不碍事", () => {
    const local = fakeStorage({ "ergo-theme": "light" });
    runBootScript({ localStorage: local, sessionStorage: fakeStorage({}) });
    expect(Object.fromEntries(local.items)).toEqual({ "ergo-theme": "light" });
    const broken = {
      get length(): number {
        throw new Error("SecurityError");
      },
    };
    expect(() => runBootScript({ localStorage: broken, sessionStorage: broken })).not.toThrow();
  });
});

/** 假的原生桥 */
const bridge = () => ({ appVersion: () => "0.1.0", log: () => {}, editServer: () => {}, setColorMode: () => {}, setCanGoBack: () => {} });
/** 假的地址栏历史：当前这条记录的 state */
const historyAt = (state: unknown): HistoryEnv => ({ location: { hash: "#/tasks/t-1", replace: () => {} }, history: { state, back: () => {}, replaceState: () => {} } });

describe("鸿蒙 App 的名字", () => {

  test("原生桥 ergoNative 优先，旧 App 只挂了 ergouNative 也认得出", () => {
    expect(detectNativeApp({ ergouNative: bridge() } as never)).toMatchObject({ platform: "harmony", version: "0.1.0" });
    const fresh = { ...bridge(), appVersion: () => "0.2.0" };
    expect(detectNativeApp({ ergoNative: fresh, ergouNative: bridge() } as never)?.version).toBe("0.2.0");
    expect(appObject({ ergouSide: 1 }, "ergoSide")).toBe(1);
    expect(appObject({ ergoSide: 2, ergouSide: 1 }, "ergoSide")).toBe(2);
  });

  test("网页挂给 App 调的函数新旧两个名字都挂（返回键、避让区、通知），停下时一起撤", () => {
    const scope: Record<string, unknown> = {};
    const app = detectNativeApp({ ergoNative: { ...bridge(), safeArea: () => '{"bottom":10}' } })!;
    const stopBack = followBackInApp(app, createBackRegistry(), scope);
    const stopInsets = followInsetsInApp(app, scope, () => {});
    const stopNotify = followNotifyInApp({ takeOpened: () => undefined, state: () => undefined, prepare: async () => undefined } as never, scope, () => {}, () => false);
    for (const name of ["__ergoBack", "__ergouBack", "__ergoInsets", "__ergouInsets", "__ergoNotifyOpen", "__ergouNotifyOpen"]) expect(typeof scope[name]).toBe("function");
    expect(scope["__ergouBack"]).toBe(scope["__ergoBack"]);
    stopBack();
    stopInsets();
    stopNotify();
    expect(Object.keys(scope)).toEqual([]);
  });

  test("exposeToApp 撤的时候只撤还是自己的那个", () => {
    const scope: Record<string, unknown> = {};
    const off = exposeToApp(scope, "__ergoSide", "a");
    scope.__ergoSide = "b";
    off();
    expect(scope).toEqual({ __ergoSide: "b" });
  });
});

describe("别的旧名字", () => {
  test("侧边栏模式：旧 App 加载的 ?ergou=side 也认", () => {
    expect(isSideMode("?ergou=side")).toBe(true);
    expect(isSideMode("?ergo=side&ergou=side")).toBe(true);
    expect(isSideMode("?ergou=main")).toBe(false);
  });

  test("地址栏历史里刷新到新版之前记的来处（旧名字）照样认", () => {
    expect(cameFrom(historyAt({ ergouFrom: "#/board" }))).toBe("#/board");
    expect(cameFrom(historyAt({ ergoFrom: "#/inbox", ergouFrom: "#/board" }))).toBe("#/inbox");
    expect(cameFrom(historyAt(null))).toBeUndefined();
  });
});
