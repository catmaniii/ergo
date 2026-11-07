// 地图插件的查地点、算路线（432、433）在假内核里（startPluginKernel：真的插件宿主、数据源那一层、设置 · 插件那一层），高德指向本机的假高德
// （helpers/fake-amap-lookup.ts），OpenStreetMap 指向本机的假 Nominatim、OSRM（helpers/fake-osm-lookup.ts），手机插件换成只给常去的地方、
// 最近一个位置点的假服务。查：
// - 工具由插件自己登记（433）：插件在运行秘书就有五个工具，不跟着高德连没连着走；没填高德的 Key 时国外照样能查、国内走 OpenStreetMap；
// - 数据源"高德地图"的按需查（默认开）照样在：开着、填了 Web 服务 Key 时国内走高德，关掉国内改走 OpenStreetMap；内核不替它给工具；
// - 查一次：用量记在插件自己的存储里、数据源那一块带着这个月的用量；不写任何事件、不落别的盘（结果只现查）；Key 不进结果、日志、页面；
// - 查的时候高德说 Key 不认：连接状态变成出错（要重新填），之后国内改走 OpenStreetMap；
// - 插件停用：工具跟着没了（已经装配的那一份再调回"地图插件没启用"）；
// - 试查一下（数据源的 live）：搜固定的地点，列出来、写明数据来自高德和这个月的用量；没填 Web 服务 Key 时说先填；
// - 体检项：插件宿主有 ctx.doctor 时登记"高德的用量"（409 合进来以后）；
// - 移除并连数据删：插件自己的存储（用量）一起删。
import fs from "node:fs";
import path from "node:path";
import { AMAP_SOURCE_ID, type AmapSourcePanel, isAmapSourcePanel } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { createDataSourceSecrets } from "../../src/data-sources/index.ts";
import { MAP_PLUGIN } from "../../src/map/api.ts";
import { AMAP_USAGE_CHECK, registerAmapDoctor } from "../../src/map/doctor.ts";
import { MAP_TOOL } from "../../src/map/lookup-tools.ts";
import { createMapPlugin, MAP_DATA_DIR } from "../../src/map/plugin.ts";
import { PHONE, type PhoneService } from "../../src/phone/api.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { SECRETARY_TARGET } from "../../src/secretary/secretary.ts";
import { startFakeAmapLookup } from "../helpers/fake-amap-lookup.ts";
import { SG_HERE, startFakeOsmLookup } from "../helpers/fake-osm-lookup.ts";
import { AMAP_TEST_JS_KEY, AMAP_TEST_SECURITY_CODE, AMAP_TEST_SERVICE_KEY } from "../helpers/fake-map.ts";
import { extraService, type PluginKernel, startPluginKernel } from "../helpers/plugin-kernel.ts";

let n = 0;
const key = () => `lk-${++n}`;
const AT = new Date("2026-11-07T09:00:00+08:00");

/** 假手机插件：只给常去的地方、最近一个位置点 */
const fakePhone = {
  namedPlaces: () => [
    { id: "place-home", name: "家", lat: 30.2775, lon: 120.1255, radius: 200 },
    { id: "place-work", name: "公司", lat: 30.2525, lon: 120.2055, radius: 300 },
  ],
  latestPoint: () => ({ lat: 30.2801, lon: 120.1302, at: "2026-11-07T08:42:00+08:00" }),
} as unknown as PhoneService;

async function setup() {
  const fake = await startFakeAmapLookup();
  const osm = await startFakeOsmLookup();
  const k = await startPluginKernel({
    plugins: [createMapPlugin({ amapHosts: fake.hosts, osmHosts: osm.hosts, osmIntervalMs: 0, timeoutMs: 5000 })],
    at: AT,
    services: [
      extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir)),
      extraService(KERNEL.dataSourceSecrets, ({ dir }) => createDataSourceSecrets({ dir: dataDirLayout(dir).dataSourceSecrets, log: () => {} })),
      extraService(PHONE, () => fakePhone),
    ],
  });
  return { fake, osm, k };
}
const source = (k: PluginKernel) => k.dataSources.view().sources.find((s) => s.id === AMAP_SOURCE_ID)!;
const mapTools = (k: PluginKernel) => k.agent.toolsFor(SECRETARY_TARGET).filter((t) => t.spec.name.startsWith("map_"));
const configure = (k: PluginKernel, values: Record<string, string>) => k.dataSources.act(AMAP_SOURCE_ID, { action: "configure", values, idempotencyKey: key() });
const run = (k: PluginKernel, name: string, args: Record<string, unknown>) => mapTools(k).find((t) => t.spec.name === name)!.run(args as never, { toolCallId: key() });

describe("地图插件：查地点、算路线", () => {
  it("没填高德的 Key：秘书照样有五个工具；国外用 OpenStreetMap 照样能查，国内也走 OpenStreetMap（提一句不全），都不发给高德", async () => {
    const { fake, osm, k } = await setup();
    expect(source(k)).toMatchObject({ connection: "not_connected", usages: [{ usage: "query", on: true }] });
    expect(mapTools(k).map((t) => t.spec.name)).toEqual([MAP_TOOL.search, MAP_TOOL.route, MAP_TOOL.geocode, MAP_TOOL.reverse, MAP_TOOL.places]);
    expect(mapTools(k)[1]!.descriptor).toMatchObject({ network: true, pullOnly: true });
    const abroad = await run(k, MAP_TOOL.search, { near: `${SG_HERE.lat},${SG_HERE.lon}`, keyword: "hawker centre" });
    expect(abroad.text).toContain("OpenStreetMap找到 4 个");
    expect(abroad.text).not.toContain("店名和小路可能不全");
    const home = await run(k, MAP_TOOL.route, { from: "家", to: "公司" });
    expect(home.isError).toBeUndefined();
    expect(home.text).toContain("（国内的地点用 OpenStreetMap 查，店名和小路可能不全。）");
    expect(home.text).not.toContain("Key");
    expect(fake.requests).toEqual([]);
    expect(osm.requests.map((r) => r.service)).toEqual(["nominatim", "osrm", "osrm"]);
  });

  it("填了 Web 服务 Key、按需查开着：国内走高德、国外走 OpenStreetMap；按需查关掉国内改走 OpenStreetMap，工具一直在、内核不替高德另给", async () => {
    const { fake, osm, k } = await setup();
    await configure(k, { serviceKey: AMAP_TEST_SERVICE_KEY });
    expect(source(k)).toMatchObject({ connection: "connected", usages: [{ usage: "query", on: true }], hasLive: true });
    expect(mapTools(k)).toHaveLength(5);
    const before = fake.requests.length;
    expect((await run(k, MAP_TOOL.route, { from: "家", to: "公司" })).text).toContain("- 开车：约 35 分钟（高德估的用时）");
    expect(fake.requests.length).toBeGreaterThan(before);
    expect((await run(k, MAP_TOOL.route, { from: "1.2805,103.845", to: "1.2834,103.8607", modes: ["walking"] })).text).toContain("数据来自 OpenStreetMap");
    await k.dataSources.act(AMAP_SOURCE_ID, { action: "usage", usage: "query", on: false, idempotencyKey: key() });
    expect(mapTools(k)).toHaveLength(5);
    const amapBefore = fake.requests.length;
    const osmBefore = osm.requests.length;
    const off = await run(k, MAP_TOOL.route, { from: "家", to: "公司", modes: ["driving"] });
    expect(off.text).toContain("OpenStreetMap按道路限速估的");
    expect(fake.requests.length).toBe(amapBefore);
    expect(osm.requests.length).toBe(osmBefore + 1);
  });

  it("只填了地图那一组：国内走 OpenStreetMap；看常去的地方照样能用", async () => {
    const { fake, k } = await setup();
    await configure(k, { jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE });
    const before = fake.requests.length;
    const out = await run(k, MAP_TOOL.route, { from: "家", to: "公司" });
    expect(out.text).toContain("数据来自 OpenStreetMap");
    expect(fake.requests.length).toBe(before);
    expect((await run(k, MAP_TOOL.places, {})).text).toContain("- 家（范围 200 米）");
    expect((source(k).panel as AmapSourcePanel).lookup).toBe(false);
  });

  it("插件停用：工具跟着没了；已经装配的那一份再调回\"地图插件没启用\"", async () => {
    const { osm, k } = await setup();
    const search = mapTools(k).find((t) => t.spec.name === MAP_TOOL.search)!;
    await k.settings.act(MAP_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(mapTools(k)).toEqual([]);
    const out = await search.run({ near: `${SG_HERE.lat},${SG_HERE.lon}`, keyword: "hawker centre" } as never, { toolCallId: key() });
    expect(out).toMatchObject({ isError: true });
    expect(out.text).toContain("地图插件没启用");
    expect(osm.requests).toEqual([]);
  });

  it("查一次：用量记下、数据源那一块带着；不写事件、只落用量文件；Key 不进结果、日志、页面", async () => {
    const { k } = await setup();
    await configure(k, { serviceKey: AMAP_TEST_SERVICE_KEY });
    const events = k.store.lastGlobalSeq();
    const out = await run(k, MAP_TOOL.route, { from: "家", to: "公司" });
    expect(out.text).toContain("- 开车：约 35 分钟");
    await run(k, MAP_TOOL.search, { near: "当前位置", keyword: "咖啡" });
    // 不写事件（查到的不进记忆素材）
    expect(k.store.lastGlobalSeq()).toBe(events);
    const panel = source(k).panel;
    expect(isAmapSourcePanel(panel)).toBe(true);
    // 填 Key 时测的那一次不算（那是 429 的测 Key）；路线：开车 1 + 公交 3（两头逆地理编码 + 公交），搜地点 1
    expect((panel as AmapSourcePanel).usage).toMatchObject({ month: "2026-11", search: 1, lbs: 4, searchLimit: 5000, lbsLimit: 150000 });
    expect((panel as AmapSourcePanel).lookup).toBe(true);
    const mapDir = path.join(k.dir, MAP_DATA_DIR);
    expect(fs.readdirSync(mapDir)).toEqual(["amap-usage.json"]);
    for (const text of [out.text, k.logs.join("\n"), JSON.stringify(k.dataSources.view())]) expect(text).not.toContain(AMAP_TEST_SERVICE_KEY);
  });

  it("查的时候高德说 Key 不认：连接状态变成出错（要重新填）；之后国内改走 OpenStreetMap，不再发给高德", async () => {
    const { fake, k } = await setup();
    await configure(k, { serviceKey: AMAP_TEST_SERVICE_KEY });
    // 秘书已经装配好的那一份
    const route = mapTools(k).find((t) => t.spec.name === MAP_TOOL.route)!;
    fake.state.fail = { infocode: "10001", info: "INVALID_USER_KEY" };
    const out = await route.run({ from: "家", to: "公司" } as never, { toolCallId: key() });
    expect(out.text).toContain("高德不认填的 Web 服务 Key");
    expect(source(k)).toMatchObject({ connection: "error", needsAuth: true });
    expect(source(k).problem).toContain("查地点和路线：高德不认这个 Key");
    // 工具还在；再查国内的走 OpenStreetMap
    expect(mapTools(k)).toHaveLength(5);
    const before = fake.requests.length;
    const again = await route.run({ from: "家", to: "公司", modes: ["driving"] } as never, { toolCallId: key() });
    expect(again.text).toContain("数据来自 OpenStreetMap");
    expect(fake.requests.length).toBe(before);
  });

  it("试查一下：搜固定的地点（不是你的位置），列出来、写明数据来自高德和这个月的用量", async () => {
    const { fake, k } = await setup();
    await configure(k, { serviceKey: AMAP_TEST_SERVICE_KEY });
    const result = await k.dataSources.live(AMAP_SOURCE_ID, {});
    expect(result.state).toBe("ok");
    const req = fake.requests.at(-1)!;
    expect(req.path).toBe("/v5/place/text");
    expect(req.query.get("keywords")).toBe("天安门");
    expect(req.query.get("region")).toBe("北京");
    expect(result.scope).toBe("试查：在北京搜「天安门」（固定的词，不是你的位置）");
    expect(result.items[0]).toMatchObject({ title: "示例湿地公园", subtitle: "浙江省杭州市西湖区 · 示例天目山路 518 号 · 公园" });
    expect(result.notes).toEqual(["通了：查地点、算路线能用。数据来自高德，现查的，不存", "这个月已查：搜地点 1 / 5000 次，地址和路线 0 / 150000 次（高德个人认证档每月的免费量，以高德控制台为准）"]);
    // 高德说超额：写清楚
    fake.state.fail = { infocode: "10044", info: "USER_DAILY_QUERY_OVER_LIMIT" };
    const over = await k.dataSources.live(AMAP_SOURCE_ID, {});
    expect(over).toMatchObject({ state: "error", problem: "高德说用量到上限了（USER_DAILY_QUERY_OVER_LIMIT 10044）：明天再试，或者到高德控制台看看用量" });
  });

  it("试查一下：只填了地图那一组时说先填 Web 服务 Key，不发请求", async () => {
    const { fake, k } = await setup();
    await configure(k, { jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE });
    const before = fake.requests.length;
    const result = await k.dataSources.live(AMAP_SOURCE_ID, {});
    expect(result).toMatchObject({ state: "error", problem: "还没填 Web 服务 Key：在上面填好、测试并保存后再试" });
    expect(fake.requests.length).toBe(before);
  });

  it("移除并连数据删：插件自己的存储（用量）一起删", async () => {
    const { k } = await setup();
    await configure(k, { serviceKey: AMAP_TEST_SERVICE_KEY });
    await run(k, MAP_TOOL.search, { keyword: "咖啡" });
    expect(fs.existsSync(path.join(k.dir, MAP_DATA_DIR))).toBe(true);
    const info = k.host.info().find((p) => p.name === MAP_PLUGIN)!;
    expect(info.removal?.deletes).toContain("记下的每月查地点、算路线的次数");
    await k.settings.act(MAP_PLUGIN, { action: "remove", purgeData: true, idempotencyKey: key() });
    expect(fs.existsSync(path.join(k.dir, MAP_DATA_DIR))).toBe(false);
  });
});

describe("体检项（接 409 的 ctx.doctor）", () => {
  it("插件宿主有 ctx.doctor 时登记\"高德的用量\"（只读、不联网），没有时不登记", () => {
    const registered: Array<{ id: string; title: string; cost: string; run(signal: AbortSignal): unknown }> = [];
    const finding = { level: "warn" as const, fact: { key: "map.doctor.usage.near" } };
    expect(registerAmapDoctor({ doctor: { register: (c: (typeof registered)[number]) => (registered.push(c), () => {}) } }, () => finding)).toBe(true);
    expect(registered.map((c) => [c.id, c.title, c.cost])).toEqual([[AMAP_USAGE_CHECK, "map.doctor.usage.title", "passive"]]);
    expect(registered[0]!.run(new AbortController().signal)).toBe(finding);
    expect(registerAmapDoctor({}, () => finding)).toBe(false);
  });
});
