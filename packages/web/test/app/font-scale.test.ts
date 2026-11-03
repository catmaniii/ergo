// 界面字号在页面上的样子：
// - 选了比例写在根元素的 --fs-k 上；是 1 时擦掉（和没有这个功能时一样）；
// - 按设备、按屏幕形态各记一份：手机上调了，换到折叠屏展开（中屏）用中屏自己那份，折回来还是手机那份；
// - 重开页面（再建一个控制器、再跑一遍内联脚本）照样是记住的那份；存储用不了时按 1，不报错；
// - 打开页面时 index.html 的内联脚本先写一遍，结果要和页面脚本写的一样。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { type FontScaleEnv, fontScaleControllerIn } from "../../src/app/font-scale.ts";

/** 假的根元素：style 上的自定义属性（--fs-k）、属性（data-font-scale） */
function fakeRoot() {
  const props = new Map<string, string>();
  const attrs = new Map<string, string>();
  return {
    props,
    attrs,
    style: {
      setProperty: (name: string, value: string) => void props.set(name, value),
      removeProperty: (name: string) => {
        const old = props.get(name) ?? "";
        props.delete(name);
        return old;
      },
    },
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
    removeAttribute: (name: string) => void attrs.delete(name),
  };
}

/** 根元素上和字号有关的两处 */
const marks = (root: ReturnType<typeof fakeRoot>) => ({ scale: root.props.get("--fs-k"), mark: root.attrs.get("data-font-scale") });

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

/** 假窗口：宽度可以改，改了叫一声 resize */
function fakeWindow(width: number) {
  const listeners = new Set<() => void>();
  return {
    width,
    resize(next: number) {
      this.width = next;
      for (const fn of listeners) fn();
    },
    onResize: (fn: () => void) => void listeners.add(fn),
  };
}

function setup(width: number, storage: ReturnType<typeof memoryStorage> | null = memoryStorage()) {
  const root = fakeRoot();
  const win = fakeWindow(width);
  const env: FontScaleEnv = {
    root,
    storage: () => {
      if (!storage) throw new Error("SecurityError");
      return storage;
    },
    width: () => win.width,
    onResize: win.onResize,
  };
  return { root, win, storage, controller: fontScaleControllerIn(env) };
}

/** index.html 里界面字号那一段内联脚本：在假窗口、假根元素、假存储上跑一遍，给出写在根元素上的 --fs-k */
function runBootScript(width: number, storage: () => unknown): ReturnType<typeof marks> {
  const html = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).filter((s) => s.includes("ergo-font-scale-"));
  expect(scripts).toHaveLength(1);
  const root = fakeRoot();
  const globals = {
    window: { innerWidth: width },
    document: { documentElement: root },
    get localStorage() {
      return storage();
    },
  };
  // 浏览器里这几个都是全局变量；用 with 把假的换进去（内联脚本不是严格模式）
  new Function("globals", `with (globals) {${scripts[0]}}`)(globals);
  return marks(root);
}

describe("界面字号写在根元素上", () => {
  test("没调过：不写 --fs-k，比例是 1", () => {
    const { root, controller } = setup(390);
    expect(controller.form()).toBe("narrow");
    expect(controller.scale()).toBe(1);
    expect(root.props.has("--fs-k")).toBe(false);
  });

  test("调到 1.25：根元素马上是 1.25，记在手机那一格；调回 1 擦掉", () => {
    const { root, storage, controller } = setup(390);
    let told = 0;
    controller.subscribe(() => told++);
    controller.choose(1.25);
    expect(marks(root)).toEqual({ scale: "1.25", mark: "up" });
    expect(storage!.items.get("ergo-font-scale-narrow")).toBe("1.25");
    expect(told).toBe(1);
    controller.choose(0.9);
    expect(marks(root)).toEqual({ scale: "0.9", mark: "down" });
    controller.choose(1);
    expect(marks(root)).toEqual({ scale: undefined, mark: undefined });
    expect(storage!.items.has("ergo-font-scale-narrow")).toBe(false);
  });

  test("超出范围、不在格上的落到范围里取整", () => {
    const { root, controller } = setup(390);
    controller.choose(2);
    expect(root.props.get("--fs-k")).toBe("1.5");
    controller.choose(0.5);
    expect(root.props.get("--fs-k")).toBe("0.85");
    controller.choose(1.17);
    expect(controller.scale()).toBe(1.15);
  });

  test("手机上调到 1.25，展开成中屏用中屏自己那份（没调过是 1），中屏调成 1.15，折回手机还是 1.25", () => {
    const { root, win, storage, controller } = setup(390);
    controller.choose(1.25);
    win.resize(720);
    expect(controller.form()).toBe("medium");
    expect(controller.scale()).toBe(1);
    expect(root.props.has("--fs-k")).toBe(false);
    controller.choose(1.15);
    expect(storage!.items.get("ergo-font-scale-medium")).toBe("1.15");
    win.resize(390);
    expect(controller.scale()).toBe(1.25);
    expect(root.props.get("--fs-k")).toBe("1.25");
    win.resize(1280);
    expect(controller.form()).toBe("wide");
    expect(controller.scale()).toBe(1);
  });

  test("同一种形态里改窗口大小不重读、不通知", () => {
    const { win, controller } = setup(390);
    let told = 0;
    controller.subscribe(() => told++);
    win.resize(400);
    expect(told).toBe(0);
  });

  test("重开页面：再建一个控制器，还是记住的那份", () => {
    const first = setup(720);
    first.controller.choose(1.3);
    const again = setup(720, first.storage);
    expect(again.controller.scale()).toBe(1.3);
    expect(again.root.props.get("--fs-k")).toBe("1.3");
  });

  test("存储用不了：按 1，调了这次照样生效，不报错", () => {
    const { root, controller } = setup(390, null);
    expect(controller.scale()).toBe(1);
    controller.choose(1.25);
    expect(root.props.get("--fs-k")).toBe("1.25");
  });
});

describe("打开页面不闪：页面脚本加载前就按记住的比例写好 --fs-k", () => {
  test.each<[number, Record<string, string>]>([
    [390, {}],
    [390, { "ergo-font-scale-narrow": "1.25" }],
    [390, { "ergo-font-scale-medium": "1.25" }],
    [599, { "ergo-font-scale-narrow": "0.85" }],
    [600, { "ergo-font-scale-medium": "1.5" }],
    [720, { "ergo-font-scale-medium": "1.17" }],
    [839, { "ergo-font-scale-medium": "9" }],
    [840, { "ergo-font-scale-wide": "0.1" }],
    [1280, { "ergo-font-scale-wide": "1.15", "ergo-font-scale-narrow": "1.3" }],
    [1280, { "ergo-font-scale-wide": "坏了" }],
    [1280, { "ergo-font-scale-wide": "1" }],
  ])("宽 %i、记住的 %j：内联脚本和页面脚本写的一样", (width, items) => {
    const storage = memoryStorage();
    for (const [k, v] of Object.entries(items)) storage.items.set(k, v);
    const booted = runBootScript(width, () => storage);
    const running = setup(width, storage);
    expect(booted).toEqual(marks(running.root));
  });

  test("存储用不了：内联脚本不写、不抛错", () => {
    expect(
      runBootScript(390, () => {
        throw new Error("SecurityError");
      }),
    ).toEqual({ scale: undefined, mark: undefined });
  });
});
