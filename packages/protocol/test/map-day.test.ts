// 地图上的"我的足迹"（430）的日期和地址：GET /api/map/day?date= 拼得出、拆得回；日期认真的（2 月 30 日不算）；
// 地图页地址里的日期和"纬度,经度"分得开；日期前后挪按日历算。
import { describe, expect, it } from "vitest";
import { HTTP_PATHS, isMapDate, mapDateProblem, mapDayItem, parseHttpPath, parseMapDayItem, parseMapFocusItem, shiftMapDate } from "../src/index.ts";

describe("我的足迹的日期和地址", () => {
  it("接口：/api/map/day?date=…，拆成 map_day；多一截、少一截的不认", () => {
    const url = new URL(HTTP_PATHS.mapDay("2026-11-06"), "http://x");
    expect(url.pathname).toBe("/api/map/day");
    expect(url.searchParams.get("date")).toBe("2026-11-06");
    expect(parseHttpPath(url.pathname)).toEqual({ route: "map_day" });
    expect(parseHttpPath("/api/map/day/2026-11-06")).toBeUndefined();
    expect(parseHttpPath("/api/map/config")).toEqual({ route: "map_config" });
  });

  it("日期：YYYY-MM-DD、月和日在范围里（闰年 2 月 29 日算）；不对的给一句话", () => {
    expect(["2026-11-06", "2024-02-29", "2026-12-31"].map(isMapDate)).toEqual([true, true, true]);
    expect(["2026-11-6", "2026-02-29", "2026-13-01", "2026-00-10", "2026-11-00", "../../x", "", "2026-11-06T00:00"].map(isMapDate)).toEqual(Array(8).fill(false));
    expect(mapDateProblem("2026-11-06")).toBeUndefined();
    expect(mapDateProblem("tomorrow")).toBe("日期要写成 YYYY-MM-DD（年-月-日），收到的是「tomorrow」");
  });

  it("地图页地址里的日期：拼了拆得回，和\"纬度,经度\"分得开", () => {
    expect(parseMapDayItem(mapDayItem("2026-11-06"))).toBe("2026-11-06");
    expect(parseMapDayItem("30.25,120.13,14")).toBeUndefined();
    expect(parseMapDayItem(undefined)).toBeUndefined();
    expect(parseMapFocusItem(mapDayItem("2026-11-06"))).toBeUndefined();
  });

  it("前后挪几天：跨月、跨年、闰年按日历算", () => {
    expect(shiftMapDate("2026-11-06", -1)).toBe("2026-11-05");
    expect(shiftMapDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftMapDate("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftMapDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftMapDate("2026-11-06", 0)).toBe("2026-11-06");
  });
});
