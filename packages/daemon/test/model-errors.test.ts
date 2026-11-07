// 模型出错（421）的三件纯逻辑，用假的钟、内存里的账本钉死边界：
// - 太久没回应的计时（runtime/silence-watch.ts，子进程包 pi 发调用的函数时用）：90 秒一个字都没回来才叫；每回一段就重新计时，
//   持续慢慢输出超过 90 秒不叫；"开始"不算回了字；调用结束了不再叫；
// - 出错原文的种类（服务商忙 / 太久没回应 / 出错）和最后没成时的说法；
// - 账本：出错、被中止的那次照样记，但 ⚙ 的上下文用量取最近一次成了的（以前没记成败、输入是 0 的也不算）。
import path from "node:path";
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { clipModelError, modelErrorKind, modelFailedReason } from "../src/conversation/model-errors.ts";
import { openEventStore } from "../src/events/event-store.ts";
import { installBuiltinLocales } from "../src/i18n/index.ts";
import { createTokenLedger, ledgerView } from "../src/ledger/index.ts";
import { silentCallError } from "../src/runtime/index.ts";
import { watchForSilence } from "../src/runtime/silence-watch.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

const NINETY = 90_000;

describe("太久没回应的计时（假的钟）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("发出去 90 秒一个字都没回来才叫，只叫一次；89 秒时还不叫", () => {
    const onSilent = vi.fn<() => void>();
    const watch = watchForSilence(NINETY, onSilent);
    vi.advanceTimersByTime(NINETY - 1000);
    expect(onSilent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onSilent).toHaveBeenCalledTimes(1);
    expect(watch.fired).toBe(true);
    // 叫过之后再来事件也不再计
    watch.heard("text_delta");
    vi.advanceTimersByTime(NINETY * 2);
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  test("流式持续输出超过 90 秒：每回一段（正文、思考、工具调用参数）就重新计时，不叫；停住 90 秒才叫", () => {
    const onSilent = vi.fn<() => void>();
    const watch = watchForSilence(NINETY, onSilent);
    // 第 60 秒才回第一个字（思考），之后每 30 秒回一段，一共输出了 5 分钟
    vi.advanceTimersByTime(60_000);
    watch.heard("thinking_start");
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(30_000);
      watch.heard(i % 3 === 0 ? "thinking_delta" : i % 3 === 1 ? "text_delta" : "toolcall_delta");
    }
    expect(onSilent).not.toHaveBeenCalled();
    // 输出到一半停住了：从最后一段起 90 秒才叫
    vi.advanceTimersByTime(NINETY - 1);
    expect(onSilent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  test("\"开始\"不算回了字（有的服务商发请求之前就报它）；调用结束了（stop）不再叫", () => {
    const onSilent = vi.fn<() => void>();
    const watch = watchForSilence(NINETY, onSilent);
    vi.advanceTimersByTime(50_000);
    watch.heard("start");
    vi.advanceTimersByTime(40_000);
    expect(onSilent).toHaveBeenCalledTimes(1);

    const quiet = vi.fn<() => void>();
    const done = watchForSilence(NINETY, quiet);
    vi.advanceTimersByTime(10_000);
    done.stop();
    vi.advanceTimersByTime(NINETY * 3);
    expect(quiet).not.toHaveBeenCalled();
    expect(done.fired).toBe(false);
  });

  test("交给 pi 的出错原文带 timed out（pi 当成能重试的），二狗按\"太久没回应\"认它", () => {
    const error = silentCallError(NINETY);
    expect(error).toMatch(/90 seconds/);
    expect(error).toMatch(/timed out/);
    expect(modelErrorKind(error)).toBe("timeout");
  });
});

describe("出错的种类和最后没成时的说法", () => {
  afterEach(() => installBuiltinLocales());

  test("服务商忙：503、429、overloaded、限流；太久没回应：timeout；别的（500、连不上）是出错", () => {
    expect(modelErrorKind("503 Service Unavailable")).toBe("busy");
    expect(modelErrorKind("429 Too Many Requests: rate limit reached")).toBe("busy");
    expect(modelErrorKind('{"error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe("busy");
    expect(modelErrorKind("Server is busy, please try again later")).toBe("busy");
    expect(modelErrorKind("Request timed out.")).toBe("timeout");
    expect(modelErrorKind("500 Internal Server Error")).toBe("error");
    expect(modelErrorKind("fetch failed: connection refused")).toBe("error");
  });

  test("原文截短成一行；最后没成时写清是服务商那边、可以等一会儿再问或在设置 · 模型里换模型（中英）", () => {
    expect(clipModelError(`500\n  Internal   Server Error ${"x".repeat(400)}`)).toMatch(/^500 Internal Server Error x+…$/);
    expect(clipModelError("a".repeat(400)).length).toBe(161);
    const zh = modelFailedReason("503 Service Unavailable", 3);
    expect(zh).toBe("模型服务商那边忙，自动重试了 3 次还是没成（503 Service Unavailable）。可以等一会儿再问，或者在设置 · 模型里换一个模型");
    expect(modelFailedReason(silentCallError(NINETY), 1)).toMatch(/^模型一直没有回应，自动重试了 1 次还是没成/);
    expect(modelFailedReason("500 Internal Server Error", 2)).toMatch(/^模型服务出错，自动重试了 2 次还是没成（500 Internal Server Error）。服务商那边可能忙或出了问题/);
    expect(zh).not.toMatch(/秘书/);
    installBuiltinLocales("en");
    expect(modelFailedReason("503 Service Unavailable", 1)).toBe(
      "The model provider is busy; retried 1 time and it still failed (503 Service Unavailable). Wait a bit and ask again, or switch to another model in Settings · Models",
    );
    expect(modelFailedReason("503 Service Unavailable", 3)).toMatch(/retried 3 times/);
  });
});

/** 内存里的账本（临时目录里的事件库），usage 记一次秘书干活的调用（failed 时是出错、被中止的那次） */
function setup() {
  const store = openEventStore({ file: path.join(makeTempDir("ergo-ledger-failed-"), "ergo.db"), views: [ledgerView] });
  onTestFinished(() => store.close());
  const ledger = createTokenLedger({ store, now: () => "2026-11-07T15:36:00.000+08:00", currentStage: () => undefined, prices: () => ({ currency: "CNY", models: {} }), holidays: () => [], log: () => undefined });
  const usage = (input: number, cacheRead: number, output: number, failed?: true) =>
    ledger.record({
      agentId: "secretary",
      sessionId: "s-1",
      model: "deepseek/deepseek-flash",
      attribution: { owner: null, role: "secretary" },
      report: { type: "usage", messageId: `m-${input}-${cacheRead}`, provider: "deepseek", modelId: "deepseek-flash", input, cacheRead, cacheWrite: 0, output, totalTokens: input + cacheRead + output, ...(failed ? { failed } : {}) },
    });
  return { ledger, usage };
}

describe("账本：出错、被中止的那次照样记，⚙ 取最近一次成了的", () => {
  test("最后两次出错、被中止（用量 0）：照样记两条；取成了的那一次是之前那 93 万", () => {
    const { ledger, usage } = setup();
    usage(20_000, 910_000, 1500);
    usage(0, 0, 0, true);
    usage(0, 0, 0, true);
    expect(ledger.entries().map((e) => e.failed ?? false)).toEqual([false, true, true]);
    expect(ledger.lastOf("secretary", ["work"])?.tokens).toEqual({ cacheHit: 0, cacheMiss: 0, output: 0 });
    expect(ledger.lastOf("secretary", ["work"], 0, { succeeded: true })?.tokens).toEqual({ cacheHit: 910_000, cacheMiss: 20_000, output: 1500 });
  });

  test("出错但用量不是 0 的（输出到一半被中止）也不算；以前没记成败、输入是 0 的也不算；一次都没成过是 undefined", () => {
    const { ledger, usage } = setup();
    expect(ledger.lastOf("secretary", ["work"], 0, { succeeded: true })).toBeUndefined();
    usage(5000, 100_000, 200);
    usage(6000, 101_000, 50, true);
    // 以前的版本出错时记的：没有 failed，输入是 0
    usage(0, 0, 0);
    expect(ledger.lastOf("secretary", ["work"], 0, { succeeded: true })?.tokens).toEqual({ cacheHit: 100_000, cacheMiss: 5000, output: 200 });
  });
});
