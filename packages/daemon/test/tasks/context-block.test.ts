// 重注入块（规格第 8 节"重注入块"）：每次唤起维护者、每次压缩之后注入的固定内容——计划摘要 + 当前阶段 + 授权 + 边界。
// 纯函数：同样的任务、计划、授权说法，生成同样的文字。授权、时序规则只给当前阶段和它所属阶段组上的。
import type { Task, TaskStage } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { contextBlockText } from "../../src/tasks/context-block.ts";
import { initialStages } from "@ergo/protocol";
import { samplePlan } from "../helpers/plans.ts";

const plan = samplePlan();

function taskWith(list: TaskStage[], extra: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    title: "X 的调研",
    summary: "整理一份 X 的调研",
    state: "running",
    origin: "request",
    maintainerId: "tm-1",
    projects: [],
    createdAt: "2026-10-08T09:00:00+08:00",
    updatedAt: "2026-10-08T09:00:00+08:00",
    stages: { total: list.length, list },
    ...extra,
  } as Task;
}

const block = (list: TaskStage[], extra: Partial<Task> = {}) =>
  contextBlockText({
    task: taskWith(list, extra),
    plan,
    goal: "整理一份 X 的调研",
    cwd: "D:\\data\\outputs\\t-1",
    grantInfo: { "push-report": { toolTitle: "推送", categoryTitles: ["以我的名义对外发送或发布"], disposition: "planned_only" } },
  });

describe("重注入块", () => {
  it("第 1 阶段在做：计划摘要、各阶段状态、当前阶段的交付件和验收标准、它自己的授权（别的阶段的不列）、边界", () => {
    const text = block(initialStages(plan).map((s, i) => (i === 0 ? { ...s, state: "running" } : s)));
    expect(text.split("\n").slice(0, 7)).toEqual([
      "【运行时注入】计划摘要、当前阶段、授权、边界：每次唤起和每次压缩之后重新给出；计划、授权、阶段以这里为准，不靠会话记忆。",
      "任务 t-1「X 的调研」：执行中，第 1/2 阶段",
      "目标：整理一份 X 的调研",
      "阶段：",
      "- s1「收集资料」：进行中",
      "- s2「写调研报告」：未开始（前置 s1）",
      "当前阶段 s1「收集资料」（进行中）",
    ]);
    expect(text).toContain("- 验收标准：清单里至少有五个来源（评审）");
    expect(text).toContain("读公开网页");
    expect(text).not.toContain("推送");
    expect(text).toContain("- 工作目录 D:\\data\\outputs\\t-1：文件工具只能写这里；工具包：bash 开，联网开");
  });

  it("第 2 阶段在做：授权和时序规则换成它的（加上所属阶段组的），定步模式列出步骤", () => {
    const list = initialStages(plan).map((s, i) => ({ ...s, state: i === 0 ? ("accepted" as const) : ("running" as const) }));
    const text = block(list);
    expect(text).toContain("任务 t-1「X 的调研」：执行中，第 2/2 阶段");
    expect(text).toContain("- s1「收集资料」：已验收");
    expect(text).toContain("- 模式：定步：列大纲 → 写正文 → 自查");
    expect(text).toContain("把报告推送到 origin 的 main");
    expect(text).toContain("推送前先跑测试");
    expect(text).not.toContain("读公开网页");
  });

  it("任务书里有验收标准的：目标后面接着写（计划变更改了目标、验收标准的，重注入的是新的一版，14 号票）", () => {
    const text = contextBlockText({
      task: taskWith(initialStages(plan).map((s, i) => (i === 0 ? { ...s, state: "running" } : s))),
      plan,
      goal: "整理一份 X 和 Y 的对比表",
      criteria: ["对比表至少五个维度", "附上来源"],
      cwd: "D:\\data\\outputs\\t-1",
      grantInfo: {},
    });
    expect(text.split("\n").slice(2, 4)).toEqual(["目标：整理一份 X 和 Y 的对比表", "任务的验收标准：对比表至少五个维度；附上来源"]);
  });

  it("在等用户：任务和阶段上写明等什么", () => {
    const list = initialStages(plan).map((s, i) => (i === 0 ? { ...s, state: "waiting" as const, waitReason: "acceptance" as const } : s));
    const text = block(list, { state: "waiting_for_user", waitReason: "acceptance" });
    expect(text).toContain("任务 t-1「X 的调研」：等我（由我验收），第 1/2 阶段");
    expect(text).toContain("- s1「收集资料」：等我（由我验收）");
  });
});
