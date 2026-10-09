// 前端状态层：日历（35 号票）。主线流程回放主切面录下的 calendar-month、calendar-changes（recorded-calendar.test.ts）；
// 这里是手写的边角：取回的日历什么时候算旧（只认任务看板上的提醒和作业事件、工作日历频道上的事件，序号要比这份记着的大），
// 晚到的旧响应、重新同步；格子上的数；详情里属于项目的作业、补跑、失败的原因、晚了的提醒；年月选择里缺数据的年份。
import { describe, expect, test } from "vitest";
import {
  type CalendarDay,
  calendarCells,
  calendarDayDetail,
  type CalendarJobEntry,
  calendarMonthOf,
  type CalendarMonthView,
  calendarYearChoices,
  EMPTY_WORKDAY_SETTINGS,
  type HolidayYear,
  jobPlace,
  replay,
  type UiInput,
  workdayCalendar,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

const SG_2026: HolidayYear = { format: 1, region: "sg", year: 2026, sources: [{ title: "测试用", url: "https://example.invalid/" }], days: [] };
const CN_2026: HolidayYear = {
  format: 1,
  region: "cn",
  year: 2026,
  sources: [{ title: "测试用", url: "https://example.invalid/" }],
  days: [{ date: "2026-10-01", name: "国庆节", kind: "holiday" }],
};
const calendar = workdayCalendar([SG_2026, CN_2026], EMPTY_WORKDAY_SETTINGS);

const BRIEFING = { jobId: "j-1", title: "每天早上出简报", schedule: { kind: "daily" as const, time: "09:00" } };

/** 十月的一天：工作日判定照两边的数据算，提醒和作业手写 */
function day(date: string, items: Partial<Pick<CalendarDay, "reminders" | "jobs">> = {}): CalendarDay {
  return { date, verdict: calendar.day(date), reminders: [], jobs: [], ...items };
}

function october(asOf: CalendarMonthView["asOf"], days: CalendarDay[] = [day("2026-10-01"), day("2026-10-08")]): CalendarMonthView {
  return { month: "2026-10", days, missing: [], asOf };
}

const fetched = (view: CalendarMonthView): UiInput => ({ kind: "calendar_month", view });
const T = "2026-10-08T08:00:00.000+08:00";
/** 看板频道上几种事件的负载（只要归并得进去） */
const BOARD_PAYLOADS: Record<string, unknown> = {
  reminder: { reminder: { id: "r-1", text: "站会", schedule: { kind: "workdays", time: "09:30" }, status: "pending", cardId: "c-1", createdAt: T, updatedAt: T }, change: "created", by: "agent" },
  scheduled_job: {
    job: { ...BRIEFING, id: "j-1", each: "出简报", maintainerId: "jm-1", taskId: "t-1", taskTitle: "简报", grants: [], temporalRules: [], grantInfo: {}, state: "active", lastFailed: false, consecutiveFailures: 0, runCount: 0, createdAt: T, updatedAt: T },
    change: "registered",
    by: "user",
  },
  task: { task: { id: "t-1", title: "简报", state: "running", maintainerId: "tm-1", projects: [], createdAt: T, updatedAt: T }, change: "started", by: "user" },
  token_totals: { owner: { kind: "task", id: "t-1" }, tokens: { cacheHit: 0, cacheMiss: 1, output: 1 }, calls: 1, byAgent: [], byStage: [] },
};
const boardEvent = (seq: number, type: string) => ({ kind: "frame" as const, frame: frame("board", seq, type, BOARD_PAYLOADS[type]) });
const workdayEvent = (seq: number) => ({ kind: "frame" as const, frame: frame("workday_calendar", seq, "workday_settings", { settings: EMPTY_WORKDAY_SETTINGS, source: "settings" }) });

describe("取回的日历什么时候算旧", () => {
  test("还没取过的月份算旧（要去取）；取回之后不旧", () => {
    expect(calendarMonthOf(replay([]), "2026-10")).toEqual({ view: undefined, stale: true });
    const state = replay([boardEvent(1, "reminder"), fetched(october({ board: 1, workdayCalendar: 0 }))]);
    expect(calendarMonthOf(state, "2026-10")).toMatchObject({ stale: false, view: { month: "2026-10" } });
    expect(calendarMonthOf(state, "2026-11")).toEqual({ view: undefined, stale: true });
  });

  test("任务看板上序号更大的提醒、定时作业事件，工作日历频道上序号更大的事件：旧了；任务、token 合计这些别的事件不算", () => {
    const base = [boardEvent(1, "reminder"), workdayEvent(1), fetched(october({ board: 1, workdayCalendar: 1 }))];
    expect(calendarMonthOf(replay([...base, boardEvent(2, "task"), boardEvent(3, "token_totals")]), "2026-10").stale).toBe(false);
    expect(calendarMonthOf(replay([...base, boardEvent(2, "reminder")]), "2026-10").stale).toBe(true);
    expect(calendarMonthOf(replay([...base, boardEvent(2, "scheduled_job")]), "2026-10").stale).toBe(true);
    expect(calendarMonthOf(replay([...base, workdayEvent(2)]), "2026-10").stale).toBe(true);
  });

  test("取回的那一份已经算上了的事件（序号不比它记着的大）：不算旧——响应比事件先到时就是这样", () => {
    const state = replay([fetched(october({ board: 5, workdayCalendar: 0 })), boardEvent(4, "scheduled_job"), boardEvent(5, "reminder")]);
    expect(calendarMonthOf(state, "2026-10").stale).toBe(false);
    expect(calendarMonthOf(replay([fetched(october({ board: 5, workdayCalendar: 0 })), boardEvent(6, "reminder")]), "2026-10").stale).toBe(true);
  });

  test("晚到的旧响应不盖掉手里更新的那一份", () => {
    const newer = october({ board: 7, workdayCalendar: 2 }, [day("2026-10-08", { reminders: [{ reminderId: "r-1", text: "站会", schedule: { kind: "workdays", time: "09:30" }, at: "2026-10-08T09:30:00.000+08:00", status: "fired" }] })]);
    const older = october({ board: 3, workdayCalendar: 2 });
    expect(calendarMonthOf(replay([fetched(newer), fetched(older)]), "2026-10").view).toBe(newer);
  });

  test("重新同步任务看板或工作日历频道：取回的日历都清掉，接下来重新取", () => {
    const base = [boardEvent(1, "reminder"), fetched(october({ board: 1, workdayCalendar: 0 }))];
    expect(calendarMonthOf(replay([...base, { kind: "resync", channel: "board" }]), "2026-10")).toEqual({ view: undefined, stale: true });
    expect(calendarMonthOf(replay([...base, { kind: "resync", channel: "workday_calendar" }]), "2026-10")).toEqual({ view: undefined, stale: true });
    // 别的频道重新同步不碰日历
    expect(calendarMonthOf(replay([...base, { kind: "resync", channel: "inbox" }]), "2026-10").stale).toBe(false);
  });
});

const job = (at: string, overrides: Partial<CalendarJobEntry> = {}): CalendarJobEntry => ({ ...BRIEFING, at, status: "expected", ...overrides });

describe("格子和某一天的详情", () => {
  const view = october({ board: 9, workdayCalendar: 1 }, [
    day("2026-10-01"),
    day("2026-10-08", {
      reminders: [
        { reminderId: "r-2", text: "吃药", schedule: { kind: "daily", time: "07:00" }, at: "2026-10-08T07:00:00.000+08:00", status: "missed", lateMinutes: 140 },
        { reminderId: "r-1", text: "交报告", schedule: { kind: "once", at: "2026-10-08T09:00:00.000+08:00" }, at: "2026-10-08T09:00:00.000+08:00", status: "fired", lateMinutes: 20 },
      ],
      jobs: [
        job("2026-10-08T09:00:00.000+08:00", {
          status: "done",
          run: { runId: "j-1-r1", jobId: "j-1", trigger: "catch_up", missed: 3, dueAt: "2026-10-08T09:00:00.000+08:00", state: "done", queuedAt: "2026-10-08T09:20:00.000+08:00" },
        }),
        {
          jobId: "j-2",
          title: "抓取资讯",
          schedule: { kind: "workdays", time: "12:00" },
          projectId: "p-1",
          projectName: "资讯站",
          at: "2026-10-08T12:00:00.000+08:00",
          status: "failed",
          run: { runId: "j-2-r1", jobId: "j-2", trigger: "scheduled", dueAt: "2026-10-08T12:00:00.000+08:00", state: "failed", queuedAt: "2026-10-08T12:00:00.000+08:00", reason: "源站打不开" },
        },
        { ...BRIEFING, jobId: "j-3", title: "周报", at: "2026-10-08T18:00:00.000+08:00", status: "paused" },
        job("2026-10-08T21:00:00.000+08:00", { jobId: "j-4", title: "备份笔记" }),
      ],
    }),
  ]);

  test("格子：上班或休息、原因的短词、提醒数、作业数（已暂停的不算）、失败的作业数", () => {
    expect(calendarCells(view)).toEqual([
      { date: "2026-10-01", day: 1, workday: true, manual: false, short: "新加坡", label: "10 月 1 日 上班 · 新加坡工作日", reminders: 0, jobs: 0, failedJobs: 0 },
      {
        date: "2026-10-08",
        day: 8,
        workday: true,
        manual: false,
        short: "工作日",
        label: "10 月 8 日 上班 · 新加坡工作日、国内工作日 · 2 条提醒 · 3 次定时作业 · 1 次失败",
        reminders: 2,
        jobs: 3,
        failedJobs: 1,
      },
    ]);
  });

  test("详情：工作日判定和原因、当天的节假日；提醒的时间、内容、触发没有（晚了多久、错过的去了待我处理）", () => {
    const holiday = calendarDayDetail(view, "2026-10-01")!;
    expect(holiday).toMatchObject({ title: "2026 年 10 月 1 日（周四）", workday: true, manual: false, reasons: ["新加坡工作日"], holidays: ["国内：国庆节"], missing: undefined, reminders: [], jobs: [] });
    const detail = calendarDayDetail(view, "2026-10-08")!;
    expect(detail.reminders.map((r) => [r.time, r.text, r.statusText, r.repeat])).toEqual([
      ["07:00", "吃药", "错过 · 晚了 2 小时 20 分钟，放在了待办", "每天 07:00"],
      ["09:00", "交报告", "已触发 · 晚了 20 分钟", undefined],
    ]);
    expect(calendarDayDetail(view, "2026-10-09")).toBeUndefined();
  });

  test("详情：作业的时间、属于哪个项目、这一次的结果（补跑、失败的原因）或预计；点它去项目页或看板上它的位置", () => {
    const { jobs } = calendarDayDetail(view, "2026-10-08")!;
    expect(jobs.map((j) => [j.time, j.title, j.project, j.statusText, j.failed])).toEqual([
      ["09:00", "每天早上出简报", "不属于项目", "开机补跑（错过 3 次） · 成功", false],
      ["12:00", "抓取资讯", "项目「资讯站」", "失败：源站打不开", true],
      ["18:00", "周报", "不属于项目", "已暂停", false],
      ["21:00", "备份笔记", "不属于项目", "预计 21:00 运行", false],
    ]);
    expect(jobPlace(jobs[0]!)).toEqual({ kind: "board", jobId: "j-1" });
    expect(jobPlace(jobs[1]!)).toEqual({ kind: "project", projectId: "p-1", jobId: "j-2" });
  });

  test("缺节假日数据的年份：详情里写明", () => {
    const missing = { ...view, days: [{ date: "2027-01-04", verdict: workdayCalendar([SG_2026], EMPTY_WORKDAY_SETTINGS).day("2027-01-04"), reminders: [], jobs: [] }] };
    expect(calendarDayDetail(missing, "2027-01-04")!.missing).toBe("缺 2027 年新加坡、国内节假日数据");
  });
});

describe("年月选择", () => {
  test("今年前后各五年；正在看的年份不在里面时也带上；缺节假日数据的年份标出来（还没收到节假日数据时不标）", () => {
    const state = replay([{ kind: "frame", frame: frame("workday_calendar", 1, "holiday_data", { years: [SG_2026, CN_2026] }) }]);
    const choices = calendarYearChoices(state, 2026, 2026);
    expect(choices.map((c) => c.year)).toEqual([2021, 2022, 2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031]);
    expect(choices.find((c) => c.year === 2026)!.missing).toBeUndefined();
    expect(choices.find((c) => c.year === 2027)!.missing).toBe("缺 2027 年新加坡、国内节假日数据");
    expect(calendarYearChoices(state, 2026, 2040).map((c) => c.year).at(-1)).toBe(2040);
    expect(calendarYearChoices(replay([]), 2026, 2026).every((c) => c.missing === undefined)).toBe(true);
  });
});
