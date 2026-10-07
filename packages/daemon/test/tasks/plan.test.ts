// 计划的检查（存计划时）、每项授权在守卫眼里的样子、确认时勾掉或收窄授权项和改假设栏、确认后的计划交给守卫的样子：
// 纯函数，表格驱动。策略（授权项加时序规则）挂在阶段或阶段组上。
// 不符合 schema 的提交由 pi 先按工具参数的 JSON Schema 拦下（契约测试），这里查 schema 管不到的：
// 全局关注类别一个不能少、阶段和阶段组的引用、授权项、时序规则（validateTemporalRules）……
import type { Plan, PlanGrant } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { BUILTIN_CATEGORY_IDS, BUILTIN_TOOL_REGISTRY, type WatchCategorySettings } from "../../src/guard/index.ts";
import { checkPlan, globalWatchCategories, grantInfoOf, narrowPlan, toGuardPlan } from "../../src/tasks/plan.ts";

const tools = BUILTIN_TOOL_REGISTRY;
const NO_SETTINGS: WatchCategorySettings = {};

const pushGrant: PlanGrant = { id: "push-main", tool: "git_push", title: "推送到 origin 的 main", scope: { remote: "origin", branch: ["main", "dev"] }, maxUses: 3 };

/** 一份合格的计划：两个阶段（s2 在 s1 之后、属于阶段组 g1），全局九类关注类别都在 */
function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    stages: [
      {
        stageId: "s1",
        title: "调研",
        deliverables: ["调研笔记"],
        acceptance: [{ criterion: "笔记覆盖三个方案", method: "review" }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 200_000, toolCalls: 80 },
      },
      {
        stageId: "s2",
        title: "成文",
        deliverables: ["报告"],
        acceptance: [{ criterion: "报告能打开", method: "script", script: "test -f report.md" }],
        mode: "steps",
        steps: ["写大纲", "写正文"],
        dependsOn: ["s1"],
        policy: { grants: [pushGrant], temporalRules: [{ id: "r-test-before-push", title: "推送前先跑测试", trigger: { tool: "git_push" }, require: { before: { tool: "run_tests" } } }] },
        budget: { tokens: 100_000, toolCalls: 40 },
        groupId: "g1",
      },
    ],
    stageGroups: [{ groupId: "g1", title: "成文组", policy: { grants: [{ id: "write-out", tool: "write", title: "写报告", scope: { path: "E:\\work\\out" } }], temporalRules: [] } }],
    toolkit: { skills: [], mcp: [], bash: true, network: true },
    projects: [],
    watchCategories: BUILTIN_CATEGORY_IDS.map((id) => ({ id })),
    scheduledJobs: [],
    assumptions: ["只看公开资料"],
    stops: { count: 1, where: ["成文前让你看大纲"] },
    tokenEstimate: 300_000,
    ...overrides,
  };
}

/** 换掉第 i 个阶段的策略 */
const withStagePolicy = (p: Plan, i: number, policy: Partial<Plan["stages"][number]["policy"]>): Plan => ({
  ...p,
  stages: p.stages.map((s, j) => (j === i ? { ...s, policy: { ...s.policy, ...policy } } : s)),
});
const withGroupPolicy = (p: Plan, policy: Partial<Plan["stageGroups"][number]["policy"]>): Plan => ({
  ...p,
  stageGroups: p.stageGroups.map((g) => ({ ...g, policy: { ...g.policy, ...policy } })),
});

const problemsOf = (p: Plan, settings = NO_SETTINGS) => {
  const r = checkPlan(p, { tools, settings });
  return r.ok ? [] : r.problems;
};

describe("存计划时的检查", () => {
  it("合格的计划通过；全局类别的名字由运行时补上", () => {
    const result = checkPlan(plan(), { tools, settings: NO_SETTINGS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.watchCategories[0]).toEqual({ id: "spend_money", title: "花钱" });
    expect(result.plan.stages).toEqual(plan().stages);
  });

  it("本任务的关注类别默认取全局、只能加：少了任何一个全局类别（内置的、用户自定义的）都不行", () => {
    const without = plan({ watchCategories: BUILTIN_CATEGORY_IDS.filter((id) => id !== "external_send").map((id) => ({ id })) });
    expect(problemsOf(without)).toEqual(["本任务的关注类别少了全局的「以我的名义对外发送或发布」（external_send）：全局的类别一个都不能少，只能在其上增加"]);
    const settings: WatchCategorySettings = { custom: [{ id: "pay-wechat", title: "微信付款", match: { tools: ["wechat_pay"] }, chat: "ask_first", task: "ask_first" }] };
    expect(problemsOf(plan(), settings)).toEqual(["本任务的关注类别少了全局的「微信付款」（pay-wechat）：全局的类别一个都不能少，只能在其上增加"]);
  });

  it("全局类别的处置只能更严；本任务新加的类别要写规则和处置", () => {
    const looser = plan({ watchCategories: BUILTIN_CATEGORY_IDS.map((id) => (id === "account_security" ? { id, disposition: "do" as const } : { id })) });
    expect(problemsOf(looser)).toEqual(["关注类别「账户与安全（凭据、权限、全局装软件）」：本任务的处置「直接做只记录」比全局的「先问我」松，只能往严里调"]);
    const added = plan({ watchCategories: [...BUILTIN_CATEGORY_IDS.map((id) => ({ id })), { id: "touch-photos", title: "动照片" }] });
    expect(problemsOf(added)).toEqual(["关注类别 touch-photos 不是全局的：本任务新加的类别要写 match（确定的规则）和 disposition"]);
    const ok = plan({ watchCategories: [...BUILTIN_CATEGORY_IDS.map((id) => ({ id })), { id: "touch-photos", title: "动照片", disposition: "ask_first", match: { paths: ["E:\\photos"] } }] });
    expect(problemsOf(ok)).toEqual([]);
  });

  it.each([
    ["阶段 id 重复", (p: Plan) => ({ ...p, stages: [p.stages[0]!, { ...p.stages[1]!, stageId: "s1", dependsOn: [] }] }), ["阶段 s1 重复"]],
    ["前置阶段不存在", (p: Plan) => ({ ...p, stages: [p.stages[0]!, { ...p.stages[1]!, dependsOn: ["s9"] }] }), ["阶段 s2 的前置阶段 s9 不存在"]],
    [
      "前置阶段成环",
      (p: Plan) => ({ ...p, stages: [{ ...p.stages[0]!, dependsOn: ["s2"] }, p.stages[1]!] }),
      ["阶段的前置关系成了环：s1 → s2 → s1"],
    ],
    ["阶段组不存在", (p: Plan) => ({ ...p, stageGroups: [] }), ["阶段 s2 所属的阶段组 g1 不存在"]],
    ["定步的阶段没写步骤", (p: Plan) => ({ ...p, stages: [p.stages[0]!, { ...p.stages[1]!, steps: undefined }] as Plan["stages"] }), ["阶段 s2 是定步的，要写 steps"]],
    [
      "脚本验收没写脚本",
      (p: Plan) => ({ ...p, stages: [{ ...p.stages[0]!, acceptance: [{ criterion: "能跑", method: "script" as const }] }, p.stages[1]!] }),
      ["阶段 s1 的验收标准「能跑」是脚本方式，要写 script"],
    ],
    [
      "授权项 id 重复",
      (p: Plan) => withGroupPolicy(p, { grants: [{ ...pushGrant }] }),
      ["授权项 push-main 重复"],
    ],
    [
      "授权项的工具没登记",
      (p: Plan) => withStagePolicy(p, 0, { grants: [{ id: "g-x", tool: "teleport", title: "传送", scope: {} }] }),
      ["授权项 g-x：没有 teleport 这个工具"],
    ],
    [
      "授权项的对象范围写了工具没有的参数",
      (p: Plan) => withStagePolicy(p, 0, { grants: [{ id: "g-x", tool: "git_push", title: "推送", scope: { repo: "x" } }] }),
      ["授权项 g-x：git_push 没有参数 repo"],
    ],
    [
      "时序规则校验不过（validateTemporalRules）",
      (p: Plan) => withStagePolicy(p, 0, { temporalRules: [{ id: "bad", trigger: { tool: "teleport" } }] }),
      [expect.stringMatching(/^阶段 s1 的时序规则：规则 bad/)],
    ],
    [
      "时序规则用了 v1 模板保留的 id",
      (p: Plan) => withGroupPolicy(p, { temporalRules: [{ id: "v1.mine", trigger: { tool: "git_push" } }] }),
      [expect.stringMatching(/^阶段组 g1 的时序规则：规则 v1\.mine：v1\.mine 是 v1 模板保留的 id/)],
    ],
    [
      "时序规则 id 在整份计划里重复（阶段和阶段组的策略各一条）",
      (p: Plan) => withGroupPolicy(p, { temporalRules: [{ id: "r-test-before-push", trigger: { tool: "git_push" }, require: { before: { tool: "run_tests" } } }] }),
      ["时序规则 r-test-before-push 重复"],
    ],
  ])("%s", (_name, mutate, expected) => {
    expect(problemsOf(mutate(plan()))).toEqual(expected);
  });
});

describe("确认时勾掉或收窄授权项", () => {
  it("勾掉一项、收窄一项（次数改少、对象范围去掉一个值）：计划里的授权项随之改变", () => {
    const result = narrowPlan(plan(), { removeGrants: ["write-out"], narrowGrants: [{ grantId: "push-main", maxUses: 1, scope: { branch: ["main"] } }] }, tools);
    expect(result).toMatchObject({ ok: true, removed: [{ id: "write-out", tool: "write", title: "写报告", scope: { path: "E:\\work\\out" } }], narrowed: ["push-main"] });
    if (!result.ok) return;
    expect(result.plan.stageGroups[0]!.policy.grants).toEqual([]);
    expect(result.plan.stages[1]!.policy.grants).toEqual([{ ...pushGrant, maxUses: 1, scope: { remote: "origin", branch: ["main"] } }]);
    expect(result).not.toHaveProperty("assumptions");
  });

  it("改假设栏：随计划一起保存，记下改之前和改之后；空的条目去掉，和原来一样的不算改", () => {
    const result = narrowPlan(plan(), { assumptions: ["只看公开资料", "  不写价格 ", ""] }, tools);
    expect(result).toMatchObject({ ok: true, plan: { assumptions: ["只看公开资料", "不写价格"] }, assumptions: { before: ["只看公开资料"], after: ["只看公开资料", "不写价格"] } });
    expect(narrowPlan(plan(), { assumptions: ["只看公开资料"] }, tools)).toEqual({ ok: true, plan: plan(), removed: [], narrowed: [] });
  });

  it("放宽被拒：次数加多、对象范围多出值；不认识的授权项也被拒", () => {
    expect(narrowPlan(plan(), { narrowGrants: [{ grantId: "push-main", maxUses: 5 }] }, tools)).toEqual({ ok: false, problems: ["授权项 push-main：次数从 3 改成了 5"] });
    expect(narrowPlan(plan(), { narrowGrants: [{ grantId: "push-main", scope: { branch: ["release"] } }] }, tools)).toEqual({
      ok: false,
      problems: ["授权项 push-main：对象范围 branch 多了 release"],
    });
    expect(narrowPlan(plan(), { removeGrants: ["nope"] }, tools)).toEqual({ ok: false, problems: ["计划里没有授权项 nope"] });
  });

  it("什么都不改就是原样", () => {
    expect(narrowPlan(plan(), {}, tools)).toEqual({ ok: true, plan: plan(), removed: [], narrowed: [] });
  });
});

describe("确认后的计划交给守卫的样子（13 号票用）", () => {
  it("授权项挂到所属阶段（阶段组的授权项给组里每个阶段各一份），授予时间是确认的时刻，有效期按天；时序规则照原样；关注类别的追加写成设置", () => {
    const confirmedAt = Date.UTC(2026, 9, 8, 1);
    const p = plan({
      watchCategories: [...BUILTIN_CATEGORY_IDS.map((id) => (id === "unknown_write" ? { id, disposition: "never" as const } : { id })), { id: "touch-photos", title: "动照片", disposition: "ask_first", match: { paths: ["E:\\photos"] } }],
    });
    p.stages[1]!.policy.grants = [{ ...pushGrant, validDays: 2 }];
    const guard = toGuardPlan(p, { confirmedAt, settings: NO_SETTINGS });
    expect(guard.grants).toEqual([
      { grantId: "push-main", tool: "git_push", scope: pushGrant.scope, maxUses: 3, stageId: "s2", grantedAt: confirmedAt, expiresAt: confirmedAt + 2 * 86_400_000 },
      { grantId: "write-out@s2", tool: "write", scope: { path: "E:\\work\\out" }, stageId: "s2", grantedAt: confirmedAt },
    ]);
    expect(guard.stages).toEqual([
      { stageId: "s1", temporalRules: [] },
      { stageId: "s2", groupId: "g1", temporalRules: p.stages[1]!.policy.temporalRules },
    ]);
    expect(guard.stageGroups).toEqual([{ groupId: "g1", temporalRules: [] }]);
    expect(guard.watchCategories).toEqual({
      builtin: { unknown_write: { task: "never" } },
      custom: [{ id: "touch-photos", title: "动照片", match: { paths: ["E:\\photos"] }, chat: "ask_first", task: "ask_first" }],
    });
  });
});

describe("每项授权在守卫眼里的样子（计划卡上的授权行和停点由它生成）", () => {
  it("工具的中文名、落在哪些类别、任务里最严的处置：按全局设置和本任务往严里调过的取", () => {
    // git_push 落在"以我的名义对外发送"：任务里默认"计划里列了才做"，本任务调成了"先问我"
    const p = plan({ watchCategories: BUILTIN_CATEGORY_IDS.map((id) => (id === "external_send" ? { id, disposition: "ask_first" as const } : { id })) });
    const info = grantInfoOf(p, { tools, settings: NO_SETTINGS });
    expect(info["push-main"]).toEqual({ toolTitle: "git 推送", categoryTitles: ["以我的名义对外发送或发布"], disposition: "ask_first" });
    expect(info["write-out"]).toEqual({ toolTitle: "写文件", categoryTitles: [], disposition: "do" });
    expect(grantInfoOf(plan(), { tools, settings: NO_SETTINGS })["push-main"]?.disposition).toBe("planned_only");
  });

  it("只按工具名匹配的自定义类别也算；底线工具固定交给我做", () => {
    const settings: WatchCategorySettings = { custom: [{ id: "push-any", title: "推送", match: { tools: ["git_push"] }, chat: "ask_first", task: "hand_over" }] };
    const p = plan({ watchCategories: [...BUILTIN_CATEGORY_IDS.map((id) => ({ id })), { id: "push-any" }] });
    expect(grantInfoOf(p, { tools, settings })["push-main"]).toMatchObject({ categoryTitles: expect.arrayContaining(["推送"]), disposition: "hand_to_me" });
  });
});

describe("全局关注类别", () => {
  it("内置九类加用户自定义的，带任务里的处置", () => {
    const settings: WatchCategorySettings = {
      builtin: { delete_or_overwrite: { task: "ask_first" } },
      custom: [{ id: "pay-wechat", title: "微信付款", match: { tools: ["wechat_pay"] }, chat: "ask_first", task: "hand_over" }],
    };
    const all = globalWatchCategories(settings);
    expect(all.map((c) => c.id)).toEqual([...BUILTIN_CATEGORY_IDS, "pay-wechat"]);
    expect(all.find((c) => c.id === "delete_or_overwrite")).toEqual({ id: "delete_or_overwrite", title: "删除或覆盖（项目档案和工作目录内）", task: "ask_first" });
    expect(all.at(-1)).toEqual({ id: "pay-wechat", title: "微信付款", task: "hand_over" });
  });
});
