// 守卫切面：时序规则的校验（参考 AgentSense 的 policies-check）。纯函数，存计划时直接调用：
// 规则引用了注册表里没有的工具或参数名、形态写错时报错，并指出是哪条规则。
import { describe, expect, it } from "vitest";
import { judgeToolCall, v1RuleTemplates, validateTemporalRules, BUILTIN_TOOL_REGISTRY, type TemporalRule } from "../../src/guard/index.ts";
import { call, inTask, maintainer, v1Satisfied } from "./helpers/guard-input.ts";
import { TEST_TOOLS } from "./helpers/test-tools.ts";

const ok: TemporalRule = {
  id: "tests-before-push",
  title: "push 之前必须跑过测试",
  trigger: { tool: "git_push" },
  for_each: { var: "r", in: { as_list: "$current.args.remote" } },
  when: { and: [{ present: "$r" }, { ne: ["$task.stageId", "hotfix"] }] },
  unless: { eq: ["$current.args.force", false] },
  require: { before: { tool: ["run_tests"], where: { path_within: ["$current.args.repoPath", "$prior.args.repoPath"] } } },
  message: "推送 {r} 之前要跑过测试（{current.args.branch}）",
  on_violation: "block",
};

const validate = (rules: readonly unknown[], extra: { facts?: string[] } = {}) => validateTemporalRules(rules, { tools: TEST_TOOLS, ...extra });
/** 改一条合法规则的某几个字段，校验它，返回问题 */
const problemsOf = (patch: Record<string, unknown>) => validate([{ ...ok, ...patch }]).problems;

describe("规则校验", () => {
  it("合法的规则通过；v1 模板本身也通过", () => {
    expect(validate([ok])).toEqual({ ok: true, problems: [] });
    expect(validateTemporalRules(v1RuleTemplates(TEST_TOOLS), { tools: TEST_TOOLS, allowReserved: true })).toEqual({ ok: true, problems: [] });
    expect(validateTemporalRules(v1RuleTemplates(BUILTIN_TOOL_REGISTRY), { tools: BUILTIN_TOOL_REGISTRY, allowReserved: true })).toEqual({ ok: true, problems: [] });
  });

  // [说明, 改动, 问题里要有的话]
  const BROKEN: [string, Record<string, unknown>, RegExp][] = [
    ["触发的工具没登记", { trigger: { tool: "git_pussh" } }, /tests-before-push.*git_pussh.*没有登记/],
    ["要求之前做过的工具没登记", { require: { before: { tool: "run_test" } } }, /run_test.*没有登记/],
    ["读了触发它的工具没有的参数", { when: { eq: ["$current.args.remotes", "origin"] } }, /git_push.*没有参数 remotes/],
    ["读了之前那次调用的工具没有的参数", { require: { before: { tool: "run_tests", where: { eq: ["$prior.args.remote", "x"] } } } }, /run_tests.*没有参数 remote/],
    ["get 写法读的参数也查", { when: { eq: [{ get: ["$current.args", "remotes"] }, "x"] } }, /没有参数 remotes/],
    // 68 号票：效果日志里写入的全文、编辑的新旧片段只记了长度和摘要哈希
    ["之前那次读写进去的全文", { require: { before: { tool: "write", where: { eq: ["$prior.args.content", "x"] } } } }, /write 的参数 content只记了长度和摘要哈希/],
    ["之前那次读改文件的新旧片段", { require: { before: { tool: "edit", where: { present: "$prior.args.edits" } } } }, /edit 的参数 edits只记了长度和摘要哈希/],
    ["之前那次读拼起来的内容，工具里有写文件", { require: { not_before: { tool: ["git_commit", "write"], where: { eq: ["$prior.content", "x"] } } } }, /write 的内容只记了长度和摘要哈希/],
    ["之前那次整份比参数", { require: { not_before: { tool: "write", where: { eq: ["$prior.args", "$current.args"] } } } }, /write 的内容类参数（这样写是整份读）只记了长度和摘要哈希/],
    ["整份读之前那次调用", { require: { before: { tool: "edit", where: { ne: ["$prior", null] } } } }, /edit 的内容类参数（这样写是整份读）只记了长度和摘要哈希/],
    ["get 取之前那次写进去的内容", { require: { not_before: { tool: "write", where: { known: { get: ["$prior", "args.content"] } } } } }, /write 的参数 content只记了长度和摘要哈希/],
    ["get 先取整份参数再取内容", { require: { not_before: { tool: "write", where: { known: { get: [{ get: ["$prior", "args"] }, "content"] } } } } }, /write 的内容类参数（这样写是整份读）/],
    ["require 同时写了两种形态", { require: { before: { tool: "run_tests" }, check: true } }, /require 只能写 before、not_before、check 之一/],
    ["require 一种也没写", { require: {} }, /require 只能写 before、not_before、check 之一/],
    ["多了不认识的键", { severity: "high", onViolation: "block" }, /不认识的键 onViolation/],
    ["on_violation 写错", { on_violation: "deny" }, /on_violation 只能是 block、confirm、pull_back/],
    ["trigger.where 里引用了不存在的东西", { trigger: { tool: "git_push", where: { eq: ["$current.args.remotes", "origin"] } } }, /git_push.*没有参数 remotes/],
    ["trigger.where 里用了不认识的运算", { trigger: { tool: "git_push", where: { equals: ["$current.args.remote", "origin"] } } }, /不认识的运算 equals/],
    ["只在规划时检查", { modes: ["plan"] }, /modes 里没有 runtime/],
    ["不认识的运算", { when: { equals: ["$current.args.remote", "origin"] } }, /不认识的运算 equals/],
    ["操作数个数不对", { when: { eq: ["$current.args.remote"] } }, /eq 要 2 个操作数/],
    ["正则写错", { when: { matches: ["$current.args.branch", "release/("] } }, /正则.*release\/\(/],
    ["引用了不存在的东西", { when: { eq: ["$param.tool", "x"] } }, /不认识的 \$param/],
    ["在 require 之外用 $prior", { when: { eq: ["$prior.tool", "x"] } }, /\$prior 只能用在 require/],
    ["$current 上没有的字段", { when: { eq: ["$current.argz", "x"] } }, /\$current 没有 argz/],
    ["不认识的环境事实", { when: { present: "$facts.contacts" } }, /\$facts 没有 contacts/],
    ["message 里的占位符引用了不存在的东西", { message: "推送到 {remote}" }, /message.*\{remote\}/],
    ["for_each 没写 var", { for_each: { in: "$current.args.remote" } }, /for_each 要写 var 和 in/],
    ["没有 trigger", { trigger: undefined }, /trigger 要写 tool/],
    ["用了 v1 模板保留的 id", { id: "v1.test-before-push" }, /v1 模板保留的 id/],
  ];
  for (const [name, patch, pattern] of BROKEN) {
    it(`${name}：报错并指出是哪条规则`, () => {
      const problems = problemsOf(patch);
      expect(problems.join("\n")).toMatch(pattern);
      expect(problems.every((p) => p.startsWith("规则 "))).toBe(true);
    });
  }

  it("没有 id、id 重复：报错", () => {
    expect(validate([{ ...ok, id: undefined }]).problems.join("\n")).toMatch(/第 1 条规则没有 id/);
    expect(validate([ok, ok]).problems.join("\n")).toMatch(/id tests-before-push 重复/);
  });

  it("这次调用写的内容、之前写文件的路径和提交说明照常能读（68 号票只缩了效果日志里的内容）", () => {
    const rule = {
      id: "after-notes",
      trigger: { tool: "write" },
      when: { ne: ["$current.args.content", ""] },
      require: {
        before: {
          tool: ["write", "git_commit"],
          where: {
            or: [
              { path_within: ["$prior.args.path", "$current.args.path"] },
              { present: "$prior.args.message" },
              { eq: [{ get: ["$prior.args", "path"] }, { get: ["$current", "args.path"] }] },
              { any: { from: { get: ["$prior", "paths"] }, where: { eq: ["$row.access", "write"] } } },
            ],
          },
        },
      },
    };
    expect(validate([rule])).toEqual({ ok: true, problems: [] });
  });

  it("多个触发工具：参数只要有一个工具有就行", () => {
    const rule = { id: "r", trigger: { tool: ["git_push", "http_request"] }, when: { eq: ["$current.args.method", "POST"] } };
    expect(validate([rule]).ok).toBe(true);
  });

  it("调用方声明了额外的环境事实，规则就能用", () => {
    const rule = { id: "r", trigger: { tool: "mcp_send_email" }, when: { any: { from: "$facts.contacts", where: { eq: ["$row.internal", false] } } } };
    expect(validate([rule]).ok).toBe(false);
    expect(validate([rule], { facts: ["contacts"] }).ok).toBe(true);
  });

  it("校验不通过的规则在判定时一律'判断不了'，先问用户（触发它的工具对得上时）", () => {
    const broken = { ...ok, when: { equals: ["$current.args.remote", "origin"] } };
    const j = judgeToolCall(inTask(maintainer(), call("git_push", { remote: "origin" }), { temporalRules: [broken], ...v1Satisfied() }));
    expect(j.temporalRules).toContainEqual(expect.objectContaining({ ruleId: ok.id, status: "unknown", outcome: "ask_first" }));
    expect(j.explanation).toMatch(/校验不通过.*不认识的运算 equals/);
    expect(judgeToolCall(inTask(maintainer(), call("git_status_diff", {}), { temporalRules: [broken] })).temporalRules).toEqual([]);
  });
});
