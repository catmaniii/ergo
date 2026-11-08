// 主切面：地图页的二狗（444）。用户在地图页右边的二狗聊天窗里、右下角的二狗悬浮按钮上跟秘书说话，消息带地图上下文
// （send_message 的 map：中心、缩放、底图、看哪一天的足迹、哪张卡片）：
// - 记进消息（MessageEnvelope.map，坐标留 6 位小数），历史分页里也带着；秘书页签里发的不带；
// - 交给秘书的输入后面跟一段：在地图页上说的、看的是哪里（中心、缩放、底图）、哪一天的足迹（选中哪一处）或哪张卡片、
//   "这里"多半指地图看的这一带、用 show_on_map 画给他看；悬浮按钮上的另写回话要短；
// - 地图插件停用后照样能发（消息上照记），但秘书那里没有这段。
// 真实装配路径（startTestDaemon），假模型（faux 剧本：echo_context 把秘书看到的上下文原样说出来），瓦片、高德指向本机的假服务（不联网）。
import { CHANNELS, EVENT_TYPES, type HistoryPage, HTTP_PATHS, type MapContext, type MessageEnvelope, type MessageEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { MAP_PLUGIN } from "../../src/map/api.ts";
import { createMapPlugin } from "../../src/map/plugin.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { stripTimeMarkers } from "../helpers/echo.ts";
import { startFakeAmap, startFakeOsm } from "../helpers/fake-map.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { pluginsApi, requestJson } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";

const { secretary: SECRETARY } = CHANNELS;
const ECHO: FauxStep = { kind: "echo_context" };

const messagesOf = (frontend: TestFrontend): MessageEnvelope[] => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).map((f) => (f.payload as MessageEventPayload).message);
const textOf = (m: MessageEnvelope | undefined) => (m?.parts ?? []).flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
const turnEnds = (frontend: TestFrontend) => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.turnEnd }).map((f) => f.payload as { inputMessageId: string });
/** 秘书这一轮 echo_context 看到的上下文里，最后一条用户输入那一段（去掉时间标记） */
const lastInput = (frontend: TestFrontend) => {
  const echo = stripTimeMarkers(textOf(messagesOf(frontend).filter((m) => m.speaker === "agent").at(-1)));
  return echo.slice(echo.lastIndexOf("[user]"));
};

/** 用户说一句（地图页上发的带 map），等秘书这一轮结束 */
async function tell(frontend: TestFrontend, text: string, map?: MapContext) {
  const sent = await frontend.sendText(text, map ? { map } : {});
  await waitUntil(() => turnEnds(frontend).some((e) => e.inputMessageId === sent.messageId), { timeoutMs: 30_000, describe: () => `等秘书处理完「${text}」` });
  return sent;
}

const LAKE: MapContext = { lat: 30.259612345, lon: 120.143398765, zoom: 14.3333, basemap: "amap" };

describe("地图页的二狗：聊天窗、悬浮按钮里发的消息带地图上下文", () => {
  it("记进消息、交给秘书时写清看的是哪里和哪一天的足迹或哪张卡片；悬浮按钮的另写回话要短；秘书页签里发的不带；地图插件停用后秘书那里没有这段", { timeout: 90_000 }, async () => {
    const osm = await startFakeOsm();
    const amap = await startFakeAmap();
    const td = await startTestDaemon({
      extraPlugins: [createMapPlugin({ osmUpstream: osm.url, amapHosts: amap.hosts, timeoutMs: 5000 })],
      secretary: [ECHO, ECHO, ECHO, ECHO, ECHO],
    });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    // 右边的聊天窗里：看着高德、开着足迹、选中了一处
    const chat = await tell(frontend, "这附近有什么好吃的", { ...LAKE, footprints: { date: "2026-11-07", spot: "公司" } });
    const stored = messagesOf(frontend).find((m) => m.id === chat.messageId);
    // 坐标留 6 位小数、级别 2 位
    expect(stored?.map).toEqual({ lat: 30.259612, lon: 120.143399, zoom: 14.33, basemap: "amap", footprints: { date: "2026-11-07", spot: "公司" } });
    const page = await requestJson<HistoryPage>(td.url, HTTP_PATHS.history(SECRETARY));
    expect(page.body.messages.flatMap((m) => ("message" in m ? [m.message] : [])).find((m) => m.id === chat.messageId)?.map).toEqual(stored?.map);
    let input = lastInput(frontend);
    expect(input).toContain("这附近有什么好吃的");
    expect(input).toContain("这句是用户在二狗的地图页上，右边的二狗聊天窗里说的");
    expect(input).toContain("纬度 30.25961、经度 120.14340（WGS-84），缩放 14.3 级");
    expect(input).toContain("底图是高德地图");
    expect(input).toContain('"足迹"开着，看的是 2026-11-07 那一天的足迹，选中了「公司」');
    expect(input).toContain("不一定是他本人现在的位置");
    expect(input).toContain("show_on_map");
    expect(input).not.toContain("回话要短");

    // 右下角的悬浮按钮上按住说的：看着一张卡片
    await tell(frontend, "这条路要走多久", { lat: 1.2847, lon: 103.8591, zoom: 13, basemap: "osm", card: { id: "c-map-route", title: "从公司到西湖边" }, via: "button", spoken: true });
    input = lastInput(frontend);
    expect(input).toContain("右下角的二狗悬浮按钮上按住说的（语音认出来的字）");
    expect(input).toContain("底图是OpenStreetMap");
    expect(input).toContain("看的是聊天里的一张地图卡片「从公司到西湖边」（卡片 c-map-route）");
    expect(input).toContain("回话要短");
    expect(messagesOf(frontend).at(-2)?.map).toEqual({ lat: 1.2847, lon: 103.8591, zoom: 13, basemap: "osm", card: { id: "c-map-route", title: "从公司到西湖边" }, via: "button", spoken: true });

    // 秘书页签里发的：不带
    const plain = await tell(frontend, "今天天气怎么样");
    expect(messagesOf(frontend).find((m) => m.id === plain.messageId)?.map).toBeUndefined();
    expect(lastInput(frontend)).not.toContain("地图页上");

    // 地图插件停用：照样能发、消息上照记，秘书那里没有这段
    expect((await pluginsApi.act(td.url, MAP_PLUGIN, { action: "disable", idempotencyKey: "t444-off" })).status).toBe(200);
    const off = await tell(frontend, "看看这里", LAKE);
    expect(messagesOf(frontend).find((m) => m.id === off.messageId)?.map).toEqual({ lat: 30.259612, lon: 120.143399, zoom: 14.33, basemap: "amap" });
    input = lastInput(frontend);
    expect(input).toContain("看看这里");
    expect(input).not.toContain("地图页上");
    expect(osm.requests).toEqual([]);
  });
});
