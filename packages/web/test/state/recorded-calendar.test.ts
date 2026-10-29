// 前端状态层回放 35 号票的主切面录下的事件流（packages/daemon/test/main/calendar.test.ts）：日历页取回的每个月（calendar_month）、
// 任务看板和工作日历频道上的事件。看：取回的这份什么时候旧了要重新取、格子上的提醒数和作业数（已暂停的不算）和失败标记、
// 某一天的详情（工作日判定、提醒触发没有、作业的结果或预计）。
// 重新录：ERGO_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/calendar.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { calendarCells, calendarDayDetail, calendarMonthOf, type CalendarMonthView, replay, type UiInput, type UiState } from "../../src/state/index.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

/** 第 n 次取回日历（从 1 数起）的下标 */
function nthFetch(inputs: readonly UiInput[], n: number): number {
  const at = inputs.flatMap((input, i) => (input.kind === "calendar_month" ? [i] : []))[n - 1];
  if (at === undefined) throw new Error(`录好的事件流里没有第 ${n} 次取日历`);
  return at;
}

/** 回放到下标 i（含） */
const upTo = (inputs: readonly UiInput[], i: number) => replay(inputs.slice(0, i + 1));

const october = (state: UiState): CalendarMonthView => calendarMonthOf(state, "2026-10").view!;
const cell = (state: UiState, date: string) => calendarCells(october(state)).find((c) => c.date === date)!;
const detail = (state: UiState, date: string) => calendarDayDetail(october(state), date)!;
/** 详情压成几行 */
const rows = (state: UiState, date: string) => {
  const d = detail(state, date);
  return [...d.reminders.map((r) => `${r.time} ${r.text} ${r.statusText}`), ...d.jobs.map((j) => `${j.time} ${j.title} ${j.project} ${j.statusText}`)];
};

describe("回放：按月看（calendar-month）", () => {
  // 录制在 calendar.test.ts 的"按月给出每一天的日历条目"：两个作业（每天 09:00 的简报、按我的工作日 18:00 的日报）、三条提醒，
  // 取一次十月；拨到 09:00 简报跑完、09:30 站会响了，再取一次
  const inputs = load("calendar-month");
  const first = nthFetch(inputs, 1);
  const second = nthFetch(inputs, 2);

  test("还没取过时算旧（页面去取）；取回之后不旧", () => {
    expect(calendarMonthOf(upTo(inputs, first - 1), "2026-10")).toEqual({ view: undefined, stale: true });
    expect(calendarMonthOf(upTo(inputs, first), "2026-10").stale).toBe(false);
  });

  test("格子：当天的提醒数、作业数；建之前的日子上没有；周末只有每天的", () => {
    const state = upTo(inputs, first);
    expect(cell(state, "2026-10-07")).toMatchObject({ workday: true, reminders: 0, jobs: 0, failedJobs: 0 });
    expect(cell(state, "2026-10-08")).toMatchObject({ workday: true, short: "工作日", reminders: 2, jobs: 2, failedJobs: 0 });
    expect(cell(state, "2026-10-10")).toMatchObject({ workday: true, short: "补班", reminders: 2, jobs: 2 });
    expect(cell(state, "2026-10-11")).toMatchObject({ workday: false, short: "周末", reminders: 1, jobs: 1 });
  });

  test("某一天的详情：工作日判定和原因，提醒待触发，作业预计几点运行、不属于项目", () => {
    const state = upTo(inputs, first);
    expect(detail(state, "2026-10-08")).toMatchObject({ title: "2026 年 10 月 8 日（周四）", workday: true, manual: false, reasons: ["新加坡工作日", "国内工作日"] });
    expect(rows(state, "2026-10-08")).toEqual(["09:30 站会 待触发", "14:00 交报告 待触发", "09:00 每天早上出简报 不属于项目 预计 09:00 运行", "18:00 写日报 不属于项目 预计 18:00 运行"]);
    expect(detail(state, "2026-10-10").reasons).toEqual(["调休补班"]);
  });

  test("任务看板上来了作业到点的事件：手里这份旧了，页面重新取", () => {
    const triggered = inputs.findIndex((input, i) => i > first && input.kind === "frame" && input.frame.type === "scheduled_job");
    expect(calendarMonthOf(upTo(inputs, triggered - 1), "2026-10").stale).toBe(false);
    expect(calendarMonthOf(upTo(inputs, triggered), "2026-10").stale).toBe(true);
    // 旧了也先接着显示手里这份，取回来再换
    expect(calendarMonthOf(upTo(inputs, second - 1), "2026-10")).toMatchObject({ stale: true, view: { month: "2026-10" } });
  });

  test("重新取回之后：站会已触发，简报这一次成功；之后的日子照旧是预计", () => {
    const state = replay(inputs);
    expect(calendarMonthOf(state, "2026-10").stale).toBe(false);
    expect(rows(state, "2026-10-08")).toEqual(["09:30 站会 已触发", "14:00 交报告 待触发", "09:00 每天早上出简报 不属于项目 成功", "18:00 写日报 不属于项目 预计 18:00 运行"]);
    expect(rows(state, "2026-10-09")).toContain("09:00 每天早上出简报 不属于项目 预计 09:00 运行");
  });
});

describe("回放：提醒、作业、工作日历变了（calendar-changes）", () => {
  // 录制在 calendar.test.ts 的"提醒、作业、工作日历变了"：简报 09:00 失败；10-09 标成休息；暂停简报；取消写日报；取消吃药。
  // 每一步之后重新取一次十月
  const inputs = load("calendar-changes");

  test("一次运行失败：格子上标出失败，详情里写明原因", () => {
    const state = upTo(inputs, nthFetch(inputs, 2));
    expect(cell(state, "2026-10-08")).toMatchObject({ jobs: 2, failedJobs: 1 });
    expect(detail(state, "2026-10-08").jobs.map((j) => [j.title, j.statusText, j.failed])).toEqual([
      ["每天早上出简报", "失败：新闻源打不开", true],
      ["写日报", "预计 18:00 运行", false],
    ]);
  });

  test("某天标成休息：工作日历频道的事件让手里这份旧了；重新取回后那天是手动标记的休息，按我的工作日的站会、写日报没有了", () => {
    const settings = inputs.findIndex((input) => input.kind === "frame" && input.frame.type === "workday_settings");
    expect(calendarMonthOf(upTo(inputs, settings), "2026-10").stale).toBe(true);
    const state = upTo(inputs, nthFetch(inputs, 3));
    expect(cell(state, "2026-10-09")).toMatchObject({ workday: false, manual: true, short: "手动", reminders: 1, jobs: 1 });
    expect(detail(state, "2026-10-09")).toMatchObject({ workday: false, manual: true, reasons: ["手动标记休息"] });
  });

  test("暂停简报：以后的标已暂停，不算进格子上的作业数", () => {
    const state = upTo(inputs, nthFetch(inputs, 4));
    expect(rows(state, "2026-10-12").filter((r) => r.includes("简报") || r.includes("日报"))).toEqual(["09:00 每天早上出简报 不属于项目 已暂停", "18:00 写日报 不属于项目 预计 18:00 运行"]);
    expect(cell(state, "2026-10-12")).toMatchObject({ jobs: 1, failedJobs: 0 });
    // 已经失败的那次照旧
    expect(cell(state, "2026-10-08")).toMatchObject({ failedJobs: 1 });
  });

  test("取消写日报、取消吃药：哪天都不再出现", () => {
    const state = replay(inputs);
    expect(calendarMonthOf(state, "2026-10").stale).toBe(false);
    expect(rows(state, "2026-10-12")).toEqual(["09:30 站会 待触发", "09:00 每天早上出简报 不属于项目 已暂停"]);
    expect(cell(state, "2026-10-12")).toMatchObject({ reminders: 1, jobs: 0 });
    expect(october(state).days.some((d) => d.jobs.some((j) => j.title === "写日报") || d.reminders.some((r) => r.text === "吃药"))).toBe(false);
  });
});
