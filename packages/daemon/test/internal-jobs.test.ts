// 内部作业"错过了没有"的判断（纯函数，定时作业也用它）：上一次之后的下一次过没过点。
// 守护进程里怎么补跑、补完不再补，在主切面测（test/main/backup.test.ts 的"错过的内部作业开机后补一次"）。
// 另有每次跑完记下的结局（411，体检读）：真的事件存储、手动时钟。
import path from "node:path";
import { nowIso, type ReminderSchedule, workdayCalendar } from "@ergo/protocol";
import { describe, expect, onTestFinished, test } from "vitest";
import { describeSyncSchedule } from "../src/data-sources/service.ts";
import { openEventStore } from "../src/events/event-store.ts";
import { clockIso } from "../src/scheduler/clock.ts";
import { createInternalJobs, internalJobsView, nextDue } from "../src/scheduler/internal-jobs.ts";
import { createScheduler } from "../src/scheduler/scheduler.ts";
import { ManualClock } from "./helpers/clock.ts";
import { makeTempDir } from "./helpers/temp-dir.ts";

/** 本地时间 2026 年 m 月 d 日 hh:mm（2026-10-07 是周三，10-11 是周日） */
const at = (m: number, d: number, hh: number, mm = 0) => new Date(2026, m - 1, d, hh, mm);
const nightly: ReminderSchedule = { kind: "daily", time: "03:30" };
const sundays: ReminderSchedule = { kind: "weekly", time: "04:30", weekdays: [0] };
/** 不看工作日历的时间表也要给一个（空的：只按周一到周五） */
const CTX = { calendar: workdayCalendar([], { rules: [], marks: [] }) };

describe("错过了没有", () => {
  test.each([
    ["当晚还没到点", nightly, at(10, 7, 21), at(10, 8, 1), { at: at(10, 8, 3, 30), missed: false }],
    ["正好到点算错过（马上跑）", nightly, at(10, 7, 21), at(10, 8, 3, 30), { at: at(10, 8, 3, 30), missed: true }],
    ["停了好几晚：只看上一次之后的那一次，错过了（只补一次）", nightly, at(10, 7, 21), at(10, 12, 9), { at: at(10, 8, 3, 30), missed: true }],
    ["每周日：周三跑过，周六还没到", sundays, at(10, 7, 4, 30), at(10, 10, 23), { at: at(10, 11, 4, 30), missed: false }],
    ["每周日：周一才开机，错过了周日那次", sundays, at(10, 7, 4, 30), at(10, 12, 8), { at: at(10, 11, 4, 30), missed: true }],
  ])("%s", (_name, schedule, last, now, expected) => {
    expect(nextDue(schedule, last, now, CTX)).toEqual(expected);
  });

  test("按我的工作日：按给的工作日历算（周末和手动休息日跳过）", () => {
    const calendar = workdayCalendar([], { rules: [], marks: [{ date: "2026-10-12", mark: "rest" }] });
    const workdays: ReminderSchedule = { kind: "workdays", time: "08:00" };
    // 周五跑过，周一手动休息：下一次是周二；周日开机还没到
    expect(nextDue(workdays, at(10, 9, 8), at(10, 11, 9), { calendar })).toEqual({ at: at(10, 13, 8), missed: false });
    expect(nextDue(workdays, at(10, 9, 8), at(10, 13, 9), { calendar })).toEqual({ at: at(10, 13, 8), missed: true });
  });

  test("一次性的已经过了：没有下一次", () => {
    expect(nextDue({ kind: "once", at: at(10, 8, 9).toISOString() }, at(10, 8, 9), at(10, 9, 0), CTX)).toBeUndefined();
  });

  test("每隔几分钟：从上一次往后数；停机错过了好几次也只补一次", () => {
    const every30 = { kind: "every", minutes: 30 } as const;
    expect(nextDue(every30, at(10, 8, 9), at(10, 8, 9, 10), CTX)).toEqual({ at: at(10, 8, 9, 30), missed: false });
    expect(nextDue(every30, at(10, 8, 9), at(10, 8, 9, 30), CTX)).toEqual({ at: at(10, 8, 9, 30), missed: true });
    expect(nextDue(every30, at(10, 8, 9), at(10, 9, 9), CTX)).toEqual({ at: at(10, 8, 9, 30), missed: true });
  });
});

describe("数据源定期导入的时间给人看的写法", () => {
  test.each([
    [{ kind: "every", minutes: 30 } as const, "每 30 分钟"],
    [{ kind: "every", minutes: 60 } as const, "每小时"],
    [{ kind: "every", minutes: 120 } as const, "每 2 小时"],
    [{ kind: "daily", time: "04:00" } as const, "每天 04:00"],
  ])("%j → %s", (schedule, text) => {
    expect(describeSyncSchedule(schedule)).toBe(text);
  });
});

// 411：内部作业跑完记下这一次的结局——跑完了是 ok，run 抛错是 failed（出错的说明一行、跑完的时间）；以前出错只写一行日志、
// 照样记"跑过了"。上一次开始跑的时间照旧记（错过补跑只看它，出错的不在下次开机时重跑）；登记着的作业的状态体检能列出来。
/** 内部作业（真的事件存储、手动时钟，停在 start） */
function jobsAt(start: Date) {
  const dir = makeTempDir("ergo-internal-jobs-");
  const clock = new ManualClock(start);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const store = openEventStore({ file: path.join(dir, "ergo.db"), views: [internalJobsView], now: () => clockIso(clock), log });
  onTestFinished(() => store.close());
  const scheduler = createScheduler({ clock, log });
  const jobs = createInternalJobs({ store, scheduler, clock, log, scheduleContext: () => CTX });
  onTestFinished(() => jobs.stop());
  return { clock, jobs, logs };
}

describe("内部作业的结局（411）", () => {
  test("出错的记 failed 和出错原文，跑完的记 ok；上一次开始跑的时间照旧记；只列登记着的", async () => {
    const { clock, jobs, logs } = jobsAt(at(10, 7, 21));
    let fail = true;
    jobs.register({
      name: "flaky",
      schedule: nightly,
      run: async () => {
        if (fail) throw new Error("推理库打不开：SQLITE_BUSY\n    at open (rg.ts:12)");
      },
    });
    jobs.register({ name: "steady", schedule: nightly, run: async () => {} });
    const undo = jobs.register({ name: "gone", schedule: nightly, run: async () => {} });
    undo();
    // 第一次见到：只记"从现在起算"，没有结局
    expect(jobs.registeredStates().map((s) => [s.job, s.lastOutcome])).toEqual([
      ["flaky", undefined],
      ["steady", undefined],
    ]);

    clock.advanceTo(at(10, 8, 3, 30));
    await jobs.whenIdle();
    const flaky = jobs.state("flaky")!;
    expect(flaky).toMatchObject({ lastRunAt: nowIso(at(10, 8, 3, 30)), lastOutcome: "failed", lastError: "推理库打不开：SQLITE_BUSY at open (rg.ts:12)", lastEndedAt: nowIso(at(10, 8, 3, 30)) });
    expect(jobs.state("steady")).toMatchObject({ lastOutcome: "ok", lastEndedAt: nowIso(at(10, 8, 3, 30)) });
    expect(jobs.state("steady")).not.toHaveProperty("lastError");
    expect(logs.some((line) => line.includes("内部作业 flaky 出错"))).toBe(true);
    expect(jobs.registeredStates().map((s) => s.job)).toEqual(["flaky", "steady"]);

    // 下一次跑完了：结局换成 ok，出错的说明不留
    fail = false;
    clock.advanceTo(at(10, 9, 3, 30));
    await jobs.whenIdle();
    expect(jobs.state("flaky")).toMatchObject({ lastOutcome: "ok", lastRunAt: nowIso(at(10, 9, 3, 30)) });
    expect(jobs.state("flaky")).not.toHaveProperty("lastError");
  });
});
