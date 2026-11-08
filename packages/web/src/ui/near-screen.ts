// 元素滚到看得见的地方附近了没有（聊天里的视频滚到附近才去取第一帧）：IntersectionObserver 盯着它，
// 以最近的那个会滚的外层（消息列表）为准，上下各多算 NEAR_MARGIN；一旦到过附近就算，之后不再盯（取到的第一帧留着）。
// 根不能用整个窗口：消息列表自己滚，列表外面的部分被它裁掉，窗口上多算的边够不到列表里还没滚出来的消息。
import { type RefObject, useEffect, useState } from "react";

/** 看得见的地方上下各多算这么多（像素）：差不多一屏，滚过来之前就取好 */
export const NEAR_MARGIN = 600;

/** 最近的那个会上下滚的外层；都不滚就是 null（以窗口为准） */
function scrollerOf(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === "auto" || y === "scroll" || y === "overlay") return p;
  }
  return null;
}

/** ref 指的元素到过看得见的地方附近就是 true（之后一直是 true）；enabled 为 false 时不盯 */
export function useNearScreen(ref: RefObject<Element | null>, enabled = true): boolean {
  // 老浏览器没有 IntersectionObserver：一开始就算在附近（直接取）
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (!enabled || near || !el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { root: scrollerOf(el), rootMargin: `${NEAR_MARGIN}px 0px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled, near]);
  return near;
}
