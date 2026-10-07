// 主切面：设置里的工作日历（29 号票，规格第 21 节）。
// - 设置接口按月返回每天上班或休息及原因；加删额外规则、把某天标成上班或休息、清掉标记之后，返回的结果随之变化，不用重启；
// - 额外规则和手动标记存在数据目录的配置区（个人数据，不进仓库），每次改动是工作日历频道上的一条事件，多个前端同步；
// - 节假日数据：框架自带的（新加坡 2026、2027，国内 2026）加上导入的；缺数据的年份按周一到周五算，结果标明缺了。
import fs from "node:fs";
import path from "node:path";
import {
  type CardEventPayload,
  CHANNELS,
  type DayVerdict,
  dayReasonLabel,
  EVENT_TYPES,
  type Card,
  type HolidayDataEventPayload,
  type InboxItem,
  type InboxItemEventPayload,
  localDate,
  type MessageEventPayload,
  type QuickActionExecutedEventPayload,
  nowIso,
  type ReminderEventPayload,
  type WorkdaySettingsEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { workdayApi } from "../helpers/http.ts";
import { waitUntil } from "../helpers/process.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { calendar: CALENDAR, secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;
const LAST_SATURDAY = { kind: "last_weekday", weekday: 6 } as const;

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);

/** 某个月里某天的结果：上班还是休息，原因 */
async function dayOf(url: string, date: string): Promise<string[]> {
  const { status, body } = await workdayApi.month(url, date.slice(0, 7));
  expect(status).toBe(200);
  const day = body.days.find((d: DayVerdict) => d.date === date)!;
  return [day.workday ? "上班" : "休息", ...day.reasons.map(dayReasonLabel)];
}

const settingsEvents = (frontend: TestFrontend) => frontend.events({ channel: CALENDAR, type: EVENT_TYPES.workdaySettings }).map((f) => f.payload as WorkdaySettingsEventPayload);

describe("设置接口：按月看，改了马上生效", () => {
  it("按月返回每天上班或休息及原因：新加坡工作日、国内工作日、调休补班、周末，以及当天的节假日", async () => {
    const { url } = await startTestDaemon({ clock: new ManualClock(at(10, 7, 21)) });
    const { status, body } = await workdayApi.month(url, "2026-10");
    expect(status).toBe(200);
    expect(body.month).toBe("2026-10");
    expect(body.days).toHaveLength(31);
    expect(body.missing).toEqual([]);
    expect(body.settings).toEqual({ rules: [], marks: [] });
    expect(await dayOf(url, "2026-10-01")).toEqual(["上班", "新加坡工作日"]);
    expect(await dayOf(url, "2026-10-08")).toEqual(["上班", "新加坡工作日", "国内工作日"]);
    expect(await dayOf(url, "2026-10-10")).toEqual(["上班", "调休补班"]);
    expect(await dayOf(url, "2026-10-11")).toEqual(["休息", "周末"]);
    expect(await dayOf(url, "2026-11-09")).toEqual(["上班", "国内工作日"]);
    expect(body.days[0]!.holidays).toEqual([{ region: "cn", name: "国庆节", kind: "holiday" }]);
  });

  it("加一条额外规则、删一条、把某天标成上班或休息、清掉标记：返回的结果随之变化，不用重启；每次改动是一条事件，两个前端都收到", async () => {
    const { url, dataDir } = await startTestDaemon({ clock: new ManualClock(at(10, 7, 21)) });
    const a = await TestFrontend.connect(url);
    const b = await TestFrontend.connect(url);
    await a.subscribe({ [CALENDAR]: 0 });
    await b.subscribe({ [CALENDAR]: 0 });

    expect(await dayOf(url, "2026-10-31")).toEqual(["休息", "周末"]);
    const added = await workdayApi.change(url, { kind: "add_rule", rule: LAST_SATURDAY });
    expect(added).toMatchObject({ status: 200, body: { changed: true, settings: { rules: [LAST_SATURDAY], marks: [] } } });
    expect(await dayOf(url, "2026-10-31")).toEqual(["上班", "额外规则：每月最后一个周六"]);

    await workdayApi.change(url, { kind: "mark", date: "2026-10-12", mark: "rest" });
    expect(await dayOf(url, "2026-10-12")).toEqual(["休息", "手动标记休息"]);
    await workdayApi.change(url, { kind: "mark", date: "2026-10-11", mark: "work" });
    expect(await dayOf(url, "2026-10-11")).toEqual(["上班", "手动标记上班"]);
    await workdayApi.change(url, { kind: "clear_mark", date: "2026-10-11" });
    expect(await dayOf(url, "2026-10-11")).toEqual(["休息", "周末"]);
    await workdayApi.change(url, { kind: "remove_rule", rule: LAST_SATURDAY });
    expect(await dayOf(url, "2026-10-31")).toEqual(["休息", "周末"]);

    // 同一条规则再加、清掉没有的标记：没有变化，不产生事件
    await workdayApi.change(url, { kind: "clear_mark", date: "2026-10-30" });

    for (const frontend of [a, b]) {
      await waitUntil(() => settingsEvents(frontend).length === 5, { describe: () => JSON.stringify(settingsEvents(frontend)) });
      expect(settingsEvents(frontend).map((e) => [e.source, e.change?.kind])).toEqual([
        ["settings", "add_rule"],
        ["settings", "mark"],
        ["settings", "mark"],
        ["settings", "clear_mark"],
        ["settings", "remove_rule"],
      ]);
      expect(settingsEvents(frontend).at(-1)!.settings).toEqual({ rules: [], marks: [{ date: "2026-10-12", mark: "rest" }] });
      // 节假日数据也在这个频道上：框架自带的三份
      const holidays = frontend.events({ channel: CALENDAR, type: EVENT_TYPES.holidayData }).map((f) => f.payload as HolidayDataEventPayload);
      expect(holidays.at(-1)!.years.map((y) => `${y.region}-${y.year}`)).toEqual(["cn-2026", "sg-2026", "sg-2027"]);
    }

    // 个人规则和手动标记存在数据目录的配置区
    const file = path.join(dataDirLayout(dataDir).config, "workday-calendar.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ format: 1, rules: [], marks: [{ date: "2026-10-12", mark: "rest" }] });
  });

  it("不对的改动被拒：日期不存在、规则写法不对", async () => {
    const { url } = await startTestDaemon();
    expect(await workdayApi.change(url, { kind: "mark", date: "2026-02-30", mark: "rest" })).toMatchObject({ status: 400, body: { code: "bad_request" } });
    expect(await workdayApi.change(url, { kind: "add_rule", rule: { kind: "weekly", weekday: 9 } } as never)).toMatchObject({ status: 400, body: { code: "bad_request" } });
    expect(await workdayApi.month(url, "2026-13")).toMatchObject({ status: 400, body: { code: "bad_request" } });
  });

  it("缺数据的年份（国内 2027 尚未公布）：国内那边按周一到周五算，结果标明缺了", async () => {
    const { url } = await startTestDaemon();
    const { body } = await workdayApi.month(url, "2027-01");
    expect(body.missing).toEqual(["cn"]);
    // 新加坡的元旦（周五），国内缺数据按工作日算
    expect(await dayOf(url, "2027-01-01")).toEqual(["上班", "国内工作日"]);
    expect(body.days[0]!.missing).toEqual(["cn"]);
  });
});

describe("个人设置在配置区：重启后还在，手改过的以配置文件为准", () => {
  it("停掉再起：规则和标记还在，不重复产生事件；停着时手改了配置文件，启动后按文件来，并推一条事件", async () => {
    const first = await startTestDaemon();
    await workdayApi.change(first.url, { kind: "add_rule", rule: LAST_SATURDAY });
    await first.daemon.stop();

    const second = await startTestDaemon({ reuse: { dataDir: first.dataDir, homeDir: first.homeDir } });
    expect(await dayOf(second.url, "2026-10-31")).toEqual(["上班", "额外规则：每月最后一个周六"]);
    const frontend = await TestFrontend.connect(second.url);
    await frontend.subscribe({ [CALENDAR]: 0 });
    await waitUntil(() => settingsEvents(frontend).length >= 1);
    expect(settingsEvents(frontend).map((e) => e.source)).toEqual(["settings"]);
    await second.daemon.stop();

    const file = path.join(dataDirLayout(first.dataDir).config, "workday-calendar.json");
    fs.writeFileSync(file, JSON.stringify({ format: 1, rules: [], marks: [{ date: "2026-10-30", mark: "rest" }] }));
    const third = await startTestDaemon({ reuse: { dataDir: first.dataDir, homeDir: first.homeDir } });
    expect(await dayOf(third.url, "2026-10-31")).toEqual(["休息", "周末"]);
    expect(await dayOf(third.url, "2026-10-30")).toEqual(["休息", "手动标记休息"]);
    const again = await TestFrontend.connect(third.url);
    await again.subscribe({ [CALENDAR]: 0 });
    await waitUntil(() => settingsEvents(again).length >= 2);
    expect(settingsEvents(again).map((e) => e.source)).toEqual(["settings", "config_file"]);
  });
});

/**
 * 2026-09-17（周四）到 11-09（周一）之间上班的日子（照调研文件里的节假日手工排出来的，独立于实现）：
 * 9-20（周日）国内调休补班；9-25 中秋、10-1 至 10-7 国庆是国内假期，新加坡上班；10-10（周六）国内调休补班；
 * 11-8（周日）新加坡屠妖节；11-9（周一）新加坡补假、国内上班（撞日，算上班）。9-18 和 10-12 是手动标的休息日。
 */
const WORKDAYS_SEP17_TO_NOV9 = [
  "09-17", "09-20", "09-21", "09-22", "09-23", "09-24", "09-25", "09-28", "09-29", "09-30",
  "10-01", "10-02", "10-05", "10-06", "10-07", "10-08", "10-09", "10-10", "10-13", "10-14", "10-15", "10-16",
  "10-19", "10-20", "10-21", "10-22", "10-23", "10-26", "10-27", "10-28", "10-29", "10-30",
  "11-02", "11-03", "11-04", "11-05", "11-06", "11-09",
].map((d) => `2026-${d}`);

const remindersIn = (test: { daemon: { store: { read(channel: string, after: number, type?: string): { payload: unknown }[] } } }) =>
  test.daemon.store.read(BOARD, 0, EVENT_TYPES.reminder).map((e) => e.payload as ReminderEventPayload);

describe("按我的工作日的提醒（可注入时钟）", () => {
  it("秘书建\"按我的工作日 09:00\"的提醒，提醒卡上显示这条规则；拨过一段含周末、两边假期、撞日、调休补班和手动休息日的日子，只在上班日的 09:00 响", async () => {
    const clock = new ManualClock(at(9, 17, 8));
    const createWorkdays: FauxStep = { kind: "reply", toolCalls: [{ name: "create_reminder", arguments: { text: "打卡", time: "09:00", repeat: { kind: "workdays" } } as never }] };
    const test = await startTestDaemon({ clock, secretary: [createWorkdays, { kind: "reply", text: "好的" }] });
    const frontend = await TestFrontend.connect(test.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [BOARD]: 0 });
    await frontend.sendText("每个工作日早上 9 点提醒我打卡");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);

    const card = (frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).at(-1)!.payload as CardEventPayload).card;
    expect(card).toMatchObject({ type: "reminder", payload: { schedule: { kind: "workdays", time: "09:00" }, nextAt: nowIso(at(9, 17, 9)) } });
    expect(card.text).toBe("简单提醒：打卡 · 按我的工作日 09:00（下一次 9 月 17 日（周四）09:00）");

    // 提醒建好之后再把明天（9-18）标成休息：明天就不响，不用重建提醒；下一次跟着改，提醒卡跟着变
    clock.advanceTo(at(9, 17, 10));
    await workdayApi.change(test.url, { kind: "mark", date: "2026-09-18", mark: "rest" });
    expect(remindersIn(test).at(-1)).toMatchObject({ change: "updated", by: "system", reminder: { nextAt: nowIso(at(9, 20, 9)) } });
    await workdayApi.change(test.url, { kind: "mark", date: "2026-10-12", mark: "rest" });

    clock.advanceTo(at(11, 9, 10));
    const fired = remindersIn(test).filter((e) => e.change === "fired");
    expect(fired.map((e) => localDate(new Date(e.reminder.lastFiredAt!)))).toEqual(WORKDAYS_SEP17_TO_NOV9);
    // 都在 09:00 整响，没有晚
    expect(fired.every((e) => e.lateMinutes === undefined && new Date(e.reminder.lastFiredAt!).getHours() === 9)).toBe(true);
    expect(test.daemon.reminders.get("r-1")).toMatchObject({ status: "pending", nextAt: nowIso(at(11, 10, 9)) });
  });

  it("定时作业的时间表也能选按我的工作日，由同一个调度器按同一个日历解释（调度器层面：内部作业）；登记之后改日历，下一次跟着变", async () => {
    const clock = new ManualClock(at(10, 7, 21));
    const test = await startTestDaemon({ clock });
    const runs: string[] = [];
    test.daemon.internalJobs.register({
      name: "workday_probe",
      schedule: { kind: "workdays", time: "08:00" },
      run: async () => {
        runs.push(nowIso(new Date(clock.now())).slice(0, 16));
      },
    });
    await workdayApi.change(test.url, { kind: "mark", date: "2026-10-08", mark: "rest" });
    for (const day of [8, 9, 10, 11, 12, 13]) {
      clock.advanceTo(at(10, day, 12));
      await test.daemon.internalJobs.whenIdle();
    }
    // 10-8 手动休息、10-10（周六）调休补班、10-11 周日
    expect(runs).toEqual(["2026-10-09T08:00", "2026-10-10T08:00", "2026-10-12T08:00", "2026-10-13T08:00"]);
  });
});

const propose = (params: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name: "propose_quick_action", arguments: { type: "workday_calendar", params } as never }] });
const latestCards = (frontend: TestFrontend): Card[] => {
  const byId = new Map<string, Card>();
  for (const f of frontend.events({ channel: CARDS, type: EVENT_TYPES.card })) byId.set((f.payload as CardEventPayload).card.id, (f.payload as CardEventPayload).card);
  return [...byId.values()];
};

describe("对秘书说：快速动作\"改工作日历\"（faux 剧本）", () => {
  it("\"下周一我不上班\"：秘书提议改工作日历，规范化成具体日期；一律先确认（卡片带确认按钮、同时进待我处理）；确认后那天变成休息，留\"已执行\"卡和操作记录", async () => {
    const clock = new ManualClock(at(10, 8, 10));
    const test = await startTestDaemon({ clock, secretary: [propose({ change: "mark_rest", date: "2026-10-12" }), { kind: "echo_context" }] });
    const frontend = await TestFrontend.connect(test.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0, [CALENDAR]: 0 });
    await frontend.sendText("下周一我不上班");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);

    const [card] = latestCards(frontend);
    expect(card).toMatchObject({
      type: "quick_action",
      status: "pending",
      payload: { action: { type: "workday_calendar", params: { kind: "mark", date: "2026-10-12", mark: "rest" } }, name: "改工作日历", title: "把 2026 年 10 月 12 日（周一）标为休息", explicit: false, disposition: "ask_first" },
    });
    const items = frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
    expect(items).toMatchObject([{ kind: "card", cardId: card!.id, title: "确认快速动作：改工作日历", source: "秘书对话", urgency: "non_blocking" }]);
    // 秘书看到：等用户确认；它没有直接改工作日历的工具（只能经"提议快速动作"）
    const seen = (frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).at(-1)!.payload as MessageEventPayload).message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(seen).toContain("[toolResult] propose_quick_action: 等用户确认：把 2026 年 10 月 12 日（周一）标为休息");
    expect(seen.split("\n").filter((l) => l.startsWith("[tool]") && /workday|calendar|日历/i.test(l))).toEqual([]);
    // 还没确认：配置不变
    expect(await dayOf(test.url, "2026-10-12")).toEqual(["上班", "新加坡工作日", "国内工作日"]);

    await frontend.cardAction({ cardId: card!.id, action: "execute", expectedVersion: card!.version });
    await waitUntil(() => latestCards(frontend)[0]!.status === "handled");
    expect(latestCards(frontend)[0]).toMatchObject({ status: "handled", outcome: { action: "execute" }, payload: { result: "已把 2026 年 10 月 12 日（周一）标为休息" } });
    expect(await dayOf(test.url, "2026-10-12")).toEqual(["休息", "手动标记休息"]);
    // 操作记录进事件日志；工作日历频道上一条改动事件（来源是快速动作）
    await waitUntil(() => frontend.events({ channel: SECRETARY, type: EVENT_TYPES.quickActionExecuted }).length === 1);
    expect(frontend.events({ channel: SECRETARY, type: EVENT_TYPES.quickActionExecuted }).map((f) => f.payload as QuickActionExecutedEventPayload)).toMatchObject([
      { action: { type: "workday_calendar", params: { kind: "mark", date: "2026-10-12", mark: "rest" } }, name: "改工作日历", explicit: false, cardId: card!.id, result: { ok: true } },
    ]);
    await waitUntil(() => settingsEvents(frontend).length === 1);
    expect(settingsEvents(frontend)).toMatchObject([{ source: "quick_action", change: { kind: "mark", date: "2026-10-12", mark: "rest" }, settings: { marks: [{ date: "2026-10-12", mark: "rest" }] } }]);
  });

  it("\"每月最后一个周六要上班\"：确认后多出一条额外规则；用户关掉卡片则配置不变", async () => {
    const rule = { kind: "last_weekday", weekday: 6 };
    const test = await startTestDaemon({
      clock: new ManualClock(at(10, 8, 10)),
      secretary: [propose({ change: "add_rule", rule }), { kind: "reply", text: "请确认" }, propose({ change: "add_rule", rule }), { kind: "reply", text: "请确认" }],
    });
    const frontend = await TestFrontend.connect(test.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0 });
    await frontend.sendText("每月最后一个周六要上班");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const [first] = latestCards(frontend);
    expect(first).toMatchObject({ status: "pending", payload: { title: "加一条额外上班规则：每月最后一个周六", action: { params: { kind: "add_rule", rule } } } });
    await frontend.cardAction({ cardId: first!.id, action: "cancel", expectedVersion: first!.version });
    await waitUntil(() => latestCards(frontend)[0]!.status === "dismissed");
    expect((await workdayApi.month(test.url, "2026-10")).body.settings.rules).toEqual([]);

    await frontend.sendText("每月最后一个周六要上班，确认一下");
    await waitUntil(() => latestCards(frontend).length === 2);
    const second = latestCards(frontend)[1]!;
    await frontend.cardAction({ cardId: second.id, action: "execute", expectedVersion: second.version });
    await waitUntil(() => latestCards(frontend)[1]!.status === "handled");
    expect((await workdayApi.month(test.url, "2026-10")).body.settings.rules).toEqual([rule]);
    expect(await dayOf(test.url, "2026-10-31")).toEqual(["上班", "额外规则：每月最后一个周六"]);
  });

  it("参数不对（日期不存在、该给日期没给）：工具结果说明原因，不出卡", async () => {
    const test = await startTestDaemon({ secretary: [propose({ change: "mark_rest", date: "2026-02-30" }), propose({ change: "mark_work" }), { kind: "echo_context" }] });
    const frontend = await TestFrontend.connect(test.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0 });
    await frontend.sendText("2 月 30 号我不上班");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const seen = (frontend.events({ channel: SECRETARY, type: EVENT_TYPES.message }).at(-1)!.payload as MessageEventPayload).message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(seen).toMatch(/propose_quick_action: 参数不对：.*2026-02-30/);
    expect(seen).toMatch(/propose_quick_action: 参数不对：.*date/);
    expect(latestCards(frontend)).toEqual([]);
  });
});

/** 国内 2027 年的数据（测试用的替身：更新任务交付件的样子，只有元旦三天和一个补班日） */
const CN_2027 = {
  format: 1,
  region: "cn",
  year: 2027,
  sources: [{ title: "国务院办公厅关于2027年部分节假日安排的通知（测试替身）", url: "https://www.gov.cn/zhengce/content/test.htm" }],
  days: [
    { date: "2027-01-01", name: "元旦", kind: "holiday" },
    { date: "2027-01-02", name: "元旦", kind: "holiday" },
    { date: "2027-01-03", name: "元旦", kind: "holiday" },
    { date: "2027-01-09", name: "元旦调休上班", kind: "makeup_workday" },
  ],
};

const noticesOf = (test: { daemon: { inbox: { list(): InboxItem[] } } }) =>
  test.daemon.inbox.list().filter((i): i is Extract<InboxItem, { kind: "notice" }> => i.kind === "notice" && i.notice === "holiday_data_missing");

describe("每年 12 月检查下一年的节假日数据（可注入时钟）", () => {
  it("12 月 1 日的内部作业发现国内 2027 年的数据缺了：待我处理里放一条事项（不卡任务），写明年份和哪一边；之后再检查不重复放", async () => {
    const clock = new ManualClock(new Date(2026, 10, 30, 12));
    const test = await startTestDaemon({ clock });
    expect(noticesOf(test)).toEqual([]);
    clock.advanceTo(new Date(2026, 11, 1, 10));
    await test.daemon.internalJobs.whenIdle();
    const [notice, ...others] = noticesOf(test);
    expect(others).toEqual([]);
    expect(notice).toMatchObject({ title: "下一年节假日数据缺失：缺 2027 年国内节假日数据", source: "工作日历", urgency: "non_blocking", actions: ["发起更新任务"], data: { year: 2027, regions: ["cn"] } });
    expect(notice!.body).toMatch(/2027 年国内/);
    // 下个月（1 月）照常检查，但同一年的缺失已经提醒过了
    clock.advanceTo(new Date(2027, 0, 1, 10));
    await test.daemon.internalJobs.whenIdle();
    expect(noticesOf(test)).toHaveLength(1);
  });

  it("数据齐了不放：2025 年 12 月检查 2026 年，两边都有", async () => {
    const clock = new ManualClock(new Date(2025, 10, 30, 12));
    const test = await startTestDaemon({ clock });
    clock.advanceTo(new Date(2025, 11, 1, 10));
    await test.daemon.internalJobs.whenIdle();
    expect(test.daemon.internalJobs.state("holiday_data_check")?.lastRunAt).toBeDefined();
    expect(noticesOf(test)).toEqual([]);
  });

  it("检查的日子可配置（holidayCheck.date）", async () => {
    const clock = new ManualClock(new Date(2026, 10, 10, 12));
    const test = await startTestDaemon({ clock, config: { holidayCheck: { date: "11-15", time: "08:00" } } });
    clock.advanceTo(new Date(2026, 10, 15, 9));
    await test.daemon.internalJobs.whenIdle();
    expect(noticesOf(test)).toMatchObject([{ data: { year: 2027, regions: ["cn"] } }]);
  });

  it("点\"发起更新任务\"：记下要发起的联网任务（年份、哪一边、官方来源、工具包开联网）；导入交付的数据后日历用上它，缺失事项自动结束", async () => {
    const clock = new ManualClock(new Date(2026, 10, 30, 12));
    const test = await startTestDaemon({ clock });
    const frontend = await TestFrontend.connect(test.url);
    await frontend.subscribe({ [INBOX]: 0, [CALENDAR]: 0 });
    clock.advanceTo(new Date(2026, 11, 1, 10));
    await test.daemon.internalJobs.whenIdle();
    const [notice] = noticesOf(test);
    expect(await frontend.inboxAction({ itemIds: [notice!.id], action: "handle", choice: "发起更新任务" })).toMatchObject({ ok: true });

    const requested = test.daemon.store.read("internal", 0, "holiday_update_requested").map((e) => e.payload as Record<string, unknown>);
    expect(requested).toMatchObject([{ itemId: notice!.id, year: 2027, regions: ["cn"], network: true, title: "更新 2027 年国内节假日数据" }]);
    const brief = String(requested[0]!.brief);
    expect(brief).toMatch(/2027 年/);
    expect(brief).toMatch(/国内/);
    expect(brief).toContain("https://www.gov.cn/zhengce/zuixin/");
    expect(brief).toContain("cn-2027.json");
    expect(brief).toMatch(/联网/);

    // 交付件不对：不导入，什么都不改
    const dir = makeTempDir("holiday-out-");
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ ...CN_2027, days: [{ date: "2028-01-01", name: "元旦", kind: "holiday" }] }));
    expect(() => test.daemon.workdayCalendar.importHolidayFile(bad)).toThrow(/不在 2027 年里/);
    expect((await workdayApi.month(test.url, "2027-01")).body.missing).toEqual(["cn"]);

    // 交付件对了：运行时校验并导入，日历从此用上这一年的数据；缺失事项自动结束（归档）
    const good = path.join(dir, "cn-2027.json");
    fs.writeFileSync(good, JSON.stringify(CN_2027));
    test.daemon.workdayCalendar.importHolidayFile(good);
    expect((await workdayApi.month(test.url, "2027-01")).body.missing).toEqual([]);
    expect(await dayOf(test.url, "2027-01-01")).toEqual(["休息", "新加坡假期：New Year's Day 元旦", "国内假期：元旦"]);
    expect(await dayOf(test.url, "2027-01-09")).toEqual(["上班", "调休补班"]);
    expect(noticesOf(test)).toMatchObject([{ id: notice!.id, archived: true }]);
    // 导入的数据放在数据目录的配置区，和框架自带的合在一起用；前端收到新的节假日数据
    expect(fs.existsSync(path.join(dataDirLayout(test.dataDir).config, "holidays", "cn-2027.json"))).toBe(true);
    await waitUntil(() => frontend.events({ channel: CALENDAR, type: EVENT_TYPES.holidayData }).length === 2);
    const latest = frontend.events({ channel: CALENDAR, type: EVENT_TYPES.holidayData }).at(-1)!.payload as HolidayDataEventPayload;
    expect(latest.imported).toEqual({ region: "cn", year: 2027 });
    expect(latest.years.map((y) => `${y.region}-${y.year}`)).toEqual(["cn-2026", "cn-2027", "sg-2026", "sg-2027"]);
  });
});

describe("录给前端回放的事件流（workday-calendar）", () => {
  it("设置页和提醒卡：节假日数据、改个人设置、按我的工作日的提醒和它跟着日历变的下一次", async () => {
    const clock = new ManualClock(at(10, 8, 10));
    const createWorkdays: FauxStep = { kind: "reply", toolCalls: [{ name: "create_reminder", arguments: { text: "打卡", time: "09:00", repeat: { kind: "workdays" } } as never }] };
    const test = await startTestDaemon({ clock, secretary: [createWorkdays, { kind: "reply", text: "好的，每个工作日 9 点提醒你打卡" }] });
    const frontend = await TestFrontend.connect(test.url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [BOARD]: 0, [CALENDAR]: 0 });
    await waitUntil(() => frontend.events({ channel: CALENDAR, type: EVENT_TYPES.holidayData }).length === 1);
    await frontend.sendText("每个工作日早上 9 点提醒我打卡");
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    // 明天（10-9）标成休息：提醒的下一次跟着变到 10-10（周六调休补班）
    await workdayApi.change(test.url, { kind: "mark", date: "2026-10-09", mark: "rest" });
    await frontend.next(BOARD, EVENT_TYPES.reminder);
    await workdayApi.change(test.url, { kind: "add_rule", rule: LAST_SATURDAY });
    await waitUntil(() => settingsEvents(frontend).length === 2);
    await waitUntil(() => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).length === 2);
    expect(remindersIn(test).at(-1)).toMatchObject({ change: "updated", by: "system", reminder: { nextAt: nowIso(at(10, 10, 9)) } });
    saveOrCheckRecording("workday-calendar", frontend.recording);
  });
});
