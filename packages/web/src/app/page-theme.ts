// 这个页面的外观（34 号票）：把 app/theme.ts 接到浏览器的 document、localStorage 和系统深浅色上。
// 单独一个文件，app/theme.ts 就不碰浏览器的全局变量，能在 Node 里测。
import { type ThemeController, themeControllerIn } from "./theme.ts";

let controller: ThemeController | undefined;

/** 第一次取时读出记住的选择、挂到页面上，之后跟着系统深浅色变（main.tsx 开场就取一次） */
export function pageTheme(): ThemeController {
  controller ??= themeControllerIn({
    document,
    storage: () => localStorage,
    // 没有 matchMedia 的环境当系统是浅色
    systemDark: typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : { matches: false, addEventListener() {} },
  });
  return controller;
}
