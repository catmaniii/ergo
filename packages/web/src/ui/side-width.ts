// 拖分隔条调一条二狗聊天侧栏的宽度（浏览侧边栏、地图页右边的聊天窗，444 从"浏览"页挪过来两边共用）：
// 拖着的时候每一帧算一次（requestAnimationFrame，挪动攒到这一帧再算），松手才记到这台设备上（app/stage-side-width.ts 的那一份）。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { dragChatSideWidth, type StageSideWidthSetting } from "../app/stage-side-width.ts";

export interface DraggedSideWidth {
  /** 现在要摆的宽度（拖着时是拖到的，不然是记住的；还没按内容区夹回） */
  readonly width: number;
  /** from 是现在摆着的宽度（按内容区夹回之后的，拖从它开始）；hostWidth 是内容区多宽 */
  onDrag(dx: number, from: number, hostWidth: number): void;
  onDragEnd(hostWidth: number): void;
}

/** 这台设备记住的宽度，改了跟着变 */
export function useRememberedSideWidth(setting: StageSideWidthSetting): number {
  return useSyncExternalStore(setting.subscribe, setting.width);
}

export function useDraggedSideWidth(setting: StageSideWidthSetting, drag: (width: number, dx: number, hostWidth: number) => number = dragChatSideWidth): DraggedSideWidth {
  const remembered = useRememberedSideWidth(setting);
  /** 拖着的时候的宽度（松手才记到这台设备上） */
  const [dragging, setDragging] = useState<number>();
  /** 这一下拖：拖到的宽度、这一帧还没算进去的挪动、等着的那一帧 */
  const pending = useRef<{ width: number; dx: number; frame: number | undefined } | undefined>(undefined);
  // 拿下时还没到的那一帧不要了
  useEffect(
    () => () => {
      const frame = pending.current?.frame;
      if (frame !== undefined) cancelAnimationFrame(frame);
    },
    [],
  );
  return {
    width: dragging ?? remembered,
    onDrag(dx, from, hostWidth) {
      const d = (pending.current ??= { width: from, dx: 0, frame: undefined });
      d.dx += dx;
      if (d.frame !== undefined) return;
      d.frame = requestAnimationFrame(() => {
        d.frame = undefined;
        d.width = drag(d.width, d.dx, hostWidth);
        d.dx = 0;
        setDragging(d.width);
      });
    },
    onDragEnd(hostWidth) {
      const d = pending.current;
      pending.current = undefined;
      if (!d) return;
      if (d.frame !== undefined) cancelAnimationFrame(d.frame);
      setting.set(drag(d.width, d.dx, hostWidth));
      setDragging(undefined);
    },
  };
}
