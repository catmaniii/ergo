// 主切面：地图插件的查地点、算路线（432）。真的守护进程走组合根和插件清单，清单里的地图插件经 extraPlugins 换成同名的、
// 高德指向本机的假高德（helpers/fake-amap-lookup.ts；不连真的高德、不用真 Key、不联网），手机插件是清单里真的那个：
// - 设置 · 数据源 · 高德地图：填 Web 服务 Key 先测再存，按需查默认开；
// - 设置 · 数据源 · 手机 · 位置里给"家""公司"起名；
// - 用户问"从家到公司多久"：秘书（假模型按剧本）调 map_route，起点终点是常去的地方的坐标（GCJ-02 发给高德），结果有开车多久、
//   哪段路堵、公交怎么换乘，写明数据来自高德；
// - 查到的不进事件（除了这次工具调用本身的记录）、不进素材；Key 不出现在日志、事件、数据源页、工具结果里；
// - 试查一下（数据源的 live）走得通。
// 433：没填高德的 Key 也有工具；新加坡"酒店附近的 hawker centre"走本机的假 OpenStreetMap（helpers/fake-osm-lookup.ts），不发给高德，
//   结果写明数据来自 OpenStreetMap、带二狗的 User-Agent。
// 436（合并时接上 431 的卡片）：查完路线照工具结果末尾的编号调 show_on_map(lookup)，聊天里出一张路线卡；卡上只存编号，
//   点和线按编号从地图插件内存里那一份（查的时候放进去的）现取，画卡、取点线都不再问高德。
import { AMAP_SOURCE_ID, type CardEventPayload, CHANNELS, EVENT_TYPES, type MessageEventPayload, PHONE_LOCATION_SOURCE, type ToolCallDetail } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { amapLocation } from "../../src/map/amap-lookup.ts";
import { MAP_TOOL } from "../../src/map/lookup-tools.ts";
import { createMapPlugin } from "../../src/map/plugin.ts";
import { SHOW_ON_MAP_TOOL } from "../../src/map/show-on-map.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { startFakeAmapLookup } from "../helpers/fake-amap-lookup.ts";
import { startFakeOsmLookup } from "../helpers/fake-osm-lookup.ts";
import { AMAP_TEST_SERVICE_KEY } from "../helpers/fake-map.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { dataSourcesApi, mapApi, toolCallDetail } from "../helpers/http.ts";

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

  it("没填高德的 Key：新加坡酒店附近的 hawker centre 走 OpenStreetMap，近的在前、写明署名；不发给高德、不记事件", { timeout: 90_000 }, async () => {
    const fake = await startFakeAmapLookup();
    const osm = await startFakeOsmLookup();
    const td = await startTestDaemon({
      extraPlugins: [createMapPlugin({ amapHosts: fake.hosts, osmHosts: osm.hosts, osmIntervalMs: 0, timeoutMs: 5000 })],
      secretary: [call(MAP_TOOL.search, { near: "酒店", keyword: "hawker centre" }), say("酒店走过去最近的是 Maxwell Food Centre，不到 100 米。")],
    });
    // 新加坡的酒店起名"酒店"（手机 · 位置下面的常去的地方）
    const added = await dataSourcesApi.act(td.url, PHONE_LOCATION_SOURCE, { action: "configure", values: { places: "add", name: "酒店", lat: "1.2805", lon: "103.845" }, idempotencyKey: key() });
    expect(added.status).toBe(200);
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("酒店附近有什么 hawker centre");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const part = frontend
      .events({ channel: SECRETARY, type: EVENT_TYPES.message })
      .flatMap((f) => (f.payload as MessageEventPayload).message.parts)
      .findLast((p) => p.type === "tool_call" && p.tool === MAP_TOOL.search);
    if (part?.type !== "tool_call") throw new Error("秘书没调 map_search_places");
    expect(part.outcome).toBe("done");
    const result = ((await toolCallDetail(td.url, part.callId)).body as ToolCallDetail).result;
    expect(result).toContain("在「酒店」（常去的地方）附近 1 公里内找「hawker centre」，OpenStreetMap找到 4 个（近的在前）");
    expect(result).toContain("1. Maxwell Food Centre");
    expect(result).toContain("数据来自 OpenStreetMap（© OpenStreetMap 贡献者");
    expect(fake.requests).toEqual([]);
    expect(osm.requests).toHaveLength(1);
    expect(osm.requests[0]!.ua).toMatch(/^ergo\//);
    expect(td.daemon.store.readGlobal(0, 1_000_000).filter((e) => e.channel.startsWith("map"))).toEqual([]);
  });

  it("查路线再画成卡片：秘书调 map_route，照结果末尾的编号调 show_on_map(lookup)，聊天里出一张路线卡；卡上只存编号，点线按编号现取，不再问高德", { timeout: 90_000 }, async () => {
    const fake = await startFakeAmapLookup();
    const td = await startTestDaemon({
      // 没有 lookups 这一项：卡片取的就是查路线时放进插件内存的那一份
      extraPlugins: [createMapPlugin({ amapHosts: fake.hosts, timeoutMs: 5000 })],
      secretary: [
        call(MAP_TOOL.route, { from: "家", to: "公司" }),
        // 假模型从 map_route 的结果里抄编号（"编号 amap-r1"），当 show_on_map 的 lookup
        { kind: "call_with_matches", toolCall: { name: SHOW_ON_MAP_TOOL, arguments: {} }, argument: "lookup", pattern: "amap-r\\d+", first: true },
        say("开车约 35 分钟，坐地铁约 52 分钟，路线放在卡片上了。"),
      ],
    });
    expect((await dataSourcesApi.act(td.url, AMAP_SOURCE_ID, { action: "configure", values: { serviceKey: AMAP_TEST_SERVICE_KEY }, idempotencyKey: key() })).status).toBe(200);
    for (const [name, p] of [["家", HOME], ["公司", OFFICE]] as const) {
      const added = await dataSourcesApi.act(td.url, PHONE_LOCATION_SOURCE, { action: "configure", values: { places: "add", name, lat: String(p.lat), lon: String(p.lon) }, idempotencyKey: key() });
      expect(added.status).toBe(200);
    }

    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("从家到公司多久，画在地图上");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const asked = fake.requests.length;
    expect(asked).toBeGreaterThan(0);

    const parts = frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).flatMap((f) => (f.payload as MessageEventPayload).message.parts);
    const routeCall = parts.find((p) => p.type === "tool_call" && p.tool === MAP_TOOL.route);
    const showCall = parts.find((p) => p.type === "tool_call" && p.tool === SHOW_ON_MAP_TOOL);
    if (routeCall?.type !== "tool_call" || showCall?.type !== "tool_call") throw new Error("秘书没调 map_route 和 show_on_map");
    expect([routeCall.outcome, showCall.outcome]).toEqual(["done", "done"]);
    // 查路线的结果末尾写着编号和怎么画
    const routed = ((await toolCallDetail(td.url, routeCall.callId)).body as ToolCallDetail).result;
    const id = /编号 (amap-r\d+)（要画在地图上时调 show_on_map，lookup 写它）/.exec(routed)?.[1];
    expect(id).toBe("amap-r1");
    const shown = ((await toolCallDetail(td.url, showCall.callId)).body as ToolCallDetail).result;
    expect(shown).toContain("已在聊天里放了一张地图卡片「从家到公司」（2 个点、2 条路线；卡上写着数据来自哪家）");

    // 一张已处理的地图卡：只存编号、种类、哪家查的和标题，不存点、线；聊天里有它的引用，排在秘书的回复前面
    const cards = td.daemon.store.read(CHANNELS.cards, 0, EVENT_TYPES.card).map((e) => (e.payload as CardEventPayload).card).filter((c) => c.type === "map");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: "handled", payload: { title: "从家到公司", show: { kind: "lookup", lookup: "amap-r1", what: "route", source: "amap" } } });
    for (const c of [HOME.lat, HOME.lon, OFFICE.lat, OFFICE.lon]) expect(JSON.stringify(cards[0])).not.toContain(String(c));
    const refAt = parts.findIndex((p) => p.type === "card_ref" && p.cardId === cards[0]!.id);
    const replyAt = parts.findIndex((p) => p.type === "text" && p.text.includes("路线放在卡片上了"));
    expect(refAt).toBeGreaterThanOrEqual(0);
    expect(replyAt).toBeGreaterThan(refAt);

    // 网页按编号取：两头的点（常去的地方，WGS-84 原样）、开车和公交两条线，就是查的时候那一份
    const drawn = await mapApi.drawing(td.url, "amap-r1");
    expect(drawn.status).toBe(200);
    expect(drawn.body).toMatchObject({ id: "amap-r1", kind: "route", source: "amap", title: "从家到公司", marks: [{ label: "家", lat: HOME.lat, lon: HOME.lon }, { label: "公司", lat: OFFICE.lat, lon: OFFICE.lon }] });
    expect(drawn.body.lines.map((l) => l.mode)).toEqual(["driving", "transit"]);
    // 画卡、取点线都不再问高德
    expect(fake.requests).toHaveLength(asked);
    await frontend.close();
  });
});
