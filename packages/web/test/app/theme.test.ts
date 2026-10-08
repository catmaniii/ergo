// 外观（34 号票）在页面上的样子：选了深色，根元素带上 data-theme="dark"；选跟随系统就去掉，交给样式里的
// prefers-color-scheme。color-scheme 和移动端地址栏的颜色（theme-color）跟着外观走。选择记在这台设备的浏览器里，
// 存不了、读不了就按跟随系统。页面、存储、系统深浅色都换成假的。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { type ThemeEnv, themeControllerIn } from "../../src/app/theme.ts";

/** Web 包里的源文件 */
function webFile(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
}

/**
 * 地址栏颜色只认一个来处：base.css 里标题栏的底色 `--surface: light-dark(浅色, 深色)`。
 * app/theme.ts、index.html（meta 的初始值和内联脚本）各有一份抄的，下面的测试拿它比对
 */
function surfaceColors(): { light: string; dark: string } {
  const [, light, dark] = /--surface:\s*light-dark\(\s*(#[0-9a-fA-F]+)\s*,\s*(#[0-9a-fA-F]+)\s*\)/.exec(webFile("src/styles/base.css")) ?? [];
  if (!light || !dark) throw new Error("base.css 里找不到 --surface: light-dark(浅色, 深色)");
  return { light, dark };
}

const BAR = surfaceColors();

/** 假页面：根元素的属性，和 color-scheme、theme-color 两个 meta 的 content（初始值是没设过的样子） */
function fakeDocument() {
  const rootAttrs = new Map<string, string>();
  const metas = new Map<string, Map<string, string>>([
    ["color-scheme", new Map([["content", "light dark"]])],
    ["theme-color", new Map([["content", "(没设过)"]])],
  ]);
  return {
    rootAttrs,
    meta: (name: string) => metas.get(name)?.get("content"),
    documentElement: {
      setAttribute: (name: string, value: string) => void rootAttrs.set(name, value),
      removeAttribute: (name: string) => void rootAttrs.delete(name),
    },
    querySelector(selector: string) {
      const name = /^meta\[name="([^"]+)"\]$/.exec(selector)?.[1];
      const attrs = name === undefined ? undefined : metas.get(name);
      return attrs ? { setAttribute: (k: string, v: string) => void attrs.set(k, v) } : null;
    },
  };
}

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

/** 假的"系统是不是深色"：可以在测试里切换 */
function fakeSystem(dark: boolean) {
  const listeners = new Set<() => void>();
  return {
    matches: dark,
    addEventListener: (_type: "change", fn: () => void) => void listeners.add(fn),
    removeEventListener: (_type: "change", fn: () => void) => void listeners.delete(fn),
    flip(next: boolean) {
      this.matches = next;
      for (const fn of listeners) fn();
    },
  };
}

function setup({ systemDark = false, storage = memoryStorage() as ReturnType<typeof memoryStorage> | null } = {}) {
  const document = fakeDocument();
  const system = fakeSystem(systemDark);
  const env: ThemeEnv = {
    document,
    storage: () => storage ?? unavailableStorage(),
    systemDark: system,
  };
  return { document, system, storage, env, controller: themeControllerIn(env) };
}

describe("选了外观，页面马上跟着变", () => {
  test("选深色：根元素带上 dark 标记，color-scheme 和地址栏都是深色；系统是浅色也一样", () => {
    const { document, controller } = setup({ systemDark: false });
    controller.choose("dark");
    expect(document.rootAttrs.get("data-theme")).toBe("dark");
    expect(document.meta("color-scheme")).toBe("dark");
    expect(document.meta("theme-color")).toBe(BAR.dark);
    expect(controller.choice()).toBe("dark");
    expect(controller.theme()).toBe("dark");
  });

  test("选浅色：系统是深色也用浅色", () => {
    const { document, controller } = setup({ systemDark: true });
    controller.choose("light");
    expect(document.rootAttrs.get("data-theme")).toBe("light");
    expect(document.meta("color-scheme")).toBe("light");
    expect(document.meta("theme-color")).toBe(BAR.light);
    expect(controller.theme()).toBe("light");
  });

  test("从深色改回跟随系统：去掉标记，color-scheme 交给系统，地址栏照系统", () => {
    const { document, controller } = setup({ systemDark: false });
    controller.choose("dark");
    controller.choose("system");
    expect(document.rootAttrs.has("data-theme")).toBe(false);
    expect(document.meta("color-scheme")).toBe("light dark");
    expect(document.meta("theme-color")).toBe(BAR.light);
    expect(controller.theme()).toBe("light");
  });
});

describe("按设备记住", () => {
  test("没选过：跟随系统，不挂标记，地址栏照系统", () => {
    const { document, controller } = setup({ systemDark: true });
    expect(controller.choice()).toBe("system");
    expect(controller.theme()).toBe("dark");
    expect(document.rootAttrs.has("data-theme")).toBe(false);
    expect(document.meta("theme-color")).toBe(BAR.dark);
  });

  test("选过深色：再打开（刷新、新开标签页）还是深色", () => {
    const first = setup({ systemDark: false });
    first.controller.choose("dark");
    const again = setup({ systemDark: false, storage: first.storage });
    expect(again.controller.choice()).toBe("dark");
    expect(again.document.rootAttrs.get("data-theme")).toBe("dark");
    expect(again.document.meta("theme-color")).toBe(BAR.dark);
  });

  test("改回跟随系统：再打开也是跟随系统", () => {
    const first = setup();
    first.controller.choose("light");
    first.controller.choose("system");
    expect(setup({ storage: first.storage }).controller.choice()).toBe("system");
  });

  test("记住的值不认识：按跟随系统", () => {
    const storage = memoryStorage();
    storage.setItem("ergou-theme", "sepia");
    const { document, controller } = setup({ systemDark: true, storage });
    expect(controller.choice()).toBe("system");
    expect(document.rootAttrs.has("data-theme")).toBe(false);
  });

  test("存储用不了（隐私模式、禁用了站点数据）：按跟随系统开场；选了照样马上生效，也不抛错", () => {
    const { document, controller } = setup({ systemDark: false, storage: null });
    expect(controller.choice()).toBe("system");
    expect(() => controller.choose("dark")).not.toThrow();
    expect(document.rootAttrs.get("data-theme")).toBe("dark");
    expect(controller.choice()).toBe("dark");
  });
});

/** 隐私模式、禁用了站点数据：一碰 localStorage 就抛错 */
function unavailableStorage(): never {
  throw new Error("SecurityError");
}

/** index.html 里那段在页面脚本之前跑的内联脚本：拿出来，在假页面、假存储、假的系统深浅色上跑一遍 */
function runBootScript({ document, storage, systemDark }: { document: ReturnType<typeof fakeDocument>; storage: () => unknown; systemDark: boolean }) {
  const html = webFile("index.html");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(scripts).toHaveLength(1);
  const globals = {
    document,
    get localStorage() {
      return storage();
    },
    matchMedia: (query: string) => ({ matches: query === "(prefers-color-scheme: dark)" && systemDark }),
  };
  // 浏览器里这几个都是全局变量；用 with 把假的换进去（内联脚本不是严格模式）
  new Function("globals", `with (globals) {${scripts[0]}}`)(globals);
}

describe("打开页面不闪：页面脚本加载前就按记住的选择定下外观", () => {
  test("记住的是深色、系统是浅色：内联脚本跑完，根元素已经是深色", () => {
    const document = fakeDocument();
    const storage = memoryStorage();
    storage.setItem("ergou-theme", "dark");
    runBootScript({ document, storage: () => storage, systemDark: false });
    expect(document.rootAttrs.get("data-theme")).toBe("dark");
    expect(document.meta("color-scheme")).toBe("dark");
    expect(document.meta("theme-color")).toBe(BAR.dark);
  });

  test("存储用不了：按跟随系统，不抛错", () => {
    const document = fakeDocument();
    expect(() => runBootScript({ document, storage: unavailableStorage, systemDark: true })).not.toThrow();
    expect(document.rootAttrs.has("data-theme")).toBe(false);
    expect(document.meta("theme-color")).toBe(BAR.dark);
  });

  test.each([null, "light", "dark", "system", "sepia"].flatMap((stored) => [false, true].map((systemDark) => [stored, systemDark] as const)))(
    "记住的是 %j、系统是深色 %s：内联脚本和页面脚本挂出来的一样",
    (stored, systemDark) => {
      const storage = memoryStorage();
      if (stored !== null) storage.setItem("ergou-theme", stored);
      const booted = fakeDocument();
      runBootScript({ document: booted, storage: () => storage, systemDark });
      const { document: running } = setup({ systemDark, storage });
      expect([booted.rootAttrs.get("data-theme"), booted.meta("color-scheme"), booted.meta("theme-color")]).toEqual([
        running.rootAttrs.get("data-theme"),
        running.meta("color-scheme"),
        running.meta("theme-color"),
      ]);
    },
  );
});

describe("地址栏颜色和标题栏底色一致", () => {
  test("index.html 里 theme-color 的初始值、内联脚本、页面脚本给出的浅深两种颜色，都和 base.css 的 --surface 一样", () => {
    expect(/<meta name="theme-color" content="([^"]*)"/.exec(webFile("index.html"))?.[1]).toBe(BAR.light);
    for (const theme of ["light", "dark"] as const) {
      const booted = fakeDocument();
      runBootScript({ document: booted, storage: () => memoryStorage(), systemDark: theme === "dark" });
      const { document: running } = setup({ systemDark: theme === "dark" });
      expect({ inline: booted.meta("theme-color"), page: running.meta("theme-color") }).toEqual({ inline: BAR[theme], page: BAR[theme] });
    }
  });
});

describe("系统切换深浅色", () => {
  test("跟随系统时实时跟着变：地址栏换色，界面收到通知", () => {
    const { document, system, controller } = setup({ systemDark: false });
    let notified = 0;
    controller.subscribe(() => notified++);
    system.flip(true);
    expect(controller.theme()).toBe("dark");
    expect(document.meta("theme-color")).toBe(BAR.dark);
    expect(document.rootAttrs.has("data-theme")).toBe(false);
    expect(notified).toBe(1);
    system.flip(false);
    expect(controller.theme()).toBe("light");
    expect(document.meta("theme-color")).toBe(BAR.light);
  });

  test("选了深色：系统怎么切都还是深色", () => {
    const { document, system, controller } = setup({ systemDark: false });
    controller.choose("dark");
    system.flip(true);
    system.flip(false);
    expect(controller.theme()).toBe("dark");
    expect(document.rootAttrs.get("data-theme")).toBe("dark");
    expect(document.meta("theme-color")).toBe(BAR.dark);
  });

  test("界面在选择变了时也收到通知；退订之后不再收到", () => {
    const { system, controller } = setup();
    let notified = 0;
    const off = controller.subscribe(() => notified++);
    controller.choose("dark");
    expect(notified).toBe(1);
    off();
    controller.choose("light");
    system.flip(true);
    expect(notified).toBe(1);
  });
});
