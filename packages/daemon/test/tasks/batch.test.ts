// 一次对多个任务做同一个控制（90 号票，tasks/batch.ts）：一个一个交给单个任务的那条路，各自成败、逐条回报（按请求里的先后），
// 每个任务用由这次幂等键派生的幂等键；做不了的（状态不对、找不到）写明原因，不影响别的；别的错记日志、回"内部出错"。
// 单个任务的那条路换成假的；真的守护进程上的在主切面 test/main/task-batch.test.ts。
import type { TaskActionParams, TaskActionResult } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { RequestRejected } from "../../src/errors.ts";
import { createTaskBatch } from "../../src/tasks/batch.ts";

describe("一次对多个任务做同一个控制", () => {
  it("逐个交给单个任务的那条路（派生的幂等键），各自成败、按先后逐条回报；晚一点才有结果的照样等", async () => {
    const calls: Array<[TaskActionParams, string]> = [];
    const logs: string[] = [];
    const batch = createTaskBatch({
      act: (params, key): TaskActionResult | Promise<TaskActionResult> => {
        calls.push([params, key]);
        if (params.taskId === "t-2") throw new RequestRejected("not_allowed", "任务现在是已完成，不能暂停");
        if (params.taskId === "t-3") throw new RequestRejected("not_found", "没有任务 t-3");
        if (params.taskId === "t-4") throw new Error("磁盘坏了");
        if (params.taskId === "t-5") return Promise.resolve({ taskId: "t-5", state: "paused" });
        return { taskId: params.taskId, state: "paused" };
      },
      log: (line) => logs.push(line),
    });
    const result = await batch({ taskIds: ["t-1", "t-2", "t-3", "t-4", "t-5"], action: "pause" }, "k-1");
    expect(calls).toEqual([
      [{ taskId: "t-1", action: "pause" }, "k-1#t-1"],
      [{ taskId: "t-2", action: "pause" }, "k-1#t-2"],
      [{ taskId: "t-3", action: "pause" }, "k-1#t-3"],
      [{ taskId: "t-4", action: "pause" }, "k-1#t-4"],
      [{ taskId: "t-5", action: "pause" }, "k-1#t-5"],
    ]);
    expect(result.results).toEqual([
      { taskId: "t-1", ok: true, state: "paused" },
      { taskId: "t-2", ok: false, code: "not_allowed", message: "任务现在是已完成，不能暂停" },
      { taskId: "t-3", ok: false, code: "not_found", message: "没有任务 t-3" },
      { taskId: "t-4", ok: false, code: "internal", message: "守护进程内部出错" },
      { taskId: "t-5", ok: true, state: "paused" },
    ]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("磁盘坏了");
  });

  it("晚一点才有结果的被拒（Promise 拒绝）也只算这一个没做成", async () => {
    const batch = createTaskBatch({
      act: (params) => (params.taskId === "t-1" ? Promise.reject(new RequestRejected("conflict", "已被处理")) : { taskId: params.taskId, state: "archived" }),
      log: () => undefined,
    });
    expect((await batch({ taskIds: ["t-1", "t-2"], action: "archive" }, "k")).results).toEqual([
      { taskId: "t-1", ok: false, code: "conflict", message: "已被处理" },
      { taskId: "t-2", ok: true, state: "archived" },
    ]);
  });
});
