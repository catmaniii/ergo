// 二狗按压缩点自动压缩（420，conversation/auto-compact.ts）的判法：每轮结束时要不要压、压完怎么记、没压成之后多久再试（不连环重试）。
// 会话里真的压、真的不重试的走主切面（test/main/auto-compact.test.ts）。
import { describe, expect, it } from "vitest";
import { AUTO_COMPACT_NOTHING_WAIT_MS, AUTO_COMPACT_RETRY_BASE_MS, AUTO_COMPACT_RETRY_MAX_MS, afterAutoCompact, autoCompactDue, autoCompactRetryMs, type AutoCompactState } from "../src/conversation/auto-compact.ts";

const NOW = 1_800_000_000_000;
const ISO = "2027-01-15T16:00:00.000+08:00";
const fresh = (): AutoCompactState => ({ failures: 0 });

describe("这一轮结束了，要不要压", () => {
  it("用量超过压缩点才压；没超过、正好等于、还不知道用量（刚换了子进程、刚压过）都不压", () => {
    expect(autoCompactDue(fresh(), 750_000, 700_000, NOW)).toBe(true);
    expect(autoCompactDue(fresh(), 650_000, 700_000, NOW)).toBe(false);
    expect(autoCompactDue(fresh(), 700_000, 700_000, NOW)).toBe(false);
    expect(autoCompactDue(fresh(), undefined, 700_000, NOW)).toBe(false);
  });

  it("没压成之后等着再试的时间里不压，过了这个时间（到了某一轮结束）再压", () => {
    const failed = afterAutoCompact(fresh(), { outcome: "failed", by: "ergo", message: "500" }, NOW, ISO);
    expect(autoCompactDue(failed, 930_000, 700_000, NOW + 1_000)).toBe(false);
    expect(autoCompactDue(failed, 930_000, 700_000, NOW + AUTO_COMPACT_RETRY_BASE_MS - 1)).toBe(false);
    expect(autoCompactDue(failed, 930_000, 700_000, NOW + AUTO_COMPACT_RETRY_BASE_MS)).toBe(true);
  });
});

describe("压完怎么记", () => {
  it("没压成：记下结果和原因，连续第 n 次之后等 15 分钟 × 2^(n-1)，最多 2 小时", () => {
    expect([1, 2, 3, 4, 5, 9].map(autoCompactRetryMs)).toEqual([15, 30, 60, 120, 120, 120].map((m) => m * 60_000));
    expect(autoCompactRetryMs(20)).toBe(AUTO_COMPACT_RETRY_MAX_MS);
    let state = afterAutoCompact(fresh(), { outcome: "failed", by: "ergo", message: "服务商忙（500）" }, NOW, ISO);
    expect(state).toEqual({ last: { outcome: "failed", by: "ergo", at: ISO, message: "服务商忙（500）" }, failures: 1, retryAt: NOW + 15 * 60_000 });
    state = afterAutoCompact(state, { outcome: "failed", by: "ergo" }, NOW + 1, ISO);
    expect(state).toMatchObject({ failures: 2, retryAt: NOW + 1 + 30 * 60_000 });
  });

  it("压好了：清零、不再等；pi 自己起的也记（by: pi），它没压成同样算一次失败", () => {
    const failed = afterAutoCompact(fresh(), { outcome: "failed", by: "pi", message: "overflow" }, NOW, ISO);
    expect(failed).toMatchObject({ last: { by: "pi", outcome: "failed" }, failures: 1 });
    expect(afterAutoCompact(failed, { outcome: "done", by: "ergo", tokensBefore: 930_000 }, NOW, ISO)).toEqual({ last: { outcome: "done", by: "ergo", at: ISO, tokensBefore: 930_000 }, failures: 0 });
  });

  it("没什么可压的：不算失败，但等一会儿再看（免得每轮都白问一次）；被中止：不记失败，原来要等的照旧", () => {
    expect(afterAutoCompact(fresh(), { outcome: "nothing", by: "ergo" }, NOW, ISO)).toMatchObject({ failures: 0, retryAt: NOW + AUTO_COMPACT_NOTHING_WAIT_MS });
    const failed = afterAutoCompact(fresh(), { outcome: "failed", by: "ergo" }, NOW, ISO);
    expect(afterAutoCompact(failed, { outcome: "aborted", by: "ergo" }, NOW + 5, ISO)).toMatchObject({ failures: 1, retryAt: failed.retryAt, last: { outcome: "aborted" } });
    expect(afterAutoCompact(fresh(), { outcome: "aborted", by: "ergo" }, NOW, ISO)).not.toHaveProperty("retryAt");
  });
});
