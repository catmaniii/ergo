// 内置浏览器接到页面的 window 上（132 号票）。单独一个文件，app/in-app-browser.ts 就不碰浏览器的全局变量，能在 Node 里测。
import { type BrowserPage, openInAppBrowserIn } from "./in-app-browser.ts";
// 212 号票：App 的原生内置浏览器是浏览插件的，经核心留的口子取（插件没启用时照旧用嵌入框叠层）
import { openInPageNativeBrowser } from "./native-open.ts";

/** 页面的 window（内置浏览器用到的那一点） */
export function pageBrowser(): BrowserPage {
  return window;
}

/**
 * 在内置浏览器里打开二狗转发的地址（/apps/<应用名>/…，或同源的完整地址）：地址写进 hash 路由，盖在现在的页面上，
 * 关掉回到现在这一页。title 是标题栏先显示的名字（框里的页面没有 <title> 时一直用它）。
 * 不是转发的地址（外部网站）照旧在新窗口打开，返回 false。133 号票的服务入口、秘书给的入口都调它。
 * 在鸿蒙 App 里（新版 App 有原生的内置浏览器，134 号票）切到"浏览"页签、在那里打开（外部网站也是）
 */
export function openInAppBrowser(url: string, title?: string): boolean {
  return openInAppBrowserIn(pageBrowser(), url, title, openInPageNativeBrowser);
}
