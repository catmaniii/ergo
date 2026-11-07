// 主切面：地图插件的查地点、算路线（432）。真的守护进程走组合根和插件清单，清单里的地图插件经 extraPlugins 换成同名的、
// 高德指向本机的假高德（helpers/fake-amap-lookup.ts；不连真的高德、不用真 Key、不联网），手机插件是清单里真的那个：
// - 设置 · 数据源 · 高德地图：填 Web 服务 Key 先测再存，按需查默认开；
// - 设置 · 数据源 · 手机 · 位置里给"家""公司"起名；
// - 用户问"从家到公司多久"：秘书（假模型按剧本）调 map_route，起点终点是常去的地方的坐标（GCJ-02 发给高德），结果有开车多久、
//   哪段路堵、公交怎么换乘，写明数据来自高德；
// - 查到的不进事件（除了这次工具调用本身的记录）、不进素材；Key 不出现在日志、事件、数据源页、工具结果里；
// - 试查一下（数据源的 live）走得通。
import { AMAP_SOURCE_ID, CHANNELS, EVENT_TYPES, type MessageEventPayload, PHONE_LOCATION_SOURCE, type ToolCallDetail } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { amapLocation } from "../../src/map/amap-lookup.ts";
import { MAP_TOOL } from "../../src/map/lookup-tools.ts";
import { createMapPlugin } from "../../src/map/plugin.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { startFakeAmapLookup } from "../helpers/fake-amap-lookup.ts";
import { AMAP_TEST_SERVICE_KEY } from "../helpers/fake-map.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { dataSourcesApi, toolCallDetail } from "../helpers/http.ts";

const { secretary: SECRETARY } = CHANNELS;
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const say = (text: string): FauxStep => ({ kind: "reply", text });

let n = 0;
const key = () => `map-lookup-${++n}`;
const HOME = { lat: 30.2775, lon: 120.1255 };
const OFFICE = { lat: 30.2525, lon: 120.2055 };

const everyEventText = (td: TestDaemon) => JSON.stringify(td.daemon.store.readGlobal(0, 1_000_000).map((e) => e.payload));

describe("地图插件：查地点、算路线（假高德走真实装配路径）", () => {
  it("从家到公司多久：家、公司取常去的地方，秘书调 map_route，结果有开车多久、哪段路堵、公交换乘，写明数据来自高德；Key 哪儿都没有", { timeout: 90_000 }, async () => {
    const fake = await startFakeAmapLookup();
    const logs: string[] = [];
    const td = await startTestDaemon({
      extraPlugins: [createMapPlugin({ amapHosts: fake.hosts, timeoutMs: 5000 })],
      log: (line) => logs.push(line),
      secretary: [call(MAP_TOOL.route, { from: "家", to: "公司" }), say("开车约 35 分钟，示例北路有一段拥堵；坐地铁约 52 分钟。")],
    });

    // 填 Web 服务 Key：先测再存；按需查默认开
    const configured = await dataSourcesApi.act(td.url, AMAP_SOURCE_ID, { action: "configure", values: { serviceKey: AMAP_TEST_SERVICE_KEY }, idempotencyKey: key() });
    expect(configured.body.view.sources.find((s) => s.id === AMAP_SOURCE_ID)).toMatchObject({ connection: "connected", usages: [{ usage: "query", on: true }], hasLive: true });

    // 给"家""公司"起名（手机 · 位置下面的常去的地方）
    for (const [name, p] of [["家", HOME], ["公司", OFFICE]] as const) {
      const added = await dataSourcesApi.act(td.url, PHONE_LOCATION_SOURCE, { action: "configure", values: { places: "add", name, lat: String(p.lat), lon: String(p.lon) }, idempotencyKey: key() });
      expect(added.status).toBe(200);
    }

    const before = fake.requests.length;
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("从家到公司多久");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);

    const part = frontend
      .events({ channel: SECRETARY, type: EVENT_TYPES.message })
      .flatMap((f) => (f.payload as MessageEventPayload).message.parts)
      .findLast((p) => p.type === "tool_call" && p.tool === MAP_TOOL.route);
    if (part?.type !== "tool_call") throw new Error("秘书没调 map_route");
    expect(part.outcome).toBe("done");
    const result = ((await toolCallDetail(td.url, part.callId)).body as ToolCallDetail).result;
    expect(result).toContain("从「家」（常去的地方）到「公司」（常去的地方）");
    expect(result).toContain("- 开车：约 35 分钟（高德估的用时），18.2 公里");
    expect(result).toContain("示例北路 拥堵 1.2 公里");
    expect(result).toContain("地铁2号线(示例南--示例北)（示例三路站 上车，示例关站 下车，5 站）");
    expect(result).toContain("数据来自高德，现查的，没存。");

    // 起点终点是常去的地方的坐标（GCJ-02），没拿"家""公司"去搜
    const asked = fake.requests.slice(before);
    expect(asked.find((r) => r.path === "/v5/direction/driving")!.query.get("origin")).toBe(amapLocation(HOME));
    expect(asked.find((r) => r.path === "/v5/direction/driving")!.query.get("destination")).toBe(amapLocation(OFFICE));
    expect(asked.filter((r) => r.path.startsWith("/v5/place"))).toEqual([]);

    // 试查一下
    const tried = await dataSourcesApi.live(td.url, AMAP_SOURCE_ID);
    expect(tried.status).toBe(200);
    expect(tried.body).toMatchObject({ state: "ok", scope: "试查：在北京搜「天安门」（固定的词，不是你的位置）" });

    // 数据源那一块带着这个月的用量
    const panel = (await dataSourcesApi.view(td.url)).body.sources.find((s) => s.id === AMAP_SOURCE_ID)!.panel as { usage: { search: number; lbs: number } };
    expect(panel.usage.search).toBe(1);
    expect(panel.usage.lbs).toBeGreaterThanOrEqual(2);

    // Key 哪儿都没有；查到的路况只在这次工具调用的记录里（聊天记录），不另外记事件
    expect(logs.some((line) => line.includes(AMAP_TEST_SERVICE_KEY))).toBe(false);
    expect(everyEventText(td)).not.toContain(AMAP_TEST_SERVICE_KEY);
    expect(JSON.stringify((await dataSourcesApi.view(td.url)).body)).not.toContain(AMAP_TEST_SERVICE_KEY);
    expect(result).not.toContain(AMAP_TEST_SERVICE_KEY);
    expect(td.daemon.store.readGlobal(0, 1_000_000).filter((e) => e.channel.startsWith("map"))).toEqual([]);
  });
});
