// Debug 工具集（124 号票）在页面上的那一份：都只在页面内存里，刷新、重开 App 就没了。
// - 入口：关于页连点版本号 8 次打开，1 小时有效（state/debug-tools.ts 的 debugTap / debugOpen），"现在收起"马上关；
// - 页面日志：页面一打开就开始收（main.tsx 第一个 import 的 page-log-start.ts 调 startPageLog），最近 200 条；
// - 通知记录：系统通知的出口（page-notify.ts）每发一条记一条，最近 20 条；
// - 页面是什么时候打开的（版本与环境里的"页面开了多久"）。
// 纯逻辑在状态层和 page-log.ts，这里只是接到 window、Date.now 上，给界面几个 hook。
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  DEBUG_LOCKED,
  debugMinutesLeft,
  debugOpen,
  debugTap,
  type DebugUnlock,
  NOTIFY_LOG_MAX,
  type NotifyRecord,
  nowIso,
  PAGE_LOG_MAX,
  type PageLogEntry,
} from "../state/index.ts";
import { collectPageLog, createListStore, type ListStore, type PageLogScope } from "./page-log.ts";

/** 页面打开的时刻（毫秒） */
export const PAGE_OPENED_AT = Date.now();

/** 页面日志（最近 200 条） */
export const pageLog: ListStore<PageLogEntry> = createListStore<PageLogEntry>(PAGE_LOG_MAX);
/** 通知记录（最近 20 条） */
export const notifyLog: ListStore<NotifyRecord> = createListStore<NotifyRecord>(NOTIFY_LOG_MAX);

let collecting = false;

/** 开始收页面日志（只收一次）：console.error / console.warn、没接住的错误和 Promise 拒绝 */
export function startPageLog(): void {
  if (collecting || typeof window === "undefined") return;
  collecting = true;
  collectPageLog(window as unknown as PageLogScope, pageLog, () => nowIso());
}

/** 一串记录（页面日志、通知记录）的最新样子 */
export function useListStore<T>(store: ListStore<T>): readonly T[] {
  return useSyncExternalStore(store.subscribe, store.list);
}

let unlock: DebugUnlock = DEBUG_LOCKED;
const unlockListeners = new Set<() => void>();

function setUnlock(next: DebugUnlock): void {
  if (next === unlock) return;
  unlock = next;
  for (const listener of unlockListeners) listener();
}

/** 点了一下关于页上的版本号：回该提示的话（第 4 次起还差几次、打开了、已经打开了），不提示是 undefined */
export function tapVersion(): string | undefined {
  const { state, hint } = debugTap(unlock, Date.now());
  setUnlock(state);
  return hint;
}

/** Debug 页上的"现在收起" */
export function closeDebug(): void {
  setUnlock(DEBUG_LOCKED);
}

/** 原型的 ?demo-debug：一打开就是打开着的 */
export function openDebugForDemo(): void {
  setUnlock({ taps: 0, openedAt: Date.now() });
}

/** 多久看一眼到没到期（还剩几分钟跟着变） */
const TICK_MS = 15_000;

/** Debug 工具集现在开着吗、还剩几分钟；到期了界面跟着变（设置列表里那一项消失） */
export function useDebugUnlock(): { open: boolean; minutesLeft: number } {
  const state = useSyncExternalStore(
    (listener) => {
      unlockListeners.add(listener);
      return () => void unlockListeners.delete(listener);
    },
    () => unlock,
  );
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (state.openedAt === undefined) return;
    const timer = setInterval(() => setTick(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [state.openedAt]);
  // 刚打开时钟还没走：按打开的那一刻算
  const now = Math.max(tick, state.openedAt ?? 0);
  return { open: debugOpen(state, now), minutesLeft: debugMinutesLeft(state, now) };
}
