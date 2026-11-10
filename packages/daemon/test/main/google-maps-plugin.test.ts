// 主切面：谷歌地图插件（446）。真的守护进程走组合根和插件清单，清单里的地图插件、谷歌地图插件经 extraPlugins 换成同名的
// （OpenStreetMap、谷歌都指向本机的假服务，不联网、不用真 Key）：
// - 设置 · 数据源 · 谷歌地图填两个 Key（经 POST /api/data-sources/google-maps，先测再存）；
// - GET /api/map/config 的 providers 多一家 google（带浏览器用的 Key，服务端用的不在里面）；
// - POST /api/map/basemap：地图页报建了一次（数用量）、写法不对回 400；
// - 秘书（假模型按剧本）查新加坡附近的 hawker centre 走谷歌；经设置 · 插件停用谷歌地图：providers 没有它，再查走 OpenStreetMap。
import { CHANNELS, EVENT_TYPES, GOOGLE_MAPS_SOURCE_ID, type GoogleMapsSourcePanel, type MessageEventPayload, type ToolCallDetail } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { GOOGLE_MAPS_PLUGIN } from "../../src/google-maps/api.ts";
import { createGoogleMapsPlugin } from "../../src/google-maps/plugin.ts";
import { MAP_TOOL } from "../../src/map/lookup-tools.ts";
import { mapPlugins } from "../helpers/map-plugins.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { GOOGLE_TEST_BROWSER_KEY, GOOGLE_TEST_SERVER_KEY, startFakeGoogleMaps } from "../helpers/fake-google-maps.ts";
import { SG_HERE, startFakeOsmLookup } from "../helpers/fake-osm-lookup.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { dataSourcesApi, mapApi, pluginsApi, toolCallDetail } from "../helpers/http.ts";

const { secretary: SECRETARY } = CHANNELS;
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const say = (text: string): FauxStep => ({ kind: "reply", text });
const near = { near: `${SG_HERE.lat},${SG_HERE.lon}`, keyword: "hawker centre" };

let n = 0;
const key = () => `google-maps-${++n}`;

describe("谷歌地图插件走真实装配路径", () => {
  it("填 Key、页面拿到浏览器用的 Key、报底图、秘书大陆外走谷歌；停用插件退回 OpenStreetMap", { timeout: 90_000 }, async () => {
    const osm = await startFakeOsmLookup();
    const google = await startFakeGoogleMaps();
    const td = await startTestDaemon({
      extraPlugins: [...mapPlugins({ osmHosts: osm.hosts, osmIntervalMs: 0, timeoutMs: 5000 }), createGoogleMapsPlugin({ hosts: google.hosts, timeoutMs: 5000 })],
      secretary: [call(MAP_TOOL.search, near), say("找到几家。"), call(MAP_TOOL.search, near), say("找到四家。")],
    });
    expect(td.daemon.plugins.report().running).toEqual(expect.arrayContaining(["map", GOOGLE_MAPS_PLUGIN]));

    // 没填：有这一家，底图、查询都用不了
    expect((await mapApi.config(td.url)).body.providers?.find((p) => p.id === "google")).toMatchObject({ ready: false, lookup: false, priority: 50 });

    const filled = await dataSourcesApi.act(td.url, GOOGLE_MAPS_SOURCE_ID, { action: "configure", values: { browserKey: GOOGLE_TEST_BROWSER_KEY, serverKey: GOOGLE_TEST_SERVER_KEY }, idempotencyKey: key() });
    expect(filled.status).toBe(200);
    const view = filled.body.view.sources.find((s) => s.id === GOOGLE_MAPS_SOURCE_ID)!;
    expect(view).toMatchObject({ connection: "connected", title: "谷歌地图" });
    // 回来的整页里没有 Key
    expect(JSON.stringify(filled.body)).not.toContain(GOOGLE_TEST_SERVER_KEY);
    expect(JSON.stringify(filled.body)).not.toContain(GOOGLE_TEST_BROWSER_KEY);

    // 页面拿到浏览器用的 Key（只有它）
    const config = (await mapApi.config(td.url)).body;
    expect(config.providers?.find((p) => p.id === "google")).toMatchObject({ ready: true, key: GOOGLE_TEST_BROWSER_KEY, lookup: true, title: "谷歌地图", regions: ["abroad"], manualRegions: ["abroad", "mainland"] });
    expect(JSON.stringify(config)).not.toContain(GOOGLE_TEST_SERVER_KEY);

    // 地图页报：建了一次谷歌底图（数用量）；写法不对回 400
    expect((await mapApi.basemap(td.url, { provider: "google", event: "loaded" })).body).toEqual({ known: true });
    expect((await mapApi.basemap(td.url, { provider: "osm", event: "loaded" })).body).toEqual({ known: false });
    expect((await mapApi.basemap(td.url, { provider: "google", event: "exploded" })).status).toBe(400);
    const panel = (await dataSourcesApi.view(td.url)).body.sources.find((s) => s.id === GOOGLE_MAPS_SOURCE_ID)!.panel as GoogleMapsSourcePanel;
    expect(panel.usage.counts.dynamicMaps).toBe(1);

    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    /** 说一句、等这一轮完，取这一轮里那次查地点的完整结果 */
    const ask = async (text: string) => {
      await frontend.sendText(text);
      await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
      const part = frontend
        .events({ channel: SECRETARY, type: EVENT_TYPES.message })
        .flatMap((f) => (f.payload as MessageEventPayload).message.parts)
        .findLast((p) => p.type === "tool_call" && p.tool === MAP_TOOL.search);
      if (part?.type !== "tool_call") throw new Error("秘书没调 map_search_places");
      return ((await toolCallDetail(td.url, part.callId)).body as ToolCallDetail).result ?? "";
    };
    const first = await ask("新加坡这儿附近有 hawker centre 吗");
    expect(first).toContain("谷歌地图找到");
    expect(first).toContain("数据来自 Google 地图");
    expect(osm.requests).toEqual([]);
    expect(google.requests.at(-1)?.path).toBe("/v1/places:searchText");

    // 设置 · 插件里停用谷歌地图：页面的 providers 没有它，再查走 OpenStreetMap
    const off = await pluginsApi.act(td.url, GOOGLE_MAPS_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(off.status).toBe(200);
    expect((await mapApi.config(td.url)).body.providers?.map((p) => p.id)).toEqual(["osm", "amap"]);
    const asked = google.requests.length;
    const second = await ask("再找一下");
    expect(second).toContain("OpenStreetMap找到 4 个");
    expect(google.requests).toHaveLength(asked);
  });
});
