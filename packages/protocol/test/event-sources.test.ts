// 事件来源登记表（77 号票）：登记表的形状、事件触发方式的检查、文件名模式、在等什么事件的说法、流程步骤里的占位（认、代入）、
// 交给 agent 的结构化事件。
import { describe, expect, it } from "vitest";
import {
  describeEventTrigger,
  EVENT_SOURCES,
  eventPlaceholdersIn,
  eventRecord,
  eventSourceOf,
  eventTriggerProblems,
  eventValueOf,
  fileNameMatches,
  jobTriggerText,
  lastTriggerEvent,
  substituteEventValues,
  triggerFields,
} from "../src/index.ts";

describe("登记表", () => {
  it("第一批两个来源：二狗内部事件、本机文件夹变化；每种事件的字段都登记了，过滤条件的键不重复", () => {
    expect(EVENT_SOURCES.map((s) => s.id)).toEqual(["ergo", "folder"]);
    expect(eventSourceOf("ergo")!.events.map((e) => e.id)).toEqual(["task_done", "task_failed", "task_waiting", "project_state", "run_failed"]);
    expect(eventSourceOf("folder")!.events.map((e) => e.id)).toEqual(["added", "changed", "removed"]);
    for (const source of EVENT_SOURCES) {
      for (const kind of source.events) for (const key of kind.fields) expect(source.fields.map((f) => f.key)).toContain(key);
      expect(new Set(source.filters.map((f) => f.key)).size).toBe(source.filters.length);
      expect(new Set(source.fields.map((f) => f.label)).size).toBe(source.fields.length);
    }
  });

  it("选的事件带哪些字段（按登记表的先后）", () => {
    expect(triggerFields({ source: "folder", events: ["removed"] }).map((f) => f.label)).toEqual(["文件路径", "文件名", "相对路径", "文件夹", "变化"]);
    expect(triggerFields({ source: "ergo", events: ["project_state"] }).map((f) => f.label)).toEqual(["项目编号", "项目名", "原来的状态", "现在的状态"]);
    expect(triggerFields({ source: "mail", events: ["x"] })).toEqual([]);
  });
});

describe("事件触发方式的检查", () => {
  it("来源要认得、至少一种事件、事件和过滤条件要是这个来源的、类型对、必填的写了", () => {
    expect(eventTriggerProblems({ kind: "event", source: "folder", events: ["added"], filter: { path: "D:\\收件箱", recursive: true, pattern: "*.pdf" } })).toEqual([]);
    expect(eventTriggerProblems({ kind: "event", source: "ergo", events: ["task_done"] })).toEqual([]);
    expect(eventTriggerProblems({ kind: "event", source: "mail", events: ["received"] })[0]).toContain("没有这个事件来源：mail");
    expect(eventTriggerProblems({ kind: "event", source: "folder", events: [], filter: { path: "D:\\x" } })[0]).toContain("至少选一种事件");
    expect(eventTriggerProblems({ kind: "event", source: "folder", events: ["moved"], filter: { path: "D:\\x" } })).toEqual(["本机文件夹变化没有这种事件：moved"]);
    expect(eventTriggerProblems({ kind: "event", source: "folder", events: ["added"] })).toEqual(["要写过滤条件「文件夹」"]);
    expect(eventTriggerProblems({ kind: "event", source: "folder", events: ["added"], filter: { path: "  " } })).toEqual(["要写过滤条件「文件夹」"]);
    expect(eventTriggerProblems({ kind: "event", source: "folder", events: ["added"], filter: { path: "D:\\x", recursive: "是" } })).toEqual(["过滤条件「含子文件夹」是开关（true 或 false）"]);
    expect(eventTriggerProblems({ kind: "event", source: "ergo", events: ["task_done"], filter: { folder: "x" } })[0]).toContain("二狗内部事件不能按 folder 过滤");
  });
});

describe("文件名模式", () => {
  it("* 是任意几个字、? 是一个字，不分大小写；几个模式用分号、逗号隔开；没写的都对得上", () => {
    expect(fileNameMatches("报告.PDF", "*.pdf")).toBe(true);
    expect(fileNameMatches("报告.pdf.txt", "*.pdf")).toBe(false);
    expect(fileNameMatches("周报-03.docx", "周报-??.docx")).toBe(true);
    expect(fileNameMatches("周报-3.docx", "周报-??.docx")).toBe(false);
    expect(fileNameMatches("猫.png", "*.jpg; *.png")).toBe(true);
    expect(fileNameMatches("猫.gif", "*.jpg，*.png")).toBe(false);
    expect(fileNameMatches("a+b(1).txt", "a+b(1).txt")).toBe(true);
    expect(fileNameMatches("随便.bin", undefined)).toBe(true);
  });
});

describe("在等什么事件", () => {
  it("文件夹、二狗内部事件各一句；触发登记、提醒的说法", () => {
    expect(describeEventTrigger({ kind: "event", source: "folder", events: ["added", "changed"], filter: { path: "D:\\收件箱", recursive: true, pattern: "*.pdf" } })).toBe("本机文件夹 D:\\收件箱（含子文件夹）里新增、修改 *.pdf 文件");
    expect(describeEventTrigger({ kind: "event", source: "folder", events: ["removed"], filter: { path: "D:\\x" } })).toBe("本机文件夹 D:\\x里删除文件");
    expect(describeEventTrigger({ kind: "event", source: "ergo", events: ["task_done", "task_failed"], filter: { taskId: "t-3" } }, { task: () => "整理发票" })).toBe("二狗内部：任务 t-3「整理发票」的任务完成、任务失败");
    expect(describeEventTrigger({ kind: "event", source: "ergo", events: ["project_state"], filter: { projectId: "p-1" } }, { project: () => "记账" })).toBe("二狗内部：项目「记账」的项目状态变化");
    expect(describeEventTrigger({ kind: "event", source: "ergo", events: ["run_failed"] })).toBe("二狗内部：一次运行失败");
    expect(jobTriggerText({ event: { kind: "event", source: "folder", events: ["added"], filter: { path: "D:\\x" } } })).toBe("事件发生时：本机文件夹 D:\\x里新增文件");
    expect(jobTriggerText({ schedule: { kind: "daily", time: "09:00" } })).toBe("每天 09:00");
  });

  it("最近一次触发：一次运行最后一个事件（时间到了的不算）", () => {
    const run = { dueAt: "2026-10-08T09:00:00+08:00", trigger: "event" as const, events: [{ source: "folder", at: "a", summary: "第一个" }, { source: "folder", at: "b", summary: "第二个" }] };
    expect(lastTriggerEvent(run)?.summary).toBe("第二个");
    expect(lastTriggerEvent({ dueAt: "2026-10-08T09:00:00+08:00", trigger: "scheduled" })).toBeUndefined();
    expect(lastTriggerEvent(undefined)).toBeUndefined();
  });
});

describe("流程步骤里的占位", () => {
  const fields = eventSourceOf("folder")!.fields;
  const data = { path: "D:\\收件箱\\季度 报告.pdf", name: "季度 报告.pdf", size: 1024 };
  const valueOf = eventValueOf(data, fields);

  it("认出写了哪些占位（字符串、数组、对象里一层层找，去掉重复）", () => {
    expect(eventPlaceholdersIn({ path: "{{事件.文件路径}}", list: ["{{ 事件.文件名 }}", "x"], deep: { a: "前缀-{{事件.文件路径}}" } })).toEqual(["文件路径", "文件名"]);
    expect(eventPlaceholdersIn("没有占位 {{别的.x}}")).toEqual([]);
  });

  it("代入：整个字符串就是一个占位的换成值本身，嵌在字符串里的换成文字；中文名、键都认；这次事件没有的字段原样留着", () => {
    expect(substituteEventValues({ path: "{{事件.文件路径}}", size: "{{事件.大小}}", note: "收到 {{事件.name}}（{{事件.大小}} 字节）", miss: "{{事件.修改时间}}" }, valueOf)).toEqual({
      path: "D:\\收件箱\\季度 报告.pdf",
      size: 1024,
      note: "收到 季度 报告.pdf（1024 字节）",
      miss: "{{事件.修改时间}}",
    });
  });

  it("只换一遍：代入的值里写着 {{事件.…}} 也原样留着，不会再被代入", () => {
    const tricky = eventValueOf({ name: "{{事件.文件路径}}.pdf", path: "D:\\x\\{{事件.name}}" }, fields);
    expect(substituteEventValues("读 {{事件.文件名}}", tricky)).toBe("读 {{事件.文件路径}}.pdf");
    expect(substituteEventValues({ path: "{{事件.文件路径}}", note: "{{事件.文件名}}和{{事件.文件路径}}" }, tricky)).toEqual({ path: "D:\\x\\{{事件.name}}", note: "{{事件.文件路径}}.pdf和D:\\x\\{{事件.name}}" });
  });

  it("交给 agent 的结构化事件：来源、事件、时间，加上字段（键是中文名）", () => {
    expect(eventRecord({ source: "folder", event: "added", at: "2026-10-08T09:00:00+08:00", data })).toEqual({
      来源: "本机文件夹变化",
      事件: "新增文件",
      时间: "2026-10-08T09:00:00+08:00",
      文件路径: "D:\\收件箱\\季度 报告.pdf",
      文件名: "季度 报告.pdf",
      大小: 1024,
    });
  });
});
