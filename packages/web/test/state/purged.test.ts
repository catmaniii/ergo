// 前端状态层：被彻底删除的消息和卡片（21 号票）。服务端补发、往上翻的历史里只有"已删除"标记；
// 手里已经有原话的，收到 messages_purged 就换成标记；带原话的工具调用记录换成改写后的样子；改写成标记的旧版本卡片忽略。
// 输入框里引用的卡片（quote_card）：发消息时带上，发出去就清掉。
import { describe, expect, test } from "vitest";
import { conversationView, type HistoryPage, type MessageEnvelope, PURGED_TEXT, quotedCards, replay, selectCard } from "../../src/state/index.ts";
import { card, frame, msg, textMessage } from "./events.ts";

const DELETED = { deleted: true as const, deletedAt: "2026-10-09T10:00:00.000+08:00", messageId: "m2", messageTime: "2026-10-07T09:00:00+08:00" };

/** 一条检索素材的工具调用记录 */
const record = (argsSummary: string, resultSummary: string): MessageEnvelope => ({
  id: "m-tool",
  conversation: "secretary",
  speaker: "agent",
  time: "2026-10-07T09:00:00+08:00",
  parts: [{ type: "tool_call", callId: "call-1", tool: "search_materials", argsSummary, categoryTitles: [], disposition: "do", withinGrant: false, genericBash: false, outcome: "done", resultSummary }],
});

describe("被彻底删除的消息", () => {
  test("补发里是\"已删除\"标记：原来的位置显示一条已删除，不带原话", () => {
    const state = replay([
      frame("secretary", 1, "message", { message: textMessage("m1", "user", "早") }),
      frame("secretary", 2, "message", DELETED),
      frame("secretary", 3, "message", { message: textMessage("m3", "agent", "好") }),
    ]);
    expect(conversationView(state, "secretary")).toEqual([
      expect.objectContaining({ kind: "message", message: expect.objectContaining({ id: "m1" }) }),
      { kind: "deleted", key: "m2", time: "2026-10-07T09:00:00+08:00" },
      expect.objectContaining({ kind: "message", message: expect.objectContaining({ id: "m3" }) }),
    ]);
  });

  test("手里有原话的，收到 messages_purged 换成标记；往上翻取回的一页里也只有标记", () => {
    const page: HistoryPage = { conversation: "secretary", messages: [{ seq: 1, deleted: { ...DELETED, messageId: "m0" } }], records: [], hasMore: false };
    const state = replay([
      frame("secretary", 2, "message", { message: textMessage("m2", "user", "这句要彻底删掉") }),
      frame("secretary", 3, "messages_purged", { messages: [{ seq: 2, messageId: "m2" }], materialIds: ["mat-1"], toolCallIds: [], mediaIds: [], deletedAt: DELETED.deletedAt }),
      { kind: "history_page", conversation: "secretary", page },
    ]);
    const items = conversationView(state, "secretary");
    expect(items.map((it) => it.kind)).toEqual(["deleted", "deleted"]);
    expect(JSON.stringify(items)).not.toContain("彻底删掉");
  });

  test("带原话的工具调用记录：换成改写后的样子（还是一次工具调用，参数摘要、结果摘要换成删除标记）", () => {
    const state = replay([
      frame("secretary", 1, "message", { message: record("query=房东", "找到 1 条：房东要卖房") }),
      frame("secretary", 2, "messages_purged", {
        messages: [{ seq: 1, messageId: "m-tool", replacement: record(PURGED_TEXT, PURGED_TEXT) }],
        materialIds: ["mat-1"],
        toolCallIds: [],
        mediaIds: [],
        deletedAt: DELETED.deletedAt,
      }),
    ]);
    const [item] = conversationView(state, "secretary");
    expect(msg(item!).parts).toMatchObject([{ type: "tool_call", tool: "search_materials", argsSummary: PURGED_TEXT, resultSummary: PURGED_TEXT, outcome: "done" }]);
    expect(JSON.stringify(state.conversations)).not.toContain("房东");
  });

  test("卡片频道上改写成标记的旧版本忽略，之后去掉原话的新版本照常", () => {
    const state = replay([frame("cards", 1, "card", { deleted: true, deletedAt: DELETED.deletedAt }), frame("cards", 2, "card", { card: card("c1", 2, { status: "handled" }) })]);
    expect(selectCard(state, "c1")?.card).toMatchObject({ version: 2, status: "handled" });
  });
});

describe("引用卡片到输入框", () => {
  test("引用一张卡（同一张只引用一次）、去掉一张；发消息时卡片引用随消息发出，输入框里的引用清掉", () => {
    const quoted = replay([
      frame("cards", 1, "card", { card: card("c1", 1) }),
      frame("cards", 2, "card", { card: card("c2", 1) }),
      { kind: "quote_card", conversation: "secretary", cardId: "c1" },
      { kind: "quote_card", conversation: "secretary", cardId: "c2" },
      { kind: "quote_card", conversation: "secretary", cardId: "c1" },
    ]);
    expect(quotedCards(quoted, "secretary")).toEqual(["c1", "c2"]);
    const removed = replay([{ kind: "unquote_card", conversation: "secretary", cardId: "c2" }], quoted);
    expect(quotedCards(removed, "secretary")).toEqual(["c1"]);

    const sent = replay(
      [
        {
          kind: "send_message",
          conversation: "secretary",
          idempotencyKey: "k1",
          parts: [{ type: "card_ref", cardId: "c1" }, { type: "text", text: "记住这条" }],
          time: "2026-10-08T09:00:00+08:00",
        },
      ],
      removed,
    );
    expect(quotedCards(sent, "secretary")).toEqual([]);
    // 乐观显示的消息里带着卡片引用；权威消息到了替换它
    expect(conversationView(sent, "secretary").map((it) => msg(it).parts.map((p) => p.type))).toEqual([["card_ref", "text"]]);
    const confirmed = replay(
      [frame("secretary", 1, "message", { message: { ...textMessage("m1", "user", "记住这条"), parts: [{ type: "card_ref", cardId: "c1" }, { type: "text", text: "记住这条" }] }, idempotencyKey: "k1" })],
      sent,
    );
    expect(conversationView(confirmed, "secretary").map((it) => it.kind)).toEqual(["message"]);
  });
});
