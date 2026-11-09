// 地图服务插槽（445）：
// - 登记表（providers.ts）：编号的写法、不许重、撤掉；给页面的 providers；给查询工具的先后（"自动"按优先级、按登记的区域收窄 covers）、
//   地图上手动选了某一家时它排最前、多管它手动能用的区域；用的不是选的那家时回答里那一句；
// - 假内核里装地图插件和测试用的假"第三家"（helpers/fake-map-provider.ts：大陆外、优先级 50、手动时大陆也能用）：
//   能接进来（页面的 providers 多一家、大陆外的查询走它、体检多一项用量），工具的 map 参数跟着地图走（查不了时退回、说一句），
//   插件停用退回 OpenStreetMap、启用回来；地图插件停了它跟着停；编号和自带的重了装不上；
// - "自动"时高德、OpenStreetMap 的行为一点没变由原来的 lookup-plugin、lookup-tools、amap、plugin 几个测试守着（没改断言）。
import { AMAP_SOURCE_ID } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { createDataSourceSecrets } from "../../src/data-sources/index.ts";
import { MAP, MAP_PLUGIN, MAP_PROVIDERS, type MapProvider } from "../../src/map/api.ts";
import type { LookupProvider } from "../../src/map/lookup.ts";
import { MAP_TOOL } from "../../src/map/lookup-tools.ts";
import { createMapPlugin } from "../../src/map/plugin.ts";
import { createMapProviders } from "../../src/map/providers.ts";
import { PHONE, type PhoneService } from "../../src/phone/api.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { SECRETARY_TARGET } from "../../src/secretary/secretary.ts";
import { startFakeAmapLookup } from "../helpers/fake-amap-lookup.ts";
import { FAKE_WORLD_MAP, FAKE_WORLD_MAP_BROWSER_KEY, FAKE_WORLD_MAP_PLUGIN, fakeWorldMapPlugin } from "../helpers/fake-map-provider.ts";
import { AMAP_TEST_SERVICE_KEY } from "../helpers/fake-map.ts";
import { SG_HERE, startFakeOsmLookup } from "../helpers/fake-osm-lookup.ts";
import { extraService, type PluginKernel, startPluginKernel } from "../helpers/plugin-kernel.ts";

let n = 0;
const key = () => `mp-${++n}`;
const AT = new Date("2026-11-08T09:00:00+08:00");
const HANGZHOU = { lat: 30.2741, lon: 120.1551 };
const SINGAPORE = { lat: 1.2834, lon: 103.8607 };

/** 一家假的查询那一半（只认名字，测先后用） */
const lookupNamed = (id: string): LookupProvider => ({
  id,
  name: id,
  credit: id,
  routeModes: ["driving"],
  defaultModes: ["driving"],
  liveTraffic: false,
  browsesNearby: true,
  covers: () => true,
  searchText: () => Promise.resolve([]),
  searchNear: () => Promise.resolve([]),
  geocode: () => Promise.resolve([]),
  reverse: () => Promise.resolve(undefined),
  route: () => Promise.reject(new Error("no")),
});

const providerOf = (id: string, over: Partial<MapProvider> = {}): MapProvider => {
  const inner = lookupNamed(id);
  return { id, title: id, regions: ["abroad"], priority: 0, ownBasemapOnly: false, basemap: () => ({ ready: true }), lookup: () => ({ ready: true, provider: inner }), ...over };
};

describe("地图服务插槽的登记表", () => {
  it("编号要照写法、不许重、一个区域都不管的不收；撤掉以后再登记同一个编号可以", () => {
    const reg = createMapProviders();
    expect(() => reg.register(providerOf("Google"))).toThrow(/写法不对/);
    expect(() => reg.register(providerOf("x", { regions: [], manualRegions: [] }))).toThrow(/一个区域都不管/);
    const undo = reg.register(providerOf("google"));
    expect(() => reg.register(providerOf("google"))).toThrow(/已经登记过了/);
    undo();
    undo();
    expect(reg.list()).toEqual([]);
    reg.register(providerOf("google"));
    expect(reg.list().map((p) => p.id)).toEqual(["google"]);
  });

  it("给页面的：底图能不能用、浏览器用的 Key、Key 不对的那一句、能不能查；手动区域不写同自动的；按区域的优先级、能不能出预览图（451）", () => {
    const reg = createMapProviders();
    reg.register(
      providerOf("a", {
        regions: ["mainland"],
        priority: 100,
        regionPriority: { abroad: 30 },
        ownBasemapOnly: true,
        basemap: () => ({ ready: true, key: "k" }),
        staticMap: { maxSide: 640, minZoom: 1, maxZoom: 19, datum: "gcj02", get: () => Promise.resolve({ ok: false, failure: "other", reason: "-" }) },
      }),
    );
    reg.register(providerOf("b", { manualRegions: ["abroad", "mainland"], basemap: () => ({ ready: false, problem: "Key 不对" }), lookup: () => ({ ready: false, why: "没填" }) }));
    reg.register(providerOf("c", { basemap: undefined }));
    expect(reg.views()).toEqual([
      { id: "a", title: "a", regions: ["mainland"], manualRegions: ["mainland"], priority: 100, regionPriority: { abroad: 30 }, ownBasemapOnly: true, basemap: true, ready: true, key: "k", lookup: true, preview: true },
      { id: "b", title: "b", regions: ["abroad"], manualRegions: ["abroad", "mainland"], priority: 0, ownBasemapOnly: false, basemap: true, ready: false, problem: "Key 不对", lookup: false, preview: false },
      { id: "c", title: "c", regions: ["abroad"], manualRegions: ["abroad"], priority: 0, ownBasemapOnly: false, basemap: false, ready: false, lookup: true, preview: false },
    ]);
  });

  it("给查询工具的：此刻能查的、优先级大的在前（一样大按登记的先后），covers 按登记的区域收窄；里面那一份没换时交回同一个对象", () => {
    const reg = createMapProviders();
    reg.register(providerOf("osm", { regions: ["mainland", "abroad"], priority: 0 }));
    reg.register(providerOf("amap", { regions: ["mainland"], priority: 100 }));
    reg.register(providerOf("google", { regions: ["abroad"], manualRegions: ["abroad", "mainland"], priority: 50 }));
    reg.register(providerOf("off", { priority: 80, lookup: () => ({ ready: false, why: "没填" }) }));
    const list = reg.lookups();
    expect(list.map((p) => p.id)).toEqual(["amap", "google", "osm"]);
    const [amap, google, osm] = list;
    expect([amap!.covers(HANGZHOU), amap!.covers(SINGAPORE)]).toEqual([true, false]);
    expect([google!.covers(HANGZHOU), google!.covers(SINGAPORE)]).toEqual([false, true]);
    expect([osm!.covers(HANGZHOU), osm!.covers(SINGAPORE)]).toEqual([true, true]);
    expect(google!.regions).toEqual(["abroad"]);
    expect(reg.lookups()[1]).toBe(google);
  });

  it("查询管的区域和底图分开（451 lookupRegions）：高德的底图国内国外都管，查询只管大陆——自动、手动选它都不拿国外的点问它，回答里说它不管大陆以外", () => {
    const reg = createMapProviders();
    reg.register(providerOf("osm", { regions: ["mainland", "abroad"], priority: 0 }));
    reg.register(providerOf("amap", { title: "高德地图", regions: ["mainland", "abroad"], manualRegions: ["mainland", "abroad"], lookupRegions: ["mainland"], priority: 100, regionPriority: { abroad: 30 } }));
    const auto = reg.lookups();
    expect(auto.map((p) => [p.id, p.regions])).toEqual([
      ["amap", ["mainland"]],
      ["osm", ["mainland", "abroad"]],
    ]);
    expect(auto[0]!.covers(SINGAPORE)).toBe(false);
    const chosen = reg.lookups("amap");
    expect(chosen[0]!.regions).toEqual(["mainland"]);
    expect(chosen[0]!.covers(SINGAPORE)).toBe(false);
    expect(chosen[0]!.covers(HANGZHOU)).toBe(true);
    expect(reg.chosenNote("amap", chosen.at(-1)!)).toBe("（地图上用的是高德地图，它不管大陆以外，这里用osm查的。）");
  });

  it("地图上手动选了某一家：它排最前、多管它手动能用的区域；选的查不了、没登记的照\"自动\"；回答里那一句写明为什么", () => {
    const reg = createMapProviders();
    reg.register(providerOf("osm", { regions: ["mainland", "abroad"] }));
    const amapState = { ready: true };
    reg.register(providerOf("amap", { regions: ["mainland"], priority: 100, lookup: () => (amapState.ready ? { ready: true, provider: lookupNamed("amap") } : { ready: false, why: "没填高德的 Web 服务 Key" }) }));
    reg.register(providerOf("google", { title: "谷歌地图", regions: ["abroad"], manualRegions: ["abroad", "mainland"], priority: 50 }));
    const chosen = reg.lookups("google");
    expect(chosen.map((p) => p.id)).toEqual(["google", "amap", "google", "osm"]);
    expect(chosen[0]!.covers(HANGZHOU)).toBe(true);
    expect(reg.lookups("osm")[0]!.id).toBe("osm");
    expect(reg.lookups("nobody").map((p) => p.id)).toEqual(["amap", "google", "osm"]);
    amapState.ready = false;
    expect(reg.lookups("amap").map((p) => p.id)).toEqual(["google", "osm"]);
    const osm = reg.lookups().at(-1)!;
    expect(reg.chosenNote("amap", osm)).toBe("（地图上用的是amap，它现在查不了（没填高德的 Web 服务 Key），这里用osm查的。）");
    expect(reg.chosenNote("amap", reg.lookups()[0]!)).toBe("（地图上用的是amap，它现在查不了（没填高德的 Web 服务 Key），这里用google查的。）");
    amapState.ready = true;
    expect(reg.chosenNote("amap", osm)).toBe("（地图上用的是amap，它不管大陆以外，这里用osm查的。）");
    expect(reg.chosenNote("nobody", osm)).toBe("（地图上选的「nobody」现在没接上，按自动挑的：用osm查的。）");
    expect(reg.chosenNote("osm", osm)).toBeUndefined();
  });
});

/** 假手机插件：只给常去的地方、最近一个位置点（杭州） */
const fakePhone = {
  namedPlaces: () => [
    { id: "place-home", name: "家", lat: 30.2775, lon: 120.1255, radius: 200 },
    { id: "place-work", name: "公司", lat: 30.2525, lon: 120.2055, radius: 300 },
  ],
  latestPoint: () => ({ lat: 30.2801, lon: 120.1302, at: "2026-11-08T08:42:00+08:00" }),
} as unknown as PhoneService;

async function setup(fakeOptions: Parameters<typeof fakeWorldMapPlugin>[0] = {}) {
  const amap = await startFakeAmapLookup();
  const osm = await startFakeOsmLookup();
  const fake = fakeWorldMapPlugin(fakeOptions);
  const k = await startPluginKernel({
    plugins: [createMapPlugin({ amapHosts: amap.hosts, osmHosts: osm.hosts, osmIntervalMs: 0, timeoutMs: 5000 }), fake.plugin],
    at: AT,
    services: [
      extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir)),
      extraService(KERNEL.dataSourceSecrets, ({ dir }) => createDataSourceSecrets({ dir: dataDirLayout(dir).dataSourceSecrets, log: () => {} })),
      extraService(PHONE, () => fakePhone),
    ],
  });
  return { amap, osm, fake, k };
}
const mapTools = (k: PluginKernel) => k.agent.toolsFor(SECRETARY_TARGET).filter((t) => t.spec.name.startsWith("map_"));
const run = (k: PluginKernel, name: string, args: Record<string, unknown>) => mapTools(k).find((t) => t.spec.name === name)!.run(args as never, { toolCallId: key() });
const views = (k: PluginKernel) => k.host.service(MAP)!.providerViews();
const usageChecks = (k: PluginKernel) =>
  k.doctorChecks
    .list()
    .filter((c) => c.plugin === MAP_PLUGIN)
    .map((c) => c.id);

describe("地图服务插槽：假\"第三家\"接进来、停用退回", () => {
  it("接进来：页面的 providers 多一家（带浏览器用的 Key）；大陆外的查询走它、大陆里照旧（没填高德 Key 走 OpenStreetMap）；体检多一项用量；工具说明里提一句", async () => {
    const { amap, osm, fake, k } = await setup();
    expect(k.host.report().running).toContain(FAKE_WORLD_MAP_PLUGIN);
    // 451：高德的底图国外也管（国外的优先级 30，低于假世界地图的 50）
    expect(views(k).map((p) => [p.id, p.regions, p.manualRegions, p.priority, p.ready, p.key])).toEqual([
      ["amap", ["mainland", "abroad"], ["mainland", "abroad"], 100, false, undefined],
      ["osm", ["mainland", "abroad"], ["mainland", "abroad"], 0, true, undefined],
      [FAKE_WORLD_MAP, ["abroad"], ["abroad", "mainland"], 50, true, FAKE_WORLD_MAP_BROWSER_KEY],
    ]);
    expect(usageChecks(k)).toEqual(["amap-usage", "worldmap-usage"]);
    expect(mapTools(k)[0]!.spec.description).toContain("另外大陆以外优先用假世界地图（测试用）");
    // 大陆外：假世界地图（优先级 50 > OpenStreetMap 0），不问 OpenStreetMap
    const abroad = await run(k, MAP_TOOL.search, { near: `${SG_HERE.lat},${SG_HERE.lon}`, keyword: "hawker centre" });
    expect(abroad.text).toContain("假世界地图找到 1 个");
    expect(abroad.text).toContain("编号 worldmap-p");
    expect(osm.requests).toEqual([]);
    expect(fake.state.asked.map((a) => a.kind)).toEqual(["searchNear"]);
    // 大陆里：没填高德的 Key，照旧 OpenStreetMap（假世界地图"自动"时不管大陆）
    const home = await run(k, MAP_TOOL.route, { from: "家", to: "公司", modes: ["driving"] });
    expect(home.text).toContain("数据来自 OpenStreetMap");
    expect(fake.state.asked).toHaveLength(1);
    expect(amap.requests).toEqual([]);
  });

  it("填了高德的 Web 服务 Key：大陆里照旧高德、大陆外假世界地图（高德 100 > 假世界地图 50 > OpenStreetMap 0，各管各的区域）", async () => {
    const { amap, osm, fake, k } = await setup();
    await k.dataSources.act(AMAP_SOURCE_ID, { action: "configure", values: { serviceKey: AMAP_TEST_SERVICE_KEY }, idempotencyKey: key() });
    expect((await run(k, MAP_TOOL.route, { from: "家", to: "公司" })).text).toContain("- 开车：约 35 分钟（高德估的用时）");
    expect(fake.state.asked).toEqual([]);
    expect((await run(k, MAP_TOOL.reverse, { where: `${SINGAPORE.lat},${SINGAPORE.lon}` })).text).toContain("假世界地图上的一处地址");
    expect(osm.requests).toEqual([]);
    expect(amap.requests.length).toBeGreaterThan(0);
    // 451：国外地图上用的是高德（底图）时，查询照旧不问高德（只管大陆），回答里说一句
    const asked = amap.requests.length;
    const abroad = await run(k, MAP_TOOL.reverse, { where: `${SINGAPORE.lat},${SINGAPORE.lon}`, map: "amap" });
    expect(abroad.text).toContain("假世界地图上的一处地址");
    expect(abroad.text).toContain("（地图上用的是高德地图，它不管大陆以外，这里用假世界地图查的。）");
    expect(amap.requests.length).toBe(asked);
  });

  it("跟着地图走（map 参数）：选了假世界地图时大陆里也用它（手动能用）；选了 OpenStreetMap 时大陆外不用它；选的查不了退回、回答里说一句", async () => {
    const { osm, fake, k } = await setup();
    const manual = await run(k, MAP_TOOL.route, { from: "家", to: "公司", map: FAKE_WORLD_MAP });
    expect(manual.text).toContain("数据来自假世界地图");
    expect(manual.text).toContain("- 公交/地铁：约 30 分钟");
    expect(manual.text).not.toContain("地图上用的是");
    expect(fake.state.asked.map((a) => a.kind)).toEqual(["route", "route"]);
    // 地图上用的是 OpenStreetMap：新加坡也用它，不问假世界地图
    const asked = fake.state.asked.length;
    const byOsm = await run(k, MAP_TOOL.reverse, { where: `${SINGAPORE.lat},${SINGAPORE.lon}`, map: "osm" });
    expect(byOsm.text).toContain("OpenStreetMap查的");
    expect(fake.state.asked).toHaveLength(asked);
    expect(osm.requests.map((r) => r.service)).toEqual(["nominatim"]);
    // "auto" 当没写
    expect((await run(k, MAP_TOOL.reverse, { where: `${SINGAPORE.lat},${SINGAPORE.lon}`, map: "auto" })).text).toContain("假世界地图上的一处地址");
    // 假世界地图查不了（没填查询用的 Key）：大陆外退回 OpenStreetMap，说一句
    fake.state.lookup = false;
    const fallback = await run(k, MAP_TOOL.search, { near: `${SG_HERE.lat},${SG_HERE.lon}`, keyword: "hawker centre", map: FAKE_WORLD_MAP });
    expect(fallback.text).toContain("OpenStreetMap找到 4 个");
    expect(fallback.text).toContain("（地图上用的是假世界地图，它现在查不了（没填查询用的 Key），这里用OpenStreetMap查的。）");
    // 页面那边：底图还能用、查不了
    expect(views(k).find((p) => p.id === FAKE_WORLD_MAP)).toMatchObject({ ready: true, lookup: false });
  });

  it("插件停用：页面的 providers、体检项、大陆外的查询都退回 OpenStreetMap；启用回来又接上", async () => {
    const { osm, fake, k } = await setup();
    await k.settings.act(FAKE_WORLD_MAP_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(views(k).map((p) => p.id)).toEqual(["amap", "osm"]);
    expect(usageChecks(k)).toEqual(["amap-usage"]);
    const abroad = await run(k, MAP_TOOL.search, { near: `${SG_HERE.lat},${SG_HERE.lon}`, keyword: "hawker centre" });
    expect(abroad.text).toContain("OpenStreetMap找到 4 个");
    expect(fake.state.asked).toEqual([]);
    expect(mapTools(k)[0]!.spec.description).not.toContain("假世界地图");
    // 地图上还选着它（这台设备记着的）：按自动挑、说一句没接上
    const chosen = await run(k, MAP_TOOL.reverse, { where: `${SINGAPORE.lat},${SINGAPORE.lon}`, map: FAKE_WORLD_MAP });
    expect(chosen.text).toContain("（地图上选的「worldmap」现在没接上，按自动挑的：用OpenStreetMap查的。）");
    expect(osm.requests.length).toBeGreaterThan(0);
    await k.settings.act(FAKE_WORLD_MAP_PLUGIN, { action: "enable", idempotencyKey: key() });
    expect(views(k).map((p) => p.id)).toEqual(["amap", "osm", FAKE_WORLD_MAP]);
    expect(usageChecks(k)).toEqual(["amap-usage", "worldmap-usage"]);
    expect((await run(k, MAP_TOOL.reverse, { where: `${SINGAPORE.lat},${SINGAPORE.lon}` })).text).toContain("假世界地图上的一处地址");
  });

  it("地图插件停用：登记了的插件跟着停（needs，记成停用了）；启用地图插件只回来自带的两家，再启用它才重新登记；直接启用它会连地图插件一起启用", async () => {
    const { k } = await setup();
    await k.settings.act(MAP_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(k.host.report().running).not.toContain(FAKE_WORLD_MAP_PLUGIN);
    expect(k.host.report().disabled).toEqual(expect.arrayContaining([MAP_PLUGIN, FAKE_WORLD_MAP_PLUGIN]));
    expect(k.host.service(MAP)).toBeUndefined();
    await k.settings.act(MAP_PLUGIN, { action: "enable", idempotencyKey: key() });
    expect(views(k).map((p) => p.id)).toEqual(["amap", "osm"]);
    await k.settings.act(FAKE_WORLD_MAP_PLUGIN, { action: "enable", idempotencyKey: key() });
    expect(views(k).map((p) => p.id)).toEqual(["amap", "osm", FAKE_WORLD_MAP]);
    // 两个都停了以后直接启用它：要的地图插件一起启用
    await k.settings.act(MAP_PLUGIN, { action: "disable", idempotencyKey: key() });
    await k.settings.act(FAKE_WORLD_MAP_PLUGIN, { action: "enable", idempotencyKey: key() });
    expect(k.host.report().running).toEqual(expect.arrayContaining([MAP_PLUGIN, FAKE_WORLD_MAP_PLUGIN]));
    expect(views(k).map((p) => p.id)).toEqual(["amap", "osm", FAKE_WORLD_MAP]);
  });

  it("编号和自带的重了（osm）：这个插件装配出错、没装上，地图插件照常", async () => {
    const amap = await startFakeAmapLookup();
    const clash: MapProvider = { ...fakeWorldMapPlugin().provider, id: "osm" };
    const k = await startPluginKernel({
      plugins: [
        createMapPlugin({ amapHosts: amap.hosts, osmIntervalMs: 0, timeoutMs: 5000 }),
        {
          name: FAKE_WORLD_MAP_PLUGIN,
          title: "撞号的",
          needs: [MAP_PROVIDERS],
          setup(ctx) {
            const slot = ctx.use(MAP_PROVIDERS);
            ctx.effect(() => slot.register(clash));
          },
        },
      ],
      at: AT,
      services: [extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir)), extraService(KERNEL.dataSourceSecrets, ({ dir }) => createDataSourceSecrets({ dir: dataDirLayout(dir).dataSourceSecrets, log: () => {} }))],
    });
    expect(k.host.report().skipped.find((s) => s.plugin === FAKE_WORLD_MAP_PLUGIN)?.reason).toContain("已经登记过了");
    expect(k.host.report().running).toContain(MAP_PLUGIN);
    expect(views(k).map((p) => p.id)).toEqual(["amap", "osm"]);
  });
});
