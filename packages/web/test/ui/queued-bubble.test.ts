// 聊天区里排队的消息（144 号票）：虚线气泡、叉、长按（电脑上按住）拖动改顺序。
// - 拖动（state/queue-drag.ts）：把 pointer 事件按先后交进去（按下、按住到时间、挪动、松手、被系统收走），看什么时候开始拖、谁给谁让位置、
//   落点的占位在哪、松手交出的顺序；
// - 气泡（ui/conversation/ChatItemView.tsx 里排队的那种）：用 React 在 Node 里渲染出来查——虚线气泡的类、"排队中"、右上角的叉、
//   拖动量位置用的标记；只剩一条时不能拖（没有可拖的类）。
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  type ChatItem,
  chatItems,
  QUEUE_DRAG_IDLE,
  QUEUE_HOLD_MS,
  QUEUE_MOVE_TOLERANCE_PX,
  type QueueDrag,
  queueDragDown,
  queueDragHold,
  queueDragMove,
  queueDragOffset,
  queueDragSlot,
  queueDragUp,
  type QueueRect,
  replay,
} from "../../src/state/index.ts";
import { ChatItemView } from "../../src/ui/conversation/ChatItemView.tsx";
import { QueueDragProvider } from "../../src/ui/conversation/queue-drag.tsx";

const IDS = ["a", "b", "c"];
/** 三条排队的气泡：各高 40，间隔 8 */
const RECTS: QueueRect[] = [
  { id: "a", top: 100, height: 40 },
  { id: "b", top: 148, height: 40 },
  { id: "c", top: 196, height: 40 },
];
const measure = () => RECTS;

/** 一串 pointer 事件按先后交进去（挪动、松手的坐标都是视口坐标） */
type Step = { down: { id: string; pointer: "mouse" | "touch"; y: number; at?: number } } | { hold: number } | { move: { x?: number; y: number } } | "up" | "cancel";
function run(steps: Step[]): { state: QueueDrag; order: string[] | undefined } {
  let state: QueueDrag = QUEUE_DRAG_IDLE;
  let order: string[] | undefined;
  for (const step of steps) {
    if (step === "up") ({ state, order } = queueDragUp(state));
    else if (step === "cancel") state = QUEUE_DRAG_IDLE;
    else if ("down" in step) state = queueDragDown(IDS, step.down.id, step.down.pointer, 50, step.down.y, step.down.at ?? 0);
    else if ("hold" in step) state = queueDragHold(state, step.hold, measure);
    else state = queueDragMove(state, step.move.x ?? 50, step.move.y, measure);
  }
  return { state, order };
}

describe("拖动改顺序（pointer 事件 → 拖动状态）", () => {
  test("电脑上按住挪开超过容差就开始拖；拖过下一条的中线就换到它后面，被越过的那条往上让出位置；松手交出新的顺序", () => {
    const pressed = run([{ down: { id: "a", pointer: "mouse", y: 120 } }, { move: { y: 120 + QUEUE_MOVE_TOLERANCE_PX - 2 } }]);
    expect(pressed.state.phase).toBe("pressed");
    const dragging = run([{ down: { id: "a", pointer: "mouse", y: 120 } }, { move: { y: 175 } }]);
    expect(dragging.state).toMatchObject({ phase: "dragging", id: "a", from: 0, target: 1, dy: 55 });
    // 被拖的跟着指针；b 往上让出 a 的高度加间隔；c 不动
    expect(["a", "b", "c"].map((id) => queueDragOffset(dragging.state, id))).toEqual([55, -48, 0]);
    // 占位：往下拖时和落点那条的下沿对齐（b 的下沿 188 - a 高 40 - a 原来的上沿 100）
    expect(queueDragSlot(dragging.state)).toBe(48);
    expect(run([{ down: { id: "a", pointer: "mouse", y: 120 } }, { move: { y: 175 } }, "up"]).order).toEqual(["b", "a", "c"]);
  });

  test("往上拖到最前：前面两条都往下让；松手落到第一位", () => {
    const up = run([{ down: { id: "c", pointer: "mouse", y: 216 } }, { move: { y: 100 } }]);
    expect(up.state).toMatchObject({ phase: "dragging", from: 2, target: 0 });
    expect(["a", "b", "c"].map((id) => queueDragOffset(up.state, id))).toEqual([48, 48, -116]);
    expect(queueDragSlot(up.state)).toBe(-96);
    expect(run([{ down: { id: "c", pointer: "mouse", y: 216 } }, { move: { y: 100 } }, "up"]).order).toEqual(["c", "a", "b"]);
  });

  test("手机上要按住不动到时间才开始拖；没到时间挪开了算在滚动，不拖；到了时间再挪就跟着走", () => {
    expect(run([{ down: { id: "b", pointer: "touch", y: 168 } }, { move: { y: 200 } }]).state).toBe(QUEUE_DRAG_IDLE);
    expect(run([{ down: { id: "b", pointer: "touch", y: 168 } }, { hold: QUEUE_HOLD_MS - 1 }]).state.phase).toBe("pressed");
    const held = run([{ down: { id: "b", pointer: "touch", y: 168 } }, { hold: QUEUE_HOLD_MS }]);
    expect(held.state).toMatchObject({ phase: "dragging", id: "b", from: 1, target: 1, dy: 0 });
    expect(run([{ down: { id: "b", pointer: "touch", y: 168 } }, { hold: QUEUE_HOLD_MS }, { move: { y: 230 } }, "up"]).order).toEqual(["a", "c", "b"]);
  });

  test("拖了又放回原位、只是点了一下、被系统收走（pointercancel）：什么都不交", () => {
    expect(run([{ down: { id: "a", pointer: "mouse", y: 120 } }, { move: { y: 175 } }, { move: { y: 122 } }, "up"]).order).toBeUndefined();
    expect(run([{ down: { id: "a", pointer: "mouse", y: 120 } }, "up"]).order).toBeUndefined();
    expect(run([{ down: { id: "a", pointer: "mouse", y: 120 } }, { move: { y: 175 } }, "cancel", "up"]).order).toBeUndefined();
  });

  test("只剩一条时不能拖（只能叉）；按的那条刚好交出去了（量不到）也不拖", () => {
    expect(queueDragDown(["a"], "a", "mouse", 0, 0, 0)).toBe(QUEUE_DRAG_IDLE);
    const gone = queueDragMove(queueDragDown(IDS, "a", "mouse", 0, 120, 0), 0, 175, () => RECTS.slice(1));
    expect(gone).toBe(QUEUE_DRAG_IDLE);
  });
});

/** 秘书正在回复时排着的几条：聊天区里排队的条目 */
function queuedItems(texts: string[]): ChatItem[] {
  const queue = texts.map((text, i) => ({ message: { id: `m-${i}`, conversation: "secretary" as const, speaker: "user" as const, time: "2026-10-18T10:00:00+08:00", parts: [{ type: "text" as const, text }] }, idempotencyKey: `k-${i}` }));
  const state = replay([
    { channel: "secretary", seq: 1, type: "turn_start", payload: { inputMessageId: "m-x" } },
    { channel: "secretary", seq: 2, type: "message_queue", payload: { change: "queued", messageIds: [], queue } },
  ]);
  return chatItems(state, "secretary").filter((it) => it.kind === "user");
}

const render = (items: ChatItem[], item: ChatItem) =>
  renderToStaticMarkup(
    createElement(
      QueueDragProvider,
      { ids: items.map((it) => (it.kind === "user" ? it.message.id : "")), root: createRef<HTMLElement>(), onRemove: () => {}, onReorder: () => {} },
      createElement(ChatItemView, { item, actions: {} }),
    ),
  );

describe("排队的气泡", () => {
  test("用户气泡的样子加虚线：标排队中，右上角一个叉，带拖动量位置用的标记，能拖", () => {
    const items = queuedItems(["先查天气", "再订餐厅"]);
    const html = render(items, items[0]!);
    expect(html).toContain('class="msg user msg-queued queued-movable"');
    expect(html).toContain('data-queued-id="m-0"');
    expect(html).toContain('<div class="bubble">先查天气</div>');
    expect(html).toContain(">排队中</span>");
    expect(html).toContain('<button type="button" class="queued-x" aria-label="不发这条了（从排队里拿掉）"');
  });

  test("只剩一条：只能叉，不能拖（没有可拖的类）", () => {
    const items = queuedItems(["先查天气"]);
    const html = render(items, items[0]!);
    expect(html).toContain('class="msg user msg-queued"');
    expect(html).toContain('class="queued-x"');
  });
});
