// App 和网页之间的名字：网页挂给 App 调的函数撤的时候只撤还是自己的那个；侧边栏模式的地址参数；地址栏历史里记的来处。
import { describe, expect, test } from "vitest";
import { appObject, exposeToApp } from "../../src/app/app-names.ts";
import { cameFrom, type HistoryEnv } from "../../src/app/history-nav.ts";
import { isSideMode } from "../../src/app/side-mode.ts";

/** 假的地址栏历史：当前这条记录的 state */
const historyAt = (state: unknown): HistoryEnv => ({ location: { hash: "#/tasks/t-1", replace: () => {} }, history: { state, back: () => {}, replaceState: () => {} } });

describe("App 和网页之间的名字", () => {
  test("App 挂的对象按名字取，没有是 undefined", () => {
    expect(appObject({ ergoSide: 2 }, "ergoSide")).toBe(2);
    expect(appObject({}, "ergoSide")).toBeUndefined();
  });

  test("网页挂给 App 调的函数：撤的时候只撤还是自己的那个", () => {
    const scope: Record<string, unknown> = {};
    const off = exposeToApp(scope, "__ergoSide", "a");
    expect(scope).toEqual({ __ergoSide: "a" });
    scope.__ergoSide = "b";
    off();
    expect(scope).toEqual({ __ergoSide: "b" });
    const again = exposeToApp(scope, "__ergoSide", "c");
    again();
    expect(scope).toEqual({});
  });
});

describe("别的名字", () => {
  test("侧边栏模式：?ergo=side", () => {
    expect(isSideMode("?ergo=side")).toBe(true);
    expect(isSideMode("?a=1&ergo=side")).toBe(true);
    expect(isSideMode("?ergo=main")).toBe(false);
    expect(isSideMode("")).toBe(false);
  });

  test("地址栏历史里记的来处", () => {
    expect(cameFrom(historyAt({ ergoFrom: "#/inbox" }))).toBe("#/inbox");
    expect(cameFrom(historyAt({}))).toBeUndefined();
    expect(cameFrom(historyAt(null))).toBeUndefined();
  });
});
