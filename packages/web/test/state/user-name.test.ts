// 前端状态层：我的名字（249 号票）。用户自己的名字不走事件：打开页面时经 GET /api/user-name 取回、设置里改完用 PUT 回的那个，
// 都进状态层的 userName。界面上用它的是秘书页、待办页的副标题——**没设就完全保持现状**（一个字都不多）。
import { describe, expect, test } from "vitest";
import { initialUiState, inboxPageSub, reduce, secretaryPageSub, type UiInput, type UiState, userNameOf } from "../../src/state/index.ts";

/** 把几样输入依次喂给状态层 */
const replay = (inputs: readonly UiInput[]): UiState => inputs.reduce(reduce, initialUiState);

const named = (name: string | undefined): UiInput => ({ kind: "user_name", name });

describe("我的名字：取回来、改了、清了", () => {
  test("没取过、没设都是 undefined（界面上照旧）", () => {
    expect(initialUiState.userName).toBeUndefined();
    expect(userNameOf(initialUiState)).toBeUndefined();
  });

  test("取回来、设置里改了：状态里是那个名字；清除了回到没设", () => {
    expect(userNameOf(replay([named("小明")]))).toBe("小明");
    expect(userNameOf(replay([named("小明"), named(undefined)]))).toBeUndefined();
  });

  test("只有空白当成没设（不会在标题里多出两个空格）", () => {
    expect(userNameOf(replay([named("   ")]))).toBeUndefined();
  });
});

describe("秘书页的副标题（标题那一带）：设了用名字，没设照旧", () => {
  test("没设：宽屏写\"主线会话\"，窄屏没有副标题（和以前一样）", () => {
    expect(secretaryPageSub(replay([]), true)).toBe("主线会话");
    expect(secretaryPageSub(replay([]), false)).toBeUndefined();
  });

  test("设了：宽窄屏都是\"<名字>的主线会话\"", () => {
    const state = replay([named("小明")]);
    expect(secretaryPageSub(state, true)).toBe("小明的主线会话");
    expect(secretaryPageSub(state, false)).toBe("小明的主线会话");
  });
});

describe("待办页的副标题：设了用名字，没设照旧（没有副标题）", () => {
  test("没设：没有副标题", () => {
    expect(inboxPageSub(replay([]))).toBeUndefined();
  });

  test("设了：\"<名字>的待办\"", () => {
    expect(inboxPageSub(replay([named("小明")]))).toBe("小明的待办");
  });
});
