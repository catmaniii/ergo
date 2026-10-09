// 返回栈在页面上的那一半（62 号票）：弹窗、选择器、标题栏的"返回"各自挂上一层，带着自己的关法；
// 按返回键时运行该退的那一层的关法。先退哪一层由状态层定（test/state/back-stack.test.ts）。
import { describe, expect, test } from "vitest";
import { createBackRegistry } from "../../src/app/back-registry.ts";

describe("按返回键", () => {
  test("什么都没挂：不做事，告诉调用方交给系统", () => {
    const back = createBackRegistry();
    expect(back.canGoBack()).toBe(false);
    expect(back.back()).toBe(false);
  });

  test("弹窗开在有返回的页面上：先关弹窗，页面不动", () => {
    const back = createBackRegistry();
    const done: string[] = [];
    back.open("page", () => done.push("回看板"));
    back.open("overlay", () => done.push("关弹窗"));
    expect(back.back()).toBe(true);
    expect(done).toEqual(["关弹窗"]);
  });

  test("弹窗关了（拿下了）：再按回上一级", () => {
    const back = createBackRegistry();
    const done: string[] = [];
    back.open("page", () => done.push("回看板"));
    const closeSheet = back.open("overlay", () => done.push("关弹窗"));
    closeSheet();
    expect(back.back()).toBe(true);
    expect(done).toEqual(["回看板"]);
  });

  test("拿下两次不出错", () => {
    const back = createBackRegistry();
    const close = back.open("overlay", () => {});
    close();
    expect(() => close()).not.toThrow();
    expect(back.canGoBack()).toBe(false);
  });
});

describe("能不能返回变了就通知", () => {
  test("挂上、拿下都通知；退订之后不再通知", () => {
    const back = createBackRegistry();
    const seen: boolean[] = [];
    const off = back.subscribe(() => seen.push(back.canGoBack()));
    const close = back.open("page", () => {});
    close();
    off();
    back.open("overlay", () => {});
    expect(seen).toEqual([true, false]);
  });
});
