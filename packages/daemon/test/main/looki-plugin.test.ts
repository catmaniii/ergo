// 主切面：Looki 插件（296 号票，生活数据源第一波之二；issue 25、调研 38）。真的守护进程走组合根和插件清单，清单里的 Looki 插件经
// extraPlugins 换成同名的、接口地址指向本机假 Looki（helpers/fake-looki.ts，照官方文档的返回格式写的剧本；不连真的 Looki、不联网）：
// - 设置 · 数据源里列出 Looki：没连、两种用法默认开着、每天 02:30 定期导入、用到的敏感内容；
// - 填错 Key → 出错、密钥区里没有；填对 Key、选中国区 → 拿 Key 调中国区的 /me 读账号（一步判断），连着、账号打码带区域，Key 进密钥区；
// - 立即同步：拉到昨天为止的每一天（今天的还在变，不拉），每个时刻一条记录、采成"观察到的本人行为"的素材（时间、场景里的结束时间和地点、
//   来源 looki、敏感类别按记录写窄：时刻是空的），AI 日记采成"别人写给你的"（只进检索：标了情绪、健康，默认不读成证据）；
//   预签名的照片链接哪儿都不存；再同步一次不重复；
// - 秘书用"查 Looki"按日期和时间段现查：找得到昨天下午的时刻；
// - 断开并连已导入的一起删：记录换成"已删除"标记、素材没了、密钥区那一格删掉；
// - Key 不出现在日志、事件、数据源页的回包、秘书的工具结果里；
// - 插件运行中停用：数据源页写"Looki插件没启用"，秘书没有"查 Looki"。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, isDeletedEventPayload, type MessageEventPayload, type ToolCallDetail } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { LOOKI_CHANNEL, LOOKI_JOURNAL, LOOKI_MOMENT, LOOKI_PLUGIN, LOOKI_QUERY_TOOL, LOOKI_SOURCE_ID } from "../../src/looki/api.ts";
import { createLookiPlugin } from "../../src/looki/plugin.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { type FakeLooki, fakeMoment, LOOKI_TEST_KEY, startFakeLooki } from "../helpers/fake-looki.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { dataSourcesApi, pluginsApi, toolCallDetail } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";

const { secretary: SECRETARY } = CHANNELS;
/** 守护进程的"现在"：2026-10-25（周日）上午，昨天是 10-24 */
const NOW = new Date("2026-10-25T10:00:00+08:00");

const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const say = (text: string): FauxStep => ({ kind: "reply", text });
const ECHO: FauxStep = { kind: "echo_context" };
/** 秘书最后一条消息的文字（回显的上下文） */
const lastSecretaryText = (frontend: TestFrontend) =>
  (frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).at(-1)!.payload as MessageEventPayload).message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
/** 回显的上下文里第一条用户消息之前的工具清单 */
const toolsIn = (echo: string) =>
  echo
    .slice(0, echo.indexOf("\n[user]"))
    .split("\n")
    .flatMap((line) => (line.startsWith("[tool] ") ? [line.slice(7)] : []));

let n = 0;
const key = () => `looki-${++n}`;

/** 假 Looki 里放好的：昨天两个时刻（一个带地点）和一篇日记，前天一个时刻 */
function script(fake: FakeLooki) {
  fake.moments.set("2026-10-24", [
    fakeMoment({ id: "m-1", date: "2026-10-24", start: "14:00", end: "16:30", title: "在望京开会", description: "和同事在会议室讨论下季度计划，白板上写满了图", location: "望京 SOHO", media: ["IMAGE", "VIDEO"] }),
    fakeMoment({ id: "m-2", date: "2026-10-24", start: "19:10", end: "19:40", title: "散步回家", description: "沿着河边慢慢走回家" }),
  ]);
  fake.moments.set("2026-10-23", [fakeMoment({ id: "m-0", date: "2026-10-23", start: "12:00", end: "12:50", title: "吃火锅", description: "中午和朋友吃了一顿火锅", location: "海底捞（望京店）" })]);
  fake.journals.push({ id: "j-1", type: "DIARY", title: "忙碌又平静的周六", description: "下午开会，晚上散步", content: "今天下午在望京开了一个很长的会，有点累；晚上沿河散步，心情放松了不少。", recorded_at: "2026-10-24T22:00:00+08:00" });
}

const lookiMaterials = (td: TestDaemon) => td.daemon.materials.list().filter((m) => m.ref.event.channel === LOOKI_CHANNEL);
const everyEventText = (td: TestDaemon) => JSON.stringify(td.daemon.store.readGlobal(0, 1_000_000).map((e) => e.payload));

/** 秘书某个工具最近一次调用的完整返回 */
async function lastResultOf(frontend: TestFrontend, url: string, tool: string): Promise<string> {
  const part = frontend
    .events({ channel: SECRETARY, type: EVENT_TYPES.message })
    .flatMap((f) => (f.payload as MessageEventPayload).message.parts)
    .findLast((p) => p.type === "tool_call" && p.tool === tool);
  if (part?.type !== "tool_call") throw new Error(`没有 ${tool} 的调用`);
  return ((await toolCallDetail(url, part.callId)).body as ToolCallDetail).result;
}

describe("Looki 插件（假 Looki 接口走真实装配路径）", () => {
  it("填 Key → 测试连接 → 拉昨天的时刻成素材 → 秘书查得到 → 断开并删时素材跟着删；Key 不出现在日志、事件、网页里", { timeout: 90_000 }, async () => {
    const fake = await startFakeLooki();
    script(fake);
    const logs: string[] = [];
    const td = await startTestDaemon({
      extraPlugins: [createLookiPlugin({ endpoints: { cn: fake.base, global: fake.base }, rateLimitWaitMs: 20 })],
      clock: new ManualClock(NOW),
      memoryPlugin: true,
      log: (line) => logs.push(line),
      secretary: [call(LOOKI_QUERY_TOOL, { date: "2026-10-24", from: "12:00", to: "18:00" }), say("你昨天下午在望京 SOHO 开会。")],
    });
    const layout = dataDirLayout(td.dataDir);
    expect(td.daemon.plugins.report().running).toContain(LOOKI_PLUGIN);

    // 设置 · 数据源里列出 Looki
    const first = (await dataSourcesApi.view(td.url)).body;
    const looki = first.sources.find((s) => s.id === LOOKI_SOURCE_ID)!;
    expect(looki).toMatchObject({
      title: "Looki",
      plugin: LOOKI_PLUGIN,
      pluginTitle: "Looki",
      available: true,
      connection: "not_connected",
      usages: [
        { usage: "query", on: true },
        { usage: "import", on: true },
      ],
      canSync: false,
      configurable: true,
      schedule: expect.stringContaining("02:30"),
    });
    expect(looki.sensitive.map((c) => c.title)).toEqual(["位置", "情绪", "健康"]);

    // 填错 Key：出错、什么都不存
    const wrong = await dataSourcesApi.act(td.url, LOOKI_SOURCE_ID, { action: "configure", values: { key: "lk-wrong-000000000000", region: "cn" }, idempotencyKey: key() });
    expect(wrong.status).toBe(200);
    const wrongView = wrong.body.view.sources.find((s) => s.id === LOOKI_SOURCE_ID)!;
    expect(wrongView).toMatchObject({ connection: "error", problem: expect.stringContaining("Key") });
    expect(fs.existsSync(path.join(layout.dataSourceSecrets, `${LOOKI_SOURCE_ID}.json`))).toBe(false);

    // 填对 Key：直接拿 Key 调所选区域的 /me 读账号；连着、账号打码带区域
    const configured = await dataSourcesApi.act(td.url, LOOKI_SOURCE_ID, { action: "configure", values: { key: `  ${LOOKI_TEST_KEY} `, region: "cn" }, idempotencyKey: key() });
    const connected = configured.body.view.sources.find((s) => s.id === LOOKI_SOURCE_ID)!;
    expect(connected).toMatchObject({ connection: "connected", canSync: true, account: "d***@example.com（中国区）" });
    expect(connected.problem).toBeUndefined();
    expect(fake.keyed().at(-1)).toMatchObject({ path: "/api/v1/me", key: LOOKI_TEST_KEY });
    expect(fs.readFileSync(path.join(layout.dataSourceSecrets, `${LOOKI_SOURCE_ID}.json`), "utf8")).toContain(LOOKI_TEST_KEY);

    // 立即同步：第一次拉最近 7 天到昨天为止（今天的不拉），三个时刻、一篇日记
    const synced = await dataSourcesApi.act(td.url, LOOKI_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    expect(synced.body).toMatchObject({ added: 4 });
    expect(synced.body.view.sources.find((s) => s.id === LOOKI_SOURCE_ID)).toMatchObject({ count: 4, lastSync: { trigger: "manual", added: 4 } });
    const days = fake.keyed().filter((r) => r.path === "/api/v1/moments").map((r) => r.query.on_date);
    expect(days).toEqual(["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24"]);
    expect(td.daemon.store.read(LOOKI_CHANNEL, 0, LOOKI_MOMENT)).toHaveLength(3);
    expect(td.daemon.store.read(LOOKI_CHANNEL, 0, LOOKI_JOURNAL)).toHaveLength(1);
    // 照片视频不进来：预签名链接哪儿都不存
    expect(everyEventText(td)).not.toContain("X-Amz-Signature");

    // 采成素材：时刻是观察到的本人行为，带时间、场景（结束时间、地点）、来源；AI 日记是别人写给你的
    await waitUntil(() => lookiMaterials(td).length === 4, { timeoutMs: 20_000, describe: () => `素材：${lookiMaterials(td).length}` });
    const meeting = td.daemon.materials.list().find((m) => m.ref.event.channel === LOOKI_CHANNEL && m.origin?.scene.place === "望京 SOHO")!;
    expect(meeting).toMatchObject({
      kind: "observed_behavior",
      time: "2026-10-24T14:00:00.000+08:00",
      origin: { dataSource: LOOKI_SOURCE_ID, scene: { end: "2026-10-24T16:30:00.000+08:00", place: "望京 SOHO" }, sensitive: [] },
    });
    const walk = lookiMaterials(td).find((m) => m.kind === "observed_behavior" && m.time.startsWith("2026-10-24T19:10"))!;
    expect(walk.origin).toEqual({ dataSource: LOOKI_SOURCE_ID, scene: { end: "2026-10-24T19:40:00.000+08:00" }, sensitive: [] });
    const journal = lookiMaterials(td).find((m) => m.kind === "received_writing")!;
    expect(journal.origin).toMatchObject({ dataSource: LOOKI_SOURCE_ID, sensitive: ["emotion", "health"] });

    // 再同步一次：从上次同步那天往前两天拉起，不重复
    const again = await dataSourcesApi.act(td.url, LOOKI_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    expect(again.body).toMatchObject({ added: 0 });
    expect(fake.keyed().filter((r) => r.path === "/api/v1/moments").map((r) => r.query.on_date).slice(days.length)).toEqual(["2026-10-23", "2026-10-24"]);

    // 秘书用"查 Looki"现查昨天下午
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    await frontend.sendText("我昨天下午在干嘛？");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const result = await lastResultOf(frontend, td.url, LOOKI_QUERY_TOOL);
    expect(result).toContain("在望京开会");
    expect(result).toContain("望京 SOHO");
    expect(result).toContain("14:00–16:30");
    expect(result).not.toContain("散步回家");
    expect(result).not.toContain(LOOKI_TEST_KEY);

    // 断开并连已导入的一起删
    const purged = await dataSourcesApi.act(td.url, LOOKI_SOURCE_ID, { action: "disconnect", purge: true, idempotencyKey: key() });
    expect(purged.status).toBe(200);
    // 四条记录、两条同步记录
    expect(purged.body.purged).toMatchObject({ events: 6, materials: 4 });
    expect(purged.body.view.sources.find((s) => s.id === LOOKI_SOURCE_ID)).toMatchObject({ connection: "not_connected", count: 0 });
    expect(td.daemon.store.read(LOOKI_CHANNEL).every((e) => isDeletedEventPayload(e.payload))).toBe(true);
    expect(fs.existsSync(path.join(layout.dataSourceSecrets, `${LOOKI_SOURCE_ID}.json`))).toBe(false);
    await waitUntil(() => lookiMaterials(td).length === 0, { timeoutMs: 20_000, describe: () => `素材：${lookiMaterials(td).length}` });

    // Key 哪儿都没有：日志、事件、数据源页
    expect(logs.some((line) => line.includes(LOOKI_TEST_KEY))).toBe(false);
    expect(everyEventText(td)).not.toContain(LOOKI_TEST_KEY);
    expect(JSON.stringify((await dataSourcesApi.view(td.url)).body)).not.toContain(LOOKI_TEST_KEY);
    expect(JSON.stringify(configured.body)).not.toContain(LOOKI_TEST_KEY);
  });

  it("没连时秘书没有\"查 Looki\"、连上才有（306）；插件运行中停用：数据源页写\"Looki插件没启用\"、不能同步，秘书没有\"查 Looki\"", async () => {
    const fake = await startFakeLooki();
    const td = await startTestDaemon({ extraPlugins: [createLookiPlugin({ endpoints: { cn: fake.base, global: fake.base } })], secretary: [ECHO, ECHO, ECHO] });
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });
    const toolsNow = async () => {
      await frontend.sendText("在吗");
      await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
      return toolsIn(lastSecretaryText(frontend));
    };
    // 306：没填 Key 时秘书没有"查 Looki"，填好连上才有
    expect(await toolsNow()).not.toContain(LOOKI_QUERY_TOOL);
    await dataSourcesApi.act(td.url, LOOKI_SOURCE_ID, { action: "configure", values: { key: LOOKI_TEST_KEY, region: "global" }, idempotencyKey: key() });
    expect((await dataSourcesApi.view(td.url)).body.sources.find((s) => s.id === LOOKI_SOURCE_ID)).toMatchObject({ connection: "connected", account: "d***@example.com（海外）" });
    expect(await toolsNow()).toContain(LOOKI_QUERY_TOOL);
    expect((await pluginsApi.act(td.url, LOOKI_PLUGIN, { action: "disable", idempotencyKey: key() })).status).toBe(200);
    expect((await dataSourcesApi.view(td.url)).body.sources.find((s) => s.id === LOOKI_SOURCE_ID)).toMatchObject({ available: false, unavailable: "Looki插件没启用", canSync: false });
    const refused = await dataSourcesApi.act(td.url, LOOKI_SOURCE_ID, { action: "sync", idempotencyKey: key() });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe("Looki插件没启用");
    expect(await toolsNow()).not.toContain(LOOKI_QUERY_TOOL);
  });
});
