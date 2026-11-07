// 本机的假高德 Web 服务（只在测试里，432）：查地点、地址、路线的接口发到这里（createMapPlugin 的 amapHosts、createAmapLookup 的 hosts），
// 从不连真的 restapi.amap.com，不用真 Key（Key 是 fake-map.ts 里编的）。
// 回的样子照高德 Web 服务文档写的字段（2026-11 读的：搜地点 2.0、地理 / 逆地理编码、路线规划 2.0、错误码；文档页没有现成的 JSON 样例，
// 示例要拿 Key 现调，所以这里照字段说明拼）：status / info / infocode 三件套，数字写成字符串，没有值的写 []（高德的老样子），
// 坐标是 GCJ-02、经度在前；驾车带 cost（用时、红绿灯、过路费）、每一步的 tmcs 路况和折线；公交的方案里一段一段的步行和公交线路。
// 测试能拨：
// - fail：之后的请求一律回这个错（{ infocode, info }），比如 10001 INVALID_USER_KEY、10044 USER_DAILY_QUERY_OVER_LIMIT、10021 CUQPS_HAS_EXCEEDED_THE_LIMIT；
// - replies：某个路径回的东西换掉（空结果、只有一种字段写法）；
// 也照 fake-map.ts 那样认 Web 端的 Key（要带对的安全密钥），地图插件填 Key 时的测试照样过。记下每个请求（地址带查询串）。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";
import { AMAP_TEST_JS_KEY, AMAP_TEST_SECURITY_CODE, AMAP_TEST_SERVICE_KEY } from "./fake-map.ts";

const OK = { status: "1", info: "OK", infocode: "10000" };

/** 搜地点 2.0 的一个 POI（编的；坐标是 GCJ-02） */
export function fakePoi(name: string, location: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    id: `B0FAKE${name.length}${location.replace(/\D/g, "").slice(-4)}`,
    parent: [],
    location,
    type: "餐饮服务;咖啡厅;咖啡厅",
    typecode: "050500",
    pname: "浙江省",
    cityname: "杭州市",
    adname: "西湖区",
    address: "示例路 1 号",
    pcode: "330000",
    adcode: "330106",
    citycode: "0571",
    ...extra,
  };
}

/** 各个接口默认回的（编的杭州一带的地方） */
export const FAKE_AMAP_REPLIES: Readonly<Record<string, unknown>> = {
  "/v5/place/text": {
    ...OK,
    count: "2",
    pois: [
      fakePoi("示例湿地公园", "120.068000,30.272000", { type: "风景名胜;公园广场;公园", address: "示例天目山路 518 号" }),
      fakePoi("示例湿地公园（东门）", "120.080000,30.270000", { type: "风景名胜;公园广场;公园", address: [] }),
    ],
  },
  "/v5/place/around": {
    ...OK,
    count: "3",
    // 故意不按距离排：二狗自己按距离排
    pois: [fakePoi("示例咖啡（二店）", "120.131000,30.282000", { distance: "460" }), fakePoi("示例咖啡（一店）", "120.130500,30.280500", { distance: "120" }), fakePoi("示例茶室", "120.133000,30.283000", { distance: "800", type: "餐饮服务;茶艺馆" })],
  },
  "/v3/geocode/geo": {
    ...OK,
    count: "1",
    geocodes: [
      {
        formatted_address: "浙江省杭州市西湖区示例路478号",
        country: "中国",
        province: "浙江省",
        citycode: "0571",
        city: "杭州市",
        district: "西湖区",
        township: [],
        neighborhood: { name: [], type: [] },
        building: { name: [], type: [] },
        adcode: "330106",
        street: "示例路",
        number: "478号",
        location: "120.130000,30.280000",
        level: "门牌号",
      },
    ],
  },
  "/v3/geocode/regeo": {
    ...OK,
    regeocode: {
      formatted_address: "浙江省杭州市西湖区文新街道示例路",
      addressComponent: {
        city: "杭州市",
        province: "浙江省",
        adcode: "330106",
        district: "西湖区",
        towncode: "330106012000",
        streetNumber: { number: "478号", location: "120.130000,30.280000", direction: "北", distance: "20", street: "示例路" },
        country: "中国",
        township: "文新街道",
        businessAreas: [[]],
        building: { name: [], type: [] },
        neighborhood: { name: [], type: [] },
        citycode: "0571",
      },
    },
  },
  "/v5/direction/driving": {
    ...OK,
    count: "1",
    route: {
      origin: "120.130000,30.280000",
      destination: "120.210000,30.250000",
      taxi_cost: "42",
      paths: [
        {
          distance: "18230",
          restriction: "0",
          cost: { duration: "2100", tolls: "0", toll_distance: "0", traffic_lights: "14" },
          steps: [
            {
              instruction: "向东行驶1200米右转",
              orientation: "东",
              road_name: "示例三路",
              step_distance: "1200",
              polyline: "120.130000,30.280000;120.140000,30.281000",
              tmcs: [
                { tmc_status: "畅通", tmc_distance: "400", tmc_polyline: "120.130000,30.280000;120.134000,30.280300" },
                { tmc_status: "缓行", tmc_distance: "800", tmc_polyline: "120.134000,30.280300;120.140000,30.281000" },
              ],
            },
            {
              instruction: "沿示例北路行驶3000米",
              orientation: "东南",
              road_name: "示例北路",
              step_distance: "3000",
              polyline: "120.140000,30.281000;120.170000,30.270000",
              tmcs: [
                { tmc_status: "拥堵", tmc_distance: "1200", tmc_polyline: "120.140000,30.281000;120.150000,30.278000" },
                { tmc_status: "畅通", tmc_distance: "1800", tmc_polyline: "120.150000,30.278000;120.170000,30.270000" },
              ],
            },
            { instruction: "到达目的地", orientation: [], road_name: [], step_distance: "14030", polyline: "120.170000,30.270000;120.210000,30.250000", tmcs: [{ tmc_status: "未知", tmc_distance: "14030" }] },
          ],
        },
      ],
    },
  },
  "/v5/direction/walking": {
    ...OK,
    count: "1",
    route: {
      origin: "120.130000,30.280000",
      destination: "120.140000,30.280000",
      paths: [{ distance: "1900", cost: { duration: "1520", taxi: "12" }, steps: [{ instruction: "向东步行1900米", orientation: "东", road_name: "示例路", step_distance: "1900", polyline: "120.130000,30.280000;120.140000,30.280000" }] }],
    },
  },
  "/v5/direction/transit/integrated": {
    ...OK,
    count: "2",
    route: {
      origin: "120.130000,30.280000",
      destination: "120.210000,30.250000",
      distance: "15300",
      transits: [
        {
          cost: { duration: "3120", transit_fee: "4.0" },
          distance: "15300",
          walking_distance: "500",
          nightflag: "0",
          segments: [
            {
              walking: { origin: "120.130000,30.280000", destination: "120.131000,30.279000", distance: "300", cost: { duration: "257" }, steps: [{ instruction: "步行300米", road: [], distance: "300", polyline: { polyline: "120.130000,30.280000;120.131000,30.279000" } }] },
              bus: {
                buslines: [
                  {
                    departure_stop: { name: "示例三路站", id: "BV0001", location: "120.131000,30.279000" },
                    arrival_stop: { name: "示例关站", id: "BV0002", location: "120.170000,30.290000" },
                    name: "地铁2号线(示例南--示例北)",
                    id: "330100023324",
                    type: "地铁线路",
                    distance: "6589",
                    cost: { duration: "720" },
                    polyline: { polyline: "120.131000,30.279000;120.170000,30.290000" },
                    via_num: "4",
                    via_stops: [],
                  },
                ],
              },
            },
            {
              walking: { distance: "0", steps: [] },
              bus: {
                buslines: [
                  {
                    departure_stop: { name: "示例关站", location: "120.170000,30.290000" },
                    arrival_stop: { name: "示例江边站", location: "120.208000,30.251000" },
                    name: "地铁5号线(示例东--示例西)",
                    type: "地铁线路",
                    distance: "8211",
                    cost: { duration: "960" },
                    polyline: { polyline: "120.170000,30.290000;120.208000,30.251000" },
                    via_num: "7",
                  },
                ],
              },
            },
            { walking: { distance: "200", steps: [{ polyline: { polyline: "120.208000,30.251000;120.210000,30.250000" } }] }, bus: { buslines: [] } },
          ],
        },
        {
          cost: { duration: "3600", transit_fee: "2.0" },
          distance: "16100",
          walking_distance: "1100",
          segments: [{ walking: { distance: "600" }, bus: { buslines: [{ name: "示例B1路", type: "普通公交线路", departure_stop: { name: "示例站" }, arrival_stop: { name: "终点站" }, via_num: "12", polyline: "120.13,30.28;120.2,30.25" }] } }],
        },
      ],
    },
  },
};

export interface FakeAmapLookup {
  hosts: { rest: string; webapi: string; vectormap: string };
  /** 每个请求：路径（去掉 /rest 前缀）、查询串 */
  requests: Array<{ path: string; query: URLSearchParams; url: string }>;
  state: { fail: { infocode: string; info: string } | undefined; replies: Record<string, unknown> };
}

function reply(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json;charset=UTF-8" });
  res.end(JSON.stringify(body));
}

export async function startFakeAmapLookup(): Promise<FakeAmapLookup> {
  const requests: FakeAmapLookup["requests"] = [];
  const state: FakeAmapLookup["state"] = { fail: undefined, replies: {} };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/rest/")) return void res.writeHead(404).end();
    const path = url.pathname.slice("/rest".length);
    const q = url.searchParams;
    requests.push({ path, query: q, url: req.url ?? "" });
    const key = q.get("key");
    // Web 端的 Key（地图插件填 Key 时测的）：要带对的安全密钥
    if (key === AMAP_TEST_JS_KEY) {
      if (q.get("jscode") !== AMAP_TEST_SECURITY_CODE) return reply(res, { status: "0", info: "INVALID_USER_SCODE", infocode: "10008" });
      return reply(res, { ...OK, regeocode: { formatted_address: "北京市东城区" } });
    }
    if (key !== AMAP_TEST_SERVICE_KEY) return reply(res, { status: "0", info: "INVALID_USER_KEY", infocode: "10001" });
    if (state.fail) return reply(res, { status: "0", ...state.fail });
    const body = state.replies[path] ?? FAKE_AMAP_REPLIES[path];
    if (body === undefined) return reply(res, { status: "0", info: "SERVICE_NOT_AVAILABLE", infocode: "10002" });
    reply(res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { hosts: { rest: `${base}/rest`, webapi: `${base}/webapi`, vectormap: `${base}/vectormap` }, requests, state };
}
