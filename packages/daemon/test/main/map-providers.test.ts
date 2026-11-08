// 主切面：地图服务插槽（445）。真的守护进程走组合根和插件清单，清单里的地图插件经 extraPlugins 换成同名的（OpenStreetMap 指向本机的
// 假 Nominatim、OSRM，不联网），再加一个测试用的假"第三家"插件（helpers/fake-map-provider.ts：大陆外、优先级 50，内存里的假数据）：
// - GET /api/map/config 的 providers：组合根拼进去的，自带两家加上它（只带浏览器用的 Key）；
// - 秘书（假模型按剧本）查新加坡附近的 hawker centre 走它，不问 OpenStreetMap；
// - 经设置 · 插件停用它：providers 退回两家，再查走 OpenStreetMap；
// - 接线（444 的地图上下文 × 445 的 map 参数）：地图页聊天窗里问"这附近有什么"，秘书照交给它的那段把 map 写成地图上用的那一家，
//   查询跟着地图走（国外手动选了 OpenStreetMap 就先问它，不走优先级更高的第三家）。
import { CHANNELS, EVENT_TYPES, type MessageEventPayload, type ToolCallDetail } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { MAP_TOOL } from "../../src/map/lookup-tools.ts";
import { createMapPlugin } from "../../src/map/plugin.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { FAKE_WORLD_MAP, FAKE_WORLD_MAP_BROWSER_KEY, FAKE_WORLD_MAP_PLUGIN, fakeWorldMapPlugin } from "../helpers/fake-map-provider.ts";
import { SG_HERE, startFakeOsmLookup } from "../helpers/fake-osm-lookup.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { mapApi, pluginsApi, toolCallDetail } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";

const { secretary: SECRETARY } = CHANNELS;
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const say = (text: string): FauxStep => ({ kind: "reply", text });
const near = { near: `${SG_HERE.lat},${SG_HERE.lon}`, keyword: "hawker centre" };

let n = 0;
const key = () => `map-providers-${++n}`;

describe("地图服务插槽：假\"第三家\"走真实装配路径", () => {
  it("接进来：GET /api/map/config 多一家、大陆外查询走它；停用它退回 OpenStreetMap", { timeout: 90_000 }, async () => {
    const osm = await startFakeOsmLookup();
    const fake = fakeWorldMapPlugin();
    const td = await startTestDaemon({
      extraPlugins: [createMapPlugin({ osmHosts: osm.hosts, osmIntervalMs: 0, timeoutMs: 5000 }), fake.plugin],
      secretary: [call(MAP_TOOL.search, near), say("找到一家。"), call(MAP_TOOL.search, near), say("找到四家。")],
    });

    const config = (await mapApi.config(td.url)).body;
    expect(config.providers?.map((p) => [p.id, p.priority, p.ready, p.key])).toEqual([
      ["amap", 100, false, undefined],
      ["osm", 0, true, undefined],
      [FAKE_WORLD_MAP, 50, true, FAKE_WORLD_MAP_BROWSER_KEY],
    ]);

    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    /** 说一句、等这一轮完，取这一轮里那次查地点的完整结果 */
    const ask = async (text: string) => {
      await frontend.sendText(text);
      await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
      const part = frontend
        .events({ channel: SECRETARY, type: EVENT_TYPES.message })
        .flatMap((f) => (f.payload as MessageEventPayload).message.parts)
        .findLast((p) => p.type === "tool_call" && p.tool === MAP_TOOL.search);
      if (part?.type !== "tool_call") throw new Error("秘书没调 map_search_places");
      return ((await toolCallDetail(td.url, part.callId)).body as ToolCallDetail).result ?? "";
    };
    const first = await ask("新加坡这儿附近有 hawker centre 吗");
    expect(first).toContain("假世界地图找到 1 个");
    expect(osm.requests).toEqual([]);
    expect(fake.state.asked.map((a) => a.kind)).toEqual(["searchNear"]);

    // 设置 · 插件里停用它：页面的 providers 退回两家，再查走 OpenStreetMap
    const off = await pluginsApi.act(td.url, FAKE_WORLD_MAP_PLUGIN, { action: "disable", idempotencyKey: key() });
    expect(off.status).toBe(200);
    expect((await mapApi.config(td.url)).body.providers?.map((p) => p.id)).toEqual(["amap", "osm"]);
    const second = await ask("再找一下");
    expect(second).toContain("OpenStreetMap找到 4 个");
    expect(fake.state.asked).toHaveLength(1);
  });

  // 接线（base/map-ui）：地图页聊天窗发的消息带的地图上下文里，底图是插槽里那一家的编号（地图切换报上来的"真画着的那一家"）；
  // 交给秘书的那段写明"地图上用的是 X（地图服务编号 id）……把 map 写成"id""，秘书照抄进查询工具的 map，查询跟着地图走。
  // 假模型用 call_with_matches 从用户那条输入（带着输入附注）里抄出编号，模拟"模型照附注填 map"。
  it("地图聊天窗问\"这附近有什么\"：秘书照地图上下文把 map 写成地图上用的那一家，查询跟着地图走（国外手动选了 OSM 就不走优先级更高的那家）", { timeout: 90_000 }, async () => {
    const osm = await startFakeOsmLookup();
    const fake = fakeWorldMapPlugin();
    const copyMap: FauxStep = { kind: "call_with_matches", toolCall: { name: MAP_TOOL.search, arguments: near as never }, argument: "map", pattern: '(?<=map 写成")[a-z][a-z0-9-]{0,19}', from: "user", first: true };
    const td = await startTestDaemon({
      extraPlugins: [createMapPlugin({ osmHosts: osm.hosts, osmIntervalMs: 0, timeoutMs: 5000 }), fake.plugin],
      secretary: [copyMap, say("附近有四家。"), copyMap, say("附近有一家。")],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    /** 在地图页右边的聊天窗里说一句（带地图上下文），等这一轮完，取这一轮里那次查地点的参数和结果 */
    const askOnMap = async (text: string, basemap: string) => {
      const sent = await frontend.sendText(text, { map: { lat: SG_HERE.lat, lon: SG_HERE.lon, zoom: 16, basemap } });
      await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).some((f) => (f.payload as { inputMessageId: string }).inputMessageId === sent.messageId), {
        timeoutMs: 30_000,
        describe: () => `等秘书处理完「${text}」`,
      });
      const part = frontend
        .events({ channel: SECRETARY, type: EVENT_TYPES.message })
        .flatMap((f) => (f.payload as MessageEventPayload).message.parts)
        .findLast((p) => p.type === "tool_call" && p.tool === MAP_TOOL.search);
      if (part?.type !== "tool_call") throw new Error("秘书没调 map_search_places");
      const detail = (await toolCallDetail(td.url, part.callId)).body as ToolCallDetail;
      return { args: detail.args as Record<string, unknown>, result: detail.result };
    };

    // 国外、这台设备手动选了 OpenStreetMap：地图上真画着 osm。按自动本该走优先级 50 的假"第三家"，带了 map 就先问 OpenStreetMap
    const onOsm = await askOnMap("这附近有什么", "osm");
    expect(onOsm.args).toMatchObject({ ...near, map: "osm" });
    expect(onOsm.result).toContain("OpenStreetMap找到 4 个");
    expect(onOsm.result).not.toContain("地图上用的是");
    expect(fake.state.asked).toEqual([]);

    // 换回自动（地图上画的是它）：编号跟着变，查询走它
    const onWorld = await askOnMap("这附近有什么", FAKE_WORLD_MAP);
    expect(onWorld.args).toMatchObject({ ...near, map: FAKE_WORLD_MAP });
    expect(onWorld.result).toContain("假世界地图找到 1 个");
    expect(fake.state.asked.map((a) => a.kind)).toEqual(["searchNear"]);
  });
});
