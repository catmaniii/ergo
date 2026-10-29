// 停止和排队（144 号票）的前端状态：回放会话频道上的事件（手写的事件序列，照主切面 daemon/test/main/message-queue.test.ts 录到的形状），
// 看界面状态：
// - turn_start 之后在回复（输入框上有"停止"、发送钮写"追加"），这一轮的 turn_end 之后不在；插进来的催促不另算一轮；
// - message_queue 带的整队在聊天区最下面（正在生成的回复下面）显示成排队的用户气泡；乐观显示的那条排进队就换成排队的，条目 id 不变；
// - 叉掉、拖完的顺序先照着显示，守护进程的 message_queue 带着同一个幂等键回来就收掉；请求被拒就收回、提示原因；
// - 交出去：消息先到、队列后到，同一条不显示两遍；交出去的消息带着发送请求的幂等键，条目 id 和排队时一样（原地换成正常气泡）；
// - 说到一半被停下的回复标"已停止"。
import { describe, expect, test } from "vitest";
import {
  chatItems,
  type ConversationId,
  type EventFrame,
  type MessageEnvelope,
  type MessageQueueEventPayload,
  type QueuedMessage,
  queuedMessages,
  reduce,
  replay,
  replyingIn,
  type UiInput,
  type UiState,
} from "../../src/state/index.ts";
import { frame, textMessage } from "./events.ts";

const S: ConversationId = "secretary";

const queued = (id: string, text: string, key: string): QueuedMessage => ({ message: textMessage(id, "user", text), idempotencyKey: key });

function queueFrame(seq: number, change: MessageQueueEventPayload["change"], queue: QueuedMessage[], messageIds: string[], requestKey?: string): EventFrame {
  return frame(S, seq, "message_queue", { change, messageIds, queue, ...(requestKey ? { requestKey } : {}) } satisfies MessageQueueEventPayload);
}

const A = queued("m-a", "先查天气", "k-a");
const B = queued("m-b", "算了不用了", "k-b");
const C = queued("m-c", "再订餐厅", "k-c");

/** 秘书正在回第一句，用户接连发了三句（排进队）：回放到这里 */
const replyingWithQueue: (EventFrame | UiInput)[] = [
  frame(S, 1, "message", { message: textMessage("m-1", "user", "写一篇长文"), idempotencyKey: "k-1" }),
  frame(S, 2, "turn_start", { inputMessageId: "m-1" }),
  frame(S, 2, "stream", { messageId: "m-r1", deltas: [{ part: 0, type: "text", offset: 0, text: "这是一段很长的" }] }),
  queueFrame(3, "queued", [A], ["m-a"], "k-a"),
  queueFrame(4, "queued", [A, B], ["m-b"], "k-b"),
  queueFrame(5, "queued", [A, B, C], ["m-c"], "k-c"),
];

/** 聊天区的条目，写成一行：用户气泡写文字（排队的带"排队中"），回复写文字（正在生成的、已停止的标出来） */
function lines(state: UiState): string[] {
  return chatItems(state, S).flatMap((it) => {
    if (it.kind === "user") return [`${it.queued ? "排队中 " : ""}你：${it.text}`];
    if (it.kind === "reply") return [`二狗：${it.text}${it.streaming ? "（正在回复）" : ""}${it.stopped ? "（已停止）" : ""}`];
    if (it.kind === "record") return [`记录：${it.keyLine}`];
    return [];
  });
}

const idOf = (state: UiState, text: string) => chatItems(state, S).find((it) => it.kind === "user" && it.text === text)!.id;

describe("在回复（输入框上的停止、追加）", () => {
  test("turn_start 之后在回复，这一轮的 turn_end 之后不在；中间插进来的催促（另一对 turn_start、turn_end）不另算一轮", () => {
    let state = replay([frame(S, 1, "message", { message: textMessage("m-1", "user", "在吗") }), frame(S, 2, "turn_start", { inputMessageId: "m-1" })]);
    expect(replyingIn(state, S)).toBe(true);
    state = replay([frame(S, 3, "turn_start", { inputMessageId: "m-nudge" }), frame(S, 4, "turn_end", { inputMessageId: "m-nudge", outcome: "completed" })], state);
    expect(replyingIn(state, S)).toBe(true);
    state = replay([frame(S, 5, "turn_end", { inputMessageId: "m-1", outcome: "aborted" })], state);
    expect(replyingIn(state, S)).toBe(false);
    expect(replyingIn(state, "maintainer:pm-1")).toBe(false);
  });
});

describe("排队的消息", () => {
  test("排在正在生成的回复下面，用户气泡、标排队中；乐观显示的那条排进队就换成排队的，条目 id 不变", () => {
    const sending = reduce(replay(replyingWithQueue.slice(0, 3)), { kind: "send_message", conversation: S, idempotencyKey: "k-a", parts: [{ type: "text", text: "先查天气" }], time: "2026-10-07T09:00:01+08:00" });
    const optimisticId = idOf(sending, "先查天气");
    const state = replay(replyingWithQueue.slice(3), sending);
    expect(lines(state)).toEqual(["你：写一篇长文", "二狗：这是一段很长的（正在回复）", "排队中 你：先查天气", "排队中 你：算了不用了", "排队中 你：再订餐厅"]);
    expect(idOf(state, "先查天气")).toBe(optimisticId);
    expect(queuedMessages(state, S).map((q) => q.message.id)).toEqual(["m-a", "m-b", "m-c"]);
  });

  test("叉掉、拖完的顺序先照着显示；守护进程的队列带着同一个幂等键回来就收掉自己那一步", () => {
    let state = replay(replyingWithQueue);
    state = reduce(state, { kind: "queue_edit", conversation: S, edit: { key: "k-rm", kind: "remove", messageId: "m-b" } });
    state = reduce(state, { kind: "queue_edit", conversation: S, edit: { key: "k-order", kind: "reorder", messageIds: ["m-c", "m-a"] } });
    expect(queuedMessages(state, S).map((q) => q.message.id)).toEqual(["m-c", "m-a"]);
    // 叉掉的那一步回来了；改顺序那一步还在路上：照旧照着它显示
    state = replay([queueFrame(6, "removed", [A, C], ["m-b"], "k-rm")], state);
    expect(queuedMessages(state, S).map((q) => q.message.id)).toEqual(["m-c", "m-a"]);
    state = replay([queueFrame(7, "reordered", [C, A], ["m-c", "m-a"], "k-order")], state);
    expect(state.conversations[S]!.queueEdits).toEqual([]);
    expect(lines(state).slice(2)).toEqual(["排队中 你：再订餐厅", "排队中 你：先查天气"]);
  });

  test("叉掉被拒（比如刚好交出去了）：收回先显示的那一步，提示原因", () => {
    let state = reduce(replay(replyingWithQueue), { kind: "queue_edit", conversation: S, edit: { key: "k-rm", kind: "remove", messageId: "m-a" } });
    expect(queuedMessages(state, S)).toHaveLength(2);
    state = reduce(state, { kind: "request_failed", idempotencyKey: "k-rm", error: "守护进程内部出错" });
    expect(queuedMessages(state, S)).toHaveLength(3);
    expect(state.failures).toEqual([{ idempotencyKey: "k-rm", error: "守护进程内部出错" }]);
  });

  test("交出去：消息先到、队列后到，同一条不显示两遍；交出去的消息带着发送请求的幂等键，条目 id 和排队时一样（原地换成正常气泡）", () => {
    const before = replay([...replyingWithQueue, queueFrame(6, "removed", [A, C], ["m-b"], "k-rm")]);
    const queuedIds = [idOf(before, "先查天气"), idOf(before, "再订餐厅")];
    const reply: MessageEnvelope = { ...textMessage("m-r1", "agent", "这是一段很长的回复"), id: "m-r1" };
    let state = replay(
      [
        frame(S, 7, "message", { message: reply }),
        frame(S, 8, "turn_end", { inputMessageId: "m-1", outcome: "completed" }),
        frame(S, 9, "message", { message: A.message, idempotencyKey: "k-a", queueDelivery: "qd-1" }),
        frame(S, 10, "message", { message: C.message, idempotencyKey: "k-c", queueDelivery: "qd-1" }),
      ],
      before,
    );
    // 队列那条还没到：已经成了消息的不再算排队的
    expect(lines(state)).toEqual(["你：写一篇长文", "二狗：这是一段很长的回复", "你：先查天气", "你：再订餐厅"]);
    expect(replyingIn(state, S)).toBe(false);
    state = replay([queueFrame(11, "delivered", [], ["m-a", "m-c"]), frame(S, 12, "turn_start", { inputMessageId: "m-a", moreInputMessageIds: ["m-c"] })], state);
    expect(lines(state)).toEqual(["你：写一篇长文", "二狗：这是一段很长的回复", "你：先查天气", "你：再订餐厅"]);
    expect([idOf(state, "先查天气"), idOf(state, "再订餐厅")]).toEqual(queuedIds);
    expect(replyingIn(state, S)).toBe(true);
  });

  test("停止：说到一半的回复留着、标已停止，时间线上一条\"你停止了这一轮\"，不再在回复", () => {
    const stopped: MessageEnvelope = { ...textMessage("m-r1", "agent", "这是一段很长的"), stopped: true };
    const state = replay([
      ...replyingWithQueue.slice(0, 3),
      frame(S, 3, "message", { message: stopped }),
      frame(S, 4, "timeline_record", { record: { id: "r-1", kind: "stopped", summary: "你停止了这一轮", time: "2026-10-07T09:00:05+08:00" } }),
      frame(S, 5, "turn_end", { inputMessageId: "m-1", outcome: "aborted" }),
    ]);
    expect(lines(state)).toEqual(["你：写一篇长文", "二狗：这是一段很长的（已停止）", "记录：停止：你停止了这一轮"]);
    expect(replyingIn(state, S)).toBe(false);
  });
});
