// "在地图上看"（447，lookup-tools.ts 的 findPlace、service.ts 的 mapFindProblem）：浏览里网页上选中的一段地址、地名不经秘书直接查一处。
// 接本机的假高德、假 OpenStreetMap（和查地点工具的测试同一套）：
// - 带汉字的先问高德、先搜地点：查到的第一处放进能画的那一份（WGS-84、标题是查的那段字），交回编号（amap-p…）；
// - 高德没搜到再当地址做地理编码（种类 address）；
// - 不带汉字的先问 OpenStreetMap（滨海湾金沙）；
// - 都没找到、最该问的那家没问成（超额、Key 不对、连不上）的结果，接口给人看的那一句；
// - 手机最近的位置只用来挑先问谁，不发出去；结果标题太长截掉。
import { describe, expect, it } from "vitest";
import path from "node:path";
import { createDataSourceSecrets } from "../../src/data-sources/index.ts";
import { AMAP_SECRET } from "../../src/amap/amap.ts";
import { createAmapLookup } from "../../src/amap/amap-lookup.ts";
import { amapUsageFile, openAmapUsage } from "../../src/amap/amap-usage.ts";
import { createLookupResults } from "../../src/map/lookup-results.ts";
import { findPlace, type MyPlaces } from "../../src/map/lookup-tools.ts";
import { createOsmLookup } from "../../src/openstreetmap/osm-lookup.ts";
import { mapFindProblem } from "../../src/map/service.ts";
import { MAP_USER_AGENT } from "../../src/openstreetmap/service.ts";
import { startFakeAmapLookup } from "../helpers/fake-amap-lookup.ts";
import { startFakeOsmLookup } from "../helpers/fake-osm-lookup.ts";
import { AMAP_TEST_SERVICE_KEY } from "../helpers/fake-map.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const NOW = new Date("2026-11-07T09:00:00+08:00").getTime();
const HERE = { lat: 30.2801, lon: 120.1302, at: "2026-11-07T08:42:00+08:00", acc: 15 };

async function setup(options: { amap?: boolean } = {}) {
  const fake = await startFakeAmapLookup();
  const osmFake = await startFakeOsmLookup();
  const osm = createOsmLookup({ hosts: osmFake.hosts, userAgent: MAP_USER_AGENT, now: () => NOW, minIntervalMs: 0, timeoutMs: 5000, log: () => {} });
  const dir = makeTempDir("ergo-447-find-");
  const secrets = createDataSourceSecrets({ dir: path.join(dir, "secrets"), log: () => {} }).forSource("amap");
  secrets.set(AMAP_SECRET.serviceKey, AMAP_TEST_SERVICE_KEY);
  const usage = openAmapUsage({ file: amapUsageFile(path.join(dir, "map")), now: () => NOW, log: () => {} });
  const lookup = createAmapLookup({ hosts: fake.hosts, timeoutMs: 5000, secrets: () => secrets, usage, log: () => {} });
  const results = createLookupResults({ now: () => NOW });
  const phone: MyPlaces = { named: () => [], latest: () => HERE };
  const deps = { providers: () => (options.amap === false ? [osm] : [lookup, osm]), myPlaces: () => phone, results, now: () => NOW };
  return { fake, osmFake, results, find: (text: string) => findPlace(deps, text) };
}

describe("在地图上看：直接查一处", () => {
  it("带汉字的先问高德、先搜地点：第一处放进能画的那一份（标题是查的那段字），交回编号；手机的位置不发出去", async () => {
    const { fake, osmFake, results, find } = await setup();
    const out = await find("  示例湿地\n公园 ");
    expect(out).toMatchObject({ found: true, source: "amap", kind: "places", title: "示例湿地 公园" });
    if (!out.found) throw new Error("没找到");
    expect(out.lookup).toMatch(/^amap-p\d+$/);
    expect(fake.requests.map((r) => r.path)).toEqual(["/v5/place/text"]);
    expect(fake.requests[0]!.query.get("keywords")).toBe("示例湿地 公园");
    expect(fake.requests[0]!.query.get("location")).toBeNull();
    expect(osmFake.requests).toEqual([]);
    const drawing = results.get(out.lookup)!;
    expect(drawing).toMatchObject({ kind: "places", source: "amap", title: "示例湿地 公园", lines: [] });
    expect(drawing.marks).toHaveLength(1);
    expect(drawing.marks[0]).toMatchObject({ id: "hit-1", label: "示例湿地公园", kind: "search" });
    // 高德回的是 GCJ-02，放进来的是 WGS-84（往西北偏几百米）
    expect(Math.abs(drawing.marks[0]!.lat - 30.272)).toBeLessThan(0.01);
    expect(drawing.marks[0]!.lon).toBeLessThan(120.068);
  });

  it("高德没搜到地点：当地址做地理编码（种类 address）", async () => {
    const { fake, find } = await setup();
    fake.state.replies["/v5/place/text"] = { status: "1", info: "OK", infocode: "10000", count: "0", pois: [] };
    const out = await find("浙江省杭州市西湖区示例路478号");
    expect(out).toMatchObject({ found: true, source: "amap", kind: "address" });
    expect(fake.requests.map((r) => r.path)).toEqual(["/v5/place/text", "/v3/geocode/geo"]);
  });

  it("不带汉字的先问 OpenStreetMap；没有高德时国内也问它", async () => {
    const { fake, osmFake, find } = await setup();
    const out = await find("Marina Bay Sands");
    expect(out).toMatchObject({ found: true, source: "osm", kind: "places" });
    expect(osmFake.requests.map((r) => r.path)).toEqual(["/search"]);
    expect(fake.requests).toEqual([]);
    const only = await setup({ amap: false });
    expect(await only.find("西湖")).toMatchObject({ found: true, source: "osm" });
  });

  it("都没找到：什么都不带；最该问的那家没问成（超额）带上是哪家、什么错", async () => {
    const { fake, osmFake, find } = await setup();
    fake.state.replies["/v5/place/text"] = { status: "1", info: "OK", infocode: "10000", count: "0", pois: [] };
    fake.state.replies["/v3/geocode/geo"] = { status: "1", info: "OK", infocode: "10000", count: "0", geocodes: [] };
    expect(await find("没有这个地方的示例名字")).toEqual({ found: false });
    fake.state.replies = {};
    fake.state.fail = { infocode: "10044", info: "USER_DAILY_QUERY_OVER_LIMIT" };
    osmFake.state.fail = { status: 503 };
    expect(await find("示例湿地公园")).toEqual({ found: false, provider: "amap", failure: "quota", detail: "USER_DAILY_QUERY_OVER_LIMIT" });
  });

  it("空的、没有地图服务时：没找到（不发请求）", async () => {
    const { fake, find } = await setup();
    expect(await find("   ")).toEqual({ found: false });
    expect(fake.requests).toEqual([]);
    const results = createLookupResults({ now: () => NOW });
    expect(await findPlace({ providers: () => [], myPlaces: () => undefined, results, now: () => NOW }, "西湖")).toEqual({ found: false });
  });

  it("标题太长截到 60 字", async () => {
    const { find } = await setup();
    const out = await find(`示例湿地公园${"东".repeat(80)}`);
    expect(out.found && out.title.length).toBe(60);
    expect(out.found && out.title.endsWith("…")).toBe(true);
  });
});

/** 地图服务的名字（接口照它写那一句） */
const titleOf = (id: string) => (id === "amap" ? "高德地图" : id);

describe("没查到时给人看的那一句", () => {
  it("只是没找到、超额、连不上、Key 不对、别的错各有说法", () => {
    expect(mapFindProblem({}, " 杭州   某个地方 ", titleOf)).toBe("地图上没找到「杭州 某个地方」：选得具体些（带上城市、区）再试");
    expect(mapFindProblem({ provider: "amap", failure: "quota", detail: "x" }, "a", titleOf)).toBe("高德地图说查得太多了，过一会儿再试");
    expect(mapFindProblem({ provider: "amap", failure: "network", detail: "x" }, "a", titleOf)).toBe("连不上高德地图，过一会儿再试");
    expect(mapFindProblem({ provider: "amap", failure: "key", detail: "x" }, "a", titleOf)).toBe("高德地图的 Key 现在用不了：到 设置 · 数据源 里看看");
    expect(mapFindProblem({ provider: "worldmap", failure: "params", detail: "bad" }, "a", titleOf)).toBe("worldmap没查成（bad）");
  });
});
