// 计划变更和自行调整（14 号票）：相对当前计划新增或改动了什么、哪些扩大授权或改了目标和验收（要用户在计划变更卡上确认）、
// 停下哪些阶段、改了之后授权项的有效期和各阶段的执行状态。纯函数，表格驱动。
import { type Plan, type PlanChangeItem, type PlanGrant, planChangeItemText, sameToolkit, type TaskStage, withStageCodes } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { BUILTIN_CATEGORY_IDS, BUILTIN_TOOL_REGISTRY } from "../../src/guard/index.ts";
import { affectedStages, diffPlan, expanding, grantTimesAfter, initialGrantTimes, mergeDraft, stagesAfter, touchedAcceptedStages } from "../../src/tasks/plan-change.ts";

const tools = BUILTIN_TOOL_REGISTRY;
const DAY = 86_400_000;
const push: PlanGrant = { id: "push", tool: "git_push", title: "推送到 origin", scope: { remote: "origin" }, maxUses: 2 };
const dir: PlanGrant = { id: "dir", tool: "make_dir", title: "建 out 目录", scope: { path: "E:\\out" } };

/** 三个阶段：s1 → s2 → s3；s2 有推送的授权和一条时序规则，s3 在阶段组 g1（组里没有授权项） */
function base(): Plan {
  return {
    stages: [
      {
        stageId: "s1",
        title: "收集",
        deliverables: ["清单"],
        acceptance: [{ criterion: "清单存在", method: "script", script: "test -f a.md" }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [dir], temporalRules: [] },
        budget: { tokens: 1000, toolCalls: 10 },
      },
      {
        stageId: "s2",
        title: "写报告",
        deliverables: ["报告", "附录"],
        acceptance: [
          { criterion: "报告完整", method: "review" },
          { criterion: "附录有来源", method: "review" },
        ],
        mode: "open",
        dependsOn: ["s1"],
        policy: { grants: [push], temporalRules: [{ id: "tests", trigger: { tool: "git_push" }, require: { before: { tool: "run_tests" } }, on_violation: "pull_back" }] },
        budget: { tokens: 2000, toolCalls: 20 },
      },
      { stageId: "s3", title: "收尾", deliverables: ["总结"], acceptance: [{ criterion: "你认可", method: "user" }], mode: "open", dependsOn: ["s2"], policy: { grants: [], temporalRules: [] }, budget: { tokens: 500, toolCalls: 5 }, groupId: "g1" },
    ],
    stageGroups: [
      { groupId: "g1", title: "收尾组", policy: { grants: [], temporalRules: [] } },
      { groupId: "g2", title: "发布组", policy: { grants: [{ id: "repo", tool: "create_remote_repo", title: "建远端仓库", scope: {} }], temporalRules: [] } },
    ],
    toolkit: { skills: [], mcp: [], bash: false, network: true },
    projects: [],
    watchCategories: BUILTIN_CATEGORY_IDS.map((id) => ({ id })),
    assumptions: [],
    stops: { count: 0, where: [] },
    tokenEstimate: 3500,
  };
}

/** 改一下计划（深拷贝后交给 edit 改） */
function edited(edit: (p: Plan) => void): Plan {
  const p = structuredClone(base());
  edit(p);
  return p;
}

const kinds = (items: readonly PlanChangeItem[]) => items.map((i) => [i.kind, i.expands]);
const diff = (after: Plan, goal?: { before: string; after: string }) => diffPlan({ before: base(), after, tools, ...(goal ? { goal } : {}) });
/** 计划不变，只改任务书里的验收标准 */
const criteriaDiff = (before: string[], after: string[]) => diffPlan({ before: base(), after: base(), tools, criteria: { before, after } });

describe("不扩大授权的调整（维护者自行调整计划，记进时间线）", () => {
  it("原样：没有改动", () => {
    expect(diff(base())).toEqual([]);
  });

  it("拆阶段：s2 拆出 s2b（验收标准、交付件、预算从 s2 挪过去，s2 的授权项和规则留着）——不扩大", () => {
    const after = edited((p) => {
      const s2 = p.stages[1]!;
      s2.acceptance = [s2.acceptance[0]!];
      s2.deliverables = ["报告"];
      s2.budget = { tokens: 1200, toolCalls: 12 };
      p.stages.splice(2, 0, {
        stageId: "s2b",
        title: "写附录",
        deliverables: ["附录"],
        acceptance: [{ criterion: "附录有来源", method: "review" }],
        mode: "open",
        dependsOn: ["s2"],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 800, toolCalls: 8 },
      });
      p.stages[3]!.dependsOn = ["s2b"];
    });
    const items = diff(after);
    expect(expanding(items)).toEqual([]);
    expect(kinds(items)).toEqual([
      ["budget", false],
      ["stage_added", false],
      ["stage_changed", false],
    ]);
    expect(items.map((i) => planChangeItemText(i))).toContain("加了阶段 s2b「写附录」");
  });

  it("调顺序、改步骤和名字：不扩大", () => {
    const after = edited((p) => {
      p.stages[0]!.title = "收集资料";
      p.stages[0]!.mode = "steps";
      p.stages[0]!.steps = ["找", "记"];
    });
    expect(kinds(diff(after))).toEqual([["stage_changed", false]]);
    const reordered = edited((p) => {
      p.stages[1]!.dependsOn = [];
      p.stages[0]!.dependsOn = ["s2"];
      p.stages.reverse();
    });
    expect(expanding(diff(reordered))).toEqual([]);
    expect(diff(reordered).some((i) => i.kind === "stage_order")).toBe(true);
  });

  it("收窄、去掉授权项，关掉能力，加时序规则：不扩大", () => {
    const after = edited((p) => {
      p.stages[1]!.policy.grants = [{ ...push, maxUses: 1 }];
      p.stages[0]!.policy.grants = [];
      p.toolkit.network = false;
      p.stages[0]!.policy.temporalRules = [{ id: "no-net", trigger: { tool: "http_request" } }];
    });
    expect(kinds(diff(after))).toEqual([
      ["grant_narrowed", false],
      ["grant_removed", false],
      ["toolkit", false],
      ["rules", false],
    ]);
  });

  it("加 skill（27 号票）：skill 只是说明书、不增加权限，维护者自己增减，不算扩大；卡上写加了哪个", () => {
    const [item] = diff(edited((p) => p.toolkit.skills.push("notes-style")));
    expect([item?.kind, item?.expands]).toEqual(["toolkit", false]);
    expect(planChangeItemText(item!)).toBe("工具包变更：加上 skill notes-style（原来 bash 关、联网开；skill：无；MCP：无）");
  });
});

/** 计划里的项目行换成这几行 */
const withLines = (projects: Plan["projects"]) => edited((p) => (p.projects = projects));
const diffLines = (before: Plan["projects"], after: Plan["projects"]) => diffPlan({ before: withLines(before), after: withLines(after), tools });

describe("涉及多个项目的计划逐行写所属阶段（17 号票）", () => {
  const A1 = { project: "记账本", changes: ["加导出"], stageId: "s1", acceptance: ["有 export.md"] };
  const B1 = { project: "家电档案", changes: ["加导入"], stageId: "s1", acceptance: ["有 import.md"] };
  const A2 = { project: "记账本", changes: ["写版本号"], stageId: "s2", acceptance: ["有版本号"] };

  it("去掉一行（计划里只剩一个项目也一样）不算扩大，可以自行调整", () => {
    expect(kinds(diffLines([A1, B1, A2], [A1, A2]))).toEqual([["projects", false]]);
  });

  it("同一个项目在另一个阶段多一行、或者把一行挪到别的阶段，算加项目", () => {
    expect(kinds(diffLines([A1, B1], [A1, B1, A2]))).toEqual([["projects", true]]);
    expect(kinds(diffLines([A1, B1], [A1, { ...B1, stageId: "s2" }]))).toEqual([["projects", true]]);
  });
});

describe("扩大授权、改目标和验收（要用户确认计划变更卡）", () => {
  const CASES: [string, (p: Plan) => void, string][] = [
    ["新增授权项", (p) => p.stages[2]!.policy.grants.push({ id: "push2", tool: "git_push", title: "推送 release", scope: { remote: "origin" } }), "grant_added"],
    ["放宽次数", (p) => (p.stages[1]!.policy.grants[0]!.maxUses = 5), "grant_widened"],
    ["去掉次数上限", (p) => delete p.stages[1]!.policy.grants[0]!.maxUses, "grant_widened"],
    ["放宽对象范围", (p) => (p.stages[1]!.policy.grants[0]!.scope = { remote: ["origin", "upstream"] }), "grant_widened"],
    ["延长有效期", (p) => (p.stages[1]!.policy.grants[0]!.validDays = 30), "grant_widened"],
    ["授权项换到别的阶段", (p) => p.stages[2]!.policy.grants.push(p.stages[1]!.policy.grants.pop()!), "grant_moved"],
    ["加工具包能力（开 bash）", (p) => (p.toolkit.bash = true), "toolkit"],
    ["加 MCP", (p) => p.toolkit.mcp.push("demo-mcp"), "toolkit"],
    ["加项目", (p) => p.projects.push({ project: "记账本", changes: ["加导出"] }), "projects"],
    ["改验收标准", (p) => (p.stages[1]!.acceptance[0]!.criterion = "报告完整、有对比"), "acceptance"],
    ["改交付件", (p) => p.stages[2]!.deliverables.push("演示视频"), "deliverables"],
    ["加预算", (p) => (p.stages[1]!.budget.tokens = 5000), "budget"],
    ["删掉时序规则", (p) => (p.stages[1]!.policy.temporalRules = []), "rules"],
    ["阶段换进有授权项的阶段组", (p) => (p.stages[2]!.groupId = "g2"), "stage_grants"],
  ];
  it.each(CASES)("%s", (_name, edit, kind) => {
    const items = diff(edited(edit));
    expect(expanding(items).map((i) => i.kind)).toContain(kind);
  });

  it("改目标：写了新目标、和任务书里的不一样才算", () => {
    expect(kinds(diff(base(), { before: "整理调研", after: "整理调研并发布" }))).toEqual([["goal", true]]);
    expect(diff(base(), { before: "整理调研", after: "整理调研" })).toEqual([]);
  });

  it("改任务书里的验收标准：写了新的、和任务书里的不一样才算（空白的去掉）；卡上写原来和改成", () => {
    const [item] = criteriaDiff(["附来源"], ["附来源", " 有对比表 ", ""]);
    expect(item).toEqual({ kind: "criteria", expands: true, before: ["附来源"], after: ["附来源", "有对比表"] });
    expect(planChangeItemText(item!)).toBe("改任务的验收标准：原来「附来源」，改成「附来源；有对比表」");
    expect(criteriaDiff(["附来源"], [" 附来源"])).toEqual([]);
    expect(criteriaDiff(["附来源"], ["", " "])).toEqual([]);
  });

  it("工具包一样不一样只看开关和 skill、MCP 的集合（不看先后）；守护进程装配时的工具包没有 skill、MCP，当空", () => {
    const toolkit = base().toolkit;
    expect(sameToolkit({ ...toolkit, mcp: ["a", "b"] }, { ...toolkit, mcp: ["b", "a"] })).toBe(true);
    expect(sameToolkit({ ...toolkit, mcp: ["a"] }, { ...toolkit, mcp: ["a", "a"] })).toBe(false);
    expect(sameToolkit({ bash: true, network: false }, { bash: true, network: false })).toBe(true);
    expect(sameToolkit({ bash: true, network: false }, { bash: false, network: false })).toBe(false);
  });

  it("卡上的说法由结构化数据生成", () => {
    const [added] = diff(edited((p) => p.stages[2]!.policy.grants.push({ id: "push2", tool: "git_push", title: "推送 release", scope: { remote: "origin" } })));
    expect(planChangeItemText(added!, { push2: { toolTitle: "git 推送", categoryTitles: ["以我的名义对外发送或发布"], disposition: "do" } })).toBe(
      "新增授权（阶段 s3「收尾」）：git 推送（git_push） · 以我的名义对外发送或发布：remote 是 origin；不限次数；7 天内有效",
    );
    const [toolkit] = diff(edited((p) => (p.toolkit.bash = true)));
    expect(planChangeItemText(toolkit!)).toBe("工具包变更：加上 bash（原来 bash 关、联网开；skill：无；MCP：无）");
  });
});

/** 按 base() 建好的各阶段（指定的几个换成给定的状态） */
const list = (states: Partial<Record<string, TaskStage["state"]>> = {}): TaskStage[] =>
  base().stages.map((s) => ({ stageId: s.stageId, title: s.title, state: states[s.stageId] ?? "pending", dependsOn: s.dependsOn, acceptance: [], attempts: 0 }));

describe("停下哪些阶段", () => {

  it("改动落在哪个阶段就停哪个（授权项、验收、预算、规则）", () => {
    const after = edited((p) => {
      p.stages[2]!.policy.grants.push({ id: "push2", tool: "git_push", title: "推送 release", scope: { remote: "origin" } });
      p.stages[1]!.acceptance[0]!.criterion = "报告完整、有对比";
    });
    expect(affectedStages(diff(after), after, list({ s1: "running" }), [], "s1")).toEqual(["s2", "s3"]);
  });

  it("阶段组的授权项：组里各阶段都停", () => {
    const after = edited((p) => (p.stageGroups[0]!.policy.grants = [{ id: "g-push", tool: "git_push", title: "推送", scope: {} }]));
    expect(affectedStages(diff(after), after, list(), [], "s1")).toEqual(["s3"]);
  });

  it("不落在具体阶段上的（工具包、项目、目标）：停维护者点名的，没点名就停手头在做的", () => {
    const after = edited((p) => (p.toolkit.bash = true));
    expect(affectedStages(diff(after), after, list({ s1: "accepted", s2: "running" }), [], "s2")).toEqual(["s2"]);
    expect(affectedStages(diff(after), after, list({ s1: "accepted", s2: "running" }), ["s3"], "s2")).toEqual(["s3"]);
  });

  it("已验收的阶段不停；改动碰到已验收的阶段要被拒（让用户返工）", () => {
    const after = edited((p) => (p.stages[0]!.acceptance[0]!.criterion = "清单有十条"));
    expect(affectedStages(diff(after), after, list({ s1: "accepted" }), [], "s2")).toEqual(["s2"]);
    expect(touchedAcceptedStages(base(), after, list({ s1: "accepted" }))).toEqual(["s1"]);
    expect(touchedAcceptedStages(base(), edited((p) => (p.stages[1]!.title = "改名")), list({ s1: "accepted" }))).toEqual([]);
  });

  it("编号不算改动（93 号票）：现在生效的那份有编号、维护者交来的没有，已验收的阶段不算碰过", () => {
    const coded = withStageCodes(base());
    expect(coded.stages[0]!.code).toBe("1");
    expect(touchedAcceptedStages(coded, base(), list({ s1: "accepted" }))).toEqual([]);
  });
});

describe("改了之后", () => {
  it("维护者交的计划合上当前计划沿用的关注类别、用户的限制、定时作业、记忆范围", () => {
    const current = { ...base(), memoryScope: "（不授予）", userLimits: [{ id: "l1", quote: "别推到 main", temporalRules: [], grantNarrowings: [{ grantId: "push", maxUses: 1 }] }] };
    const { watchCategories: _w, userLimits: _u, memoryScope: _m, ...draft } = base();
    expect(mergeDraft(current, draft)).toEqual(current);
  });

  it("授权项的有效期：原样和收窄的照旧，放宽的次数接着算、有效期从这次确认重新算，新加的从这次确认起算", () => {
    const confirmedAt = 1_000 * DAY;
    const before = base();
    const times = initialGrantTimes(before, confirmedAt);
    expect(times.push).toEqual({ grantedAt: confirmedAt, expiresAt: confirmedAt + 7 * DAY });
    expect(times["repo@s3"]).toBeUndefined();
    const at = confirmedAt + 3 * DAY;
    const after = edited((p) => {
      p.stages[1]!.policy.grants[0]!.maxUses = 5;
      p.stages[2]!.policy.grants.push({ id: "new", tool: "git_push", title: "推送", scope: {}, validDays: 2 });
    });
    const next = grantTimesAfter({ before, beforeTimes: times, beforeConfirmedAt: confirmedAt, after, at, tools });
    expect(next.dir).toEqual(times.dir);
    expect(next.push).toEqual({ grantedAt: confirmedAt, expiresAt: at + 7 * DAY });
    expect(next.new).toEqual({ grantedAt: at, expiresAt: at + 2 * DAY });
  });

  it("各阶段的执行状态：原有的留着（验收标准没变的连结果一起留），新加的未开始，去掉的不要了", () => {
    const running: TaskStage[] = [
      { stageId: "s1", title: "收集", state: "accepted", dependsOn: [], acceptance: [{ criterion: "清单存在", method: "script", result: { passed: true, at: "t" } }], attempts: 1 },
      { stageId: "s2", title: "写报告", state: "running", dependsOn: ["s1"], acceptance: [], attempts: 0, pullBacks: 2 },
      { stageId: "s3", title: "收尾", state: "pending", dependsOn: ["s2"], acceptance: [], attempts: 0 },
    ];
    const after = edited((p) => {
      p.stages.splice(2, 1, { ...p.stages[2]!, stageId: "s4", title: "发布" });
    });
    expect(stagesAfter(running, after)).toEqual([
      running[0],
      { ...running[1], acceptance: [{ criterion: "报告完整", method: "review" }, { criterion: "附录有来源", method: "review" }] },
      { stageId: "s4", title: "发布", state: "pending", dependsOn: ["s2"], acceptance: [{ criterion: "你认可", method: "user" }], attempts: 0 },
    ]);
  });

  it("各阶段的编号照计划里存的（93 号票）：已有的阶段沿用，新加的是调整时给的号", () => {
    const running: TaskStage[] = [
      { stageId: "s1", title: "收集", state: "accepted", dependsOn: [], acceptance: [], attempts: 1, code: "1" },
      { stageId: "s2", title: "写报告", state: "running", dependsOn: ["s1"], acceptance: [], attempts: 0, code: "2" },
      { stageId: "s3", title: "收尾", state: "pending", dependsOn: ["s2"], acceptance: [], attempts: 0, code: "3" },
    ];
    const before = withStageCodes(base());
    // 新加一个和 s2 并行的 s4
    const after = withStageCodes(
      edited((p) => {
        p.stages.push({ ...p.stages[1]!, stageId: "s4", title: "附录" });
      }),
      before,
    );
    expect(stagesAfter(running, after).map((s) => [s.stageId, s.code])).toEqual([
      ["s1", "1"],
      ["s2", "2"],
      ["s3", "3"],
      ["s4", "2b"],
    ]);
  });
});
