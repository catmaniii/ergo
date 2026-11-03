// 这个页面是不是开在鸿蒙 App 里：把 app/native-app.ts 接到页面的 window 上。
// 单独一个文件，app/native-app.ts 就不碰浏览器的全局变量，能在 Node 里测。
import type { ReportAppVersionParams } from "../state/index.ts";
import { appBottomReserve, type BackScope, detectNativeApp, followBackInApp, followInsetsInApp, followLocaleInApp, followThemeInApp, type InsetsScope, type NativeApp, nativeAppReport } from "./native-app.ts";
import type { AppUpdateScope } from "./native-app-update.ts";
import type { NativeBrowserScope } from "./native-browser.ts";
import type { NativeVoiceScope } from "./native-voice.ts";
import { pageBack } from "./page-back.ts";
import { pageTheme } from "./page-theme.ts";

let detected: { app: NativeApp | undefined } | undefined;

/** 在 App 里返回 App 能做的事，不在返回 undefined；只检测一次（App 在页面加载前就注入好了）。有原生录音时顺带登记 window.__ergoVoice */
export function pageNativeApp(): NativeApp | undefined {
  // 没有页面（组件在 Node 里只画样子）：不在 App 里
  if (typeof window === "undefined") return undefined;
  detected ??= { app: detectNativeApp(window as { ergoNative?: unknown } & NativeVoiceScope & NativeBrowserScope & AppUpdateScope) };
  return detected.app;
}

/** 开在 App 里时要报的版本（读不到是空串）；不在 App 里是 undefined。App 在页面加载前就注入好了，版本在 App 的一次运行里不变 */
let reported: { report: ReportAppVersionParams | undefined } | undefined;
export function pageAppReport(): ReportAppVersionParams | undefined {
  if (typeof window === "undefined") return undefined;
  reported ??= { report: nativeAppReport(window) };
  return reported.report;
}

/**
 * 开场调一次（main.tsx）：在 App 里就把外观告诉 App、接上返回键，之后跟着变；
 * 底部避让：App 把网页延伸到了手势条底下，页面底部只让开一小截（base.css 的 --safe-bottom）。
 * App 原生的字跟着二狗的语言。不在 App 里什么都不做
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
