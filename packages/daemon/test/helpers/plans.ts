// 主切面里维护者提交的计划：一份字段齐全、能通过检查的计划（全局九类关注类别都在），以及按它写的 faux 剧本步骤。
import type { Plan } from "@ergou/protocol";
import { BUILTIN_CATEGORY_IDS } from "../../src/guard/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";

/** 字段齐全的计划：两个阶段（s2 在 s1 之后、属于阶段组 g1），每个都有授权项 */
export function samplePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    stages: [
      {
        stageId: "s1",
        title: "收集资料",
        deliverables: ["资料清单"],
        acceptance: [{ criterion: "清单里至少有五个来源", method: "review" }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [{ id: "fetch-docs", tool: "network_read", title: "读公开网页", scope: {}, maxUses: 20 }], temporalRules: [] },
        budget: { tokens: 200_000, toolCalls: 60 },
      },
      {
        stageId: "s2",
        title: "写调研报告",
        deliverables: ["调研报告 report.md"],
        acceptance: [
          { criterion: "报告文件存在", method: "script", script: "test -f report.md" },
          { criterion: "结论你认可", method: "user" },
        ],
        mode: "steps",
        steps: ["列大纲", "写正文", "自查"],
        dependsOn: ["s1"],
        policy: {
          grants: [{ id: "push-report", tool: "git_push", title: "把报告推送到 origin 的 main", scope: { remote: "origin", branch: ["main", "report"] }, maxUses: 2 }],
          temporalRules: [{ id: "tests-before-push", title: "推送前先跑测试", trigger: { tool: "git_push" }, require: { before: { tool: "run_tests" } }, on_violation: "pull_back" }],
        },
        budget: { tokens: 120_000, toolCalls: 40 },
        groupId: "g1",
      },
    ],
    stageGroups: [{ groupId: "g1", title: "成文", policy: { grants: [], temporalRules: [] } }],
    toolkit: { skills: [], mcp: [], bash: true, network: true },
    projects: [],
    memoryScope: "（第一阶段不授予）",
    watchCategories: BUILTIN_CATEGORY_IDS.map((id) => ({ id })),
    assumptions: ["只用公开资料"],
    stops: { count: 1, where: ["写报告前给你看大纲"] },
    tokenEstimate: 320_000,
    ...overrides,
  };
}

/** 维护者调用"提交计划"的一步 */
export function submitPlanStep(plan: Plan = samplePlan()): FauxStep {
  return { kind: "reply", toolCalls: [{ name: "submit_plan", arguments: plan as never }] };
}
