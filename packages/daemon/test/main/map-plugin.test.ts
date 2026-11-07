// 主切面：地图插件（429）。真的守护进程走组合根和插件清单，清单里的地图插件经 extraPlugins 换成同名的、
// 瓦片和高德指向本机的假服务（helpers/fake-map.ts；不连真的 OSM、高德，不联网）：
// - /tiles/osm/<z>/<x>/<y> 经网关转发：带二狗的 User-Agent、存进缓存区；地址不对 404；外网端口没凭证 401；
// - GET /api/map/config：没填 Key 时是空的（页面国内也先用 OpenStreetMap）；填了 Key 和安全密钥只给 Web 端的 Key；
// - /_AMapService/… 拼上安全密钥转给高德、回应原样交回；
// - 安全密钥、Web 服务 Key 不出现在页面、接口的回包、日志、事件里；
// - 插件运行中停用：接口、瓦片、代理都回"地图插件没启用"。
import fs from "node:fs";
import path from "node:path";
import { AMAP_SOURCE_ID } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { MAP_PLUGIN } from "../../src/map/api.ts";
import { createMapPlugin } from "../../src/map/plugin.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { AMAP_TEST_JS_KEY, AMAP_TEST_SECURITY_CODE, AMAP_TEST_SERVICE_KEY, startFakeAmap, startFakeOsm, TINY_PNG } from "../helpers/fake-map.ts";
import { dataSourcesApi, mapApi, pluginsApi, request } from "../helpers/http.ts";

let n = 0;
const key = () => `map-${++n}`;

describe("地图插件（假瓦片、假高德走真实装配路径）", () => {
  it("瓦片转发、填 Key、高德代理；安全密钥不进页面、回包、日志、事件；停用后写没启用", { timeout: 60_000 }, async () => {
    const osm = await startFakeOsm();
    const amap = await startFakeAmap();
    const logs: string[] = [];
    const td = await startTestDaemon({ extraPlugins: [createMapPlugin({ osmUpstream: osm.url, amapHosts: amap.hosts, timeoutMs: 5000 })], log: (line) => logs.push(line) });
    expect(td.daemon.plugins.report().running).toContain(MAP_PLUGIN);

    // 瓦片经网关转发、进缓存区
    const tile = await request(td.url, "/tiles/osm/2/1/1");
    expect(tile.status).toBe(200);
    expect(tile.headers["content-type"]).toBe("image/png");
    expect(tile.headers["x-content-type-options"]).toBe("nosniff");
    expect(tile.headers["cache-control"]).toMatch(/^private, max-age=\d+$/);
    expect(tile.body.equals(TINY_PNG)).toBe(true);
    expect(osm.requests.map((r) => r.url)).toEqual(["/2/1/1.png"]);
    expect(osm.requests[0]!.headers["user-agent"]).toMatch(/^ergo\//);
    expect(fs.existsSync(path.join(dataDirLayout(td.dataDir).mapTiles, "osm", "2", "1", "1.png"))).toBe(true);
    expect((await request(td.url, "/tiles/osm/2/1/1.png")).status).toBe(200);
    expect(osm.requests).toHaveLength(1);
    expect((await request(td.url, "/tiles/osm/30/0/0")).status).toBe(404);
    expect((await request(td.url, "/tiles/osm/2/1/1", { method: "POST" })).status).toBe(405);
    // 外网端口和别的地址一样要设备凭证
    expect((await request(td.externalUrl, "/tiles/osm/2/1/1")).status).toBe(401);
    expect((await request(td.externalUrl, "/_AMapService/v3/ip")).status).toBe(401);

    // 没填 Key：页面国内也先用 OpenStreetMap；代理不转
    expect((await mapApi.config(td.url)).body).toEqual({});
    expect((await request(td.url, "/_AMapService/v3/geocode/regeo?key=x")).status).toBe(503);

    // 设置 · 数据源里填高德的 Key：先测再存
    const view = (await dataSourcesApi.view(td.url)).body.sources.find((s) => s.id === AMAP_SOURCE_ID)!;
    expect(view).toMatchObject({ title: "高德地图", plugin: MAP_PLUGIN, pluginTitle: "地图", connection: "not_connected", configurable: true, usages: [{ usage: "query", on: true }] });
    const configured = await dataSourcesApi.act(td.url, AMAP_SOURCE_ID, {
      action: "configure",
      values: { jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE, serviceKey: AMAP_TEST_SERVICE_KEY },
      idempotencyKey: key(),
    });
    expect(configured.status).toBe(200);
    expect(configured.body.view.sources.find((s) => s.id === AMAP_SOURCE_ID)).toMatchObject({ connection: "connected", account: "地图：已填 · 查地点和路线：已填" });
    const config = await mapApi.config(td.url);
    expect(config.body).toEqual({ amapKey: AMAP_TEST_JS_KEY });

    // 高德代理：拼上安全密钥（页面带来的去掉），回应原样交回
    amap.requests.length = 0;
    const proxied = await request(td.url, `/_AMapService/v3/geocode/regeo?key=${AMAP_TEST_JS_KEY}&location=120.15,30.27&callback=jsonp_7&jscode=fromPage`, { headers: { "user-agent": "TestBrowser/1.0" } });
    expect(proxied.status).toBe(200);
    expect(proxied.headers["content-type"]).toContain("javascript");
    expect(proxied.headers["cache-control"]).toBe("no-store");
    expect(proxied.body.toString()).toMatch(/^jsonp_7\(\{"status":"1"/);
    const sent = new URL(amap.requests[0]!.url, "http://x");
    expect(sent.pathname).toBe("/rest/v3/geocode/regeo");
    expect(sent.searchParams.getAll("jscode")).toEqual([AMAP_TEST_SECURITY_CODE]);
    expect(amap.requests[0]!.headers["user-agent"]).toBe("TestBrowser/1.0");
    expect((await request(td.url, "/_AMapService/v4/map/styles?styleid=x")).status).toBe(200);
    expect(new URL(amap.requests.at(-1)!.url, "http://x").pathname).toBe("/webapi/v4/map/styles");

    // 安全密钥、Web 服务 Key 哪儿都不出现：页面、页面要的设置、数据源页、日志、事件
    const page = await request(td.url, "/", { headers: { accept: "text/html" } });
    const everywhere = [
      page.body.toString("utf8"),
      JSON.stringify(config.body),
      JSON.stringify((await dataSourcesApi.view(td.url)).body),
      logs.join("\n"),
      JSON.stringify(td.daemon.store.readGlobal(0, 1_000_000).map((e) => e.payload)),
    ].join("\n");
    expect(everywhere).not.toContain(AMAP_TEST_SECURITY_CODE);
    expect(everywhere).not.toContain(AMAP_TEST_SERVICE_KEY);

    // 运行中停用：接口、瓦片、代理都写"地图插件没启用"
    const off = await pluginsApi.act(td.url, MAP_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(off.status).toBe(200);
    const config2 = await mapApi.config(td.url);
    expect(config2.status).toBe(400);
    expect(config2.body.message).toBe("地图插件没启用");
    const tileOff = await request(td.url, "/tiles/osm/2/1/1");
    expect(tileOff.status).toBe(404);
    expect(tileOff.body.toString()).toContain("地图插件没启用");
    expect((await request(td.url, "/_AMapService/v3/ip")).status).toBe(404);
  });
});
