// 事件触发的流程（77 号票）：步骤参数里的占位——交计划时的检查、规划时当作"未知"再换回、每次运行一批里每个事件各走一遍并代入值；
// 通用 bash 的命令里值不拼进命令，换成引用环境变量（按占位所在的引号换写法）：用真的 bash 跑一遍看值原样到了、命令的意思没变，
// 守卫拆命令时按同一份值展开、看到的路径和真的一样。
import { spawnSync } from "node:child_process";
import { eventSourceOf, type TriggerEvent, type WorkflowPlanDraft, type WorkflowStepView } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { TOOL } from "../../src/guard/index.ts";
import { splitShellCommand } from "../../src/guard/shell/split.ts";
import { draftEventProblems, eventShellEnv, eventShellVar, maskEventPlaceholders, runWorkflowSteps, shellCommandWithVars, unmaskEventPlaceholders } from "../../src/tasks/workflow-events.ts";
import { findGitBash } from "../../src/typed-shell/git-bash.ts";

const folderFields = eventSourceOf("folder")!.fields;

const draft: WorkflowPlanDraft = {
  goal: "归档新来的 PDF",
  steps: [
    { id: "s1", title: "读 {{事件.文件名}}", tool: "read", args: { path: "{{事件.文件路径}}" } },
    { id: "s2", title: "归档", tool: "bash", args: { command: "cp {{事件.文件路径}} 归档/" }, after: ["s1"] },
    { id: "s3", title: "看看", tool: "ls", args: { path: "." }, after: ["s2"] },
  ],
  rules: [],
};

describe("交计划时的检查", () => {
  it("只有事件触发的流程能写占位；名字要是它等的事件带的字段（中文名或键）", () => {
    expect(draftEventProblems(draft, folderFields)).toEqual([]);
    expect(draftEventProblems(draft, undefined)).toEqual([
      "步骤 s1 写了事件的值（{{事件.文件名}}、{{事件.文件路径}}），但这个流程不是事件触发的：没有事件可以代入",
      "步骤 s2 写了事件的值（{{事件.文件路径}}），但这个流程不是事件触发的：没有事件可以代入",
    ]);
    const wrong = { ...draft, steps: [{ id: "s1", title: "读", tool: "read", args: { path: "{{事件.收件人}}" } }] };
    expect(draftEventProblems(wrong, folderFields)[0]).toContain("步骤 s1 的 {{事件.收件人}} 不是这个流程等的事件带的字段（能用：文件路径、文件名");
  });
});

describe("规划时当作未知", () => {
  it("非 bash 的参数里带占位的换成未知（数组逐个换），bash 的命令照原文；审查完换回原来写的", () => {
    const masked = maskEventPlaceholders([...draft.steps, { id: "s4", title: "删", tool: "rm", args: { paths: ["{{事件.文件路径}}", "固定.txt"] } }]);
    expect(masked.map((s) => s.args)).toEqual([
      { path: { $unknown: "{{事件.文件路径}}" } },
      { command: "cp {{事件.文件路径}} 归档/" },
      { path: "." },
      { paths: [{ $unknown: "{{事件.文件路径}}" }, "固定.txt"] },
    ]);
    expect(masked.map((s) => unmaskEventPlaceholders(s.args))).toEqual([...draft.steps.map((s) => s.args), { paths: ["{{事件.文件路径}}", "固定.txt"] }]);
    // 本来就是未知的（审查标的）不动
    expect(unmaskEventPlaceholders({ x: { $unknown: "不知道" } })).toEqual({ x: { $unknown: "不知道" } });
  });
});

const view = (s: WorkflowPlanDraft["steps"][number]): WorkflowStepView => ({ id: s.id, title: s.title, tool: s.tool, args: s.args ?? {}, after: s.after ?? [], marks: [], conditions: [] });
const event = (name: string, path = `D:\\收件箱\\${name}`): TriggerEvent => ({ source: "folder", event: "added", at: "2026-10-08T09:00:00+08:00", summary: `新增文件 ${name}`, data: { path, name } });

describe("每次运行代入", () => {
  const steps = draft.steps.map(view);

  it("一个事件：照原来的编号，文件工具的参数和标题代入值；bash 的命令里引用这个事件的环境变量，值放进环境", () => {
    expect(runWorkflowSteps(steps, [event("季度 报告.pdf")]).map((s) => [s.id, s.title, s.args, s.after])).toEqual([
      ["s1", "读 季度 报告.pdf", { path: "D:\\收件箱\\季度 报告.pdf" }, []],
      ["s2", "归档", { command: 'cp "${ERGO_EVENT_1_PATH}" 归档/' }, ["s1"]],
      ["s3", "看看", { path: "." }, ["s2"]],
    ]);
    // 来源登记的每个字段一个变量；这次事件里没有的是空的
    expect(eventShellEnv([event("季度 报告.pdf")])).toMatchObject({ ERGO_EVENT_1_PATH: "D:\\收件箱\\季度 报告.pdf", ERGO_EVENT_1_NAME: "季度 报告.pdf", ERGO_EVENT_1_RELATIVE_PATH: "", ERGO_EVENT_1_SIZE: "" });
    expect(eventShellVar(2, "modifiedAt")).toBe("ERGO_EVENT_2_MODIFIED_AT");
  });

  it("一批两个事件：每个事件各走一遍，编号加 .e<第几个>，前置步骤换成同一遍里的；bash 的命令引用各自那个事件的变量", () => {
    expect(runWorkflowSteps(steps, [event("a.pdf"), event("b.pdf")]).map((s) => [s.id, s.title, s.args.path ?? s.args.command, s.after])).toEqual([
      ["s1.e1", "读 a.pdf（第 1 个事件）", "D:\\收件箱\\a.pdf", []],
      ["s2.e1", "归档（第 1 个事件）", 'cp "${ERGO_EVENT_1_PATH}" 归档/', ["s1.e1"]],
      ["s3.e1", "看看（第 1 个事件）", ".", ["s2.e1"]],
      ["s1.e2", "读 b.pdf（第 2 个事件）", "D:\\收件箱\\b.pdf", []],
      ["s2.e2", "归档（第 2 个事件）", 'cp "${ERGO_EVENT_2_PATH}" 归档/', ["s1.e2"]],
      ["s3.e2", "看看（第 2 个事件）", ".", ["s2.e2"]],
    ]);
    expect(eventShellEnv([event("a.pdf"), event("b.pdf")])).toMatchObject({ ERGO_EVENT_1_PATH: "D:\\收件箱\\a.pdf", ERGO_EVENT_2_PATH: "D:\\收件箱\\b.pdf" });
  });

  it("代入了值的步骤不沿用规划时的真实路径（执行时另取），没有占位的沿用", () => {
    const withReal = steps.map((s) => ({ ...s, realPaths: { "C:\\x": "C:\\x" } }));
    expect(runWorkflowSteps(withReal, [event("a.pdf")]).map((s) => s.realPaths)).toEqual([undefined, undefined, { "C:\\x": "C:\\x" }]);
  });

  it("只换一遍：代入的值里写着 {{事件.…}} 不会再被代入（文件工具的参数、标题、环境变量都原样）", () => {
    const tricky = event("{{事件.文件路径}}.pdf", "D:\\x\\{{事件.name}}");
    const [bound] = runWorkflowSteps([view({ id: "s1", title: "读 {{事件.文件名}}", tool: "read", args: { path: "{{事件.文件路径}}" } })], [tricky]);
    expect(bound).toMatchObject({ title: "读 {{事件.文件路径}}.pdf", args: { path: "D:\\x\\{{事件.name}}" } });
    expect(eventShellEnv([tricky])).toMatchObject({ ERGO_EVENT_1_NAME: "{{事件.文件路径}}.pdf", ERGO_EVENT_1_PATH: "D:\\x\\{{事件.name}}" });
  });
});

/** 各种写法的文件名：引号、$、命令替换、反引号、换行、{{占位}}、前后空格、反斜杠 */
const HOSTILE = ["a$(calc).pdf", `it's "q".pdf`, "`whoami`.pdf", "两行\n第二行.pdf", "{{事件.文件路径}}.pdf", "  前后空格  ", "x\\$HOME\\y.pdf", "$'x'.pdf"];

describe("通用 bash 的命令：值不拼进命令", () => {
  it("按占位所在的那一层引号换写法：不在引号里、双引号里、单引号里、$'…' 里、命令替换和反引号里；认不出的字段原样留着", () => {
    expect(shellCommandWithVars("cp {{事件.文件路径}} x", 1, folderFields)).toBe('cp "${ERGO_EVENT_1_PATH}" x');
    expect(shellCommandWithVars('cp "{{事件.文件路径}}" "D:/out/{{事件.文件名}}.bak"', 1, folderFields)).toBe('cp "${ERGO_EVENT_1_PATH}" "D:/out/${ERGO_EVENT_1_NAME}.bak"');
    expect(shellCommandWithVars("echo 'a{{事件.文件名}}b'", 2, folderFields)).toBe(`echo 'a'"\${ERGO_EVENT_2_NAME}"'b'`);
    expect(shellCommandWithVars("echo $'a{{事件.文件名}}b'", 1, folderFields)).toBe(`echo $'a'"\${ERGO_EVENT_1_NAME}"$'b'`);
    expect(shellCommandWithVars('echo "$(basename {{事件.文件路径}})"', 1, folderFields)).toBe('echo "$(basename "${ERGO_EVENT_1_PATH}")"');
    expect(shellCommandWithVars("echo `basename {{事件.文件路径}}`", 1, folderFields)).toBe('echo `basename "${ERGO_EVENT_1_PATH}"`');
    expect(shellCommandWithVars('echo \\"{{事件.文件名}}', 1, folderFields)).toBe('echo \\""${ERGO_EVENT_1_NAME}"');
    expect(shellCommandWithVars("echo {{事件.收件人}}", 1, folderFields)).toBe("echo {{事件.收件人}}");
  });

  const bash = findGitBash(process.env);
  it.skipIf(!bash)("真的 bash 跑一遍：不管文件名里有什么，每种引号里都原样拿到这个值，命令的意思不变（不执行文件名里的命令）", () => {
    const template = `printf '<%s>' {{事件.文件名}} "x{{事件.文件名}}y" 'a{{事件.文件名}}b' $'c{{事件.文件名}}d' "$(printf '%s' {{事件.文件名}})" "D:/out/{{事件.文件名}}.bak"`;
    const command = shellCommandWithVars(template, 1, folderFields);
    for (const name of HOSTILE) {
      const env = { ...process.env, ...eventShellEnv([event(name)]) };
      const out = spawnSync(bash!, ["-c", command], { env, encoding: "utf8", windowsHide: true });
      expect({ status: out.status, stderr: out.stderr }).toEqual({ status: 0, stderr: "" });
      // 命令替换会去掉结尾的换行，别的都原样
      expect(out.stdout).toBe(`<${name}><x${name}y><a${name}b><c${name}d><${name.replace(/\n+$/, "")}><D:/out/${name}.bak>`);
    }
  });

  it("守卫拆命令时按同一份环境变量的值展开：看到的就是这次事件的文件，命令结构没变（不会多出命令、不会变成看不懂的）", () => {
    const command = shellCommandWithVars('cp "{{事件.文件路径}}" "D:/out/{{事件.文件名}}.bak"', 1, folderFields);
    for (const name of HOSTILE.filter((n) => !/[\n\\]|^\s|\s$/.test(n))) {
      const file = `D:\\收件箱\\${name}`;
      const calls = splitShellCommand(command, { cwd: "D:\\work", homeDir: "C:\\Users\\me", vars: eventShellEnv([event(name, file)]) });
      expect(calls.map((c) => c.tool)).toEqual([TOOL.copy]);
      expect(JSON.stringify(calls[0]!.args)).toContain(JSON.stringify(file).slice(1, -1));
      expect(JSON.stringify(calls[0]!.args)).toContain(JSON.stringify(`D:\\out\\${name}.bak`).slice(1, -1));
    }
    // 不给值（不是这次运行的 agent）：变量没法静态确定，按看不清的路径算
    expect(JSON.stringify(splitShellCommand(command, { cwd: "D:\\work", homeDir: "C:\\Users\\me" }).map((c) => c.args))).toContain("<unresolved:");
  });
});
