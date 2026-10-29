// 165 号票：⋮ 菜单里的"在页面里查找"——顶栏下面的查找栏在网页这一侧的状态（app/browse-find.ts）：打字停一下才交给 App 查
// （ArkWeb 的页内查找，网页里高亮），App 推回第几个、一共几个；上一个、下一个；关掉清高亮；换了网页收起。App 的原生工具是假的。
import { describe, expect, test } from "vitest";
import { BrowseFind, FIND_DEBOUNCE_MS } from "../../src/plugins/browsing/browse-find.ts";

function setup() {
  const calls: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const find = new BrowseFind({
    tools: { find: (t) => calls.push(`find ${t}`), findNext: (f) => calls.push(`next ${f}`), findClear: () => calls.push("clear"), findBar: (open) => calls.push(`bar ${open}`) },
    later(fn, ms) {
      const timer = { fn, ms, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  });
  const flush = () => {
    for (const t of timers.splice(0)) if (t.live) t.fn();
  };
  return { calls, timers, find, flush };
}

describe("查找栏", () => {
  test("打开、打字：停一下（防抖）才交给 App 查；连着打只查最后一次", () => {
    const { calls, timers, find, flush } = setup();
    let changed = 0;
    find.subscribe(() => changed++);
    find.open();
    expect(find.snapshot()).toEqual({ open: true, query: "" });
    find.setQuery("新");
    find.setQuery("新闻");
    expect(calls).toEqual(["bar true"]);
    expect(timers.at(-1)!.ms).toBe(FIND_DEBOUNCE_MS);
    flush();
    expect(calls).toEqual(["bar true", "find 新闻"]);
    expect(changed).toBeGreaterThan(0);
  });

  test("App 推回结果才有计数；换了字之前的结果作废；清空了字清掉高亮", () => {
    const { calls, find, flush } = setup();
    find.open();
    find.setQuery("新闻");
    flush();
    find.handle({ type: "find", result: { active: 0, total: 5, done: true } });
    expect(find.snapshot().result).toEqual({ active: 0, total: 5, done: true });
    find.setQuery("新闻联播");
    expect(find.snapshot().result).toBeUndefined();
    find.setQuery("");
    expect(calls.at(-1)).toBe("clear");
    flush();
    expect(calls).toEqual(["bar true", "find 新闻", "clear"]);
  });

  test("回车：还没交出去的马上查，查过了就是下一个；上一个、下一个；没字时不动", () => {
    const { calls, find } = setup();
    find.open();
    find.next();
    expect(calls).toEqual(["bar true"]);
    find.setQuery("新闻");
    find.submit();
    find.submit();
    find.prev();
    find.next();
    expect(calls).toEqual(["bar true", "find 新闻", "next true", "next false", "next true"]);
  });

  test("关掉：清高亮、等着的不查了；关着时 App 推的结果不认；换了网页收起；再打开接着上次的字查", () => {
    const { calls, find, flush } = setup();
    find.open();
    find.setQuery("新闻");
    find.close();
    flush();
    expect(calls).toEqual(["bar true", "clear", "bar false"]);
    expect(find.snapshot()).toEqual({ open: false, query: "新闻" });
    find.handle({ type: "find", result: { active: 0, total: 5, done: true } });
    expect(find.snapshot().result).toBeUndefined();
    find.open();
    flush();
    expect(calls).toEqual(["bar true", "clear", "bar false", "bar true", "find 新闻"]);
    find.pageChanged();
    expect(find.snapshot().open).toBe(false);
    find.pageChanged();
    expect(calls).toEqual(["bar true", "clear", "bar false", "bar true", "find 新闻", "clear", "bar false"]);
    // App 推的 find-close（查找栏开着时按了返回）：收起
    find.open();
    find.handle({ type: "find-close" });
    expect(find.snapshot().open).toBe(false);
  });
});
