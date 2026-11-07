// 主切面：地图上的"我的足迹"（430）。真的守护进程走组合根和插件清单，清单里的地图插件经 extraPlugins 换成同名的、瓦片和高德
// 指向本机的假服务（helpers/fake-map.ts，记下收到的每个请求；不连真的 OSM、高德，不联网）；手机插件在清单里。
// App 交来的位置点、照片照网页经 POST /api/data-sources/<id>/push 交的样子，都是编的（杭州的几处），时钟手动拨：
// - GET /api/map/day?date=2026-11-06：三段停留（家两段、写起的名字；西湖边写系统地名）、轨迹的点、有地点的照片、常去的地方、有足迹的日子；
// - 取足迹时不往外发请求：填了高德的 Key，假 OSM、假高德照样一个请求都没收到，守护进程一次 fetch 都没叫；
// - 只给本机和已配对的设备：外网端口没凭证 401；
// - 日期写法不对 400；手机插件停用 400"数据源-手机插件没启用"；地图插件停用 400"地图插件没启用"。
import { AMAP_SOURCE_ID, type DataSourcePushResult, type HttpErrorBody, HTTP_PATHS, type MapDayView, nowIso, PHONE_LOCATION_SOURCE, PHONE_PHOTOS_SOURCE } from "@ergo/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAP_PLUGIN } from "../../src/map/api.ts";
import { createMapPlugin } from "../../src/map/plugin.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { AMAP_TEST_JS_KEY, AMAP_TEST_SECURITY_CODE, startFakeAmap, startFakeOsm } from "../helpers/fake-map.ts";
import { dataSourcesApi, pluginsApi, request, requestJson } from "../helpers/http.ts";

/** 本地时间 2026 年 11 月 d 日 hh:mm */
const at = (d: number, hh: number, mm = 0) => nowIso(new Date(2026, 10, d, hh, mm));
const HOME = { lat: 30.28, lon: 120.1 };
const LAKE = { lat: 30.259, lon: 120.13 };

let n = 0;
const key = () => `t430-${++n}`;
const push = (url: string, id: string, data: unknown) => requestJson<DataSourcePushResult & HttpErrorBody>(url, HTTP_PATHS.dataSourcePush(id), { method: "POST", body: { data, idempotencyKey: key() } });
const dayOf = (url: string, date: string) => requestJson<MapDayView & HttpErrorBody>(url, HTTP_PATHS.mapDay(date));

/** 每隔 10 分钟一个点：从 from 到 to（含），在 where 附近 */
function every10(d: number, from: [number, number], to: [number, number], where: { lat: number; lon: number }) {
  const out: Array<{ at: string; lat: number; lon: number; accuracy: number }> = [];
  const end = new Date(2026, 10, d, ...to).getTime();
  for (let t = new Date(2026, 10, d, ...from).getTime(), k = 0; t <= end; t += 10 * 60_000, k++) {
    out.push({ at: nowIso(new Date(t)), lat: where.lat + (k % 2 === 0 ? 0.0002 : -0.0002), lon: where.lon + (k % 2 === 0 ? -0.0002 : 0.0002), accuracy: 40 });
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("我的足迹（GET /api/map/day，假瓦片、假高德走真实装配路径）", () => {
  it("某一天的停留、轨迹、照片、常去的地方；取的时候不往外发请求；外网端口要凭证；日期不对、插件停用回 400", { timeout: 60_000 }, async () => {
    const osm = await startFakeOsm();
    const amap = await startFakeAmap();
    const clock = new ManualClock(new Date(2026, 10, 7, 9));
    const td = await startTestDaemon({ clock, extraPlugins: [createMapPlugin({ osmUpstream: osm.url, amapHosts: amap.hosts, timeoutMs: 5000 })] });

    const location = await push(td.url, PHONE_LOCATION_SOURCE, {
      state: "granted",
      link: true,
      background: true,
      points: [
        ...every10(6, [8, 0], [10, 0], HOME),
        { at: at(6, 10, 20), lat: 30.27, lon: 120.116, accuracy: 80 },
        { at: at(6, 10, 40), lat: 30.268, lon: 120.12, accuracy: 80 },
        ...every10(6, [11, 0], [15, 0], LAKE).map((p) => ({ ...p, address: { spot: "北山街", district: "西湖区", city: "杭州市" } })),
        ...every10(6, [17, 30], [22, 0], HOME),
      ],
    });
    expect(location.status).toBe(200);
    expect((await push(td.url, PHONE_PHOTOS_SOURCE, {
      state: "granted",
      link: true,
      location: true,
      from: at(1, 0),
      to: at(7, 9),
      photos: [
        { key: "file://media/Photo/1/IMG_1.jpg", takenAt: at(6, 14, 5), ...LAKE },
        { key: "file://media/Photo/3/IMG_3.jpg", takenAt: at(6, 19, 50) },
      ],
    })).status).toBe(200);
    const named = await dataSourcesApi.act(td.url, PHONE_LOCATION_SOURCE, { action: "configure", values: { places: "add", name: "家", lat: String(HOME.lat), lon: String(HOME.lon) }, idempotencyKey: key() });
    expect(named.status).toBe(200);
    // 填了高德的 Key（地图页国内用高德）：取足迹照样不连高德
    expect((await dataSourcesApi.act(td.url, AMAP_SOURCE_ID, { action: "configure", values: { jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE }, idempotencyKey: key() })).status).toBe(200);
    osm.requests.length = 0;
    amap.requests.length = 0;

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const day = await dayOf(td.url, "2026-11-06");
    expect(day.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(osm.requests).toEqual([]);
    expect(amap.requests).toEqual([]);
    expect(day.body.stays.map((s) => [s.from.slice(11, 16), s.to.slice(11, 16), s.minutes, s.name ?? s.address])).toEqual([
      ["08:00", "10:00", 120, "家"],
      ["11:00", "15:00", 240, "杭州市西湖区北山街"],
      ["17:30", "22:00", 270, "家"],
    ]);
    expect(day.body.stays[0]!.spot).toBe(day.body.stays[2]!.spot);
    expect(day.body.points).toHaveLength(13 + 2 + 25 + 28);
    expect(day.body.photos).toEqual([{ id: expect.any(String), at: at(6, 14, 5), lat: LAKE.lat, lon: LAKE.lon }]);
    expect(day.body).toMatchObject({ date: "2026-11-06", unlocatedPhotos: 1, places: [{ name: "家", radius: 200 }], days: ["2026-11-06"], linked: { location: true, photos: true } });

    // 只给本机和已配对的设备
    expect((await request(td.externalUrl, HTTP_PATHS.mapDay("2026-11-06"))).status).toBe(401);
    // 日期写法不对
    const bad = await requestJson<HttpErrorBody>(td.url, "/api/map/day?date=..%2F..%2Fconfig");
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/^日期要写成 YYYY-MM-DD/);
    expect((await requestJson<HttpErrorBody>(td.url, "/api/map/day")).status).toBe(400);

    // 手机插件停用：足迹取不到，写明为什么（地图照样能看）
    expect((await pluginsApi.act(td.url, "phone", { action: "disable", idempotencyKey: key() })).status).toBe(200);
    const phoneOff = await dayOf(td.url, "2026-11-06");
    expect(phoneOff.status).toBe(400);
    expect(phoneOff.body.message).toBe("数据源-手机插件没启用");
    expect((await requestJson(td.url, HTTP_PATHS.mapConfig)).status).toBe(200);
    expect((await pluginsApi.act(td.url, "phone", { action: "enable", idempotencyKey: key() })).status).toBe(200);
    expect((await dayOf(td.url, "2026-11-06")).body.stays).toHaveLength(3);

    // 地图插件停用
    expect((await pluginsApi.act(td.url, MAP_PLUGIN, { action: "disable", idempotencyKey: key() })).status).toBe(200);
    const mapOff = await dayOf(td.url, "2026-11-06");
    expect(mapOff.status).toBe(400);
    expect(mapOff.body.message).toBe("地图插件没启用");
  });
});
