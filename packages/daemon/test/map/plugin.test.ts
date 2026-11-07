// 地图插件在假内核里（429；startPluginKernel：真的插件宿主、数据源那一层、设置 · 插件那一层），瓦片、高德指向本机的假服务：
// 装上后设置 · 数据源里有"高德地图"、填 Key 先测再存；停用时服务取不到、数据源写"地图插件没启用"、Key 留着；
// 再启用接着用；移除并连数据删：密钥区那一格、瓦片缓存删掉，确认框写明删什么、删不掉什么。
import fs from "node:fs";
import path from "node:path";
import { AMAP_SOURCE_ID } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { createDataSourceSecrets } from "../../src/data-sources/index.ts";
import { MAP, MAP_PLUGIN } from "../../src/map/api.ts";
import { createMapPlugin } from "../../src/map/plugin.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { AMAP_TEST_JS_KEY, AMAP_TEST_SECURITY_CODE, startFakeAmap, startFakeOsm } from "../helpers/fake-map.ts";
import { extraService, startPluginKernel } from "../helpers/plugin-kernel.ts";

let n = 0;
const key = () => `k-${++n}`;
const live = () => new AbortController().signal;

async function setup() {
  const osm = await startFakeOsm();
  const amap = await startFakeAmap();
  const plugin = createMapPlugin({ osmUpstream: osm.url, amapHosts: amap.hosts, timeoutMs: 5000 });
  const k = await startPluginKernel({
    plugins: [plugin],
    services: [
      extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir)),
      extraService(KERNEL.dataSourceSecrets, ({ dir }) => createDataSourceSecrets({ dir: dataDirLayout(dir).dataSourceSecrets, log: () => {} })),
    ],
  });
  return { osm, amap, k };
}
const source = (k: Awaited<ReturnType<typeof setup>>["k"]) => k.dataSources.view().sources.find((s) => s.id === AMAP_SOURCE_ID)!;
const secretFile = (dir: string) => path.join(dataDirLayout(dir).dataSourceSecrets, `${AMAP_SOURCE_ID}.json`);

describe("地图插件", () => {
  it("装上：提供地图服务，设置 · 数据源里有没连的\"高德地图\"，填 Key 先测再存，页面要的设置跟着有了 Key", async () => {
    const { k } = await setup();
    expect(k.host.running(MAP_PLUGIN)).toBe(true);
    expect(source(k)).toMatchObject({ title: "高德地图", connection: "not_connected", usages: [{ usage: "query", on: true }] });
    const map = k.host.service(MAP)!;
    expect(map.config()).toEqual({});
    await k.dataSources.act(AMAP_SOURCE_ID, { action: "configure", values: { jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE }, idempotencyKey: key() });
    expect(source(k)).toMatchObject({ connection: "connected", account: "地图：已填 · 查地点和路线：没填" });
    expect(map.config()).toEqual({ amapKey: AMAP_TEST_JS_KEY });
    // 数据源页上什么地方都没有安全密钥
    expect(JSON.stringify(k.dataSources.view())).not.toContain(AMAP_TEST_SECURITY_CODE);
    expect(k.logs.join("\n")).not.toContain(AMAP_TEST_SECURITY_CODE);
  });

  it("瓦片经它转发、存进数据目录的缓存区", async () => {
    const { osm, k } = await setup();
    const reply = await k.host.service(MAP)!.tile({ source: "osm", z: 1, x: 1, y: 0 }, live());
    expect(reply.status).toBe(200);
    expect(osm.requests).toHaveLength(1);
    expect(fs.existsSync(path.join(dataDirLayout(k.dir).mapTiles, "osm", "1", "1", "0.png"))).toBe(true);
  });

  it("停用：服务取不到，数据源写\"地图插件没启用\"、填不了；Key 留着，再启用接着用", async () => {
    const { k } = await setup();
    await k.dataSources.act(AMAP_SOURCE_ID, { action: "configure", values: { jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE }, idempotencyKey: key() });
    await k.settings.act(MAP_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(k.host.service(MAP)).toBeUndefined();
    expect(source(k)).toMatchObject({ available: false, unavailable: "地图插件没启用" });
    await expect(k.dataSources.act(AMAP_SOURCE_ID, { action: "configure", values: {}, idempotencyKey: key() })).rejects.toThrow("地图插件没启用");
    expect(fs.existsSync(secretFile(k.dir))).toBe(true);
    await k.settings.act(MAP_PLUGIN, { action: "enable", idempotencyKey: key() });
    expect(k.host.service(MAP)!.config()).toEqual({ amapKey: AMAP_TEST_JS_KEY });
  });

  it("断开：Key 从密钥区删掉，页面要的设置里没有 Key 了", async () => {
    const { k } = await setup();
    await k.dataSources.act(AMAP_SOURCE_ID, { action: "configure", values: { jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE }, idempotencyKey: key() });
    await k.dataSources.act(AMAP_SOURCE_ID, { action: "disconnect", purge: false, idempotencyKey: key() });
    expect(fs.existsSync(secretFile(k.dir))).toBe(false);
    expect(k.host.service(MAP)!.config()).toEqual({});
    expect(source(k).connection).toBe("not_connected");
  });

  it("移除并连数据删：密钥区那一格、瓦片缓存、用量、地图卡片删掉；确认框写明删什么、删不掉什么；给秘书查地点、算路线那几个工具（432）和画在地图上（431）、一种卡片", async () => {
    const { k } = await setup();
    await k.dataSources.act(AMAP_SOURCE_ID, { action: "configure", values: { jsKey: AMAP_TEST_JS_KEY, securityCode: AMAP_TEST_SECURITY_CODE }, idempotencyKey: key() });
    await k.host.service(MAP)!.tile({ source: "osm", z: 0, x: 0, y: 0 }, live());
    const info = k.host.info().find((p) => p.name === MAP_PLUGIN)!;
    expect(info.brings).toEqual({ tools: ["查地点", "查路线", "查地址在哪", "查某处的地址", "看常去的地方", "画在地图上"], cards: ["聊天里的地图卡片"], jobs: [] });
    expect(info.removal?.deletes).toEqual(["填过的高德 Key 和安全密钥", "缓存在这台电脑上的地图瓦片", "记下的每月查地点、算路线的次数", "聊天里的地图卡片（卡上的标题、点和路线）"]);
    expect(info.removal?.keeps.join("\n")).toContain("聊天里说到过的地点");
    const result = await k.settings.act(MAP_PLUGIN, { action: "remove", purgeData: true, idempotencyKey: key() });
    expect(result.purged).toMatchObject({ events: 0, files: 2 });
    expect(fs.existsSync(secretFile(k.dir))).toBe(false);
    expect(fs.existsSync(dataDirLayout(k.dir).mapTiles)).toBe(false);
  });
});
