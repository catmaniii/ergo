// 会话树（150 号票）的推导：每段序号属于哪条分支、当前路径上的序号段、分叉点、回退长出的新分支、这段会话从哪开始。
import { describe, expect, it } from "vitest";
import {
  agentSessionStart,
  branchAt,
  branchForks,
  branchOwnRanges,
  type ConversationBranches,
  grownTree,
  nextBranchId,
  onBranchPath,
  pathRanges,
  rangesFrom,
  rollbackEnabled,
  rollbackFork,
  SINGLE_BRANCH,
  stageRollbackLabel,
  subtractRanges,
  switchedTree,
} from "../src/index.ts";

const INF = Number.POSITIVE_INFINITY;

/** 在 tree 上回到 cut 之前，新分支从 at 开始 */
function rollback(tree: ConversationBranches, cut: { seq: number } | { branchId: string }, at: number): ConversationBranches {
  const fork = rollbackFork(tree, cut)!;
  return grownTree(tree, { id: nextBranchId(tree), ...fork }, at, `tip-${tree.current}`);
}

const sys = (parts: Parameters<typeof agentSessionStart>[0]["parts"], extra = {}) => ({ speaker: "system" as const, parts, ...extra });

describe("会话树", () => {
  it("没回退过：都是最初那条，路径是整段，没有分叉", () => {
    expect(branchAt(SINGLE_BRANCH, 7)).toBe("b0");
    expect(pathRanges(SINGLE_BRANCH)).toEqual([{ from: 0, to: INF }]);
    expect(branchForks(SINGLE_BRANCH)).toEqual([]);
  });

  it("回到第 5 条之前：新分支从回退那一刻起，路径是 [0,5) 加上新分支；原来那条从第 5 条起是废弃分支，分叉在新分支开头", () => {
    const tree = rollback(SINGLE_BRANCH, { seq: 5 }, 11);
    expect(tree.current).toBe("b1");
    expect(tree.branches).toEqual([
      { id: "b0", start: 0, tip: "tip-b0" },
      { id: "b1", parent: "b0", cutoff: 5, start: 11 },
    ]);
    expect([3, 5, 10, 11, 12].map((s) => branchAt(tree, s))).toEqual(["b0", "b0", "b0", "b1", "b1"]);
    expect([3, 5, 10, 11, 12].map((s) => onBranchPath(tree, s))).toEqual([true, false, false, true, true]);
    expect(pathRanges(tree)).toEqual([
      { from: 0, to: 5 },
      { from: 11, to: INF },
    ]);
    expect(branchForks(tree)).toEqual([{ at: 5, branches: ["b0"] }]);
    // 原来那条自己的路径
    expect(pathRanges(tree, "b0")).toEqual([{ from: 0, to: 11 }]);
    expect(rangesFrom(pathRanges(tree), 4)).toEqual([
      { from: 4, to: 5 },
      { from: 11, to: INF },
    ]);
  });

  it("撤回到一条分支开始前：和它同一处长出来（兄弟），两条废弃分支挂在同一个分叉点", () => {
    const one = rollback(SINGLE_BRANCH, { seq: 5 }, 11);
    expect(rollbackFork(one, { branchId: "b1" })).toEqual({ parent: "b0", cutoff: 5 });
    expect(rollbackFork(one, { branchId: "b0" })).toBeUndefined();
    const two = rollback(one, { branchId: "b1" }, 20);
    expect(pathRanges(two)).toEqual([
      { from: 0, to: 5 },
      { from: 20, to: INF },
    ]);
    expect(branchForks(two)).toEqual([{ at: 5, branches: ["b0", "b1"] }]);
  });

  it("在新分支上再回到它的某条之前：路径接着它前面那段，两个分叉点各在各的边界上", () => {
    const one = rollback(SINGLE_BRANCH, { seq: 5 }, 11);
    const two = rollback(one, { seq: 14 }, 19);
    expect(two.branches.at(-1)).toMatchObject({ id: "b2", parent: "b1", cutoff: 14, start: 19 });
    expect(pathRanges(two)).toEqual([
      { from: 0, to: 5 },
      { from: 11, to: 14 },
      { from: 19, to: INF },
    ]);
    expect(branchForks(two)).toEqual([
      { at: 5, branches: ["b0"] },
      { at: 14, branches: ["b1"] },
    ]);
    // 被放弃的那段：当前路径上第 14 条起
    expect(rangesFrom(pathRanges(one), 14)).toEqual([{ from: 14, to: INF }]);
  });

  it("切回原来那条（151 号票）：它之后追加的接着属于它，路径是它自己的两段", () => {
    const one = rollback(SINGLE_BRANCH, { seq: 5 }, 11);
    const back: ConversationBranches = { ...one, current: "b0", epochs: [...one.epochs, { from: 30, branch: "b0" }] };
    expect(pathRanges(back)).toEqual([
      { from: 0, to: 11 },
      { from: 30, to: INF },
    ]);
    expect(branchForks(back)).toEqual([{ at: 5, branches: ["b1"] }]);
  });

  it("切换分支（151 号票）：当前分支换过去、原来那条记下末端；两条各自那一段对称，能再切回来", () => {
    const one = rollback(SINGLE_BRANCH, { seq: 5 }, 11);
    // b1 上又说了几句（11..29），第 30 条切回 b0
    const back = switchedTree(one, "b0", 30, "tip-b1");
    expect(back.current).toBe("b0");
    expect(back.branches.find((b) => b.id === "b1")!.tip).toBe("tip-b1");
    expect(back.epochs.at(-1)).toEqual({ from: 30, branch: "b0" });
    expect(branchForks(back)).toEqual([{ at: 5, branches: ["b1"] }]);
    // 废弃的 b1 自己那一段：长出它的那条 session_branch 起到切走之前；b0 那边是被放弃的第 5..10 条
    expect(branchOwnRanges(back, "b1")).toEqual([{ from: 11, to: 30 }]);
    expect(branchOwnRanges(one, "b0")).toEqual([{ from: 5, to: 11 }]);
    // 切过去之后别的设备要取的：新的当前分支上不在原来那条路径上的
    expect(branchOwnRanges(back, "b0", "b1")).toEqual([
      { from: 5, to: 11 },
      { from: 30, to: INF },
    ]);
    // 再切回 b1：b0 记下新的末端，b1 的路径接着它那两段
    const again = switchedTree(back, "b1", 40, "tip-b0-2");
    expect(again.branches.find((b) => b.id === "b0")!.tip).toBe("tip-b0-2");
    expect(pathRanges(again)).toEqual([
      { from: 0, to: 5 },
      { from: 11, to: 30 },
      { from: 40, to: INF },
    ]);
    expect(branchOwnRanges(again, "b0")).toEqual([
      { from: 5, to: 11 },
      { from: 30, to: 40 },
    ]);
  });

  it("序号段相减：落在里面的去掉，两头留下", () => {
    expect(subtractRanges([{ from: 0, to: 20 }], [{ from: 5, to: 8 }])).toEqual([
      { from: 0, to: 5 },
      { from: 8, to: 20 },
    ]);
    expect(subtractRanges([{ from: 0, to: 20 }], [{ from: 0, to: INF }])).toEqual([]);
    expect(subtractRanges([{ from: 10, to: INF }], [{ from: 0, to: 12 }, { from: 30, to: INF }])).toEqual([{ from: 12, to: 30 }]);
  });

  it("这段会话从哪开始：清空的分隔线、换模型的说明（有标记的、150 号票之前按文字认的）、会话分段线", () => {
    expect(agentSessionStart(sys([{ type: "conversation_cleared" }]))).toBe(true);
    expect(agentSessionStart(sys([{ type: "text", text: "已换成 DeepSeek V4 Pro 模型（思考：高），接着之前的对话。" }]))).toBe(true);
    expect(agentSessionStart(sys([{ type: "text", text: "随便一句" }], { sessionStart: true }))).toBe(true);
    expect(agentSessionStart(sys([{ type: "work_order_divider", workOrderId: "wo-1", title: "x", from: "y" }]))).toBe(true);
    expect(agentSessionStart(sys([{ type: "text", text: "没能换成 X 模型：写交接摘要时出错" }]))).toBe(false);
    expect(agentSessionStart({ speaker: "user", parts: [{ type: "text", text: "已换成 X，接着之前的对话。" }] })).toBe(false);
  });

  it("能回退的会话：秘书主会话、任务和项目维护者的会话（152 号票）；阶段开始的回退点的说法", () => {
    expect(rollbackEnabled("secretary")).toBe(true);
    expect(rollbackEnabled("maintainer:tm-1")).toBe(true);
    expect(rollbackEnabled("maintainer:pm-1")).toBe(true);
    expect(rollbackEnabled("board")).toBe(false);
    expect(stageRollbackLabel("写报告")).toBe("撤回到阶段「写报告」开始前");
  });
});
