// 前端状态层：计划卡上的勾选（12 号票）。勾掉、收窄授权项、改假设栏变成"确认"的输入，
// 守护进程拿它改存储里的计划（主切面 tasks.test.ts 里验证）；停点随勾选变化（协议包的 planStops，这里接上勾选验一遍）。
import { describe, expect, test } from "vitest";
import { type GrantInfo, narrowedGrantIds, type Plan, planConfirmInput, planStops } from "../../src/state/index.ts";

const plan: Plan = {
  stages: [
    {
      stageId: "s1",
      title: "收集资料",
      deliverables: ["清单"],
      acceptance: [{ criterion: "有五个来源", method: "review" }],
      mode: "open",
      dependsOn: [],
      policy: { grants: [{ id: "fetch", tool: "network_read", title: "读公开网页", scope: {}, maxUses: 20 }], temporalRules: [] },
      budget: { tokens: 1000, toolCalls: 10 },
    },
    {
      stageId: "s2",
      title: "写报告",
      deliverables: ["report.md"],
      acceptance: [{ criterion: "你认可", method: "user" }],
      mode: "open",
      dependsOn: ["s1"],
      policy: { grants: [{ id: "push", tool: "git_push", title: "推送报告", scope: { remote: "origin", branch: ["main", "report"] }, maxUses: 2 }], temporalRules: [] },
      budget: { tokens: 1000, toolCalls: 10 },
      groupId: "g1",
    },
  ],
  stageGroups: [{ groupId: "g1", title: "成文", policy: { grants: [{ id: "write", tool: "write", title: "写工作目录", scope: { path: "out" } }], temporalRules: [] } }],
  toolkit: { skills: [], mcp: [], bash: true, network: true },
  projects: [],
  watchCategories: [{ id: "spend_money" }],
  assumptions: ["只用公开资料"],
  stops: { count: 0, where: [] },
  tokenEstimate: 2000,
};
const nothing = { removed: new Set<string>(), drafts: {} };

describe("计划卡上的勾选变成确认的输入", () => {
  test("什么都没动：原样确认", () => {
    expect(planConfirmInput(plan, nothing)).toEqual({});
  });

  test("勾掉一行、收窄一行（次数改少、分支只留 main）", () => {
    const choice = { removed: new Set(["fetch"]), drafts: { push: { maxUses: 1, scope: { branch: ["main"] } } } };
    expect(planConfirmInput(plan, choice)).toEqual({ removeGrants: ["fetch"], narrowGrants: [{ grantId: "push", maxUses: 1, scope: { branch: ["main"] } }] });
    expect(narrowedGrantIds(plan, choice)).toEqual(new Set(["push"]));
  });

  test("勾掉的那行不再算收窄；和原来一样的次数、留下全部值的范围不算收窄；不限次数的加上次数也是收窄", () => {
    expect(planConfirmInput(plan, { removed: new Set(["push"]), drafts: { push: { maxUses: 1, scope: {} } } })).toEqual({ removeGrants: ["push"] });
    expect(planConfirmInput(plan, { removed: new Set(), drafts: { push: { maxUses: 2, scope: { branch: ["main", "report"] } } } })).toEqual({});
    expect(planConfirmInput(plan, { removed: new Set(), drafts: { write: { maxUses: 3, scope: {} } } })).toEqual({ narrowGrants: [{ grantId: "write", maxUses: 3 }] });
  });

  test("改了假设栏：整栏随确认交出（空的条目去掉）；改回原样就不算改", () => {
    expect(planConfirmInput(plan, { ...nothing, assumptions: ["只用公开资料", " 报告用中文 ", ""] })).toEqual({ assumptions: ["只用公开资料", "报告用中文"] });
    expect(planConfirmInput(plan, { ...nothing, assumptions: ["只用公开资料"] })).toEqual({});
  });
});

describe("停点随勾选变化", () => {
  const grantInfo: Record<string, GrantInfo> = {
    fetch: { toolTitle: "只读的联网命令", categoryTitles: [], disposition: "do" },
    push: { toolTitle: "git 推送", categoryTitles: ["以我的名义对外发送或发布"], disposition: "ask_first" },
    write: { toolTitle: "写文件", categoryTitles: [], disposition: "do" },
  };

  test("落在“先问我”类别里的那一项不算授权，始终是停点；勾掉、收窄各多一处", () => {
    const card = { plan, grantInfo };
    expect(planStops(card, { removed: new Set(), narrowed: new Set() }).map((s) => s.kind)).toEqual(["user_acceptance", "still_asks"]);
    const choice = { removed: new Set(["fetch"]), drafts: { write: { maxUses: 1, scope: {} } } };
    expect(planStops(card, { removed: choice.removed, narrowed: narrowedGrantIds(plan, choice) }).map((s) => s.kind)).toEqual(["user_acceptance", "unchecked", "still_asks", "narrowed"]);
  });
});
