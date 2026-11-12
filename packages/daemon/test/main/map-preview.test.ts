// 主切面：聊天卡片的预览图（451，GET /api/map/preview）。真的守护进程走组合根和插件清单，清单里的地图插件、谷歌地图插件经 extraPlugins
// 换成同名的、高德和谷歌指向本机的假服务（helpers/fake-amap-lookup.ts、fake-google-maps.ts：不连真的、不用真 Key、不联网）：
// - 秘书（假模型按剧本）画一组点：卡片进聊天；按卡片编号取预览图 → 地图插件向高德只要一张光底图（453：发给高德的地址里没有点、
//   没有 markers），图原样转回、Cache-Control 照转、回应头 X-Map-View 写着视野，页面的地址里没有坐标；GET /api/map/config 里高德、谷歌标着能出预览图、高德国外排在谷歌后面；
// - 谷歌查的（查到的放在地图插件内存里的那一份）一律用谷歌（provider 写别的也不管），谷歌没开 Maps Static API 回 503 和原因；
// - 过期的编号 404，参数不对 400，OpenStreetMap 不出静态图 503，外网端口要凭证，地图插件停用 400；Key 不进日志。
import { AMAP_SOURCE_ID, CHANNELS, type CardEventPayload, EVENT_TYPES, GOOGLE_MAPS_SOURCE_ID, type HttpErrorBody, HTTP_PATHS, type MapPreviewQuery, parseMapPreviewView, wgsToGcj } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createGoogleMapsPlugin } from "../../src/google-maps/plugin.ts";
import { MAP_PLUGIN } from "../../src/map/api.ts";
import { mapPlugins } from "../helpers/map-plugins.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { startFakeAmapLookup } from "../helpers/fake-amap-lookup.ts";
import { GOOGLE_TEST_BROWSER_KEY, GOOGLE_TEST_SERVER_KEY, startFakeGoogleMaps } from "../helpers/fake-google-maps.ts";
import { AMAP_TEST_SERVICE_KEY, TINY_PNG } from "../helpers/fake-map.ts";
import { startFakeOsmLookup } from "../helpers/fake-osm-lookup.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { dataSourcesApi, mapApi, pluginsApi, request } from "../helpers/http.ts";

const { secretary: SECRETARY } = CHANNELS;
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const say = (text: string): FauxStep => ({ kind: "reply", text });

let n = 0;
const key = () => `t451-${++n}`;
const POINTS = [
  { lat: 30.2741, lon: 120.1551, label: "家" },
  { lat: 30.259, lon: 120.13, label: "西湖边" },
];

const mapCards = (td: TestDaemon) => td.daemon.store.read(CHANNELS.cards, 0, EVENT_TYPES.card).map((e) => (e.payload as CardEventPayload).card).filter((c) => c.type === "map");
const q = (over: Partial<MapPreviewQuery>): MapPreviewQuery => ({ width: 400, height: 200, dark: false, scale: 2, ...over });

describe("聊天卡片的预览图（假高德、假谷歌走真实装配路径）", () => {
  it("按卡片编号取高德的静态图、图原样转回；谷歌查的用谷歌；没开、过期、参数不对、OpenStreetMap、外网端口、插件停用都回对的状态", { timeout: 90_000 }, async () => {
    const amap = await startFakeAmapLookup();
    const google = await startFakeGoogleMaps();
    const osm = await startFakeOsmLookup();
    const logs: string[] = [];
    const td = await startTestDaemon({
      log: (line) => logs.push(line),
      extraPlugins: [...mapPlugins({ amapHosts: amap.hosts, osmHosts: osm.hosts, osmIntervalMs: 0, timeoutMs: 5000 }), createGoogleMapsPlugin({ hosts: google.hosts, timeoutMs: 5000 })],
      secretary: [call("show_on_map", { points: POINTS, title: "两处" }), say("标好了。")],
    });
    expect((await dataSourcesApi.act(td.url, AMAP_SOURCE_ID, { action: "configure", values: { serviceKey: AMAP_TEST_SERVICE_KEY }, idempotencyKey: key() })).status).toBe(200);
    expect((await dataSourcesApi.act(td.url, GOOGLE_MAPS_SOURCE_ID, { action: "configure", values: { browserKey: GOOGLE_TEST_BROWSER_KEY, serverKey: GOOGLE_TEST_SERVER_KEY }, idempotencyKey: key() })).status).toBe(200);

    // 页面挑底图要的：高德、谷歌能出预览图，高德国外的优先级低于谷歌
    const config = await mapApi.config(td.url);
    expect(config.body.providers?.find((p) => p.id === "amap")).toMatchObject({ regions: ["mainland", "abroad"], regionPriority: { abroad: 30 }, preview: true });
    expect(config.body.providers?.find((p) => p.id === "google")).toMatchObject({ priority: 50, preview: true });
    expect(config.body.providers?.find((p) => p.id === "osm")).toMatchObject({ preview: false });

    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("把家和西湖边标在地图上");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const [card] = mapCards(td);
    expect(card?.payload).toMatchObject({ show: { kind: "points" } });

    const path = HTTP_PATHS.mapPreview(q({ card: card!.id, provider: "amap" }));
    expect(path).toBe(`/api/map/preview?card=${encodeURIComponent(card!.id)}&provider=amap&w=400&h=200&scale=2`);
    expect(path).not.toMatch(/30\.2|120\.1/);
    const got = await request(td.url, path);
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["cache-control"]).toBe("max-age=300");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.body.equals(TINY_PNG)).toBe(true);
    const sent = amap.requests.filter((r) => r.path === "/v3/staticmap");
    expect(sent).toHaveLength(1);
    // 光底图：发给高德的只有中心、级别、尺寸、清晰度（和 Key），两个点的坐标都不在里面
    expect([...sent[0]!.query.keys()].toSorted()).toEqual(["key", "location", "scale", "size", "zoom"]);
    for (const p of POINTS) for (const c of [p, wgsToGcj(p)]) expect(sent[0]!.url).not.toContain(c.lat.toFixed(5));
    const view = parseMapPreviewView(got.headers["x-map-view"] as string | undefined);
    expect(view).toMatchObject({ zoom: Number(sent[0]!.query.get("zoom")), width: 400, height: 200, scale: 2, datum: "gcj02" });

    // 谷歌查的（查一次，放进内存的那一份）：provider 写 amap 也用谷歌；谷歌没开 Maps Static API：503 带原因
    const searched = await mapApi.find(td.url, { text: "Maxwell Food Centre" });
    expect(searched.body).toMatchObject({ ok: true, source: "google" });
    const lookup = (searched.body as { lookup: string }).lookup;
    const viaGoogle = await request(td.url, HTTP_PATHS.mapPreview(q({ lookup, provider: "amap", dark: true })));
    expect(viaGoogle.status).toBe(200);
    expect(google.requests.filter((r) => r.api === "static").at(-1)!.query.get("colorscheme")).toBe("dark");
    expect(amap.requests.filter((r) => r.path === "/v3/staticmap")).toHaveLength(1);
    google.state.staticOff = true;
    const off = await request(td.url, HTTP_PATHS.mapPreview(q({ lookup })));
    expect(off.status).toBe(503);
    expect((JSON.parse(off.body.toString("utf8")) as HttpErrorBody).message).toContain("Maps Static API 没开");

    // 过期了 404；参数不对 400；OpenStreetMap 不出静态图 503；外网端口要凭证
    expect((await request(td.url, HTTP_PATHS.mapPreview(q({ lookup: "amap-r99" })))).status).toBe(404);
    expect((await request(td.url, "/api/map/preview?card=x&w=10&h=200")).status).toBe(400);
    expect((await request(td.url, `/api/map/preview?card=${card!.id}&lookup=amap-r1&w=400&h=200`)).status).toBe(400);
    const osmPreview = await request(td.url, HTTP_PATHS.mapPreview(q({ card: card!.id, provider: "osm" })));
    expect(osmPreview.status).toBe(503);
    expect((await request(td.externalUrl, path)).status).toBe(401);

    // Key 不进日志
    for (const secret of [AMAP_TEST_SERVICE_KEY, GOOGLE_TEST_SERVER_KEY]) expect(logs.join("\n")).not.toContain(secret);

    // 地图插件停用：400"地图插件没启用"
    expect((await pluginsApi.act(td.url, MAP_PLUGIN, { action: "disable", idempotencyKey: key() })).status).toBe(200);
    const disabled = await request(td.url, path);
    expect(disabled.status).toBe(400);
    expect((JSON.parse(disabled.body.toString("utf8")) as HttpErrorBody).message).toBe("地图插件没启用");
    await frontend.close();
  });
});
