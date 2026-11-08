// 主切面："在地图上看"（447）。真的守护进程走组合根和插件清单，清单里的地图插件经 extraPlugins 换成同名的、高德和 OpenStreetMap 指向
// 本机的假服务（不联网、不用真 Key）。浏览里网页上选中一段地址点"在地图上看"，网页 POST /api/map/find：
// - 没填高德的 Web 服务 Key：国内国外都问 OpenStreetMap，查到的放进能画的那一份，回编号；GET /api/map/drawing 按编号取得到（地图页就这么画）；
// - 填了 Key：带汉字的先问高德（编号 amap-p…），不带汉字的问 OpenStreetMap；
// - 没找到也是 200（ok: false 和给人看的一句）；请求体不对 400；外网端口要凭证；地图插件停用 400"地图插件没启用"；
// - 不进事件（不是秘书的对话，什么都不记）。
// 合了 446（谷歌地图插件）以后：填了谷歌的服务端 Key，"自动"的先后里大陆外先问谷歌——不带汉字的查一处走谷歌（编号 google-p…，
// 只画在谷歌底图上），谷歌没问成（到了每日上限）退回 OpenStreetMap；带汉字的按国内挑先后，谷歌排在国内能用的后面（"自动"它只管大陆外）。
import { AMAP_SOURCE_ID, GOOGLE_MAPS_SOURCE_ID, HTTP_PATHS } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createGoogleMapsPlugin } from "../../src/google-maps/plugin.ts";
import { MAP_PLUGIN } from "../../src/map/api.ts";
import { createMapPlugin } from "../../src/map/plugin.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { startFakeAmapLookup } from "../helpers/fake-amap-lookup.ts";
import { fakeGooglePlace, GOOGLE_FAILURES, GOOGLE_TEST_SERVER_KEY, startFakeGoogleMaps } from "../helpers/fake-google-maps.ts";
import { startFakeOsmLookup } from "../helpers/fake-osm-lookup.ts";
import { AMAP_TEST_SERVICE_KEY } from "../helpers/fake-map.ts";
import { dataSourcesApi, mapApi, pluginsApi, request } from "../helpers/http.ts";

let n = 0;
const key = () => `t447-${++n}`;

describe("在地图上看：POST /api/map/find（假高德、假 OpenStreetMap 走真实装配路径）", () => {
  it("查一处回编号、按编号取得到；填了高德 Key 带汉字的先问高德；没找到 200 带原因；坏请求 400、外网 401、插件停用 400；不进事件", { timeout: 90_000 }, async () => {
    const amap = await startFakeAmapLookup();
    const osm = await startFakeOsmLookup();
    const td = await startTestDaemon({ extraPlugins: [createMapPlugin({ amapHosts: amap.hosts, osmHosts: osm.hosts, osmIntervalMs: 0, timeoutMs: 5000 })] });
    const eventsBefore = td.daemon.store.readGlobal(0, 1_000_000).length;

    // 没填高德的 Key：问 OpenStreetMap
    const sg = await mapApi.find(td.url, { text: "Marina Bay Sands" });
    expect(sg.status).toBe(200);
    expect(sg.body).toMatchObject({ ok: true, source: "osm", kind: "places", title: "Marina Bay Sands" });
    if (!sg.body.ok) throw new Error("没查到");
    const drawing = await mapApi.drawing(td.url, sg.body.lookup);
    expect(drawing.status).toBe(200);
    expect(drawing.body).toMatchObject({ id: sg.body.lookup, kind: "places", source: "osm", title: "Marina Bay Sands" });
    expect(drawing.body.marks).toHaveLength(1);
    expect(Math.abs(drawing.body.marks[0]!.lat - 1.2834)).toBeLessThan(0.001);
    expect(amap.requests).toEqual([]);

    // 填了高德的 Web 服务 Key：带汉字的先问高德
    const configured = await dataSourcesApi.act(td.url, AMAP_SOURCE_ID, { action: "configure", values: { serviceKey: AMAP_TEST_SERVICE_KEY }, idempotencyKey: key() });
    expect(configured.status).toBe(200);
    const cn = await mapApi.find(td.url, { text: "示例湿地公园" });
    expect(cn.body).toMatchObject({ ok: true, source: "amap", kind: "places" });
    if (!cn.body.ok) throw new Error("没查到");
    expect(cn.body.lookup).toMatch(/^amap-p\d+$/);
    expect(amap.requests.some((r) => r.path === "/v5/place/text" && r.query.get("keywords") === "示例湿地公园")).toBe(true);

    // 都没找到：200，给人看的一句
    amap.state.replies["/v5/place/text"] = { status: "1", info: "OK", infocode: "10000", count: "0", pois: [] };
    amap.state.replies["/v3/geocode/geo"] = { status: "1", info: "OK", infocode: "10000", count: "0", geocodes: [] };
    const none = await mapApi.find(td.url, { text: "没有这个地方的示例名字" });
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ ok: false, reason: "地图上没找到「没有这个地方的示例名字」：选得具体些（带上城市、区）再试" });

    // 请求体不对、外网端口没凭证
    expect((await mapApi.find(td.url, { text: "" })).status).toBe(400);
    expect((await mapApi.find(td.url, { words: "西湖" })).status).toBe(400);
    expect((await request(td.externalUrl, HTTP_PATHS.mapFind, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "西湖" }) })).status).toBe(401);

    // 不是秘书的对话：什么事件都不记（填 Key 那一步记的除外）
    const added = td.daemon.store.readGlobal(eventsBefore, 1_000_000).map((e) => e.type);
    expect(added.filter((t) => !t.startsWith("data_source"))).toEqual([]);

    // 地图插件停用：400"地图插件没启用"
    expect((await pluginsApi.act(td.url, MAP_PLUGIN, { action: "disable", idempotencyKey: key() })).status).toBe(200);
    const off = await mapApi.find(td.url, { text: "西湖" });
    expect(off.status).toBe(400);
    expect(off.body.message).toBe("地图插件没启用");
  });

  it("填了谷歌的服务端 Key：不带汉字的先问谷歌、编号 google-p…；谷歌到每日上限退回 OpenStreetMap；带汉字的先问国内能用的（假谷歌）", { timeout: 90_000 }, async () => {
    const osm = await startFakeOsmLookup();
    const google = await startFakeGoogleMaps();
    const td = await startTestDaemon({ extraPlugins: [createMapPlugin({ osmHosts: osm.hosts, osmIntervalMs: 0, timeoutMs: 5000 }), createGoogleMapsPlugin({ hosts: google.hosts, timeoutMs: 5000 })] });

    // 只填服务端用的那个（先测再存：假谷歌上三个 API 各问一次）
    const filled = await dataSourcesApi.act(td.url, GOOGLE_MAPS_SOURCE_ID, { action: "configure", values: { serverKey: GOOGLE_TEST_SERVER_KEY }, idempotencyKey: key() });
    expect(filled.status).toBe(200);
    expect((await mapApi.config(td.url)).body.providers?.find((p) => p.id === "google")).toMatchObject({ lookup: true });
    google.state.replies["/v1/places:searchText"] = { places: [fakeGooglePlace("ChIJfake-mbs", "Marina Bay Sands", 1.2834, 103.8607, { short: "10 Bayfront Ave" })] };
    const askedBefore = google.requests.length;

    // 不带汉字：先问谷歌，查到就停，OpenStreetMap 一次没问
    const sg = await mapApi.find(td.url, { text: "Marina Bay Sands" });
    expect(sg.status).toBe(200);
    expect(sg.body).toMatchObject({ ok: true, source: "google", kind: "places", title: "Marina Bay Sands" });
    if (!sg.body.ok) throw new Error("没查到");
    expect(sg.body.lookup).toMatch(/^google-p\d+$/);
    const asked = google.requests.slice(askedBefore);
    expect(asked.map((r) => r.path)).toEqual(["/v1/places:searchText"]);
    expect(asked[0]!.body?.textQuery).toBe("Marina Bay Sands");
    expect(osm.requests).toEqual([]);
    // 地图页按编号取得到：谷歌查的（网页只画在谷歌底图上）
    const drawing = await mapApi.drawing(td.url, sg.body.lookup);
    expect(drawing.status).toBe(200);
    expect(drawing.body).toMatchObject({ id: sg.body.lookup, kind: "places", source: "google", title: "Marina Bay Sands" });
    expect(Math.abs(drawing.body.marks[0]!.lat - 1.2834)).toBeLessThan(0.001);
    // Key 不进结果
    expect(JSON.stringify(sg.body) + JSON.stringify(drawing.body)).not.toContain(GOOGLE_TEST_SERVER_KEY);

    // 谷歌到了每日上限：这一家没问成，退回 OpenStreetMap 查到
    google.state.fail = { api: "places", failure: GOOGLE_FAILURES.quota };
    const fallback = await mapApi.find(td.url, { text: "Marina Bay Sands" });
    expect(fallback.body).toMatchObject({ ok: true, source: "osm", kind: "places" });
    expect(osm.requests.length).toBeGreaterThan(0);
    google.state.fail = undefined;

    // 带汉字（没有手机的位置）：按国内挑先后，谷歌"自动"只管大陆外、排在国内能用的后面——OpenStreetMap 先问、找到了就不问谷歌
    const googleBefore = google.requests.length;
    const cn = await mapApi.find(td.url, { text: "滨海湾金沙" });
    expect(cn.body).toMatchObject({ ok: true, source: "osm", title: "滨海湾金沙" });
    expect(google.requests).toHaveLength(googleBefore);
  });
});
