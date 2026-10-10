// 计划的纯函数（12 号票）：授权项列表、卡上由代码生成的授权行和时序规则说明、停点随勾选变化。
import { describe, expect, test } from "vitest";
import { type GrantInfo, type Plan, type PlanCardPayload, planGrants, planPolicies, planStops, grantText, policyOwnerLabel, temporalRuleText } from "../src/index.ts";

const policy = (grants: Plan["stages"][number]["policy"]["grants"], temporalRules: Plan["stages"][number]["policy"]["temporalRules"] = []) => ({ grants, temporalRules });

const plan: Plan = {
  stages: [
    {
      stageId: "s1",
      title: "收集资料",
      deliverables: ["清单"],
      acceptance: [{ criterion: "有五个来源", method: "review" }],
      mode: "open",
      dependsOn: [],
      policy: policy([
        { id: "fetch", tool: "web_fetch", title: "读公开网页", scope: {}, maxUses: 20 },
        { id: "pay", tool: "pay", title: "买资料", scope: { amount: "30" }, maxUses: 1 },
      ]),
      budget: { tokens: 1000, toolCalls: 10 },
    },
    {
      stageId: "s2",
      title: "写报告",
      deliverables: ["report.md"],
      acceptance: [{ criterion: "你认可", method: "user" }],
      mode: "open",
      dependsOn: ["s1"],
      policy: policy(
        [{ id: "push", tool: "git_push", title: "推送报告", scope: { remote: "origin", branch: ["main", "report"] }, maxUses: 2 }],
        [{ id: "tests-before-push", title: "推送前先跑测试", trigger: { tool: "git_push" }, require: { before: { tool: "run_tests" } }, on_violation: "pull_back" }],
      ),
      budget: { tokens: 1000, toolCalls: 10 },
      groupId: "g1",
    },
  ],
  stageGroups: [{ groupId: "g1", title: "成文", policy: policy([{ id: "write", tool: "write", title: "写工作目录", scope: { path: "out" }, validDays: 3 }]) }],
  toolkit: { skills: [], mcp: [], bash: true, network: true },
  projects: [],
  watchCategories: [{ id: "spend_money" }],
  assumptions: [],
  stops: { count: 0, where: [] },
  tokenEstimate: 2000,
};

const grantInfo: Record<string, GrantInfo> = {
  fetch: { toolTitle: "读网页", categoryTitles: [], disposition: "do" },
  pay: { toolTitle: "付款", categoryTitles: ["花钱"], disposition: "hand_to_me" },
  push: { toolTitle: "推送", categoryTitles: ["以我的名义对外发送或发布"], disposition: "planned_only" },
  write: { toolTitle: "写文件", categoryTitles: [], disposition: "do" },
};
const card: Pick<PlanCardPayload, "plan" | "grantInfo"> = { plan, grantInfo };

describe("授权项和生成的文字", () => {
  test("全部授权项：各阶段的在前（按阶段顺序），阶段组的在后", () => {
    expect(planGrants(plan).map(({ grant, owner }) => [grant.id, owner.kind])).toEqual([
      ["fetch", "stage"],
      ["pay", "stage"],
      ["push", "stage"],
      ["write", "group"],
    ]);
  });

  test("授权行的主文由工具、类别、对象范围、次数、有效期生成，不用维护者写的标题", () => {
    expect(grantText(plan.stages[1]!.policy.grants[0]!, grantInfo.push)).toBe("推送（git_push） · 以我的名义对外发送或发布：remote 是 origin，branch 是 main 或 report；最多 2 次；7 天内有效");
    expect(grantText(plan.stageGroups[0]!.policy.grants[0]!, grantInfo.write)).toBe("写文件（write）：path 是 out；不限次数；3 天内有效");
    expect(grantText(plan.stages[0]!.policy.grants[0]!, undefined)).toBe("web_fetch：不限对象；最多 20 次；7 天内有效");
    // 58 号票：流程里通用 bash 的步骤推出的授权项只限那条命令
    expect(grantText({ id: "g-s1", tool: "git_push", title: "s1「推送」", scope: { remote: "origin", branch: "main" }, maxUses: 1, command: "git push origin main" }, undefined)).toBe(
      "git_push：remote 是 origin，branch 是 main；只限命令「git push origin main」；最多 1 次；7 天内有效",
    );
    // 非 bash 的步骤：只认写了的参数，路径按真实路径比
    expect(grantText({ id: "g-s1", tool: "git_commit", title: "s1「提交」", scope: { repoPath: "E:\\work\\sub", message: "x" }, realScope: { repoPath: "E:\\elsewhere\\repo" }, maxUses: 1, exactArgs: true }, undefined)).toBe(
      "git_commit：repoPath 是 E:\\work\\sub，message 是 x；不能多带别的参数；路径按真实路径比（repoPath 是 E:\\elsewhere\\repo）；最多 1 次；7 天内有效",
    );
  });

  test("定时触发的任务每次运行的授权（19 号票的定时作业，76 号票迁移成定时触发的普通任务）：主文里次数按每次运行算、没有天数（任务在运营就一直有效）", () => {
    const daily = { id: "send-daily", tool: "http_request", title: "把日报发到 hook", scope: { url: "http://127.0.0.1/daily" }, maxUses: 1, validDays: 3 };
    expect(grantText(daily, undefined, "job")).toBe("http_request：url 是 http://127.0.0.1/daily；每次运行最多 1 次；任务在运营就一直有效，暂停、取消即收回");
    // 76 号票起计划里没有定时作业：策略只有阶段的和阶段组的
    expect(planPolicies(plan).map((p) => p.owner.kind)).toEqual(["stage", "stage", "group"]);
    expect(policyOwnerLabel(planPolicies(plan)[2]!.owner)).toBe("阶段组「成文」的各阶段");
  });

  test("时序规则按结构生成说明：四种形态和违反时怎么办", () => {
    expect(temporalRuleText({ id: "a", trigger: { tool: "git_push" }, require: { before: { tool: "run_tests" } }, on_violation: "pull_back" })).toBe("git_push 之前必须已经成功做过 run_tests；违反时退回，先补上再做");
    expect(temporalRuleText({ id: "b", trigger: { tool: ["send_email", "web_post"] }, require: { not_before: { tool: "read" } } })).toBe("做过 read 之后不能再做 send_email、web_post；违反时先问你");
    expect(temporalRuleText({ id: "c", trigger: { tool: "delete" }, require: { check: "$current.backedUp" }, when: "x" })).toBe("做 delete 时当下的条件必须满足（只在满足条件时检查）；违反时先问你");
    expect(temporalRuleText({ id: "d", trigger: { tool: "git_push" }, on_violation: "block" })).toBe("git_push 一律禁止；违反就不做");
  });
});

describe("停点（授权后还会在几处停下来）", () => {
  test("什么都没勾掉：由你验收的阶段，和落在“交给我做”类别里、列进计划也不算授权的那一项", () => {
    expect(planStops(card, { removed: new Set(), narrowed: new Set() }).map((s) => s.kind)).toEqual(["user_acceptance", "still_asks"]);
    expect(planStops(card, { removed: new Set(), narrowed: new Set() })[1]!.text).toContain("（落在「交给我做」类别里，交给你做）");
  });

  test("勾掉一项、收窄一项：多两处停点，随勾选变化", () => {
    const stops = planStops(card, { removed: new Set(["fetch"]), narrowed: new Set(["push"]) });
    expect(stops.map((s) => s.kind)).toEqual(["user_acceptance", "unchecked", "still_asks", "narrowed"]);
    expect(stops[1]!.text).toBe("第 1 阶段「收集资料」：读网页（web_fetch）：不限对象；最多 20 次；7 天内有效（勾掉了，执行到那一步再问你）");
    expect(stops[3]!.text).toContain("第 2 阶段「写报告」：推送（git_push）");
  });

  test("处理过的卡：按记下的确认结果算（勾掉的已经不在计划里）", () => {
    const removedFetch = plan.stages[0]!.policy.grants[0]!;
    const confirmed: Pick<PlanCardPayload, "plan" | "grantInfo" | "removedGrants" | "narrowedGrants"> = {
      plan: { ...plan, stages: [{ ...plan.stages[0]!, policy: policy([plan.stages[0]!.policy.grants[1]!]) }, plan.stages[1]!] },
      grantInfo,
      removedGrants: [removedFetch],
      narrowedGrants: ["push"],
    };
    expect(planStops(confirmed).map((s) => s.kind)).toEqual(["user_acceptance", "still_asks", "narrowed", "unchecked"]);
  });
});
