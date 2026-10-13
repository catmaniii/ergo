// 系统通知的出口接到页面上（110 号票）：app/system-notify.ts 不碰浏览器的全局变量，这里接上 window.Notification、
// 鸿蒙 App 的原生桥（page-native.ts）和页面地址。单独一个文件，system-notify.ts、native-notify.ts 就能在 Node 里测。
import { pushHash } from "./history-nav.ts";
import { followNotifyInApp, type NotifyOpenScope } from "./native-notify.ts";
import { pageNativeApp } from "./page-native.ts";
import { parseHash, toHash } from "./route-hash.ts";
import { type BrowserNotifications, createSystemNotifier, type SystemNotifier } from "./system-notify.ts";

let notifier: SystemNotifier | undefined;

/** 浏览器通知；浏览器不支持时没有 */
function browserNotifications(): BrowserNotifications | undefined {
  if (typeof window === "undefined" || !("Notification" in window)) return undefined;
  return {
    permission: () => Notification.permission,
    show(title, options) {
      const n = new Notification(title, options);
      return { onClick: (listener) => n.addEventListener("click", listener), close: () => n.close() };
    },
  };
}

/** 这个页面的那一份出口（几处发通知共用：同一件事只发一条） */
export function pageNotifier(): SystemNotifier {
  notifier ??= createSystemNotifier({
    app: pageNativeApp()?.notify,
    browser: browserNotifications(),
    focus: () => window.focus(),
    // 和页面里的跳转一样压一条记录、记下来处（route.ts 的 navigate）
    go: (route) => pushHash(window, toHash(parseHash(route))),
  });
  return notifier;
}

/** 在 App 里、App 能发通知（新版 App）：浏览器通知的"允许"不用再问（App 自己问） */
export function appNotifies(): boolean {
  return pageNativeApp()?.notify !== undefined;
}

/**
 * 开场调一次（main.tsx，在页面画出来之前）：在 App 里接上"点了通知回来去那一项"（开场取一次：被点开的通知拉起来的，
 * 这时改的地址页面一画出来就是那一页），第一次向用户要通知授权。不在 App 里、旧版 App 什么都不做
 */
export function connectSystemNotify(): void {
  const notify = pageNativeApp()?.notify;
  if (!notify) return;
  followNotifyInApp(notify, window as NotifyOpenScope, (opened) => pageNotifier().open(opened.id, opened.route), () => document.visibilityState === "visible");
}
