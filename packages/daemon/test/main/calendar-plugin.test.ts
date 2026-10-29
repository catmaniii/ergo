// 主切面：日历插件（213 号票，ADR-0027；用户 2026-10-20："把内置浏览器和网页工具，日历和语音这三个拆成插件，其他都不拆"）。
// 走真实的装配路径：经组合根和插件清单起守护进程，停用只经数据目录配置的 plugins.disabled 或设置 · 插件的接口，不手挂插件。
// 日历只是按天合起来看的视图（35 号票），不拥有数据；工作日历、工作日判定、定时作业是内核的，不跟着它停。
// - 默认全开：日历插件在运行，按月取照常（35 号票的 calendar.test.ts 原样过）；设置里看得到：一句话，不带给二狗的工具、卡片，没有"连数据删"；
// - 配置里停用：守护进程照常起（不算降级），按月取回"日历插件没启用"（插件没启用的现有说法）；工作日历照常改；
// - 运行中停用、启用（设置 · 插件）：马上回"日历插件没启用"、启用后马上照常，写进配置；不连带提醒；
// - 提醒插件是可选依赖（wants）：提醒停用时（运行中、配置里）日历照常给工作日判定和定时作业，只是没有提醒；提醒启用后又有；
// - 移除：不能连数据删（日历不拥有数据，211 号票的勾选对它是空的），勾了回"日历插件没有可以一起删的数据"；不勾照常移除、装回。
import fs from "node:fs";
import { type CalendarMonthView, CHANNELS, EVENT_TYPES, nowIso, type PluginStatusEventPayload, type ScheduledJobEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { ManualClock } from "../helpers/clock.ts";
import { reminderService, startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { calendarApi, pluginsApi, workdayApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { ok } from "../helpers/running-task.ts";

const { board: BOARD, cards: CARDS, inbox: INBOX, plugins: PLUGINS, workdayCalendar: WORKDAY } = CHANNELS;

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-08 是周四，上班） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const START = at(10, 8, 8, 0);

let keys = 0;
const act = (url: string, name: string, action: "disable" | "enable" | "remove", purgeData?: boolean) =>
  pluginsApi.act(url, name, { action, ...(purgeData === undefined ? {} : { purgeData }), idempotencyKey: `calendar-plugin-${++keys}` });

/** 数据目录配置文件里的 plugins */
const pluginsConfig = (dataDir: string): unknown => (JSON.parse(fs.readFileSync(dataDirLayout(dataDir).configFile, "utf8")) as { plugins?: unknown }).plugins;

/** 插件频道上收到的状况（最后一条），按插件名 → 状况 */
const lastStatus = (frontend: TestFrontend) =>
  Object.fromEntries((frontend.events({ channel: PLUGINS, type: EVENT_TYPES.pluginStatus }).at(-1)!.payload as PluginStatusEventPayload).plugins.map((p) => [p.name, p.state]));

async function connect(td: TestDaemon): Promise<TestFrontend> {
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [INBOX]: 0, [WORKDAY]: 0, [PLUGINS]: 0 });
  await waitUntil(() => frontend.events({ channel: PLUGINS, type: EVENT_TYPES.pluginStatus }).length >= 1);
  return frontend;
}

/** 一个定时触发的普通任务（每天 09:00 出简报）和一条提醒（10-08 14:00 交报告） */
async function jobAndReminder(td: TestDaemon, frontend: TestFrontend): Promise<void> {
  ok(await frontend.startTask("每天早上出简报\n汇总昨天的新闻，写一份简报 brief.md", "k-briefing", [], "plain", { kind: "schedule", schedule: { kind: "daily", time: "09:00" } }));
  await waitUntil(() => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).some((f) => (f.payload as ScheduledJobEventPayload).change === "registered"), { describe: () => "等触发登记" });
  reminderService(td.daemon).create({ text: "交报告", schedule: { kind: "once", at: nowIso(at(10, 8, 14)) } }, "agent");
}

/** 某一天压成一行：上班或休息、提醒、作业 */
function day(view: CalendarMonthView, date: string): string {
  const d = view.days.find((x) => x.date === date)!;
  return `${d.verdict.workday ? "上班" : "休息"} | 提醒 ${d.reminders.map((r) => r.text).join("、") || "-"} | 作业 ${d.jobs.map((j) => j.title).join("、") || "-"}`;
}

/** 按月取：成了交回这个月，没成交回状态码和原因 */
async function month(url: string, m = "2026-10"): Promise<CalendarMonthView | string> {
  const { status, body } = await calendarApi.month(url, m);
  return status === 200 ? body : `${status} ${body.code}: ${body.message}`;
}

const OFF = "400 bad_request: 日历插件没启用";

describe("日历插件", () => {
  it("默认全开：日历插件在运行、按月取照常；设置里一句话、只带来网页上的页面（守护进程这一半没有工具、卡片、定时作业），没有\"连数据删\"；提醒的\"谁要用它\"里没有日历（可选依赖）", async () => {
    const td = await startTestDaemon({ clock: new ManualClock(START) });
    expect(td.daemon.plugins.running("calendar")).toBe(true);
    const frontend = await connect(td);
    await jobAndReminder(td, frontend);
    const view = await month(td.url);
    expect(typeof view === "string" ? view : day(view, "2026-10-08")).toBe("上班 | 提醒 交报告 | 作业 每天早上出简报");

    const { body } = await pluginsApi.view(td.url);
    const calendar = body.plugins.find((p) => p.name === "calendar");
    expect(calendar).toEqual({
      name: "calendar",
      title: "日历",
      summary: "按月看每天上班还是休息、当天的提醒、定时触发的任务和订阅的外部日历；只是合起来看，不存自己的数据",
      state: "running",
      brings: { tools: [], cards: [], jobs: [] },
      needs: [],
      neededBy: [],
      stopsWith: [],
      startsWith: [],
    });
    expect(body.plugins.find((p) => p.name === "reminders")).toMatchObject({ neededBy: [], stopsWith: [] });
  });

  it("配置里停用：守护进程照常起、不算降级；按月取回\"日历插件没启用\"，插件频道上是停用了；工作日历照常改", async () => {
    const td = await startTestDaemon({ plugins: ["reminders", "memory", "voice", "browsing", "claude-code", "phone", "google", "looki"], clock: new ManualClock(START) });
    expect(td.daemon.plugins.report()).toEqual({ running: ["reminders", "memory", "voice", "browsing", "claude-code", "phone", "google", "looki"], disabled: ["calendar"], skipped: [] });
    const health = (await (await fetch(new URL("/healthz", td.url))).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ status: "ok", reasons: [] });
    expect(await month(td.url)).toBe(OFF);
    const frontend = await connect(td);
    expect(lastStatus(frontend)).toMatchObject({ calendar: "disabled", reminders: "running" });
    expect((await workdayApi.change(td.url, { kind: "mark", date: "2026-10-12", mark: "rest" })).status).toBe(200);
  });

  it("运行中停用、启用（设置 · 插件）：马上回\"日历插件没启用\"、写进配置，提醒照常；启用后马上照常、从配置里拿掉", async () => {
    // 265 号票：给了 clock 时底座默认停掉记忆插件；这里看的是全部插件照常装时的状况和配置，打开
    const td = await startTestDaemon({ clock: new ManualClock(START), memoryPlugin: true });
    const frontend = await connect(td);
    await jobAndReminder(td, frontend);

    const disabled = await act(td.url, "calendar", "disable");
    expect(disabled.status).toBe(200);
    expect(disabled.body.changed).toEqual(["calendar"]);
    expect(await month(td.url)).toBe(OFF);
    await waitUntil(() => lastStatus(frontend).calendar === "disabled");
    expect(lastStatus(frontend)).toMatchObject({ reminders: "running", memory: "running" });
    expect(pluginsConfig(td.dataDir)).toEqual({ disabled: ["calendar"] });
    // 不连带提醒：提醒照常建、到点
    expect(td.daemon.plugins.running("reminders")).toBe(true);
    expect(reminderService(td.daemon).get("r-1")).toMatchObject({ status: "pending" });

    const enabled = await act(td.url, "calendar", "enable");
    expect(enabled.body.changed).toEqual(["calendar"]);
    await waitUntil(() => lastStatus(frontend).calendar === "running");
    expect(pluginsConfig(td.dataDir)).toBeUndefined();
    const view = await month(td.url);
    expect(typeof view === "string" ? view : day(view, "2026-10-08")).toBe("上班 | 提醒 交报告 | 作业 每天早上出简报");
  });

  it("提醒插件停用（运行中）：日历照常，工作日判定和定时作业都在，只是没有提醒；提醒启用后又有", async () => {
    const td = await startTestDaemon({ clock: new ManualClock(START) });
    const frontend = await connect(td);
    await jobAndReminder(td, frontend);

    expect((await act(td.url, "reminders", "disable")).body.changed).toEqual(["reminders"]);
    expect(td.daemon.plugins.running("calendar")).toBe(true);
    const off = await month(td.url);
    if (typeof off === "string") throw new Error(off);
    expect(day(off, "2026-10-08")).toBe("上班 | 提醒 - | 作业 每天早上出简报");
    expect(day(off, "2026-10-10")).toBe("上班 | 提醒 - | 作业 每天早上出简报");
    expect(day(off, "2026-10-11")).toBe("休息 | 提醒 - | 作业 每天早上出简报");
    expect(off.days.every((d) => d.reminders.length === 0)).toBe(true);

    expect((await act(td.url, "reminders", "enable")).body.changed).toEqual(["reminders"]);
    const on = await month(td.url);
    expect(typeof on === "string" ? on : day(on, "2026-10-08")).toBe("上班 | 提醒 交报告 | 作业 每天早上出简报");
  });

  it("提醒插件在配置里停用：日历照常装上（可选依赖不算缺），只是没有提醒", async () => {
    const td = await startTestDaemon({ plugins: ["memory", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki"], clock: new ManualClock(START) });
    expect(td.daemon.plugins.report()).toEqual({ running: ["memory", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki"], disabled: ["reminders"], skipped: [] });
    const view = await month(td.url);
    if (typeof view === "string") throw new Error(view);
    expect(view.days).toHaveLength(31);
    expect(day(view, "2026-10-08")).toBe("上班 | 提醒 - | 作业 -");
    expect(view.days.every((d) => d.reminders.length === 0)).toBe(true);
  });

  it("移除：勾了连数据删回\"日历插件没有可以一起删的数据\"、什么都不动；不勾照常移除（按月取回没启用），装回后照常", async () => {
    // 265 号票：给了 clock 时底座默认停掉记忆插件；这里看的是全部插件照常装时的状况和配置，打开
    const td = await startTestDaemon({ clock: new ManualClock(START), memoryPlugin: true });
    const refused = await act(td.url, "calendar", "remove", true);
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe("日历插件没有可以一起删的数据");
    expect(td.daemon.plugins.running("calendar")).toBe(true);

    const removed = await act(td.url, "calendar", "remove");
    expect(removed.body.changed).toEqual(["calendar"]);
    expect(removed.body.purged).toBeUndefined();
    expect(pluginsConfig(td.dataDir)).toEqual({ removed: ["calendar"] });
    expect(await month(td.url)).toBe(OFF);

    expect((await act(td.url, "calendar", "enable")).body.changed).toEqual(["calendar"]);
    expect(typeof (await month(td.url))).toBe("object");
  });
});
