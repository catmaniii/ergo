// 流程的计划推授权项、标注时按真实路径（58 号票复审）：用真的 Windows 目录联接（junction）——
// 步骤写的是工作目录里的 sub，sub 实际指向工作目录之外。规划时取真实路径：计划卡上这一步标出"真实路径在工作目录之外"、
// 敏感标注里有"越出项目目录"；授权项记下规划时的真实路径。执行时（判定前现取事实）真实路径和规划时一样才算授权内，
// 联接改指别处的照常问用户。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { workflowConfirmationItems } from "@ergou/protocol";
import { BUILTIN_TOOL_REGISTRY, type GuardAgent, type GuardPlaces, judgeToolCall, TOOL } from "../../src/guard/index.ts";
import { gatherFacts } from "../../src/guard-runtime/facts.ts";
import { toGuardPlan } from "../../src/tasks/plan.ts";
import { reviewWorkflowDraft } from "../../src/tasks/workflow-plan.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const real = (p: string) => fs.realpathSync.native(p);

function layout() {
  const root = real(makeTempDir("ergou-workflow-plan-"));
  const dir = (...parts: string[]) => {
    const p = path.join(root, ...parts);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  const places: GuardPlaces = {
    dataDir: { root: dir("data"), config: dir("data", "config"), secrets: dir("data", "secrets"), db: dir("data", "db"), projects: dir("data", "projects") },
    programDir: dir("program"),
    homeDir: dir("home"),
  };
  return { places, workDir: dir("data", "outputs", "t-1"), outside: dir("elsewhere", "repo"), other: dir("elsewhere", "other") };
}

describe("流程的计划按真实路径推授权项、标出真实路径在工作目录之外的步骤", () => {
  it("sub 是指到工作目录之外的目录联接：卡上标出来；执行时联接没变才算授权内，改指别处的照常问用户", async () => {
    const { places, workDir, outside, other } = layout();
    const sub = path.join(workDir, "sub");
    fs.symlinkSync(outside, sub, "junction");
    const now = Date.now();

    const reviewed = await reviewWorkflowDraft(
      { goal: "提交 sub 里的改动", steps: [{ id: "s1", title: "提交", tool: TOOL.git_commit, args: { repoPath: "sub", message: "x" } }], rules: [] },
      1,
      { tools: BUILTIN_TOOL_REGISTRY, settings: {}, places, maintainerId: "m-1", cwd: workDir, now },
    );
    const [s1] = reviewed.plan.steps;
    // 卡上：这一步的真实路径在工作目录之外；敏感标注里有"越出项目目录"（任务里默认"计划里列了才做"，这一步列了就算授权）
    expect(s1!.outside).toEqual([{ arg: "repoPath", path: sub, realPath: outside }]);
    expect(s1!.marks).toContainEqual(expect.objectContaining({ category: "outside_project", title: "越出项目目录", authorized: true }));
    // 授权前必须逐条勾的确认事项里有它（不勾不能授权）
    expect(workflowConfirmationItems(reviewed.plan.review, reviewed.plan.steps)).toEqual([
      { key: `o:s1:repoPath:${sub}`, text: `s1「提交」的 repoPath 写的是 ${sub}，真实路径在工作目录之外（${outside}）：同意照这样做` },
    ]);
    // 授权项：写死的参数、只认写了的参数、规划时的真实路径
    const grants = reviewed.execution.stages[0]!.policy.grants;
    expect(grants).toEqual([{ id: "g-s1", tool: TOOL.git_commit, title: "s1「提交」", scope: { repoPath: sub, message: "x" }, realScope: { repoPath: outside }, maxUses: 1, exactArgs: true }]);

    // 执行时：判定前现取事实，按真实路径比
    const agent: GuardAgent = { kind: "maintainer", agentId: "m-1", cwd: workDir, toolkit: { bash: true, network: false }, projectRecords: [], workingDirs: [workDir] };
    const plan = toGuardPlan(reviewed.execution, { confirmedAt: now });
    const judgeCommit = () => {
      const args = { repoPath: "sub", message: "x" };
      const facts = gatherFacts([{ tool: TOOL.git_commit, args, origin: "tool" }], { tools: BUILTIN_TOOL_REGISTRY, agent, homeDir: places.homeDir });
      return judgeToolCall({
        call: { toolName: TOOL.git_commit, args },
        agent,
        places,
        task: { taskId: "t-1", currentStageId: "flow", plan },
        effectLog: [],
        settings: {},
        facts,
        tools: BUILTIN_TOOL_REGISTRY,
        now: now + 1000,
      });
    };
    expect(judgeCommit().withinGrant).toBe(true);

    // 联接改指别处：真实路径对不上，照常问用户
    fs.rmdirSync(sub);
    fs.symlinkSync(other, sub, "junction");
    const moved = judgeCommit();
    expect(moved.withinGrant).toBe(false);
    expect(moved.explanation).toContain(`repoPath 的真实路径是 ${other}`);
  });

  it("没有联接的普通路径：不标；授权项的真实路径就是它自己", async () => {
    const { places, workDir } = layout();
    const reviewed = await reviewWorkflowDraft(
      { goal: "写笔记", steps: [{ id: "s1", title: "写笔记", tool: TOOL.write, args: { path: "notes.md", content: "x" } }], rules: [] },
      1,
      { tools: BUILTIN_TOOL_REGISTRY, settings: {}, places, maintainerId: "m-1", cwd: workDir, now: Date.now() },
    );
    expect(reviewed.plan.steps[0]!.outside).toBeUndefined();
    const notes = path.join(workDir, "notes.md");
    expect(reviewed.execution.stages[0]!.policy.grants).toEqual([expect.objectContaining({ scope: { path: notes, content: "x" }, realScope: { path: notes } })]);
  });
});
