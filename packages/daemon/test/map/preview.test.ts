// 聊天卡片的预览图（451，MAP_PREVIEW：GET /api/map/preview 背后那一层）。假内核里装地图插件、谷歌地图插件，高德、谷歌、
// OpenStreetMap 都是本机的假服务（不连真的、不用真 Key）：
// - 四种卡：足迹（按日期现算）、秘书给的点、路线、查到的（按编号从内存取）——向 provider 那一家只要一张光底图（453：地址里只有
//   中心、级别、尺寸、清晰度，没有 markers、paths，足迹的坐标一个都不在里面），图原样交回、上游的 Cache-Control 照转，
//   回应头 X-Map-View 写着这张图的视野（WGS-84 的中心、级别、宽高、清晰度、坐标）；查到的过期了 404；
// - 查到的一律用查它的那家（谷歌查的给 provider=amap 照样用谷歌）；OpenStreetMap 查的照 provider；
// - Key 不进日志；高德计进 lbs、谷歌计进 staticMaps；谷歌超了免费量不取（不影响查询），放开了照取；谷歌回 403 记"预览图：没开"；
//   高德出错回 JSON 时说原因、Key 不对记下；没填 Key、OpenStreetMap、没说用哪家都说清楚。
import fs from "node:fs";
import path from "node:path";
import { AMAP_SOURCE_ID, GOOGLE_MAPS_SOURCE_ID, type LatLon, MAP_VIEW_HEADER, type MapCardPayload, type MapDayView, type MapPreviewQuery, parseMapPreviewView, wgsToGcj } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { createDataSourceSecrets } from "../../src/data-sources/index.ts";
import { RequestRejected } from "../../src/errors.ts";
import { createGoogleMapsPlugin } from "../../src/google-maps/plugin.ts";
import { MAP, MAP_PREVIEW, MapPreviewUnavailable } from "../../src/map/api.ts";
import { createMapPlugin } from "../../src/map/plugin.ts";
import { PHONE, type PhoneService } from "../../src/phone/api.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { startFakeAmapLookup } from "../helpers/fake-amap-lookup.ts";
import { GOOGLE_TEST_BROWSER_KEY, GOOGLE_TEST_SERVER_KEY, startFakeGoogleMaps } from "../helpers/fake-google-maps.ts";
import { AMAP_TEST_SERVICE_KEY, TINY_PNG } from "../helpers/fake-map.ts";
import { startFakeOsmLookup } from "../helpers/fake-osm-lookup.ts";
import { extraService, type PluginKernel, startPluginKernel } from "../helpers/plugin-kernel.ts";

let n = 0;
const key = () => `pv-${++n}`;
const AT = new Date("2026-11-08T09:00:00+08:00");
const HANGZHOU = { lat: 30.2741, lon: 120.1551 };
const SINGAPORE = { lat: 1.2834, lon: 103.8607 };

/** 11-06 的足迹：家、西湖边两处，轨迹几个点 */
const DAY: MapDayView = {
  date: "2026-11-06",
  points: [
    { at: "2026-11-06T08:00:00.000+08:00", ...HANGZHOU },
    { at: "2026-11-06T09:30:00.000+08:00", lat: 30.265, lon: 120.14 },
    { at: "2026-11-06T11:00:00.000+08:00", lat: 30.259, lon: 120.13 },
  ],
  stays: [
    { id: "s1", spot: "home", from: "2026-11-06T08:00:00.000+08:00", to: "2026-11-06T10:00:00.000+08:00", minutes: 120, ...HANGZHOU, points: 12 },
    { id: "s2", spot: "lake", from: "2026-11-06T11:00:00.000+08:00", to: "2026-11-06T15:00:00.000+08:00", minutes: 240, lat: 30.259, lon: 120.13, points: 24 },
  ],
  photos: [],
  unlocatedPhotos: 0,
  places: [],
  days: ["2026-11-06"],
  linked: { location: true, photos: true },
};

const fakePhone = {
  footprints: (date: string) => (date === DAY.date ? DAY : { ...DAY, date, points: [], stays: [] }),
  namedPlaces: () => [],
  latestPoint: () => undefined,
} as unknown as PhoneService;

async function setup() {
  const google = await startFakeGoogleMaps();
  const osm = await startFakeOsmLookup();
  const amap = await startFakeAmapLookup();
  const k = await startPluginKernel({
    plugins: [createMapPlugin({ amapHosts: amap.hosts, osmHosts: osm.hosts, osmIntervalMs: 0, timeoutMs: 5000 }), createGoogleMapsPlugin({ hosts: google.hosts, timeoutMs: 5000 })],
    at: AT,
    services: [
      extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir)),
      extraService(KERNEL.dataSourceSecrets, ({ dir }) => createDataSourceSecrets({ dir: dataDirLayout(dir).dataSourceSecrets, log: () => {} })),
      extraService(PHONE, () => fakePhone),
    ],
  });
  return { google, osm, amap, k };
}

const fillAmap = async (k: PluginKernel) => {
  const res = await k.dataSources.act(AMAP_SOURCE_ID, { action: "configure", values: { serviceKey: AMAP_TEST_SERVICE_KEY }, idempotencyKey: key() });
  expect(res.view.sources.find((s) => s.id === AMAP_SOURCE_ID)?.connection).toBe("connected");
};
const fillGoogle = async (k: PluginKernel) => {
  const res = await k.dataSources.act(GOOGLE_MAPS_SOURCE_ID, { action: "configure", values: { browserKey: GOOGLE_TEST_BROWSER_KEY, serverKey: GOOGLE_TEST_SERVER_KEY }, idempotencyKey: key() });
  expect(res.view.sources.find((s) => s.id === GOOGLE_MAPS_SOURCE_ID)?.connection).toBe("connected");
};
const card = (k: PluginKernel, payload: MapCardPayload) => k.cards.create({ type: "map", status: "handled", payload }).id;
const preview = (k: PluginKernel, q: Partial<MapPreviewQuery>) => k.host.service(MAP_PREVIEW)!.preview({ width: 400, height: 200, dark: false, scale: 2, ...q }, new AbortController().signal);
const lookups = (k: PluginKernel) => (k.host.service(MAP) as unknown as { lookups: { put(d: object): string } }).lookups;
const googlePanel = (k: PluginKernel) => k.dataSources.view().sources.find((s) => s.id === GOOGLE_MAPS_SOURCE_ID)!.panel as { staticMap?: string; usage: { counts: Record<string, number> } };
const amapLbs = (k: PluginKernel) => (k.dataSources.view().sources.find((s) => s.id === AMAP_SOURCE_ID)!.panel as { usage: { lbs: number } }).usage.lbs;
/** 一个地址里出现了哪些点的坐标（WGS-84 和 GCJ-02，5 位、6 位小数都找；经纬度谁先都找） */
function coordsIn(url: string, points: readonly LatLon[]): LatLon[] {
  const text = decodeURIComponent(url);
  return points.filter((p) =>
    [p, wgsToGcj(p)].some((q) => [5, 6].some((d) => text.includes(`${q.lon.toFixed(d)},${q.lat.toFixed(d)}`) || text.includes(`${q.lat.toFixed(d)},${q.lon.toFixed(d)}`) || text.includes(q.lat.toFixed(d)))),
  );
}
/** 足迹里所有的点 */
const DAY_POINTS: LatLon[] = [...DAY.points, ...DAY.stays].map((p) => ({ lat: p.lat, lon: p.lon }));

/** 日志、设置文件里搜得到哪个 Key */
function leaks(k: PluginKernel): string[] {
  return [AMAP_TEST_SERVICE_KEY, GOOGLE_TEST_SERVER_KEY, GOOGLE_TEST_BROWSER_KEY].filter((v) => k.logs.join("\n").includes(v));
}

describe("聊天卡片的预览图", () => {
  it("四种卡：足迹按日期现算、点和路线在卡上、查到的按编号取——向那一家只要光底图（没有点和线、没有足迹的坐标），图原样交回（Cache-Control 照转），视野写在 X-Map-View；高德计进 lbs；Key 不进日志", async () => {
    const { amap, k } = await setup();
    await fillAmap(k);
    const before = amapLbs(k);
    const day = card(k, { show: { kind: "day", date: "2026-11-06" } });
    const reply = await preview(k, { card: day, provider: "amap" });
    expect(reply.status).toBe(200);
    expect(Object.keys(reply.headers).toSorted()).toEqual(["Cache-Control", "Content-Type", MAP_VIEW_HEADER].toSorted());
    expect(reply.headers["Content-Type"]).toBe("image/png");
    expect(reply.headers["Cache-Control"]).toBe("max-age=300");
    expect(reply.body.equals(TINY_PNG)).toBe(true);
    const sent = amap.requests.filter((r) => r.path === "/v3/staticmap");
    expect(sent).toHaveLength(1);
    // 只有中心、级别、尺寸、清晰度（和 Key）：没有 markers、labels、paths
    expect([...sent[0]!.query.keys()].toSorted()).toEqual(["key", "location", "scale", "size", "zoom"]);
    expect(coordsIn(sent[0]!.url, DAY_POINTS)).toEqual([]);
    expect(sent[0]!.query.get("size")).toBe("400*200");
    expect(sent[0]!.query.get("scale")).toBe("2");
    // 视野：中心是 WGS-84（交给高德的是它转成的 GCJ-02）、级别和交给高德的一样、宽高是图的
    const view = parseMapPreviewView(reply.headers[MAP_VIEW_HEADER])!;
    expect(view).toMatchObject({ zoom: Number(sent[0]!.query.get("zoom")), width: 400, height: 200, scale: 2, datum: "gcj02" });
    const gcj = wgsToGcj(view);
    expect(sent[0]!.query.get("location")).toBe(`${gcj.lon.toFixed(6)},${gcj.lat.toFixed(6)}`);
    expect(amapLbs(k)).toBe(before + 1);

    const points = card(k, { title: "三处", show: { kind: "points", marks: [{ id: "p1", ...HANGZHOU, label: "家" }, { id: "p2", lat: 30.259, lon: 120.13, label: "湖" }, { id: "p3", lat: 30.28, lon: 120.13, label: "公司" }] } });
    await preview(k, { card: points, provider: "amap" });
    expect([...amap.requests.at(-1)!.query.keys()].toSorted()).toEqual(["key", "location", "scale", "size", "zoom"]);
    expect(coordsIn(amap.requests.at(-1)!.url, [HANGZHOU, { lat: 30.259, lon: 120.13 }, { lat: 30.28, lon: 120.13 }])).toEqual([]);

    const route = card(k, { show: { kind: "route", points: [HANGZHOU, { lat: 30.259, lon: 120.13 }], marks: [{ id: "r1", ...HANGZHOU, label: "起点" }, { id: "r2", lat: 30.259, lon: 120.13, label: "终点" }] } });
    const routeReply = await preview(k, { card: route, provider: "amap", scale: 1, width: 320, height: 160 });
    expect([...amap.requests.at(-1)!.query.keys()].toSorted()).toEqual(["key", "location", "size", "zoom"]);
    expect(amap.requests.at(-1)!.query.get("size")).toBe("320*160");
    expect(parseMapPreviewView(routeReply.headers[MAP_VIEW_HEADER])).toMatchObject({ width: 320, height: 160, scale: 1 });

    const id = lookups(k).put({ kind: "route", source: "amap", title: "从家到湖边", at: AT.toISOString(), marks: [{ id: "from", ...HANGZHOU, kind: "place" }], lines: [{ id: "walking", kind: "route", mode: "walking", points: [HANGZHOU, { lat: 30.259, lon: 120.13 }] }] });
    const found = card(k, { show: { kind: "lookup", lookup: id, what: "route", source: "amap" } });
    await preview(k, { card: found, provider: "google" });
    expect(amap.requests.filter((r) => r.path === "/v3/staticmap")).toHaveLength(4);
    // 不经卡片直接看查到的一处（447 的编号）也行
    await preview(k, { lookup: id });
    expect(amap.requests.filter((r) => r.path === "/v3/staticmap")).toHaveLength(5);
    expect(leaks(k)).toEqual([]);
  });

  it("查到的一律用查它的那家（谷歌查的给 provider=amap 照样用谷歌，大陆外的点不转）；谷歌计进 staticMaps、记成能用；OpenStreetMap 查的照 provider", async () => {
    const { google, amap, k } = await setup();
    await fillAmap(k);
    await fillGoogle(k);
    const counted = googlePanel(k).usage.counts.staticMaps!;
    const id = lookups(k).put({ kind: "places", source: "google", title: "附近的 hawker centre", at: AT.toISOString(), marks: [{ id: "here", ...SINGAPORE, kind: "here" }, { id: "p1", lat: 1.2804, lon: 103.8448, label: "Maxwell", kind: "search" }], lines: [] });
    const c = card(k, { show: { kind: "lookup", lookup: id, what: "places", source: "google" } });
    const reply = await preview(k, { card: c, provider: "amap", dark: true });
    expect(reply.headers["Cache-Control"]).toBe("public, max-age=86400");
    const sent = google.requests.filter((r) => r.api === "static").at(-1)!;
    // 光底图：没有 markers、path；查到的点的坐标不在地址里
    expect([...sent.query.keys()].toSorted()).toEqual(["center", "colorscheme", "format", "key", "language", "maptype", "scale", "size", "zoom"]);
    expect(coordsIn(sent.query.toString(), [SINGAPORE, { lat: 1.2804, lon: 103.8448 }])).toEqual([]);
    expect(parseMapPreviewView(reply.headers[MAP_VIEW_HEADER])).toMatchObject({ width: 400, height: 200, scale: 2, datum: "gcj02" });
    expect(sent.query.get("colorscheme")).toBe("dark");
    expect(sent.query.get("key")).toBe(GOOGLE_TEST_SERVER_KEY);
    expect(googlePanel(k).usage.counts.staticMaps).toBe(counted + 1);
    expect(googlePanel(k).staticMap).toBe("ok");
    expect(amap.requests.filter((r) => r.path === "/v3/staticmap")).toHaveLength(0);
    // OpenStreetMap 查的：哪家地图上都能画，照页面说的那家
    const osmId = lookups(k).put({ kind: "places", source: "osm", title: "x", at: AT.toISOString(), marks: [{ id: "p1", ...SINGAPORE, kind: "search" }], lines: [] });
    await preview(k, { lookup: osmId, provider: "amap" });
    expect(amap.requests.filter((r) => r.path === "/v3/staticmap")).toHaveLength(1);
    expect(leaks(k)).toEqual([]);
  });

  it("谷歌：Maps Static API 没开（403）说原因、记成没开，查询照常", async () => {
    const { google, k } = await setup();
    await fillGoogle(k);
    google.state.staticOff = true;
    const c = card(k, { show: { kind: "points", marks: [{ id: "p1", ...SINGAPORE }] } });
    await expect(preview(k, { card: c, provider: "google" })).rejects.toThrow(MapPreviewUnavailable);
    await expect(preview(k, { card: c, provider: "google" })).rejects.toThrow(/Maps Static API 没开/);
    expect(googlePanel(k).staticMap).toBe("off");
    // 连接状态不受影响（只是卡片没有谷歌的预览图）
    expect(k.dataSources.view().sources.find((s) => s.id === GOOGLE_MAPS_SOURCE_ID)!.connection).toBe("connected");
    expect(k.host.service(MAP)!.providerViews().find((p) => p.id === "google")).toMatchObject({ lookup: true, preview: true });
    google.state.staticOff = false;
    expect((await preview(k, { card: c, provider: "google" })).status).toBe(200);
    expect(googlePanel(k).staticMap).toBe("ok");
  });

  it("谷歌：超了免费量不取（底图、查询照常），放开了照取", async () => {
    const { google, k } = await setup();
    // 用量在第一次用时读进来：先写好这个月静态地图已经 1 万次
    const usageFile = path.join(k.dir, "google-maps", "usage.json");
    fs.mkdirSync(path.dirname(usageFile), { recursive: true });
    fs.writeFileSync(usageFile, JSON.stringify({ format: 1, months: { "2026-11": { staticMaps: 10_000 } } }));
    await fillGoogle(k);
    const c = card(k, { show: { kind: "points", marks: [{ id: "p1", ...SINGAPORE }] } });
    const asked = google.requests.length;
    await expect(preview(k, { card: c, provider: "google" })).rejects.toThrow(/免费预览图用完了/);
    expect(google.requests.length).toBe(asked);
    expect(k.host.service(MAP)!.providerViews().find((p) => p.id === "google")).toMatchObject({ ready: true, lookup: true });
    // 放开了：照取
    await k.dataSources.act(GOOGLE_MAPS_SOURCE_ID, { action: "configure", values: { allowOverage: "on" }, idempotencyKey: key() });
    expect((await preview(k, { card: c, provider: "google" })).status).toBe(200);
  });

  it("测服务端 Key 时 Maps Static API 没开：照样存上（不挡保存），只标预览图没开", async () => {
    const { google, k } = await setup();
    google.state.staticOff = true;
    await fillGoogle(k);
    expect(googlePanel(k).staticMap).toBe("off");
  });

  it("高德出错回 JSON：说原因；Key 不对记下（之后不再去问）；没填 Key、OpenStreetMap、没说用哪家、过期了、卡不在都说清楚", async () => {
    const { amap, k } = await setup();
    const c = card(k, { show: { kind: "points", marks: [{ id: "p1", ...HANGZHOU }] } });
    await expect(preview(k, { card: c, provider: "amap" })).rejects.toThrow(/没填高德的 Web 服务 Key/);
    await fillAmap(k);
    amap.state.fail = { infocode: "10044", info: "USER_DAILY_QUERY_OVER_LIMIT" };
    await expect(preview(k, { card: c, provider: "amap" })).rejects.toThrow(/用得太多了/);
    amap.state.fail = { infocode: "10001", info: "INVALID_USER_KEY" };
    await expect(preview(k, { card: c, provider: "amap" })).rejects.toThrow(/Web 服务 Key 不对/);
    const asked = amap.requests.length;
    await expect(preview(k, { card: c, provider: "amap" })).rejects.toThrow(/Web 服务 Key 不对/);
    expect(amap.requests.length).toBe(asked);
    await expect(preview(k, { card: c, provider: "osm" })).rejects.toThrow(/不出静态地图/);
    await expect(preview(k, { card: c, provider: "nobody" })).rejects.toThrow(/没接上/);
    await expect(preview(k, { card: c })).rejects.toThrow(RequestRejected);
    await expect(preview(k, { lookup: "amap-r99" })).rejects.toMatchObject({ code: "not_found" });
    await expect(preview(k, { card: "c-nope", provider: "amap" })).rejects.toMatchObject({ code: "not_found" });
    expect(leaks(k)).toEqual([]);
  });
});
