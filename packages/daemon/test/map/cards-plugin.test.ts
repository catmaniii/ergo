// 地图插件的"画在地图上"和地图卡片（431）在假内核里（startPluginKernel：真的插件宿主、卡片、agent 贡献；手机插件 + 地图插件，
// 瓦片、高德指向本机的假服务；查地点和路线留下的那几份是手写的，经 createMapPlugin 只给测试的 lookups 换掉）：
// - 秘书拿得到 show_on_map（只给秘书）；调一次多一张已处理的地图卡（卡片服务里查得到，负载合 schema）；
// - 查到的那一份经 MAP_DRAWING 按编号取；
// - 停用：秘书手里那个旧工具回"地图插件没启用"、不出卡；卡片类型照样认得（数据契约）；再启用接着用；
// - 移除并连数据删：地图卡片每个版本换成删除标记。
import { CHANNELS, EVENT_TYPES, isDeletedEventPayload, type MapDrawing } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { createDataSourceSecrets } from "../../src/data-sources/index.ts";
import { MAP_DRAWING, MAP_PLUGIN } from "../../src/map/api.ts";
import { mapPlugins } from "../helpers/map-plugins.ts";
import { SHOW_ON_MAP_TOOL } from "../../src/map/show-on-map.ts";
import { phonePlugin } from "../../src/phone/plugin.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { startFakeAmap, startFakeOsm } from "../helpers/fake-map.ts";
import { extraService, startPluginKernel } from "../helpers/plugin-kernel.ts";

let n = 0;
const key = () => `t431-${++n}`;
const secretary = { agent: "secretary", agentId: "secretary", session: "secretary" } as const;
const ROUTE: MapDrawing = {
  id: "amap-r1",
  kind: "route",
  source: "amap",
  title: "从家到公司",
  at: "2026-11-07T08:52:00.000+08:00",
  marks: [{ id: "from", lat: 30.2775, lon: 120.1255, label: "家", kind: "place" }],
  lines: [{ id: "driving", kind: "route", mode: "driving", points: [{ lat: 30.2775, lon: 120.1255 }, { lat: 30.2525, lon: 120.2055 }] }],
};
/** 假的个人档案（手机插件要它，这里用不到） */
const files = { people: () => [], background: () => "", withheld: () => [], onFieldReplaced: () => () => {}, replacedValues: () => [], addCandidates: () => 0, composeCandidates: () => undefined };

async function setup() {
  const osm = await startFakeOsm();
  const amap = await startFakeAmap();
  const k = await startPluginKernel({
    plugins: [phonePlugin, ...mapPlugins({ osmUpstream: osm.url, amapHosts: amap.hosts, timeoutMs: 5000, lookups: () => ({ get: (id) => (id === ROUTE.id ? ROUTE : undefined) }) })],
    services: [
      extraService(KERNEL.layout, ({ dir }) => dataDirLayout(dir)),
      extraService(KERNEL.dataSourceSecrets, ({ dir }) => createDataSourceSecrets({ dir: dataDirLayout(dir).dataSourceSecrets, log: () => {} })),
      extraService(KERNEL.personalFiles, () => files),
    ],
    at: new Date(2026, 10, 7, 9),
  });
  return { k, osm, amap };
}
const showTool = (k: Awaited<ReturnType<typeof setup>>["k"]) => k.agent.toolsFor(secretary).find((t) => t.spec.name === SHOW_ON_MAP_TOOL);
const mapCardEvents = (k: Awaited<ReturnType<typeof setup>>["k"]) =>
  k.store.read(CHANNELS.cards, 0, EVENT_TYPES.card).filter((e) => isDeletedEventPayload(e.payload) || (e.payload as { card: { type: string } }).card.type === "map");

describe("地图插件：画在地图上、地图卡片（431）", () => {
  it("只给秘书；调一次多一张已处理的地图卡；查到的那一份按编号取；画的时候不往外发请求", async () => {
    const { k, osm, amap } = await setup();
    expect(k.agent.toolsFor({ agent: "task", agentId: "tm-1", session: "execution" }).map((t) => t.spec.name)).not.toContain(SHOW_ON_MAP_TOOL);
    const tool = showTool(k)!;
    const out = await tool.run({ points: [{ lat: 30.25, lon: 120.14, label: "西湖" }] }, { toolCallId: "c1" });
    expect(out.isError).toBeUndefined();
    const card = k.cards.get(out.cardIds![0]!)!;
    expect(card).toMatchObject({ type: "map", status: "handled", payload: { show: { kind: "points", marks: [{ label: "西湖" }] } } });
    expect(card.text).toBe("地图卡片：标了 1 处（点开看地图）");

    const route = await tool.run({ lookup: "amap-r1" }, { toolCallId: "c2" });
    expect(k.cards.get(route.cardIds![0]!)!.payload).toEqual({ title: "从家到公司", show: { kind: "lookup", lookup: "amap-r1", what: "route", source: "amap" } });
    expect(k.host.service(MAP_DRAWING)!.drawing("amap-r1")).toBe(ROUTE);
    expect(() => k.host.service(MAP_DRAWING)!.drawing("amap-r2")).toThrow("已经过期了");

    // 没交来过位置的一天：不出卡
    const empty = await tool.run({ date: "2026-11-06" }, { toolCallId: "c3" });
    expect(empty.cardIds).toBeUndefined();
    expect(empty.text).toContain("2026-11-06 没有足迹");
    expect(osm.requests).toEqual([]);
    expect(amap.requests).toEqual([]);
  });

  it("停用：秘书手里的旧工具回\"地图插件没启用\"、不出卡，卡片类型照样认得；再启用接着用", async () => {
    const { k } = await setup();
    const old = showTool(k)!;
    await k.settings.act(MAP_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(showTool(k)).toBeUndefined();
    const off = await old.run({ points: [{ lat: 30.25, lon: 120.14 }] }, { toolCallId: "c1" });
    expect(off.isError).toBe(true);
    expect(off.text).toMatch(/^地图插件没启用/);
    expect(mapCardEvents(k)).toEqual([]);
    expect(k.cardTypes.get("map")).toBeDefined();
    await k.settings.act(MAP_PLUGIN, { action: "enable", idempotencyKey: key() });
    expect((await showTool(k)!.run({ points: [{ lat: 30.25, lon: 120.14 }] }, { toolCallId: "c2" })).cardIds).toHaveLength(1);
  });

  it("移除并连数据删：地图卡片每个版本换成删除标记", async () => {
    const { k } = await setup();
    await showTool(k)!.run({ points: [{ lat: 30.25, lon: 120.14, label: "西湖" }] }, { toolCallId: "c1" });
    await showTool(k)!.run({ lookup: "amap-r1" }, { toolCallId: "c2" });
    expect(mapCardEvents(k)).toHaveLength(2);
    const result = await k.settings.act(MAP_PLUGIN, { action: "remove", purgeData: true, idempotencyKey: key() });
    expect(result.purged).toMatchObject({ cards: 2 });
    const after = mapCardEvents(k);
    expect(after).toHaveLength(2);
    expect(after.every((e) => isDeletedEventPayload(e.payload))).toBe(true);
  });
});
