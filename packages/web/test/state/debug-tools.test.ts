// 设置里的"关于二狗"和 Debug 工具集（124 号票）在状态层的那一半：
// - 连点版本号 8 次打开 Debug 工具集（两次之间超过 2 秒重新数，第 4 次起提示还差几次），打开后 1 小时有效、能"现在收起"；
// - 页面日志、通知记录只留最近的几条；console 的参数怎么写成一行字；
// - 连接断开的原因、本机存储列出来的样子（敏感的不显示值、太长的截短）、已运行多久的写法。
import { describe, expect, test } from "vitest";
import {
  appendCapped,
  closeReasonText,
  DEBUG_LOCKED,
  DEBUG_OPEN_MS,
  type DebugUnlock,
  debugMinutesLeft,
  debugOpen,
  debugTap,
  logText,
  NOTIFY_LOG_MAX,
  PAGE_LOG_MAX,
  pageLogText,
  storageRows,
  uptimeText,
} from "../../src/state/index.ts";

/** 从 start 起按给的间隔（毫秒）连点，回每一次的提示和最后的样子 */
function taps(gaps: readonly number[], from: DebugUnlock = DEBUG_LOCKED, start = 1_000_000) {
  let state = from;
  let at = start;
  const hints: (string | undefined)[] = [];
  for (const gap of gaps) {
    at += gap;
    const next = debugTap(state, at);
    state = next.state;
    hints.push(next.hint);
  }
  return { state, hints, at };
}

describe("连点版本号打开 Debug 工具集", () => {
  test("连点 8 次：前 3 次不出声，第 4 次起提示还差几次，第 8 次打开、1 小时内有效", () => {
    const { state, hints, at } = taps([0, 300, 300, 300, 300, 300, 300, 300]);
    expect(hints).toEqual([undefined, undefined, undefined, "再点 4 次打开 Debug 工具集", "再点 3 次打开 Debug 工具集", "再点 2 次打开 Debug 工具集", "再点 1 次打开 Debug 工具集", "Debug 工具集已打开，1 小时内有效"]);
    expect(debugOpen(state, at)).toBe(true);
    expect(debugMinutesLeft(state, at)).toBe(60);
  });

  test("两次之间超过 2 秒就重新数：这一下算第 1 次", () => {
    const slow = taps([0, 300, 300, 300, 2_001, 300, 300, 300]);
    expect(slow.hints).toEqual([undefined, undefined, undefined, "再点 4 次打开 Debug 工具集", undefined, undefined, undefined, "再点 4 次打开 Debug 工具集"]);
    expect(debugOpen(slow.state, slow.at)).toBe(false);
    // 正好 2 秒还算连着
    const edge = taps([0, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000]);
    expect(debugOpen(edge.state, edge.at)).toBe(true);
  });

  test("已经打开时再点：提示已经打开了，不重新计时", () => {
    const opened = taps([0, 100, 100, 100, 100, 100, 100, 100]);
    const again = debugTap(opened.state, opened.at + 10 * 60_000);
    expect(again.hint).toBe("Debug 工具集已经打开了");
    expect(debugMinutesLeft(again.state, opened.at + 10 * 60_000)).toBe(50);
  });

  test("1 小时到期：入口没了；还剩几分钟往上取整；到期后再连点 8 次又能打开", () => {
    const opened = taps([0, 100, 100, 100, 100, 100, 100, 100]);
    expect(debugMinutesLeft(opened.state, opened.at + DEBUG_OPEN_MS - 61_000)).toBe(2);
    expect(debugMinutesLeft(opened.state, opened.at + DEBUG_OPEN_MS - 1)).toBe(1);
    expect(debugOpen(opened.state, opened.at + DEBUG_OPEN_MS - 1)).toBe(true);
    expect(debugOpen(opened.state, opened.at + DEBUG_OPEN_MS)).toBe(false);
    expect(debugMinutesLeft(opened.state, opened.at + DEBUG_OPEN_MS)).toBe(0);
    const later = opened.at + DEBUG_OPEN_MS + 5_000;
    const first = debugTap(opened.state, later);
    expect(first.hint).toBeUndefined();
    const reopened = taps([100, 100, 100, 100, 100, 100, 100], first.state, later);
    expect(reopened.hints.at(-1)).toBe("Debug 工具集已打开，1 小时内有效");
    expect(debugOpen(reopened.state, reopened.at)).toBe(true);
  });

  test("没打开过：不算打开、剩 0 分钟", () => {
    expect(debugOpen(DEBUG_LOCKED, 0)).toBe(false);
    expect(debugMinutesLeft(DEBUG_LOCKED, 0)).toBe(0);
  });
});

describe("只留最近的几条", () => {
  test("新的排在最后；超过上限从最早的丢", () => {
    let list: readonly number[] = [];
    for (let i = 1; i <= 5; i++) list = appendCapped(list, i, 3);
    expect(list).toEqual([3, 4, 5]);
    expect(PAGE_LOG_MAX).toBe(200);
    expect(NOTIFY_LOG_MAX).toBe(20);
  });
});

describe("页面日志", () => {
  test("console 的参数写成一行字：字符串原样、出错带堆栈、对象写成 JSON、写不成 JSON 的退回 String；太长的截短", () => {
    const err = new TypeError("x is undefined");
    err.stack = "TypeError: x is undefined\n    at f (index.html:1:2)";
    expect(logText(["加载失败", 404, err])).toBe("加载失败 404 TypeError: x is undefined\n    at f (index.html:1:2)");
    expect(logText([{ code: "bad", n: 1 }])).toBe('{"code":"bad","n":1}');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(logText([loop])).toBe("[object Object]");
    expect(logText([undefined, null])).toBe("undefined null");
    expect(logText(["长".repeat(5000)]).length).toBeLessThanOrEqual(4001);
  });

  test("复制出去的文字：每条一行头（时间、来源）再接内容", () => {
    const text = pageLogText([
      { at: "2026-10-14T21:03:05.120+08:00", source: "console.error", text: "连接失败" },
      { at: "2026-10-14T21:03:06.000+08:00", source: "unhandledrejection", text: "Error: boom\n    at x" },
    ]);
    expect(text).toBe("21:03:05 console.error 连接失败\n21:03:06 unhandledrejection Error: boom\n    at x");
  });
});

describe("连接断开的原因", () => {
  test.each<[number | undefined, string | undefined, string]>([
    [1000, undefined, "1000 正常关闭"],
    [1006, "", "1006 异常断开（没收到关闭帧：网断了、守护进程停了、隧道断了）"],
    [4401, "这台设备的凭证已失效", "4401 这台设备的凭证失效了：这台设备的凭证已失效"],
    [1012, undefined, "1012 守护进程在重启"],
    [3999, "x", "3999：x"],
    [undefined, undefined, "不知道（浏览器没给关闭码）"],
  ])("关闭码 %s、原因 %s → %s", (code, reason, text) => {
    expect(closeReasonText(code, reason)).toBe(text);
  });
});

describe("本机存储", () => {
  test("只列二狗记的键（ergo 开头），按键排好；太长的截短，敏感的（凭证、草稿）只写有", () => {
    const rows = storageRows("localStorage", [
      ["ergo-theme", "dark"],
      ["other-site", "x"],
      ["ergo-device-credential", "secret-token"],
      ["ergo-board-folded", "x".repeat(200)],
    ]);
    expect(rows).toEqual([
      { area: "localStorage", key: "ergo-board-folded", value: `${"x".repeat(79)}…`, masked: false },
      { area: "localStorage", key: "ergo-device-credential", value: "有", masked: true },
      { area: "localStorage", key: "ergo-theme", value: "dark", masked: false },
    ]);
    expect(storageRows("sessionStorage", [["ergo.reload_drafts", '{"secretary":"我想说的话"}']])).toEqual([{ area: "sessionStorage", key: "ergo.reload_drafts", value: "有", masked: true }]);
  });
});

describe("已运行多久", () => {
  test.each<[number, string]>([
    [20_000, "不到 1 分钟"],
    [5 * 60_000 + 59_000, "5 分钟"],
    [3 * 3_600_000 + 12 * 60_000, "3 小时 12 分钟"],
    [26 * 3_600_000, "1 天 2 小时"],
    [-5_000, "不到 1 分钟"],
  ])("%s 毫秒 → %s", (ms, text) => {
    expect(uptimeText(ms)).toBe(text);
  });
});
