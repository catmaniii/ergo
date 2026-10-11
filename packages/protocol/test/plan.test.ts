// 计划的纯函数（12 号票）：授权项列表、卡上由代码生成的授权行和时序规则说明、停点随勾选变化。
import { describe, expect, test } from "vitest";
import {
  type GrantInfo,
  initialStages,
  listStageCodes,
  type Plan,
  type PlanCardPayload,
  planGrants,
  planPolicies,
  planStageCodes,
  planStops,
  grantText,
  policyOwnerLabel,
  stageCodes,
  stageCodeAt,
  stageLayerCount,
  stageNumbers,
  stageStops,
  temporalRuleText,
  withStageCodes,
} from "../src/index.ts";

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

/** 几个阶段和各自的前置 */
const deps = (list: [string, string[]][]) => list.map(([id, after]) => ({ id, after }));

describe("第几阶段、编号（91 号票，照 AgentSense check.ts 的 stageNumbers、idRuleProblems）", () => {

  test("第几阶段是最长那条前置链的长度，同号的是并行的；同一阶段有几个时按计划里的先后加 a、b", () => {
    const stages = deps([
      ["a", []],
      ["b", []],
      ["c", ["a", "b"]],
      ["d", ["c"]],
      ["e", ["c"]],
      ["f", ["a", "e"]],
    ]);
    expect(Object.fromEntries(stageNumbers(stages))).toEqual({ a: 1, b: 1, c: 2, d: 3, e: 3, f: 4 });
    expect(Object.fromEntries(stageCodes(stages))).toEqual({ a: "1a", b: "1b", c: "2", d: "3a", e: "3b", f: "4" });
  });

  test("一份计划的编号：一条直线的和顺序号一样", () => {
    expect(Object.fromEntries(planStageCodes(plan))).toEqual({ s1: "1", s2: "2" });
  });

  test("给了编号，阶段写编号（并行的两个都是第 1 阶段：1a、1b）；不给照旧按计划里的顺序（守护进程现在都不给）", () => {
    const parallel: Plan = { ...plan, stages: [plan.stages[0]!, { ...plan.stages[1]!, dependsOn: [] }] };
    const codes = planStageCodes(parallel);
    const owner = planPolicies(parallel)[1]!.owner;
    expect(policyOwnerLabel(owner)).toBe("第 2 阶段「写报告」");
    expect(policyOwnerLabel(owner, codes)).toBe("第 1b 阶段「写报告」");
    const c = { plan: parallel, grantInfo };
    expect(planStops(c, { removed: new Set(), narrowed: new Set() })[0]!.text).toBe("第 2 阶段「写报告」由你验收");
    expect(planStops(c, { removed: new Set(), narrowed: new Set() }, codes)[0]!.text).toBe("第 1b 阶段「写报告」由你验收");
    expect(stageStops(c, "s2", codes).map((s) => s.text)[0]).toBe("第 1b 阶段「写报告」由你验收");
    expect(stageStops(c, "s1", codes).map((s) => s.text)[0]).toContain("第 1a 阶段「收集资料」：付款（pay）");
  });
});

/** 只要阶段 id 和前置的计划（编号只看这两样；93 号票） */
const shape = (list: [string, string[]][]): Pick<Plan, "stages"> => ({ stages: list.map(([stageId, dependsOn]) => ({ ...plan.stages[0]!, stageId, dependsOn })) });
const codesOf = (p: Pick<Plan, "stages">) => Object.fromEntries(p.stages.map((s) => [s.stageId, s.code]));

describe("编号存进计划（93 号票，照 AgentSense 的里程碑编号：idRuleProblems、prompt.ts 的编号规则）", () => {

  test("第一版：一个阶段号只有一个是阶段号，有几个按计划里的先后加 a、b", () => {
    const first = withStageCodes(shape([["s1", []], ["s2", []], ["s3", ["s1", "s2"]], ["s4", ["s3"]]]));
    expect(codesOf(first)).toEqual({ s1: "1a", s2: "1b", s3: "2", s4: "3" });
  });

  test("计划调整：已有的不改号（前置改了、阶段号变了也不改），新加的按它所在的阶段编", () => {
    const first = withStageCodes(shape([["s1", []], ["s2", ["s1"]], ["s3", ["s2"]]]));
    // s2 改成和新加的 s4 并行（都在 s1 之后）；s3 挪到 s4 之后（阶段号从 3 变成 3，号照旧）；s5 是新的第 4 阶段
    const next = withStageCodes(shape([["s1", []], ["s2", ["s1"]], ["s4", ["s1"]], ["s3", ["s2", "s4"]], ["s5", ["s3"]]]), first);
    expect(codesOf(next)).toEqual({ s1: "1", s2: "2", s4: "2b", s3: "3", s5: "4" });
    // 再调一次：新加两个并行的第 5 阶段
    const third = withStageCodes(shape([["s1", []], ["s2", ["s1"]], ["s4", ["s1"]], ["s3", ["s2", "s4"]], ["s5", ["s3"]], ["s6", ["s5"]], ["s7", ["s5"]]]), next);
    expect(codesOf(third)).toMatchObject({ s6: "5a", s7: "5b" });
  });

  test("已有的阶段号被前置拉到后面：号照旧，新加的不和它撞", () => {
    const first = withStageCodes(shape([["s1", []], ["s2", ["s1"]]]));
    // s2 前面插进新的 s3：s2 变成第 3 阶段、号还是 2；s3 在第 2 阶段，"2"已经有人用了，取 2b
    const next = withStageCodes(shape([["s1", []], ["s3", ["s1"]], ["s2", ["s3"]]]), first);
    expect(codesOf(next)).toEqual({ s1: "1", s3: "2b", s2: "2" });
    expect(stageNumbers(next.stages.map((s) => ({ id: s.stageId, after: s.dependsOn }))).get("s2")).toBe(3);
  });

  test("之前几版用过的号不再给新阶段（去掉的阶段的号）", () => {
    const first = withStageCodes(shape([["s1", []], ["s2", ["s1"]]]));
    const next = withStageCodes(shape([["s1", []], ["s9", ["s1"]]]), first, ["2"]);
    expect(codesOf(next)).toEqual({ s1: "1", s9: "2b" });
  });

  test("之前存下的计划没有编号：它的号按依赖图现算（和界面上之前显示的一样），沿用下去", () => {
    const legacy = shape([["s1", []], ["s2", []], ["s3", ["s1"]]]);
    expect(planStageCodes(legacy)).toEqual(new Map([["s1", "1a"], ["s2", "1b"], ["s3", "2"]]));
    const next = withStageCodes(shape([["s2", []], ["s1", []], ["s3", ["s1"]], ["s4", []]]), legacy);
    expect(codesOf(next)).toEqual({ s2: "1b", s1: "1a", s3: "2", s4: "1c" });
  });

  test("第 X/N 阶段（93 号票评审：守护进程写的和界面状态行共用）：X 是存下的编号，N 是存下的编号里最大的阶段号；去掉中间的阶段之后不会写出\"第 3/2 阶段\"", () => {
    const first = withStageCodes(shape([["s1", []], ["s2", ["s1"]], ["s3", ["s2"]]]));
    expect(codesOf(first)).toEqual({ s1: "1", s2: "2", s3: "3" });
    // 去掉中间的 s2，s3 改成接在 s1 后面：s3 还是 3（不改名），依赖图只有两层
    const cut = withStageCodes(shape([["s1", []], ["s3", ["s1"]]]), first);
    const list = initialStages({ ...plan, stages: cut.stages });
    expect(stageCodeAt(list, "s3")).toEqual({ code: "3", total: 3 });
    expect(stageCodeAt(list, "s1")).toEqual({ code: "1", total: 3 });
    expect(stageCodeAt(list, "s9")).toBeUndefined();
    // 并行的：字母不算进阶段号
    expect(stageCodeAt(initialStages({ ...plan, stages: withStageCodes(shape([["a", []], ["b", []], ["c", ["a", "b"]]])).stages }), "b")).toEqual({ code: "1b", total: 2 });
    // 之前没存编号的：按依赖图现算
    expect(stageCodeAt(initialStages(plan), "s2")).toEqual({ code: "2", total: 2 });
  });

  test("读的地方照存的号：计划、开始执行时带到看板上的阶段列表；一共几个阶段号", () => {
    // 第一版两个并行（s2 在前：1a，s1：1b），调整后 s2 排到 s1 之后——号照旧，不按现在的依赖图重算成 1、2
    const stored = withStageCodes(shape([["s1", []], ["s2", ["s1"]]]), withStageCodes(shape([["s2", []], ["s1", []]])));
    expect(planStageCodes(stored)).toEqual(new Map([["s1", "1b"], ["s2", "1a"]]));
    const list = initialStages({ ...plan, stages: stored.stages });
    expect(list.map((s) => s.code)).toEqual(["1b", "1a"]);
    expect(listStageCodes(list)).toEqual(new Map([["s1", "1b"], ["s2", "1a"]]));
    // 一共几个阶段号照存下的编号（93 号票评审）：两个都还是第 1 阶段的号，不按现在的依赖图算成 2
    expect(stageLayerCount(list)).toBe(1);
    // 没存编号的阶段列表照旧现算
    expect(listStageCodes(initialStages(plan))).toEqual(new Map([["s1", "1"], ["s2", "2"]]));
    expect(stageCodes([{ id: "a", after: [], code: "7c" }, { id: "b", after: [] }])).toEqual(new Map([["a", "7c"], ["b", "1b"]]));
  });
});
