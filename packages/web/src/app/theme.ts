// 外观（34 号票）和视觉风格（39 号票）在浏览器里的那一半：读写这台设备记住的选择（localStorage），给页面挂标记，
// 跟着系统深浅色变。算实际用哪种在 state/theme.ts、state/visual-style.ts；有哪几套风格在 src/visual-styles/。
//
// 页面上跟外观、风格有关的几处：
// - 根元素的 data-theme：选了浅色、深色就挂上，跟随系统时去掉。样式按它切 color-scheme，颜色 token 用
//   light-dark() 跟着 color-scheme 走（styles/base.css）；
// - 根元素的 data-style：现在用哪套风格（记住的不在风格清单里就是经典）。风格的 token 挂在 [data-style="<id>"] 上；
// - <meta name="color-scheme">：浅色 light、深色 dark、跟随系统 light dark；
// - <meta name="theme-color">：移动端浏览器地址栏的颜色，和这套风格的标题栏底色（--surface）一致；
// - <link rel="stylesheet" data-style-fonts>：这套风格自己的字体（只在选了它时挂；没有自己的字体就不挂）；
// - <link rel="stylesheet" data-preview-fonts>：设置里风格预览用的字体（只收预览场景里那几个字，打开设置时挂一次）。
// 打开页面时 index.html 里的内联脚本在页面脚本加载前就按记住的选择挂好这几处，不先闪一下另一种颜色、另一套风格；
// 它和这里做的是同一件事，改一处要改另一处（test/app/theme.test.ts 比对两边的结果）。
import { DEFAULT_VISUAL_STYLE, resolveTheme, type Theme, type ThemeChoice, themeChoiceOf, visualStyleOf } from "../state/index.ts";
import type { StylePageInfo } from "../visual-styles/page.ts";
import type { DeviceStorage } from "./device-storage.ts";

/** 页面里用到的元素：meta、link（浏览器里就是 Element；这里不写 DOM 的类型，测试在 Node 里跑） */
export interface PageElement {
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  remove(): void;
}

/** 页面里用到的那部分：根元素、两个 meta、<head> 里的字体样式表（浏览器里由 page-theme.ts 接到 document 上） */
export interface ThemeDocument {
  documentElement: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void };
  querySelector(selector: string): PageElement | null;
  createElement(tag: "link"): PageElement;
  head: { appendChild(el: PageElement): unknown };
}

/** 系统是不是深色：matchMedia("(prefers-color-scheme: dark)") 用到的那部分 */
export interface SystemDark {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
}

export interface ThemeEnv {
  document: ThemeDocument;
  /** 取不到（隐私模式、禁用了站点数据）时抛错 */
  storage(): DeviceStorage;
  systemDark: SystemDark;
  /** 风格清单里每套风格在页面上要挂的东西（visual-styles/page.ts 的 stylePageInfo），至少要有经典 */
  styles: Readonly<Record<string, StylePageInfo>>;
  /** 设置里风格预览用的字体样式表（visual-styles/page.ts 的 PREVIEW_FONTS_HREF）；没有一套风格带字体就不给 */
  previewFonts?: string;
}

/** 记在 localStorage 里的键（index.html 的内联脚本也用它们） */
const THEME_KEY = "ergou-theme";
const STYLE_KEY = "ergou-style";

/** 风格字体样式表的记号（index.html 的内联脚本挂的也带它）、风格预览字体样式表的记号 */
const FONTS_MARK = "data-style-fonts";
const PREVIEW_FONTS_MARK = "data-preview-fonts";

export interface ThemeController {
  /** 用户选的外观 */
  choice(): ThemeChoice;
  /** 实际用的外观 */
  theme(): Theme;
  /** 选了马上生效，并记在这台设备上 */
  choose(choice: ThemeChoice): void;
  /** 现在用的风格（风格清单里的 id） */
  style(): string;
  /** 选一套风格：马上生效，并记在这台设备上；清单里没有的按经典 */
  chooseStyle(id: string): void;
  /** 选择、风格或实际用的外观变了（包括跟随系统时系统切了深浅色）时通知界面；返回退订 */
  subscribe(listener: () => void): () => void;
  /** 设置里画风格预览时调：挂上预览用的字体样式表（挂过就不再挂，离开设置也留着；没有就什么都不做） */
  showPreviewFonts(): void;
}

/** 读记住的值；存储用不了就当没记过 */
function load(storage: () => DeviceStorage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

/** 记下来；默认值（跟随系统、经典）就是没选过，擦掉 */
function save(storage: () => DeviceStorage, key: string, value: string, isDefault: boolean): void {
  try {
    if (isDefault) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    // 存不了：这次打开里照样生效，下次打开回到默认
  }
}

/** <head> 里带某个记号的样式表：换成这个地址（已经是就不动），地址是 undefined 就拿掉 */
function setStylesheet(doc: ThemeDocument, mark: string, href: string | undefined): void {
  const link = doc.querySelector(`link[${mark}]`);
  if ((link?.getAttribute("href") ?? undefined) === href) return;
  link?.remove();
  if (href === undefined) return;
  const el = doc.createElement("link");
  el.setAttribute("rel", "stylesheet");
  el.setAttribute("href", href);
  el.setAttribute(mark, "");
  doc.head.appendChild(el);
}

/** 开场读出记住的选择并挂到页面上（内联脚本已经挂过一遍，这里再挂一遍无妨），之后跟着系统深浅色变 */
export function themeControllerIn(env: ThemeEnv): ThemeController {
  const known = Object.keys(env.styles);
  let choice = themeChoiceOf(load(env.storage, THEME_KEY));
  let style = visualStyleOf(load(env.storage, STYLE_KEY), known);
  const listeners = new Set<() => void>();
  const theme = () => resolveTheme(choice, env.systemDark.matches);
  const apply = () => {
    const doc = env.document;
    const info = env.styles[style]!;
    if (choice === "system") doc.documentElement.removeAttribute("data-theme");
    else doc.documentElement.setAttribute("data-theme", choice);
    doc.documentElement.setAttribute("data-style", style);
    doc.querySelector('meta[name="color-scheme"]')?.setAttribute("content", choice === "system" ? "light dark" : choice);
    doc.querySelector('meta[name="theme-color"]')?.setAttribute("content", info.bar[theme()]);
    // 字体样式表：只挂现在这套风格的；内联脚本挂过同一份就留着
    setStylesheet(doc, FONTS_MARK, info.fonts);
    for (const listener of listeners) listener();
  };
  apply();
  // 颜色由样式里的 prefers-color-scheme 自己跟着变；这里只换地址栏的颜色、告诉界面
  env.systemDark.addEventListener("change", apply);
  return {
    choice: () => choice,
    theme,
    choose(next) {
      choice = next;
      save(env.storage, THEME_KEY, next, next === "system");
      apply();
    },
    style: () => style,
    chooseStyle(id) {
      style = visualStyleOf(id, known);
      save(env.storage, STYLE_KEY, style, style === DEFAULT_VISUAL_STYLE);
      apply();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    showPreviewFonts() {
      if (env.previewFonts !== undefined) setStylesheet(env.document, PREVIEW_FONTS_MARK, env.previewFonts);
    },
  };
}
