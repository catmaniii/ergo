// 事件存储（规格第 4 节）：事件日志是唯一真相，按频道编号，带幂等键；派生视图在追加事件的同一事务里更新，
// 可以从日志整体重建。这里从事件存储的对外接口测；派生视图用会话视图（真实的）和测试里定义的视图。
import path from "node:path";
import { describe, expect, test } from "vitest";
import { conversationViews, listMessages, pendingInputs, startedInputs } from "../src/conversation/views.ts";
import { type DerivedView, type EventStore, openEventStore, type StoredEvent } from "../src/events/event-store.ts";
import { openDatabase } from "../src/storage/sqlite.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

function openStore(views: readonly DerivedView[] = conversationViews) {
  const file = path.join(makeTempDir(), "ergou.db");
  return Object.assign(openEventStore({ file, views }), { file });
}

const userMessage = (id: string, text: string, conversation = "secretary") => ({
  message: { id, conversation, speaker: "user", time: "2026-10-07T09:00:00+08:00", parts: [{ type: "text", text }] },
});

describe("追加与读取", () => {
  test("事件带全局序号、频道、频道内序号、类型、负载、时间、幂等键；频道内序号各自从 1 连续编号", () => {
    const store = openStore();
    try {
      store.append({ channel: "secretary", type: "message", payload: userMessage("m1", "早"), idempotencyKey: "k1" });
      store.append({ channel: "cards", type: "card", payload: { card: { id: "c1" } } });
      store.append({ channel: "secretary", type: "message", payload: userMessage("m2", "在吗") });

      const events = store.read("secretary");
      expect(events.map((e) => [e.channel, e.seq, e.type, e.idempotencyKey])).toEqual([
        ["secretary", 1, "message", "k1"],
        ["secretary", 2, "message", null],
      ]);
      expect(events[1]!.payload).toEqual(userMessage("m2", "在吗"));
      expect(events[0]!.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/);
      expect(store.read("cards").map((e) => e.seq)).toEqual([1]);
      // 全局序号跨频道递增
      const global = [...store.read("secretary"), ...store.read("cards")].map((e) => e.globalSeq).toSorted((a, b) => a - b);
      expect(global).toEqual([1, 2, 3]);
      expect(store.lastSeq("secretary")).toBe(2);
      expect(store.lastSeq("board")).toBe(0);
    } finally {
      store.close();
    }
  });

  test("按频道从某个序号之后读", () => {
    const store = openStore();
    try {
      for (let i = 1; i <= 5; i++) store.append({ channel: "secretary", type: "message", payload: userMessage(`m${i}`, `第${i}句`) });
      expect(store.read("secretary", 3).map((e) => e.seq)).toEqual([4, 5]);
      expect(store.read("secretary", 5)).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("同一个幂等键追加两次只留一条，第二次拿到第一次的结果，也不再通知订阅者", () => {
    const store = openStore();
    try {
      const seen: StoredEvent[] = [];
      store.onAppend((e) => seen.push(e));
      const first = store.append({ channel: "secretary", type: "message", payload: userMessage("m1", "在吗"), idempotencyKey: "k1" });
      const second = store.append({ channel: "secretary", type: "message", payload: userMessage("m1-again", "在吗"), idempotencyKey: "k1" });
      expect(first.duplicate).toBe(false);
      expect(second).toEqual({ event: first.event, duplicate: true });
      expect(store.read("secretary")).toEqual([first.event]);
      expect(listMessages(store.reader, "secretary").map((m) => m.id)).toEqual(["m1"]);
      expect(seen).toEqual([first.event]);
    } finally {
      store.close();
    }
  });
});

describe("订阅", () => {
  test("订阅者在通知里又追加了事件：每个订阅者收到的事件仍按追加顺序，一条不漏", () => {
    const store = openStore();
    try {
      const first: number[] = [];
      const second: number[] = [];
      // 第一个订阅者看到用户消息就追加一条 turn_start（秘书就是这样做的）
      store.onAppend((e) => {
        first.push(e.seq);
        if (e.type === "message") store.append({ channel: "secretary", type: "turn_start", payload: { inputMessageId: "m1" } });
      });
      store.onAppend((e) => second.push(e.seq));
      store.append({ channel: "secretary", type: "message", payload: userMessage("m1", "在吗") });
      expect(first).toEqual([1, 2]);
      expect(second).toEqual([1, 2]);
    } finally {
      store.close();
    }
  });
});

describe("派生视图", () => {
  test("派生视图和事件在同一事务里写：视图更新失败时事件也不落", () => {
    const failing: DerivedView = {
      name: "failing",
      create: (db) => db.exec("CREATE TABLE IF NOT EXISTS failing_view (id TEXT)"),
      clear: (db) => db.exec("DELETE FROM failing_view"),
      apply: (db, event) => {
        db.run("INSERT INTO failing_view (id) VALUES (?)", String(event.globalSeq));
        if ((event.payload as { boom?: boolean }).boom) throw new Error("视图更新失败");
      },
    };
    const store = openStore([...conversationViews, failing]);
    try {
      store.append({ channel: "secretary", type: "message", payload: userMessage("m1", "早") });
      expect(() => store.append({ channel: "secretary", type: "message", payload: { ...userMessage("m2", "炸"), boom: true } })).toThrow("视图更新失败");

      expect(store.read("secretary").map((e) => e.seq)).toEqual([1]);
      expect(store.lastSeq("secretary")).toBe(1);
      expect(listMessages(store.reader, "secretary").map((m) => m.id)).toEqual(["m1"]);
      expect(store.reader.all("SELECT id FROM failing_view")).toEqual([{ id: "1" }]);
      // 失败之后照常能追加，序号接着连续
      expect(store.append({ channel: "secretary", type: "message", payload: userMessage("m3", "好了") }).event.seq).toBe(2);
    } finally {
      store.close();
    }
  });

  test("会话视图里只有定稿的消息，按事件顺序", () => {
    const store = openStore();
    try {
      store.append({ channel: "secretary", type: "message", payload: userMessage("m1", "在吗"), idempotencyKey: "k1" });
      store.append({ channel: "secretary", type: "turn_end", payload: { inputMessageId: "m1", outcome: "completed" } });
      store.append({ channel: "maintainer:p-notes", type: "message", payload: userMessage("w1", "改一下", "maintainer:p-notes") });
      store.append({
        channel: "secretary",
        type: "message",
        payload: { message: { id: "m2", conversation: "secretary", speaker: "agent", time: "2026-10-07T09:00:01+08:00", parts: [{ type: "reasoning", text: "想想" }, { type: "text", text: "在" }] } },
      });
      expect(listMessages(store.reader, "secretary")).toEqual([
        { id: "m1", conversation: "secretary", speaker: "user", time: "2026-10-07T09:00:00+08:00", parts: [{ type: "text", text: "在吗" }] },
        { id: "m2", conversation: "secretary", speaker: "agent", time: "2026-10-07T09:00:01+08:00", parts: [{ type: "reasoning", text: "想想" }, { type: "text", text: "在" }] },
      ]);
    } finally {
      store.close();
    }
  });

  test("派生视图被清空后，从事件日志整体重建，结果和重建前一致", () => {
    const store = openStore();
    try {
      store.append({ channel: "secretary", type: "message", payload: userMessage("m1", "在吗"), idempotencyKey: "k1" });
      store.append({ channel: "secretary", type: "message", payload: userMessage("m2", "第二句") });
      store.append({ channel: "secretary", type: "turn_start", payload: { inputMessageId: "m2" } });
      store.append({ channel: "secretary", type: "turn_end", payload: { inputMessageId: "m1", outcome: "completed" } });
      store.append({ channel: "maintainer:p-notes", type: "message", payload: userMessage("w1", "改一下", "maintainer:p-notes") });
      const before = { secretary: listMessages(store.reader, "secretary"), notes: listMessages(store.reader, "maintainer:p-notes"), pending: pendingIds(store) };
      expect(before.pending).toEqual(["w1"]);
      expect(startedInputs(store.reader, "secretary").map((i) => i.messageId)).toEqual(["m2"]);

      // 派生视图丢了（另开一个连接直接清空，模拟损坏）
      const raw = openDatabase(store.file);
      for (const view of conversationViews) view.clear(raw);
      raw.close();
      expect(listMessages(store.reader, "secretary")).toEqual([]);
      expect(pendingIds(store)).toEqual([]);

      store.rebuildViews();
      expect({ secretary: listMessages(store.reader, "secretary"), notes: listMessages(store.reader, "maintainer:p-notes"), pending: pendingIds(store) }).toEqual(before);
      expect(startedInputs(store.reader, "secretary").map((i) => i.messageId)).toEqual(["m2"]);
    } finally {
      store.close();
    }
  });

  test("读派生视图用的连接是只读的：写不进去", () => {
    const store = openStore();
    try {
      store.append({ channel: "secretary", type: "message", payload: userMessage("m1", "在吗") });
      expect(() => store.reader.all("DELETE FROM events RETURNING global_seq")).toThrow(/readonly/);
      expect(store.read("secretary")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("重新打开同一个库：事件和派生视图都还在，序号接着编", () => {
    const file = path.join(makeTempDir(), "ergou.db");
    const first = openEventStore({ file, views: conversationViews });
    first.append({ channel: "secretary", type: "message", payload: userMessage("m1", "在吗") });
    first.close();
    const second = openEventStore({ file, views: conversationViews });
    try {
      expect(listMessages(second.reader, "secretary").map((m) => m.id)).toEqual(["m1"]);
      expect(second.append({ channel: "secretary", type: "message", payload: userMessage("m2", "还在吗") }).event.seq).toBe(2);
    } finally {
      second.close();
    }
  });
});

function pendingIds(store: EventStore): string[] {
  return (["secretary", "maintainer:p-notes"] as const).flatMap((c) => pendingInputs(store.reader, c).map((input) => input.messageId));
}
