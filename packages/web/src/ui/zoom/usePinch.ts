// 来源：AgentSense web/src/ui/usePinch.ts（D:\code\claudecode\user_agent_sense_of_security，提交 99656b5，2026-10-09），54 号票原样搬。
// 和原文的差别只有三处，都不改行为：缩进从 tab 换成两个空格；二狗开着 noUncheckedIndexedAccess，
// dist / mid 里按下标取两根手指加了非空断言（!，调用前都查过 touches.length === 2）；
// 二狗的 lint 不许渲染时写 ref，最新的回调改在渲染完（useLayoutEffect）写进去（原文在渲染时写）。下面的注释是原文。
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

export interface PinchHandlers {
  /** 双指按下：center 为双指中点（视口坐标） */
  onStart(center: { x: number; y: number }): void;
  /** 双指移动：ratio = 起始距离 / 当前距离（>1 为内划缩小） */
  onChange(ratio: number, center: { x: number; y: number }): void;
  onEnd(): void;
}

function dist(t: TouchList) {
  return Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
}

function mid(t: TouchList) {
  return { x: (t[0]!.clientX + t[1]!.clientX) / 2, y: (t[0]!.clientY + t[1]!.clientY) / 2 };
}

export function usePinch(ref: RefObject<HTMLElement | null>, handlers: PinchHandlers) {
  const h = useRef(handlers);
  useLayoutEffect(() => {
    h.current = handlers;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let start = 0;
    // Ctrl + 滚轮连续缩放：滚动时跟手，停下来再吸附到预设档
    let wheelRatio = 0;
    let wheelTimer: ReturnType<typeof setTimeout> | undefined;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      start = dist(e.touches);
      h.current.onStart(mid(e.touches));
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !start) return;
      e.preventDefault();
      h.current.onChange(start / dist(e.touches), mid(e.touches));
    };
    const onEnd = (e: TouchEvent) => {
      if (!start || e.touches.length > 1) return;
      start = 0;
      h.current.onEnd();
    };
    const onWheel = (e: WheelEvent) => {
      // 普通滚轮照常上下滚动看历史；按住 Ctrl（Mac 上 ⌘）滚才是缩放。
      // 触控板双指捏合在浏览器里本来就以 ctrlKey 的 wheel 事件送来，所以捏合照样能缩放。
      if (!e.ctrlKey && !e.metaKey) return;
      // 当成捏合：向下缩小、向上放大；拦下浏览器自己的页面缩放
      e.preventDefault();
      const center = { x: e.clientX, y: e.clientY };
      if (!wheelRatio) {
        wheelRatio = 1;
        h.current.onStart(center);
      }
      // 向下滚 = 内划缩小，比例与捏合同一套语义
      wheelRatio *= Math.exp(e.deltaY * 0.0048);
      h.current.onChange(wheelRatio, center);
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        wheelRatio = 0;
        h.current.onEnd();
      }, 140);
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
      el.removeEventListener("wheel", onWheel);
      clearTimeout(wheelTimer);
    };
  }, [ref]);
}
