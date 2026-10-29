// 会话现在缩放到哪一档：整个页面一份（54 号票评审）。
// 档位是 App 的一份状态，换了会话档位照旧。二狗的三处会话各是各的组件，
// 换了会话（换任务、换项目、换页）是重新挂上，从这里记着的那一档开始（ZoomHistory 的 initialLevel）；
// 标题栏的 ▤ / 💬（ZoomToggle）、返回键要不要先放大回对话层，都看这一份。
import { useSyncExternalStore } from "react";
import type { ZoomLevel } from "./zoom.ts";

let current: ZoomLevel = 0;
const listeners = new Set<() => void>();

/** 现在这一档（不订阅变化：挂上会话历史时取一次） */
export function currentZoomLevel(): ZoomLevel {
  return current;
}

/** 会话历史换了档时调 */
export function setZoomLevel(level: ZoomLevel): void {
  if (level === current) return;
  current = level;
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** 现在这一档（跟着变） */
export function useZoomLevel(): ZoomLevel {
  return useSyncExternalStore(subscribe, currentZoomLevel);
}
