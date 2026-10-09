// 守卫切面：流程计划的审查修补（58 号票，guard/workflow-review.ts）。照 AgentSense 的 planguardReviewer：
// 计划交给用户授权之前，按规则（框架的 v1 模板 + 计划里写的）在规划时查一遍，能修的修（插一步、改写），
// 修不了的退回维护者或判定不可执行；另给出每一步要满足的条件和规划时查出的结果。
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_REGISTRY, TOOL, V1_TEMPLATE_IDS } from "../../src/guard/index.ts";
import { reviewWorkflow, type WorkflowDraftStep } from "../../src/guard/workflow-review.ts";
import { maintainer, P } from "./helpers/guard-input.ts";

const agent = maintainer();
const review = (steps: WorkflowDraftStep[], rules: Array<Record<string, unknown> & { id: string }> = []) =>
  reviewWorkflow({ goal: "把 notes 的改动推上去", steps, rules, tools: BUILTIN_TOOL_REGISTRY, agent, homeDir: P.home });

const step = (id: string, tool: string, args: Record<string, unknown> = {}, title = `${tool} 一下`): WorkflowDraftStep => ({ id, title, tool, args });

describe("审查修补", () => {
  it("推送之前没有跑测试：审查在推送前面插一步跑测试（p1），推送的前置步骤记上它；插入后这一条满足；不打扰用户", async () => {
    const { review: r, steps, conditions } = await review([step("s1", TOOL.git_commit, { message: "整理" }, "提交改动"), step("s2", TOOL.git_push, { remote: "origin", branch: "main" }, "推送到 origin")]);
    expect(r).toMatchObject({ verdict: "fail", status: "patched", confirmations: [], replans: [], scanned: { rules: 6, steps: 2 } });
    expect(r.violations).toEqual([expect.objectContaining({ stepId: "s2", property: V1_TEMPLATE_IDS.testBeforePush })]);
    expect(r.actions).toEqual([expect.objectContaining({ kind: "insert", title: "推送之前先在这个仓库里跑一遍测试", covers: [`${V1_TEMPLATE_IDS.testBeforePush}@s2`] })]);
    expect(steps.map((s) => [s.id, s.tool, s.inserted === true])).toEqual([
      ["s1", TOOL.git_commit, false],
      ["p1", TOOL.run_tests, true],
      ["s2", TOOL.git_push, false],
    ]);
    // 插进来的那一步：参数是修补方案给的（推送那一步的仓库，默认取工作目录）
    expect(steps[1]).toMatchObject({ title: "推送之前先在这个仓库里跑一遍测试", args: { repoPath: P.workDir }, after: [] });
    // 原来的步骤：参数照维护者写的（不换成规范化之后的样子，也不补上推送的 headCommit）
    expect(steps[2]).toMatchObject({ args: { remote: "origin", branch: "main" }, after: ["p1"] });
    expect(conditions.s2).toContainEqual(expect.objectContaining({ ruleId: V1_TEMPLATE_IDS.testBeforePush, template: true, status: "pass" }));
  });

  it("先跑测试再推送：审查通过，什么也不改", async () => {
    const { review: r, steps } = await review([step("s1", TOOL.run_tests), step("s2", TOOL.git_push, { remote: "origin" })]);
    expect(r).toMatchObject({ verdict: "pass", status: "pass", violations: [], actions: [] });
    expect(steps.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("一律禁止的（force push）：没有修补，判定不可执行，说明哪一步违反了哪条", async () => {
    const { review: r } = await review([step("s1", TOOL.run_tests), step("s2", TOOL.git_push, { remote: "origin", force: true })]);
    expect(r).toMatchObject({ verdict: "fail", status: "blocked" });
    expect(r.violations).toEqual([expect.objectContaining({ stepId: "s2", property: V1_TEMPLATE_IDS.noForcePushOrRmRfOutside })]);
    expect(r.note).toBeTruthy();
  });

  it("计划里写的规则：违反时先问我的（不写 on_violation）交给用户逐项确认；退回的（pull_back）退回维护者重写", async () => {
    const confirmRule = { id: "only-once", title: "只推一次", trigger: { tool: TOOL.git_push }, require: { not_before: { tool: TOOL.git_push } }, message: "第二次推送要你点头" };
    const asked = await review([step("s1", TOOL.run_tests), step("s2", TOOL.git_push, { remote: "origin" }), step("s3", TOOL.git_push, { remote: "backup" })], [confirmRule]);
    expect(asked.review).toMatchObject({ status: "needs_confirmation", confirmations: ["第二次推送要你点头"] });

    const pullBackRule = { id: "status-first", trigger: { tool: TOOL.git_commit }, require: { before: { tool: TOOL.git_status_diff } }, message: "提交之前先看一眼 git 状态", on_violation: "pull_back" };
    const replanned = await review([step("s1", TOOL.git_commit, { message: "x" })], [pullBackRule]);
    expect(replanned.review).toMatchObject({ status: "needs_replan", replans: ["提交之前先看一眼 git 状态"] });
  });

  it("规则自己写了修补方案的照它修（改写参数）", async () => {
    const rule = {
      id: "main-only",
      title: "只往 main 推",
      trigger: { tool: TOOL.git_push },
      require: { check: { eq: ["$current.args.branch", "main"] } },
      message: "只能推 main",
      repairs: [{ rewrite: { set: { branch: "main" }, title: "推送的分支改成 main" } }],
    };
    const { review: r, steps } = await review([step("s1", TOOL.run_tests), step("s2", TOOL.git_push, { remote: "origin", branch: "dev" })], [rule]);
    expect(r).toMatchObject({ status: "patched" });
    expect(r.actions).toEqual([expect.objectContaining({ kind: "rewrite", title: "推送的分支改成 main", stepId: "s2" })]);
    expect(steps[1]).toMatchObject({ id: "s2", args: { remote: "origin", branch: "main" } });
    expect(steps[1]!.patches).toHaveLength(1);
  });
});

describe("调整顺序（照 AgentSense 的 travel/reorder）", () => {
  it("规则写了 move_after 的：排错了的步骤挪到它依赖的那一步之后，前置步骤记上它；修补动作是调整顺序，不打扰用户", async () => {
    const rule = {
      id: "read-after-write",
      title: "读笔记要在写好之后",
      trigger: { tool: TOOL.read },
      when: { any: { from: "$plan.steps", where: { eq: ["$row.tool", TOOL.write] } } },
      require: { before: { tool: TOOL.write } },
      message: "「{current.title}」排在写笔记之前，读不到新内容",
      repairs: [{ move_after: { tool: TOOL.write } }],
    };
    const { review: r, steps, conditions } = await review(
      [step("s1", TOOL.read, { path: "notes.md" }, "读一遍笔记"), step("s2", TOOL.write, { path: "notes.md", content: "x" }, "写笔记")],
      [rule],
    );
    expect(r).toMatchObject({ status: "patched", confirmations: [], replans: [] });
    expect(r.actions).toEqual([expect.objectContaining({ kind: "move_after", stepId: "s1" })]);
    expect(steps.map((s) => [s.id, s.after])).toEqual([
      ["s2", []],
      ["s1", ["s2"]],
    ]);
    expect(conditions.s1).toContainEqual(expect.objectContaining({ ruleId: "read-after-write", status: "pass" }));
  });
});

describe("逐条规则复测（照 AgentSense 的 RuleProbe）", () => {
  it("每条规则单独扫一遍原计划：查出几处违反、几处判不了，规则的来源；各阶段耗时", async () => {
    const { review: r } = await review([step("s1", TOOL.git_commit, { message: "x" }), step("s2", TOOL.git_push, { remote: "origin", branch: "main" })]);
    expect(r.rules.map((p) => p.id)).toEqual(Object.values(V1_TEMPLATE_IDS));
    expect(r.rules.find((p) => p.id === V1_TEMPLATE_IDS.testBeforePush)).toMatchObject({ template: true, violated: 1, unknown: 0 });
    expect(r.rules.find((p) => p.id === V1_TEMPLATE_IDS.noForcePushOrRmRfOutside)).toMatchObject({ violated: 0 });
    expect(r.phases).toEqual({ facts: 0, compile: expect.any(Number), solve: expect.any(Number), probe: expect.any(Number) });
  });
});

describe("每一步要满足的条件", () => {
  it("触发它的规则都列出来，连同规划时查出的结果：要环境事实才判得了的（覆盖前已提交）推迟到执行时再查", async () => {
    const { review: r, conditions } = await review([step("s1", TOOL.write, { path: `${P.workDir}\\README.md`, content: "x" }, "改写 README")]);
    // 规划时不取文件在不在、git 状态：判不了，推迟到执行时
    expect(r.deferred).toEqual([expect.objectContaining({ stepId: "s1", property: V1_TEMPLATE_IDS.backupBeforeOverwrite })]);
    expect(conditions.s1).toEqual([expect.objectContaining({ ruleId: V1_TEMPLATE_IDS.backupBeforeOverwrite, template: true, status: "unknown" })]);
  });

  it("计划里写的规则也算一步的条件（标成计划里写的）；trigger.where 明确不成立的不算", async () => {
    const rule = { id: "no-push-main", title: "别往 main 推", trigger: { tool: TOOL.git_push, where: { eq: ["$current.args.branch", "main"] } }, on_violation: "block" };
    const { conditions } = await review([step("s1", TOOL.run_tests), step("s2", TOOL.git_push, { remote: "origin", branch: "report" })], [rule]);
    const ids = conditions.s2!.map((c) => c.ruleId);
    expect(ids).toContain(V1_TEMPLATE_IDS.testBeforePush);
    expect(ids).not.toContain("no-push-main");
    const other = await review([step("s1", TOOL.run_tests), step("s2", TOOL.git_push, { remote: "origin", branch: "main" })], [rule]);
    expect(other.review.status).toBe("blocked");
    expect(other.conditions.s2).toContainEqual(expect.objectContaining({ ruleId: "no-push-main", template: false, status: "violated" }));
  });
});
