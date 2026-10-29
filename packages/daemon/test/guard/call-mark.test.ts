// 守卫切面：一次调用要动的是对外的事（外）还是本机的敏感权限（权）（93 号票，guard/nature.ts 的 toolCallMark：
// 策略标记里有敏感操作的才标，按工具的权限种类分外、权）。二狗的敏感操作是命中了关注类别的调用，
// "对外"只有一个口径：判定里实际要判的调用有一条往外送（sendsOut）。没命中类别的不标；通用 bash 按拆出来的调用看。
// 最后一段看会话里的工具调用 part 真的带上了这个标记。
import { describe, expect, test } from "vitest";
import { BUILTIN_TOOL_REGISTRY, type EnvironmentFacts, judgeToolCall, type ToolCallMark, toolCallMark } from "../../src/guard/index.ts";
import { type CallState, newCallState, toolCallPart } from "../../src/guard-runtime/tool-call-record.ts";
import { bash, call, inTask, maintainer, P, v1Satisfied } from "./helpers/guard-input.ts";

/** 任务里的维护者（工作目录 E:\work\notes）做一次调用，v1 模板的前提先满足（免得被退回）；连同命中的类别一起看 */
function markOf(toolName: string, args: Record<string, unknown>, facts: EnvironmentFacts = {}): { mark: ToolCallMark | undefined; categories: string[] } {
  const v1 = v1Satisfied(P.workDir);
  const input = inTask(maintainer(), call(toolName, args), { ...v1, facts: { ...v1.facts, ...facts } });
  const j = judgeToolCall(input);
  return { mark: toolCallMark(input, j), categories: j.categories };
}
const bashMark = (command: string) => markOf("bash", bash(command).args as Record<string, unknown>);

/** 工作目录里这几个文件在不在 */
const files = (exists: boolean, ...names: string[]): EnvironmentFacts => ({ files: Object.fromEntries(names.map((n) => [`${P.workDir}\\${n}`, { exists }])) });

describe("没命中关注类别的不标", () => {
  test.each<[string, string, Record<string, unknown>, EnvironmentFacts]>([
    ["读工作目录里的文件", "read", { path: "a.txt" }, {}],
    ["在工作目录里写新文件", "write", { path: "new.md", content: "x" }, files(false, "new.md")],
    ["跑测试", "run_tests", {}, {}],
  ])("%s", (_name, tool, args, facts) => {
    const got = markOf(tool, args, facts);
    expect(got.categories).toEqual([]);
    expect(got.mark).toBeUndefined();
  });
});

describe("命中了关注类别的：往外送是外，别的是权", () => {
  test("推送（对外发送）是外", () => {
    const got = markOf("git_push", { remote: "origin", branch: "main" });
    expect(got.categories).toContain("external_send");
    expect(got.mark).toBe("out");
  });

  test("覆盖工作目录里已有的文件（删除或覆盖）是权", () => {
    const got = markOf("write", { path: "old.md", content: "x" }, files(true, "old.md"));
    expect(got.categories).toContain("delete_or_overwrite");
    expect(got.mark).toBe("perm");
  });

  test("只读的越界（读项目目录外的文件）也是权：\"访问计划外的文件\"同样算敏感权限", () => {
    const got = markOf("read", { path: `${P.outside}\\a.md` });
    expect(got.categories).toContain("outside_project");
    expect(got.mark).toBe("perm");
  });

  test("通用 bash 按拆出来的调用看：里面有推送的是外", () => {
    const got = bashMark("git add -A && git commit -m wip && git push origin main");
    expect(got.categories.length).toBeGreaterThan(0);
    expect(got.mark).toBe("out");
  });
});

describe("工具调用的记录真的带上 mark（93 号票评审：会话里的工具调用 part，guard-runtime/tool-call-record.ts）", () => {
  /** 一次判定过、放行执行完的调用写成的 part */
  function partOf(toolName: string, args: Record<string, unknown>, facts: EnvironmentFacts = {}) {
    const v1 = v1Satisfied(P.workDir);
    const input = inTask(maintainer(), call(toolName, args), { ...v1, facts: { ...v1.facts, ...facts } });
    const state: CallState = { ...newCallState({ type: "guard_request", requestId: "r-1", toolCallId: "c-1", toolName, args }), input, judgement: judgeToolCall(input), outcome: "allowed" };
    return toolCallPart(state, { type: "tool_call_end", toolCallId: "c-1", toolName, isError: false, resultText: "好了" }, BUILTIN_TOOL_REGISTRY);
  }

  test("命中关注类别、往外送的记外", () => {
    expect(partOf("git_push", { remote: "origin", branch: "main" })).toMatchObject({ outcome: "done", mark: "out" });
  });

  test("命中关注类别、不往外送的记权", () => {
    expect(partOf("write", { path: "old.md", content: "x" }, files(true, "old.md"))).toMatchObject({ outcome: "done", mark: "perm" });
  });

  test("没命中关注类别的不记", () => {
    const part = partOf("read", { path: "a.txt" });
    expect(part.categoryTitles).toEqual([]);
    expect(part).not.toHaveProperty("mark");
  });

  test("判定出错（没有判定）的不记", () => {
    const state: CallState = { ...newCallState({ type: "guard_request", requestId: "r-2", toolCallId: "c-2", toolName: "git_push", args: {} }), outcome: "allowed" };
    expect(toolCallPart(state, { type: "tool_call_end", toolCallId: "c-2", toolName: "git_push", isError: false, resultText: "" }, BUILTIN_TOOL_REGISTRY)).not.toHaveProperty("mark");
  });
});
