// 这个页面是不是开在鸿蒙 App 里（62 号票）：把 app/native-app.ts 接到页面的 window 上。
// 单独一个文件，app/native-app.ts 就不碰浏览器的全局变量，能在 Node 里测。
import { appBottomReserve, type BackScope, detectNativeApp, followBackInApp, followInsetsInApp, followLocaleInApp, followThemeInApp, type InsetsScope, type NativeApp } from "./native-app.ts";
import type { NativeBrowserScope } from "./native-browser.ts";
import type { NativeVoiceScope } from "./native-voice.ts";
import { pageBack } from "./page-back.ts";
import { pageTheme } from "./page-theme.ts";

let detected: { app: NativeApp | undefined } | undefined;

/** 在 App 里返回 App 能做的事，不在返回 undefined；只检测一次（App 在页面加载前就注入好了）。有原生录音时顺带登记 window.__ergoVoice */
export function pageNativeApp(): NativeApp | undefined {
  detected ??= { app: detectNativeApp(window as { ergoNative?: unknown } & NativeVoiceScope & NativeBrowserScope) };
  return detected.app;
}

/**
 * 开场调一次（main.tsx）：在 App 里就把外观告诉 App、接上返回键，之后跟着变；
 * 底部避让（105 号票）：App 把网页延伸到了手势条底下，页面底部只让开一小截（base.css 的 --safe-bottom）。
 * App 原生的字跟着二狗的语言（175 号票）。不在 App 里什么都不做
 */
export function connectNativeApp(): void {
  const app = pageNativeApp();
  if (!app) return;
  followThemeInApp(app, pageTheme());
  followBackInApp(app, pageBack(), window as BackScope);
  followLocaleInApp(app);
  followInsetsInApp(app, window as InsetsScope, (insets) => {
    document.documentElement.style.setProperty("--safe-bottom", `${appBottomReserve(insets.bottom, window.devicePixelRatio)}px`);
  });
}
