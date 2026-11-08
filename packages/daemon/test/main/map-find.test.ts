// 主切面："在地图上看"（447）。真的守护进程走组合根和插件清单，清单里的地图插件经 extraPlugins 换成同名的、高德和 OpenStreetMap 指向
// 本机的假服务（不联网、不用真 Key）。浏览里网页上选中一段地址点"在地图上看"，网页 POST /api/map/find：
// - 没填高德的 Web 服务 Key：国内国外都问 OpenStreetMap，查到的放进能画的那一份，回编号；GET /api/map/drawing 按编号取得到（地图页就这么画）；
// - 填了 Key：带汉字的先问高德（编号 amap-p…），不带汉字的问 OpenStreetMap；
// - 没找到也是 200（ok: false 和给人看的一句）；请求体不对 400；外网端口要凭证；地图插件停用 400"地图插件没启用"；
// - 不进事件（不是秘书的对话，什么都不记）。
import { AMAP_SOURCE_ID, HTTP_PATHS } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { MAP_PLUGIN } from "../../src/map/api.ts";
import { createMapPlugin } from "../../src/map/plugin.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { startFakeAmapLookup } from "../helpers/fake-amap-lookup.ts";
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
});
