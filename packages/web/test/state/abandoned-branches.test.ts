// 废弃分支（151 号票）的前端状态：回放会话频道上的事件和 HTTP 取回的分支的样子（手写的，照主切面 daemon/test/main/session-branch-switch.test.ts
// 的形状），看
// - ⑂ 展开的预览：这条分支自己那一段的条目（和主线同一套），"N 段"是缩小后的块数；手里的消息不全时取回来并进去；
// - 分支详情：分支摘要、遗留效果，申请撤回过的标出来（取回时就有的、之后会话频道上来的）；会话树一变取回的就作废；
// - 切换分支：会话里换成那条分支的样子，原来的当前分支变成废弃的、挂在同一处；切回来照样；往上翻沿当前分支接着翻；
// - 分叉在这段会话之前的切不过去；切换之后进到当前路径上的条目不算新到的。
import { describe, expect, test } from "vitest";
import {
  abandonedBranch,
  type BranchView,
  branchEpochStart,
  branchGaps,
  chatItems,
  type ConversationBranches,
  type ConversationId,
  type EventFrame,
  type MessageEnvelope,
  olderHistory,
  replay,
  type RollbackEffect,
  type SessionBranchEventPayload,
  switchedTree,
  type UiInput,
  type UiState,
  zoomDecor,
} from "../../src/state/index.ts";
import { frame, textMessage } from "./events.ts";

const S: ConversationId = "secretary";
const TIME = "2026-10-18T10:00:00+08:00";

const user = (seq: number, id: string, text: string) => frame(S, seq, "message", { message: textMessage(id, "user", text) });
const agent = (seq: number, id: string, text: string) => frame(S, seq, "message", { message: textMessage(id, "agent", text) });
const summary = (seq: number, id: string, branchId: string, text: string): EventFrame =>
  frame(S, seq, "message", { message: { id, conversation: S, speaker: "system", time: TIME, parts: [{ type: "branch_summary", branchId, summary: text }] } satisfies MessageEnvelope });
const branchEvent = (seq: number, branches: ConversationBranches, from: string, to: string, change: "rollback" | "switch" = "rollback"): EventFrame =>
  frame(S, seq, "session_branch", { change, branches, from, to, by: "user", time: TIME } satisfies SessionBranchEventPayload);

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

const effect = (callId: string, scope: "local" | "external", undoable: boolean, why?: string): RollbackEffect => ({
  callId,
  tool: callId === "c-send" ? "send_message" : "write",
  argsSummary: "x",
  summary: "x",
  scope,
  undoable,
  ...(why ? { why } : {}),
  at: TIME,
});

/** 守护进程给的 b0 的样子（和 b1 比）：第 3~6 条、分支摘要、两件遗留效果，写文件那件已经申请过撤回 */
const B0_VIEW: BranchView = {
  conversation: S,
  branchId: "b0",
  against: "b1",
  summary: "摘要一",
  messages: [
    { seq: 3, message: textMessage("m-3", "user", "第二句：写邮件") },
    { seq: 4, message: textMessage("m-4", "agent", "写好了") },
    { seq: 5, message: textMessage("m-5", "user", "第三句：订会议室") },
    { seq: 6, message: textMessage("m-6", "agent", "订好了") },
  ],
  records: [],
  effects: [effect("c-send", "external", false, "已经对外生效"), { ...effect("c-write", "local", true), undoRequested: "2026-10-18T10:05:00+08:00" }, effect("c-note", "local", true)],
};

const keyLines = (items: readonly { keyLine: string }[]) => items.map((it) => it.keyLine);
const forksOf = (state: UiState) => {
  const items = chatItems(state, S);
  const decor = zoomDecor(state, S, items);
  return items.flatMap((it) => (decor.forks.has(it.id) ? decor.forks.get(it.id)!.map((f) => `${it.keyLine} → ${f.branchId}${f.switchable ? "" : "（切不过去）"}`) : []));
};

describe("废弃分支（前端）", () => {
  test("⑂ 展开的预览：这条分支自己那一段，和主线同一套条目；N 段是缩小后的块数", () => {
    const state = replay(rolledBack);
    const b0 = abandonedBranch(state, S, "b0");
    expect(keyLines(b0.items)).toEqual(["你：第二句：写邮件", "回复：写好了", "你：第三句：订会议室", "回复：订好了"]);
    expect(b0.segments).toBe(4);
    // 守护进程那份还没取回：没有摘要、遗留效果
    expect(b0).toMatchObject({ loaded: false, summary: undefined, effects: [] });
    // 当前分支自己那一段是空的
    expect(abandonedBranch(state, S, "b1").items).toEqual([]);
  });

  test("手里没有那条分支的消息（刷新之后只补发了当前分支）：取回来并进去，预览、详情都有了；往上翻照旧沿当前分支", () => {
    // 刷新：最新的会话树钉在前面，补发的一页从第 8 条起
    const fresh = replay([branchEvent(7, ONE, "b0", "b1"), summary(8, "m-s1", "b1", "摘要一"), user(9, "m-7", "重新来"), agent(10, "m-8", "好")]);
    expect(abandonedBranch(fresh, S, "b0").items).toEqual([]);
    const state = replay([{ kind: "branch_view", conversation: S, view: B0_VIEW }], fresh);
    const b0 = abandonedBranch(state, S, "b0");
    expect(keyLines(b0.items)).toEqual(["你：第二句：写邮件", "回复：写好了", "你：第三句：订会议室", "回复：订好了"]);
    expect(b0.loaded).toBe(true);
    expect(b0.summary).toBe("摘要一");
    // 会话里还是只有当前分支上的
    expect(keyLines(chatItems(state, S))).toEqual(["分支摘要：摘要一", "你：重新来", "回复：好"]);
    // 往上翻：从当前分支上最早那条（第 8 条）往前，不从取回来的第 3 条那里跳过去
    expect(olderHistory(state, S)).toEqual({ canLoadOlder: true, before: 8 });
  });

  test("分支详情：遗留效果，申请撤回过的标出来；之后会话频道上来的申请也算；会话树一变取回的就作废", () => {
    const state = replay([...rolledBack, { kind: "branch_view", conversation: S, view: B0_VIEW }]);
    const requested = () => abandonedBranch(state2(), S, "b0").effects.map((e) => [e.callId, e.scope, e.undoable, e.requested ?? null]);
    let current = state;
    const state2 = () => current;
    expect(requested()).toEqual([
      ["c-send", "external", false, null],
      ["c-write", "local", true, "2026-10-18T10:05:00+08:00"],
      ["c-note", "local", true, null],
    ]);
    // 别的设备点了「申请撤回」：会话频道上来一条 effect_undo_requested
    current = replay([frame(S, 11, "effect_undo_requested", { branchId: "b0", callId: "c-note", tool: "write", summary: "x", by: "user", time: "2026-10-18T10:06:00+08:00" })], state);
    expect(requested()[2]).toEqual(["c-note", "local", true, "2026-10-18T10:06:00+08:00"]);
    // 会话树变了（切换）：取回的作废，要重新取
    current = replay([branchEvent(12, switchedTree(ONE, "b0", 12, "e-20"), "b1", "b0", "switch")], current);
    expect(abandonedBranch(current, S, "b0").loaded).toBe(false);
  });

  test("切换到 b0：会话里换成 b0 的样子，b1 变成废弃分支、挂在同一处；切回来照样；切换带进来的条目不算新到的", () => {
    const toB0 = switchedTree(ONE, "b0", 11, "e-20");
    const switched = replay([...rolledBack, branchEvent(11, toB0, "b1", "b0", "switch")]);
    expect(keyLines(chatItems(switched, S))).toEqual(["你：第一句：查天气", "回复：今天晴", "你：第二句：写邮件", "回复：写好了", "你：第三句：订会议室", "回复：订好了"]);
    expect(forksOf(switched)).toEqual(["你：第二句：写邮件 → b1"]);
    expect(keyLines(abandonedBranch(switched, S, "b1").items)).toEqual(["分支摘要：摘要一", "你：重新来", "回复：好"]);
    // 第 3~6 条是切换带进来的（序号在这次切换之前）：不播到达动效；之后新说的才是新到的
    expect(branchEpochStart(switched, S)).toBe(11);
    // 在 b0 上接着说一句，再切回 b1：b1 的样子，b0（连同刚说的那句）挂在同一处
    const back = replay([user(12, "m-9", "第四句"), branchEvent(13, switchedTree(toB0, "b1", 13, "e-30"), "b0", "b1", "switch")], switched);
    expect(keyLines(chatItems(back, S))).toEqual(["你：第一句：查天气", "回复：今天晴", "分支摘要：摘要一", "你：重新来", "回复：好"]);
    expect(forksOf(back)).toEqual(["分支摘要：摘要一 → b0"]);
    expect(keyLines(abandonedBranch(back, S, "b0").items)).toEqual(["你：第二句：写邮件", "回复：写好了", "你：第三句：订会议室", "回复：订好了", "你：第四句"]);
  });

  test("别的设备切换了分支：切过去的那条手里缺的那一段要补，补回来之后会话是它的样子、往上翻接着它翻；取回过那一段再切的、刚打开的不缺", () => {
    const toB0 = switchedTree(ONE, "b0", 11, "e-20");
    // 这台设备打开时只补发了 b1 上的（第 7 条起），别的设备切到了 b0：b0 上第 3~6 条手里没有
    const fresh = replay([branchEvent(7, ONE, "b0", "b1"), summary(8, "m-s1", "b1", "摘要一"), user(9, "m-7", "重新来"), agent(10, "m-8", "好")]);
    const switched = replay([branchEvent(11, toB0, "b1", "b0", "switch")], fresh);
    expect(branchGaps(switched)).toEqual([{ conversation: S, branch: "b0", against: "b1" }]);
    expect(chatItems(switched, S)).toEqual([]);
    // 取回 b0 和 b1 比的那一段：会话里是 b0 的样子，缺口没了；往上翻从第 3 条往前接着翻
    const filled = replay([{ kind: "branch_view", conversation: S, view: { ...B0_VIEW, against: "b1" } }], switched);
    expect(branchGaps(filled)).toEqual([]);
    expect(keyLines(chatItems(filled, S))).toEqual(["你：第二句：写邮件", "回复：写好了", "你：第三句：订会议室", "回复：订好了"]);
    expect(olderHistory(filled, S)).toEqual({ canLoadOlder: true, before: 3 });
    // 自己点的切换：切之前预览取回过 b0 和 b1 比的样子，不缺
    const previewed = replay([{ kind: "branch_view", conversation: S, view: B0_VIEW }, branchEvent(11, toB0, "b1", "b0", "switch")], fresh);
    expect(branchGaps(previewed)).toEqual([]);
    // 刚打开页面：最新的会话树钉在最前面推来，手里还没有消息，不缺（补发、往上翻本来就沿当前分支）
    expect(branchGaps(replay([branchEvent(11, toB0, "b1", "b0", "switch")]))).toEqual([]);
    // 回退不缺（新分支上的都是之后追加的）
    expect(branchGaps(replay(rolledBack))).toEqual([]);
  });

  test("分叉在这段会话之前（清空之前分出去的）：⑂ 照样标出、能预览，但切不过去", () => {
    const cleared = frame(S, 11, "message", { message: { id: "m-c", conversation: S, speaker: "system", time: TIME, parts: [{ type: "conversation_cleared" }] } });
    const state = replay([...rolledBack, cleared, user(12, "m-10", "清空之后")]);
    expect(forksOf(state)).toEqual(["分支摘要：摘要一 → b0（切不过去）"]);
    expect(forksOf(replay(rolledBack))).toEqual(["分支摘要：摘要一 → b0"]);
  });
});
