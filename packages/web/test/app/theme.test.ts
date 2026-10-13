// 外观（34 号票）和视觉风格（39 号票）在页面上的样子：
// - 选了深色，根元素带上 data-theme="dark"；选跟随系统就去掉，交给样式里的 prefers-color-scheme。color-scheme 跟着外观走；
// - 选了一套风格，根元素的 data-style 换成它，这套风格有自己的字体就挂上它的字体样式表（只在选了它时才挂）；
// - 设置里画风格预览时挂上预览用的字体样式表（只收预览里那几个字），和风格的字体样式表互不相干；
// - 移动端地址栏的颜色（theme-color）按风格和外观两样定，和标题栏的底色（风格的 --bar-bg，经典是 --surface）一致；
// - 选择记在这台设备的浏览器里；存不了、读不了就按跟随系统、经典；记住的风格已经不在清单里就按经典。
// 页面、存储、系统深浅色都换成假的。打开页面时 index.html 的内联脚本先挂一遍，结果要和页面脚本挂的一样。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { injectStyleTable } from "../../build/visual-styles-plugin.ts";
import { type ThemeEnv, themeControllerIn } from "../../src/app/theme.ts";
import { DEFAULT_VISUAL_STYLE } from "../../src/state/index.ts";
import { BASE_STYLE, effectiveTokens, PREVIEW_FONTS_HREF, resolveColor, stylePageInfo, VISUAL_STYLES } from "../../src/visual-styles/index.ts";

/** Web 包里的源文件 */
function webFile(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
}

const STYLES = stylePageInfo(VISUAL_STYLES, BASE_STYLE);

/**
 * 地址栏颜色只认一个来处：风格清单里这套风格的标题栏底色 --bar-bg（42 号票加；经典是 var(--surface)）。app/theme.ts、
 * index.html 的内联脚本都从风格清单取（内联脚本的那张表是构建时填进去的），下面的测试拿它比对
 */
function barOf(styleId: string): { light: string; dark: string } {
  const style = VISUAL_STYLES.find((s) => s.id === styleId);
  if (!style) throw new Error(`风格清单里没有 ${styleId}`);
  const tokens = effectiveTokens(style, BASE_STYLE);
  return { light: resolveColor(tokens, "bar-bg", "light"), dark: resolveColor(tokens, "bar-bg", "dark") };
}

const BAR = barOf("classic");
const GRID_BAR = barOf("grid");

/** 不在风格清单里的风格（比如以后删掉的一套） */
const RETIRED = "retired-style";

/** 假的页面元素：属性，和挂在 <head> 里没有 */
class FakeElement {
  readonly attrs = new Map<string, string>();
  parent: FakeElement[] | undefined;
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  remove() {
    const list = this.parent;
    if (list) list.splice(list.indexOf(this), 1);
    this.parent = undefined;
  }
}

/** 假页面：根元素的属性，color-scheme、theme-color 两个 meta 的 content（初始值是没设过的样子），<head> 里加进来的元素 */
function fakeDocument() {
  const rootAttrs = new Map<string, string>();
  const metas = new Map<string, FakeElement>(
    ["color-scheme", "theme-color"].map((name) => {
      const meta = new FakeElement("meta");
      meta.setAttribute("content", name === "color-scheme" ? "light dark" : "(没设过)");
      return [name, meta];
    }),
  );
  const added: FakeElement[] = [];
  return {
    rootAttrs,
    meta: (name: string) => metas.get(name)?.getAttribute("content"),
    /** 挂着的风格字体样式表 */
    fontLinks: () => added.filter((el) => el.tag === "link" && el.attrs.has("data-style-fonts")).map((el) => `${el.getAttribute("rel")} ${el.getAttribute("href")}`),
    /** 挂着的风格预览字体样式表 */
    previewFontLinks: () => added.filter((el) => el.tag === "link" && el.attrs.has("data-preview-fonts")).map((el) => `${el.getAttribute("rel")} ${el.getAttribute("href")}`),
    documentElement: {
      setAttribute: (name: string, value: string) => void rootAttrs.set(name, value),
      removeAttribute: (name: string) => void rootAttrs.delete(name),
    },
    querySelector(selector: string): FakeElement | null {
      const name = /^meta\[name="([^"]+)"\]$/.exec(selector)?.[1];
      if (name !== undefined) return metas.get(name) ?? null;
      const attr = /^link\[([a-z-]+)\]$/.exec(selector)?.[1];
      if (attr !== undefined) return added.find((el) => el.tag === "link" && el.attrs.has(attr)) ?? null;
      throw new Error(`假页面不认识的选择器：${selector}`);
    },
    createElement: (tag: string) => new FakeElement(tag),
    head: {
      appendChild(el: FakeElement) {
        el.parent = added;
        added.push(el);
        return el;
      },
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

function setup({
  systemDark = false,
  storage = memoryStorage() as ReturnType<typeof memoryStorage> | null,
  document = fakeDocument(),
  /** null：没有一套风格带字体 */
  previewFonts = PREVIEW_FONTS_HREF as string | null,
} = {}) {
  const system = fakeSystem(systemDark);
  const env: ThemeEnv = {
    document,
    storage: () => storage ?? unavailableStorage(),
    systemDark: system,
    styles: STYLES,
    ...(previewFonts === null ? {} : { previewFonts }),
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

describe("选了风格，页面马上跟着变", () => {
  test("没选过：经典，不挂字体样式表", () => {
    const { document, controller } = setup();
    expect(controller.style()).toBe("classic");
    expect(document.rootAttrs.get("data-style")).toBe("classic");
    expect(document.fontLinks()).toEqual([]);
  });

  test("选净白格栅：根元素换成它，挂上它的字体样式表，地址栏换成它的标题栏底色", () => {
    const { document, controller } = setup({ systemDark: false });
    controller.chooseStyle("grid");
    expect(controller.style()).toBe("grid");
    expect(document.rootAttrs.get("data-style")).toBe("grid");
    expect(document.fontLinks()).toEqual(["stylesheet fonts/grid.css"]);
    expect(document.meta("theme-color")).toBe(GRID_BAR.light);
  });

  test("风格和深浅色是两回事：净白格栅 + 深色", () => {
    const { document, controller } = setup({ systemDark: false });
    controller.chooseStyle("grid");
    controller.choose("dark");
    expect(document.rootAttrs.get("data-style")).toBe("grid");
    expect(document.rootAttrs.get("data-theme")).toBe("dark");
    expect(document.meta("theme-color")).toBe(GRID_BAR.dark);
    // 换回经典：深色留着，字体样式表拿掉
    controller.chooseStyle("classic");
    expect(document.rootAttrs.get("data-theme")).toBe("dark");
    expect(document.meta("theme-color")).toBe(BAR.dark);
    expect(document.fontLinks()).toEqual([]);
  });

  test("选清单里没有的风格：按经典", () => {
    const { document, controller } = setup();
    controller.chooseStyle(RETIRED);
    expect(controller.style()).toBe("classic");
    expect(document.rootAttrs.get("data-style")).toBe("classic");
  });

  test("界面在风格变了时收到通知", () => {
    const { controller } = setup();
    let notified = 0;
    controller.subscribe(() => notified++);
    controller.chooseStyle("grid");
    expect(notified).toBe(1);
  });
});

describe("经典的主色（119 号票）：选了马上换，只在经典下挂", () => {
  test("没选过：经典挂默认的蓝（就是原来的颜色）", () => {
    const { document, controller } = setup();
    expect(controller.accent()).toBe("blue");
    expect(document.rootAttrs.get("data-accent")).toBe("blue");
  });

  test("选橙：根元素马上挂上橙，界面收到通知", () => {
    const { document, controller } = setup();
    let notified = 0;
    controller.subscribe(() => notified++);
    controller.chooseAccent("orange");
    expect(controller.accent()).toBe("orange");
    expect(document.rootAttrs.get("data-accent")).toBe("orange");
    expect(notified).toBe(1);
  });

  test("换到别的风格：根元素拿掉 data-accent（别的风格不受影响）；换回经典，还是选过的橙", () => {
    const { document, controller } = setup();
    controller.chooseAccent("orange");
    controller.chooseStyle("grid");
    expect(document.rootAttrs.has("data-accent")).toBe(false);
    expect(controller.accent()).toBeUndefined();
    controller.chooseStyle("classic");
    expect(document.rootAttrs.get("data-accent")).toBe("orange");
  });

  test("别的风格下选主色：不生效，也不记", () => {
    const { document, controller, storage } = setup();
    controller.chooseStyle("grid");
    controller.chooseAccent("orange");
    expect(document.rootAttrs.has("data-accent")).toBe(false);
    expect(storage?.items.has("ergou-accent")).toBe(false);
    controller.chooseStyle("classic");
    expect(controller.accent()).toBe("blue");
  });

  test("选不认识的主色：按蓝", () => {
    const { document, controller } = setup();
    controller.chooseAccent("orange");
    controller.chooseAccent("purple");
    expect(controller.accent()).toBe("blue");
    expect(document.rootAttrs.get("data-accent")).toBe("blue");
  });

  test("设置里画经典的预览按它的主色：现在用的是别的风格也照样给经典的（别的风格没有主色）", () => {
    const { controller } = setup();
    controller.chooseAccent("teal");
    controller.chooseStyle("grid");
    expect(controller.accent("classic")).toBe("teal");
    expect(controller.accent("grid")).toBeUndefined();
    expect(controller.accent(RETIRED)).toBeUndefined();
  });
});

describe("设置里风格预览用的字体", () => {
  test("打开设置时挂上预览的字体样式表；再打开不重复挂", () => {
    const { document, controller } = setup();
    expect(document.previewFontLinks()).toEqual([]);
    controller.showPreviewFonts();
    controller.showPreviewFonts();
    expect(document.previewFontLinks()).toEqual([`stylesheet ${PREVIEW_FONTS_HREF}`]);
  });

  test("和风格的字体样式表是两样：换风格不动它，挂了它也不动风格的", () => {
    const { document, controller } = setup();
    controller.showPreviewFonts();
    controller.chooseStyle("grid");
    controller.chooseStyle("classic");
    expect(document.previewFontLinks()).toEqual([`stylesheet ${PREVIEW_FONTS_HREF}`]);
    expect(document.fontLinks()).toEqual([]);
    controller.chooseStyle("grid");
    expect(document.fontLinks()).toEqual(["stylesheet fonts/grid.css"]);
  });

  test("没有一套风格带字体（没有预览的字体样式表）：什么都不挂", () => {
    const { document, controller } = setup({ previewFonts: null });
    controller.showPreviewFonts();
    expect(document.previewFontLinks()).toEqual([]);
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

  test("选过净白格栅：再打开还是它，字体样式表也挂着；改回经典，再打开就是经典", () => {
    const first = setup();
    first.controller.chooseStyle("grid");
    const again = setup({ storage: first.storage });
    expect(again.controller.style()).toBe("grid");
    expect(again.document.fontLinks()).toEqual(["stylesheet fonts/grid.css"]);
    again.controller.chooseStyle("classic");
    expect(setup({ storage: first.storage }).controller.style()).toBe("classic");
  });

  test("记住的风格已经不在清单里（那套风格删掉了）：按经典，不挂字体样式表", () => {
    const storage = memoryStorage();
    storage.setItem("ergou-style", RETIRED);
    const { document, controller } = setup({ storage });
    expect(controller.style()).toBe("classic");
    expect(document.rootAttrs.get("data-style")).toBe("classic");
    expect(document.fontLinks()).toEqual([]);
    expect(document.meta("theme-color")).toBe(BAR.light);
  });

  test("存储用不了（隐私模式、禁用了站点数据）：按跟随系统、经典开场；选了照样马上生效，也不抛错", () => {
    const { document, controller } = setup({ systemDark: false, storage: null });
    expect(controller.choice()).toBe("system");
    expect(controller.style()).toBe("classic");
    expect(controller.accent()).toBe("blue");
    expect(() => controller.chooseAccent("green")).not.toThrow();
    expect(document.rootAttrs.get("data-accent")).toBe("green");
    expect(() => controller.choose("dark")).not.toThrow();
    expect(() => controller.chooseStyle("grid")).not.toThrow();
    expect(document.rootAttrs.get("data-theme")).toBe("dark");
    expect(document.rootAttrs.get("data-style")).toBe("grid");
    expect(controller.choice()).toBe("dark");
    expect(controller.style()).toBe("grid");
  });

  test("选过橙：再打开（刷新、新开标签页）还是橙；改回蓝就擦掉（默认就是没选过），再打开是蓝", () => {
    const first = setup();
    first.controller.chooseAccent("orange");
    expect(first.storage?.items.get("ergou-accent")).toBe("orange");
    const again = setup({ storage: first.storage });
    expect(again.controller.accent()).toBe("orange");
    expect(again.document.rootAttrs.get("data-accent")).toBe("orange");
    again.controller.chooseAccent("blue");
    expect(first.storage?.items.has("ergou-accent")).toBe(false);
    expect(setup({ storage: first.storage }).controller.accent()).toBe("blue");
  });

  test("记住的主色不认识（以后删掉的颜色、被改过的值）：按蓝", () => {
    const storage = memoryStorage();
    storage.setItem("ergou-accent", "purple");
    const { document, controller } = setup({ storage });
    expect(controller.accent()).toBe("blue");
    expect(document.rootAttrs.get("data-accent")).toBe("blue");
  });

  test("记住的是净白格栅和橙：不挂 data-accent；换回经典就是橙", () => {
    const storage = memoryStorage();
    storage.setItem("ergou-style", "grid");
    storage.setItem("ergou-accent", "orange");
    const { document, controller } = setup({ storage });
    expect(document.rootAttrs.has("data-accent")).toBe(false);
    controller.chooseStyle("classic");
    expect(document.rootAttrs.get("data-accent")).toBe("orange");
  });
});

/** 隐私模式、禁用了站点数据：一碰 localStorage 就抛错 */
function unavailableStorage(): never {
  throw new Error("SecurityError");
}

/**
 * index.html 里那段在页面脚本之前跑的内联脚本：照构建时那样把风格清单的表填进去，拿出来，
 * 在假页面、假存储、假的系统深浅色上跑一遍
 */
function runBootScript({ document, storage, systemDark }: { document: ReturnType<typeof fakeDocument>; storage: () => unknown; systemDark: boolean }) {
  const html = injectStyleTable(webFile("index.html"), STYLES);
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

/** 页面上和外观、风格有关的几处 */
function snapshot(document: ReturnType<typeof fakeDocument>) {
  return {
    theme: document.rootAttrs.get("data-theme"),
    style: document.rootAttrs.get("data-style"),
    accent: document.rootAttrs.get("data-accent"),
    colorScheme: document.meta("color-scheme"),
    themeColor: document.meta("theme-color"),
    fonts: document.fontLinks(),
  };
}

describe("打开页面不闪：页面脚本加载前就按记住的选择定下外观和风格", () => {
  test("记住的是深色、系统是浅色：内联脚本跑完，根元素已经是深色", () => {
    const document = fakeDocument();
    const storage = memoryStorage();
    storage.setItem("ergou-theme", "dark");
    runBootScript({ document, storage: () => storage, systemDark: false });
    expect(document.rootAttrs.get("data-theme")).toBe("dark");
    expect(document.meta("color-scheme")).toBe("dark");
    expect(document.meta("theme-color")).toBe(BAR.dark);
  });

  test("记住的是净白格栅：内联脚本跑完，根元素已经是它，字体样式表已经在下了", () => {
    const document = fakeDocument();
    const storage = memoryStorage();
    storage.setItem("ergou-style", "grid");
    runBootScript({ document, storage: () => storage, systemDark: true });
    expect(document.rootAttrs.get("data-style")).toBe("grid");
    expect(document.fontLinks()).toEqual(["stylesheet fonts/grid.css"]);
    expect(document.meta("theme-color")).toBe(GRID_BAR.dark);
  });

  test("页面脚本接手时不重复挂字体样式表", () => {
    const document = fakeDocument();
    const storage = memoryStorage();
    storage.setItem("ergou-style", "grid");
    runBootScript({ document, storage: () => storage, systemDark: false });
    setup({ storage, document });
    expect(document.fontLinks()).toEqual(["stylesheet fonts/grid.css"]);
  });

  test("存储用不了：按跟随系统、经典、蓝，不抛错", () => {
    const document = fakeDocument();
    expect(() => runBootScript({ document, storage: unavailableStorage, systemDark: true })).not.toThrow();
    expect(document.rootAttrs.has("data-theme")).toBe(false);
    expect(document.rootAttrs.get("data-style")).toBe("classic");
    expect(document.rootAttrs.get("data-accent")).toBe("blue");
    expect(document.meta("theme-color")).toBe(BAR.dark);
  });

  test("记住的主色是橙（119 号票）：内联脚本跑完，根元素已经挂着橙，样式表一上来就是橙色，不先闪一下蓝", () => {
    const document = fakeDocument();
    const storage = memoryStorage();
    storage.setItem("ergou-accent", "orange");
    runBootScript({ document, storage: () => storage, systemDark: false });
    expect(document.rootAttrs.get("data-style")).toBe("classic");
    expect(document.rootAttrs.get("data-accent")).toBe("orange");
  });

  const STORED_ACCENTS = [null, ...(BASE_STYLE.accents ?? []).map((a) => a.id), "purple", "__proto__"];
  test.each(STORED_ACCENTS.flatMap((accent) => [null, "classic", "grid", RETIRED].map((style) => [accent, style] as const)))(
    "记住的主色 %j、风格 %j：内联脚本和页面脚本挂出来的一样",
    (accent, style) => {
      const storage = memoryStorage();
      if (accent !== null) storage.setItem("ergou-accent", accent);
      if (style !== null) storage.setItem("ergou-style", style);
      const booted = fakeDocument();
      runBootScript({ document: booted, storage: () => storage, systemDark: false });
      const { document: running } = setup({ storage });
      expect(snapshot(booted)).toEqual(snapshot(running));
    },
  );

  const STORED_THEMES = [null, "light", "dark", "system", "sepia"];
  const STORED_STYLES = [null, ...VISUAL_STYLES.map((s) => s.id), RETIRED, "__proto__"];
  test.each(STORED_THEMES.flatMap((theme) => STORED_STYLES.flatMap((style) => [false, true].map((systemDark) => [theme, style, systemDark] as const))))(
    "记住的外观 %j、风格 %j、系统是深色 %s：内联脚本和页面脚本挂出来的一样",
    (theme, style, systemDark) => {
      const storage = memoryStorage();
      if (theme !== null) storage.setItem("ergou-theme", theme);
      if (style !== null) storage.setItem("ergou-style", style);
      const booted = fakeDocument();
      runBootScript({ document: booted, storage: () => storage, systemDark });
      const { document: running } = setup({ systemDark, storage });
      expect(snapshot(booted)).toEqual(snapshot(running));
    },
  );
});

describe("默认的风格只有一个", () => {
  test("状态层的 DEFAULT_VISUAL_STYLE、风格清单的第一项（经典）、内联脚本里退回的那个是同一个", () => {
    const html = webFile("index.html");
    const fallback = /style = "([^"]+)";/.exec(html)?.[1];
    expect({ base: BASE_STYLE.id, first: VISUAL_STYLES[0]?.id, inline: fallback }).toEqual({ base: DEFAULT_VISUAL_STYLE, first: DEFAULT_VISUAL_STYLE, inline: DEFAULT_VISUAL_STYLE });
    expect(VISUAL_STYLES[0]).toBe(BASE_STYLE);
  });
});

describe("地址栏颜色和标题栏底色一致", () => {
  test("经典、净白格栅的标题栏底色就是卡片的底色 --surface：加 --bar-bg（42 号票）之前地址栏就是这个颜色，表现不变", () => {
    for (const id of ["classic", "grid"]) {
      const tokens = effectiveTokens(VISUAL_STYLES.find((s) => s.id === id)!, BASE_STYLE);
      expect(barOf(id)).toEqual({ light: resolveColor(tokens, "surface", "light"), dark: resolveColor(tokens, "surface", "dark") });
    }
  });

  test("index.html 里 theme-color 的初始值是经典浅色的标题栏底色", () => {
    expect(/<meta name="theme-color" content="([^"]*)"/.exec(webFile("index.html"))?.[1]).toBe(BAR.light);
  });

  test.each(VISUAL_STYLES.flatMap((style) => (["light", "dark"] as const).map((theme) => [style.id, theme] as const)))(
    "%s · %s：内联脚本、页面脚本给出的地址栏颜色都是这套风格的 --bar-bg",
    (styleId, theme) => {
      const storage = memoryStorage();
      storage.setItem("ergou-style", styleId);
      const booted = fakeDocument();
      runBootScript({ document: booted, storage: () => storage, systemDark: theme === "dark" });
      const { document: running } = setup({ systemDark: theme === "dark", storage });
      const expected = barOf(styleId)[theme];
      expect({ inline: booted.meta("theme-color"), page: running.meta("theme-color") }).toEqual({ inline: expected, page: expected });
    },
  );
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

  test("净白格栅、跟随系统：系统切深色，地址栏换成它的深色底", () => {
    const { document, system, controller } = setup({ systemDark: false });
    controller.chooseStyle("grid");
    system.flip(true);
    expect(document.meta("theme-color")).toBe(GRID_BAR.dark);
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
