// 地图页的二狗（444）交给秘书的那段（map/chat-note.ts）× 地图服务插槽（445）的接线：地图上下文的底图是插槽里那一家的编号，
// 这段写明"地图上用的是 X（地图服务编号 id）"，叫秘书查地点、算路线时把工具的 map 写成它（查询跟着地图走）。
// - 认得的写名字：455 起名字由登记那一家的插件给（MapProvider.modelName：amap 高德地图、osm OpenStreetMap、google 谷歌地图），
//   地图插件自己不认得任何一家；没登记的编号原样写；
// - 还没画上（loading）、不是编号的写法：不叫秘书写 map（按自动挑）；
// - 开着足迹（451 起底图也是当前地图）：和没开一样写地图上用的那一家，map 照样写成交来的编号；453 起照实写一句
//   "足迹只在他这台设备上画，不发给任何地图服务"。
import type { MapMark } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { mapChatNote } from "../../src/map/chat-note.ts";
import { MAP_TOOL } from "../../src/map/lookup-tools.ts";

const at = (basemap: string): MapMark => ({ lat: 1.2805, lon: 103.845, zoom: 16, basemap });
/** 登记了的三家给的名字（地图插件按编号问插槽，plugin.ts 的 nameOf） */
const NAMES: Readonly<Record<string, string>> = { amap: "高德地图", osm: "OpenStreetMap", google: "谷歌地图" };
const nameOf = (id: string) => NAMES[id];

describe("交给秘书的那段写明地图上用的是哪一家、map 写成它的编号", () => {
  it("认得的写名字和编号，叫秘书查询时把 map 写成这个编号", () => {
    for (const [id, name] of [
      ["amap", "高德地图"],
      ["osm", "OpenStreetMap"],
      ["google", "谷歌地图"],
    ] as const) {
      const note = mapChatNote(at(id), nameOf);
      expect(note).toContain(`地图上用的是${name}（地图服务编号 ${id}）`);
      expect(note).toContain(`把 map 写成"${id}"`);
      expect(note).toContain(MAP_TOOL.search);
      expect(note).toContain(MAP_TOOL.route);
    }
  });

  it("别家接进来的编号原样写", () => {
    const note = mapChatNote(at("worldmap"), nameOf);
    expect(note).toContain("地图上用的是worldmap（地图服务编号 worldmap）");
    expect(note).toContain('把 map 写成"worldmap"');
  });

  it("还没画上、不是编号的写法：不叫秘书写 map", () => {
    const loading = mapChatNote(at("loading"));
    expect(loading).toContain("底图还没画上");
    expect(loading).not.toContain("map 写成");
    const odd = mapChatNote(at("Some Map"));
    expect(odd).toContain("底图是Some Map");
    expect(odd).not.toContain("map 写成");
  });

  it("开着足迹（451 起底图也是当前地图）：和没开一样写地图上用的那一家，map 照样写成它；453：照实写足迹只在他这台设备上画", () => {
    const note = mapChatNote({ ...at("amap"), lat: 30.2741, lon: 120.1551, footprints: { date: "2026-11-06" } }, nameOf);
    expect(note).toContain("地图上用的是高德地图（地图服务编号 amap）");
    expect(note).toContain('把 map 写成"amap"');
    expect(note).not.toContain("OpenStreetMap");
    expect(note).toContain('"足迹"开着，看的是 2026-11-06 那一天的足迹（足迹只在他这台设备上画，不发给任何地图服务，它们只知道地图看的是哪一片）');
    expect(mapChatNote(at("amap"), nameOf)).not.toContain("只在他这台设备上画");
    // 没给名字（那一家没登记）：照原样写编号
    expect(mapChatNote(at("amap"))).toContain("地图上用的是amap（地图服务编号 amap）");
    // 手动选了 OpenStreetMap 的：照样写它
    expect(mapChatNote({ ...at("osm"), footprints: { date: "2026-11-06" } })).toContain('把 map 写成"osm"');
  });
});
