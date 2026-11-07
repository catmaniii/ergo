// 聊天里的地图卡片（431）：GET /api/map/drawing?lookup= 拼得出、拆得回；卡片负载的 schema（四种画什么、坐标范围、上限）；
// 点开去地图页的哪里（足迹卡看那一天，别的看这张卡）；没写标题时按画的是什么起。
import { describe, expect, it } from "vitest";
import { CARD_TYPE_VERSIONS, CARD_TYPES, HTTP_PATHS, MAP_CARD_ITEM, MAP_CARD_MARKS_MAX, MapCardPayload, mapCardPath, mapCardTitle, parseHttpPath, parseMapCardPath, parseMapDayItem, schemaChecker } from "../src/index.ts";

const ok = schemaChecker(MapCardPayload);

describe("地图卡片", () => {
  it("接口：/api/map/drawing?lookup=…，拆成 map_drawing；多一截的不认", () => {
    const url = new URL(HTTP_PATHS.mapDrawing("amap-r1"), "http://x");
    expect(url.pathname).toBe("/api/map/drawing");
    expect(url.searchParams.get("lookup")).toBe("amap-r1");
    expect(parseHttpPath(url.pathname)).toEqual({ route: "map_drawing" });
    expect(parseHttpPath("/api/map/drawing/amap-r1")).toBeUndefined();
  });

  it("卡片类型 map，版本 1", () => {
    expect(CARD_TYPES).toContain("map");
    expect(CARD_TYPE_VERSIONS.map).toBe(1);
  });

  it("负载：四种画什么各认得；坐标出界、点太多、日期写法不对、路线不到两个点、多带字段的不认", () => {
    const good = [
      { show: { kind: "day", date: "2026-11-06" } },
      { title: "西湖一带", show: { kind: "points", marks: [{ id: "p1", lat: 30.25, lon: 120.14, label: "西湖" }] } },
      { show: { kind: "route", points: [{ lat: 30.27, lon: 120.15 }, { lat: 30.26, lon: 120.14 }], marks: [] } },
      { title: "从家到公司", show: { kind: "lookup", lookup: "amap-r1", what: "route", source: "amap" } },
    ];
    for (const p of good) expect(ok.firstError(p)).toBeUndefined();
    const bad = [
      { show: { kind: "day", date: "11-06" } },
      { show: { kind: "points", marks: [] } },
      { show: { kind: "points", marks: [{ id: "p1", lat: 91, lon: 0 }] } },
      { show: { kind: "points", marks: Array.from({ length: MAP_CARD_MARKS_MAX + 1 }, (_, i) => ({ id: `p${i}`, lat: 1, lon: 1 })) } },
      { show: { kind: "route", points: [{ lat: 1, lon: 1 }], marks: [] } },
      { show: { kind: "lookup", lookup: "amap-r1", what: "somewhere", source: "amap" } },
      { title: "", show: { kind: "day", date: "2026-11-06" } },
      { show: { kind: "elsewhere" } },
    ];
    for (const p of bad) expect(ok.check(p)).toBe(false);
  });

  it("点开去哪：足迹卡看那一天（#/more/map/<日期>），别的看这张卡（#/more/map/card/<编号>），拆得回", () => {
    const day = mapCardPath("c-1", { kind: "day", date: "2026-11-06" });
    expect(day).toEqual({ item: "2026-11-06" });
    expect(parseMapDayItem(day.item)).toBe("2026-11-06");
    const route = mapCardPath("c-2", { kind: "lookup", lookup: "amap-r1", what: "route", source: "amap" });
    expect(route).toEqual({ item: MAP_CARD_ITEM, sub: "c-2" });
    expect(parseMapCardPath(route.item, route.sub)).toBe("c-2");
    expect(parseMapCardPath(MAP_CARD_ITEM, undefined)).toBeUndefined();
    expect(parseMapCardPath("2026-11-06", undefined)).toBeUndefined();
  });

  it("标题：写了用它，没写按画的是什么起", () => {
    expect(mapCardTitle({ title: "昨天", show: { kind: "day", date: "2026-11-06" } })).toBe("昨天");
    expect(mapCardTitle({ show: { kind: "day", date: "2026-11-06" } })).toBe("11 月 6 日去过的地方");
    expect(mapCardTitle({ show: { kind: "points", marks: [{ id: "p1", lat: 1, lon: 1 }, { id: "p2", lat: 1, lon: 2 }] } })).toBe("标了 2 处");
    expect(mapCardTitle({ show: { kind: "route", points: [], marks: [] } })).toBe("一条路线");
    expect(["places", "route", "address"].map((what) => mapCardTitle({ show: { kind: "lookup", lookup: "x", what: what as "places", source: "amap" } }))).toEqual(["查到的地点", "查到的路线", "查到的地址"]);
  });
});
