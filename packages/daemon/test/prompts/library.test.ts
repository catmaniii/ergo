// 各 agent 的系统提示放进可编辑的 md 文件（71 号票，src/prompts/）：默认的在本包的 prompts/，用户改的在数据目录配置区的
// prompts/，有就用用户的；每次装配现读，改了下一次装配就生效；占位符写错的启动报错、设置页存不进去；能恢复默认；前缀加在最前面。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RequestRejected } from "../../src/errors.ts";
import { taskMaintainerSystemPrompt, thresholdValues } from "../../src/maintainers/system-prompt.ts";
import { projectMaintainerSystemPrompt } from "../../src/projects/system-prompt.ts";
import { checkPromptRegistry, createPromptLibrary, DEFAULT_PROMPTS_DIR, defaultPromptLibrary, PROMPT_IDS, PromptFilesBroken, PROMPTS } from "../../src/prompts/index.ts";
import { secretarySystemPrompt } from "../../src/secretary/system-prompt.ts";
import { DEFAULT_TASK_THRESHOLDS } from "../../src/tasks/thresholds.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** 一份有用户目录的提示库，连同它记的日志；defaults 给了就把默认的几份换掉（默认目录拷一份到临时目录再改） */
function library(defaults: Record<string, string> = {}) {
  const root = makeTempDir("ergou-prompts-");
  const userDir = path.join(root, "config", "prompts");
  const logs: string[] = [];
  let defaultsDir: string | undefined;
  if (Object.keys(defaults).length > 0) {
    defaultsDir = path.join(root, "defaults");
    fs.cpSync(DEFAULT_PROMPTS_DIR, defaultsDir, { recursive: true });
    for (const [id, content] of Object.entries(defaults)) fs.writeFileSync(path.join(defaultsDir, `${id}.md`), content);
  }
  const prompts = createPromptLibrary({ userDir, log: (line) => logs.push(line), ...(defaultsDir === undefined ? {} : { defaultsDir }) });
  const write = (id: string, content: string) => {
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, `${id}.md`), content);
  };
  return { prompts, userDir, logs, write };
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

const project = { id: "p-1", name: "记账本", goal: "记下每一笔开销", state: "building", charterConfirmed: true, kind: "dev", workdir: { external: false }, toolkit: { bash: true, network: false } } as never;

describe("清单和默认的提示", () => {
  it("清单自洽（片段能用的占位符每个插它的都有），每份默认的提示文件都在、占位符都写对了", () => {
    expect(() => checkPromptRegistry()).not.toThrow();
    expect(PROMPT_IDS.filter((id) => !fs.existsSync(path.join(DEFAULT_PROMPTS_DIR, `${id}.md`)))).toEqual([]);
    expect(() => createPromptLibrary().check()).not.toThrow();
  });

  it("代码里不再有整段的系统提示：各角色的提示都从 md 文件来（文件里有的，拼出来的才有）", () => {
    const secretary = fs.readFileSync(path.join(DEFAULT_PROMPTS_DIR, "secretary.md"), "utf8");
    expect(secretary.startsWith("你是「二狗」的秘书")).toBe(true);
    expect(secretarySystemPrompt(defaultPromptLibrary(), "小美")).toContain("用户叫你「小美」");
    const src = path.join(import.meta.dirname, "../../src");
    const inCode = fs
      .readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && /["`]你是「?二狗/.test(fs.readFileSync(path.join(src, file), "utf8")));
    expect(inCode).toEqual([]);
  });
});

describe("用户改的放在数据目录，有就用用户的", () => {
  it("改了数据目录里的 md，下一次装配就读到新的（不用重启）；删掉又回到默认的", () => {
    const { prompts, userDir, write } = library();
    const before = secretarySystemPrompt(prompts, "小美");
    write("secretary", "你是我的私人秘书「{{名字}}」。\n{{#对话审批开着}}\n审批开着。\n{{/对话审批开着}}\n草稿区是你的。");
    expect(secretarySystemPrompt(prompts, "小美")).toBe("你是我的私人秘书「小美」。\n草稿区是你的。");
    expect(secretarySystemPrompt(prompts, "小美", "on")).toBe("你是我的私人秘书「小美」。\n审批开着。\n草稿区是你的。");
    fs.rmSync(path.join(userDir, "secretary.md"));
    expect(secretarySystemPrompt(prompts, "小美")).toBe(before);
  });

  it("改了共用的片段，插它的几份都跟着变（长程任务的维护者、项目的维护者）", () => {
    const { prompts, write } = library();
    write("plan-writing", "计划写短一点，用 {{submit_plan}} 交。");
    expect(taskMaintainerSystemPrompt(prompts, DEFAULT_TASK_THRESHOLDS)).toContain("\n计划写短一点，用 submit_plan 交。\n执行：");
    expect(projectMaintainerSystemPrompt(prompts, project, { root: "D:\\p" } as never, "D:\\w", DEFAULT_TASK_THRESHOLDS)).toContain("\n计划写短一点，用 submit_plan 交。\n执行：");
    expect(prompts.list().prompts.find((p) => p.id === "plan-writing")).toMatchObject({ group: "fragment", state: "custom", usedIn: ["长程任务的维护者", "项目的维护者"] });
  });

  it("前缀加在每个 agent 的系统提示最前面（空行隔开），默认是空的、原样返回", () => {
    const { prompts, write } = library();
    expect(prompts.withPrefix("你是维护者。")).toBe("你是维护者。");
    write("prefix", "\uFEFF我住在新加坡，回答用简体中文。\r\n\r\n");
    expect(prompts.withPrefix("你是维护者。")).toBe("我住在新加坡，回答用简体中文。\n\n你是维护者。");
  });

  it("运行中直接把文件改坏了：这次装配用默认的，记一行日志（同样的内容只记一次），列表上标有错", () => {
    const { prompts, logs, write } = library();
    write("sub-agent", "你是子 agent，用 {{git_comit}} 提交。");
    expect(prompts.render("sub-agent", {})).toBe(defaultPromptLibrary().render("sub-agent", {}));
    prompts.render("sub-agent", {});
    expect(logs.filter((l) => l.includes("sub-agent.md 有错"))).toHaveLength(1);
    expect(logs[0]).toContain("第 1 行：不认得的占位符 {{git_comit}}");
    const summary = prompts.list().prompts.find((p) => p.id === "sub-agent");
    expect(summary).toMatchObject({ state: "broken" });
    expect(summary?.problem).toContain("{{git_comit}}");
    expect(prompts.detail("sub-agent")).toMatchObject({ state: "broken", brokenContent: "你是子 agent，用 {{git_comit}} 提交。" });
  });
});

describe("装配时万一还是缺值（检查拦不住的）：出错的那一份退回默认的，agent 照常拉起", () => {
  it("角色本身：用默认的，列表和设置页上标有错、说清第几行哪个占位符，日志记一行；改了文件重新算", () => {
    // 默认的评审提示不用“只读工具”，用户改的用了；这次装配没给它的值
    const { prompts, logs, write } = library({ reviewer: "默认的评审：判完用 {{submit_review}} 交。" });
    write("reviewer", "改过的评审。\n只能读（{{只读工具}}），判完用 {{submit_review}} 交。");
    const values = { 只读工具: undefined } as never;
    expect(prompts.render("reviewer", values)).toBe("默认的评审：判完用 submit_review 交。");
    expect(prompts.render("reviewer", values)).toBe("默认的评审：判完用 submit_review 交。");
    expect(logs.filter((l) => l.includes("reviewer.md 有错"))).toHaveLength(1);
    expect(logs[0]).toContain("第 2 行：装配“评审”时 {{只读工具}} 没有值");
    const summary = prompts.list().prompts.find((p) => p.id === "reviewer");
    expect(summary).toMatchObject({ state: "broken" });
    expect(summary?.problem).toContain("第 2 行：装配“评审”时 {{只读工具}} 没有值");
    expect(prompts.detail("reviewer")).toMatchObject({ state: "broken", brokenContent: "改过的评审。\n只能读（{{只读工具}}），判完用 {{submit_review}} 交。" });
    // 改了文件：按新的内容重新算
    write("reviewer", "又改过的评审，判完用 {{submit_review}} 交。");
    expect(prompts.render("reviewer", values)).toBe("又改过的评审，判完用 submit_review 交。");
    expect(prompts.detail("reviewer")).toMatchObject({ state: "custom" });
  });

  it("插进来的片段缺值：只有那个片段退回默认的，插它的照样用改过的", () => {
    const { prompts, write } = library({ thresholds: "默认的阈值：停滞 {{停滞分钟}} 分钟。" });
    write("thresholds", "改过的阈值：拉回 {{拉回次数}} 次。");
    write("execution", "改过的执行。\n{{> thresholds}}");
    const values = { ...thresholdValues(DEFAULT_TASK_THRESHOLDS), 拉回次数: undefined } as never;
    expect(prompts.render("execution", values)).toBe(`改过的执行。\n默认的阈值：停滞 ${DEFAULT_TASK_THRESHOLDS.stallMs / 60_000} 分钟。`);
    const states = Object.fromEntries(prompts.list().prompts.map((p) => [p.id, p.state]));
    expect(states).toMatchObject({ execution: "custom", thresholds: "broken" });
    expect(prompts.detail("thresholds").problem).toContain("第 1 行：装配“执行的推进”时 {{拉回次数}} 没有值");
  });

  it("默认的也缺（程序没给值）是编程错误：照样抛", () => {
    const { prompts } = library();
    expect(() => prompts.render("reviewer", { 只读工具: undefined } as never)).toThrow("“reviewer”第 2 行的 {{只读工具}} 没有值");
  });
});

describe("启动时查一遍", () => {
  it("用户改的有错：报清楚是哪个文件哪一行，不启动", () => {
    const { prompts, userDir, write } = library();
    write("reviewer", "你是评审。\n只能读（{{只读工具}}），判完用 {{submit_reveiw}} 交。");
    let error: unknown;
    try {
      prompts.check();
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PromptFilesBroken);
    expect((error as Error).message).toContain(path.join(userDir, "reviewer.md"));
    expect((error as Error).message).toContain("第 2 行：不认得的占位符 {{submit_reveiw}}");
  });

  it("只在某个条件成立时才有值的写在条件外面：启动报错、设置页存不进去，说清第几行、哪个占位符、在什么情况下会缺", () => {
    const { prompts, userDir, write } = library();
    const moved = "你是项目「{{项目名}}」的维护者。\n{{项目类型}}项目。\n{{#立项书已确认}}立项书已确认。{{/立项书已确认}}";
    const why = "第 2 行：{{项目类型}} 在条件“立项书已确认”不成立时没有值，要写在 {{#立项书已确认}}……{{/立项书已确认}} 里面";
    expect(rejection(() => prompts.save("project-maintainer", moved))).toContain(why);
    expect(rejection(() => prompts.save("project-maintainer", moved.replace("{{#立项书已确认}}立项书已确认。{{/立项书已确认}}", "{{^立项书已确认}}{{项目类型}}{{/立项书已确认}}")))).toContain(why);
    write("project-maintainer", moved);
    expect(() => prompts.check()).toThrow(`${path.join(userDir, "project-maintainer.md")} 有错（改好，或者删掉它恢复默认）：\n${why}`);
    // 运行中直接改成这样的：筹备中的项目照样拉得起维护者（用默认的）
    const preparing = { ...(project as object), state: "preparing", charterConfirmed: false, kind: undefined };
    expect(projectMaintainerSystemPrompt(prompts, preparing as never, { root: "D:/data/projects/p-1" } as never, "D:/data/projects/p-1/workdir", DEFAULT_TASK_THRESHOLDS)).toBe(
      projectMaintainerSystemPrompt(defaultPromptLibrary(), preparing as never, { root: "D:/data/projects/p-1" } as never, "D:/data/projects/p-1/workdir", DEFAULT_TASK_THRESHOLDS),
    );
  });

  it("预算控制关着（93 号票默认）：用户改的阈值那一段把预算的两个占位符写在条件外面，照常启动，照配置的倍数填", () => {
    const { prompts, write } = library();
    write("thresholds", "超了 {{停下的用量}} 停下，{{说明进展的用量}} 说明进展；拉回 {{拉回次数}} 次。{{验收退回次数}}{{验收退回次数加一}}{{停滞分钟}}{{催促次数}}{{累计拒绝次数}}");
    expect(() => prompts.check()).not.toThrow();
    const off = { ...DEFAULT_TASK_THRESHOLDS, budgetControl: false };
    expect(prompts.render("thresholds", thresholdValues(off))).toMatch(/^超了 用量超过预算的 2 倍 停下，用量超过预算 说明进展；拉回 3 次。/);
    expect(taskMaintainerSystemPrompt(prompts, off)).toContain("超了 用量超过预算的 2 倍 停下");
  });

  it("不认得的文件（名字写错了）用不上：只提醒，照常启动", () => {
    const { prompts, logs, write } = library();
    write("secretry", "随便写");
    expect(() => prompts.check()).not.toThrow();
    expect(logs.some((l) => l.includes("secretry.md") && l.includes("用不上"))).toBe(true);
  });
});

describe("设置页：看、保存、恢复默认", () => {
  it("列表：前缀、各角色、共用片段，各自用的是默认的还是改过的", () => {
    const { prompts, userDir, write } = library();
    write("job-maintainer", "你是定时作业的维护者，失败 {{连续失败几次暂停}} 次暂停。");
    const list = prompts.list();
    expect(list.userDir).toBe(userDir);
    expect(list.prompts.map((p) => p.id)).toEqual(PROMPT_IDS);
    expect(list.prompts[0]).toMatchObject({ id: "prefix", group: "prefix", state: "default" });
    expect(list.prompts.find((p) => p.id === "job-maintainer")).toMatchObject({ group: "role", state: "custom" });
    expect(list.prompts.find((p) => p.id === "secretary")).toMatchObject({ title: "⟦个人助理⟧", state: "default" });
  });

  it("一份：现在用的、默认的内容，能用的占位符（自己的、条件、片段、公用的工具名）", () => {
    const { prompts } = library();
    const detail = prompts.detail("project-maintainer");
    expect(detail.content).toBe(detail.defaultContent);
    expect(detail.content.startsWith("你是「二狗」里项目「{{项目名}}」")).toBe(true);
    expect(detail.allowEmpty).toBe(false);
    const byName = Object.fromEntries(detail.placeholders.map((p) => [p.name, p]));
    expect(byName["项目名"]).toMatchObject({ kind: "value" });
    expect(byName["项目类型"]).toMatchObject({ kind: "value", onlyWhen: "立项书已确认" });
    expect(byName["立项书已确认"]).toMatchObject({ kind: "flag" });
    expect(byName["plan-writing"]).toMatchObject({ kind: "partial", description: "计划的写法" });
    expect(byName["submit_plan"]).toMatchObject({ kind: "value", common: true });
    expect(prompts.detail("prefix").placeholders).toEqual([]);
    expect(() => prompts.detail("nope")).toThrow(RequestRejected);
  });

  it("保存：存进数据目录、下一次装配用它，通知改了哪份；同样的再存没有变化", () => {
    const { prompts, userDir } = library();
    const changed: string[] = [];
    prompts.onChange((id) => changed.push(id));
    const saved = prompts.save("reviewer", "你是严格的评审。只能读（{{只读工具}}），判完用 {{submit_review}} 交。\r\n");
    expect(saved).toMatchObject({ state: "custom", content: "你是严格的评审。只能读（{{只读工具}}），判完用 {{submit_review}} 交。" });
    expect(fs.readFileSync(path.join(userDir, "reviewer.md"), "utf8")).toBe("你是严格的评审。只能读（{{只读工具}}），判完用 {{submit_review}} 交。\n");
    expect(prompts.render("reviewer", { 只读工具: "read、ls" })).toBe("你是严格的评审。只能读（read、ls），判完用 submit_review 交。");
    prompts.save("reviewer", "你是严格的评审。只能读（{{只读工具}}），判完用 {{submit_review}} 交。");
    expect(changed).toEqual(["reviewer"]);
  });

  it("占位符写错的存不进去：说清第几行错在哪，文件不动", () => {
    const { prompts, userDir } = library();
    const message = rejection(() => prompts.save("secretary", "你是秘书。\n用户叫你「{{名子}}」。"));
    expect(message).toContain("第 2 行：不认得的占位符 {{名子}}（这里能填的值：名字");
    expect(rejection(() => prompts.save("project-maintainer", "{{#外部工作目录}}外部的"))).toContain("第 1 行的 {{#外部工作目录}} 没有结束");
    expect(rejection(() => prompts.save("prefix", "我叫{{名字}}"))).toContain("不认得的占位符 {{名字}}（这里能填的值：没有）");
    expect(rejection(() => prompts.save("execution", "{{> plan-writing}}"))).toContain("不认得的片段 {{> plan-writing}}（这里能插的片段：thresholds）");
    expect(rejection(() => prompts.save("secretary", "  \n"))).toContain("不能是空的");
    expect(fs.existsSync(userDir)).toBe(false);
    // 前缀、片段可以是空的
    expect(prompts.save("plan-writing", "")).toMatchObject({ state: "custom", content: "" });
  });

  it("恢复默认：删掉用户的那份；存的和默认的一样也等于恢复默认", () => {
    const { prompts, userDir } = library();
    const changed: string[] = [];
    prompts.onChange((id) => changed.push(id));
    prompts.save("sub-agent", "只做交给你的事。");
    expect(prompts.reset("sub-agent")).toMatchObject({ state: "default" });
    expect(fs.existsSync(path.join(userDir, "sub-agent.md"))).toBe(false);
    expect(prompts.reset("sub-agent")).toMatchObject({ state: "default" });
    prompts.save("sub-agent", "只做交给你的事。");
    const original = prompts.detail("sub-agent").defaultContent;
    expect(prompts.save("sub-agent", `${original}\r\n`)).toMatchObject({ state: "default" });
    expect(fs.existsSync(path.join(userDir, "sub-agent.md"))).toBe(false);
    expect(changed).toEqual(["sub-agent", "sub-agent", "sub-agent", "sub-agent"]);
  });

  it("没有数据目录的那份（测试、纯函数用）改不了", () => {
    expect(rejection(() => defaultPromptLibrary().save("secretary", "x"))).toContain("改不了");
    expect(Object.keys(PROMPTS)).toEqual(PROMPT_IDS);
  });
});
