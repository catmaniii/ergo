// 阶段详情从守护进程现取的（84 号票，tasks/stage-view.ts）：效果日志里的一条在哪儿生效（只看的不列，本机、对外），
// 从这里重做时列出的"这几步已经做了的事"（重开范围里的阶段、这一轮的、同一件只列一次），没有这个阶段时没有。
// 纯函数，表格驱动；授权已用几次和守卫计次同一个函数（guard/grants.ts 的 grantUses），在主切面测试里查。
// 274 号票：一个阶段这一轮系统查到的结果（发了什么、改了哪些文件、本机做的别的事）、维护者自报里提到的文件对不对得上、看板卡上的个数。
import type { Task, TaskStage } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_REGISTRY, type EffectRecord, TOOL, type ToolRegistry } from "../../src/guard/index.ts";
import { claimChecks, claimedFiles, effectReach, observedCounts, stageEffects, stageObserved, taskStageView } from "../../src/tasks/stage-view.ts";

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

// ───────────────────────── 274 号票：系统查到的结果 ─────────────────────────

/** 内置的加一个登记过的、会发消息的 MCP 工具（有收件人） */
const withMail: ToolRegistry = {
  ...tools,
  mcp__mail__send: {
    name: "mcp__mail__send",
    title: "邮件 · 发邮件",
    source: "mcp",
    categories: ["external_send"],
    args: { to: { kind: "recipient" }, body: { kind: "content" } },
    network: true,
    outbound: true,
  },
};

describe("一个阶段这一轮系统查到的结果（274 号票）", () => {
  // s1 做完了；s2 在任务第 1 次重做时重开过，这一轮的从重开之后算
  const t = task([
    stage("s1", [], { summary: "报告在 out/report.md，删掉了 old.md，另有 summary.pdf" }),
    stage("s2", ["s1"], { state: "running", reopenNo: 1, startedAt: "2026-10-11T09:31:00+08:00" }),
    stage("s3", ["s2"], { state: "pending", attempts: 0 }),
  ]);
  const log = [
    // 新建（判定前不存在）后又改：还是新建
    { ...effect("s1", TOOL.write, { path: "D:/w/out/report.md" }, 1), created: ["D:/w/out/report.md"] },
    effect("s1", TOOL.edit, { path: "D:/w/out/report.md" }, 2),
    // 改已有的
    effect("s1", TOOL.edit, { path: "D:/w/README.md" }, 3),
    // 删除
    effect("s1", TOOL.delete, { path: "D:/w/old.md" }, 4),
    // 删了又写（判定前已不在，写的时候按新建记）：算修改
    effect("s1", TOOL.delete, { path: "D:/w/data.csv" }, 5),
    { ...effect("s1", TOOL.write, { path: "D:/w/data.csv" }, 6), created: ["D:/w/data.csv"] },
    // 只看的、在哪儿做的（仓库路径）不算改了文件
    effect("s1", TOOL.read, { path: "D:/w/README.md" }, 7),
    // 本机做的、看不出改了哪些文件的：按工具数（提交只记下改动，不算改了文件）
    effect("s1", TOOL.run_tests, { repoPath: "D:/w" }, 8),
    effect("s1", TOOL.run_tests, { repoPath: "D:/w", args: "--watch=false" }, 9),
    effect("s1", TOOL.git_commit, { repoPath: "D:/w", message: "报告", paths: ["D:/w/out/report.md"] }, 10),
    // 对外：请求、对外动作、消息；同一件只列一次
    effect("s1", TOOL.http_request, { method: "POST", url: "https://hooks.example.com/x", data: ["hello"] }, 11),
    effect("s1", TOOL.git_push, { repoPath: "D:/w", remote: "origin", branch: "main" }, 12),
    effect("s1", TOOL.git_push, { repoPath: "D:/w", remote: "origin", branch: "main" }, 13),
    effect("s1", "mcp__mail__send", { to: "boss@example.com", body: "报告好了" }, 14),
    // 认不出的（二狗自己的工具）不算
    effect("s1", "complete_stage", { summary: "写好了" }, 15),
    // 别的阶段、别的任务、之前那一轮的不算
    effect("s2", TOOL.write, { path: "D:/w/draft-old.md" }, 20),
    effect("s2", TOOL.write, { path: "D:/w/draft.md" }, 40, "t-1", 1),
    effect("s1", TOOL.write, { path: "D:/w/other.md" }, 50, "t-2"),
  ];

  it("发了什么（消息、请求、对外动作）、改了哪些文件（新建 / 修改 / 删除，按第一次动它的先后）、本机做的别的事（按工具数）", () => {
    const o = stageObserved(t, "s1", log, withMail);
    expect(o.sent.map((s) => [s.tool, s.toolTitle, s.kind])).toEqual([
      [TOOL.http_request, "发 HTTP 请求", "request"],
      [TOOL.git_push, "git 推送", "action"],
      ["mcp__mail__send", "邮件 · 发邮件", "message"],
    ]);
    expect(o.sent[0]!.argsSummary).toContain("https://hooks.example.com/x");
    expect(o.sent[0]!.at).toBe("2026-10-11T09:11:00.000+08:00");
    expect(o.files).toEqual([
      { path: "D:/w/out/report.md", change: "created" },
      { path: "D:/w/README.md", change: "modified" },
      { path: "D:/w/old.md", change: "deleted" },
      { path: "D:/w/data.csv", change: "modified" },
    ]);
    expect(o.other.map((x) => [x.tool, x.toolTitle, x.n])).toEqual([
      [TOOL.run_tests, "跑测试", 2],
      [TOOL.git_commit, "git 提交", 1],
    ]);
  });

  it("这一轮只算阶段上次重开之后判定的（之前那一轮的不算）；没做过事的阶段什么都是空的", () => {
    expect(stageObserved(t, "s2", log, withMail).files).toEqual([{ path: "D:/w/draft.md", change: "modified" }]);
    expect(stageObserved(t, "s3", log, withMail)).toEqual({ sent: [], files: [], other: [], claims: [] });
  });

  it.each([
    ["中文里夹着的相对路径和文件名", "报告在 out/report.md，资料清单在 sources.md。", ["out/report.md", "sources.md"]],
    ["引号里的中文文件名", "交付件：「月度总结.md」和“附录 A.docx”", ["月度总结.md", "附录 A.docx"]],
    ["反引号里的", "改了 `src/index.ts` 和 `package.json`", ["src/index.ts", "package.json"]],
    ["Windows 绝对路径", String.raw`表格在 D:\w\out\a.csv`, [String.raw`D:\w\out\a.csv`]],
    ["目录", "全部放在 outputs/ 下面", ["outputs/"]],
    ["网址、邮箱、技术名、版本号、数字不算", "用 Node.js 写了 build.js，见 https://example.com/a.md，发给 me@example.com，v1.2.3，共 3.5 万字", ["build.js"]],
    ["同一个只算一次（句末的点不算）", "写了 report.md。又改了 report.md.", ["report.md"]],
    ["没提到文件", "这一阶段做完了", []],
  ] as const)("自报里提到的文件：%s", (_name, summary, expected) => {
    expect(claimedFiles(summary)).toEqual(expected);
  });

  it("自报里提到的文件对不对得上：这一轮新建或改过的对得上，删了的标出来，没查到的标出来；目录看里面有没有改过的，绝对路径照全路径比", () => {
    const files = stageObserved(t, "s1", log, withMail).files;
    expect(claimChecks(String.raw`报告在 out/report.md，删掉了 old.md，另有 summary.pdf；都在 out/ 里。表格 D:\w\data.csv、D:\x\data.csv`, files)).toEqual([
      { text: "out/report.md", result: "found" },
      { text: "old.md", result: "deleted" },
      { text: "summary.pdf", result: "untouched" },
      { text: "out/", result: "found" },
      { text: String.raw`D:\w\data.csv`, result: "found" },
      { text: String.raw`D:\x\data.csv`, result: "untouched" },
    ]);
    expect(claimChecks(undefined, files)).toEqual([]);
  });

  it("看板卡上那一行用的个数：对外的按工具数（同一件只算一次，带上工具的名字），文件按怎么了数，和自报对不上的几处；不记路径、网址、内容", () => {
    const o = { ...stageObserved(t, "s1", log, withMail), claims: claimChecks(t.stages!.list![0]!.summary, stageObserved(t, "s1", log, withMail).files) };
    expect(observedCounts(o, "2026-10-11T09:20:00+08:00")).toEqual({
      at: "2026-10-11T09:20:00+08:00",
      sent: [
        { tool: TOOL.http_request, title: "发 HTTP 请求", n: 1 },
        { tool: TOOL.git_push, title: "git 推送", n: 1 },
        { tool: "mcp__mail__send", title: "邮件 · 发邮件", n: 1 },
      ],
      created: 1,
      modified: 2,
      deleted: 1,
      mismatches: 2,
    });
  });

  it("看板卡上那一行的个数不算缓存和编译产物（311 号票：__pycache__、*.pyc、node_modules……）；阶段详情里逐条的照列", () => {
    const files = [
      { path: "D:/w/todo.py", change: "created" as const },
      { path: "D:/w/__pycache__/todo.cpython-312.pyc", change: "created" as const },
      { path: "D:/w/build/app.pyc", change: "created" as const },
      { path: "D:/w/node_modules/left-pad/index.js", change: "modified" as const },
      { path: "D:/w/.pytest_cache/v/cache/lastfailed", change: "deleted" as const },
      { path: "D:/w/README.md", change: "modified" as const },
    ];
    expect(observedCounts({ sent: [], files, other: [], claims: [] }, "2026-10-11T09:20:00+08:00")).toEqual({ at: "2026-10-11T09:20:00+08:00", sent: [], created: 1, modified: 1, deleted: 0, mismatches: 0 });
  });

  it("阶段详情现取的带上系统查到的结果（自报里提到的文件按阶段上记着的那一两句核）；没开始过的阶段没有", () => {
    const env = { cwd: "D:/w", homeDir: "C:/Users/me" };
    const view = taskStageView({ task: t, stageId: "s1", guardTask: null, effects: log, tools: withMail, env });
    expect(view?.observed?.files.map((f) => f.change)).toEqual(["created", "modified", "deleted", "modified"]);
    expect(view?.observed?.claims).toEqual([
      { text: "out/report.md", result: "found" },
      { text: "old.md", result: "deleted" },
      { text: "summary.pdf", result: "untouched" },
    ]);
    expect(taskStageView({ task: t, stageId: "s3", guardTask: null, effects: log, tools: withMail, env })?.observed).toBeUndefined();
  });
});
