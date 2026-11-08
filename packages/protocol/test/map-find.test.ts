// "在地图上看"（447）：POST /api/map/find 拼得出、拆得回，请求体认什么；地图页地址里"看查到的一处"（#/more/map/lookup/<编号>）
// 拼得出、拆得回，凭编号认出哪家查的、查的是什么（编号写法和守护进程 lookup-results.ts 起的一样，那边的测试也核对）。
import { describe, expect, it } from "vitest";
import { HTTP_PATHS, MAP_FIND_TEXT_MAX, MAP_LOOKUP_ITEM, MAP_PAGE_ID, MapFindBody, mapLookupPath, parseHttpPath, parseMapCardPath, parseMapLookupPath, schemaChecker } from "../src/index.ts";

describe("在地图上看", () => {
  it("接口：POST /api/map/find，拆成 map_find；多一截的不认", () => {
    expect(HTTP_PATHS.mapFind).toBe("/api/map/find");
    expect(parseHttpPath("/api/map/find")).toEqual({ route: "map_find" });
    expect(parseHttpPath("/api/map/find/x")).toBeUndefined();
  });

  it("请求体：一段 1–200 字的字，多带字段的不认", () => {
    const ok = schemaChecker(MapFindBody);
    expect(ok.check({ text: "杭州市西湖区文三路 478 号" })).toBe(true);
    expect(ok.check({ text: "" })).toBe(false);
    expect(ok.check({ text: "x".repeat(MAP_FIND_TEXT_MAX + 1) })).toBe(false);
    expect(ok.check({})).toBe(false);
  });

  it("地图页地址：#/more/map/lookup/<编号>，拆回来认出哪家查的、查的是什么；写法不对的不认，也不当成卡片", () => {
    expect(MAP_PAGE_ID).toBe("map");
    const at = mapLookupPath("amap-p3");
    expect(at).toEqual({ item: MAP_LOOKUP_ITEM, sub: "amap-p3" });
    expect(parseMapLookupPath(at.item, at.sub)).toEqual({ kind: "lookup", lookup: "amap-p3", what: "places", source: "amap" });
    expect(parseMapLookupPath("lookup", "osm-a12")).toEqual({ kind: "lookup", lookup: "osm-a12", what: "address", source: "osm" });
    expect(parseMapLookupPath("lookup", "world-map-r1")).toEqual({ kind: "lookup", lookup: "world-map-r1", what: "route", source: "world-map" });
    for (const bad of [undefined, "", "amap", "amap-x1", "Amap-p1", "amap-p", "-p1", "amap-p1/2"]) expect(parseMapLookupPath("lookup", bad)).toBeUndefined();
    expect(parseMapLookupPath("card", "amap-p3")).toBeUndefined();
    expect(parseMapCardPath(at.item, at.sub)).toBeUndefined();
  });
});
