// 系统通知的统一出口（110 号票）：到点的提醒这类"马上告诉用户"的事，除了页面顶上的框，另外发一条系统通知——
// 鸿蒙 App 里（新版 App，原生桥有通知这一组方法）交给 App 发到系统通知栏（native-notify.ts；App 在前台时 App 不发，顶上已经有了）；
// 别的地方（浏览器、旧版 App）照旧弹浏览器通知（Notification，用户允许了才弹）。两条路二选一，调用方不用管走哪条：
// 只给一条（id、标题、正文、点了去哪）。
// - 同一件事只发一条：页面里按 id 记着发过的（重渲染、重连不再发）；浏览器通知的 tag、App 的通知编号也用它
//   （几个窗口里只出一条，App 那边同一件事换掉旧的、不再响）。
// - 点了通知：浏览器里把窗口拉到前面；App 里 App 自己到了前台、把这一条交回网页——都去那一项的地址，并告诉订阅的
//   （顶上的框据此把这一条收起）。
// 不碰浏览器的全局变量（页面上那一份在 page-notify.ts），测试在 Node 里用假的 Notification、假的原生桥。
import type { NotifyEventPayload } from "../state/index.ts";
import type { NativeNotify } from "./native-notify.ts";
import { toHash } from "./route-hash.ts";

/** 要发的一条 */
export interface SystemNotice {
  /** 去重用：同一件事只发一条 */
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** 点了去哪：页面地址（#/inbox/<事项>、#/secretary/at/<消息>……） */
  readonly route: string;
}

/** 标题、正文最多多少字（含末尾的省略号）：通知栏里本来也只露一两行，太长的截短 */
export const NOTICE_TITLE_MAX = 60;
export const NOTICE_BODY_MAX = 200;
/** 地址最长多少 */
const NOTICE_ROUTE_MAX = 512;

/** 是不是页面地址（#/ 开头）：App 交回来的只认这种 */
export function isNoticeRoute(route: unknown): route is string {
  return typeof route === "string" && route.startsWith("#/") && route.length <= NOTICE_ROUTE_MAX;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** 标题、正文去掉首尾空白，太长的截短 */
export function clipNotice(notice: SystemNotice): SystemNotice {
  return { ...notice, title: clip(notice.title, NOTICE_TITLE_MAX), body: clip(notice.body, NOTICE_BODY_MAX) };
}

/**
 * 顶上的通知（到点的提醒这些，守护进程的 notify 事件）对应的一条：点了去待办里那一项，没有对应事项的去待办列表
 * （同顶上框里的"查看"）；名字占位（43 号票）换成名字本身（plain）
 */
export function alertNotice(alert: NotifyEventPayload, plain: (text: string) => string): SystemNotice {
  return {
    id: alert.id,
    title: plain(alert.title),
    body: plain(alert.body ?? ""),
    route: toHash(alert.itemId ? { tab: "inbox", itemId: alert.itemId } : { tab: "inbox" }),
  };
}

/** 浏览器通知用到的那一点（页面上是 window.Notification） */
export interface BrowserNotifications {
  /** 用户给没给：granted / denied / default */
  permission(): string;
  /** 弹一条（new Notification）；有的浏览器只许在 Service Worker 里发，会抛错 */
  show(title: string, options: { body: string; tag: string }): { onClick(listener: () => void): void; close(): void };
}

export interface SystemNotifyEnv {
  /** 鸿蒙 App 的通知（新版 App 才有）：有就走它 */
  readonly app?: Pick<NativeNotify, "show">;
  /** 浏览器通知；浏览器不支持时没有 */
  readonly browser?: BrowserNotifications;
  /** 浏览器通知被点了：把窗口拉到前面 */
  focus(): void;
  /** 去这个页面地址 */
  go(route: string): void;
}

export interface SystemNotifier {
  /** 发一条；同一个 id 只发一次 */
  show(notice: SystemNotice): void;
  /** 用户点开了一条（浏览器通知被点了，或者 App 交回来的）：去它的地址，告诉订阅的 */
  open(id: string, route: string): void;
  /** 订阅"点开了哪一条"；返回退订 */
  onOpen(listener: (id: string) => void): () => void;
}

export function createSystemNotifier(env: SystemNotifyEnv): SystemNotifier {
  const sent = new Set<string>();
  const listeners = new Set<(id: string) => void>();
  const open = (id: string, route: string) => {
    env.go(route);
    for (const listener of listeners) listener(id);
  };
  return {
    show(raw) {
      if (sent.has(raw.id)) return;
      const notice = clipNotice(raw);
      if (env.app) {
        sent.add(notice.id);
        env.app.show(notice);
        return;
      }
      const browser = env.browser;
      // 用户还没允许：先不记，之后允许了还挂着的这一条照样能弹
      if (!browser || browser.permission() !== "granted") return;
      sent.add(notice.id);
      try {
        const n = browser.show(notice.title, { body: notice.body, tag: notice.id });
        n.onClick(() => {
          env.focus();
          open(notice.id, notice.route);
          n.close();
        });
      } catch {
        // 有的浏览器（比如手机上）只允许在 Service Worker 里发通知：那就只有页面内提示
      }
    },
    open,
    onOpen(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
