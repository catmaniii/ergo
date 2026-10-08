import { describe, expect, it } from "vitest";
import { boardGroupOfScheduledJob, scheduledJobActions, scheduledJobStatusText } from "../src/index.ts";

describe("定时作业的状态和动作（19 号票，守护进程和 Web 共用）", () => {
  it("运营中的能暂停、取消；已暂停的能恢复、取消；已取消的什么都不能做", () => {
    expect(scheduledJobActions({ state: "active" })).toEqual(["pause", "cancel"]);
    expect(scheduledJobActions({ state: "paused" })).toEqual(["resume", "cancel"]);
    expect(scheduledJobActions({ state: "cancelled" })).toEqual([]);
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
