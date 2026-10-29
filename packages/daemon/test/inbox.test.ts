// 待我处理（模块层）：已读、归档、删除、处理通知；卡着任务（紧急度前两档）的事项处理之前不能归档或删除。
// 卡着任务的事项要等产生它们的票（审批卡 07、计划卡 12……）才会真的出现，主切面场景由那些票补；这里从模块的接口测。
import path from "node:path";
import { CHANNELS, type InboxItem, nowIso } from "@ergo/protocol";
import { describe, expect, test } from "vitest";
import { createCardService } from "../src/cards/cards.ts";
import { CardTypeRegistry } from "../src/cards/registry.ts";
import { cardsView } from "../src/cards/views.ts";
import { RequestRejected } from "../src/errors.ts";
import { createEphemeralBus } from "../src/events/ephemeral.ts";
import { openEventStore } from "../src/events/event-store.ts";
import { createInboxService } from "../src/inbox/inbox.ts";
import { inboxView } from "../src/inbox/views.ts";
import { suggestTaskFixture } from "./helpers/card-fixtures.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

function setup() {
  const store = openEventStore({ file: path.join(makeTempDir(), "ergo.db"), views: [cardsView, inboxView] });
  const registry = new CardTypeRegistry();
  registry.register(suggestTaskFixture);
  const cards = createCardService({ store, registry, now: nowIso });
  const inbox = createInboxService({ store, notifications: createEphemeralBus(), now: nowIso });
  const blockingCard = () => {
    const card = cards.create({ type: "suggest_task", payload: { title: "整理照片", why: "重复太多" }, urgency: "blocking" });
    const item = inbox.add({ kind: "card", cardId: card.id, title: "计划等你确认", source: "任务「整理照片」", urgency: "blocking" });
    return { card, item };
  };
  return { store, cards, inbox, blockingCard };
}

let keyNo = 0;
const key = () => `k-${++keyNo}`;

function rejection(f: () => unknown): RequestRejected {
  try {
    f();
  } catch (err) {
    if (err instanceof RequestRejected) return err;
    throw err;
  }
  throw new Error("没有被拒");
}

describe("卡着任务的事项", () => {
  test("卡片还没处理：归档、删除都被拒并说明原因；处理之后就可以了", () => {
    const { store, cards, inbox, blockingCard } = setup();
    try {
      const { card, item } = blockingCard();
      for (const action of ["archive", "delete"] as const) {
        const err = rejection(() => inbox.act({ itemIds: [item.id], action, idempotencyKey: key() }));
        expect(err.code).toBe("not_allowed");
        expect(err.message).toMatch(/卡着任务，处理之前不能(归档|删除)/);
      }
      expect(inbox.get(item.id)).toMatchObject({ archived: false, deleted: false, version: 1 });

      // 在别处（比如聊天里）处理了这张卡：这里同步算处理过了
      cards.act({ cardId: card.id, action: "start_task", expectedVersion: 1, idempotencyKey: key() });
      expect(inbox.isProcessed(inbox.get(item.id)!)).toBe(true);
      inbox.act({ itemIds: [item.id], action: "archive", idempotencyKey: key() });
      expect(inbox.get(item.id)).toMatchObject({ archived: true, read: true, version: 2 });
      inbox.act({ itemIds: [item.id], action: "delete", idempotencyKey: key() });
      expect(inbox.get(item.id)).toMatchObject({ deleted: true, version: 3 });
      expect(inbox.list()).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("卡住任务且有时限的通知（卡住求助）：没选处理动作之前不能删；选了之后可以", () => {
    const { store, inbox } = setup();
    try {
      const item = inbox.add({ kind: "notice", notice: "stuck_help", title: "卡住求助：读不到 sdb", source: "任务「巡检」", urgency: "blocking_deadline", actions: ["我来看看", "跳过 sdb"] });
      expect(rejection(() => inbox.act({ itemIds: [item.id], action: "delete", idempotencyKey: key() })).code).toBe("not_allowed");
      inbox.act({ itemIds: [item.id], action: "handle", choice: "跳过 sdb", idempotencyKey: key() });
      expect(inbox.get(item.id)).toMatchObject({ handled: "跳过 sdb", read: true });
      inbox.act({ itemIds: [item.id], action: "delete", idempotencyKey: key() });
      expect(inbox.get(item.id)?.deleted).toBe(true);
    } finally {
      store.close();
    }
  });

  test("一次对几项做同一个动作：其中一项卡着任务，整个请求被拒，哪一项都没变", () => {
    const { store, inbox, blockingCard } = setup();
    try {
      const free = inbox.add({ kind: "notice", notice: "backup_failed", title: "备份没写进同步目录", source: "系统", urgency: "non_blocking", actions: ["知道了"] });
      const { item: blocked } = blockingCard();
      const before = store.lastSeq(CHANNELS.inbox);
      expect(rejection(() => inbox.act({ itemIds: [free.id, blocked.id], action: "archive", idempotencyKey: key() })).code).toBe("not_allowed");
      expect(store.lastSeq(CHANNELS.inbox)).toBe(before);
      expect(inbox.get(free.id)?.archived).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("不卡任务的事项", () => {
  test("随时可以标已读、标未读、归档、取消归档、删除；没有变化的不推送", () => {
    const { store, inbox } = setup();
    try {
      const a = inbox.add({ kind: "notice", notice: "reminder_due", title: "该交报告了", source: "简单提醒", urgency: "non_blocking", pinned: true, actions: ["知道了"] });
      const b = inbox.add({ kind: "notice", notice: "backup_failed", title: "备份失败", source: "系统", urgency: "non_blocking" });
      inbox.act({ itemIds: [a.id, b.id], action: "read", idempotencyKey: key() });
      expect([inbox.get(a.id), inbox.get(b.id)].map((i) => [i?.read, i?.version])).toEqual([
        [true, 2],
        [true, 2],
      ]);
      const seq = store.lastSeq(CHANNELS.inbox);
      inbox.act({ itemIds: [a.id], action: "read", idempotencyKey: key() });
      expect(store.lastSeq(CHANNELS.inbox)).toBe(seq);

      inbox.act({ itemIds: [a.id], action: "unread", idempotencyKey: key() });
      inbox.act({ itemIds: [a.id], action: "archive", idempotencyKey: key() });
      inbox.act({ itemIds: [a.id], action: "unarchive", idempotencyKey: key() });
      expect(inbox.get(a.id)).toMatchObject<Partial<InboxItem>>({ read: true, archived: false, pinned: true });
      inbox.act({ itemIds: [b.id], action: "delete", idempotencyKey: key() });
      expect(inbox.list().map((i) => i.id)).toEqual([a.id]);
    } finally {
      store.close();
    }
  });

  test("处理通知：只能选它自己的动作；选过之后再选别的得到\"已被处理\"，再选同一个不算两次", () => {
    const { store, inbox } = setup();
    try {
      const item = inbox.add({ kind: "notice", notice: "reminder_due", title: "该交报告了", source: "简单提醒", urgency: "non_blocking", actions: ["知道了"] });
      expect(rejection(() => inbox.act({ itemIds: [item.id], action: "handle", choice: "删库", idempotencyKey: key() })).code).toBe("bad_params");
      inbox.act({ itemIds: [item.id], action: "handle", choice: "知道了", idempotencyKey: key() });
      const seq = store.lastSeq(CHANNELS.inbox);
      inbox.act({ itemIds: [item.id], action: "handle", choice: "知道了", idempotencyKey: key() });
      expect(store.lastSeq(CHANNELS.inbox)).toBe(seq);
    } finally {
      store.close();
    }
  });

  test("用户选了通知的某个动作：登记了这种通知、这个动作的模块被叫一次（重发、再选同一个、别的动作、别种通知都不叫）", () => {
    const { store, inbox } = setup();
    try {
      const calls: string[] = [];
      const off = inbox.onNoticeHandled("backup_failed", "重试", (item) => calls.push(item.id));
      const failed = inbox.add({ kind: "notice", notice: "backup_failed", title: "备份失败", source: "备份", urgency: "non_blocking", actions: ["重试", "知道了"] });
      const other = inbox.add({ kind: "notice", notice: "backup_failed", title: "又失败了", source: "备份", urgency: "non_blocking", actions: ["重试", "知道了"] });
      const due = inbox.add({ kind: "notice", notice: "reminder_due", title: "该交报告了", source: "简单提醒", urgency: "non_blocking", actions: ["重试"] });

      inbox.act({ itemIds: [failed.id], action: "handle", choice: "重试", idempotencyKey: "k-retry" });
      inbox.act({ itemIds: [failed.id], action: "handle", choice: "重试", idempotencyKey: "k-retry" });
      inbox.act({ itemIds: [failed.id], action: "handle", choice: "重试", idempotencyKey: key() });
      inbox.act({ itemIds: [failed.id], action: "read", idempotencyKey: key() });
      inbox.act({ itemIds: [other.id], action: "handle", choice: "知道了", idempotencyKey: key() });
      inbox.act({ itemIds: [due.id], action: "handle", choice: "重试", idempotencyKey: key() });
      expect(calls).toEqual([failed.id]);

      off();
      const third = inbox.add({ kind: "notice", notice: "backup_failed", title: "第三次", source: "备份", urgency: "non_blocking", actions: ["重试"] });
      inbox.act({ itemIds: [third.id], action: "handle", choice: "重试", idempotencyKey: key() });
      expect(calls).toEqual([failed.id]);
    } finally {
      store.close();
    }
  });

  test("同一个幂等键重发：不会做两次（中间别处改过的状态不会被它改回去）", () => {
    const { store, inbox } = setup();
    try {
      const item = inbox.add({ kind: "notice", notice: "backup_failed", title: "备份失败", source: "系统", urgency: "non_blocking" });
      const first = inbox.act({ itemIds: [item.id], action: "read", idempotencyKey: "k-read" });
      inbox.act({ itemIds: [item.id], action: "unread", idempotencyKey: "k-unread" });
      const again = inbox.act({ itemIds: [item.id], action: "read", idempotencyKey: "k-read" });
      expect(again).toEqual(first);
      expect(inbox.get(item.id)).toMatchObject({ read: false, version: 3 });
    } finally {
      store.close();
    }
  });

  test("不存在的事项：not_found", () => {
    const { store, inbox } = setup();
    try {
      expect(rejection(() => inbox.act({ itemIds: ["i-nope"], action: "read", idempotencyKey: key() })).code).toBe("not_found");
    } finally {
      store.close();
    }
  });
});
