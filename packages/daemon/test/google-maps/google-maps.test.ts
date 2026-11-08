// 谷歌地图插件（446）：假内核里装地图插件和谷歌地图插件，谷歌、OpenStreetMap、高德都是本机的假服务（不连外网、不用真 Key）。
// - 填 Key：服务端 Key 先测再存（三个 API 各问一次；不认、没开 API 写清楚、不存），浏览器用的只看写法；日志、事件里没有 Key；
// - 区域选源：填了 Key 大陆以外走谷歌（"附近的 hawker centre"：Text Search 带圈和按距离排、只要 Pro 档的字段），大陆里照旧；
//   地图上选了谷歌时大陆里也问它（点转 GCJ-02 发出去、回来的转回 WGS-84）；
// - 三类查询：搜地点和周边、地址 ↔ 位置、路线（开车带实时路况算 Pro 档、步行、公交的几个方案）；
// - Key 不对、到上限：回答里说清楚，Key 不对时连接状态报出错、之后退回 OpenStreetMap；
// - 用量：按计费项数，八成体检提醒，超了先停用这家退回 OpenStreetMap（底图那一项超了不交 Key），放开了接着用；
// - 地图页报来的：建了一次数地图加载、Key 被拒了记下（不交 Key、连接状态报出错）；
// - 插件停用退回 OpenStreetMap，再启用接上；移除并连数据删删密钥区那一格和用量。
import fs from "node:fs";
import path from "node:path";
import { GOOGLE_MAPS_SOURCE_ID, wgsToGcj } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { createDataSourceSecrets } from "../../src/data-sources/index.ts";
import { GOOGLE_MAPS, GOOGLE_MAPS_PLUGIN } from "../../src/google-maps/api.ts";
import { PLACE_FIELDS, ROUTE_FIELDS, TRANSIT_FIELDS } from "../../src/google-maps/lookup.ts";
import { createGoogleMapsPlugin } from "../../src/google-maps/plugin.ts";
import { decodePolyline, encodePolyline } from "../../src/google-maps/polyline.ts";
import { GOOGLE_MAPS_MONTHLY_FREE } from "../../src/google-maps/usage.ts";
import { MAP, MAP_PLUGIN } from "../../src/map/api.ts";
import { MAP_TOOL } from "../../src/map/lookup-tools.ts";
import { createMapPlugin } from "../../src/map/plugin.ts";
import { PHONE, type PhoneService } from "../../src/phone/api.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { SECRETARY_TARGET } from "../../src/secretary/secretary.ts";
import { startFakeAmapLookup } from "../helpers/fake-amap-lookup.ts";
import { GOOGLE_FAILURES, GOOGLE_TEST_BROWSER_KEY, GOOGLE_TEST_SERVER_KEY, GOOGLE_WEST_LAKE, GOOGLE_WEST_LAKE_GCJ, startFakeGoogleMaps } from "../helpers/fake-google-maps.ts";
import { SG_HERE, startFakeOsmLookup } from "../helpers/fake-osm-lookup.ts";
import { extraService, type PluginKernel, startPluginKernel } from "../helpers/plugin-kernel.ts";

let n = 0;
const key = () => `gm-${++n}`;
const AT = new Date("2026-11-08T09:00:00+08:00");
const HANGZHOU = { lat: 30.2741, lon: 120.1551 };
const SINGAPORE = { lat: 1.2834, lon: 103.8607 };

const fakePhone = {
  namedPlaces: () => [
    { name: "家", lat: 30.2741, lon: 120.1551 },
    { name: "公司", lat: 30.2801, lon: 120.1302 },
  ],
  latestPoint: () => ({ lat: SG_HERE.lat, lon: SG_HERE.lon, at: "2026-11-08T08:42:00+08:00" }),
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

const configure = (k: PluginKernel, values: Record<string, string>) => k.dataSources.act(GOOGLE_MAPS_SOURCE_ID, { action: "configure", values, idempotencyKey: key() });
const source = (k: PluginKernel) => k.dataSources.view().sources.find((s) => s.id === GOOGLE_MAPS_SOURCE_ID)!;
const mapTools = (k: PluginKernel) => k.agent.toolsFor(SECRETARY_TARGET).filter((t) => t.spec.name.startsWith("map_"));
const run = (k: PluginKernel, name: string, args: Record<string, unknown>) => mapTools(k).find((t) => t.spec.name === name)!.run(args as never, { toolCallId: key() });
const googleView = (k: PluginKernel) => k.host.service(MAP)!.providerViews().find((p) => p.id === "google");
const usageCheck = (k: PluginKernel) => k.doctorChecks.list().find((c) => c.plugin === MAP_PLUGIN && c.id === "google-usage");
const usageFile = (k: PluginKernel) => path.join(k.dir, "google-maps", "usage.json");
const secretFile = (k: PluginKernel) => path.join(dataDirLayout(k.dir).dataSourceSecrets, `${GOOGLE_MAPS_SOURCE_ID}.json`);
/** 把这个月某一项的用量直接写成 n 次 */
function setUsage(k: PluginKernel, counts: Record<string, number>) {
  fs.mkdirSync(path.dirname(usageFile(k)), { recursive: true });
  fs.writeFileSync(usageFile(k), JSON.stringify({ format: 1, months: { "2026-11": counts } }));
}
/** 日志、数据源的设置文件里搜得到哪个 Key（数据源填 Key 不写事件） */
function leaks(k: PluginKernel): string[] {
  const file = dataDirLayout(k.dir).dataSourcesFile;
  const settings = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const text = `${k.logs.join("\n")}\n${settings}`;
  return [GOOGLE_TEST_BROWSER_KEY, GOOGLE_TEST_SERVER_KEY].filter((v) => text.includes(v));
}
async function connected(k: PluginKernel) {
  const res = await configure(k, { browserKey: GOOGLE_TEST_BROWSER_KEY, serverKey: GOOGLE_TEST_SERVER_KEY });
  expect(res.view.sources.find((s) => s.id === GOOGLE_MAPS_SOURCE_ID)?.connection).toBe("connected");
}

describe("谷歌的折线编码", () => {
  it("照谷歌文档的例子解出三个点；编了再解还是原样", () => {
    // developers.google.com/maps/documentation/utilities/polylinealgorithm 的例子
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([
      { lat: 38.5, lon: -120.2 },
      { lat: 40.7, lon: -120.95 },
      { lat: 43.252, lon: -126.453 },
    ]);
    const pts = [
      { lat: 1.2805, lon: 103.845 },
      { lat: -33.86785, lon: 151.20732 },
    ];
    expect(decodePolyline(encodePolyline(pts))).toEqual(pts);
    expect(decodePolyline("_p~iF")).toEqual([]);
  });
});

describe("谷歌地图插件：填 Key", () => {
  it("没填时：地图服务里有这一家但底图、查询都用不了，大陆以外照旧 OpenStreetMap；数据源没连", async () => {
    const { google, osm, k } = await setup();
    expect(k.host.report().running).toEqual(expect.arrayContaining([MAP_PLUGIN, GOOGLE_MAPS_PLUGIN]));
    expect(googleView(k)).toMatchObject({ id: "google", regions: ["abroad"], manualRegions: ["abroad", "mainland"], priority: 50, ownBasemapOnly: true, basemap: true, ready: false, lookup: false });
    expect(source(k).connection).toBe("not_connected");
    const abroad = await run(k, MAP_TOOL.search, { near: `${SG_HERE.lat},${SG_HERE.lon}`, keyword: "hawker centre" });
    expect(abroad.text).toContain("OpenStreetMap找到");
    expect(google.requests).toEqual([]);
    expect(osm.requests.length).toBeGreaterThan(0);
    expect(mapTools(k)[0]!.spec.description).toContain("另外大陆以外优先用谷歌地图");
  });

  it("服务端 Key 先测再存：三个 API 各问一次（固定的地方），都过了才存；浏览器用的只看写法；日志里没有 Key", async () => {
    const { google, k } = await setup();
    await connected(k);
    expect(google.requests.map((r) => `${r.api} ${r.fieldMask ?? "-"}`)).toEqual(["geocoding -", "places places.id", "routes routes.distanceMeters"]);
    expect(google.requests[0]!.query.get("latlng")).toBe("1.2868,103.8545");
    const s = source(k);
    expect(s.account).toBe("浏览器用的 Key：已填 · 服务端用的 Key：已填");
    expect(s.problem).toBeUndefined();
    expect(s.panel).toMatchObject({ kind: "google-maps", browserKey: true, serverKey: true, allowOverage: false, over: [] });
    // 测 Key 那三次里地址和路线各数一次（只要编号的搜索不收费、不数）
    expect((s.panel as { usage: { counts: Record<string, number> } }).usage.counts).toMatchObject({ geocoding: 1, routesEssentials: 1, textSearch: 0 });
    expect(googleView(k)).toMatchObject({ ready: true, key: GOOGLE_TEST_BROWSER_KEY, lookup: true });
    expect(fs.existsSync(secretFile(k))).toBe(true);
    expect(leaks(k)).toEqual([]);
  });

  it("服务端 Key 不认：出错、写原因、不存（原来没存过）；没开 API：写清是哪个 API、怎么开；新填的没过时原来的照用", async () => {
    const { google, k } = await setup();
    const wrong = await configure(k, { serverKey: `${GOOGLE_TEST_SERVER_KEY.slice(0, -2)}zz` });
    const s1 = wrong.view.sources.find((s) => s.id === GOOGLE_MAPS_SOURCE_ID)!;
    expect(s1.connection).toBe("error");
    expect(s1.problem).toContain("谷歌不认这个服务端 Key");
    expect(googleView(k)?.lookup).toBe(false);
    // 存上一个好的，再填一个没开 Places API 的：还用原来的
    await configure(k, { serverKey: GOOGLE_TEST_SERVER_KEY });
    expect(source(k).connection).toBe("connected");
    google.state.fail = { api: "places", failure: GOOGLE_FAILURES.serviceDisabled };
    const disabled = await configure(k, { serverKey: GOOGLE_TEST_SERVER_KEY });
    const s2 = disabled.view.sources.find((s) => s.id === GOOGLE_MAPS_SOURCE_ID)!;
    expect(s2.problem).toContain("Places API (New)：这个 Google Cloud 项目里还没开这个 API");
    expect(s2.problem).toContain("还在用原来的");
    expect(leaks(k)).toEqual([]);
  });

  it("写法不对的 Key（带空格）不存；只改\"超了还接着用\"不去测 Key", async () => {
    const { google, k } = await setup();
    const bad = await configure(k, { browserKey: "AIza bad key with spaces 0000000000" });
    expect(bad.view.sources.find((s) => s.id === GOOGLE_MAPS_SOURCE_ID)?.problem).toContain("这不像谷歌的 Key");
    expect(googleView(k)?.ready).toBe(false);
    await configure(k, { browserKey: GOOGLE_TEST_BROWSER_KEY });
    expect(googleView(k)).toMatchObject({ ready: true, key: GOOGLE_TEST_BROWSER_KEY, lookup: false });
    await configure(k, { allowOverage: "on" });
    expect(google.requests).toEqual([]);
    expect(source(k).panel).toMatchObject({ allowOverage: true });
  });
});

describe("谷歌地图插件：区域选源和三类查询", () => {
  it("附近的 hawker centre（大陆以外）：走谷歌 Text Search（圈、按距离排、只要 Pro 档字段），按远近排、去掉圈外的；结果写明数据来自 Google 地图", async () => {
    const { google, osm, k } = await setup();
    await connected(k);
    google.requests.length = 0;
    const res = await run(k, MAP_TOOL.search, { near: "当前位置", keyword: "hawker centre" });
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("谷歌地图找到");
    expect(res.text).toContain("数据来自 Google 地图（Google Maps）");
    expect(res.text).toContain("编号 google-p");
    // 最近的是 Maxwell，圈外的（1 公里以外的 Tiong Bahru）去掉
    expect(res.text.indexOf("Maxwell Food Centre")).toBeLessThan(res.text.indexOf("Lau Pa Sat"));
    expect(res.text).not.toContain("Tiong Bahru");
    expect(osm.requests).toEqual([]);
    const req = google.requests.at(-1)!;
    expect(req.path).toBe("/v1/places:searchText");
    expect(req.fieldMask).toBe(PLACE_FIELDS);
    expect(req.fieldMask).not.toMatch(/rating|opening|phone|website/i);
    expect(req.body).toMatchObject({ textQuery: "hawker centre", rankPreference: "DISTANCE", languageCode: "zh-CN", locationBias: { circle: { center: { latitude: SG_HERE.lat, longitude: SG_HERE.lon } } } });
    expect(req.key).toBe(GOOGLE_TEST_SERVER_KEY);
  });

  it("不说找什么的周边走 Nearby Search；地址 → 位置、位置 → 地址走 Geocoding；计数按计费项", async () => {
    const { google, k } = await setup();
    await connected(k);
    google.requests.length = 0;
    const near = await run(k, MAP_TOOL.search, { near: `${SG_HERE.lat},${SG_HERE.lon}` });
    expect(near.text).toContain("谷歌地图");
    expect(google.requests.at(-1)).toMatchObject({ path: "/v1/places:searchNearby", fieldMask: PLACE_FIELDS });
    expect(google.requests.at(-1)!.body).toMatchObject({ rankPreference: "DISTANCE", locationRestriction: { circle: { center: { latitude: SG_HERE.lat, longitude: SG_HERE.lon } } } });
    const where = await run(k, MAP_TOOL.reverse, { where: `${SINGAPORE.lat},${SINGAPORE.lon}` });
    expect(where.text).toContain("10 Bayfront Ave, Singapore 018956");
    expect(where.text).toContain("谷歌地图查的");
    expect(google.requests.at(-1)!.query.get("latlng")).toBe(`${SINGAPORE.lat.toFixed(6)},${SINGAPORE.lon.toFixed(6)}`);
    const geo = await run(k, MAP_TOOL.geocode, { address: "10 Bayfront Avenue Singapore" });
    expect(geo.text).toContain("精确到门牌");
    expect(source(k).panel).toMatchObject({ usage: { counts: { nearbySearch: 1, geocoding: 3, textSearch: 0 } } });
  });

  it("路线：开车带实时路况（TRAFFIC_AWARE，算开车那一项）、公交几个方案（地铁几站、步行多少），步行；都有折线", async () => {
    const { google, k } = await setup();
    await connected(k);
    google.requests.length = 0;
    const res = await run(k, MAP_TOOL.route, { from: `${SG_HERE.lat},${SG_HERE.lon}`, to: `${SINGAPORE.lat},${SINGAPORE.lon}`, modes: ["driving", "transit", "walking"] });
    expect(res.text).toContain("- 开车：约 13 分钟（谷歌地图估的用时）");
    expect(res.text).toContain("- 公交/地铁：约 26 分钟，步行 590 米");
    expect(res.text).toContain("DT（Maxwell 上车，Bayfront 下车，3 站）");
    expect(res.text).toContain("另有方案：约 31 分钟（CC）");
    // 新加坡元不写成"元"
    expect(res.text).not.toContain("票价");
    expect(res.text).toContain("- 步行：");
    const routes = google.requests.filter((r) => r.api === "routes");
    expect(routes.map((r) => [r.body?.travelMode, r.body?.routingPreference ?? "-", r.fieldMask])).toEqual([
      ["DRIVE", "TRAFFIC_AWARE", ROUTE_FIELDS],
      ["TRANSIT", "-", TRANSIT_FIELDS],
      ["WALK", "-", ROUTE_FIELDS],
    ]);
    expect(source(k).panel).toMatchObject({ usage: { counts: { routesPro: 1, routesEssentials: 3 } } });
    const id = /编号 (google-r\d+)/.exec(res.text)![1]!;
    const drawing = k.host.service(MAP)!;
    expect(drawing).toBeDefined();
    expect(id).toMatch(/^google-r/);
  });

  it("大陆里：\"自动\"不问谷歌（没填高德 Key 走 OpenStreetMap）；地图上选了谷歌就问它，点转成 GCJ-02 发出去、回来的转回 WGS-84", async () => {
    const { google, osm, k } = await setup();
    await connected(k);
    google.requests.length = 0;
    const auto = await run(k, MAP_TOOL.reverse, { where: `${HANGZHOU.lat},${HANGZHOU.lon}` });
    expect(auto.text).toContain("OpenStreetMap查的");
    expect(google.requests).toEqual([]);
    osm.requests.length = 0;
    google.state.replies["/v1/places:searchText"] = { places: [GOOGLE_WEST_LAKE] };
    const manual = await run(k, MAP_TOOL.search, { near: `${HANGZHOU.lat},${HANGZHOU.lon}`, keyword: "West Lake", radius: 5000, map: "google" });
    expect(manual.text).toContain("谷歌地图找到 1 个");
    expect(manual.text).toContain("谷歌在大陆的店名、小路可能不全不新");
    expect(osm.requests).toEqual([]);
    const sent = (google.requests.at(-1)!.body as { locationBias: { circle: { center: { latitude: number; longitude: number } } } }).locationBias.circle.center;
    const gcj = wgsToGcj(HANGZHOU);
    expect(sent.latitude).toBeCloseTo(gcj.lat, 5);
    expect(sent.longitude).toBeCloseTo(gcj.lon, 5);
    expect(Math.abs(sent.longitude - HANGZHOU.lon)).toBeGreaterThan(0.003);
    // 回来的 GCJ-02 转回 WGS-84：结果里的坐标离谷歌给的差几百米
    const coord = /坐标 ([\d.]+),([\d.]+)/.exec(manual.text)!;
    expect(Number(coord[2])).toBeLessThan(GOOGLE_WEST_LAKE_GCJ.lon - 0.003);
  });
});

describe("谷歌地图插件：出错、用量、退回", () => {
  it("查的时候谷歌说 Key 不对：回答里请用户重新填；连接状态报出错要重新填；之后大陆以外退回 OpenStreetMap、说一句", async () => {
    const { google, osm, k } = await setup();
    await connected(k);
    google.state.fail = { failure: GOOGLE_FAILURES.keyInvalid };
    const res = await run(k, MAP_TOOL.search, { near: `${SG_HERE.lat},${SG_HERE.lon}`, keyword: "hawker centre" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("谷歌不认填的服务端 Key");
    expect(res.text).toContain("设置 · 数据源 · 谷歌地图");
    expect(res.text).not.toContain(GOOGLE_TEST_SERVER_KEY);
    expect(source(k)).toMatchObject({ connection: "error", needsAuth: true });
    expect(googleView(k)?.lookup).toBe(false);
    osm.requests.length = 0;
    const again = await run(k, MAP_TOOL.search, { near: `${SG_HERE.lat},${SG_HERE.lon}`, keyword: "hawker centre", map: "google" });
    expect(again.text).toContain("OpenStreetMap找到");
    expect(again.text).toContain("（地图上用的是谷歌地图，它现在查不了（谷歌说服务端 Key 不对或没权限，要用户重新填），这里用OpenStreetMap查的。）");
    // 出错后内核每小时叫 recheck：谷歌还不认照旧出错；好了就回来
    const gm = k.host.service(GOOGLE_MAPS)!;
    const secrets = createDataSourceSecrets({ dir: dataDirLayout(k.dir).dataSourceSecrets, log: () => {} }).forSource(GOOGLE_MAPS_SOURCE_ID);
    await gm.recheck(secrets, new AbortController().signal);
    expect(source(k).connection).toBe("error");
    google.state.fail = undefined;
    await gm.recheck(secrets, new AbortController().signal);
    expect(source(k)).toMatchObject({ connection: "connected" });
    expect(googleView(k)?.lookup).toBe(true);
    expect(leaks(k)).toEqual([]);
  });

  it("到了每日上限（429 per day）：回答里说上限到了、明天再试；Key 照样算认的", async () => {
    const { google, k } = await setup();
    await connected(k);
    google.state.fail = { api: "routes", failure: GOOGLE_FAILURES.quota };
    const res = await run(k, MAP_TOOL.route, { from: `${SG_HERE.lat},${SG_HERE.lon}`, to: `${SINGAPORE.lat},${SINGAPORE.lon}`, modes: ["driving"] });
    expect(res.text).toContain("谷歌说用量到上限了");
    expect(source(k).connection).toBe("connected");
    expect(source(k).problem).toContain("用量到上限");
  });

  it("用量：到了八成体检提醒；哪一项超了免费量先停用、退回 OpenStreetMap 并说明；放开了接着用", async () => {
    const { google, osm, k } = await setup();
    await connected(k);
    const check = usageCheck(k)!;
    expect(check).toBeDefined();
    expect((await check.run(new AbortController().signal)).level).toBe("ok");
    setUsage(k, { textSearch: 4_100 });
    // 换一个插件实例才重读文件：停用再启用
    await k.settings.act(GOOGLE_MAPS_PLUGIN, { action: "disable", idempotencyKey: key() });
    await k.settings.act(GOOGLE_MAPS_PLUGIN, { action: "enable", idempotencyKey: key() });
    const warn = await usageCheck(k)!.run(new AbortController().signal);
    expect(warn.level).toBe("warn");
    expect(warn.fact.params?.items).toContain("搜地点 4100 / 5000");
    setUsage(k, { textSearch: GOOGLE_MAPS_MONTHLY_FREE.textSearch, dynamicMaps: GOOGLE_MAPS_MONTHLY_FREE.dynamicMaps });
    await k.settings.act(GOOGLE_MAPS_PLUGIN, { action: "disable", idempotencyKey: key() });
    await k.settings.act(GOOGLE_MAPS_PLUGIN, { action: "enable", idempotencyKey: key() });
    const over = await usageCheck(k)!.run(new AbortController().signal);
    expect(over).toMatchObject({ level: "error", fact: { key: "googleMaps.doctor.usage.over" }, action: { route: "#/more/data-sources/google-maps" } });
    expect(googleView(k)).toMatchObject({ ready: false, lookup: false });
    expect(googleView(k)?.problem).toContain("免费地图加载用完了");
    expect(source(k).problem).toContain("这个月超了谷歌的免费量，先停用：地图加载；搜地点");
    google.requests.length = 0;
    osm.requests.length = 0;
    const res = await run(k, MAP_TOOL.search, { near: `${SG_HERE.lat},${SG_HERE.lon}`, keyword: "hawker centre", map: "google" });
    expect(res.text).toContain("OpenStreetMap找到");
    expect(res.text).toContain("这个月谷歌的免费量用完了（搜地点）");
    expect(google.requests).toEqual([]);
    // 放开：接着用谷歌（体检照样标红，写明超出的按量收费）
    await configure(k, { allowOverage: "on" });
    expect(googleView(k)).toMatchObject({ ready: true, lookup: true });
    expect((await run(k, MAP_TOOL.search, { near: `${SG_HERE.lat},${SG_HERE.lon}`, keyword: "hawker centre" })).text).toContain("谷歌地图找到");
    expect((await usageCheck(k)!.run(new AbortController().signal)).fact.key).toBe("googleMaps.doctor.usage.overAllowed");
  });

  it("地图页报来的：建了一次数一次地图加载；谷歌拒了浏览器用的 Key 记下（不交 Key、写原因、连接状态出错），重新填才清掉", async () => {
    const { k } = await setup();
    await connected(k);
    const map = k.host.service(MAP)!;
    expect(map.basemapEvent({ provider: "google", event: "loaded" })).toEqual({ known: true });
    expect(map.basemapEvent({ provider: "google", event: "loaded" })).toEqual({ known: true });
    expect(source(k).panel).toMatchObject({ usage: { counts: { dynamicMaps: 2 } } });
    // 没登记的、不收的不算错
    expect(map.basemapEvent({ provider: "osm", event: "loaded" })).toEqual({ known: false });
    expect(map.basemapEvent({ provider: "nope", event: "auth_failed" })).toEqual({ known: false });
    map.basemapEvent({ provider: "google", event: "auth_failed" });
    expect(googleView(k)).toMatchObject({ ready: false, lookup: true });
    expect(googleView(k)?.key).toBeUndefined();
    expect(googleView(k)?.problem).toContain("谷歌拒了浏览器用的 Key");
    expect(source(k)).toMatchObject({ connection: "error", needsAuth: true });
    await configure(k, { browserKey: GOOGLE_TEST_BROWSER_KEY });
    expect(googleView(k)).toMatchObject({ ready: true, key: GOOGLE_TEST_BROWSER_KEY });
    expect(leaks(k)).toEqual([]);
  });

  it("关了按需查：秘书不用谷歌查（退回 OpenStreetMap），底图照样能用", async () => {
    const { google, k } = await setup();
    await connected(k);
    await k.dataSources.act(GOOGLE_MAPS_SOURCE_ID, { action: "usage", usage: "query", on: false, idempotencyKey: key() });
    expect(googleView(k)).toMatchObject({ ready: true, lookup: false });
    google.requests.length = 0;
    expect((await run(k, MAP_TOOL.reverse, { where: `${SINGAPORE.lat},${SINGAPORE.lon}` })).text).toContain("OpenStreetMap查的");
    expect(google.requests).toEqual([]);
  });

  it("插件停用：地图服务里没有这一家，大陆以外退回 OpenStreetMap、体检少一项；启用回来接上（Key 还在）", async () => {
    const { osm, k } = await setup();
    await connected(k);
    await k.settings.act(GOOGLE_MAPS_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(googleView(k)).toBeUndefined();
    expect(usageCheck(k)).toBeUndefined();
    osm.requests.length = 0;
    expect((await run(k, MAP_TOOL.reverse, { where: `${SINGAPORE.lat},${SINGAPORE.lon}` })).text).toContain("OpenStreetMap查的");
    // 数据源照样列着（Key 还在密钥区），写明插件没启用
    expect(source(k)).toMatchObject({ connection: "connected", available: false });
    await k.settings.act(GOOGLE_MAPS_PLUGIN, { action: "enable", idempotencyKey: key() });
    expect(googleView(k)).toMatchObject({ ready: true, lookup: true });
    expect((await run(k, MAP_TOOL.reverse, { where: `${SINGAPORE.lat},${SINGAPORE.lon}` })).text).toContain("谷歌地图查的");
  });

  it("移除并连数据删：密钥区那一格、用量删掉；确认框写明删什么、删不掉什么；不带工具和卡片", async () => {
    const { k } = await setup();
    await connected(k);
    expect(fs.existsSync(usageFile(k))).toBe(true);
    const info = k.host.info().find((p) => p.name === GOOGLE_MAPS_PLUGIN)!;
    expect(info.brings).toEqual({ tools: [], cards: [], jobs: [] });
    expect(info.removal?.deletes).toEqual(["填过的两个谷歌 Key", "每月用了谷歌几次的计数、超了免费量放没放开"]);
    expect(info.removal?.keeps.join("\n")).toContain("聊天里说到过的地点");
    const result = await k.settings.act(GOOGLE_MAPS_PLUGIN, { action: "remove", purgeData: true, idempotencyKey: key() });
    expect(result.purged).toMatchObject({ events: 0, files: 2 });
    expect(fs.existsSync(secretFile(k))).toBe(false);
    expect(fs.existsSync(path.join(k.dir, "google-maps"))).toBe(false);
    expect(googleView(k)).toBeUndefined();
  });
});
