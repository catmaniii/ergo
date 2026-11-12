// OpenStreetMap 的免费服务（433）：Nominatim 查地点、OSRM 算路线，接本机的假服务（helpers/fake-osm-lookup.ts），不连真的。查：
// - 请求的样子：带能认出二狗的 User-Agent、不带 Referer，format=jsonv2、addressdetails、accept-language；附近是 viewbox + bounded=1，
//   二狗自己按距离排、去掉圈外的；按名字找时另一头做 viewbox（不限死）；OSRM 开车走 /routed-car/、步行走 /routed-foot/，坐标经度在前；
// - 每秒最多 1 次：一起发的几个排成一队，两次到达之间至少隔 1 秒；排队的太多直接说太频繁；
// - 缓存：同样的查询一天内只发一次（内存里），过了一天再发；出错的不缓存；停用时扔掉；
// - 出错：429 / 403 / 5xx / 连不上 / OSRM 的 NoRoute、NoSegment、TooBig 分成 lookup.ts 的几种，给模型的话写"免费服务暂时不可用"；
// - 管哪：哪儿都管，国内的提一句店名和小路可能不全；没有公交（不发请求）。
import { describe, expect, it } from "vitest";
import { problemText } from "../../src/map/lookup-tools.ts";
import { MapLookupError } from "../../src/map/lookup.ts";
import { createPoliteClient, OSM_CACHE_TTL_MS, OSM_MIN_INTERVAL_MS } from "../../src/openstreetmap/osm-client.ts";
import { createOsmLookup, nominatimHit, viewboxAround } from "../../src/openstreetmap/osm-lookup.ts";
import { MAP_USER_AGENT } from "../../src/openstreetmap/service.ts";
import { FAKE_HAWKERS, SG_HERE, startFakeOsmLookup } from "../helpers/fake-osm-lookup.ts";

function setup(options: { intervalMs?: number; now?: () => number } = {}) {
  return startFakeOsmLookup().then((fake) => {
    const logs: string[] = [];
    const osm = createOsmLookup({ hosts: fake.hosts, userAgent: MAP_USER_AGENT, now: options.now ?? (() => Date.now()), minIntervalMs: options.intervalMs ?? 0, timeoutMs: 5000, log: (l) => logs.push(l) });
    return { fake, osm, logs };
  });
}

/** 抓住它抛的 MapLookupError */
async function failureOf(run: () => Promise<unknown>): Promise<MapLookupError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof MapLookupError) return err;
    throw err;
  }
  throw new Error("没抛错");
}

describe("Nominatim：查地点", () => {
  it("附近：在中心四周的方框里找（bounded=1），带二狗的 User-Agent、不带 Referer；二狗自己按距离排、去掉圈外的", async () => {
    const { fake, osm } = await setup();
    const hits = await osm.searchNear({ center: SG_HERE, keyword: "hawker centre", radius: 1000, limit: 5 });
    const req = fake.requests[0]!;
    expect(req).toMatchObject({ service: "nominatim", path: "/search", ua: MAP_USER_AGENT, referer: undefined });
    expect(MAP_USER_AGENT).toMatch(/^ergo\/\d+\.\d+\.\d+ \(personal assistant; \+https:\/\/github\.com\/catmaniii\/ergo\)$/);
    expect(Object.fromEntries(req.query)).toMatchObject({ q: "hawker centre", format: "jsonv2", addressdetails: "1", bounded: "1", viewbox: viewboxAround(SG_HERE, 1000) });
    expect(req.query.get("accept-language")).toMatch(/,en$/);
    expect(Number(req.query.get("limit"))).toBeLessThanOrEqual(40);
    // 牛车水那几家近的在前；1 公里以外的天峇鲁去掉了
    expect(hits.map((h) => h.name)).toEqual(["Maxwell Food Centre", "Amoy Street Food Centre", "Chinatown Complex Food Centre", "Lau Pa Sat"]);
    expect(hits.map((h) => h.distanceM)).toEqual(hits.map((h) => h.distanceM).toSorted((a, b) => a! - b!));
    expect(hits[0]).toMatchObject({ id: "W2001", address: "1 Kadayanallur Street", area: "Chinatown, Singapore", type: "food court", lat: 1.28036, lon: 103.84476 });
    expect(hits[0]!.distanceM).toBeLessThan(100);
  });

  it("附近没说找什么：Nominatim 列不出全部，不发请求", async () => {
    const { fake, osm } = await setup();
    const err = await failureOf(() => osm.searchNear({ center: SG_HERE, radius: 1000, limit: 5 }));
    expect(err.failure).toBe("params");
    expect(problemText(err, osm)).toContain("要说找什么");
    expect(fake.requests).toEqual([]);
  });

  it("按名字找：城市写进查询；知道另一头在哪的拿它做 viewbox（bounded=0，只让近的排前面）", async () => {
    const { fake, osm } = await setup();
    const hits = await osm.searchText({ keyword: "滨海湾金沙", city: "Singapore", limit: 1, near: SG_HERE });
    expect(hits[0]).toMatchObject({ name: "滨海湾金沙", lat: 1.2834, lon: 103.8607, address: "Bayfront Avenue", area: "Marina Bay, Singapore", type: "hotel" });
    expect(Object.fromEntries(fake.requests[0]!.query)).toMatchObject({ q: "滨海湾金沙, Singapore", limit: "1", bounded: "0" });
    expect(fake.requests[0]!.query.get("viewbox")).not.toBeNull();
    // 不知道另一头的：不带 viewbox
    await osm.geocode({ address: "1 Kadayanallur St" });
    expect(fake.requests[1]!.query.get("viewbox")).toBeNull();
    expect(fake.requests[1]!.query.get("limit")).toBe("3");
  });

  it("某处 → 地址：名字写完整的地址，点用问的那个；那里什么都没有的是 undefined", async () => {
    const { fake, osm } = await setup();
    const hit = await osm.reverse(SG_HERE);
    expect(hit).toMatchObject({ name: "Maxwell Food Centre, 1, Kadayanallur Street, Chinatown, Singapore, 069184, Singapore", lat: SG_HERE.lat, lon: SG_HERE.lon });
    expect(Object.fromEntries(fake.requests[0]!.query)).toMatchObject({ lat: "1.280500", lon: "103.845000", format: "jsonv2", zoom: "18" });
    fake.state.replies["/reverse"] = { error: "Unable to geocode" };
    expect(await osm.reverse({ lat: 1.2, lon: 103.7 })).toBeUndefined();
  });

  it("认不出的条目扔掉；没有 name 的取 display_name 的第一段", () => {
    expect(nominatimHit({ lat: "abc", lon: "1" })).toBeUndefined();
    expect(nominatimHit({ ...FAKE_HAWKERS[0], name: "" })).toMatchObject({ name: "Chinatown Complex Food Centre" });
  });
});

describe("OSRM：算路线", () => {
  it("开车走 /routed-car/、步行走 /routed-foot/；坐标经度在前；整条折线（geojson）；没有路况", async () => {
    const { fake, osm } = await setup();
    const to = { lat: 1.2834, lon: 103.8607 };
    const driving = await osm.route({ from: SG_HERE, to, mode: "driving" });
    expect(driving).toMatchObject({ mode: "driving", durationS: 420, distanceM: 2400 });
    expect(driving.mode === "driving" && driving.traffic).toBeUndefined();
    expect(driving.mode === "driving" && driving.line).toEqual([SG_HERE, { lat: SG_HERE.lat, lon: (SG_HERE.lon + to.lon) / 2 }, to]);
    expect(fake.requests[0]).toMatchObject({ service: "osrm", path: "/routed-car/route/v1/driving/103.845000,1.280500;103.860700,1.283400", ua: MAP_USER_AGENT });
    expect(Object.fromEntries(fake.requests[0]!.query)).toMatchObject({ overview: "full", geometries: "geojson" });
    const walking = await osm.route({ from: SG_HERE, to, mode: "walking" });
    expect(walking).toMatchObject({ mode: "walking", durationS: 1380, distanceM: 1900 });
    expect(fake.requests[1]!.path).toMatch(/^\/routed-foot\/route\/v1\/foot\//);
  });

  it("没有公交：不发请求；走法、署名写在它的说明里", async () => {
    const { fake, osm } = await setup();
    expect((await failureOf(() => osm.route({ from: SG_HERE, to: { lat: 1.3, lon: 103.8 }, mode: "transit" }))).failure).toBe("params");
    expect(fake.requests).toEqual([]);
    expect(osm).toMatchObject({ id: "osm", name: "OpenStreetMap", routeModes: ["driving", "walking"], liveTraffic: false, browsesNearby: false });
    expect(osm.credit).toContain("数据来自 OpenStreetMap（© OpenStreetMap 贡献者");
  });

  it("哪儿都管（有高德时国内的点归高德，由工具按先后挑）；国内的提一句店名和小路可能不全", async () => {
    const { osm } = await setup();
    for (const p of [SG_HERE, { lat: 22.2819, lon: 114.1582 }, { lat: 30.2741, lon: 120.1551 }]) expect(osm.covers(p)).toBe(true);
    expect(osm.coverageNote?.(SG_HERE)).toBeUndefined();
    expect(osm.coverageNote?.({ lat: 22.2819, lon: 114.1582 })).toBeUndefined();
    expect(osm.coverageNote?.({ lat: 30.2741, lon: 120.1551 })).toBe("国内的地点用 OpenStreetMap 查，店名和小路可能不全");
  });
});

describe("每秒最多 1 次", () => {
  it("默认的间隔不小于 1 秒；一起发的三个排成一队，到达之间都隔够了", { timeout: 15_000 }, async () => {
    expect(OSM_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(1000);
    const { fake, osm } = await setup({ intervalMs: OSM_MIN_INTERVAL_MS });
    await Promise.all([osm.searchNear({ center: SG_HERE, keyword: "hawker centre", radius: 1000, limit: 5 }), osm.reverse(SG_HERE), osm.geocode({ address: "1 Kadayanallur St" })]);
    const at = fake.requests.map((r) => r.at);
    expect(at).toHaveLength(3);
    for (let i = 1; i < at.length; i += 1) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(1000);
    // OSRM 是另一家，另排一队：和 Nominatim 的不互相等
    expect(osm.sent()).toEqual({ nominatim: 3, osrm: 0 });
  });

  it("排队等多久按上一次开始算（假的等待）；排的太多直接说查得太频繁", async () => {
    let now = 0;
    const waited: number[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const client = createPoliteClient({
      name: "test",
      userAgent: MAP_USER_AGENT,
      now: () => now,
      minIntervalMs: 1000,
      queueMax: 2,
      wait: async (ms) => {
        waited.push(ms);
        await blocked;
        now += ms;
      },
      log: () => {},
    });
    const { fake } = await setup();
    const first = client.get(`${fake.hosts.nominatim}/search?q=hawker`);
    const second = client.get(`${fake.hosts.nominatim}/search?q=lau+pa+sat`);
    const third = await failureOf(() => client.get(`${fake.hosts.nominatim}/search?q=maxwell`));
    expect(third.failure).toBe("rate");
    expect(problemText(third, (await setup()).osm)).toContain("OpenStreetMap 的免费服务暂时不可用（查得太频繁：它每秒最多查 1 次）");
    await first;
    release!();
    await second;
    expect(waited).toEqual([1000]);
    expect(client.sent()).toBe(2);
  });
});

describe("缓存（只在内存里）", () => {
  it("同样的查询一天内只发一次；过了一天再发；换个词另发；停用时扔掉", async () => {
    let now = Date.parse("2026-11-07T10:00:00+08:00");
    const { fake, osm } = await setup({ now: () => now });
    const ask = () => osm.searchNear({ center: SG_HERE, keyword: "hawker centre", radius: 1000, limit: 5 });
    const a = await ask();
    const b = await ask();
    expect(b).toEqual(a);
    expect(fake.requests).toHaveLength(1);
    await osm.searchNear({ center: SG_HERE, keyword: "hawker centre", radius: 500, limit: 5 });
    expect(fake.requests).toHaveLength(2);
    now += OSM_CACHE_TTL_MS + 1;
    await ask();
    expect(fake.requests).toHaveLength(3);
    await ask();
    expect(fake.requests).toHaveLength(3);
    osm.clear();
    await ask();
    expect(fake.requests).toHaveLength(4);
  });

  it("出错的不缓存：429 之后好了再问会真的去问", async () => {
    const { fake, osm } = await setup();
    fake.state.fail = { status: 429 };
    expect((await failureOf(() => osm.reverse(SG_HERE))).failure).toBe("rate");
    fake.state.fail = undefined;
    expect(await osm.reverse(SG_HERE)).toBeDefined();
    expect(fake.requests).toHaveLength(2);
  });
});

describe("出错的说法", () => {
  it("429、403、503、连不上：都说免费服务暂时不可用", async () => {
    const { fake, osm, logs } = await setup();
    const near = () => osm.searchNear({ center: SG_HERE, keyword: "hawker centre", radius: 1000, limit: 5 });
    fake.state.fail = { status: 403 };
    const denied = await failureOf(near);
    expect(denied.failure).toBe("denied");
    expect(problemText(denied, osm)).toBe("OpenStreetMap 的免费服务暂时不可用（它拒绝了这台电脑的请求（HTTP 403））：它不保证一直能用。如实告诉用户，过一会儿再试。");
    fake.state.fail = { status: 503, service: "nominatim" };
    const server = await failureOf(near);
    expect(server.failure).toBe("server");
    expect(problemText(server, osm)).toContain("OpenStreetMap 的免费服务暂时不可用（HTTP 503）");
    // 只坏了 Nominatim：OSRM 照样能算
    expect(await osm.route({ from: SG_HERE, to: { lat: 1.29, lon: 103.85 }, mode: "driving" })).toMatchObject({ mode: "driving" });
    fake.state.fail = undefined;
    await fake.down();
    const network = await failureOf(() => osm.reverse({ lat: 1.31, lon: 103.81 }));
    expect(network.failure).toBe("network");
    expect(problemText(network, osm)).toContain("OpenStreetMap 的免费服务暂时不可用");
    // 日志只写服务和路径，不写查了什么
    expect(logs.join("\n")).not.toMatch(/hawker|103\.8/);
  });

  it("OSRM 的 NoRoute、NoSegment 是找不到路，TooBig 是太远", async () => {
    const { fake, osm } = await setup();
    const to = { lat: 1.29, lon: 103.85 };
    for (const [code, failure] of [
      ["NoRoute", "no_route"],
      ["NoSegment", "no_route"],
      ["TooBig", "too_far"],
      ["InvalidValue", "params"],
    ] as const) {
      fake.state.osrmCode = code;
      const err = await failureOf(() => osm.route({ from: SG_HERE, to, mode: "walking" }));
      expect(err).toMatchObject({ failure, code });
    }
    fake.state.osrmCode = "NoRoute";
    expect(problemText(await failureOf(() => osm.route({ from: SG_HERE, to, mode: "driving" })), osm)).toBe("OpenStreetMap没找到能走的路（NoRoute (fake)，NoRoute）。");
  });
});
