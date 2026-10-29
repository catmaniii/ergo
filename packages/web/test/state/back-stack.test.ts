// 返回栈（62 号票，系统返回键）：鸿蒙 App 里按系统返回键，网页按层级退一级——
// 先关最后打开的那个弹窗、选择器、详情页（overlay），没有再回这一页的上一级（page：标题栏的"‹ 返回"），
// 都没有就是到了顶层，交给系统退出 App。
import { describe, expect, test } from "vitest";
import { type BackLayer, type BackStack, backTarget, canGoBack, closeBackLayer, openBackLayer, overlayOpen } from "../../src/state/index.ts";

type Op = ["open", BackLayer] | ["close", number];

const overlay = (id: number): BackLayer => ({ id, kind: "overlay" });
const page = (id: number): BackLayer => ({ id, kind: "page" });

function run(ops: Op[]): BackStack {
  let stack: BackStack = [];
  for (const [op, arg] of ops) stack = op === "open" ? openBackLayer(stack, arg) : closeBackLayer(stack, arg);
  return stack;
}

describe("按返回键先退哪一层", () => {
  test.each<[string, Op[], number | undefined]>([
    ["什么都没开（顶层，比如秘书页、看板）：交给系统", [], undefined],
    ["任务详情（标题栏有返回）：回看板", [["open", page(1)]], 1],
    ["任务详情上开了工具调用详情：先关详情", [["open", page(1)], ["open", overlay(2)]], 2],
    ["弹窗比页面后挂上也一样先关弹窗", [["open", overlay(2)], ["open", page(1)]], 2],
    ["弹窗上又开了一个弹窗：先关后开的", [["open", overlay(1)], ["open", overlay(2)]], 2],
    ["后开的弹窗关了：再按关先开的", [["open", overlay(1)], ["open", overlay(2)], ["close", 2]], 1],
    ["弹窗都关了：回上一级", [["open", page(1)], ["open", overlay(2)], ["close", 2]], 1],
    ["两个页面都有返回（比如维护者会话叠在项目页上）：退后挂上的", [["open", page(1)], ["open", page(2)]], 2],
    ["页面离开了（回到顶层）：交给系统", [["open", page(1)], ["close", 1]], undefined],
    ["同一层又挂一次：挪到最上面，不重复", [["open", overlay(1)], ["open", overlay(2)], ["open", overlay(1)]], 1],
    ["关一个没挂过的：不变", [["open", page(1)], ["close", 9]], 1],
  ])("%s", (_name, ops, expected) => {
    const stack = run(ops);
    expect(backTarget(stack)?.id).toBe(expected);
    expect(canGoBack(stack)).toBe(expected !== undefined);
  });
});

describe("挂上、拿下", () => {
  test("同一层挂两次只算一层：拿下一次就没了", () => {
    const stack = run([["open", overlay(1)], ["open", overlay(1)], ["close", 1]]);
    expect(stack).toEqual([]);
  });

  test("开着弹窗、详情这些 overlay 吗（116 号票：开着就不在回到前台时直接刷新）：只有 page 的不算", () => {
    expect(overlayOpen(run([]))).toBe(false);
    expect(overlayOpen(run([["open", page(1)]]))).toBe(false);
    expect(overlayOpen(run([["open", page(1)], ["open", overlay(2)]]))).toBe(true);
    expect(overlayOpen(run([["open", overlay(2)], ["close", 2]]))).toBe(false);
  });

  test("不改原来的栈（纯函数）", () => {
    const before = run([["open", page(1)]]);
    openBackLayer(before, overlay(2));
    closeBackLayer(before, 1);
    expect(before).toEqual([page(1)]);
  });
});
