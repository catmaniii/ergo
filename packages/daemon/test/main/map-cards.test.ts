// 主切面：聊天里的地图卡片（431）。真的守护进程走组合根和插件清单，清单里的地图插件经 extraPlugins 换成同名的、瓦片和高德指向本机的
// 假服务（记下收到的每个请求；不联网），查地点和路线留下的那几份是手写的（432 合进来前经 createMapPlugin 的 lookups 给）；手机插件在清单里。
// App 交来的位置点是编的（杭州的几处），时钟手动拨：
// - 用户说"把我昨天去过的地方画在地图上"：秘书（假模型按剧本）调 show_on_map(date)，聊天里多一条只有卡片引用的消息，卡片是已处理的
//   地图卡、只存日期；工具结果按先后列出待过的几处、叫秘书先说结论；画的时候不往外发请求；
// - 再说"从家到公司怎么走，画在地图上"：调 show_on_map(lookup=amap-r1)，卡上只存编号和标题；
// - GET /api/map/drawing?lookup=：在内存里的交回点和线，没有的 404"过期了"，外网端口要凭证，地图插件停用 400。
import { CHANNELS, type CardEventPayload, type DataSourcePushResult, EVENT_TYPES, type HttpErrorBody, HTTP_PATHS, type MapDrawing, type MessageEventPayload, nowIso, PHONE_LOCATION_SOURCE } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { MAP_PLUGIN } from "../../src/map/api.ts";
import { createMapPlugin } from "../../src/map/plugin.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { startFakeAmap, startFakeOsm } from "../helpers/fake-map.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { dataSourcesApi, mapApi, pluginsApi, request, requestJson, toolCallDetail } from "../helpers/http.ts";

const { secretary: SECRETARY } = CHANNELS;
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const say = (text: string): FauxStep => ({ kind: "reply", text });

let n = 0;
const key = () => `t431-${++n}`;
/** 本地时间 2026 年 11 月 d 日 hh:mm */
const at = (d: number, hh: number, mm = 0) => nowIso(new Date(2026, 10, d, hh, mm));
const HOME = { lat: 30.28, lon: 120.1 };
const LAKE = { lat: 30.259, lon: 120.13 };

/** 每隔 10 分钟一个点：从 from 到 to（含），在 where 附近 */
function every10(d: number, from: [number, number], to: [number, number], where: { lat: number; lon: number }) {
  const out: Array<{ at: string; lat: number; lon: number; accuracy: number }> = [];
  const end = new Date(2026, 10, d, ...to).getTime();
  for (let t = new Date(2026, 10, d, ...from).getTime(), k = 0; t <= end; t += 10 * 60_000, k++) {
    out.push({ at: nowIso(new Date(t)), lat: where.lat + (k % 2 === 0 ? 0.0002 : -0.0002), lon: where.lon + (k % 2 === 0 ? -0.0002 : 0.0002), accuracy: 40 });
  }
  return out;
}

const ROUTE: MapDrawing = {
  id: "amap-r1",
  kind: "route",
  source: "amap",
  title: "从家到公司",
  at: at(7, 8, 52),
  marks: [
    { id: "from", ...HOME, label: "家", kind: "place" },
    { id: "to", lat: 30.2525, lon: 120.2055, label: "公司", kind: "place" },
  ],
  lines: [{ id: "driving", kind: "route", mode: "driving", points: [HOME, { lat: 30.2525, lon: 120.2055 }] }],
};

/** 秘书会话里的卡片引用、工具调用 */
function secretaryParts(frontend: TestFrontend) {
  return frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).flatMap((f) => (f.payload as MessageEventPayload).message.parts);
}
const mapCards = (td: TestDaemon) => td.daemon.store.read(CHANNELS.cards, 0, EVENT_TYPES.card).map((e) => (e.payload as CardEventPayload).card).filter((c) => c.type === "map");

describe("聊天里的地图卡片（假模型调 show_on_map，假瓦片、假高德走真实装配路径）", () => {
  it("画昨天的足迹、画查到的路线：卡片进聊天、只存日期和编号；工具结果叫秘书先说结论；按编号取查到的那一份；不往外发请求", { timeout: 90_000 }, async () => {
    const osm = await startFakeOsm();
    const amap = await startFakeAmap();
    const clock = new ManualClock(new Date(2026, 10, 7, 9));
    const td = await startTestDaemon({
      clock,
      extraPlugins: [createMapPlugin({ osmUpstream: osm.url, amapHosts: amap.hosts, timeoutMs: 5000, lookups: () => ({ get: (id) => (id === ROUTE.id ? ROUTE : undefined) }) })],
      secretary: [call("show_on_map", { date: "2026-11-06" }), say("去了 2 个地方：家、西湖边。"), call("show_on_map", { lookup: "amap-r1" }), say("开车约 35 分钟。")],
    });

    // 11-06：家 08:00–10:00、西湖边 11:00–15:00（带系统地名）、家 17:30–22:00
    const pushed = await requestJson<DataSourcePushResult & HttpErrorBody>(td.url, HTTP_PATHS.dataSourcePush(PHONE_LOCATION_SOURCE), {
      method: "POST",
      body: {
        data: {
          state: "granted",
          link: true,
          background: true,
          points: [...every10(6, [8, 0], [10, 0], HOME), ...every10(6, [11, 0], [15, 0], LAKE).map((p) => ({ ...p, address: { spot: "北山街", district: "西湖区", city: "杭州市" } })), ...every10(6, [17, 30], [22, 0], HOME)],
        },
        idempotencyKey: key(),
      },
    });
    expect(pushed.status).toBe(200);
    expect((await dataSourcesApi.act(td.url, PHONE_LOCATION_SOURCE, { action: "configure", values: { places: "add", name: "家", lat: String(HOME.lat), lon: String(HOME.lon) }, idempotencyKey: key() })).status).toBe(200);
    osm.requests.length = 0;
    amap.requests.length = 0;

    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("把我昨天去过的地方画在地图上");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);

    // 一张已处理的地图卡，只存日期；聊天里有它的引用，排在秘书的回复前面
    const [dayCard] = mapCards(td);
    expect(dayCard).toMatchObject({ type: "map", status: "handled", payload: { show: { kind: "day", date: "2026-11-06" } } });
    expect(dayCard!.text).toBe("地图卡片：11 月 6 日去过的地方（点开看地图）");
    const parts = secretaryParts(frontend);
    const refAt = parts.findIndex((p) => p.type === "card_ref" && p.cardId === dayCard!.id);
    const replyAt = parts.findIndex((p) => p.type === "text" && p.text.includes("去了 2 个地方"));
    expect(refAt).toBeGreaterThanOrEqual(0);
    expect(replyAt).toBeGreaterThan(refAt);
    const showCall = parts.find((p) => p.type === "tool_call" && p.tool === "show_on_map");
    if (showCall?.type !== "tool_call") throw new Error("秘书没调 show_on_map");
    expect(showCall.outcome).toBe("done");
    const result = (await toolCallDetail(td.url, showCall.callId)).body.result;
    expect(result).toContain("这一天待过 2 个地方（按先到的先后）：家（08:00–10:00，17:30–22:00）、杭州市西湖区北山街（11:00–15:00）。");
    expect(result).toContain("回复时先用一句话说结论");
    expect(result).not.toContain("30.28");

    // 查到的路线：卡上只存编号、种类、哪家查的和标题
    await frontend.sendText("从家到公司怎么走，画在地图上");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const routeCard = mapCards(td)[1]!;
    expect(routeCard.payload).toEqual({ title: "从家到公司", show: { kind: "lookup", lookup: "amap-r1", what: "route", source: "amap" } });
    expect(JSON.stringify(routeCard)).not.toContain("120.2055");

    // 按编号取：在内存里的交回点和线，没有的 404，外网端口要凭证
    const drawn = await mapApi.drawing(td.url, "amap-r1");
    expect(drawn.status).toBe(200);
    expect(drawn.body).toEqual(ROUTE);
    const gone = await mapApi.drawing(td.url, "amap-r9");
    expect(gone.status).toBe(404);
    expect(gone.body.message).toContain("已经过期了");
    expect((await request(td.externalUrl, HTTP_PATHS.mapDrawing("amap-r1"))).status).toBe(401);
    // 画卡片、取查到的都不往外发请求
    expect(osm.requests).toEqual([]);
    expect(amap.requests).toEqual([]);

    // 地图插件停用：400"地图插件没启用"
    expect((await pluginsApi.act(td.url, MAP_PLUGIN, { action: "disable", idempotencyKey: key() })).status).toBe(200);
    const off = await mapApi.drawing(td.url, "amap-r1");
    expect(off.status).toBe(400);
    expect(off.body.message).toBe("地图插件没启用");
    await frontend.close();
  });
});
