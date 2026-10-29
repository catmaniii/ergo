// 会话回退（150 号票）的前端状态：回放会话频道上的事件（手写的，照主切面 daemon/test/main/session-rollback.test.ts 的形状），看
// - 会话视图、时间线、未读只看当前分支上的；废弃分支上的消息留在手里（151 号票的预览用）；往上翻取回的一页照常并进来；
// - 分支摘要是一条系统说明：对话层 🧭 摘要，要点层写"分支摘要：…"；
// - 回退点（条左边的 ↶）：这段会话里每条用户消息"撤回到这条请求之前"、每条分支摘要"撤回到这条分支开始前"；清空之前的、
//   排队一起交出的一批里第一条之后的、网页上下的指令、系统说明都没有；只在能回退的会话（秘书）里有；
// - 分叉点（条右边的 ⑂）：挂在当前路径上分叉处之后的第一条（新分支开头的分支摘要），几条分支挂在同一处时都在。
import { describe, expect, test } from "vitest";
import {
  chatItems,
  type ConversationBranches,
  type ConversationId,
  conversationView,
  type EventFrame,
  type MessageEnvelope,
  replay,
  type SessionBranchEventPayload,
  type UiInput,
  type UiState,
  zoomDecor,
} from "../../src/state/index.ts";
import { frame, textMessage } from "./events.ts";

const S: ConversationId = "secretary";

const user = (seq: number, id: string, text: string, extra: Record<string, unknown> = {}) => frame(S, seq, "message", { message: textMessage(id, "user", text), ...extra });
const agent = (seq: number, id: string, text: string) => frame(S, seq, "message", { message: textMessage(id, "agent", text) });
const summary = (seq: number, id: string, branchId: string, text: string): EventFrame =>
  frame(S, seq, "message", { message: { id, conversation: S, speaker: "system", time: "2026-10-18T10:00:00+08:00", parts: [{ type: "branch_summary", branchId, summary: text }] } satisfies MessageEnvelope });
const branchEvent = (seq: number, branches: ConversationBranches, from: string, to: string): EventFrame =>
  frame(S, seq, "session_branch", { change: "rollback", branches, from, to, by: "user", time: "2026-10-18T10:00:00+08:00" } satisfies SessionBranchEventPayload);

/** 回到第 3 条（"第二句"）之前：第 7 条起是新分支 b1 */
const ONE: ConversationBranches = {
  current: "b1",
  branches: [
    { id: "b0", start: 0, tip: "e-9" },
    { id: "b1", parent: "b0", cutoff: 3, start: 7, summary: { messageId: "m-s1", text: "摘要一" }, entry: "e-2" },
  ],
  epochs: [
    { from: 0, branch: "b0" },
    { from: 7, branch: "b1" },
  ],
};

const base: (EventFrame | UiInput)[] = [
  user(1, "m-1", "第一句：查天气"),
  agent(2, "m-2", "今天晴"),
  user(3, "m-3", "第二句：写邮件"),
  agent(4, "m-4", "写好了"),
  user(5, "m-5", "第三句：订会议室"),
  agent(6, "m-6", "订好了"),
];
const rolledBack: (EventFrame | UiInput)[] = [...base, branchEvent(7, ONE, "b0", "b1"), summary(8, "m-s1", "b1", "摘要一"), user(9, "m-7", "重新来"), agent(10, "m-8", "好")];

const texts = (state: UiState) => chatItems(state, S).map((it) => it.keyLine);
const leftOf = (state: UiState) => {
  const items = chatItems(state, S);
  const decor = zoomDecor(state, S, items);
  return items.flatMap((it) => (decor.rollbacks.get(it.id) ?? []).map((p) => `${it.keyLine} ← ${p.label}`));
};
const forksOf = (state: UiState) => {
  const items = chatItems(state, S);
  const decor = zoomDecor(state, S, items);
  return items.flatMap((it) => (decor.forks.has(it.id) ? [`${it.keyLine} → ${decor.forks.get(it.id)!.map((f) => f.branchId).join("、")}`] : []));
};

describe("会话树（前端）", () => {
  test("回退之后：会话里只有当前分支上的，废弃分支上的消息留在手里；分支摘要是一条 🧭 系统说明", () => {
    const state = replay(rolledBack);
    expect(texts(state)).toEqual(["你：第一句：查天气", "回复：今天晴", "分支摘要：摘要一", "你：重新来", "回复：好"]);
    expect(conversationView(state, S).map((it) => (it.kind === "deleted" ? "" : it.message.id))).toEqual(["m-1", "m-2", "m-s1", "m-7", "m-8"]);
    expect(state.conversations[S]!.messages).toHaveLength(9);
    const branch = chatItems(state, S).find((it) => it.kind === "system")!;
    expect(branch).toMatchObject({ kind: "system", content: "context", text: "摘要一", branch: { id: "b1", summary: "摘要一" } });
  });

  test("没回退过：照旧都显示，没有分叉；回退点在每条用户消息左边", () => {
    const state = replay(base);
    expect(texts(state)).toHaveLength(6);
    expect(forksOf(state)).toEqual([]);
    expect(leftOf(state)).toEqual(["你：第一句：查天气 ← 撤回到这条请求之前", "你：第二句：写邮件 ← 撤回到这条请求之前", "你：第三句：订会议室 ← 撤回到这条请求之前"]);
  });

  test("回退点：当前分支上的用户消息、分支摘要；分叉点挂在分支摘要右边", () => {
    const state = replay(rolledBack);
    expect(leftOf(state)).toEqual(["你：第一句：查天气 ← 撤回到这条请求之前", "分支摘要：摘要一 ← 撤回到这条分支开始前", "你：重新来 ← 撤回到这条请求之前"]);
    expect(forksOf(state)).toEqual(["分支摘要：摘要一 → b0"]);
  });

  test("撤回到分支开始前又长出一条：两条废弃分支挂在同一处", () => {
    const two: ConversationBranches = {
      current: "b2",
      branches: [...ONE.branches, { id: "b2", parent: "b0", cutoff: 3, start: 11, summary: { messageId: "m-s2", text: "摘要二" }, entry: "e-2" }],
      epochs: [...ONE.epochs, { from: 11, branch: "b2" }],
    };
    const state = replay([...rolledBack, branchEvent(11, two, "b1", "b2"), summary(12, "m-s2", "b2", "摘要二")]);
    expect(texts(state)).toEqual(["你：第一句：查天气", "回复：今天晴", "分支摘要：摘要二"]);
    expect(forksOf(state)).toEqual(["分支摘要：摘要二 → b0、b1"]);
  });

  test("只在这段会话里：清空之前的没有回退点；排队一起交出的一批只有第一条有；网页上下的指令没有；152 号票起维护者的会话也有", () => {
    const cleared = frame(S, 3, "message", { message: { id: "m-c", conversation: S, speaker: "system", time: "2026-10-18T09:00:00+08:00", parts: [{ type: "conversation_cleared" }] } });
    const page = frame(S, 6, "message", { message: { ...textMessage("m-p", "user", "把名字填上"), pageCommand: { url: "https://x", title: "x", field: "名字", spoken: false } } });
    const state = replay([
      user(1, "m-1", "清空前"),
      agent(2, "m-2", "嗯"),
      cleared,
      user(4, "m-a", "排队一", { queueDelivery: "q-1" }),
      user(5, "m-b", "排队二", { queueDelivery: "q-1" }),
      page,
      user(7, "m-z", "最后一句"),
    ]);
    expect(leftOf(state)).toEqual(["你：排队一 ← 撤回到这条请求之前", "你：最后一句 ← 撤回到这条请求之前"]);
    const maintainer: ConversationId = "maintainer:t-1";
    const other = replay([frame(maintainer, 1, "message", { message: textMessage("m-x", "user", "维护者会话里", maintainer) })]);
    const items = chatItems(other, maintainer);
    expect([...zoomDecor(other, maintainer, items).rollbacks.values()].flat().map((p) => p.label)).toEqual(["撤回到这条请求之前"]);
  });

  test("接管时导进来的前情（290 号票，prelude）没有回退点：不是交给 agent 的输入（293 号票）", () => {
    const maintainer: ConversationId = "maintainer:tm-flaky";
    const state = replay([
      frame(maintainer, 1, "message", { message: { ...textMessage("m-pre", "user", "前情里的话", maintainer), prelude: true } }),
      frame(maintainer, 2, "message", { message: textMessage("m-now", "user", "接管之后说的", maintainer) }),
    ]);
    const items = chatItems(state, maintainer);
    const decor = zoomDecor(state, maintainer, items);
    expect(items.flatMap((it) => (decor.rollbacks.get(it.id) ?? []).map((p) => `${it.keyLine} ← ${p.label}`))).toEqual(["你：接管之后说的 ← 撤回到这条请求之前"]);
  });

  test("分支摘要上记着运行时恢复了哪些文件（293 号票）：条目带着", () => {
    const withFiles = frame(S, 8, "message", {
      message: { id: "m-s1", conversation: S, speaker: "system", time: "2026-10-18T10:00:00+08:00", parts: [{ type: "branch_summary", branchId: "b1", summary: "摘要一", files: { restored: ["a.md"] } }] } satisfies MessageEnvelope,
    });
    const state = replay([...base, branchEvent(7, ONE, "b0", "b1"), withFiles]);
    expect(chatItems(state, S).find((it) => it.kind === "system")).toMatchObject({ branch: { id: "b1", summary: "摘要一", files: { restored: ["a.md"] } } });
  });

  test("换模型新开会话的说明之后才有回退点（150 号票之前的说明按文字认）", () => {
    const note = frame(S, 3, "message", { message: textMessage("m-n", "system", "已换成 DeepSeek V4 Pro 模型（思考：高），接着之前的对话。") });
    const state = replay([user(1, "m-1", "换之前"), agent(2, "m-2", "嗯"), note, user(4, "m-3", "换之后")]);
    expect(leftOf(state)).toEqual(["你：换之后 ← 撤回到这条请求之前"]);
  });

  test("往上翻取回的一页（服务端只给当前分支上的）照常并进来；最新的会话树先到（补发时钉在前面），之后的事件照常归并", () => {
    // 第一次订阅：最新的会话树（序号 7）先到，补发的一页从序号 8 起
    const state = replay([branchEvent(7, ONE, "b0", "b1"), summary(8, "m-s1", "b1", "摘要一"), user(9, "m-7", "重新来")]);
    expect(texts(state)).toEqual(["分支摘要：摘要一", "你：重新来"]);
    const withPage = replay(
      [
        {
          kind: "history_page",
          conversation: S,
          page: {
            conversation: S,
            messages: [
              { seq: 1, message: textMessage("m-1", "user", "第一句：查天气") },
              { seq: 2, message: textMessage("m-2", "agent", "今天晴") },
            ],
            records: [],
            hasMore: false,
          },
        },
      ],
      state,
    );
    expect(texts(withPage)).toEqual(["你：第一句：查天气", "回复：今天晴", "分支摘要：摘要一", "你：重新来"]);
    expect(forksOf(withPage)).toEqual(["分支摘要：摘要一 → b0"]);
  });
});
