// 长按 / 右键（90 号票从语音气泡里抽出来共用：语音气泡的菜单、看板卡片的任务操作菜单、待办行的菜单）。
// - 按下（主键）开始计时，按住 LONG_PRESS_MS 算长按，叫 onLongPress；手指挪开超过 MOVE_TOLERANCE_PX 就不算（在滚动）；
// - 没到时间就松开算点（onTap，给了才叫：语音气泡点一下是播放；按钮自己的 onClick 照常）；
// - 桌面上右键：弹出菜单（手机上长按之后也会来一次 contextmenu，这一按已经弹过就不再叫）；
// - 长按之后松开时浏览器还会补一次 click：吞掉它（看板卡长按出菜单，不该顺手把任务打开）。
// 被按住的元素要挂 user-select: none、-webkit-touch-callout: none，长按时手机不选字、不弹系统菜单（样式里各自给）。
import { type MouseEvent, type PointerEvent, useEffect, useRef } from "react";

/** 按住多久算长按（毫秒） */
export const LONG_PRESS_MS = 500;
/** 按住时手指挪开多远就不算长按也不算点 */
export const MOVE_TOLERANCE_PX = 10;

export interface LongPressHandlers {
  onPointerDown(e: PointerEvent): void;
  onPointerMove(e: PointerEvent): void;
  onPointerUp(): void;
  onPointerCancel(): void;
  onContextMenu(e: MouseEvent): void;
  onClickCapture(e: MouseEvent): void;
}

/** 挂到被按住的元素上（展开 {...handlers}）；disabled 时什么都不做（多选时点卡片只是勾选） */
export function useLongPress(onLongPress: () => void, options: { onTap?: (() => void) | undefined; disabled?: boolean | undefined } = {}): LongPressHandlers {
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> | undefined; long: boolean } | null>(null);
  // 这一按已经长按过（松开后补来的 click、contextmenu 认它）
  const fired = useRef(false);
  // 回调用最新的（外面每次渲染都可能换）
  const latest = useRef({ onLongPress, ...options });
  useEffect(() => {
    latest.current = { onLongPress, ...options };
  });
  const clear = () => {
    if (press.current?.timer !== undefined) clearTimeout(press.current.timer);
  };
  return {
    onPointerDown(e) {
      fired.current = false;
      if (latest.current.disabled || e.button !== 0) return;
      clear();
      const timer = setTimeout(() => {
        if (!press.current) return;
        press.current.long = true;
        fired.current = true;
        latest.current.onLongPress();
      }, LONG_PRESS_MS);
      press.current = { x: e.clientX, y: e.clientY, timer, long: false };
    },
    onPointerMove(e) {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE_PX) {
        clear();
        press.current = null;
      }
    },
    onPointerUp() {
      const p = press.current;
      press.current = null;
      if (!p) return;
      clear();
      if (!p.long) latest.current.onTap?.();
    },
    onPointerCancel() {
      clear();
      press.current = null;
    },
    onContextMenu(e) {
      if (latest.current.disabled) return;
      e.preventDefault();
      if (!fired.current) latest.current.onLongPress();
    },
    onClickCapture(e) {
      // 弹出来的菜单经 portal 画在别处，React 里仍算这个元素的子孙：点菜单里的一项不吞（手机上长按之后可能不补 click，记号还留着）
      if (!fired.current || !e.currentTarget.contains(e.target as Node)) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
