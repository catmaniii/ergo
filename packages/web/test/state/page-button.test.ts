// 悬浮按钮背后就是秘书本人（149 号票）在状态层这一侧（state/page-button.ts）：回放秘书会话频道上的事件（手写的事件序列，照主切面
// daemon/test/main/page-button.test.ts 录到的形状），看悬浮按钮上发的那句（发消息的幂等键）走到哪了：
// - 发出去还没回、排在队里（秘书正忙）、交给秘书在办、这一轮结束了（回话是这一轮里秘书最后说的那句；一起交出的一批里有它也算）；
// - 这一轮出错、停下、没说话；请求被拒；
// - 这个浏览器的网页候选卡（别的浏览器的不算），按建出来的先后。
import { describe, expect, test } from "vitest";
import { type BrowsePickCardPayload, browsePicksOf, buttonTurnOf, type ConversationId, type EventFrame, type QueuedMessage, replay, type UiInput } from "../../src/state/index.ts";
import { card, frame, textMessage } from "./events.ts";

const S: ConversationId = "secretary";
const userSays = (seq: number, id: string, text: string, key: string) => frame(S, seq, "message", { message: textMessage(id, "user", text), idempotencyKey: key });
const agentSays = (seq: number, id: string, text: string) => frame(S, seq, "message", { message: textMessage(id, "agent", text) });
const queued = (id: string, text: string, key: string): QueuedMessage => ({ message: textMessage(id, "user", text), idempotencyKey: key });
/** 一张网页候选卡（哪个浏览器、什么时候建的） */
const pick = (id: string, browser: string, createdAt: string) =>
  frame("cards", 0, "card", { card: card(id, 1, { type: "browse_pick", createdAt, payload: { browser, files: [], page: { title: "", url: "" } } as unknown as BrowsePickCardPayload }) });

describe("悬浮按钮上发的那句走到哪了", () => {
  test("发出去还没回是在发；交给秘书在办；这一轮结束了回话是这一轮里秘书最后说的那句", () => {
    const sent: UiInput = { kind: "send_message", conversation: S, idempotencyKey: "k-b", parts: [{ type: "text", text: "名字写成张三" }], time: "2026-10-18T10:00:00+08:00" };
    let state = replay([sent]);
    expect(buttonTurnOf(state, "k-b")).toEqual({ phase: "sending" });
    state = replay([sent, userSays(1, "m-b", "名字写成张三", "k-b")]);
    expect(buttonTurnOf(state, "k-b")).toEqual({ phase: "thinking" });
    const events: (EventFrame | UiInput)[] = [
      sent,
      userSays(1, "m-b", "名字写成张三", "k-b"),
      frame(S, 2, "turn_start", { inputMessageId: "m-b" }),
      agentSays(3, "m-r1", "我先看看这个框"),
      agentSays(4, "m-r2", "填好了"),
      frame(S, 5, "turn_end", { inputMessageId: "m-b", outcome: "completed" }),
      // 下一轮的回话不算
      userSays(6, "m-c", "谢谢", "k-c"),
      frame(S, 7, "turn_start", { inputMessageId: "m-c" }),
      agentSays(8, "m-r3", "不客气"),
    ];
    expect(buttonTurnOf(replay(events.slice(0, 4)), "k-b")).toEqual({ phase: "thinking" });
    expect(buttonTurnOf(replay(events), "k-b")).toEqual({ phase: "replied", text: "填好了" });
  });

  test("秘书正忙：排在队里；交出去时和别的排着的一起成一轮，回话照样认得", () => {
    const events: (EventFrame | UiInput)[] = [
      userSays(1, "m-1", "读一下这页", "k-1"),
      frame(S, 2, "turn_start", { inputMessageId: "m-1" }),
      frame(S, 3, "message_queue", { change: "queued", messageIds: ["m-a"], queue: [queued("m-a", "先查天气", "k-a")] }),
      frame(S, 4, "message_queue", { change: "queued", messageIds: ["m-b"], queue: [queued("m-a", "先查天气", "k-a"), queued("m-b", "名字写成张三", "k-b")] }),
    ];
    expect(buttonTurnOf(replay(events), "k-b")).toEqual({ phase: "queued" });
    const delivered = [
      ...events,
      agentSays(5, "m-r1", "读完了"),
      frame(S, 6, "turn_end", { inputMessageId: "m-1", outcome: "completed" }),
      userSays(7, "m-a", "先查天气", "k-a"),
      userSays(8, "m-b", "名字写成张三", "k-b"),
      frame(S, 9, "message_queue", { change: "delivered", messageIds: ["m-a", "m-b"], queue: [] }),
      frame(S, 10, "turn_start", { inputMessageId: "m-a", moreInputMessageIds: ["m-b"] }),
    ];
    expect(buttonTurnOf(replay(delivered), "k-b")).toEqual({ phase: "thinking" });
    const done = [...delivered, agentSays(11, "m-r2", "天气晴，名字填好了"), frame(S, 12, "turn_end", { inputMessageId: "m-a", moreInputMessageIds: ["m-b"], outcome: "completed" })];
    expect(buttonTurnOf(replay(done), "k-b")).toEqual({ phase: "replied", text: "天气晴，名字填好了" });
  });

  test("这一轮出错、停下、没说话；请求被拒", () => {
    const turn = (outcome: string, error?: string) =>
      replay([userSays(1, "m-b", "名字写成张三", "k-b"), frame(S, 2, "turn_start", { inputMessageId: "m-b" }), frame(S, 3, "turn_end", { inputMessageId: "m-b", outcome, ...(error ? { error } : {}) })]);
    expect(buttonTurnOf(turn("error", "模型没回"), "k-b")).toEqual({ phase: "failed", reason: "二狗这一轮出错了：模型没回" });
    expect(buttonTurnOf(turn("aborted"), "k-b")).toEqual({ phase: "failed", reason: "这一轮停下了" });
    expect(buttonTurnOf(turn("completed"), "k-b")).toEqual({ phase: "replied", text: "办好了" });
    const rejected = replay([
      { kind: "send_message", conversation: S, idempotencyKey: "k-x", parts: [{ type: "text", text: "嗨" }], time: "2026-10-18T10:00:00+08:00" },
      { kind: "request_failed", idempotencyKey: "k-x", error: "网页上下文只能带在秘书的会话里" },
    ]);
    expect(buttonTurnOf(rejected, "k-x")).toEqual({ phase: "failed", reason: "网页上下文只能带在秘书的会话里" });
  });
});

describe("这个浏览器的网页候选卡", () => {
  test("只要这个浏览器的，按建出来的先后；不是候选卡的不算", () => {
    const state = replay([
      { ...pick("c-2", "b-1", "2026-10-18T10:00:02+08:00"), seq: 1 },
      { ...pick("c-1", "b-1", "2026-10-18T10:00:01+08:00"), seq: 2 },
      { ...pick("c-3", "b-2", "2026-10-18T10:00:03+08:00"), seq: 3 },
      frame("cards", 4, "card", { card: card("c-4", 1) }),
    ]);
    expect(browsePicksOf(state, "b-1").map((v) => v.card.id)).toEqual(["c-1", "c-2"]);
    expect(browsePicksOf(state, "b-3")).toEqual([]);
  });
});
