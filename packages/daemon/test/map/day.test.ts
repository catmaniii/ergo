// 地图插件的"我的足迹"（430）在假内核里：手机插件 + 地图插件（瓦片、高德指向本机的假服务，记下收到的每个请求）；
// App 交来的位置点、照片都是编的（杭州的几处），不读真的数据目录：
// - MAP_DAY.day(日期) 经手机插件现算：三段停留（家两段归成一处、写起的名字）、照片只有时间和坐标、常去的地方、有足迹的日子；
// - **取足迹时一个请求都不往外发**：填了高德的 Key 也一样——假 OpenStreetMap、假高德一个请求都没收到，
//   全局 fetch、http / https 的 request 和 get、net / tls 直连都没被叫过；
// - 日期写法不对：回"日期要写成…"（不读文件）；手机插件停用：回"数据源-手机插件没启用"，再启用接着有；
//   地图插件停用：服务取不到（接口那边回"地图插件没启用"，主切面测）。
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { AMAP_SOURCE_ID, nowIso, PHONE_LOCATION_SOURCE, PHONE_PHOTOS_SOURCE } from "@ergo/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { createDataSourceSecrets } from "../../src/data-sources/index.ts";
import { MAP_DAY, MAP_PLUGIN } from "../../src/map/api.ts";
import { createMapPlugin } from "../../src/map/plugin.ts";
import { phonePlugin } from "../../src/phone/plugin.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { AMAP_TEST_JS_KEY, AMAP_TEST_SECURITY_CODE, startFakeAmap, startFakeOsm } from "../helpers/fake-map.ts";
import { extraService, startPluginKernel } from "../helpers/plugin-kernel.ts";

let n = 0;
const key = () => `fp-${++n}`;
/** 本地时间 2026 年 11 月 d 日 hh:mm */
const at = (d: number, hh: number, mm = 0) => nowIso(new Date(2026, 10, d, hh, mm));
const HOME = { lat: 30.28, lon: 120.1 };
const LAKE = { lat: 30.259, lon: 120.13 };

/** 每隔 10 分钟一个点（App 交来的样子）：从 from 到 to（含），在 where 附近 */
function every10(d: number, from: [number, number], to: [number, number], where: { lat: number; lon: number }) {
  const out: Array<{ at: string; lat: number; lon: number; accuracy: number }> = [];
  const end = new Date(2026, 10, d, ...to).getTime();
  for (let t = new Date(2026, 10, d, ...from).getTime(), k = 0; t <= end; t += 10 * 60_000, k++) {
    out.push({ at: nowIso(new Date(t)), lat: where.lat + (k % 2 === 0 ? 0.0002 : -0.0002), lon: where.lon + (k % 2 === 0 ? -0.0002 : 0.0002), accuracy: 40 });
  }
  return out;
}

/** 假的个人档案（手机插件要它，这里用不到） */
const files = { people: () => [], background: () => "", withheld: () => [], onFieldReplaced: () => () => {}, replacedValues: () => [], addCandidates: () => 0, composeCandidates: () => undefined };

async function setup() {
  const osm = await startFakeOsm();
  const amap = await startFakeAmap();
  const k = await startPluginKernel({
    plugins: [phonePlugin, createMapPlugin({ osmUpstream: osm.url, amapHosts: amap.hosts, timeoutMs: 5000 })],
    services: [
      extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir)),
      extraService(KERNEL.dataSourceSecrets, ({ dir }) => createDataSourceSecrets({ dir: dataDirLayout(dir).dataSourceSecrets, log: () => {} })),
      extraService(KERNEL.personalFiles, () => files),
    ],
    at: new Date(2026, 10, 7, 9),
  });
  const push = (id: string, data: unknown) => k.dataSources.push(id, { data, idempotencyKey: key() });
  // 11-06：家 08:00–10:00、路上两个点、西湖边 11:00–15:00（带系统地名）、两个半小时没记到、家 17:30–22:00；11-03 西湖边一会儿
  await push(PHONE_LOCATION_SOURCE, {
    state: "granted",
    link: true,
    background: true,
    points: [
      ...every10(6, [8, 0], [10, 0], HOME),
      { at: at(6, 10, 20), lat: 30.27, lon: 120.116, accuracy: 80 },
      { at: at(6, 10, 40), lat: 30.268, lon: 120.12, accuracy: 80 },
      ...every10(6, [11, 0], [15, 0], LAKE).map((p) => ({ ...p, address: { spot: "北山街", district: "西湖区", city: "杭州市" } })),
      ...every10(6, [17, 30], [22, 0], HOME),
      ...every10(3, [14, 0], [14, 30], LAKE),
    ],
  });
  await push(PHONE_PHOTOS_SOURCE, {
    state: "granted",
    link: true,
    location: true,
    from: at(1, 0),
    to: at(7, 9),
    photos: [
      { key: "file://media/Photo/1/IMG_1.jpg", takenAt: at(6, 14, 5), ...LAKE, address: { spot: "北山街" } },
      { key: "file://media/Photo/2/IMG_2.jpg", takenAt: at(6, 14, 30), lat: 30.2592, lon: 120.1303 },
      { key: "file://media/Photo/3/IMG_3.jpg", takenAt: at(6, 19, 50) },
      { key: "file://media/Photo/4/IMG_4.jpg", takenAt: at(4, 9, 0), ...LAKE },
    ],
  });
  await k.dataSources.act(PHONE_LOCATION_SOURCE, { action: "configure", values: { places: "add", name: "家", lat: String(HOME.lat), lon: String(HOME.lon) }, idempotencyKey: key() });
  return { k, osm, amap };
}

/** 盯着往外连的各条路：fetch、http / https 的 request 和 get、net / tls 直连 */
function watchOutgoing() {
  return [
    vi.spyOn(globalThis, "fetch"),
    vi.spyOn(http, "request"),
    vi.spyOn(http, "get"),
    vi.spyOn(https, "request"),
    vi.spyOn(https, "get"),
    vi.spyOn(net, "connect"),
    vi.spyOn(net, "createConnection"),
    vi.spyOn(tls, "connect"),
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("我的足迹（地图插件经手机插件取）", () => {
  it("某一天：三段停留（家两段归一处、写起的名字）、照片只有时间和坐标、常去的地方、有足迹的日子；取的时候一个请求都不往外发", async () => {
    const { k, osm, amap } = await setup();
    // 填上高德的 Key（地图页国内用高德的样子）：取足迹照样不连高德
    await k.dataSources.act(AMAP_SOURCE_ID, { action: "configure", values: { jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE }, idempotencyKey: key() });
    osm.requests.length = 0;
    amap.requests.length = 0;

    const spies = watchOutgoing();
    const day = k.host.service(MAP_DAY)!.day("2026-11-06");
    const empty = k.host.service(MAP_DAY)!.day("2026-11-05");
    expect(spies.map((s) => s.mock.calls.length)).toEqual(spies.map(() => 0));
    expect(osm.requests).toEqual([]);
    expect(amap.requests).toEqual([]);

    expect(day.stays.map((s) => [s.from.slice(11, 16), s.to.slice(11, 16), s.minutes, s.name ?? s.address, s.spot === day.stays[0]!.spot])).toEqual([
      ["08:00", "10:00", 120, "家", true],
      ["11:00", "15:00", 240, "杭州市西湖区北山街", false],
      ["17:30", "22:00", 270, "家", true],
    ]);
    expect(day.points).toHaveLength(13 + 2 + 25 + 28);
    expect(day.photos.map((p) => [p.at, p.lat, p.lon])).toEqual([
      [at(6, 14, 5), LAKE.lat, LAKE.lon],
      [at(6, 14, 30), 30.2592, 120.1303],
    ]);
    // 照片只有编号、时间、坐标：不带地名、相册里的地址
    expect(JSON.stringify(day.photos)).not.toMatch(/IMG_|file:|北山街/);
    expect(day.unlocatedPhotos).toBe(1);
    expect(day.places).toMatchObject([{ name: "家", lat: HOME.lat, lon: HOME.lon, radius: 200 }]);
    expect(day.days).toEqual(["2026-11-06", "2026-11-04", "2026-11-03"]);
    expect(day.linked).toEqual({ location: true, photos: true });
    expect(empty).toMatchObject({ date: "2026-11-05", points: [], stays: [], photos: [], unlocatedPhotos: 0, days: ["2026-11-06", "2026-11-04", "2026-11-03"] });
  });

  it("日期写法不对回一句话（不读文件）；手机插件停用写没启用、再启用接着有；地图插件停用后服务取不到", async () => {
    const { k } = await setup();
    const map = () => k.host.service(MAP_DAY)!;
    for (const bad of ["2026-11-6", "2026-02-30", "../../config", ""]) {
      expect(() => map().day(bad)).toThrow(/^日期要写成 YYYY-MM-DD/);
    }
    await k.settings.act("phone", { action: "disable", idempotencyKey: key() });
    expect(() => map().day("2026-11-06")).toThrow("数据源-手机插件没启用");
    await k.settings.act("phone", { action: "enable", idempotencyKey: key() });
    expect(map().day("2026-11-06").stays).toHaveLength(3);
    await k.settings.act(MAP_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(k.host.service(MAP_DAY)).toBeUndefined();
  });
});
