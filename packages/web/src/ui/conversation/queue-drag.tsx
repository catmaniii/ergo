// 聊天区里排队的消息（144 号票）：叉掉一条、长按（电脑上按住）拖动改顺序。会话组件挂一个 QueueDragProvider（这个会话现在排着的消息 id、
// 叉掉和交出新顺序的函数、量气泡位置用的根元素），排队的气泡（ChatItemView）从 useQueuedBubble 取 pointer 事件、要挪多少、落点占位。
// 拖动的规则是 state/queue-drag.ts 的纯函数，这里只把 DOM 事件、长按计时、量出来的位置交进去。不用拖拽库。
// - 指针挪动、松手听在 window 上（拖出气泡也跟着走）；拖着的时候手机上不让页面跟着滚（不被动的 touchmove 里 preventDefault）；
// - 拖完松手浏览器补来的那次 click 吞掉（用户气泡点整条是打开详情）。
import { createContext, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode, type RefObject, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  QUEUE_DRAG_IDLE,
  QUEUE_HOLD_MS,
  type QueueDrag,
  queueDragDown,
  queueDragHold,
  queueDragMove,
  queueDragOffset,
  queueDragSlot,
  queueDragUp,
  type QueueRect,
} from "../../state/index.ts";

interface QueueDragApi {
  readonly state: QueueDrag;
  readonly count: number;
  down(id: string, e: PointerEvent): void;
  remove(id: string): void;
  /** 刚拖完（松手后补来的 click 要吞掉） */
  justDragged(): boolean;
}

const QueueDragContext = createContext<QueueDragApi | undefined>(undefined);

/** 一条排队的气泡在 DOM 上的标记（量位置时按它找） */
export const QUEUED_ID_ATTR = "data-queued-id";

export function QueueDragProvider({
  ids,
  root,
  onRemove,
  onReorder,
  children,
}: {
  /** 这个会话现在排着的消息 id，先交的在前 */
  ids: readonly string[];
  /** 量气泡位置时在它里面找 */
  root: RefObject<HTMLElement | null>;
  onRemove(id: string): void;
  onReorder(ids: string[]): void;
  children?: ReactNode;
}) {
  const [state, setState] = useState<QueueDrag>(QUEUE_DRAG_IDLE);
  const stateRef = useRef(state);
  const idsRef = useRef(ids);
  const reorderRef = useRef(onReorder);
  const dragged = useRef(0);
  useEffect(() => {
    idsRef.current = ids;
    reorderRef.current = onReorder;
  });
  const set = useCallback((next: QueueDrag) => {
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
  }, []);

  /** 量各条排队的气泡（按队列的先后） */
  const measure = useCallback((): QueueRect[] => {
    const el = root.current;
    if (!el) return [];
    const byId = new Map<string, QueueRect>();
    for (const node of el.querySelectorAll<HTMLElement>(`[${QUEUED_ID_ATTR}]`)) {
      const id = node.getAttribute(QUEUED_ID_ATTR)!;
      const r = node.getBoundingClientRect();
      byId.set(id, { id, top: r.top, height: r.height });
    }
    return idsRef.current.flatMap((id) => byId.get(id) ?? []);
  }, [root]);

  // 按着、拖着的时候：听 window 上的挪动、松手；手机上按住到时间开始拖；拖着时不让页面滚
  const phase = state.phase;
  useEffect(() => {
    if (phase === "idle") return;
    const move = (e: globalThis.PointerEvent) => set(queueDragMove(stateRef.current, e.clientX, e.clientY, measure));
    const up = () => {
      const { state: next, order } = queueDragUp(stateRef.current);
      if (stateRef.current.phase === "dragging") dragged.current = Date.now();
      set(next);
      if (order) reorderRef.current(order);
    };
    const cancel = () => set(QUEUE_DRAG_IDLE);
    const noScroll = (e: TouchEvent) => {
      if (stateRef.current.phase === "dragging") e.preventDefault();
    };
    const hold = phase === "pressed" ? setTimeout(() => set(queueDragHold(stateRef.current, Date.now(), measure)), QUEUE_HOLD_MS) : undefined;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("touchmove", noScroll, { passive: false });
    return () => {
      if (hold !== undefined) clearTimeout(hold);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("touchmove", noScroll);
    };
  }, [phase, measure, set]);

  const api = useMemo<QueueDragApi>(
    () => ({
      state,
      count: ids.length,
      down(id, e) {
        // 主键；点在叉、链接、播放器上的不算
        if (e.button !== 0 || (e.target as HTMLElement).closest("button, a, audio, video")) return;
        set(queueDragDown(idsRef.current, id, e.pointerType === "mouse" ? "mouse" : "touch", e.clientX, e.clientY, Date.now()));
      },
      remove: onRemove,
      justDragged: () => Date.now() - dragged.current < 400,
    }),
    [state, ids.length, onRemove, set],
  );
  return <QueueDragContext.Provider value={api}>{children}</QueueDragContext.Provider>;
}

/** 一条排队的气泡要挂的：标记、pointer 事件、挪多少、是不是被拖着、叉；会话没挂 QueueDragProvider 时是 undefined */
export function useQueuedBubble(id: string):
  | {
      attrs: Record<string, string>;
      style: CSSProperties;
      dragging: boolean;
      /** 只剩一条：不能拖，只能叉 */
      single: boolean;
      onPointerDown(e: PointerEvent): void;
      onContextMenu(e: MouseEvent): void;
      onClickCapture(e: MouseEvent): void;
      remove(): void;
    }
  | undefined {
  const api = useContext(QueueDragContext);
  if (!api) return undefined;
  const { state } = api;
  const dragging = state.phase === "dragging" && state.id === id;
  const offset = queueDragOffset(state, id);
  const style: CSSProperties & Record<string, string> = {
    ...(offset !== 0 ? { transform: `translateY(${offset}px)` } : {}),
    // 落点的占位画在被拖那条自己身上（跟着它挪），所以减掉它挪了的
    ...(dragging ? { "--queued-slot": `${queueDragSlot(state) - offset}px` } : {}),
  };
  return {
    attrs: { [QUEUED_ID_ATTR]: id },
    style,
    dragging,
    single: api.count < 2,
    onPointerDown: (e) => api.down(id, e),
    // 手机上长按不弹系统菜单
    onContextMenu: (e) => e.preventDefault(),
    onClickCapture: (e) => {
      if (!api.justDragged()) return;
      e.preventDefault();
      e.stopPropagation();
    },
    remove: () => api.remove(id),
  };
}
