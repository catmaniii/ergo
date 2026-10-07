// 前端状态层：往上翻的历史分页和附件消息（09 号票）。
// 先回放主切面录下的真实事件流（recordings/secretary-history.json、secretary-attachments.json），再补手写的边角。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { conversationView, type HistoryMessage, olderHistory, replay, type UiInput, type UiState } from "../../src/state/index.ts";
import { frame, textMessage } from "./events.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

const view = (state: UiState) => conversationView(state, "secretary");
const texts = (state: UiState) => view(state).map((it) => it.message.parts.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join(""));

describe("回放：往上翻历史（secretary-history）", () => {
  const inputs = load("secretary-history");
  const pageAt = inputs.findIndex((i) => i.kind === "history_page");

  test("第一次打开只有最近一页（第 21–70 条），可以往上翻，翻的起点是手里最早那条的序号", () => {
    const before = replay(inputs.slice(0, pageAt));
    expect(texts(before)).toEqual(Array.from({ length: 50 }, (_, k) => `历史第 ${k + 21} 条`));
    expect(olderHistory(before, "secretary")).toEqual({ canLoadOlder: true, before: 21 });
  });

  test("取回的一页接在前面，和 WebSocket 来的不重不漏；没有更早的了就不再翻；之后的聊天接在后面", () => {
    const state = replay(inputs);
    expect(texts(state)).toEqual([...Array.from({ length: 70 }, (_, k) => `历史第 ${k + 1} 条`), "在吗", "在的，刚才那些都看到了。"]);
    const ids = view(state).map((it) => it.message.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(olderHistory(state, "secretary")).toEqual({ canLoadOlder: false, before: 1 });
  });
});

const msg = (seq: number, text: string): HistoryMessage => ({ seq, message: textMessage(`m${seq}`, "agent", text) });
const page = (messages: HistoryMessage[], hasMore: boolean): UiInput => ({ kind: "history_page", conversation: "secretary", page: { conversation: "secretary", messages, hasMore } });

describe("历史分页的边角", () => {
  test("和手里已有的重叠的部分不重复；按序号排好", () => {
    const state = replay([
      frame("secretary", 5, "message", { message: textMessage("m5", "agent", "五") }),
      frame("secretary", 6, "message", { message: textMessage("m6", "agent", "六") }),
      page([msg(3, "三"), msg(4, "四"), msg(5, "五")], true),
    ]);
    expect(texts(state)).toEqual(["三", "四", "五", "六"]);
    expect(olderHistory(state, "secretary")).toEqual({ canLoadOlder: true, before: 3 });
  });

  test("自己刚发、还没确认的消息仍在最后；翻历史不推进游标", () => {
    const state = replay([
      frame("secretary", 9, "message", { message: textMessage("m9", "agent", "九") }),
      { kind: "send_message", conversation: "secretary", idempotencyKey: "k1", parts: [{ type: "text", text: "新的" }], time: "2026-10-08T09:00:00+08:00" },
      page([msg(7, "七")], false),
    ]);
    expect(texts(state)).toEqual(["七", "九", "新的"]);
    expect(view(state).at(-1)!.kind).toBe("pending");
    expect(state.cursors).toEqual({ secretary: 9 });
    expect(olderHistory(state, "secretary").canLoadOlder).toBe(false);
  });

  test("重新同步清掉了这个频道：翻历史的状态一起清掉", () => {
    const state = replay([frame("secretary", 9, "message", { message: textMessage("m9", "agent", "九") }), page([msg(7, "七")], false), { kind: "resync", channel: "secretary" }]);
    expect(texts(state)).toEqual([]);
    expect(olderHistory(state, "secretary")).toEqual({ canLoadOlder: false, before: undefined });
    const again = replay([frame("secretary", 3, "message", { message: textMessage("m3", "agent", "三") })], state);
    expect(olderHistory(again, "secretary")).toEqual({ canLoadOlder: true, before: 3 });
  });

  test("从序号 1 起就在手里：没有更早的可翻", () => {
    const state = replay([frame("secretary", 1, "message", { message: textMessage("m1", "user", "一") })]);
    expect(olderHistory(state, "secretary")).toEqual({ canLoadOlder: false, before: 1 });
  });
});

describe("回放：附件消息（secretary-attachments）", () => {
  const inputs = load("secretary-attachments");

  test("乐观显示和权威消息都带图片 part 和文件 part；权威消息里是服务端入库的类型、尺寸和大小", () => {
    const send = inputs.findIndex((i) => i.kind === "send_message");
    const pending = view(replay(inputs.slice(0, send + 1)));
    expect(pending.map((it) => it.kind)).toEqual(["pending"]);
    expect(pending[0]!.message.parts.map((p) => p.type)).toEqual(["image", "file", "text"]);

    const state = replay(inputs);
    const [user, reply] = view(state);
    expect(user!.kind).toBe("message");
    expect(user!.message.parts).toEqual([
      { type: "image", mediaId: expect.stringMatching(/^[0-9a-f]{64}$/), name: "截图.png", mime: "image/png", width: 8, height: 6 },
      { type: "file", mediaId: expect.stringMatching(/^[0-9a-f]{64}$/), name: "清单.md", mime: "text/markdown", size: 18 },
      { type: "text", text: "看看这两个" },
    ]);
    expect(texts(state)).toEqual(["[image][file]看看这两个", "图片和清单都收到了。"]);
    expect(reply!.kind).toBe("message");
  });
});
