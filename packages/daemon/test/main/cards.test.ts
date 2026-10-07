// 主切面：卡片和待我处理的通用机制（规格第 5 节）。
// 卡片是独立实体，消息里只放引用；同一张卡在聊天、待我处理里只有一份状态。按钮闭环按版本条件更新、先到先得。
// 本票只登记了简单提醒卡；这里用一张替身"建议发起任务"卡（test/helpers/card-fixtures.ts），由测试直接放进聊天和待我处理。
import {
  type CardActionResult,
  type CardDismissedEventPayload,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItemEventPayload,
  type MessageEventPayload,
  type ResponseFrame,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { appendMessage } from "../../src/conversation/messages.ts";
import type { Daemon } from "../../src/daemon.ts";
import { suggestTaskFixture } from "../helpers/card-fixtures.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";

const { cards: CARDS, inbox: INBOX, secretary: SECRETARY } = CHANNELS;

/** 一张要用户处理的卡：在秘书的聊天里（消息里只放引用），也在待我处理里 */
function suggestCardInChatAndInbox(daemon: Daemon) {
  const card = daemon.cards.create({ type: "suggest_task", payload: { title: "整理家庭照片", why: "你提过三次重复照片太多" } });
  appendMessage(daemon.store, { conversation: SECRETARY, speaker: "agent", parts: [{ type: "text", text: "要不要发起一个任务？" }, { type: "card_ref", cardId: card.id }] });
  const item = daemon.inbox.add({ kind: "card", cardId: card.id, title: "建议发起任务：整理家庭照片", source: "秘书", urgency: "non_blocking" });
  return { card, item };
}

describe("卡片", () => {
  it("卡片是独立实体：消息里只有引用，卡片本身（类型、版本、状态、负载、纯文本降级、创建时间）在卡片频道推送", async () => {
    const { url, daemon } = await startTestDaemon({ cardTypes: [suggestTaskFixture] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0 });
    const { card } = suggestCardInChatAndInbox(daemon);

    const pushed = (await frontend.next(CARDS, EVENT_TYPES.card)).payload as CardEventPayload;
    expect(pushed.card).toEqual({
      id: card.id,
      type: "suggest_task",
      typeVersion: 1,
      version: 1,
      status: "pending",
      payload: { title: "整理家庭照片", why: "你提过三次重复照片太多" },
      text: "建议发起任务：整理家庭照片（你提过三次重复照片太多）",
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    const message = ((await frontend.next(SECRETARY, EVENT_TYPES.message)).payload as MessageEventPayload).message;
    expect(message.parts).toEqual([
      { type: "text", text: "要不要发起一个任务？" },
      { type: "card_ref", cardId: card.id },
    ]);
    const item = ((await frontend.next(INBOX, EVENT_TYPES.inboxItem)).payload as InboxItemEventPayload).item;
    expect(item).toMatchObject({ kind: "card", cardId: card.id, urgency: "non_blocking", pinned: false, read: false, archived: false, deleted: false, version: 1 });
  });

  it("两个前端：在聊天里处理一张卡，另一个前端待我处理里的同一张卡同步变成已处理", async () => {
    const { url, daemon } = await startTestDaemon({ cardTypes: [suggestTaskFixture] });
    const chat = await TestFrontend.connect(url);
    const inbox = await TestFrontend.connect(url);
    await chat.subscribe({ [SECRETARY]: 0, [CARDS]: 0 });
    await inbox.subscribe({ [CARDS]: 0, [INBOX]: 0 });
    const { card, item } = suggestCardInChatAndInbox(daemon);
    await inbox.next(INBOX, EVENT_TYPES.inboxItem);
    await chat.next(SECRETARY, EVENT_TYPES.message);

    const ack = await chat.cardAction({ cardId: card.id, action: "start_task", expectedVersion: 1 });
    expect(ack).toMatchObject({ ok: true, result: { cardId: card.id, version: 2 } satisfies CardActionResult });

    // 卡片的第一版在待我处理事项之前就推过了，这里等到的是处理之后的那一版
    const updated = (await inbox.next(CARDS, EVENT_TYPES.card)).payload as CardEventPayload;
    expect(updated.card).toMatchObject({ id: card.id, version: 2, status: "handled", outcome: { action: "start_task" }, handledAt: expect.any(String) });
    // 待我处理里的事项指向同一张卡，不另外存状态：处理没处理看卡片
    expect(daemon.inbox.isProcessed(daemon.inbox.get(item.id)!)).toBe(true);
    saveOrCheckRecording("cards-inbox-sync", inbox.recording);
  });

  it("两个前端用同一期望版本同时点同一张卡：只有一个生效，另一个得到\"已被处理\"", async () => {
    const { url, daemon } = await startTestDaemon({ cardTypes: [suggestTaskFixture] });
    const a = await TestFrontend.connect(url);
    const b = await TestFrontend.connect(url);
    await a.subscribe({ [CARDS]: 0 });
    await b.subscribe({ [CARDS]: 0 });
    const { card } = suggestCardInChatAndInbox(daemon);

    const responses = await Promise.all([
      a.cardAction({ cardId: card.id, action: "start_task", expectedVersion: 1 }),
      b.cardAction({ cardId: card.id, action: "dismiss", expectedVersion: 1 }),
    ]);
    expect(responses.filter((r) => r.ok)).toHaveLength(1);
    const lost = responses.find((r) => !r.ok) as Extract<ResponseFrame, { ok: false }>;
    expect(lost.error).toEqual({ code: "conflict", message: "已被处理" });
    // 卡片只变了一次
    expect(daemon.store.read(CARDS).filter((e) => e.type === EVENT_TYPES.card).map((e) => (e.payload as CardEventPayload).card.version)).toEqual([1, 2]);
  });

  it("同一个幂等键重发：拿到同一个 ack，卡片不会被处理两次", async () => {
    const { url, daemon } = await startTestDaemon({ cardTypes: [suggestTaskFixture] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [CARDS]: 0 });
    const { card } = suggestCardInChatAndInbox(daemon);
    const first = await frontend.cardAction({ cardId: card.id, action: "start_task", expectedVersion: 1 }, "k-start");
    const again = await frontend.cardAction({ cardId: card.id, action: "start_task", expectedVersion: 1 }, "k-start");
    expect(again).toEqual({ ...first, id: again.id });
    expect(daemon.store.read(CARDS).map((e) => e.type)).toEqual([EVENT_TYPES.card, EVENT_TYPES.card]);
  });

  it("用户关掉一张卡：卡片已关闭，并产生\"卡片被关闭\"事件（卡片类型、id、用户的说明、时间），给回避信号用", async () => {
    const { url, daemon } = await startTestDaemon({ cardTypes: [suggestTaskFixture] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [CARDS]: 0 });
    const { card } = suggestCardInChatAndInbox(daemon);
    await frontend.cardAction({ cardId: card.id, action: "dismiss", expectedVersion: 1, note: "暂时不用" });

    const dismissed = (await frontend.next(CARDS, EVENT_TYPES.cardDismissed)).payload as CardDismissedEventPayload;
    expect(dismissed).toEqual({ cardId: card.id, cardType: "suggest_task", action: "dismiss", note: "暂时不用", time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(daemon.cards.get(card.id)).toMatchObject({ status: "dismissed", outcome: { action: "dismiss", note: "暂时不用" } });
  });

  it("不存在的卡、卡上没有的动作、过期的版本：各自的错误，连接不断", async () => {
    const { url, daemon } = await startTestDaemon({ cardTypes: [suggestTaskFixture] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [CARDS]: 0 });
    const { card } = suggestCardInChatAndInbox(daemon);
    expect(await frontend.cardAction({ cardId: "c-nope", action: "start_task", expectedVersion: 1 })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: 1 })).toMatchObject({ ok: false, error: { code: "bad_params" } });
    expect(await frontend.cardAction({ cardId: card.id, action: "start_task", expectedVersion: 7 })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await frontend.cardAction({ cardId: card.id, action: "start_task", expectedVersion: 1 })).toMatchObject({ ok: true });
  });
});

describe("待我处理", () => {
  it("已读、归档、删除在多个前端之间实时同步", async () => {
    const { url, daemon } = await startTestDaemon({ cardTypes: [suggestTaskFixture] });
    const a = await TestFrontend.connect(url);
    const b = await TestFrontend.connect(url);
    await a.subscribe({ [INBOX]: 0, [CARDS]: 0 });
    await b.subscribe({ [INBOX]: 0, [CARDS]: 0 });
    const { item } = suggestCardInChatAndInbox(daemon);
    const notice = daemon.inbox.add({ kind: "notice", notice: "backup_failed", title: "昨晚的备份没写进同步目录", source: "系统", urgency: "non_blocking", actions: ["重试", "知道了"] });

    expect(await a.inboxAction({ itemIds: [item.id, notice.id], action: "read" })).toMatchObject({ ok: true });
    expect(await a.inboxAction({ itemIds: [notice.id], action: "handle", choice: "知道了" })).toMatchObject({ ok: true });
    expect(await a.inboxAction({ itemIds: [notice.id], action: "archive" })).toMatchObject({ ok: true });
    expect(await a.inboxAction({ itemIds: [item.id], action: "delete" })).toMatchObject({ ok: true });

    // b 收到的事项状态：按推送顺序，每条都是最新的完整状态
    for (let i = 0; i < 7; i++) await b.next(INBOX, EVENT_TYPES.inboxItem);
    const seen = b.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
    const handled = (i: (typeof seen)[number]) => (i.kind === "notice" && i.handled ? ` ${i.handled}` : "");
    expect(seen.map((i) => `${i.kind} v${i.version}${i.read ? " 已读" : ""}${handled(i)}${i.archived ? " 已归档" : ""}${i.deleted ? " 已删除" : ""}`)).toEqual([
      "card v1",
      "notice v1",
      "card v2 已读",
      "notice v2 已读",
      "notice v3 已读 知道了",
      "notice v4 已读 知道了 已归档",
      "card v3 已读 已删除",
    ]);
  });
});
