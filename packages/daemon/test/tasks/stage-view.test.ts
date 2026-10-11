// 阶段详情从守护进程现取的（84 号票，tasks/stage-view.ts）：效果日志里的一条在哪儿生效（只看的不列，本机、对外），
// 从这里重做时列出的"这几步已经做了的事"（重开范围里的阶段、这一轮的、同一件只列一次），没有这个阶段时没有。
// 纯函数，表格驱动；授权已用几次和守卫计次同一个函数（guard/grants.ts 的 grantUses），在主切面测试里查。
import type { Task, TaskStage } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_REGISTRY, type EffectRecord, TOOL } from "../../src/guard/index.ts";
import { effectReach, stageEffects, taskStageView } from "../../src/tasks/stage-view.ts";

const tools = BUILTIN_TOOL_REGISTRY;
const T0 = Date.parse("2026-10-11T09:00:00+08:00");

describe("效果日志里的一条在哪儿生效", () => {
  it.each([
    ["写文件是本机", TOOL.write, { path: "D:/w/report.md" }, "local"],
    ["读文件只看", TOOL.read, { path: "D:/w/report.md" }, "look"],
    ["删除是本机", TOOL.delete, { path: "D:/w/old.md" }, "local"],
    ["推送是对外", TOOL.git_push, { repoPath: "D:/w", remote: "origin", branch: "main" }, "external"],
    ["不带数据的 GET 只看", TOOL.http_request, { method: "GET", url: "https://example.com/a" }, "look"],
    ["带数据的请求是对外（哪怕写成 GET）", TOOL.http_request, { method: "GET", url: "https://example.com/a", data: ["@a.json"] }, "external"],
    ["POST 是对外", TOOL.http_request, { method: "POST", url: "https://example.com/a" }, "external"],
    ["只看的命令只看", TOOL.shell_command, { program: "ls" }, "look"],
    ["别的命令算本机", TOOL.shell_command, { program: "python", paths: ["D:/w/move.py"] }, "local"],
  ] as const)("%s", (_name, tool, args, reach) => {
    expect(effectReach({ tool, args }, tools)).toBe(reach);
  });

  it("没登记的工具（守护进程代为执行的二狗自己的工具）认不出，不列", () => {
    expect(effectReach({ tool: "complete_stage", args: {} }, tools)).toBeUndefined();
  });
});

const stage = (stageId: string, dependsOn: string[], extra: Partial<TaskStage> = {}): TaskStage => ({ stageId, title: stageId, state: "accepted", dependsOn, acceptance: [], attempts: 1, ...extra });
const task = (list: TaskStage[]): Task => ({
  id: "t-1",
  title: "调研",
  summary: "调研",
  state: "running",
  origin: "button",
  maintainerId: "tm-1",
  projects: [],
  projectIds: [],
  projectScope: "none",
  stages: { total: list.length, list },
  createdAt: "2026-10-11T08:00:00+08:00",
  updatedAt: "2026-10-11T08:00:00+08:00",
});
let seq = 0;
const effect = (stageId: string | null, tool: string, args: Record<string, unknown>, minutes: number, taskId: string | null = "t-1", reworkNo?: number): EffectRecord => ({
  seq: ++seq,
  taskId,
  stageId,
  agentId: "tm-1",
  tool,
  args,
  summary: "",
  at: T0 + minutes * 60_000,
  ...(reworkNo === undefined ? {} : { reworkNo }),
});

describe("这几步已经做了的事", () => {
  // s1 → s2 → s3；s2 在任务第 1 次重做时重开过（之前那一轮判定的不算，哪怕结束得晚），s3 没开始过
  const t = task([stage("s1", []), stage("s2", ["s1"], { state: "running", reopenNo: 1, startedAt: "2026-10-11T09:31:00+08:00" }), stage("s3", ["s2"], { state: "pending", attempts: 0 })]);
  const log = [
    effect("s1", TOOL.write, { path: "D:/w/sources.md" }, 5),
    effect("s1", TOOL.read, { path: "D:/w/sources.md" }, 6),
    effect("s1", TOOL.write, { path: "D:/w/sources.md" }, 7),
    effect("s2", TOOL.write, { path: "D:/w/draft-old.md" }, 20),
    // 重做之前判定、重做之后才结束的（迟到的结果）：记着判定那一刻的重做次数 0，不算新的一轮
    effect("s2", TOOL.write, { path: "D:/w/late.md" }, 35),
    effect("s2", TOOL.write, { path: "D:/w/report.md" }, 40, "t-1", 1),
    effect("s2", TOOL.git_push, { repoPath: "D:/w", remote: "origin", branch: "main" }, 45, "t-1", 1),
    effect("s2", "complete_stage", { summary: "写好了" }, 46),
    effect("s1", TOOL.write, { path: "D:/w/other.md" }, 50, "t-2"),
    effect(null, TOOL.write, { path: "D:/w/chat.md" }, 51, null),
  ];

  it("重开范围里的阶段这一轮的（判定时的重做次数不小于阶段重开时的）：只看的、认不出的、别的任务和对话里的不列，同一件只列一次，按先后", () => {
    expect(stageEffects(t, ["s1", "s2"], log, tools).map((e) => [e.stageId, e.tool, e.toolTitle, e.argsSummary, e.reach])).toEqual([
      ["s1", TOOL.write, "写文件", "D:/w/sources.md", "local"],
      ["s2", TOOL.write, "写文件", "D:/w/report.md", "local"],
      ["s2", TOOL.git_push, "git 推送", "repoPath=D:/w remote=origin branch=main", "external"],
    ]);
    expect(stageEffects(t, ["s1", "s2"], log, tools)[0]!.at).toBe("2026-10-11T09:05:00.000+08:00");
  });

  it("阶段详情现取的：重做范围是它和开始过的下游；没有这个阶段时没有；还没开始执行（守卫没有这个任务）时授权用量是空的", () => {
    const env = { cwd: "D:/w", homeDir: "C:/Users/me" };
    const view = taskStageView({ task: t, stageId: "s1", guardTask: null, effects: log, tools, env });
    expect(view?.reopenScope).toEqual(["s1", "s2"]);
    expect(view?.grantUses).toEqual([]);
    expect(view?.effects.map((e) => e.argsSummary)).toEqual(["D:/w/sources.md", "D:/w/report.md", "repoPath=D:/w remote=origin branch=main"]);
    expect(taskStageView({ task: t, stageId: "s3", guardTask: null, effects: log, tools, env })?.reopenScope).toEqual(["s3"]);
    expect(taskStageView({ task: t, stageId: "nope", guardTask: null, effects: log, tools, env })).toBeUndefined();
  });
});
