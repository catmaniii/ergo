// 页面日志（124 号票：Debug 工具集的"日志与本机存储"）：页面一打开就开始收（main.tsx 里最先调 page-debug.ts 的 startPageLog），
// console.error / console.warn、没接住的错误（window 的 error 事件）、没接住的 Promise 拒绝（unhandledrejection），留最近 200 条，
// 能复制、能清空。只在页面内存里，刷新就没了。原来的 console 照常输出。
// 这里不碰浏览器的全局变量（页面上那一份在 page-debug.ts），测试用假的 console 和 window。
import { appendCapped, logText, type PageLogEntry, type PageLogSource } from "../state/index.ts";

/** 只留最近几条的一串记录（页面日志、通知记录），变了告诉订阅的 */
export interface ListStore<T> {
  list(): readonly T[];
  push(entry: T): void;
  clear(): void;
  /** 订阅变化；返回退订 */
  subscribe(listener: () => void): () => void;
}

export function createListStore<T>(max: number, initial: readonly T[] = []): ListStore<T> {
  let entries: readonly T[] = initial.slice(-max);
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    list: () => entries,
    push(entry) {
      entries = appendCapped(entries, entry, max);
      changed();
    },
    clear() {
      entries = [];
      changed();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** console 用到的那两个 */
interface ConsoleLike {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/** 页面上要接的：console 和 window 的事件 */
export interface PageLogScope {
  readonly console: ConsoleLike;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  removeEventListener(type: string, listener: (ev: unknown) => void): void;
}

/** window 的 error 事件（ErrorEvent）用到的几项 */
interface ErrorEventLike {
  message?: unknown;
  error?: unknown;
  filename?: unknown;
  lineno?: unknown;
  colno?: unknown;
}

/** 没接住的错误写成一行字：有错误对象的带堆栈；只有一句话的（跨源脚本的 Script error.）带上位置 */
function errorEventText(ev: ErrorEventLike): string {
  if (ev.error !== undefined && ev.error !== null) return logText([ev.error]);
  // @i18n-ignore-start log：页面日志（Debug 工具集里给开发者看的）
  const where = typeof ev.filename === "string" && ev.filename ? `（${ev.filename}:${String(ev.lineno ?? "?")}:${String(ev.colno ?? "?")}）` : "";
  return `${typeof ev.message === "string" ? ev.message : "没有说明的错误"}${where}`;
  // @i18n-ignore-end
}

/** 开始收：换上记录用的 console.error / console.warn，听 window 的两个事件；返回停下（换回原来的 console） */
export function collectPageLog(scope: PageLogScope, store: ListStore<PageLogEntry>, now: () => string): () => void {
  // 记的时候（通知订阅的、页面跟着画）又往 console 里写的不再记：不绕圈
  let recording = false;
  const record = (source: PageLogSource, text: () => string) => {
    if (recording) return;
    recording = true;
    try {
      store.push({ at: now(), source, text: text() });
    } finally {
      recording = false;
    }
  };
  const { console } = scope;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    record("console.error", () => logText(args));
    originalError.apply(console, args);
  };
  console.warn = (...args: unknown[]) => {
    record("console.warn", () => logText(args));
    originalWarn.apply(console, args);
  };
  const onError = (ev: unknown) => record("error", () => errorEventText((ev ?? {}) as ErrorEventLike));
  const onRejection = (ev: unknown) => record("unhandledrejection", () => logText([(ev as { reason?: unknown } | undefined)?.reason]));
  scope.addEventListener("error", onError);
  scope.addEventListener("unhandledrejection", onRejection);
  return () => {
    console.error = originalError;
    console.warn = originalWarn;
    scope.removeEventListener("error", onError);
    scope.removeEventListener("unhandledrejection", onRejection);
  };
}
