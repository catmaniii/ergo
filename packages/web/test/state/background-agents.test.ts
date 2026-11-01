// 368 号票：负责人背后的 agent 说成人话（标题栏入口、一行上写什么、现在在做哪一步、用时），临时事件记下版本号
import { describe, expect, test } from "vitest";
import {
  backgroundAgentDoing,
  backgroundAgentDuration,
  backgroundAgentName,
  backgroundAgentPurpose,
  type BackgroundAgentRow,
  backgroundAgentsEntry,
  backgroundAgentStage,
  backgroundAgentsVersion,
  backgroundCallIssue,
  CHANNELS,
  detailKey,
  detailTitle,
  EVENT_TYPES,
  replay,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

function row(x: Partial<BackgroundAgentRow>): BackgroundAgentRow {
  return { agentId: "sa-1", kind: "sub_agent", taskId: "t-1", taskTitle: "任务", state: "done", toolCalls: 0, tokens: 0, cacheHitTokens: 0, ...x };
}

describe("标题栏上的入口", () => {
  test("从来没有过：不显示", () => {
    expect(backgroundAgentsEntry([])).toBeUndefined();
  });

  test("有运行中的：写几个在干活", () => {
    expect(backgroundAgentsEntry([row({ state: "running" }), row({ state: "running" }), row({ state: "done" })])).toEqual({ running: 2, count: 2, label: "背后有 2 个 agent 在干活" });
  });

  test("没有运行中的也能点开看已完成的", () => {
    expect(backgroundAgentsEntry([row({ state: "done" }), row({ state: "failed" })])).toEqual({ running: 0, count: 2, label: "背后的 agent（2）" });
  });
});

describe("一行上写什么", () => {
  test("名字：子 agent 写编号，评审写评审", () => {
    expect(backgroundAgentName(row({}))).toBe("sa-1");
    expect(backgroundAgentName(row({ agentId: "review-t-1-s1-1", kind: "reviewer" }))).toBe("评审");
  });

  test("派去做什么：工作说明的第一行；评审写验收哪个阶段；老的评审只知道阶段编号；什么都没有也有一句", () => {
    expect(backgroundAgentPurpose(row({ brief: "写 a.txt" }))).toBe("写 a.txt");
    expect(backgroundAgentPurpose(row({ kind: "reviewer", stageId: "s1", stageTitle: "做 a.txt" }))).toBe("验收阶段「做 a.txt」");
    expect(backgroundAgentPurpose(row({ kind: "reviewer", stageId: "s1" }))).toBe("验收阶段 s1");
    expect(backgroundAgentPurpose(row({}))).toBe("（没有记下派去做什么）");
  });

  test("哪个阶段：阶段名、定步阶段的哪一步；不在阶段里的没有", () => {
    expect(backgroundAgentStage(row({ stageId: "s1", stageTitle: "做 a.txt" }))).toBe("阶段 s1「做 a.txt」");
    expect(backgroundAgentStage(row({ stageId: "s1" }))).toBe("阶段 s1");
    expect(backgroundAgentStage(row({ stageId: "s1", stageTitle: "做 a.txt", step: "第一步" }))).toBe("阶段 s1「做 a.txt」的「第一步」");
    expect(backgroundAgentStage(row({}))).toBeUndefined();
  });

  test("现在在做哪一步：运行中的才有；排队、活动状态说得出来的（在调工具）照它说，别的写最近一次工具调用", () => {
    const lastStep = { tool: "read", argsSummary: "src/app.ts", at: "" };
    expect(backgroundAgentDoing(row({ state: "done", lastStep }), { state: "sleeping" })).toBeUndefined();
    expect(backgroundAgentDoing(row({ state: "running", lastStep }), { state: "queued" })).toBe("排队中，等空出名额");
    expect(backgroundAgentDoing(row({ state: "running", lastStep }), { state: "working", detail: { kind: "calling_tool", tool: "运行命令" } })).toContain("运行命令");
    expect(backgroundAgentDoing(row({ state: "running", lastStep }), { state: "sleeping" })).toBe("读 src/app.ts");
    expect(backgroundAgentDoing(row({ state: "running" }), { state: "sleeping" })).toBeUndefined();
  });

  test("用时：结束了的按结束时间，运行中的按现在；没拉起过的没有", () => {
    const start = "2026-10-01T09:00:00.000+08:00";
    const startMs = Date.parse(start);
    expect(backgroundAgentDuration(row({ startedAt: start, endedAt: "2026-10-01T09:00:12.000+08:00" }), startMs + 999_000)).toBe("12 秒");
    expect(backgroundAgentDuration(row({ startedAt: start }), startMs + 192_000)).toBe("3 分 12 秒");
    expect(backgroundAgentDuration(row({ startedAt: start }), startMs + 3_900_000)).toBe("1 小时 5 分");
    expect(backgroundAgentDuration(row({}), startMs)).toBeUndefined();
  });

  test("工具调用：做了的不写，被拦下的、你拒绝了的、出错的写出来", () => {
    expect(backgroundCallIssue("done")).toBeUndefined();
    expect(backgroundCallIssue("blocked")).toBe("被拦下");
    expect(backgroundCallIssue("denied")).toBe("你拒绝了");
    expect(backgroundCallIssue("error")).toBe("出错");
  });
});

test("有变化时的临时事件：这个负责人的版本加一，别的负责人不动；列表、只读对话拿它当该重新取了", () => {
  const push = (maintainerId: string) => frame(CHANNELS.backgroundAgents, 0, EVENT_TYPES.backgroundAgents, { maintainerId });
  const state = replay([push("pm-1"), push("pm-1"), push("pm-2")]);
  expect(backgroundAgentsVersion(state, "pm-1")).toBe(2);
  expect(backgroundAgentsVersion(state, "pm-2")).toBe(1);
  expect(backgroundAgentsVersion(state, "pm-3")).toBe(0);
});

test("详情的这几页：标题、键（换一页正文从头看）", () => {
  expect(detailTitle({ type: "agents", maintainerId: "pm-1" })).toBe("背后的 agent");
  expect(detailTitle({ type: "agent", maintainerId: "pm-1", agentId: "sa-1" })).toBe("sa-1");
  expect(detailTitle({ type: "agent", maintainerId: "pm-1", agentId: "review-t-1-s1-1" })).toBe("评审");
  expect(detailTitle({ type: "archive", title: "项目档案" })).toBe("项目档案");
  expect(new Set([detailKey({ type: "agents", maintainerId: "pm-1" }), detailKey({ type: "agent", maintainerId: "pm-1", agentId: "sa-1" }), detailKey({ type: "archive", title: "项目档案" })]).size).toBe(3);
});
