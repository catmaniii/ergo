import { describe, expect, it } from "vitest";
import { addDays, compareTime, isZonedIso, localDate, sameLocalDay, startOfMonth, startOfWeek, startOfYear, toMs } from "../../src/domain/time.ts";

describe("时间", () => {
  it("只认带时区的 ISO 时间", () => {
    expect(isZonedIso("2026-10-01T20:10:00+08:00")).toBe(true);
    expect(isZonedIso("2026-10-01T12:10:00Z")).toBe(true);
    expect(isZonedIso("2026-10-01T12:10:00.123Z")).toBe(true);
    expect(isZonedIso("2026-10-01T20:10:00")).toBe(false);
    expect(isZonedIso("2026-10-01")).toBe(false);
    expect(isZonedIso("昨天")).toBe(false);
    expect(() => toMs("2026-10-01")).toThrow(/时区/);
  });

  it("不同时区按同一时刻比较", () => {
    expect(compareTime("2026-10-01T20:00:00+08:00", "2026-10-01T12:00:00Z")).toBe(0);
    expect(compareTime("2026-10-01T20:00:00+08:00", "2026-10-01T12:00:01Z")).toBeLessThan(0);
  });

  it("按时间自己的时区算日期、同一天", () => {
    expect(localDate("2026-10-01T00:30:00+08:00")).toBe("2026-10-01");
    expect(sameLocalDay("2026-10-05T08:00:00+08:00", "2026-10-05T23:00:00+08:00")).toBe(true);
    expect(sameLocalDay("2026-10-05T23:00:00+08:00", "2026-10-06T00:10:00+08:00")).toBe(false);
    // 第二个换到第一个的时区再比
    expect(sameLocalDay("2026-10-05T08:00:00+08:00", "2026-10-05T15:00:00Z")).toBe(true);
  });

  it("月初、年初、周一（保留时区）", () => {
    const ref = "2026-10-20T12:00:00+08:00";
    expect(startOfMonth(ref, -1)).toBe("2026-09-01T00:00:00+08:00");
    expect(startOfMonth(ref, 0)).toBe("2026-10-01T00:00:00+08:00");
    expect(startOfMonth("2026-01-15T12:00:00+08:00", -1)).toBe("2025-12-01T00:00:00+08:00");
    expect(startOfYear(ref, -1)).toBe("2025-01-01T00:00:00+08:00");
    // 2026-10-20 是周二
    expect(startOfWeek(ref, 0)).toBe("2026-10-19T00:00:00+08:00");
    expect(startOfWeek(ref, -1)).toBe("2026-10-12T00:00:00+08:00");
    expect(addDays(ref, -14)).toBe("2026-10-06T12:00:00+08:00");
  });
});
