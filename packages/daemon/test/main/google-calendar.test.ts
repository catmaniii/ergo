// 主切面：Google 插件的日历订阅（297 号票，生活数据源第一波之三）。真的守护进程走组合根和插件清单（Google 插件在清单里），
// 私密 iCal 地址指向本机起的假日历服务（编的 .ics：重复事件、全天跨几天、时区、改期、取消），不连 Google：
// - 设置 · 数据源里填地址（测试连接）→ 马上同步 → 日历插件按月取时每天列出 Google 的日程（重复事件展开对、跨时区换成本地时间、
//   改期的按改后的放、取消的没有、全天跨几天每天都有），经数据源的 calendar()（299 号票定的路）交过去，标出来自 Google · 日历的哪个日历；
// - 秘书问"我明天有什么安排"：调"查 Google 日历"查到明天的看牙和生日；
// - 地址失效了（假服务回 404）：立即同步写明"地址失效了"；
// - 私密地址只在密钥区：事件日志、守护进程日志、数据源页里都没有；
// - 日历插件没启用：数据源页上 Google · 日历写"日历插件没启用"，照样能同步、按需查。
import fs from "node:fs";
import path from "node:path";
import { type CalendarMonthView, CHANNELS, EVENT_TYPES, type MessageEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { myCalendar, PRIVATE_TOKEN, startFakeCalendarServer } from "../helpers/fake-ical.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { calendarApi, dataSourcesApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";

const { secretary: SECRETARY } = CHANNELS;
const SOURCE = "google-calendar";
/** 本地时间 2026-10-24（周六）09:00 */
const START = new Date(2026, 9, 24, 9, 0);
const PATH = `/calendar/ical/chenxiao%40gmail.com/${PRIVATE_TOKEN}/basic.ics`;

let n = 0;
const key = () => `gc-${++n}`;
const echo: FauxStep = { kind: "echo_context" };
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });

/** 某一天的 Google 日程压成一行："全天 出差（Google · 日历 · 工作）、09:00 站会（Google · 日历 · 工作）" */
function googleDay(view: CalendarMonthView, date: string): string {
  const day = view.days.find((d) => d.date === date)!;
  return (day.external ?? []).map((e) => `${e.allDay ? "全天" : e.at.slice(11, 16)} ${e.title}（${e.sourceTitle} · ${e.calendar}）`).join("、") || "-";
}

describe("Google 日历订阅（假日历服务走真实装配路径）", () => {
  it("填地址 → 马上同步 → 日历按天显示（重复、时区、改期、取消、全天）→ 秘书查得到明天的 → 地址失效有提示；地址不出密钥区", { timeout: 90_000 }, async () => {
    const remote = await startFakeCalendarServer();
    remote.routes.set(remote.address(PATH), { status: 200, body: myCalendar() });
    const logs: string[] = [];
    const td = await startTestDaemon({
      clock: new ManualClock(START),
      log: (line) => logs.push(line),
      secretary: [call("query_google_calendar", { date: "2026-10-25" }), echo],
    });
    expect(td.daemon.plugins.report().running).toContain("google");
    const frontend = await TestFrontend.connect(td.url);
    await frontend.subscribe({ [SECRETARY]: 0 });

    // 设置 · 数据源：Google · 日历，没连
    const first = (await dataSourcesApi.view(td.url)).body.sources.find((s) => s.id === SOURCE)!;
    expect(first).toMatchObject({ title: "Google · 日历", plugin: "google", connection: "not_connected", schedule: "每 30 分钟", destination: "显示在日历里（只读），不进素材" });
    expect(first.note).toBeUndefined();

    // 填地址：测试连接、存密钥区、马上同步
    const configured = await dataSourcesApi.act(td.url, SOURCE, { action: "configure", values: { add: remote.address(PATH), name: "工作" }, idempotencyKey: key() });
    expect(configured.status).toBe(200);
    expect(configured.body.added).toBe(6);
    expect(configured.body.view.sources.find((s) => s.id === SOURCE)).toMatchObject({ connection: "connected", account: "c***@gmail.com", count: 6, lastSync: { trigger: "manual", added: 6 } });

    // 日历插件按月取：每天的 Google 日程
    const month = await calendarApi.month(td.url, "2026-10");
    expect(month.status).toBe(200);
    const view = month.body;
    expect(googleDay(view, "2026-10-24")).toBe("-");
    expect(googleDay(view, "2026-10-25")).toBe("全天 小王生日（Google · 日历 · 工作）、10:00 看牙（Google · 日历 · 工作）");
    expect(googleDay(view, "2026-10-26")).toBe("09:00 站会（Google · 日历 · 工作）");
    expect(googleDay(view, "2026-10-27")).toBe("全天 出差（Google · 日历 · 工作）、21:00 纽约周会（Google · 日历 · 工作）");
    expect(googleDay(view, "2026-10-28")).toBe("全天 出差（Google · 日历 · 工作）、14:00 站会（改到下午）（Google · 日历 · 工作）");
    expect(googleDay(view, "2026-10-29")).toBe("全天 出差（Google · 日历 · 工作）");
    expect(googleDay(view, "2026-10-30")).toBe("-");
    expect(googleDay(view, "2026-10-19")).toBe("09:00 站会（Google · 日历 · 工作）");
    // 11 月：11-02 那次站会取消了；纽约过了夏令时，周会变成 22:00
    const november = (await calendarApi.month(td.url, "2026-11")).body;
    expect(googleDay(november, "2026-11-02")).toBe("-");
    expect(googleDay(november, "2026-11-03")).toBe("22:00 纽约周会（Google · 日历 · 工作）");
    expect(googleDay(november, "2026-11-04")).toBe("09:00 站会（Google · 日历 · 工作）");

    // 秘书问明天的安排：调"查 Google 日历"，查到看牙和生日
    await frontend.sendText("我明天有什么安排？");
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).some((f) => JSON.stringify(f.payload).includes("[toolResult] query_google_calendar")), { timeoutMs: 30_000, describe: () => "等秘书查日历" });
    const echoed = frontend
      .events({ channel: SECRETARY, type: EVENT_TYPES.message })
      .map((f) => (f.payload as MessageEventPayload).message.parts.map((p) => (p.type === "text" ? p.text : "")).join(""))
      .find((text) => text.includes("[toolResult] query_google_calendar"))!;
    expect(echoed).toContain("- 全天 小王生日（Google · 工作）");
    expect(echoed).toContain("- 10:00–11:00 看牙（Google · 工作；说明：带上医保卡）");
    expect(echoed).toContain("外部数据");

    // 地址失效了：立即同步写明原因
    remote.routes.set(remote.address(PATH), { status: 404, body: "Not Found" });
    const failed = await dataSourcesApi.act(td.url, SOURCE, { action: "sync", idempotencyKey: key() });
    expect(failed.body.error).toContain("「工作」：地址失效了（Google 回了 404）");
    const after = failed.body.view.sources.find((s) => s.id === SOURCE)!;
    expect(after.lastSync).toMatchObject({ error: failed.body.error });
    expect(after.items?.[0]?.problem).toContain("地址失效了");
    // 同步来的那份照样在日历上
    expect(googleDay((await calendarApi.month(td.url, "2026-10")).body, "2026-10-26")).toBe("09:00 站会（Google · 日历 · 工作）");

    // 私密地址只在密钥区
    const layout = dataDirLayout(td.dataDir);
    expect(fs.readFileSync(path.join(layout.dataSourceSecrets, `${SOURCE}.json`), "utf8")).toContain(PRIVATE_TOKEN);
    expect(td.daemon.store.readGlobal(0, 1_000_000).some((e) => JSON.stringify(e.payload).includes(PRIVATE_TOKEN))).toBe(false);
    expect(logs.some((l) => l.includes(PRIVATE_TOKEN))).toBe(false);
    expect(JSON.stringify((await dataSourcesApi.view(td.url)).body)).not.toContain(PRIVATE_TOKEN);
  });

  it("日历插件没启用：Google · 日历写\"日历插件没启用\"，照样能填地址、同步；按月取回日历插件没启用", { timeout: 60_000 }, async () => {
    const remote = await startFakeCalendarServer();
    remote.routes.set(remote.address(PATH), { status: 200, body: myCalendar() });
    const td = await startTestDaemon({ plugins: ["reminders", "memory", "voice", "browsing", "claude-code", "phone", "google", "looki"], clock: new ManualClock(START) });
    expect(td.daemon.plugins.report()).toMatchObject({ disabled: ["calendar"] });
    const source = (await dataSourcesApi.view(td.url)).body.sources.find((s) => s.id === SOURCE)!;
    expect(source.note).toBe("日历插件没启用：同步来的事件现在在日历里看不到（照样同步、照样查得到）");
    const configured = await dataSourcesApi.act(td.url, SOURCE, { action: "configure", values: { add: remote.address(PATH) }, idempotencyKey: key() });
    expect(configured.body).toMatchObject({ added: 6 });
    expect((await calendarApi.month(td.url, "2026-10")).body).toMatchObject({ code: "bad_request", message: "日历插件没启用" });
  });
});
