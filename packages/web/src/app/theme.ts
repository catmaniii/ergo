// 外观（34 号票）在浏览器里的那一半：读写这台设备记住的选择（localStorage），给页面挂标记，跟着系统深浅色变。
// 算实际用哪种在 state/theme.ts。
//
// 页面上跟外观有关的三处：
// - 根元素的 data-theme：选了浅色、深色就挂上，跟随系统时去掉。样式按它切 color-scheme，颜色 token 用
//   light-dark() 跟着 color-scheme 走（styles/base.css）；
// - <meta name="color-scheme">：浅色 light、深色 dark、跟随系统 light dark；
// - <meta name="theme-color">：移动端浏览器地址栏的颜色，和标题栏的底色一致。
// 打开页面时 index.html 里的内联脚本在页面脚本加载前就按记住的选择挂好这三处，不先闪一下另一种颜色；
// 它和这里做的是同一件事，改一处要改另一处（test/app/theme.test.ts 比对两边的结果）。
import { resolveTheme, type Theme, type ThemeChoice, themeChoiceOf } from "../state/index.ts";
import type { DeviceStorage } from "./device-storage.ts";

/** 页面里用到的那部分：根元素和两个 meta（浏览器里就是 document；这里不写 DOM 的类型，测试在 Node 里跑） */
export interface ThemeDocument {
  documentElement: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void };
  querySelector(selector: string): { setAttribute(name: string, value: string): void } | null;
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
}

/** 记在 localStorage 里的键（index.html 的内联脚本也用它） */
const THEME_KEY = "ergou-theme";

/** 地址栏颜色：抄自标题栏的底色（base.css 的 --surface）；index.html 的 meta 初始值和内联脚本里也各有一份，测试拿 --surface 比对 */
const THEME_BAR_COLOR: Record<Theme, string> = { light: "#ffffff", dark: "#1d1f24" };

export interface ThemeController {
  /** 用户选的 */
  choice(): ThemeChoice;
  /** 实际用的 */
  theme(): Theme;
  /** 选了马上生效，并记在这台设备上 */
  choose(choice: ThemeChoice): void;
  /** 选择或实际用的外观变了（包括跟随系统时系统切了深浅色）时通知界面；返回退订 */
  subscribe(listener: () => void): () => void;
}

/** 记住的选择；没选过、不认识、存储用不了都是跟随系统 */
function loadChoice(storage: () => DeviceStorage): ThemeChoice {
  try {
    return themeChoiceOf(storage().getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

/** 记下来；跟随系统就是没选过，擦掉 */
function saveChoice(storage: () => DeviceStorage, choice: ThemeChoice): void {
  try {
    if (choice === "system") storage().removeItem(THEME_KEY);
    else storage().setItem(THEME_KEY, choice);
  } catch {
    // 存不了：这次打开里照样生效，下次打开回到跟随系统
  }
}

/** 开场读出记住的选择并挂到页面上（内联脚本已经挂过一遍，这里再挂一遍无妨），之后跟着系统深浅色变 */
export function themeControllerIn(env: ThemeEnv): ThemeController {
  let choice = loadChoice(env.storage);
  const listeners = new Set<() => void>();
  const theme = () => resolveTheme(choice, env.systemDark.matches);
  const apply = () => {
    const doc = env.document;
    if (choice === "system") doc.documentElement.removeAttribute("data-theme");
    else doc.documentElement.setAttribute("data-theme", choice);
    doc.querySelector('meta[name="color-scheme"]')?.setAttribute("content", choice === "system" ? "light dark" : choice);
    doc.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_BAR_COLOR[theme()]);
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
      saveChoice(env.storage, next);
      apply();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
