// "下一次"的时间（282 号票，util/time.ts 的 nextTimeLabel）：提醒卡、看板、任务详情上的"下一次 / 下次"，在今年的照旧写月-日，
// 不在今年的带上年份；所有重复种类一样（每年的提醒、12 月建的每月提醒落到明年 1 月）。"现在"由调用方给，测试不看真时钟。
import { describe, expect, test } from "vitest";
import { nextTimeLabel, timeLabel } from "../../src/util/time.ts";

/** 本地时间 2026 年 m 月 d 日 */
const now = (m: number, d: number) => new Date(2026, m - 1, d, 12, 0).getTime();

describe("下一次的时间", () => {
  test("在今年的照旧：10-26 09:00", () => {
    expect(nextTimeLabel("2026-10-26T09:00:00.000+08:00", now(10, 25))).toBe("10-26 09:00");
    expect(nextTimeLabel("2026-10-26T09:00:00.000+08:00", now(10, 25))).toBe(timeLabel("2026-10-26T09:00:00.000+08:00"));
  });

  test("不在今年的带上年份：每年的提醒今年过了是明年那天；12 月建的每月提醒落到明年 1 月", () => {
    expect(nextTimeLabel("2027-10-25T09:00:00.000+08:00", now(10, 25))).toBe("2027-10-25 09:00");
    expect(nextTimeLabel("2027-01-08T09:00:00.000+08:00", now(12, 20))).toBe("2027-01-08 09:00");
  });

  test("认不出的原样给出", () => {
    expect(nextTimeLabel("不是时间", now(10, 25))).toBe("不是时间");
  });
});
