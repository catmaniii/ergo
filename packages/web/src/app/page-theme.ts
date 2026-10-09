// 这个页面的外观和视觉风格（34、39 号票）：把 app/theme.ts 接到浏览器的 document、localStorage 和系统深浅色上。
// 单独一个文件，app/theme.ts 就不碰浏览器的全局变量，能在 Node 里测。
import { BASE_STYLE, PREVIEW_FONTS_HREF, stylePageInfo, VISUAL_STYLES } from "../visual-styles/index.ts";
import { type PageElement, type ThemeController, themeControllerIn } from "./theme.ts";

let controller: ThemeController | undefined;

/** 第一次取时读出记住的选择、挂到页面上，之后跟着系统深浅色变（main.tsx 开场就取一次） */
export function pageTheme(): ThemeController {
  controller ??= themeControllerIn({
    document: {
      documentElement: document.documentElement,
      querySelector: (selector) => document.querySelector(selector),
      createElement: (tag) => document.createElement(tag),
      // 加进 <head> 的只有 createElement 造出来的 <link>
      head: { appendChild: (el: PageElement) => document.head.appendChild(el as HTMLLinkElement) },
    },
    storage: () => localStorage,
    // 没有 matchMedia 的环境当系统是浅色
    systemDark: typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : { matches: false, addEventListener() {} },
    styles: stylePageInfo(VISUAL_STYLES, BASE_STYLE),
    // 有字体的风格才有预览用的字体样式表（构建插件生成）
    ...(VISUAL_STYLES.some((s) => s.fonts?.length) ? { previewFonts: PREVIEW_FONTS_HREF } : {}),
  });
  return controller;
}
