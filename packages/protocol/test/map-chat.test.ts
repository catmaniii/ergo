// 地图页的二狗（444）：聊天窗、悬浮按钮发的消息带的地图上下文——发消息的请求帧认它（只认认得的形状：坐标在范围里、日期是 YYYY-MM-DD、
// 底图名字不长），记在消息上时坐标留 6 位小数、只取认得的字段；会话里的小字"在地图上说"、悬浮按钮上的"打字 / 说"，中英都有。
import { describe, expect, test } from "vitest";
import { activeLocaleFrom, type MapContext, mapLabel, mapMarkOf, parseRequest, setActiveLocale } from "../src/index.ts";
import { TEST_LOCALES } from "./setup-locales.ts";

const send = (map: unknown) => parseRequest(JSON.stringify({ id: "r1", method: "send_message", params: { conversation: "secretary", parts: [{ type: "text", text: "这附近有什么" }], map }, idempotencyKey: "k1" }));

describe("地图页发的消息带的地图上下文", () => {
  test("发消息的请求帧带着它：认得的形状才收", () => {
    const ok: MapContext = { lat: 30.2596, lon: 120.1434, zoom: 14, basemap: "amap", footprints: { date: "2026-11-07", spot: "公司" }, card: { id: "c-1", title: "从家到公司" }, via: "button", spoken: true };
    expect(send(ok)).toMatchObject({ ok: true, request: { params: { map: ok } } });
    expect(send({ lat: 30, lon: 120, zoom: 3, basemap: "osm" }).ok).toBe(true);
    expect(send({ lat: 30, lon: 120, zoom: 3, basemap: "osm", card: { id: "c-1", count: 2 } }).ok).toBe(true);
    // 坐标出范围、级别不对、日期不是 YYYY-MM-DD、底图没写或太长、via 不认得：都不收
    for (const bad of [
      { lat: 91, lon: 120, zoom: 3, basemap: "osm" },
      { lat: 30, lon: 181, zoom: 3, basemap: "osm" },
      { lat: 30, lon: 120, zoom: 30, basemap: "osm" },
      { lat: 30, lon: 120, zoom: 3 },
      { lat: 30, lon: 120, zoom: 3, basemap: "x".repeat(33) },
      { lat: 30, lon: 120, zoom: 3, basemap: "osm", footprints: { date: "昨天" } },
      { lat: 30, lon: 120, zoom: 3, basemap: "osm", via: "sidebar" },
      { lat: 30, lon: 120, zoom: 3, basemap: "osm", card: { id: "c-1", count: 1 } },
      { lat: 30, lon: 120, zoom: 3, basemap: "osm", card: { id: "c-1", count: 2.5 } },
    ]) {
      expect(send(bad).ok).toBe(false);
    }
  });

  test("记在消息上：坐标留 6 位小数、级别 2 位，只取认得的字段；不是从悬浮按钮发的不记 spoken", () => {
    expect(mapMarkOf({ lat: 30.259612345, lon: 120.143398765, zoom: 14.33333, basemap: "amap", footprints: { date: "2026-11-07" }, extra: 1 } as MapContext)).toEqual({
      lat: 30.259612,
      lon: 120.143399,
      zoom: 14.33,
      basemap: "amap",
      footprints: { date: "2026-11-07" },
    });
    expect(mapMarkOf({ lat: 1, lon: 2, zoom: 3, basemap: "osm", spoken: true })).toEqual({ lat: 1, lon: 2, zoom: 3, basemap: "osm" });
    expect(mapMarkOf({ lat: 1, lon: 2, zoom: 3, basemap: "osm", via: "button", spoken: true, card: { id: "c-9" } })).toEqual({ lat: 1, lon: 2, zoom: 3, basemap: "osm", card: { id: "c-9" }, via: "button", spoken: true });
    // 461：地图上叠着几张二狗画的（2 张以上才写）照记
    expect(mapMarkOf({ lat: 1, lon: 2, zoom: 3, basemap: "osm", card: { id: "c-9", title: "地铁站", count: 3 } })).toEqual({ lat: 1, lon: 2, zoom: 3, basemap: "osm", card: { id: "c-9", title: "地铁站", count: 3 } });
  });

  test("会话里的小字：聊天窗里说的、悬浮按钮上打字 / 说的，中英", () => {
    expect(mapLabel({})).toBe("在地图上说");
    expect(mapLabel({ via: "button" })).toBe("在地图上用悬浮按钮打字");
    expect(mapLabel({ via: "button", spoken: true })).toBe("在地图上用悬浮按钮说");
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    try {
      expect(mapLabel({})).toBe("Said on the map");
      expect(mapLabel({ via: "button", spoken: true })).toBe("Said with the floating button on the map");
    } finally {
      setActiveLocale(activeLocaleFrom(TEST_LOCALES, "zh-CN"));
    }
  });
});
