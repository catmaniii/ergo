// 页面日志（124 号票：Debug 工具集）：页面一打开就开始收 console.error / console.warn、没接住的错误、没接住的 Promise 拒绝，
// 留最近 200 条，能清空；原来的 console 照常输出。console、window 换成假的。
import { describe, expect, test } from "vitest";
import { collectPageLog, createListStore } from "../../src/app/page-log.ts";
import type { PageLogEntry } from "../../src/state/index.ts";

/** 假的页面：console 记下原样输出了什么，window 能发 error / unhandledrejection */
function fakePage() {
  const printed: string[] = [];
  const listeners: Record<string, ((ev: unknown) => void)[]> = {};
  const scope = {
    console: {
      error: (...args: unknown[]) => void printed.push(`error ${args.join(" ")}`),
      warn: (...args: unknown[]) => void printed.push(`warn ${args.join(" ")}`),
    },
    addEventListener: (type: string, listener: (ev: unknown) => void) => void (listeners[type] ??= []).push(listener),
    removeEventListener: (type: string, listener: (ev: unknown) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener);
    },
  };
  return { scope, printed, emit: (type: string, ev: unknown) => listeners[type]?.forEach((l) => l(ev)), listenerCount: () => Object.values(listeners).flat().length };
}

const NOW = "2026-10-14T21:03:05.000+08:00";
const brief = (entries: readonly PageLogEntry[]) => entries.map((e) => `${e.source}: ${e.text}`);

describe("页面日志", () => {
  test("console.error / console.warn 记下来，原来的照常输出", () => {
    const page = fakePage();
    const store = createListStore<PageLogEntry>(200);
    collectPageLog(page.scope, store, () => NOW);
    page.scope.console.error("连接失败", 404);
    page.scope.console.warn("慢了");
    expect(brief(store.list())).toEqual(["console.error: 连接失败 404", "console.warn: 慢了"]);
    expect(store.list()[0]!.at).toBe(NOW);
    expect(page.printed).toEqual(["error 连接失败 404", "warn 慢了"]);
  });

  test("没接住的错误（带堆栈的、只有一句话和位置的）、没接住的 Promise 拒绝", () => {
    const page = fakePage();
    const store = createListStore<PageLogEntry>(200);
    collectPageLog(page.scope, store, () => NOW);
    const err = new TypeError("x is undefined");
    err.stack = "TypeError: x is undefined\n    at f (index.html:1:2)";
    page.emit("error", { message: "Uncaught TypeError: x is undefined", error: err });
    page.emit("error", { message: "Script error.", filename: "index.html", lineno: 3, colno: 7 });
    page.emit("unhandledrejection", { reason: new Error("boom") });
    page.emit("unhandledrejection", { reason: "没有原因的字符串" });
    expect(brief(store.list()).map((l) => l.split("\n")[0])).toEqual([
      "error: TypeError: x is undefined",
      "error: Script error.（index.html:3:7）",
      "unhandledrejection: Error: boom",
      "unhandledrejection: 没有原因的字符串",
    ]);
  });

  test("只留最近的几条；能清空；订阅的知道变了", () => {
    const page = fakePage();
    const store = createListStore<PageLogEntry>(3);
    let changes = 0;
    store.subscribe(() => {
      changes += 1;
    });
    collectPageLog(page.scope, store, () => NOW);
    for (let i = 1; i <= 5; i++) page.scope.console.warn(`第 ${i} 条`);
    expect(brief(store.list())).toEqual(["console.warn: 第 3 条", "console.warn: 第 4 条", "console.warn: 第 5 条"]);
    store.clear();
    expect(store.list()).toEqual([]);
    expect(changes).toBe(6);
  });

  test("订阅的在通知时又往 console 里写：不再记一遍（不会绕圈）", () => {
    const page = fakePage();
    const store = createListStore<PageLogEntry>(200);
    store.subscribe(() => page.scope.console.error("画的时候出错了"));
    collectPageLog(page.scope, store, () => NOW);
    page.scope.console.error("第一条");
    expect(brief(store.list())).toEqual(["console.error: 第一条"]);
    expect(page.printed).toEqual(["error 画的时候出错了", "error 第一条"]);
  });

  test("停下：console 换回原来的，不再听 window 的事件", () => {
    const page = fakePage();
    const original = page.scope.console.error;
    const store = createListStore<PageLogEntry>(200);
    const stop = collectPageLog(page.scope, store, () => NOW);
    expect(page.scope.console.error).not.toBe(original);
    stop();
    expect(page.scope.console.error).toBe(original);
    expect(page.listenerCount()).toBe(0);
  });
});
