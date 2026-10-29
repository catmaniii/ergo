// 274 号票：长程任务阶段"系统查到的结果"（每轮结束系统直接查到的结果——会话列表那一行、阶段框里的
// "系统在真实环境里查到的"；二狗查不了世界，守护进程从效果日志汇总）：看板卡上那一行（最近一次交上来的阶段的个数，和自报对不上的另写）、
// 阶段框展开后的那一行、阶段详情里逐条的（对外发的说成人话、改了的文件按新建 / 修改 / 删除分开、本机做的别的事、和自报对不上的）。
import { describe, expect, it } from "vitest";
import {
  activeLocaleFrom,
  DEFAULT_LANGUAGE,
  observedLine,
  observedRows,
  setActiveLocale,
  type StageObserved,
  type StageObservedCounts,
  type Task,
  type TaskStage,
  taskObservedLine,
} from "../../src/state/index.ts";
import { TEST_LOCALES } from "../setup-locales.ts";

const counts = (extra: Partial<StageObservedCounts> = {}): StageObservedCounts => ({ at: "2026-10-25T09:00:00.000+08:00", sent: [], created: 0, modified: 0, deleted: 0, mismatches: 0, ...extra });

describe("一行说完系统查到的个数", () => {
  it.each([
    ["对外发的按工具数（工具的名字照守护进程记的，没记的照界面的），文件按新建、修改、删除数", counts({ sent: [{ tool: "git_push", n: 1 }, { tool: "http_request", title: "发 HTTP 请求", n: 2 }], created: 1, modified: 2, deleted: 1 }), "git 推送 1 次、发 HTTP 请求 2 次；新建 1 个、修改 2 个、删除 1 个文件"],
    ["没对外发、只改了文件", counts({ created: 2 }), "没有对外发送；新建 2 个文件"],
    ["什么都没做也照实说（「没有发任何消息」「一张都没删」）", counts(), "没有对外发送；没改文件"],
    ["认不得的工具（MCP 的）写原名", counts({ sent: [{ tool: "mcp__mail__send", n: 1 }] }), "mcp__mail__send 1 次；没改文件"],
  ] as const)("%s", (_name, c, text) => {
    expect(observedLine(c)).toBe(text);
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
  createdAt: "2026-10-25T08:00:00+08:00",
  updatedAt: "2026-10-25T08:00:00+08:00",
});

describe("看板卡上那一行", () => {
  it("取最近一次交上来的那个阶段（按汇总的时间），前面写第几阶段；和自报对不上的几处另给", () => {
    const t = task([
      stage("s1", [], { observed: counts({ at: "2026-10-25T09:00:00.000+08:00", created: 1 }) }),
      stage("s2", ["s1"], { observed: counts({ at: "2026-10-25T10:00:00.000+08:00", sent: [{ tool: "git_push", n: 1 }], modified: 1, mismatches: 1 }) }),
      stage("s3", ["s2"], { state: "running" }),
    ]);
    expect(taskObservedLine(t)).toEqual({ text: "第 2 阶段：git 推送 1 次；修改 1 个文件", mismatches: 1 });
  });

  it("还没有阶段交上来过（或者重开之后清掉了）就没有这一行", () => {
    expect(taskObservedLine(task([stage("s1", [], { state: "running" })]))).toBeUndefined();
    expect(taskObservedLine({ ...task([]), stages: undefined })).toBeUndefined();
  });
});

describe("阶段详情里逐条的", () => {
  const observed: StageObserved = {
    sent: [
      { tool: "git_push", toolTitle: "git 推送", argsSummary: "repoPath=D:/w remote=origin branch=main", kind: "action", at: "2026-10-25T09:05:00.000+08:00" },
      { tool: "http_request", toolTitle: "发 HTTP 请求", argsSummary: "method=POST url=https://hooks.example.com/x data=hello", kind: "request", at: "2026-10-25T09:06:00.000+08:00" },
      { tool: "mcp__mail__send", toolTitle: "邮件 · 发邮件", argsSummary: "to=boss@example.com body=报告好了", kind: "message", at: "2026-10-25T09:07:00.000+08:00" },
    ],
    files: [
      { path: "D:/w/out/report.md", change: "created" },
      { path: "D:/w/README.md", change: "modified" },
      { path: "D:/w/old.md", change: "deleted" },
      { path: "D:/w/out/data.csv", change: "created" },
    ],
    other: [
      { tool: "run_tests", toolTitle: "跑测试", n: 2 },
      { tool: "git_commit", toolTitle: "git 提交", n: 1 },
    ],
    claims: [
      { text: "out/report.md", result: "found" },
      { text: "old.md", result: "deleted" },
      { text: "summary.pdf", result: "untouched" },
    ],
  };

  it("对外发的一件一行（消息、请求、对外动作，说成人话），文件按新建、修改、删除分开，本机做的别的事按工具数，和自报对不上的一条一句", () => {
    const rows = observedRows(observed);
    expect(rows.sent.map((s) => [s.kind, s.text])).toEqual([
      ["对外动作", expect.stringContaining("origin")],
      ["请求", expect.stringContaining("https://hooks.example.com/x")],
      ["消息", expect.stringContaining("boss@example.com")],
    ]);
    expect(rows.files).toEqual([
      { change: "created", label: "新建", paths: ["D:/w/out/report.md", "D:/w/out/data.csv"] },
      { change: "modified", label: "修改", paths: ["D:/w/README.md"] },
      { change: "deleted", label: "删除", paths: ["D:/w/old.md"] },
    ]);
    expect(rows.other).toBe("跑测试 2 次、git 提交 1 次");
    expect(rows.mismatches).toEqual(["自报里提到 old.md，系统查到这一轮把它删了", "自报里提到 summary.pdf，系统没查到这一轮新建或改过它"]);
  });

  it("什么都没做：没有对外的、没有文件、没有别的事", () => {
    expect(observedRows({ sent: [], files: [], other: [], claims: [] })).toEqual({ sent: [], files: [], other: undefined, mismatches: [] });
  });
});

describe("英文下", () => {
  it("一行、单复数、对不上的说法", () => {
    setActiveLocale(activeLocaleFrom(TEST_LOCALES, "en"));
    try {
      expect(observedLine(counts({ sent: [{ tool: "git_push", n: 1 }, { tool: "http_request", title: "HTTP request", n: 2 }], created: 1, deleted: 2 }))).toBe(
        "Git push once, HTTP request ×2; files 1 created, 2 deleted",
      );
      expect(observedLine(counts())).toBe("nothing sent out; no files changed");
      expect(observedRows({ sent: [], files: [], other: [], claims: [{ text: "a.md", result: "untouched" }] }).mismatches).toEqual([
        "The report mentions a.md, but nothing shows it was created or changed this round",
      ]);
    } finally {
      setActiveLocale(activeLocaleFrom(TEST_LOCALES, DEFAULT_LANGUAGE));
    }
  });
});
