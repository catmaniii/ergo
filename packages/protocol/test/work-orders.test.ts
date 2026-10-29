// 工单的名字和纯函数（16、17 号票）：流水线的三栏、状态写成一句，守护进程和 Web 共用
import { describe, expect, test } from "vitest";
import { isActiveWorkOrder, WORK_ORDER_STATES, workOrderLane, workOrderStatusText } from "../src/index.ts";

describe("工单", () => {
  test("待接排在排队中，进行中和等澄清是维护者手上的那一张，已结束的在已结束；待你确认、等阶段开始的还没派出，不在流水线上", () => {
    expect(WORK_ORDER_STATES.map((state) => [state, workOrderLane({ state, source: "user_task" }), isActiveWorkOrder({ state })])).toEqual([
      ["awaiting_confirm", undefined, false],
      ["planned", undefined, false],
      ["pending", "queued", false],
      ["in_progress", "active", true],
      ["clarifying", "active", true],
      ["ended", "ended", false],
    ]);
  });

  test("任务维护者派的工单（17 号票）：派出过的结束后在已结束，没派出就结束的（你拒绝了、任务先结束了）不在流水线上", () => {
    expect(workOrderLane({ state: "ended", source: "task_maintainer", dispatchedAt: "2026-10-08T09:00:00.000+08:00" })).toBe("ended");
    expect(workOrderLane({ state: "ended", source: "task_maintainer" })).toBeUndefined();
    expect(workOrderStatusText({ state: "awaiting_confirm" })).toBe("待你确认");
    expect(workOrderStatusText({ state: "planned" })).toBe("等阶段开始");
    expect(workOrderStatusText({ state: "ended", outcome: "declined" })).toBe("已结束 · 没派出");
  });

  test("已结束的带上结局", () => {
    expect(workOrderStatusText({ state: "clarifying" })).toBe("等澄清");
    expect(workOrderStatusText({ state: "ended", outcome: "returned" })).toBe("已结束 · 退回");
    expect(workOrderStatusText({ state: "ended", outcome: "unable" })).toBe("已结束 · 做不了");
    // 那一段没写回项目档案的如实写上（16 号票评审后：写回中途重置的照常算完成；催了还没写回的转用户拍板）
    expect(workOrderStatusText({ state: "ended", outcome: "done", unwritten: "reset" })).toBe("已结束 · 完成 · 重置时这段没写回档案");
    expect(workOrderStatusText({ state: "ended", outcome: "done", unwritten: "nudged" })).toBe("已结束 · 完成 · 催了还没写回档案");
  });
});
