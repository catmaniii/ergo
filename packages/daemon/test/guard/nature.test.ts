// 守卫切面：一次工具调用做了什么性质的事——只看、动手、删改（54 号票，guard/nature.ts，用户 2026-10-09 定由守护进程判定，
// 按"动没动原来就有的东西"分）。按这次判定实际要判的调用（通用 bash 拆成的伪工具调用）取最重的；
// 局部改、整个覆盖已有的文件都算删改，文件在不在看环境事实，查不清的按新建算动手。
import { describe, expect, test } from "vitest";
import { BUILTIN_TOOL_REGISTRY, type EnvironmentFacts, judgeToolCall, type ToolDescriptor, type ToolNature, toolNature } from "../../src/guard/index.ts";
import { bash, call, inTask, maintainer, P, v1Satisfied } from "./helpers/guard-input.ts";

/** 任务里的维护者（工作目录 E:\work\notes）做一次调用：v1 模板的前提先满足（不影响性质，只是免得被退回） */
function natureOf(toolName: string, args: Record<string, unknown>, facts: EnvironmentFacts = {}, tools = BUILTIN_TOOL_REGISTRY): ToolNature {
  const v1 = v1Satisfied();
  const input = inTask(maintainer(), call(toolName, args), { ...v1, facts: { ...v1.facts, ...facts }, tools });
  return toolNature(input, judgeToolCall(input));
}
const bashNature = (command: string, facts: EnvironmentFacts = {}) => natureOf("bash", bash(command).args as Record<string, unknown>, facts);
/** 代为执行的工具的登记 */
const host = (name: string, extra: Partial<ToolDescriptor>): ToolDescriptor => ({ name, title: name, source: "host", categories: [], args: {}, ...extra });
const existing = (...names: string[]): EnvironmentFacts => ({ files: Object.fromEntries(names.map((n) => [`${P.workDir}\\${n}`, { exists: true }])) });
const absent = (...names: string[]): EnvironmentFacts => ({ files: Object.fromEntries(names.map((n) => [`${P.workDir}\\${n}`, { exists: false }])) });

describe("模型直接调的工具", () => {
  test.each<[string, string, Record<string, unknown>, EnvironmentFacts, ToolNature]>([
    ["读文件", "read", { path: "a.txt" }, {}, "look"],
    ["列目录", "ls", {}, {}, "look"],
    ["搜索内容", "grep", { pattern: "TODO" }, {}, "look"],
    ["查找文件", "find", { pattern: "*.md" }, {}, "look"],
    ["git 状态和差异", "git_status_diff", {}, {}, "look"],
    ["联网搜索（70 号票）", "web_search", { query: "二狗", engine: "bing", tavily: true }, {}, "look"],
    ["读网页（70 号票）", "web_fetch", { url: "https://example.com/a" }, {}, "look"],
    ["写一个新文件", "write", { path: "new.md", content: "x" }, absent("new.md"), "act"],
    ["整个覆盖一个已有的文件：删改", "write", { path: "old.md", content: "x" }, existing("old.md"), "modify"],
    ["写文件、查不清在不在：按新建算", "write", { path: "maybe.md", content: "x" }, {}, "act"],
    ["局部改一个已有的文件：删改", "edit", { path: "old.md", edits: [] }, existing("old.md"), "modify"],
    ["改文件、查不清在不在：按新建算", "edit", { path: "maybe.md", edits: [] }, {}, "act"],
    ["提交", "git_commit", { message: "wip" }, {}, "act"],
    ["推送", "git_push", { remote: "origin", branch: "main" }, {}, "act"],
    ["强推：删改", "git_push", { remote: "origin", branch: "main", force: true }, {}, "modify"],
    ["跑测试", "run_tests", {}, {}, "act"],
    ["没登记的工具", "mystery_tool", {}, {}, "act"],
  ])("%s", (_name, tool, args, facts, nature) => {
    expect(natureOf(tool, args, facts)).toBe(nature);
  });

  test("代为执行的工具：登记成只看的是只看，登记成删改的是删改，给了 modifiesWith 参数的是删改，别的是动手", () => {
    const tools = {
      ...BUILTIN_TOOL_REGISTRY,
      view_board: host("view_board", { nature: "look", readOnlyOrIdempotent: true }),
      cancel_reminder: host("cancel_reminder", { nature: "modify" }),
      adjust_skills: host("adjust_skills", { modifiesWith: ["remove"], readOnlyOrIdempotent: true }),
      write_segment_summary: host("write_segment_summary", { readOnlyOrIdempotent: true }),
    };
    expect(natureOf("view_board", {}, {}, tools)).toBe("look");
    expect(natureOf("cancel_reminder", { reminderId: "r-1" }, {}, tools)).toBe("modify");
    expect(natureOf("adjust_skills", { add: ["pdf"], remove: [], why: "要读 PDF" }, {}, tools)).toBe("act");
    expect(natureOf("adjust_skills", { add: [], remove: ["pdf"], why: "用不上" }, {}, tools)).toBe("modify");
    // 幂等不等于只看：写摘要改了东西
    expect(natureOf("write_segment_summary", {}, {}, tools)).toBe("act");
  });
});

describe("通用 bash：按拆出来的每条调用取最重的", () => {
  test.each<[string, EnvironmentFacts, ToolNature]>([
    ["ls", {}, "look"],
    ["ls -la src", {}, "look"],
    ["cat a.txt | grep foo | wc -l", {}, "look"],
    ["echo hi", {}, "look"],
    ["git status && git diff HEAD~1", {}, "look"],
    ["curl https://example.com", {}, "look"],
    ["curl -d name=x https://example.com", {}, "act"],
    ["mkdir -p out", {}, "act"],
    ["echo hi > new.txt", absent("new.txt"), "act"],
    ["echo hi > old.txt", existing("old.txt"), "modify"],
    // 追加写只新增、不碰原有的内容
    ["echo hi >> old.txt", existing("old.txt"), "act"],
    ["echo hi | tee -a old.txt", existing("old.txt"), "act"],
    ["echo hi | tee old.txt", existing("old.txt"), "modify"],
    ["sed -i 's/a/b/' old.txt", existing("old.txt"), "modify"],
    ["sed 's/a/b/' old.txt", existing("old.txt"), "look"],
    ["cp a.txt b.txt", absent("b.txt"), "act"],
    ["cp a.txt b.txt", existing("b.txt"), "modify"],
    ["mv a.txt b.txt", absent("b.txt"), "modify"],
    ["rm -rf build", {}, "modify"],
    ["ls && rm a.txt", {}, "modify"],
    // git：丢掉改动、改写历史、删改分支和标签、删远端分支都是删改（54 号票评审）；提交、普通推送、建分支是动手；看状态是只看
    ["git reset --hard HEAD", {}, "modify"],
    ["git reset HEAD~1", {}, "modify"],
    ["git reset --soft HEAD~2", {}, "modify"],
    ["git reset", {}, "act"],
    ["git reset HEAD -- notes.md", {}, "act"],
    ["git checkout -- notes.md", {}, "modify"],
    ["git checkout main", {}, "act"],
    ["git restore notes.md", {}, "modify"],
    ["git clean -fd", {}, "modify"],
    ["git clean -n", {}, "look"],
    ["git stash drop", {}, "modify"],
    ["git stash", {}, "act"],
    ["git rebase main", {}, "modify"],
    ["git rebase -i HEAD~3", {}, "modify"],
    ["git branch -D feature", {}, "modify"],
    ["git branch -d feature", {}, "modify"],
    ["git branch -m old new", {}, "modify"],
    ["git branch feature", {}, "act"],
    ["git tag -d v1.0", {}, "modify"],
    ["git tag v1.0", {}, "act"],
    ["git commit -m wip", {}, "act"],
    ["git commit --amend -m wip", {}, "modify"],
    ["git commit --amend --no-edit", {}, "modify"],
    ["git push origin main", {}, "act"],
    ["git push --force origin main", {}, "modify"],
    ["git push origin +main", {}, "modify"],
    ["git push origin --delete feature", {}, "modify"],
    ["git push -d origin feature", {}, "modify"],
    ["git push origin :feature", {}, "modify"],
    ["git status", {}, "look"],
    ["python calc.py", {}, "act"],
    ["npm test", {}, "act"],
    ["npm install", {}, "act"],
    ["make all", {}, "act"],
    ["eval \"$CMD\"", {}, "act"],
  ])("%s", (command, facts, nature) => {
    expect(bashNature(command, facts)).toBe(nature);
  });
});

test("被拦下、没执行的也按要做的事算：覆盖围栏外的已有文件仍是删改，读密钥区仍是只看", () => {
  const outside = `${P.outside}\\x.txt`;
  const write = inTask(maintainer(), call("write", { path: outside, content: "x" }), { facts: { files: { [outside]: { exists: true } } } });
  const wj = judgeToolCall(write);
  expect(wj.hardRefusal).not.toBeNull();
  expect(toolNature(write, wj)).toBe("modify");
  const read = inTask(maintainer(), call("read", { path: `${P.secrets}\\token.txt` }));
  const rj = judgeToolCall(read);
  expect(rj.hardRefusal).not.toBeNull();
  expect(toolNature(read, rj)).toBe("look");
});

test("工具注册表里登记成只看的：路径都是读，不往外送", () => {
  const look = Object.values(BUILTIN_TOOL_REGISTRY).filter((t) => t.nature === "look");
  expect(look.map((t) => t.name).toSorted()).toEqual(["find", "git_status_diff", "grep", "ls", "network_read", "read", "web_fetch", "web_search"]);
  expect(look.filter((t) => t.outbound === true).map((t) => t.name)).toEqual([]);
  const accesses = look.flatMap((t) => Object.values(t.args).flatMap((rule) => (rule.kind === "path" ? [rule.access] : [])));
  expect(new Set(accesses)).toEqual(new Set(["read"]));
});
