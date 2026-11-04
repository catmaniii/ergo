// 整理之前同步一遍的等法和记法（memory/nightly-sync.ts 的 syncBeforeNightly）：内核那一半换成假的（交回编好的几样），时钟手动拨，查：
// - 同步完的记新增几条、刚同步过的、连接出错的（原因）、这次出错的（原因）、交回时就不能同步了的（RequestRejected 的话）各记一样；
// - 一起开始、等到同一个上限：上限之前完的记同步完，到了上限还没完的记没同步上（timeout），不等它；
// - 中止马上不等、抛 AbortError；内核那一半自己出错只记日志、交回 undefined（整理照常）。
import { describe, expect, it } from "vitest";
import type { PullableSync } from "../../src/data-sources/index.ts";
import { RequestRejected } from "../../src/errors.ts";
import { consolidationText } from "../../src/memory/curator-tools.ts";
import type { MemoryNightlyRecord } from "../../src/memory/nightly-record.ts";
import { NIGHTLY_SYNC_FRESH_MS, NIGHTLY_SYNC_WAIT_MS, syncBeforeNightly } from "../../src/memory/nightly-sync.ts";
import type { DataSourcePreSync } from "../../src/plugins/kernel.ts";
import { ManualClock } from "../helpers/clock.ts";

const START = new Date("2026-10-08T03:00:00+08:00");

/** 内核那一半：交回编好的几样，记下问它时的 freshMs */
function preSync(pulled: readonly PullableSync[], asked: number[] = []): DataSourcePreSync {
  return {
    syncPullable: ({ freshMs }) => {
      asked.push(freshMs);
      return Promise.resolve(pulled);
    },
  };
}

/** 一个还没完的同步：交回放行它的函数 */
function pending(): { done: Promise<{ added?: number; error?: string }>; finish: (result: { added?: number; error?: string }) => void } {
  let finish!: (result: { added?: number; error?: string }) => void;
  const done = new Promise<{ added?: number; error?: string }>((resolve) => (finish = resolve));
  return { done, finish };
}

/** 等到 syncBeforeNightly 把上限挂上（它先等内核那一半交回） */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("整理之前同步一遍（syncBeforeNightly）", () => {
  it("各样的结局都记下：同步完、刚同步过、连接出错、这次出错、不能同步了", async () => {
    const clock = new ManualClock(START);
    const asked: number[] = [];
    const logs: string[] = [];
    const result = await syncBeforeNightly({
      sync: preSync(
        [
          { id: "looki", title: "Looki", state: "started", done: Promise.resolve({ added: 5 }) },
          { id: "google-calendar", title: "Google · 日历", state: "fresh", at: "2026-10-08T02:55:00.000+08:00" },
          { id: "gmail", title: "Google · Gmail", state: "broken", problem: "登录没通过" },
          { id: "camera", title: "示例相机", state: "started", done: Promise.resolve({ error: "那边忙" }) },
          { id: "gone", title: "停了的", state: "started", done: Promise.reject(new RequestRejected("not_allowed", "停了的插件没启用")) },
        ],
        asked,
      ),
      clock,
      signal: new AbortController().signal,
      log: (line) => logs.push(line),
    });
    expect(asked).toEqual([NIGHTLY_SYNC_FRESH_MS]);
    expect(result).toEqual({
      waitMinutes: NIGHTLY_SYNC_WAIT_MS / 60_000,
      sources: [
        { id: "looki", title: "Looki", state: "synced", added: 5 },
        { id: "google-calendar", title: "Google · 日历", state: "fresh" },
        { id: "gmail", title: "Google · Gmail", state: "broken", reason: "登录没通过" },
        { id: "camera", title: "示例相机", state: "failed", reason: "那边忙" },
        { id: "gone", title: "停了的", state: "failed", reason: "停了的插件没启用" },
      ],
    });
    expect(logs.at(-1)).toContain("looki synced +5");
  });

  it("到了上限还没完的不等了，记没同步上；上限之前完的照常记", async () => {
    const clock = new ManualClock(START);
    const slow = pending();
    const quick = pending();
    let finished = false;
    const running = syncBeforeNightly({
      sync: preSync([
        { id: "slow", title: "慢的", state: "started", done: slow.done },
        { id: "quick", title: "快的", state: "started", done: quick.done },
      ]),
      clock,
      signal: new AbortController().signal,
      log: () => {},
    }).finally(() => (finished = true));
    await settle();
    // 2 分钟时快的完了，还在等慢的
    clock.advance(2 * 60_000);
    quick.finish({ added: 1 });
    await settle();
    expect(finished).toBe(false);
    // 到 3 分钟：不等了
    clock.advance(NIGHTLY_SYNC_WAIT_MS - 2 * 60_000);
    expect(await running).toEqual({
      waitMinutes: 3,
      sources: [
        { id: "slow", title: "慢的", state: "timeout" },
        { id: "quick", title: "快的", state: "synced", added: 1 },
      ],
    });
    // 慢的之后才完：不影响已经交回的
    slow.finish({ added: 9 });
  });

  it("中止马上不等，抛 AbortError；内核那一半出错交回 undefined", async () => {
    const clock = new ManualClock(START);
    const stuck = pending();
    const controller = new AbortController();
    const running = syncBeforeNightly({ sync: preSync([{ id: "slow", title: "慢的", state: "started", done: stuck.done }]), clock, signal: controller.signal, log: () => {} });
    await settle();
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });

    // 已经中止了：不问内核那一半
    const asked: number[] = [];
    await expect(syncBeforeNightly({ sync: preSync([], asked), clock, signal: controller.signal, log: () => {} })).rejects.toMatchObject({ name: "AbortError" });
    expect(asked).toEqual([]);

    const logs: string[] = [];
    const broken: DataSourcePreSync = { syncPullable: () => Promise.reject(new Error("数据源的服务坏了")) };
    expect(await syncBeforeNightly({ sync: broken, clock, signal: new AbortController().signal, log: (line) => logs.push(line) })).toBeUndefined();
    expect(logs.join("\n")).toContain("数据源的服务坏了");
  });

  it("没有要同步的：交回空的", async () => {
    const result = await syncBeforeNightly({ sync: preSync([]), clock: new ManualClock(START), signal: new AbortController().signal, waitMs: 60_000, log: () => {} });
    expect(result).toEqual({ waitMinutes: 1, sources: [] });
  });

  it("交给记忆管理员的整理结果里照实说同步了哪几个、哪个没同步上；没同步的不说", () => {
    const ran: MemoryNightlyRecord = {
      night: "2026-10-08",
      at: "2026-10-08T03:10:00.000+08:00",
      state: "ran",
      trigger: "scheduled",
      deferrals: 0,
      newClaims: 1,
      changedClaims: 0,
      reviewed: 0,
      needsReview: 0,
      questions: { added: 0, resolved: 0, obsolete: 0, expired: 0, skipped: 0, retired: 0, open: 0 },
      modelCalls: 3,
      budgetExhausted: false,
      processedEvidence: 2,
      pendingEvidence: 0,
    };
    expect(consolidationText(ran)).not.toContain("同步");
    const said = consolidationText({
      ...ran,
      sourceSync: {
        waitMinutes: 3,
        sources: [
          { id: "looki", title: "Looki", state: "synced", added: 5 },
          { id: "google-calendar", title: "Google · 日历", state: "fresh" },
          { id: "camera", title: "示例相机", state: "timeout" },
          { id: "gmail", title: "Google · Gmail", state: "broken", reason: "登录没通过" },
        ],
      },
    });
    expect(said).toContain(
      "整理之前先同步了数据源：同步了 Looki 新增 5 条；Google · 日历 刚同步过；没同步上：示例相机（等了 3 分钟没同步完，导进来的下一次整理读）、Google · Gmail（连接出错：登录没通过，每小时自动再试）。",
    );
  });
});
