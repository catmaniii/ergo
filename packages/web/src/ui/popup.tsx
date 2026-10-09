/**
 * 弹出菜单（长按菜单、下拉这类贴着某个元素弹出的菜单）：画在应用框最上面的一层，浮在一切之上。
 *
 * 为什么不就地画（用户 2026-10-10 反馈：长按语音气泡的菜单被底部的输入栏挡住）：54 号票起会话是一镜到底的缩放，
 * 条目都在 .zh-content 里，它带着 transform（整体 scale），自成一个层叠上下文，里面的菜单 z-index 再大也盖不过外面的
 * 输入栏（.zh-footer 里的输入框也带 transform，排在后面）、标题栏、宽屏的详情栏；列表本身（.zh-viewport）又是滚动容器，
 * 菜单伸出去的部分被裁掉。transform 还会让里面的 position: fixed 跟着缩，所以也不能就地 fixed
 * （AgentSense 的 TaskDialog 同样因为这个放到 body 下）。
 *
 * 做法：经 portal 画到 App 外框里的 .popup-layer（PopupHost 给出；没有时画到 body 下），菜单 position: fixed，
 * 位置按锚点在屏幕上的矩形算（state/popup.ts 的 popupPlacement：默认在下方，放不下翻到上方，不出屏幕），
 * 画出来之前先量好再放（useLayoutEffect），不闪。窗口大小变了跟着重新放。
 *
 * 什么时候关（照原来语音气泡菜单的规矩，再补上 portal 之后跟不上锚点的几种）：
 * - 点菜单外面（按下就关；双指捏合、标题栏的 ▤ / 💬 也先有一次按下）；
 * - 任何地方滚动（菜单不再跟着列表走，滚了就关）、滚轮（Ctrl/⌘ + 滚轮、触控板捏合是缩放）；
 * - 鸿蒙 App 的返回键（62 号票的返回栈：开着就挂一层 overlay）。
 * 缩小着（不是对话层）的时候条目不接手势（zoom.css 的 .zi-l0 pointer-events: none），菜单本来就开不出来，这里不另外管。
 *
 * portal 里的事件仍沿 React 树往外冒（会冒到会话的条目上：比如用户气泡点整条是看详情），所以菜单里的按下、点击到菜单为止。
 * 以后在会话里加弹出菜单都用它，别在条目里就地画 position: absolute 的菜单。
 */
import { createContext, type ReactNode, type RefObject, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackLayer } from "../app/page-back.ts";
import { type PopupAlign, type PopupPlacement, popupPlacement } from "../state/index.ts";

/** 弹出菜单画在哪：App 外框里最上面的那一层（.popup-layer） */
export const PopupHost = createContext<HTMLElement | null>(null);

export function PopupMenu({
  anchor,
  align,
  className,
  onClose,
  children,
}: {
  /** 贴着哪个元素弹（按住的那个） */
  anchor: RefObject<HTMLElement | null>;
  /** 和它哪一边对齐 */
  align: PopupAlign;
  /** 菜单自己的样子（比如 voice-menu） */
  className: string;
  onClose(): void;
  children: ReactNode;
}) {
  const host = useContext(PopupHost);
  const menuRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<PopupPlacement | undefined>(undefined);
  // 关掉用最新的回调（外面每次渲染都可能换）
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useBackLayer("overlay", true, onClose);

  // 量锚点和菜单，放到屏幕上：第一次在画出来之前（还没放好时菜单先藏着、按自然宽度排）；窗口大小变了再放一次
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current;
      const m = menuRef.current;
      if (!a || !m) return;
      const bounds = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      setPlaced(popupPlacement(a.getBoundingClientRect(), { width: m.offsetWidth, height: m.offsetHeight }, bounds, align));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, align]);

  useEffect(() => {
    const dismiss = () => close.current();
    // 按在菜单外面才关（菜单里的按下到菜单为止，见下面；这里再查一次，不靠事件冒泡的先后）
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) dismiss();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", dismiss, { capture: true, passive: true });
    window.addEventListener("wheel", dismiss, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", dismiss, { capture: true });
      window.removeEventListener("wheel", dismiss, { capture: true });
    };
  }, []);

  const style = placed ? { left: placed.left, top: placed.top } : { left: 0, top: 0, visibility: "hidden" as const };
  return createPortal(
    <div
      ref={menuRef}
      className={`popup ${className}`}
      role="menu"
      data-side={placed?.side}
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    host ?? document.body,
  );
}
