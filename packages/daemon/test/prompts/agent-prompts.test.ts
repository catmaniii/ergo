// 每个 agent 单独的提示词（114 号票，src/prompts/library.ts）：存在数据目录配置区的 agent-prompts/，按 agent 分（<agent id>.append.md、
// <agent id>.replace.md），不进仓库。追加的接在通用模板后面（通用模板改了跟着变），整份自己写的替换通用模板（通用模板改了不影响它）；
// 两种都按这个角色的通用模板查占位符，写错的存不进去；文件被改坏、装配时缺值的退回通用模板，agent 照常拉起。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RequestRejected } from "../../src/errors.ts";
import { createPromptLibrary, DEFAULT_PROMPTS_DIR } from "../../src/prompts/index.ts";
import { secretarySystemPrompt } from "../../src/secretary/system-prompt.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

function library() {
  const root = makeTempDir("ergou-agent-prompts-");
  const userDir = path.join(root, "config", "prompts");
  const agentsDir = path.join(root, "config", "agent-prompts");
  const logs: string[] = [];
  const prompts = createPromptLibrary({ userDir, agentsDir, log: (line) => logs.push(line) });
  const changes: string[] = [];
  prompts.onAgentChange((agentId) => changes.push(agentId));
  return { prompts, userDir, agentsDir, logs, changes };
}

const rejection = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RequestRejected);
    return (err as Error).message;
  }
  throw new Error("没有被拒");
};

const DEFAULT_SECRETARY = (name: string) => secretarySystemPrompt(createPromptLibrary(), name);

describe("单独的提示词：存在数据目录配置区，按 agent 分", () => {
  it("追加：接在通用模板后面（空一行），能用通用模板的占位符；只有这个 agent 有，别的照旧", () => {
    const { prompts, agentsDir, changes } = library();
    prompts.saveAgentPrompt("secretary", "secretary", "append", "回答尽量短。叫我老板，你是{{名字}}。\r\n");
    expect(fs.readFileSync(path.join(agentsDir, "secretary.append.md"), "utf8")).toBe("回答尽量短。叫我老板，你是{{名字}}。\n");
    expect(prompts.agentPrompt("secretary", "secretary")).toEqual({ mode: "append", content: "回答尽量短。叫我老板，你是{{名字}}。" });
    expect(secretarySystemPrompt(prompts, "阿福", "off", "secretary")).toBe(`${DEFAULT_SECRETARY("阿福")}\n\n回答尽量短。叫我老板，你是阿福。`);
    // 不带 agent（或别的 agent）的照旧是通用模板
    expect(secretarySystemPrompt(prompts, "阿福")).toBe(DEFAULT_SECRETARY("阿福"));
    expect(changes).toEqual(["secretary"]);
  });

  it("追加的跟着通用模板变：设置 · 系统提示里改了通用模板，追加的照旧接在后面", () => {
    const { prompts } = library();
    prompts.saveAgentPrompt("secretary", "secretary", "append", "多用表格。");
    prompts.save("secretary", "你是{{名字}}，新的通用模板。");
    expect(secretarySystemPrompt(prompts, "阿福", "off", "secretary")).toBe("你是阿福，新的通用模板。\n\n多用表格。");
  });

  it("整份自己写：替换通用模板，占位符照填；通用模板之后再改不影响它；恢复用通用模板就回去", () => {
    const { prompts, agentsDir, changes } = library();
    prompts.saveAgentPrompt("secretary", "secretary", "append", "先追加一段");
    prompts.saveAgentPrompt("secretary", "secretary", "replace", "你是{{名字}}。\n{{#对话审批开着}}\n先问。\n{{/对话审批开着}}\n只说中文。");
    // 换了写法：追加的那份删掉，只留整份的
    expect(fs.readdirSync(agentsDir)).toEqual(["secretary.replace.md"]);
    expect(secretarySystemPrompt(prompts, "阿福", "on", "secretary")).toBe("你是阿福。\n先问。\n只说中文。");
    prompts.save("secretary", "你是{{名字}}，改过的通用模板。");
    expect(secretarySystemPrompt(prompts, "阿福", "off", "secretary")).toBe("你是阿福。\n只说中文。");
    prompts.resetAgentPrompt("secretary");
    expect(fs.readdirSync(agentsDir)).toEqual([]);
    expect(prompts.agentPrompt("secretary", "secretary")).toBeUndefined();
    expect(secretarySystemPrompt(prompts, "阿福", "off", "secretary")).toBe("你是阿福，改过的通用模板。");
    expect(changes).toEqual(["secretary", "secretary", "secretary"]);
  });

  it("占位符照通用模板查，和设置页一样写错的存不进去（说清第几行），整份的不能是空的；追加的存空的等于恢复用通用模板", () => {
    const { prompts, agentsDir, changes } = library();
    expect(rejection(() => prompts.saveAgentPrompt("secretary", "secretary", "append", "第一行\n叫我{{老板}}"))).toContain("第 2 行：不认得的占位符 {{老板}}");
    // 项目维护者才有的值，秘书的通用模板里没有
    expect(rejection(() => prompts.saveAgentPrompt("secretary", "secretary", "replace", "{{项目名}}"))).toContain("不认得的占位符 {{项目名}}");
    // 只在立项书确认之后才有的值写在条件外面（和设置页同一个检查）
    expect(rejection(() => prompts.saveAgentPrompt("pm-1", "project-maintainer", "replace", "类型：{{项目类型}}"))).toContain("{{项目类型}} 在条件“立项书已确认”不成立时没有值");
    expect(rejection(() => prompts.saveAgentPrompt("secretary", "secretary", "replace", "  \n"))).toContain("不能是空的");
    expect(fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : []).toEqual([]);
    prompts.saveAgentPrompt("secretary", "secretary", "append", "多用表格。");
    prompts.saveAgentPrompt("secretary", "secretary", "append", "\n");
    expect(fs.readdirSync(agentsDir)).toEqual([]);
    expect(changes).toEqual(["secretary", "secretary"]);
    // 同样的再存一遍没有变化，不通知
    prompts.saveAgentPrompt("secretary", "secretary", "append", "多用表格。");
    prompts.saveAgentPrompt("secretary", "secretary", "append", "多用表格。\n");
    expect(changes).toEqual(["secretary", "secretary", "secretary"]);
    // agent id 不能带目录
    expect(rejection(() => prompts.saveAgentPrompt("../secretary", "secretary", "append", "x"))).toContain("没有这个 agent");
  });

  it("文件被直接改坏了：这次装配用通用模板、记一行日志（同样的内容只记一次），面板上写明错在哪", () => {
    const { prompts, agentsDir, logs } = library();
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "secretary.replace.md"), "你是{{名字}}\n{{#没有这个条件}}\nx\n{{/没有这个条件}}");
    expect(secretarySystemPrompt(prompts, "阿福", "off", "secretary")).toBe(DEFAULT_SECRETARY("阿福"));
    expect(secretarySystemPrompt(prompts, "阿福", "off", "secretary")).toBe(DEFAULT_SECRETARY("阿福"));
    expect(logs.filter((l) => l.includes("secretary.replace.md"))).toHaveLength(1);
    expect(prompts.agentPrompt("secretary", "secretary")).toMatchObject({ mode: "replace", problem: expect.stringContaining("第 2 行：不认得的条件“没有这个条件”") });
  });

  it("按这个 agent 现在的通用模板查（任务转为项目后模板换了）：对不上的退回通用模板、标有错；对得上的照填", () => {
    const { prompts, agentsDir } = library();
    fs.mkdirSync(agentsDir, { recursive: true });
    const values = { 拉回次数: "3", 停滞分钟: "30", 催促次数: "2", 验收退回次数: "2", 验收退回次数加一: "3", 预算控制: false, 停下的用量: "x", 说明进展的用量: "y", 累计拒绝次数: "3" };
    // 维护者的模板里都有阈值：照填
    fs.writeFileSync(path.join(agentsDir, "tm-1.append.md"), "停滞 {{停滞分钟}} 分钟就说一声");
    expect(prompts.agentPrompt("tm-1", "task-maintainer")).toEqual({ mode: "append", content: "停滞 {{停滞分钟}} 分钟就说一声" });
    expect(prompts.render("task-maintainer", values, "tm-1")).toBe(`${prompts.render("task-maintainer", values)}\n\n停滞 30 分钟就说一声`);
    // 秘书的写法拿到维护者的模板上：不认得，用通用模板
    fs.writeFileSync(path.join(agentsDir, "tm-1.append.md"), "你叫{{名字}}");
    expect(prompts.agentPrompt("tm-1", "task-maintainer")).toMatchObject({ mode: "append", problem: expect.stringContaining("不认得的占位符 {{名字}}") });
    expect(prompts.render("task-maintainer", values, "tm-1")).toBe(prompts.render("task-maintainer", values));
  });

  it("修改时间和大小算进 revision（秘书据此在下一轮之前看出来）；没有 agentsDir 的那份改不了", () => {
    const { prompts } = library();
    const before = prompts.revision(["secretary"], "secretary");
    prompts.saveAgentPrompt("secretary", "secretary", "append", "多用表格。");
    expect(prompts.revision(["secretary"], "secretary")).not.toBe(before);
    expect(prompts.revision(["secretary"])).toBe(prompts.revision(["secretary"]));
    const bare = createPromptLibrary({ defaultsDir: DEFAULT_PROMPTS_DIR });
    expect(rejection(() => bare.saveAgentPrompt("secretary", "secretary", "append", "x"))).toContain("改不了");
  });
});
