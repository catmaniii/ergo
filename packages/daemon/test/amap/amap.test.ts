// 高德地图（429）：填 Key 先测再存、安全密钥代理拼上 jscode 再转、三个地址各转各的；安全密钥不进给页面的、不进日志；
// 高德说 Key 不对时地图页不再拿 Key（国内先用别家），每小时再测好了就回来。全接本机的假高德。
// 455 起高德是单独的插件：转发口（/_AMapService）、页面要的设置都经地图插件的插槽——这里把高德这一家登记进一份地图服务，
// 走和网关同一条路（map.proxy、map.config 的 providers）。
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AMAP_SECRET, createAmap } from "../../src/amap/amap.ts";
import { createAmapService } from "../../src/amap/service.ts";
import { createMapService } from "../../src/map/service.ts";
import { createDataSourceSecrets } from "../../src/data-sources/index.ts";
import { AMAP_TEST_JS_KEY, AMAP_TEST_SECURITY_CODE, AMAP_TEST_SERVICE_KEY, startFakeAmap } from "../helpers/fake-map.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

async function setup() {
  const fake = await startFakeAmap();
  const dir = makeTempDir("ergo-amap-");
  const logs: string[] = [];
  const store = createDataSourceSecrets({ dir, log: (l) => logs.push(l) });
  const secrets = store.forSource("amap");
  const amap = createAmap({ hosts: fake.hosts, timeoutMs: 5000, secrets: () => secrets, log: (l) => logs.push(l) });
  const amapService = createAmapService({ hosts: fake.hosts, timeoutMs: 5000, secrets: () => secrets, usageFile: path.join(makeTempDir("ergo-amap-data-"), "usage.json"), now: () => Date.now(), log: (l) => logs.push(l) });
  const map = createMapService({ now: () => Date.now(), log: (l) => logs.push(l) });
  map.providers.register(amapService.provider);
  /** 页面要的设置里高德那一家：浏览器用的 Key、上次说不对的原因（455 以前叫 amapKey、amapProblem） */
  const config = () => {
    const view = map.config().providers?.find((p) => p.id === "amap");
    return { ...(view?.key === undefined ? {} : { amapKey: view.key }), ...(view?.problem === undefined ? {} : { amapProblem: view.problem }) };
  };
  const service = {
    configureAmap: (values: Record<string, string>, s: typeof secrets) => amapService.configure(values, s),
    amapService: (sub: string, search: string, signal: AbortSignal, userAgent?: string) => map.proxy(`/_AMapService${sub}`, search, signal, userAgent),
    amapStatus: (s: typeof secrets) => amapService.status(s),
    recheckAmap: (s: typeof secrets, signal: AbortSignal) => amapService.recheck(s, signal),
    config,
    raw: () => map.config(),
  };
  return { fake, secrets, amap, service, logs };
}
const live = () => new AbortController().signal;
const SECRETS = [AMAP_TEST_JS_KEY, AMAP_TEST_SECURITY_CODE, AMAP_TEST_SERVICE_KEY];
const leaks = (text: string) => SECRETS.filter((s) => text.includes(s));

describe("高德地图：填 Key 先测再存", () => {
  it("Web 端 Key 和安全密钥一起测过了才存；测的是一个固定的点、带着安全密钥和平台", async () => {
    const { fake, secrets, amap, logs } = await setup();
    expect(amap.status(secrets)).toEqual({ connection: "not_connected" });
    const status = await amap.configure({ jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE }, secrets);
    expect(status.connection).toBe("connected");
    expect(status.account).toBe("地图：已填 · 查地点和路线：没填");
    expect(secrets.get(AMAP_SECRET.jsKey)).toBe(AMAP_TEST_JS_KEY);
    expect(secrets.get(AMAP_SECRET.securityCode)).toBe(AMAP_TEST_SECURITY_CODE);
    const probe = new URL(fake.requests[0]!.url, "http://x");
    expect(probe.pathname).toBe("/rest/v3/geocode/regeo");
    expect(probe.searchParams.get("location")).toBe("116.397428,39.90923");
    expect(probe.searchParams.get("jscode")).toBe(AMAP_TEST_SECURITY_CODE);
    expect(probe.searchParams.get("platform")).toBe("JS");
    expect(leaks(logs.join("\n"))).toEqual([]);
  });

  it("Key 不对、安全密钥不对、平台不对：说清楚，不存", async () => {
    const { secrets, amap } = await setup();
    const wrongKey = await amap.configure({ jsKey: "x".repeat(32), securityCode: AMAP_TEST_SECURITY_CODE }, secrets);
    expect(wrongKey.connection).toBe("error");
    expect(wrongKey.problem).toBe("地图：高德不认这个 Key（填错了、删了，或者过期了）");
    const wrongCode = await amap.configure({ jsKey: AMAP_TEST_JS_KEY, securityCode: "y".repeat(32) }, secrets);
    expect(wrongCode.problem).toContain("安全密钥不对");
    const jsAsService = await amap.configure({ serviceKey: AMAP_TEST_JS_KEY }, secrets);
    expect(jsAsService.problem).toContain("不是「Web服务」的");
    expect(secrets.has(AMAP_SECRET.jsKey)).toBe(false);
    expect(secrets.has(AMAP_SECRET.serviceKey)).toBe(false);
  });

  it("只填 Key 不填安全密钥：要一起填；什么都没填：先填", async () => {
    const { secrets, amap } = await setup();
    expect((await amap.configure({ jsKey: AMAP_TEST_JS_KEY }, secrets)).problem).toContain("要一起填");
    expect((await amap.configure({}, secrets)).problem).toBe("先填 Web 端（JS API）的 Key 和安全密钥");
    expect((await amap.configure({ jsKey: `${AMAP_TEST_JS_KEY} x`, securityCode: AMAP_TEST_SECURITY_CODE }, secrets)).problem).toContain("不能有空格");
  });

  it("Web 服务 Key 单独测、单独存；新填的没过时原来的照用", async () => {
    const { secrets, amap } = await setup();
    await amap.configure({ jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE }, secrets);
    const both = await amap.configure({ serviceKey: AMAP_TEST_SERVICE_KEY }, secrets);
    expect(both.connection).toBe("connected");
    expect(both.account).toBe("地图：已填 · 查地点和路线：已填");
    const kept = await amap.configure({ jsKey: "z".repeat(32) }, secrets);
    expect(kept.connection).toBe("connected");
    expect(kept.problem).toContain("还在用原来的");
    expect(secrets.get(AMAP_SECRET.jsKey)).toBe(AMAP_TEST_JS_KEY);
  });
});

describe("高德安全密钥代理", () => {
  it("拼上存着的安全密钥（页面带来的 jscode 去掉），三个地址各转各的，回应原样交回、不缓存", async () => {
    const { fake, secrets, service, logs } = await setup();
    await service.configureAmap({ jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE }, secrets);
    fake.requests.length = 0;
    const rest = await service.amapService("/v3/geocode/regeo", `?key=${AMAP_TEST_JS_KEY}&location=120.15,30.27&jscode=bogus&callback=jsonp_1`, live(), "Mozilla/5.0 test");
    expect(rest.status).toBe(200);
    expect(rest.headers["Cache-Control"]).toBe("no-store");
    expect(rest.headers["Content-Type"]).toContain("javascript");
    expect(rest.body.toString()).toMatch(/^jsonp_1\(\{"status":"1"/);
    const sent = new URL(fake.requests[0]!.url, "http://x");
    expect(sent.pathname).toBe("/rest/v3/geocode/regeo");
    expect(sent.searchParams.getAll("jscode")).toEqual([AMAP_TEST_SECURITY_CODE]);
    expect(fake.requests[0]!.headers["user-agent"]).toBe("Mozilla/5.0 test");
    await service.amapService("/v4/map/styles", "?styleid=dark", live());
    await service.amapService("/v3/vectormap", "?x=1", live());
    expect(fake.requests.slice(1).map((r) => new URL(r.url, "http://x").pathname)).toEqual(["/webapi/v4/map/styles", "/vectormap/v3/vectormap"]);
    expect(leaks(logs.join("\n"))).toEqual([]);
  });

  it("没填安全密钥时不转；跑出去的路径不转", async () => {
    const { fake, service, secrets: own } = await setup();
    const setupWithKeys = async (s: typeof service) => {
      await s.configureAmap({ jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE }, own);
      return { secrets: own };
    };
    expect((await service.amapService("/v3/geocode/regeo", "?key=x", live())).status).toBe(503);
    expect(fake.requests).toHaveLength(0);
    const { secrets } = await setupWithKeys(service);
    const statuses = await Promise.all(["/../x", "/v3//x", "/v3/a b", "/v3/%2e%2e"].map(async (bad) => (await service.amapService(bad, "", live())).status));
    expect(statuses).toEqual([404, 404, 404, 404]);
    expect(fake.requests.filter((r) => !r.url.includes("regeo"))).toHaveLength(0);
    expect(secrets.has(AMAP_SECRET.securityCode)).toBe(true);
  });

  it("页面要的设置里只有 Web 端 Key，没有安全密钥、Web 服务 Key", async () => {
    const { secrets, service } = await setup();
    expect(service.config()).toEqual({});
    await service.configureAmap({ jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE, serviceKey: AMAP_TEST_SERVICE_KEY }, secrets);
    const config = service.config();
    expect(config).toEqual({ amapKey: AMAP_TEST_JS_KEY });
    expect(JSON.stringify(service.raw())).not.toContain(AMAP_TEST_SECURITY_CODE);
    expect(JSON.stringify(service.raw())).not.toContain(AMAP_TEST_SERVICE_KEY);
  });

  it("转发时高德说 Key 不对：页面不再拿 Key、写原因，连接状态报出错要重新填；每小时再测好了就回来", async () => {
    const { fake, secrets, service } = await setup();
    await service.configureAmap({ jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE }, secrets);
    fake.keys.jsRevoked = true;
    await service.amapService("/v3/place/text", `?key=${AMAP_TEST_JS_KEY}&keywords=x`, live());
    expect(service.config()).toEqual({ amapProblem: "高德不认这个 Key（填错了、删了，或者过期了）" });
    const status = service.amapStatus(secrets);
    expect(status.connection).toBe("error");
    expect(status.needsAuth).toBe(true);
    await service.recheckAmap(secrets, live());
    expect(service.config().amapKey).toBeUndefined();
    fake.keys.jsRevoked = false;
    await service.recheckAmap(secrets, live());
    expect(service.config()).toEqual({ amapKey: AMAP_TEST_JS_KEY });
    expect(service.amapStatus(secrets).connection).toBe("connected");
  });
});
