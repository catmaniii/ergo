// 地图插件和两家地图服务插件在假内核里（429；455 起 OpenStreetMap、高德各是一个插件；startPluginKernel：真的插件宿主、
// 数据源那一层、设置 · 插件那一层），瓦片、高德指向本机的假服务：
// - 装上：三个都在跑；设置 · 数据源里"高德地图"是高德插件的，填 Key 先测再存，页面要的设置（providers）里高德那一家跟着有了 Key；
//   瓦片经 OpenStreetMap 插件转发、存进数据目录的缓存区；
// - 停用高德：插槽里没有它（页面、秘书的查询退回别家），数据源写"高德地图插件没启用"、填不了；Key 留着，再启用接着用；
//   停用 OpenStreetMap：瓦片回 404"没接上"；停用地图插件：两家跟着停（needs 的规矩）；
// - 断开高德：Key 从密钥区删掉，页面要的设置里没有 Key 了；
// - 移除并连数据删：各删各的——地图插件删地图卡片；OpenStreetMap 删瓦片缓存；高德删密钥区那一格、用量（连同 455 以前记在地图插件名下的）。
import fs from "node:fs";
import path from "node:path";
import { AMAP_SOURCE_ID } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { AMAP_PLUGIN } from "../../src/amap/api.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { createDataSourceSecrets } from "../../src/data-sources/index.ts";
import { MAP, MAP_PLUGIN } from "../../src/map/api.ts";
import { OPENSTREETMAP_PLUGIN } from "../../src/openstreetmap/api.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { AMAP_TEST_JS_KEY, AMAP_TEST_SECURITY_CODE, startFakeAmap, startFakeOsm } from "../helpers/fake-map.ts";
import { mapPlugins } from "../helpers/map-plugins.ts";
import { extraService, startPluginKernel } from "../helpers/plugin-kernel.ts";

let n = 0;
const key = () => `k-${++n}`;
const live = () => new AbortController().signal;

async function setup() {
  const osm = await startFakeOsm();
  const amap = await startFakeAmap();
  const k = await startPluginKernel({
    plugins: mapPlugins({ osmUpstream: osm.url, amapHosts: amap.hosts, timeoutMs: 5000 }),
    services: [
      extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir)),
      extraService(KERNEL.dataSourceSecrets, ({ dir }) => createDataSourceSecrets({ dir: dataDirLayout(dir).dataSourceSecrets, log: () => {} })),
    ],
  });
  return { osm, amap, k };
}
const source = (k: Awaited<ReturnType<typeof setup>>["k"]) => k.dataSources.view().sources.find((s) => s.id === AMAP_SOURCE_ID)!;
const secretFile = (dir: string) => path.join(dataDirLayout(dir).dataSourceSecrets, `${AMAP_SOURCE_ID}.json`);
/** 页面要的设置里高德那一家的浏览器 Key（没登记、没 Key 是 undefined） */
const amapKeyOf = (k: Awaited<ReturnType<typeof setup>>["k"]) => k.host.service(MAP)!.config().providers?.find((p) => p.id === "amap")?.key;
const ids = (k: Awaited<ReturnType<typeof setup>>["k"]) => (k.host.service(MAP)!.config().providers ?? []).map((p) => p.id);

describe("地图插件和两家地图服务插件", () => {
  it("装上：三个都在跑；设置 · 数据源里有没连的\"高德地图\"，填 Key 先测再存，页面要的设置跟着有了 Key", async () => {
    const { k } = await setup();
    expect([MAP_PLUGIN, OPENSTREETMAP_PLUGIN, AMAP_PLUGIN].map((name) => k.host.running(name))).toEqual([true, true, true]);
    expect(source(k)).toMatchObject({ title: "高德地图", connection: "not_connected", usages: [{ usage: "query", on: true }] });
    const map = k.host.service(MAP)!;
    expect(ids(k)).toEqual(["osm", "amap"]);
    // 455 以前另给的 amapKey、amapProblem 不再给
    expect(Object.keys(map.config())).toEqual(["providers"]);
    expect(amapKeyOf(k)).toBeUndefined();
    await k.dataSources.act(AMAP_SOURCE_ID, { action: "configure", values: { jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE }, idempotencyKey: key() });
    expect(source(k)).toMatchObject({ connection: "connected", account: "地图：已填 · 查地点和路线：没填" });
    expect(amapKeyOf(k)).toBe(AMAP_TEST_JS_KEY);
    // 数据源页上、页面要的设置里什么地方都没有安全密钥
    expect(JSON.stringify(k.dataSources.view())).not.toContain(AMAP_TEST_SECURITY_CODE);
    expect(JSON.stringify(map.config())).not.toContain(AMAP_TEST_SECURITY_CODE);
    expect(k.logs.join("\n")).not.toContain(AMAP_TEST_SECURITY_CODE);
  });

  it("瓦片经 OpenStreetMap 插件转发、存进数据目录的缓存区；停用 OpenStreetMap 后回 404\"没接上\"", async () => {
    const { osm, k } = await setup();
    const reply = await k.host.service(MAP)!.tile({ source: "osm", z: 1, x: 1, y: 0 }, live());
    expect(reply.status).toBe(200);
    expect(osm.requests).toHaveLength(1);
    expect(fs.existsSync(path.join(dataDirLayout(k.dir).mapTiles, "osm", "1", "1", "0.png"))).toBe(true);
    await k.settings.act(OPENSTREETMAP_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(k.host.running(MAP_PLUGIN)).toBe(true);
    expect(ids(k)).toEqual(["amap"]);
    const gone = await k.host.service(MAP)!.tile({ source: "osm", z: 1, x: 1, y: 1 }, live());
    expect(gone.status).toBe(404);
    expect(gone.body.toString()).toContain("没接上");
    expect(osm.requests).toHaveLength(1);
  });

  it("高德的安全密钥代理经地图插件的转发口：拼上安全密钥再转；停用高德后回 404\"没接上\"", async () => {
    const { amap, k } = await setup();
    await k.dataSources.act(AMAP_SOURCE_ID, { action: "configure", values: { jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE }, idempotencyKey: key() });
    amap.requests.length = 0;
    const reply = await k.host.service(MAP)!.proxy("/_AMapService/v3/geocode/regeo", `?key=${AMAP_TEST_JS_KEY}&location=120.15,30.27`, live());
    expect(reply.status).toBe(200);
    expect(new URL(amap.requests[0]!.url, "http://x").searchParams.get("jscode")).toBe(AMAP_TEST_SECURITY_CODE);
    expect((await k.host.service(MAP)!.proxy("/_AMapServiceX/v3", "", live())).status).toBe(404);
    await k.settings.act(AMAP_PLUGIN, { action: "disable", idempotencyKey: key() });
    const gone = await k.host.service(MAP)!.proxy("/_AMapService/v3/geocode/regeo", "", live());
    expect(gone.status).toBe(404);
    expect(amap.requests).toHaveLength(1);
  });

  it("停用高德：插槽里没有它，数据源写\"高德地图插件没启用\"、填不了；Key 留着，再启用接着用", async () => {
    const { k } = await setup();
    await k.dataSources.act(AMAP_SOURCE_ID, { action: "configure", values: { jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE }, idempotencyKey: key() });
    await k.settings.act(AMAP_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(k.host.running(MAP_PLUGIN)).toBe(true);
    expect(ids(k)).toEqual(["osm"]);
    expect(source(k)).toMatchObject({ available: false, unavailable: "高德地图插件没启用" });
    await expect(k.dataSources.act(AMAP_SOURCE_ID, { action: "configure", values: {}, idempotencyKey: key() })).rejects.toThrow("高德地图插件没启用");
    expect(fs.existsSync(secretFile(k.dir))).toBe(true);
    await k.settings.act(AMAP_PLUGIN, { action: "enable", idempotencyKey: key() });
    expect(amapKeyOf(k)).toBe(AMAP_TEST_JS_KEY);
  });

  it("停用地图插件：两家跟着停；再启用地图插件时两家要各自启用（宿主的规矩）", async () => {
    const { k } = await setup();
    await k.settings.act(MAP_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect([MAP_PLUGIN, OPENSTREETMAP_PLUGIN, AMAP_PLUGIN].map((name) => k.host.running(name))).toEqual([false, false, false]);
    expect(k.host.service(MAP)).toBeUndefined();
    expect(source(k)).toMatchObject({ available: false });
    // 直接启用一家会连地图插件一起启用
    await k.settings.act(AMAP_PLUGIN, { action: "enable", idempotencyKey: key() });
    expect([MAP_PLUGIN, AMAP_PLUGIN].map((name) => k.host.running(name))).toEqual([true, true]);
    expect(ids(k)).toContain("amap");
  });

  it("断开高德：Key 从密钥区删掉，页面要的设置里没有 Key 了", async () => {
    const { k } = await setup();
    await k.dataSources.act(AMAP_SOURCE_ID, { action: "configure", values: { jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE }, idempotencyKey: key() });
    await k.dataSources.act(AMAP_SOURCE_ID, { action: "disconnect", purge: false, idempotencyKey: key() });
    expect(fs.existsSync(secretFile(k.dir))).toBe(false);
    expect(amapKeyOf(k)).toBeUndefined();
    expect(source(k).connection).toBe("not_connected");
  });

  it("移除并连数据删：各删各的，确认框写明删什么、删不掉什么；地图插件带查地点、算路线那几个工具（432）和画在地图上（431）、一种卡片", async () => {
    const { k } = await setup();
    await k.dataSources.act(AMAP_SOURCE_ID, { action: "configure", values: { jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE }, idempotencyKey: key() });
    await k.host.service(MAP)!.tile({ source: "osm", z: 0, x: 0, y: 0 }, live());
    const info = (name: string) => k.host.info().find((p) => p.name === name)!;
    expect(info(MAP_PLUGIN).brings).toEqual({ tools: ["查地点", "查路线", "查地址在哪", "查某处的地址", "看常去的地方", "画在地图上"], cards: ["聊天里的地图卡片"], jobs: [] });
    expect(info(MAP_PLUGIN).removal?.deletes).toEqual(["聊天里的地图卡片（卡上的标题、点和路线）"]);
    expect(info(OPENSTREETMAP_PLUGIN).removal?.deletes).toEqual(["缓存在这台电脑上的地图瓦片"]);
    expect(info(AMAP_PLUGIN).removal?.deletes).toEqual(["填过的高德 Key 和安全密钥", "记下的每月查地点、算路线的次数"]);
    for (const name of [MAP_PLUGIN, OPENSTREETMAP_PLUGIN, AMAP_PLUGIN]) expect(info(name).removal?.keeps.join("\n")).toContain("聊天里说到过的地点");
    // 455 以前记在地图插件名下的用量还没挪过来（比如高德这次没启用过）：移除高德时一起删
    const legacy = path.join(k.dir, "map", "amap-usage.json");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ format: 1, months: { "2026-10": { search: 3, lbs: 4 } } }));
    const amapGone = await k.settings.act(AMAP_PLUGIN, { action: "remove", purgeData: true, idempotencyKey: key() });
    expect(amapGone.purged).toMatchObject({ events: 0 });
    expect(fs.existsSync(secretFile(k.dir))).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(dataDirLayout(k.dir).mapTiles)).toBe(true);
    const osmGone = await k.settings.act(OPENSTREETMAP_PLUGIN, { action: "remove", purgeData: true, idempotencyKey: key() });
    expect(osmGone.purged).toMatchObject({ events: 0, files: 1 });
    expect(fs.existsSync(dataDirLayout(k.dir).mapTiles)).toBe(false);
    expect(k.host.running(MAP_PLUGIN)).toBe(true);
    expect(ids(k)).toEqual([]);
  });
});
