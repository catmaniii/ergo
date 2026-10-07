// 前端状态层：流式增量（临时事件，不占序号）和连接状态。
// 主线流程用主切面录下的真实事件流回放（recorded.test.ts）；这里补录不出来的边角：漏掉中间增量、迟到的增量。
import { describe, expect, test } from "vitest";
import { conversationView, replay, resumeCursors } from "../../src/state/index.ts";
import { card, frame, textMessage } from "./events.ts";

const delta = (seq: number, messageId: string, ...deltas: Array<[part: number, type: "text" | "reasoning", offset: number, text: string]>) =>
  frame("secretary", seq, "stream", { messageId, deltas: deltas.map(([part, type, offset, text]) => ({ part, type, offset, text })) });

describe("流式增量", () => {
  test("增量拼成一条正在生成的回复，排在权威消息之后；不推进序号", () => {
    const state = replay([
      frame("secretary", 1, "message", { message: textMessage("m1", "user", "在吗") }),
      delta(1, "m2", [0, "reasoning", 0, "想"], [0, "reasoning", 1, "一想"]),
      delta(1, "m2", [0, "reasoning", 3, "。"], [1, "text", 0, "在"]),
      delta(1, "m2", [1, "text", 1, "的"]),
    ]);
    expect(resumeCursors(state)).toEqual({ secretary: 1 });
    const items = conversationView(state, "secretary");
    expect(items.map((it) => it.kind)).toEqual(["message", "streaming"]);
    expect(items[1]).toMatchObject({
      kind: "streaming",
      broken: false,
      message: { id: "m2", speaker: "agent", parts: [{ type: "reasoning", text: "想一想。" }, { type: "text", text: "在的" }] },
    });
  });

  test("定稿消息（同一个 id）到了，正在生成的那条被它替换", () => {
    const state = replay([
      frame("secretary", 1, "message", { message: textMessage("m1", "user", "在吗") }),
      delta(1, "m2", [0, "text", 0, "在"]),
      frame("secretary", 2, "message", { message: textMessage("m2", "agent", "在的") }),
    ]);
    expect(conversationView(state, "secretary").map((it) => [it.kind, it.message.id])).toEqual([
      ["message", "m1"],
      ["message", "m2"],
    ]);
  });

  test("迟到的增量（序号比已收到的落盘事件旧）直接丢掉", () => {
    const state = replay([
      frame("secretary", 1, "message", { message: textMessage("m1", "user", "在吗") }),
      frame("secretary", 2, "message", { message: textMessage("m2", "agent", "在的") }),
      delta(1, "m2", [0, "text", 1, "的"]),
    ]);
    expect(conversationView(state, "secretary").map((it) => it.kind)).toEqual(["message", "message"]);
  });

  test("漏掉了中间的增量（断线重连、回复说到一半才打开页面）：不拼残缺的文字，只标出正在回复", () => {
    const joinedLate = replay([frame("secretary", 1, "message", { message: textMessage("m1", "user", "在吗") }), delta(1, "m2", [0, "text", 5, "后半句"])]);
    expect(conversationView(joinedLate, "secretary")[1]).toMatchObject({ kind: "streaming", broken: true, message: { parts: [] } });

    const gap = replay([
      frame("secretary", 1, "message", { message: textMessage("m1", "user", "在吗") }),
      delta(1, "m2", [0, "text", 0, "前半句"]),
      delta(1, "m2", [0, "text", 9, "又一句"]),
    ]);
    expect(conversationView(gap, "secretary")[1]).toMatchObject({ kind: "streaming", broken: true, message: { parts: [{ type: "text", text: "前半句" }] } });
  });

  test("回合结束（比如出错、没有定稿消息）时，正在生成的那条也收起", () => {
    const state = replay([
      frame("secretary", 1, "message", { message: textMessage("m1", "user", "在吗") }),
      delta(1, "m2", [0, "text", 0, "在"]),
      frame("secretary", 2, "turn_end", { inputMessageId: "m1", outcome: "aborted" }),
    ]);
    expect(conversationView(state, "secretary").map((it) => it.kind)).toEqual(["message"]);
  });

  test("正在生成的回复排在乐观显示的尾巴前面", () => {
    const state = replay([
      frame("secretary", 1, "message", { message: textMessage("m1", "user", "第一句"), idempotencyKey: "k1" }),
      delta(1, "m2", [0, "text", 0, "回第一句"]),
      { kind: "send_message", conversation: "secretary", idempotencyKey: "k2", parts: [{ type: "text", text: "第二句" }], time: "2026-10-07T09:02:00+08:00" },
    ]);
    expect(conversationView(state, "secretary").map((it) => it.kind)).toEqual(["message", "streaming", "pending"]);
  });
});

describe("重新同步", () => {
  test("清掉这个频道的序号、消息和正在生成的回复，还没确认的乐观显示留着；之后从头补发的事件照常归并", () => {
    const before = replay([
      frame("secretary", 1, "message", { message: textMessage("m1", "user", "旧的一句") }),
      frame("secretary", 2, "message", { message: textMessage("m2", "agent", "旧的回复") }),
      delta(2, "m3", [0, "text", 0, "旧的流"]),
      { kind: "send_message", conversation: "secretary", idempotencyKey: "k9", parts: [{ type: "text", text: "还没确认" }], time: "2026-10-07T09:02:00+08:00" },
      frame("cards", 1, "card", { card: card("c1", 1) }),
    ]);
    const after = replay([{ kind: "resync", channel: "secretary" }], before);
    expect(resumeCursors(after)).toEqual({ cards: 1 });
    expect(conversationView(after, "secretary").map((it) => it.kind)).toEqual(["pending"]);
    expect(after.cards).toEqual(before.cards);

    const refilled = replay([frame("secretary", 1, "message", { message: textMessage("n1", "user", "恢复后的第一句") })], after);
    expect(conversationView(refilled, "secretary").map((it) => [it.kind, it.message.id])).toEqual([
      ["message", "n1"],
      ["pending", "pending:k9"],
    ]);
  });

  test("卡片频道重新同步：卡片清空", () => {
    const state = replay([frame("cards", 3, "card", { card: card("c1", 1) }), { kind: "resync", channel: "cards" }]);
    expect(state.cards).toEqual({});
    expect(resumeCursors(state)).toEqual({});
  });
});

describe("连接状态", () => {
  test("一开始是连接中；连接告诉状态层的状态原样记下", () => {
    expect(replay([]).connection).toBe("connecting");
    expect(replay([{ kind: "connection", status: "online" }, { kind: "connection", status: "offline" }]).connection).toBe("offline");
    expect(replay([{ kind: "connection", status: "outdated" }]).connection).toBe("outdated");
  });
});
