// Google 插件的日历订阅（297 号票）在假内核里（startPluginKernel：真的插件宿主、数据源那一层、外部日历的登记表），拉地址用注入的假 fetch，
// 不连 Google：
// - 设置 · 数据源里的 Google · 日历：名字、两种用法（导入每 30 分钟、显示在日历里不进素材）、没连；日历插件不在时写"日历插件没启用"；
// - 填地址：测试连接（拉一遍）→ 存密钥区（事件、日志里没有地址）、马上同步一次（条数按事件数）、几个日历打码列出；
//   地址不对（不是网址、不是 https、拿到的不是日历、404）的写明原因、什么都不存；
// - 同步：只写新的、变了的、没了的；地址失效了写明"地址失效了"、那个日历下面也写着，拉到的照样写；
// - 交给日历的日程：标出来自 Google 哪个日历、重复事件展开、全天的按日期；删掉一个日历它的日程跟着没了；
// - 每隔 30 分钟定期导入：到点同步，什么都没变的不记事件（页面上照样显示上次同步），变了的记；
// - 按需查：现拉问的那几天；拉不到用同步来的那份；没填地址如实说；
// - 断开并删、插件停用：日程没了、外部日历的版本往前挪。
import fs from "node:fs";
import path from "node:path";
import { isDeletedEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { DATA_SOURCE_SYNCED, DATA_SOURCES_CHANNEL } from "../../src/data-sources/index.ts";
import { GOOGLE_CALENDAR_TOOL } from "../../src/google/calendar-tool.ts";
import { GOOGLE_CALENDAR_ITEM, GOOGLE_CHANNEL } from "../../src/google/events.ts";
import { createGooglePlugin } from "../../src/google/plugin.ts";
import { SECRETARY_TARGET } from "../../src/secretary/secretary.ts";
import { fakeCalendarFetch, googleAddress, icsOf, myCalendar, PRIVATE_TOKEN } from "../helpers/fake-ical.ts";
import { KERNEL } from "../../src/plugins/kernel.ts";
import { fakePersonalFiles } from "../helpers/fake-personal-files.ts";
import { extraService, type PluginKernel, startPluginKernel } from "../helpers/plugin-kernel.ts";

const SOURCE = "google-calendar";
const MINE = googleAddress("chenxiao@gmail.com");
const FAMILY = googleAddress("family123@group.calendar.google.com", "private-fedcba9876543210fedcba9876543210");

let keySeq = 0;
const key = () => `g-${++keySeq}`;

async function start(options: { at?: Date } = {}) {
  const remote = fakeCalendarFetch();
  remote.routes.set(MINE, { status: 200, body: myCalendar() });
  // 301 号票起 Google 插件要个人档案（联系人进档案候选）：日历这边用不上，给个假的
  const k = await startPluginKernel({
    plugins: [createGooglePlugin({ fetch: remote.fetch })],
    at: options.at ?? new Date("2026-10-24T09:00:00+08:00"),
    services: [extraService(KERNEL.personalFiles, () => fakePersonalFiles().service)],
  });
  return { k, remote };
}

const sourceOf = (k: PluginKernel) => k.dataSources.view().sources.find((s) => s.id === SOURCE)!;
const configure = (k: PluginKernel, values: Record<string, string>) => k.dataSources.act(SOURCE, { action: "configure", values, idempotencyKey: key() });
/** 交给日历插件的日程（数据源的 calendar()，内核现取；[from, to) 本地时间），压成"日期 时间 标题 · 数据源 · 哪个日历" */
function agenda(k: PluginKernel, from: Date, to: Date): string[] {
  return k.dataSources
    .calendarEvents(from, to)
    .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at) || Number(b.allDay) - Number(a.allDay))
    .map((e) => `${e.at.slice(0, 10)} ${e.allDay ? "全天" : e.at.slice(11, 16)} ${e.title} · ${e.sourceTitle} · ${e.calendar}`);
}
const week = (k: PluginKernel) => agenda(k, new Date(2026, 9, 24), new Date(2026, 10, 3));
/** 事件日志、日志里有没有私密地址 */
function leaked(k: PluginKernel): boolean {
  const events = k.store.readGlobal(0, 1_000_000).some((e) => JSON.stringify(e.payload).includes(PRIVATE_TOKEN));
  return events || k.logs.some((l) => l.includes(PRIVATE_TOKEN));
}
const syncRecords = (k: PluginKernel) => k.store.read(DATA_SOURCES_CHANNEL, 0, DATA_SOURCE_SYNCED).filter((e) => !isDeletedEventPayload(e.payload));

describe("设置 · 数据源里的 Google · 日历", () => {
  it("名字、两种用法（按需查、导入每 30 分钟，显示在日历里不进素材）、没连；日历插件不在时写\"日历插件没启用\"", async () => {
    const { k } = await start();
    expect(sourceOf(k)).toMatchObject({
      title: "Google · 日历",
      plugin: "google",
      pluginTitle: "Google",
      available: true,
      connection: "not_connected",
      usages: [
        { usage: "query", on: true },
        { usage: "import", on: true },
      ],
      sensitive: [],
      count: 0,
      schedule: "每 30 分钟",
      destination: "显示在日历里（只读），不进素材",
      configurable: true,
      note: "日历插件没启用：同步来的事件现在在日历里看不到（照样同步、照样查得到）",
    });
  });
});

describe("填地址", () => {
  it("测试连接后存进密钥区、马上同步一次；页面上打码列出这个日历（名字是日历自己的），事件、日志里没有地址", async () => {
    const { k, remote } = await start();
    const result = await configure(k, { add: MINE });
    expect(result.added).toBe(6);
    const source = result.view.sources.find((s) => s.id === SOURCE)!;
    expect(source).toMatchObject({ connection: "connected", account: "c***@gmail.com", count: 6, lastSync: { trigger: "manual", added: 6 } });
    expect(source.items).toEqual([{ id: expect.stringMatching(/^g[0-9a-f]{10}$/), title: "chenxiao@gmail.com", detail: "calendar.google.com · c***@gmail.com · 6 个事件" }]);
    expect(JSON.stringify(result.view)).not.toContain(PRIVATE_TOKEN);
    expect(fs.readFileSync(path.join(k.layout.dataSourceSecrets, `${SOURCE}.json`), "utf8")).toContain(PRIVATE_TOKEN);
    expect(remote.fetched).toEqual([MINE, MINE]);
    expect(leaked(k)).toBe(false);
  });

  it("起个名字：日历上写\"Google · 工作\"；再加一个共享的日历（不算账号）", async () => {
    const { k, remote } = await start();
    await configure(k, { add: MINE, name: "工作" });
    remote.routes.set(FAMILY, { status: 200, body: icsOf({ name: "家里", events: [["UID:dinner@google.com", "DTSTART:20261025T110000Z", "DTEND:20261025T130000Z", "SUMMARY:家庭聚餐"]] }) });
    const second = await configure(k, { add: FAMILY });
    const source = second.view.sources.find((s) => s.id === SOURCE)!;
    expect(source.items!.map((i) => [i.title, i.detail])).toEqual([
      ["工作", "calendar.google.com · c***@gmail.com · 6 个事件"],
      ["家里", "calendar.google.com · f***@group.calendar.google.com · 1 个事件"],
    ]);
    expect(source).toMatchObject({ account: "c***@gmail.com", count: 7 });
    expect(agenda(k, new Date(2026, 9, 25), new Date(2026, 9, 26))).toEqual(["2026-10-25 全天 小王生日 · Google · 日历 · 工作", "2026-10-25 10:00 看牙 · Google · 日历 · 工作", "2026-10-25 19:00 家庭聚餐 · Google · 日历 · 家里"]);
  });

  it.each([
    ["不是网址", "日历地址", "这不是一个网址：把 Google 日历设置里「iCal 格式的私密地址」整段贴过来"],
    ["不是 https", "http://calendar.google.com/calendar/ical/x/private-1/basic.ics", "地址要以 https:// 开头"],
    ["拿到的不是日历", googleAddress("page@gmail.com"), "这个地址拿到的不是日历：要复制「iCal 格式的私密地址」（以 .ics 结尾）"],
    ["地址失效了", googleAddress("gone@gmail.com"), "地址失效了（Google 回了 404）：可能在 Google 日历里重置过私密地址，去 Google 日历的设置里重新复制「iCal 格式的私密地址」"],
    ["连不上", googleAddress("nowhere@gmail.com"), "连不上（ENOTFOUND）"],
  ])("地址不对（%s）：写明原因、什么都不存", async (_name, address, problem) => {
    const { k, remote } = await start();
    remote.routes.set(googleAddress("page@gmail.com"), { status: 200, body: "<!doctype html><title>登录</title>" });
    remote.routes.set(googleAddress("gone@gmail.com"), { status: 404, body: "Not Found" });
    const result = await configure(k, { add: address });
    expect(result.view.sources.find((s) => s.id === SOURCE)).toMatchObject({ connection: "error", problem, count: 0 });
    expect(fs.existsSync(path.join(k.layout.dataSourceSecrets, `${SOURCE}.json`))).toBe(false);
    expect(k.store.read(GOOGLE_CHANNEL)).toEqual([]);
  });

  it("已经连着时再加一个不对的：照样连着，原因写在出错那一行；之后加对了就清掉", async () => {
    const { k, remote } = await start();
    await configure(k, { add: MINE });
    const wrong = await configure(k, { add: googleAddress("gone@gmail.com") });
    expect(wrong.view.sources.find((s) => s.id === SOURCE)).toMatchObject({ connection: "connected", problem: expect.stringContaining("连不上"), count: 6 });
    remote.routes.set(FAMILY, { status: 200, body: icsOf({ events: [] }) });
    const fixed = await configure(k, { add: FAMILY });
    expect(fixed.view.sources.find((s) => s.id === SOURCE)!.problem).toBeUndefined();
  });

  it("删掉一个日历：它的日程从日历上没了、条数跟着少；最后一个删了就是没连", async () => {
    const { k } = await start();
    await configure(k, { add: MINE });
    expect(week(k)).toContain("2026-10-26 09:00 站会 · Google · 日历 · chenxiao@gmail.com");
    const id = sourceOf(k).items![0]!.id;
    const removed = await configure(k, { remove: id });
    expect(removed.view.sources.find((s) => s.id === SOURCE)).toMatchObject({ connection: "not_connected", count: 0 });
    expect(week(k)).toEqual([]);
    expect(fs.existsSync(path.join(k.layout.dataSourceSecrets, `${SOURCE}.json`))).toBe(false);
  });
});

describe("同步和交给日历的日程", () => {
  it("重复事件展开、改期的按改后的放、取消的那次没有、全天的跨几天、跨时区的换成本地时间", async () => {
    const { k } = await start();
    await configure(k, { add: MINE, name: "我的" });
    expect(week(k)).toEqual([
      "2026-10-25 全天 小王生日 · Google · 日历 · 我的",
      "2026-10-25 10:00 看牙 · Google · 日历 · 我的",
      "2026-10-26 09:00 站会 · Google · 日历 · 我的",
      "2026-10-27 全天 出差 · Google · 日历 · 我的",
      "2026-10-27 21:00 纽约周会 · Google · 日历 · 我的",
      "2026-10-28 14:00 站会（改到下午） · Google · 日历 · 我的",
    ]);
    // 11-02 周一那次取消了（EXDATE）；11-03 起纽约过了夏令时，09:00 是新加坡 22:00
    expect(agenda(k, new Date(2026, 10, 2), new Date(2026, 10, 4))).toEqual(["2026-11-03 22:00 纽约周会 · Google · 日历 · 我的"]);
  });

  it("再同步只写变了的：改了一个、删了一个、加了一个——新进来 2 条，条数对，删掉的日程没了", async () => {
    const { k, remote } = await start();
    await configure(k, { add: MINE });
    const before = k.store.read(GOOGLE_CHANNEL, 0, GOOGLE_CALENDAR_ITEM).length;
    remote.routes.set(MINE, {
      status: 200,
      body: myCalendar({
        drop: ["dentist@google.com"],
        extra: [
          ["UID:dentist2@google.com", "DTSTART:20261026T060000Z", "DTEND:20261026T070000Z", "SUMMARY:看牙（改到周一）"],
          ["UID:new@google.com", "DTSTART;VALUE=DATE:20261031", "SUMMARY:万圣节"],
        ],
      }),
    });
    const synced = await k.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() });
    expect(synced.added).toBe(2);
    expect(k.store.read(GOOGLE_CHANNEL, 0, GOOGLE_CALENDAR_ITEM).length - before).toBe(3);
    expect(synced.view.sources.find((s) => s.id === SOURCE)!.count).toBe(7);
    expect(week(k)).not.toContain("2026-10-25 10:00 看牙 · Google · 日历 · chenxiao@gmail.com");
    expect(week(k)).toEqual(expect.arrayContaining(["2026-10-26 14:00 看牙（改到周一） · Google · 日历 · chenxiao@gmail.com", "2026-10-31 全天 万圣节 · Google · 日历 · chenxiao@gmail.com"]));
    // 什么都没变：新进来 0 条，不写事件
    const again = await k.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() });
    expect(again.added).toBe(0);
    expect(k.store.read(GOOGLE_CHANNEL, 0, GOOGLE_CALENDAR_ITEM).length - before).toBe(3);
  });

  it("地址失效了：同步出错写明\"地址失效了\"、那个日历下面也写着；另一个日历拉到的照样写；出错原因里没有地址", async () => {
    const { k, remote } = await start();
    await configure(k, { add: MINE, name: "工作" });
    remote.routes.set(FAMILY, { status: 200, body: icsOf({ events: [] }) });
    await configure(k, { add: FAMILY, name: "家里" });
    remote.routes.set(MINE, { status: 404, body: "Not Found" });
    remote.routes.set(FAMILY, { status: 200, body: icsOf({ events: [["UID:dinner@google.com", "DTSTART:20261025T110000Z", "SUMMARY:家庭聚餐"]] }) });
    const result = await k.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() });
    const source = result.view.sources.find((s) => s.id === SOURCE)!;
    expect(result.error).toBe("「工作」：地址失效了（Google 回了 404）：可能在 Google 日历里重置过私密地址，去 Google 日历的设置里重新复制「iCal 格式的私密地址」");
    expect(source.lastSync).toMatchObject({ error: result.error });
    expect(source.items!.map((i) => [i.title, i.problem])).toEqual([
      ["工作", expect.stringContaining("地址失效了")],
      ["家里", undefined],
    ]);
    expect(source.count).toBe(7);
    expect(leaked(k)).toBe(false);
    // 还有一个日历拉得到：照样连着（306：只有每个日历都一直不行才算出错）
    expect(source.connection).toBe("connected");
  });

  it("偶尔一次 404 不停（306）：一个日历连着 3 次失效才算它坏了，中间拉到一次就重数", async () => {
    const { k, remote } = await start();
    await configure(k, { add: MINE, name: "工作" });
    const sync = () => k.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() });
    remote.routes.set(MINE, { status: 404, body: "Not Found" });
    await sync();
    await sync();
    expect(sourceOf(k).connection).toBe("connected");
    // 拉到一次：重数
    remote.routes.set(MINE, { status: 200, body: myCalendar() });
    await sync();
    remote.routes.set(MINE, { status: 404, body: "Not Found" });
    await sync();
    await sync();
    expect(sourceOf(k).connection).toBe("connected");
    expect(k.agent.toolsFor(SECRETARY_TARGET).map((t) => t.spec.name)).toContain(GOOGLE_CALENDAR_TOOL);
    // 第三次：出错
    await sync();
    expect(sourceOf(k)).toMatchObject({ connection: "error", problem: expect.stringContaining("地址失效了（Google 回了 404）"), autoRetry: true });
  });

  it("每个日历都连着几次地址失效、没权限（306）：出错（写明哪个日历怎么了），秘书没有\"查 Google 日历\"、定期导入到点不拉；一时拉不到的照样连着；每小时替它再试，地址又好了就回到连着、工具回来", async () => {
    const { k, remote } = await start();
    await configure(k, { add: MINE, name: "工作" });
    remote.routes.set(FAMILY, { status: 200, body: icsOf({ events: [] }) });
    await configure(k, { add: FAMILY, name: "家里" });
    const tools = () => k.agent.toolsFor(SECRETARY_TARGET).map((t) => t.spec.name);
    const sync = () => k.dataSources.act(SOURCE, { action: "sync", idempotencyKey: key() });
    expect(tools()).toContain(GOOGLE_CALENDAR_TOOL);
    // 一个失效、一个一时拉不到：还连着
    remote.routes.set(MINE, { status: 404, body: "Not Found" });
    remote.routes.set(FAMILY, { status: 503, body: "" });
    await sync();
    expect(sourceOf(k).connection).toBe("connected");
    expect(tools()).toContain(GOOGLE_CALENDAR_TOOL);
    // 两个都一直不行，"家里"连着第 3 次：出错
    remote.routes.set(FAMILY, { status: 403, body: "" });
    await sync();
    await sync();
    expect(sourceOf(k).connection).toBe("connected");
    await sync();
    expect(sourceOf(k)).toMatchObject({ connection: "error", problem: expect.stringMatching(/^「工作」：地址失效了（Google 回了 404）.*；「家里」：没有权限读这个日历（Google 回了 403）/), canSync: false, autoRetry: true });
    expect(tools()).not.toContain(GOOGLE_CALENDAR_TOOL);
    expect(leaked(k)).toBe(false);
    // 定期导入到点不拉
    const failedAt = k.clock.now();
    const fetched = remote.fetched.length;
    k.clock.advanceTo(failedAt + 31 * 60_000);
    await k.internalJobs.whenIdle();
    await k.dataSources.whenIdle();
    expect(remote.fetched.length).toBe(fetched);
    // 地址又好了（没重填）：一小时到点再试，回到连着、工具回来，之后定期导入照常拉
    remote.routes.set(MINE, { status: 200, body: myCalendar() });
    remote.routes.set(FAMILY, { status: 200, body: icsOf({ events: [] }) });
    k.clock.advanceTo(failedAt + 61 * 60_000);
    await k.internalJobs.whenIdle();
    await k.dataSources.whenIdle();
    expect(remote.fetched.length).toBe(fetched + 2);
    expect(sourceOf(k).connection).toBe("connected");
    expect(sourceOf(k).autoRetry).toBeUndefined();
    expect(tools()).toContain(GOOGLE_CALENDAR_TOOL);
    k.clock.advanceTo(failedAt + 95 * 60_000);
    await k.internalJobs.whenIdle();
    await k.dataSources.whenIdle();
    expect(remote.fetched.length).toBeGreaterThan(fetched + 2);
  });
});

describe("每 30 分钟定期导入", () => {
  it("到点同步；什么都没变的那次不记事件、页面上照样显示上次同步；变了的记下来", async () => {
    const { k, remote } = await start();
    await configure(k, { add: MINE });
    expect(syncRecords(k)).toHaveLength(1);
    // 30 分钟后：没变
    k.clock.advanceTo(new Date("2026-10-24T09:31:00+08:00"));
    await k.internalJobs.whenIdle();
    await k.dataSources.whenIdle();
    expect(remote.fetched).toHaveLength(3);
    expect(syncRecords(k)).toHaveLength(1);
    expect(sourceOf(k).lastSync).toMatchObject({ trigger: "scheduled", added: 0, at: "2026-10-24T09:31:00.000+08:00" });
    // 再过 30 分钟：加了一个
    remote.routes.set(MINE, { status: 200, body: myCalendar({ extra: [["UID:late@google.com", "DTSTART:20261024T120000Z", "SUMMARY:晚饭"]] }) });
    k.clock.advanceTo(new Date("2026-10-24T10:02:00+08:00"));
    await k.internalJobs.whenIdle();
    await k.dataSources.whenIdle();
    expect(syncRecords(k)).toHaveLength(2);
    expect(sourceOf(k)).toMatchObject({ count: 7, lastSync: { trigger: "scheduled", added: 1 } });
  });
});

/** 秘书调"查 Google 日历"，交回结果的文字 */
async function ask(k: PluginKernel, args: Record<string, unknown>): Promise<string> {
  const tool = k.agent.toolsFor(SECRETARY_TARGET).find((t) => t.spec.name === GOOGLE_CALENDAR_TOOL)!;
  return (await tool.run(args as never, { toolCallId: key() })).text;
}

describe("按需查", () => {

  it("秘书有\"查 Google 日历\"：现拉明天的安排（夹在外部数据里）；没填地址时没有这个工具（306）", async () => {
    const { k, remote } = await start();
    expect(k.agent.toolsFor(SECRETARY_TARGET).map((t) => t.spec.name)).not.toContain(GOOGLE_CALENDAR_TOOL);
    await configure(k, { add: MINE, name: "工作" });
    const fetchedBefore = remote.fetched.length;
    const text = await ask(k, { date: "2026-10-25" });
    expect(remote.fetched.length).toBe(fetchedBefore + 1);
    expect(text).toContain("外部数据");
    expect(text).toContain("- 全天 小王生日（Google · 工作）");
    expect(text).toContain("- 10:00–11:00 看牙（Google · 工作；说明：带上医保卡）");
    expect(text).not.toContain("站会");
    // 不填日期是今天（2026-10-24 周六，没有安排）
    expect(await ask(k, {})).toContain("- 没有安排");
    // 几天：出差全天跨三天，每天都列
    const days = await ask(k, { date: "2026-10-27", days: 3 });
    expect(days.match(/出差/g)).toHaveLength(3);
  });

  it("现拉拉不到：用同步来的那份，写明拉不到的原因", async () => {
    const { k, remote } = await start();
    await configure(k, { add: MINE, name: "工作" });
    remote.routes.set(MINE, { status: 503, body: "" });
    const text = await ask(k, { date: "2026-10-25" });
    expect(text).toContain("「工作」现在拉不到（拉日历出错（Google 回了 503），过一会儿再试），下面这个日历用的是上次同步的那份。");
    expect(text).toContain("看牙");
  });

  it("按需查关了：秘书没有这个工具", async () => {
    const { k } = await start();
    await k.dataSources.act(SOURCE, { action: "usage", usage: "query", on: false, idempotencyKey: key() });
    expect(k.agent.toolsFor(SECRETARY_TARGET).map((t) => t.spec.name)).not.toContain(GOOGLE_CALENDAR_TOOL);
  });
});

describe("断开、停用", () => {
  it("断开：留着已导入的条数照样在、日历上不再显示（没有地址了，和手机日历一样）；断开并删：条数归零", async () => {
    const { k } = await start();
    await configure(k, { add: MINE });
    const keepKey = key();
    const kept = await k.dataSources.act(SOURCE, { action: "disconnect", purge: false, idempotencyKey: keepKey });
    expect(kept.view.sources.find((s) => s.id === SOURCE)).toMatchObject({ connection: "not_connected", count: 6 });
    expect(week(k)).toEqual([]);
    const purged = await k.dataSources.act(SOURCE, { action: "disconnect", purge: true, idempotencyKey: key() });
    expect(purged.purged).toMatchObject({ events: expect.any(Number), materials: 0 });
    expect(purged.view.sources.find((s) => s.id === SOURCE)!.count).toBe(0);
    expect(week(k)).toEqual([]);
  });

  it("插件停用：交给日历的日程没有了（内核只问在运行的）；启用回来又有", async () => {
    const { k } = await start();
    await configure(k, { add: MINE });
    await k.settings.act("google", { action: "disable", idempotencyKey: key() });
    expect(week(k)).toEqual([]);
    expect(sourceOf(k)).toMatchObject({ available: false, unavailable: "Google插件没启用" });
    await k.settings.act("google", { action: "enable", idempotencyKey: key() });
    expect(week(k).length).toBeGreaterThan(0);
  });
});
