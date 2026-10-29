// 聊天区里排队的消息长按拖动改顺序（144 号票）：pointer 事件 → 拖动状态的纯函数。界面（ui/conversation/queue-drag.tsx）只把 DOM 的
// pointer 事件、长按计时、量出来的气泡位置交进来，照状态给每个气泡挪位置；不用拖拽库。
// - 按下：手机上（touch、pen）按住 QUEUE_HOLD_MS 不动才开始拖（照 ui/long-press.ts 的长按），没到时间挪开超过 QUEUE_MOVE_TOLERANCE_PX
//   算在滚动，不拖；电脑上（mouse）按住挪开超过容差就开始拖，按住不动到时间也开始；
// - 拖着：被拖的那条跟着指针上下走；它的中线越过别的气泡的中线就换到那个位置，夹在中间的气泡给它让出位置，落下的地方画一个虚线占位；
// - 松手：位置变了交出新的顺序；没开始拖（只是点了一下）、位置没变什么都不交；指针被系统收走（pointercancel）算没拖；
// - 只剩一条时不能拖（只能叉）。

/** 手机上按住多久开始拖（毫秒，和长按菜单一样，ui/long-press.ts 的 LONG_PRESS_MS） */
export const QUEUE_HOLD_MS = 500;
/** 开始拖之前挪开多远算在滚动（手机）、算开始拖（电脑） */
export const QUEUE_MOVE_TOLERANCE_PX = 10;

/** 按下（开始拖）那一刻量的一条排队的气泡：消息 id、上沿（视口坐标）、高度。按队列的先后 */
export interface QueueRect {
  readonly id: string;
  readonly top: number;
  readonly height: number;
}

/** 指针是哪种：鼠标按住挪就拖，手指、笔要先按住不动 */
export type QueuePointer = "mouse" | "touch";

export type QueueDrag =
  | { readonly phase: "idle" }
  /** 按下了还没开始拖 */
  | { readonly phase: "pressed"; readonly id: string; readonly pointer: QueuePointer; readonly x: number; readonly y: number; readonly at: number }
  /** 拖着：from 是它原来的位置，target 是松手会落到的位置，dy 是指针从按下起上下挪了多少 */
  | { readonly phase: "dragging"; readonly id: string; readonly rects: readonly QueueRect[]; readonly from: number; readonly target: number; readonly startY: number; readonly dy: number };

export const QUEUE_DRAG_IDLE: QueueDrag = { phase: "idle" };

/** 按下一条（ids 是现在队列的先后）：只剩一条时不理 */
export function queueDragDown(ids: readonly string[], id: string, pointer: QueuePointer, x: number, y: number, at: number): QueueDrag {
  if (ids.length < 2 || !ids.includes(id)) return QUEUE_DRAG_IDLE;
  return { phase: "pressed", id, pointer, x, y, at };
}

/** 开始拖：量出各条的位置；量不到被按的那条（刚好交出去了）就不拖 */
function startDragging(state: Extract<QueueDrag, { phase: "pressed" }>, y: number, rects: readonly QueueRect[]): QueueDrag {
  const from = rects.findIndex((r) => r.id === state.id);
  if (from < 0 || rects.length < 2) return QUEUE_DRAG_IDLE;
  return withTarget({ phase: "dragging", id: state.id, rects, from, target: from, startY: state.y, dy: y - state.y });
}

/** 按住不动到了时间（界面的计时器）：开始拖 */
export function queueDragHold(state: QueueDrag, at: number, measure: () => readonly QueueRect[]): QueueDrag {
  if (state.phase !== "pressed" || at - state.at < QUEUE_HOLD_MS) return state;
  return startDragging(state, state.y, measure());
}

/** 指针挪动：按着没开始拖的，手指挪开了算在滚动（不拖），鼠标挪开了开始拖；拖着的跟着走、换落点 */
export function queueDragMove(state: QueueDrag, x: number, y: number, measure: () => readonly QueueRect[]): QueueDrag {
  if (state.phase === "pressed") {
    if (Math.hypot(x - state.x, y - state.y) <= QUEUE_MOVE_TOLERANCE_PX) return state;
    return state.pointer === "mouse" ? startDragging(state, y, measure()) : QUEUE_DRAG_IDLE;
  }
  if (state.phase !== "dragging") return state;
  return withTarget({ ...state, dy: y - state.startY });
}

/** 松手：位置变了交出新的顺序（order），回到不拖 */
export function queueDragUp(state: QueueDrag): { state: QueueDrag; order: string[] | undefined } {
  if (state.phase !== "dragging" || state.target === state.from) return { state: QUEUE_DRAG_IDLE, order: undefined };
  const ids = state.rects.map((r) => r.id);
  const [moved] = ids.splice(state.from, 1);
  ids.splice(state.target, 0, moved!);
  return { state: QUEUE_DRAG_IDLE, order: ids };
}

/** 落点：被拖那条的中线越过了几条别的气泡的中线 */
function withTarget(state: Extract<QueueDrag, { phase: "dragging" }>): QueueDrag {
  const dragged = state.rects[state.from]!;
  const center = dragged.top + dragged.height / 2 + state.dy;
  const target = state.rects.filter((r, i) => i !== state.from && r.top + r.height / 2 < center).length;
  return target === state.target ? state : { ...state, target };
}

/** 相邻两条气泡之间的空隙（量的；只有一条时是 0） */
function gapOf(rects: readonly QueueRect[], at: number): number {
  const next = rects[at + 1] ?? rects[at];
  const prev = rects[at + 1] ? rects[at] : rects[at - 1];
  if (!next || !prev || next === prev) return 0;
  return Math.max(0, next.top - prev.top - prev.height);
}

/** 拖着时这条气泡要挪多少（px，往下为正）：被拖的跟着指针，夹在原位置和落点之间的给它让位置；不拖时都是 0 */
export function queueDragOffset(state: QueueDrag, id: string): number {
  if (state.phase !== "dragging") return 0;
  if (id === state.id) return state.dy;
  const i = state.rects.findIndex((r) => r.id === id);
  if (i < 0) return 0;
  const room = state.rects[state.from]!.height + gapOf(state.rects, state.from);
  if (state.from < state.target && i > state.from && i <= state.target) return -room;
  if (state.target < state.from && i >= state.target && i < state.from) return room;
  return 0;
}

/**
 * 落点的占位在被拖那条原来位置的哪儿（px，往下为正）：松手后它的上沿在这里——往下拖时和落点那条的下沿对齐，往上拖时和落点那条的上沿对齐。
 * 不拖时是 0
 */
export function queueDragSlot(state: QueueDrag): number {
  if (state.phase !== "dragging") return 0;
  const dragged = state.rects[state.from]!;
  const at = state.rects[state.target]!;
  if (state.target > state.from) return at.top + at.height - dragged.height - dragged.top;
  return at.top - dragged.top;
}
