// 前端状态层回放（规格 Testing Decisions）：输入一串事件帧和本地动作，断言归并出的界面状态。
// 秘书聊天的主线流程（乐观显示被替换、流式到定稿、断线重连补发）回放主切面录下的真实事件流，见 recorded.test.ts；
// 这里是录不出来、或者还没有真数据的边角（卡片在 06 号票接真数据），用手写的事件序列。
import { describe, expect, test } from "vitest";
import { type ConversationId, type ConversationItem, conversationView, replay, resumeCursors, selectCard, type UiInput } from "../../src/state/index.ts";
import { card, frame, textMessage } from "./events.ts";

describe("频道序号", () => {
  test("按频道记下最后收到的序号，重连时原样带给服务端", () => {
    const state = replay([
      frame("secretary", 1, "message", { message: textMessage("m1", "agent", "早") }),
      frame("cards", 1, "card_unknown_yet", {}),
      frame("secretary", 2, "message", { message: textMessage("m2", "agent", "今天有两件事等你") }),
    ]);
    expect(resumeCursors(state)).toEqual({ secretary: 2, cards: 1 });
  });

  test("更旧的序号不会把游标往回拨", () => {
    const state = replay([
      frame("secretary", 1, "message", { message: textMessage("m1", "agent", "早") }),
      frame("secretary", 2, "message", { message: textMessage("m2", "agent", "在") }),
      frame("secretary", 1, "message", { message: textMessage("m1", "agent", "早") }),
    ]);
    expect(resumeCursors(state)).toEqual({ secretary: 2 });
  });
});

describe("会话", () => {
  test("各会话互不影响：一个频道的序号不挡另一个频道", () => {
    const maintainer = "maintainer:p-notes";
    const state = replay([
      frame("secretary", 5, "message", { message: textMessage("m5", "agent", "秘书第五条") }),
      frame(maintainer, 1, "message", { message: textMessage("w1", "agent", "维护者第一条", maintainer) }),
    ]);
    expect(texts(conversationView(state, maintainer))).toEqual(["agent:维护者第一条"]);
    expect(texts(conversationView(state, "secretary"))).toEqual(["agent:秘书第五条"]);
  });

  test("没收到过任何事件的会话是空的", () => {
    expect(conversationView(replay([]), "secretary")).toEqual([]);
  });
});

describe("乐观显示", () => {
  test("还没确认的尾巴始终排在权威消息后面，确认一条换掉一条", () => {
    const state = replay([
      send("secretary", "k1", "第一句"),
      send("secretary", "k2", "第二句"),
      frame("secretary", 1, "message", { message: textMessage("m1", "agent", "（在想）") }),
      frame("secretary", 2, "message", { message: textMessage("m2", "user", "第一句"), idempotencyKey: "k1" }),
    ]);
    expect(texts(conversationView(state, "secretary"))).toEqual(["agent:（在想）", "user:第一句", "user:第二句（sending）"]);
  });

  test("发送失败的尾巴标成失败，原文留着好重发", () => {
    const state = replay([send("secretary", "k1", "在吗"), { kind: "request_failed", idempotencyKey: "k1", error: "连接断了" }]);
    expect(conversationView(state, "secretary")).toMatchObject([{ kind: "pending", status: "failed", error: "连接断了" }]);
    expect(texts(conversationView(state, "secretary"))).toEqual(["user:在吗（failed）"]);
  });
});

describe("卡片", () => {
  test("卡片频道上同一张卡只留最新的版本", () => {
    const state = replay([
      frame("cards", 1, "card", { card: card("c1", 1, { status: "pending" }) }),
      frame("cards", 2, "card", { card: card("c2", 1) }),
      frame("cards", 3, "card", { card: card("c1", 2, { status: "handled", outcome: { action: "execute" } }) }),
    ]);
    expect(selectCard(state, "c1")?.card).toMatchObject({ version: 2, status: "handled", outcome: { action: "execute" } });
    expect(selectCard(state, "c2")?.card).toMatchObject({ version: 1, status: "pending" });
    expect(selectCard(state, "nope")).toBeUndefined();
  });

  test("点了按钮先显示处理中，收到卡片更新事件后变成已处理", () => {
    const clicked = replay([
      frame("cards", 1, "card", { card: card("c1", 1) }),
      { kind: "card_action", cardId: "c1", action: "approve", idempotencyKey: "k1" },
    ]);
    expect(selectCard(clicked, "c1")).toMatchObject({ card: { status: "pending" }, pending: { action: "approve", status: "sending" } });

    const done = replay([frame("cards", 2, "card", { card: card("c1", 2, { status: "handled", outcome: { action: "approve" } }) })], clicked);
    expect(selectCard(done, "c1")).toEqual({ card: card("c1", 2, { status: "handled", outcome: { action: "approve" } }) });
  });

  test("请求被拒（比如别的设备先处理了）：处理中的标记换成错误，卡片按权威版本显示", () => {
    const state = replay([
      frame("cards", 1, "card", { card: card("c1", 1) }),
      { kind: "card_action", cardId: "c1", action: "approve", idempotencyKey: "k1" },
      { kind: "request_failed", idempotencyKey: "k1", error: "已被处理" },
    ]);
    expect(selectCard(state, "c1")).toMatchObject({ card: { version: 1 }, pending: { action: "approve", status: "failed", error: "已被处理" } });
  });
});

describe("不认识的事件", () => {
  test("只推进序号，别的不变（后面的票再往状态层里加处理）", () => {
    const before = replay([frame("secretary", 1, "message", { message: textMessage("m1", "agent", "早") })]);
    const after = replay([frame("secretary", 2, "some_future_event", { anything: true })], before);
    expect(resumeCursors(after)).toEqual({ secretary: 2 });
    expect(conversationView(after, "secretary")).toEqual(conversationView(before, "secretary"));
  });
});

function send(conversation: ConversationId, idempotencyKey: string, text: string): UiInput {
  return { kind: "send_message", conversation, idempotencyKey, parts: [{ type: "text", text }], time: "2026-10-07T09:01:00+08:00" };
}

/** 把会话视图压成"发言方:文字"，乐观显示的条目带上自己的状态 */
function texts(items: readonly ConversationItem[]): string[] {
  return items.map((it) => {
    const text = it.message.parts.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("");
    return it.kind === "pending" ? `${it.message.speaker}:${text}（${it.status}）` : `${it.message.speaker}:${text}`;
  });
}
