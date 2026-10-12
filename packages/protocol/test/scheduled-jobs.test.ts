import { describe, expect, it } from "vitest";
import {
  boardGroupOfScheduledJob,
  canRescheduleJob,
  canRunJobNow,
  externalEvents,
  JOB_RUN_TRIGGER_LABEL,
  lastTriggerEvent,
  MANUAL_TRIGGER_SOURCE,
  manualTriggerSummary,
  scheduledJobActions,
  scheduledJobStatusText,
} from "../src/index.ts";

describe("定时作业的状态和动作（19 号票，守护进程和 Web 共用）", () => {
  it("运营中的能暂停、取消；已暂停的能恢复、取消；已取消的什么都不能做", () => {
    expect(scheduledJobActions({ state: "active" })).toEqual(["pause", "cancel"]);
    expect(scheduledJobActions({ state: "paused" })).toEqual(["resume", "cancel"]);
    expect(scheduledJobActions({ state: "cancelled" })).toEqual([]);
  });

  it("能不能改时间（98 号票）：定时的运营中、已暂停的能改；已取消的、事件触发的（没有时间表）不能", () => {
    const daily = { kind: "daily" as const, time: "09:00" };
    expect(canRescheduleJob({ state: "active", schedule: daily })).toBe(true);
    expect(canRescheduleJob({ state: "paused", schedule: daily })).toBe(true);
    expect(canRescheduleJob({ state: "cancelled", schedule: daily })).toBe(false);
    expect(canRescheduleJob({ state: "active" })).toBe(false);
  });

  it("能不能立即运行一次（100 号票）：运营中、已暂停的能（暂停着的跑一次照旧暂停），定时、事件触发的都能；已取消的不能", () => {
    expect(canRunJobNow({ state: "active" })).toBe(true);
    expect(canRunJobNow({ state: "paused" })).toBe(true);
    expect(canRunJobNow({ state: "cancelled" })).toBe(false);
    expect(JOB_RUN_TRIGGER_LABEL.manual).toBe("手动");
  });

  it("手动的那次触发怎么说；交给 agent、卡上“最近一次触发”的事件不算它和到点的", () => {
    const at = new Date(2026, 9, 12, 10, 5);
    expect(manualTriggerSummary(at)).toBe("10 月 12 日（周一）10:05 你让它立即运行一次");
    const manual = { source: MANUAL_TRIGGER_SOURCE, at: "2026-10-12T10:05:00.000+08:00", summary: manualTriggerSummary(at) };
    const folder = { source: "folder", event: "file_added", at: "2026-10-12T10:06:00.000+08:00", summary: "新增了 a.pdf" };
    const run = { runId: "j-1-r1", jobId: "j-1", trigger: "manual" as const, dueAt: manual.at, events: [manual, folder], state: "queued" as const, queuedAt: manual.at };
    expect(externalEvents(run)).toEqual([folder]);
    expect(lastTriggerEvent({ ...run, events: [folder, manual] })).toEqual(folder);
    expect(lastTriggerEvent({ ...run, events: [manual] })).toBeUndefined();
  });

  it("运营中、已暂停的都在看板的运营中分组；已取消的不上看板", () => {
    expect(boardGroupOfScheduledJob("active")).toBe("ops");
    expect(boardGroupOfScheduledJob("paused")).toBe("ops");
    expect(boardGroupOfScheduledJob("cancelled")).toBeUndefined();
  });

  it("作业卡上的状态写明暂停的原因：自动暂停写连续失败了几次，因项目停用而暂停的写项目已停用，用户自己暂停的只写已暂停", () => {
    expect(scheduledJobStatusText({ state: "active" })).toBe("运营中");
    expect(scheduledJobStatusText({ state: "paused", pausedBy: "user" })).toBe("已暂停");
    expect(scheduledJobStatusText({ state: "paused", pausedBy: "failures", consecutiveFailures: 3 })).toBe("已暂停（连续失败 3 次，自动暂停）");
    expect(scheduledJobStatusText({ state: "paused", pausedBy: "project_retired" })).toBe("已暂停（项目已停用）");
    expect(scheduledJobStatusText({ state: "cancelled" })).toBe("已取消");
  });
});
