// 主切面：地图服务插槽（445）。真的守护进程走组合根和插件清单，清单里的地图插件经 extraPlugins 换成同名的（OpenStreetMap 指向本机的
// 假 Nominatim、OSRM，不联网），再加一个测试用的假"第三家"插件（helpers/fake-map-provider.ts：大陆外、优先级 50，内存里的假数据）：
// - GET /api/map/config 的 providers：组合根拼进去的，自带两家加上它（只带浏览器用的 Key）；
// - 秘书（假模型按剧本）查新加坡附近的 hawker centre 走它，不问 OpenStreetMap；
// - 经设置 · 插件停用它：providers 退回两家，再查走 OpenStreetMap。
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
});
