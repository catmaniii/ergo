// 设置 · 系统提示（71 号票）的状态层：列表分节、每份的状态和副标题、正在改的内容对不对（和守护进程同一个检查）、能用的占位符怎么列。
import { describe, expect, it } from "vitest";
import {
  checkSystemPromptDraft,
  placeholderGroups,
  SYSTEM_PROMPT_STATE_LABEL,
  type SystemPromptDetail,
  type SystemPromptList,
  systemPromptSections,
  systemPromptSubtitle,
} from "../../src/state/index.ts";

const summary = (id: string, group: "prefix" | "role" | "fragment", extra: Partial<SystemPromptList["prompts"][number]> = {}) => ({
  id,
  title: id,
  description: `${id}的说明`,
  group,
  state: "default" as const,
  usedIn: [],
  ...extra,
});

const detail: SystemPromptDetail = {
  ...summary("secretary", "role", { title: "⟦个人助理⟧" }),
  content: "你是「{{名字}}」。\n{{#对话审批开着}}\n开着\n{{/对话审批开着}}",
  defaultContent: "你是默认的「{{名字}}」。",
  placeholders: [
    { name: "名字", kind: "value", description: "用户起的名字" },
    { name: "项目类型", kind: "value", description: "立项书确认的项目类型", onlyWhen: "对话审批开着" },
    { name: "对话审批开着", kind: "flag", description: "配置里开着时成立" },
    { name: "plan-writing", kind: "partial", description: "计划的写法" },
    { name: "web_search", kind: "value", description: "工具名", common: true },
  ],
  allowEmpty: false,
  userFile: "D:\\data\\config\\prompts\\secretary.md",
};

describe("列表", () => {
  it("分成前缀、各角色、共用片段三节，守护进程给的顺序不动；没有的节不列", () => {
    const list: SystemPromptList = { userDir: "D:\\data\\config\\prompts", prompts: [summary("secretary", "role"), summary("prefix", "prefix"), summary("reviewer", "role")] };
    expect(systemPromptSections(list).map((s) => [s.title, s.prompts.map((p) => p.id)])).toEqual([
      ["前缀", ["prefix"]],
      ["各角色", ["secretary", "reviewer"]],
    ]);
  });

  it("状态的说法；共用片段的副标题写明插在哪几份里", () => {
    expect(SYSTEM_PROMPT_STATE_LABEL).toEqual({ default: "默认", custom: "改过", broken: "有错，在用默认的" });
    expect(systemPromptSubtitle(summary("plan-writing", "fragment", { description: "计划怎么写", usedIn: ["长程任务的维护者", "项目的维护者"] }))).toBe("计划怎么写。插在：长程任务的维护者、项目的维护者");
    expect(systemPromptSubtitle(summary("reviewer", "role", { description: "评审" }))).toBe("评审");
  });
});

describe("正在改的内容", () => {
  it("没改：对、没有可存的；换行、末尾空行按守护进程存的样子比", () => {
    expect(checkSystemPromptDraft(detail, detail.content)).toEqual({ ok: true, problem: undefined, changed: false, isDefault: false });
    expect(checkSystemPromptDraft(detail, `${detail.content.replaceAll("\n", "\r\n")}\r\n\r\n`)).toMatchObject({ ok: true, changed: false });
  });

  it("改对了能存；和默认的一样时标出来（存了就是恢复默认）", () => {
    expect(checkSystemPromptDraft(detail, "你叫{{名字}}，查资料用 {{web_search}}。{{> plan-writing}}")).toEqual({ ok: true, problem: undefined, changed: true, isDefault: false });
    expect(checkSystemPromptDraft(detail, "你是默认的「{{名字}}」。\n")).toMatchObject({ ok: true, changed: true, isDefault: true });
  });

  it("占位符写错：和守护进程一样说清第几行错在哪；角色的提示不能是空的", () => {
    expect(checkSystemPromptDraft(detail, "第一行\n你叫{{名子}}")).toMatchObject({ ok: false, changed: true, problem: "第 2 行：不认得的占位符 {{名子}}（这里能填的值：名字、项目类型，另有每份都能用的工具名和标记）" });
    // 只在某个条件成立时才有值的：写在条件外面、写在 {{^条件}} 里面都拦下，说清在什么情况下会缺
    const outside = "第 1 行：{{项目类型}} 在条件“对话审批开着”不成立时没有值，要写在 {{#对话审批开着}}……{{/对话审批开着}} 里面";
    expect(checkSystemPromptDraft(detail, "类型：{{项目类型}}")).toMatchObject({ ok: false, problem: outside });
    expect(checkSystemPromptDraft(detail, "{{^对话审批开着}}类型：{{项目类型}}{{/对话审批开着}}")).toMatchObject({ ok: false, problem: outside });
    expect(checkSystemPromptDraft(detail, "{{#对话审批开着}}类型：{{项目类型}}{{/对话审批开着}}")).toMatchObject({ ok: true });
    expect(checkSystemPromptDraft(detail, "{{#对话审批开着}}没结束")).toMatchObject({ ok: false, problem: "第 1 行：第 1 行的 {{#对话审批开着}} 没有结束：后面要有 {{/对话审批开着}}" });
    expect(checkSystemPromptDraft(detail, " \n")).toMatchObject({ ok: false, problem: "不能是空的（要用默认的请点“恢复默认”）" });
    expect(checkSystemPromptDraft({ ...detail, allowEmpty: true }, "")).toMatchObject({ ok: true });
  });
});

describe("能用的占位符", () => {
  it("按种类列：填值、条件（连同不成立时的写法）、能插的片段、每份都能用的工具名和标记；没有的种类不列", () => {
    expect(placeholderGroups(detail)).toEqual([
      {
        title: "填值",
        items: [
          { code: "{{名字}}", description: "用户起的名字" },
          { code: "{{项目类型}}", description: "立项书确认的项目类型；只在“对话审批开着”成立时有值，要写在 {{#对话审批开着}}……{{/对话审批开着}} 里面" },
        ],
      },
      { title: "条件", items: [{ code: "{{#对话审批开着}}…{{/对话审批开着}}", description: "配置里开着时成立；{{^对话审批开着}}…{{/对话审批开着}} 是不成立时才有" }] },
      { title: "能插的片段", items: [{ code: "{{> plan-writing}}", description: "计划的写法" }] },
      { title: "工具名和标记（每份都能用）", items: [{ code: "{{web_search}}", description: "工具名" }] },
    ]);
    expect(placeholderGroups({ placeholders: [] })).toEqual([]);
  });
});
