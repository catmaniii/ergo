// 高德 Web 服务（432）：查地点、地址、路线，全接本机的假高德（helpers/fake-amap-lookup.ts，照文档的字段拼的回应），不连真的高德、不用真 Key。
// 查：
// - 三类查询（搜地点：关键字 / 周边；地理编码 / 逆地理编码；路线：驾车带路况和用时、公交、步行）发对接口、带对参数，回来的读对；
// - 坐标进出都转：进去的 WGS-84 → GCJ-02（大陆里），回来的 GCJ-02 → WGS-84；
// - 高德的老毛病：没有值写 []、数字写成字符串、折线两种写法；
// - Key 不对 / 超额 / 限流 / 点在国外的说法；没填 Key、点在国外时根本不发请求；
// - 用量：搜地点和地址路线分开数、按月、重开接着数；查到的不落盘（数据目录里只有用量文件，里面没有查了什么）。
import fs from "node:fs";
import path from "node:path";
import { gcjToWgs, wgsToGcj } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createDataSourceSecrets } from "../../src/data-sources/index.ts";
import { AMAP_SECRET } from "../../src/map/amap.ts";
import { amapLocation, createAmapLookup, fromAmapLocation, parseAmapPolyline, thinLine } from "../../src/map/amap-lookup.ts";
import { AMAP_PERSONAL_MONTHLY_LIMITS, amapUsageFile, openAmapUsage, usageFinding } from "../../src/map/amap-usage.ts";
import { MapLookupError } from "../../src/map/lookup.ts";
import { startFakeAmapLookup } from "../helpers/fake-amap-lookup.ts";
import { AMAP_TEST_SERVICE_KEY } from "../helpers/fake-map.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 杭州一带的两个点（WGS-84） */
const HOME = { lat: 30.2775, lon: 120.1255 };
const OFFICE = { lat: 30.2525, lon: 120.2055 };
/** 新加坡（大陆外） */
const SINGAPORE = { lat: 1.2834, lon: 103.8607 };

async function setup(options: { key?: boolean; now?: () => number } = {}) {
  const fake = await startFakeAmapLookup();
  const dir = makeTempDir("ergo-amap-lookup-");
  const logs: string[] = [];
  const secrets = createDataSourceSecrets({ dir: path.join(dir, "secrets"), log: (l) => logs.push(l) }).forSource("amap");
  if (options.key !== false) secrets.set(AMAP_SECRET.serviceKey, AMAP_TEST_SERVICE_KEY);
  const mapDir = path.join(dir, "map");
  const now = options.now ?? (() => new Date("2026-11-07T09:00:00+08:00").getTime());
  const usage = openAmapUsage({ file: amapUsageFile(mapDir), now, log: (l) => logs.push(l) });
  const replies: Array<{ body: unknown; status: number }> = [];
  const lookup = createAmapLookup({ hosts: fake.hosts, timeoutMs: 5000, secrets: () => secrets, usage, onReply: (body, status) => replies.push({ body, status }), log: (l) => logs.push(l) });
  return { fake, lookup, usage, logs, replies, mapDir, dir, secrets };
}

const near = (a: { lat: number; lon: number }, b: { lat: number; lon: number }, eps = 1e-6) => Math.abs(a.lat - b.lat) < eps && Math.abs(a.lon - b.lon) < eps;

describe("坐标进出", () => {
  it("送给高德的是 GCJ-02（经度在前、6 位小数），高德回来的转回 WGS-84；大陆外原样", () => {
    const g = wgsToGcj(HOME);
    expect(amapLocation(HOME)).toBe(`${g.lon.toFixed(6)},${g.lat.toFixed(6)}`);
    // 大陆里转了几百米
    expect(Math.abs(g.lat - HOME.lat) + Math.abs(g.lon - HOME.lon)).toBeGreaterThan(0.002);
    const back = fromAmapLocation(amapLocation(HOME))!;
    expect(near(back, HOME, 1e-5)).toBe(true);
    expect(amapLocation(SINGAPORE)).toBe("103.860700,1.283400");
    expect(fromAmapLocation([])).toBeUndefined();
    expect(fromAmapLocation("abc")).toBeUndefined();
  });

  it("折线：分号分点、也认竖线分段和全用逗号连写的；点多了均匀抽掉、头尾留着", () => {
    const a = parseAmapPolyline("120.13,30.28;120.14,30.281|120.15,30.282");
    expect(a).toHaveLength(3);
    expect(near(a[0]!, gcjToWgs({ lat: 30.28, lon: 120.13 }))).toBe(true);
    expect(parseAmapPolyline("120.13,30.28,120.14,30.281")).toHaveLength(2);
    expect(parseAmapPolyline("")).toEqual([]);
    const many = Array.from({ length: 5000 }, (_, i) => ({ lat: 30 + i / 1e5, lon: 120 }));
    const thin = thinLine(many, 100);
    expect(thin).toHaveLength(100);
    expect(thin[0]).toEqual(many[0]);
    expect(thin.at(-1)).toEqual(many.at(-1));
  });
});

describe("三类查询", () => {
  it("关键字搜：/v5/place/text，限城市；结果的坐标转回 WGS-84，[] 当没有，种类取最后一段", async () => {
    const { fake, lookup, logs } = await setup();
    const hits = await lookup.searchText({ keyword: "示例湿地", city: "杭州", limit: 5 });
    const req = fake.requests.at(-1)!;
    expect(req.path).toBe("/v5/place/text");
    expect(req.query.get("keywords")).toBe("示例湿地");
    expect(req.query.get("region")).toBe("杭州");
    expect(req.query.get("city_limit")).toBe("true");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ name: "示例湿地公园", address: "示例天目山路 518 号", area: "浙江省杭州市西湖区", type: "公园", cityCode: "0571" });
    expect(near(hits[0]!, gcjToWgs({ lat: 30.272, lon: 120.068 }))).toBe(true);
    expect(hits[1]!.address).toBeUndefined();
    // 日志里没有 Key，也没有搜了什么
    expect(logs.join("\n")).not.toContain(AMAP_TEST_SERVICE_KEY);
    expect(logs.join("\n")).not.toContain("示例湿地");
  });

  it("周边搜：/v5/place/around，中心转成 GCJ-02、按距离排；近的在前", async () => {
    const { fake, lookup } = await setup();
    const hits = await lookup.searchNear({ center: HOME, keyword: "咖啡", radius: 1000, limit: 5 });
    const req = fake.requests.at(-1)!;
    expect(req.path).toBe("/v5/place/around");
    expect(req.query.get("location")).toBe(amapLocation(HOME));
    expect(req.query.get("radius")).toBe("1000");
    expect(req.query.get("keywords")).toBe("咖啡");
    expect(hits.map((h) => [h.name, h.distanceM])).toEqual([
      ["示例咖啡（一店）", 120],
      ["示例咖啡（二店）", 460],
      ["示例茶室", 800],
    ]);
  });

  it("地理编码、逆地理编码：/v3/geocode/geo、/v3/geocode/regeo；直辖市的 city 是 [] 也认", async () => {
    const { fake, lookup } = await setup();
    const [hit] = await lookup.geocode({ address: "示例路 478 号", city: "杭州" });
    expect(fake.requests.at(-1)!.path).toBe("/v3/geocode/geo");
    expect(fake.requests.at(-1)!.query.get("city")).toBe("杭州");
    expect(hit).toMatchObject({ name: "浙江省杭州市西湖区示例路478号", area: "浙江省杭州市西湖区", level: "门牌号", cityCode: "0571" });
    const where = await lookup.reverse(HOME);
    expect(fake.requests.at(-1)!.query.get("location")).toBe(amapLocation(HOME));
    expect(where).toMatchObject({ name: "浙江省杭州市西湖区文新街道示例路", address: "示例路478号", cityCode: "0571" });
    fake.state.replies["/v3/geocode/regeo"] = {
      status: "1",
      info: "OK",
      infocode: "10000",
      regeocode: { formatted_address: "北京市东城区东华门街道", addressComponent: { province: "北京市", city: [], district: "东城区", citycode: "010", streetNumber: { street: [], number: [] } } },
    };
    expect(await lookup.reverse({ lat: 39.9, lon: 116.39 })).toMatchObject({ area: "北京市东城区", address: "北京市东城区东华门街道", cityCode: "010" });
  });

  it("驾车：用时、距离、红绿灯、打车费，按路名合起来的路况（堵的在前，畅通、未知不算），折线转回 WGS-84", async () => {
    const { fake, lookup } = await setup();
    const answer = await lookup.route({ from: HOME, to: OFFICE, mode: "driving" });
    const req = fake.requests.at(-1)!;
    expect(req.path).toBe("/v5/direction/driving");
    expect(req.query.get("origin")).toBe(amapLocation(HOME));
    expect(req.query.get("destination")).toBe(amapLocation(OFFICE));
    expect(req.query.get("show_fields")).toBe("cost,tmcs,polyline");
    expect(answer).toMatchObject({ mode: "driving", durationS: 2100, distanceM: 18230, lights: 14, tolls: 0, taxiCost: 42 });
    if (answer.mode !== "driving") throw new Error("不是驾车");
    expect(answer.traffic).toEqual([
      { road: "示例北路", status: "jam", meters: 1200 },
      { road: "示例三路", status: "slow", meters: 800 },
    ]);
    expect(answer.line.length).toBeGreaterThanOrEqual(4);
    expect(near(answer.line[0]!, gcjToWgs({ lat: 30.28, lon: 120.13 }))).toBe(true);
  });

  it("公交：两头的城市编码先逆地理编码查（带着的不查）；方案里一段一段的步行、地铁，几站、票价", async () => {
    const { fake, lookup } = await setup();
    const answer = await lookup.route({ from: HOME, to: { ...OFFICE, cityCode: "0571" }, mode: "transit" });
    expect(fake.requests.map((r) => r.path)).toEqual(["/v3/geocode/regeo", "/v5/direction/transit/integrated"]);
    const req = fake.requests.at(-1)!;
    expect(req.query.get("city1")).toBe("0571");
    expect(req.query.get("city2")).toBe("0571");
    if (answer.mode !== "transit") throw new Error("不是公交");
    expect(answer.plans).toHaveLength(2);
    expect(answer.plans[0]).toMatchObject({ durationS: 3120, distanceM: 15300, walkingM: 500, fare: 4 });
    expect(answer.plans[0]!.legs).toEqual([
      { kind: "walk", meters: 300 },
      { kind: "ride", name: "地铁2号线(示例南--示例北)", from: "示例三路站", to: "示例关站", stops: 5, subway: true },
      { kind: "ride", name: "地铁5号线(示例东--示例西)", from: "示例关站", to: "示例江边站", stops: 8, subway: true },
      { kind: "walk", meters: 200 },
    ]);
    expect(answer.plans[0]!.line.length).toBeGreaterThanOrEqual(6);
    // 第二个方案的折线是字符串写法、用时在 cost 里
    expect(answer.plans[1]).toMatchObject({ durationS: 3600, fare: 2, walkingM: 1100 });
    expect(answer.plans[1]!.legs[1]).toMatchObject({ kind: "ride", name: "示例B1路", subway: false, stops: 13 });
  });

  it("步行：用时、距离、折线", async () => {
    const { fake, lookup } = await setup();
    const answer = await lookup.route({ from: HOME, to: OFFICE, mode: "walking" });
    expect(fake.requests.at(-1)!.path).toBe("/v5/direction/walking");
    expect(answer).toMatchObject({ mode: "walking", durationS: 1520, distanceM: 1900 });
  });
});

/** 假高德一律回这个错时搜一次 */
async function failing(infocode: string, info: string) {
  const { fake, lookup, replies } = await setup();
  fake.state.fail = { infocode, info };
  const err = await lookup.searchText({ keyword: "咖啡", limit: 3 }).catch((e: unknown) => e);
  return { err: err as MapLookupError, replies };
}

describe("出错的说法", () => {

  it("Key 不认、超额、限流、点在国外、找不到路：分成几种，带高德的原话和错误码；每个回应交给 amap.ts 记", async () => {
    const key = await failing("10001", "INVALID_USER_KEY");
    expect(key.err).toBeInstanceOf(MapLookupError);
    expect(key.err).toMatchObject({ failure: "key", detail: "INVALID_USER_KEY", code: "10001" });
    expect(key.replies).toHaveLength(1);
    expect((await failing("10044", "USER_DAILY_QUERY_OVER_LIMIT")).err.failure).toBe("quota");
    expect((await failing("10003", "DAILY_QUERY_OVER_LIMIT")).err.failure).toBe("quota");
    expect((await failing("10021", "CUQPS_HAS_EXCEEDED_THE_LIMIT")).err.failure).toBe("rate");
    expect((await failing("10004", "ACCESS_TOO_FREQUENT")).err.failure).toBe("rate");
    expect((await failing("20800", "OUT_OF_SERVICE")).err.failure).toBe("abroad");
    expect((await failing("20802", "ROUTE_FAIL")).err.failure).toBe("no_route");
    expect((await failing("20803", "OVER_DIRECTION_RANGE")).err.failure).toBe("too_far");
    expect((await failing("32001", "ENGINE_RESPONSE_DATA_ERROR")).err.failure).toBe("server");
    expect((await failing("10002", "SERVICE_NOT_AVAILABLE")).err.failure).toBe("denied");
  });

  it("没填 Web 服务 Key、点在大陆外：不发请求就说清楚", async () => {
    const noKey = await setup({ key: false });
    await expect(noKey.lookup.searchText({ keyword: "咖啡", limit: 3 })).rejects.toMatchObject({ failure: "no_key" });
    expect(noKey.fake.requests).toEqual([]);
    expect(noKey.usage.view().search).toBe(0);
    const { fake, lookup } = await setup();
    await expect(lookup.searchNear({ center: SINGAPORE, radius: 500, limit: 3 })).rejects.toMatchObject({ failure: "abroad" });
    await expect(lookup.route({ from: HOME, to: SINGAPORE, mode: "driving" })).rejects.toMatchObject({ failure: "abroad" });
    expect(fake.requests).toEqual([]);
  });

  it("连不上：说连不上，原因里没有 Key", async () => {
    const { lookup, logs, secrets } = await setup();
    const dead = createAmapLookup({ hosts: { rest: "http://127.0.0.1:1/rest" }, timeoutMs: 2000, secrets: () => secrets, usage: openAmapUsage({ file: path.join(makeTempDir("ergo-amap-dead-"), "u.json"), now: Date.now, log: () => {} }), log: (l) => logs.push(l) });
    const err = (await dead.searchText({ keyword: "咖啡", limit: 1 }).catch((e: unknown) => e)) as MapLookupError;
    expect(err.failure).toBe("network");
    expect(err.detail).not.toContain(AMAP_TEST_SERVICE_KEY);
    expect(logs.join("\n")).not.toContain(AMAP_TEST_SERVICE_KEY);
    expect(lookup.hasKey()).toBe(true);
  });
});

describe("用量和不落盘", () => {
  it("搜地点、地址路线分开数，按本地月份；重开接着数；换了月从 0 数；文件里只有次数", async () => {
    let now = new Date("2026-11-30T23:00:00+08:00").getTime();
    const { lookup, usage, mapDir } = await setup({ now: () => now });
    await lookup.searchText({ keyword: "示例湿地", limit: 1 });
    await lookup.searchNear({ center: HOME, radius: 500, limit: 1 });
    await lookup.route({ from: HOME, to: OFFICE, mode: "transit" });
    expect(usage.view()).toEqual({ month: "2026-11", search: 2, lbs: 3, searchLimit: 5000, lbsLimit: 150000 });
    // 重开（守护进程重启）接着数
    const again = openAmapUsage({ file: amapUsageFile(mapDir), now: () => now, log: () => {} });
    expect(again.view().search).toBe(2);
    now = new Date("2026-12-01T08:00:00+08:00").getTime();
    expect(again.view()).toMatchObject({ month: "2026-12", search: 0, lbs: 0 });
    // 插件自己的存储里只有用量文件，里面没有查了什么
    expect(fs.readdirSync(mapDir)).toEqual(["amap-usage.json"]);
    const text = fs.readFileSync(path.join(mapDir, "amap-usage.json"), "utf8");
    expect(text).not.toMatch(/示例|咖啡|120\.|30\./);
  });

  it("体检：没填 Key 不适用；到 80% 注意、到 100% 坏了，事实里写两类的次数和免费量", () => {
    const base = { month: "2026-11", search: 10, lbs: 30, searchLimit: AMAP_PERSONAL_MONTHLY_LIMITS.search, lbsLimit: AMAP_PERSONAL_MONTHLY_LIMITS.lbs };
    expect(usageFinding(base, false).level).toBe("na");
    expect(usageFinding(base, true)).toMatchObject({ level: "ok", fact: { key: "map.doctor.usage.ok", params: { search: 10, searchLimit: 5000, lbs: 30 } } });
    expect(usageFinding({ ...base, search: 4000 }, true)).toMatchObject({ level: "warn", fix: { key: "map.doctor.usage.fixNear" }, action: { kind: "open", route: "#/more/data-sources/amap" } });
    expect(usageFinding({ ...base, lbs: 150_000 }, true)).toMatchObject({ level: "error", fact: { key: "map.doctor.usage.over" } });
  });
});
