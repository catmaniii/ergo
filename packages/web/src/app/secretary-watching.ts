// 页面上别处开着的秘书会话（444：地图页右边的二狗聊天窗）报"秘书会话正被看着"：主框架据此不在顶上提醒秘书说完了一轮
// （和在秘书页、"浏览"右边的侧边栏开着时一样，app/secretary-unread.ts 的 useSecretaryAlerts）。
// 整个页面一份；按来源记（同一来源报两次只算一次），全部关掉才算没在看。
import { useSyncExternalStore } from "react";

const sources = new Set<string>();
const listeners = new Set<() => void>();

/** 某一处开着 / 关掉了秘书会话 */
export function setSecretaryWatching(source: string, on: boolean): void {
  const before = sources.size > 0;
  if (on) sources.add(source);
  else sources.delete(source);
  if (before === sources.size > 0) return;
  for (const listener of listeners) listener();
}

/** 别处有没有开着秘书会话 */
export function secretaryWatchedElsewhere(): boolean {
  return sources.size > 0;
}

export function useSecretaryWatchedElsewhere(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    secretaryWatchedElsewhere,
  );
}
