// 91 号票：长程任务的计划栏照 AgentSense 最新版（bedf5a5）画成依赖图——第几阶段是最长那条前置链的长度（同号的就是并行的），
// 同一阶段有几个时按计划里的先后编 4a、4b；自上而下分层、同层并排、曲线连线；节点大小按栏的宽高算；
// 有等你确认的计划（计划卡、计划变更卡）就画它（新加的标"新"、改过的标"改"、去掉的也画上），否则画现在生效的那份
// （被计划变更去掉的阶段也留在图上）。
// 回放：task-plan-change（两个阶段都没有前置——并行；计划变更等你确认、被拒绝、维护者自行调整了顺序）、task-execution（一条直线）；
// 录不出来的按共享协议的 schema 构造：计划变更加一个阶段、去掉一个阶段，确认前和确认后。
import fs from "node:fs";
import path from "node:path";
import { CardEventPayload as CardEventPayloadSchema, schemaChecker, TaskEventPayload as TaskEventPayloadSchema, TaskPlanEventPayload as TaskPlanEventPayloadSchema } from "@ergou/protocol";
import { describe, expect, test } from "vitest";
import {
  type Card,
  changeStageGraph,
  chatItems,
  fillNodeSize,
  graphGeometry,
  graphRows,
  type PlanChangeCardPayload,
  railColumns,
  replay,
  detailContent,
  shownStage,
  stageAtItems,
  stageLabelIn,
  taskActionItems,
  taskStageAt,
  taskStageCodes,
  taskWorkOrders,
  stageCodes,
  stageNumbers,
  type StageGraph,
  stageBoxes,
  stageGraphNodes,
  type Task,
  taskStageGraph,
  type UiInput,
  type UiState,
  zoomBlocks,
} from "../../src/state/index.ts";
import { frame } from "./events.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

const deps = (list: [string, string[]][]) => list.map(([id, after]) => ({ id, after }));

/** AgentSense 场景"一家三口去杭州"的计划：两个起点并行，第 4 阶段三个并行，再汇成一条 */
const HANGZHOU = deps([
  ["weather", []],
  ["places", []],
  ["verify", ["weather", "places"]],
  ["schedule", ["verify"]],
  ["tickets", ["schedule"]],
  ["trains", ["schedule"]],
  ["hotel", ["schedule"]],
  ["pay", ["tickets", "trains", "hotel"]],
  ["tell", ["pay"]],
]);

describe("第几阶段、编号（AgentSense check.ts 的 stageNumbers、idRuleProblems）", () => {
  test("第几阶段是最长那条前置链的长度：没有前置的是第 1 阶段，同号的是并行的", () => {
    expect(Object.fromEntries(stageNumbers(HANGZHOU))).toEqual({ weather: 1, places: 1, verify: 2, schedule: 3, tickets: 4, trains: 4, hotel: 4, pay: 5, tell: 6 });
    // 前置链长短不一时取最长的那条
    expect(Object.fromEntries(stageNumbers(deps([["a", []], ["b", ["a"]], ["c", ["a", "b"]]])))).toEqual({ a: 1, b: 2, c: 3 });
  });

  test("编号：这一阶段只有一个就是阶段号；有几个就按计划里的先后加 a、b、c", () => {
    expect(Object.fromEntries(stageCodes(HANGZHOU))).toEqual({ weather: "1a", places: "1b", verify: "2", schedule: "3", tickets: "4a", trains: "4b", hotel: "4c", pay: "5", tell: "6" });
    // 排在后面、但没有前置的，也在第 1 阶段（顺序号会写成第 3 阶段）
    expect(Object.fromEntries(stageCodes(deps([["s1", []], ["s2", ["s1"]], ["s3", []]])))).toEqual({ s1: "1a", s2: "2", s3: "1b" });
  });

  test("写错的前置（计划里没有这个阶段）不算；有环也不会卡住", () => {
    expect(Object.fromEntries(stageNumbers(deps([["a", ["nope"]], ["b", ["a"]]])))).toEqual({ a: 1, b: 2 });
    const cyclic = stageNumbers(deps([["a", ["b"]], ["b", ["a"]]]));
    expect([...cyclic.keys()].toSorted()).toEqual(["a", "b"]);
  });
});

describe("图的排法（AgentSense milestone.tsx 的 layers、MilestoneGraph、FillGraph）", () => {
  test("自上而下分层，同一层按计划里的先后并排", () => {
    expect(graphRows(HANGZHOU)).toEqual([["weather", "places"], ["verify"], ["schedule"], ["tickets", "trains", "hotel"], ["pay"], ["tell"]]);
  });

  test("同一层在图里居中；线从上游底边的中点连到下游顶边（留 3px 箭头位）的中点，中间是一段三次贝塞尔", () => {
    const g = graphGeometry(deps([["a", []], ["b", ["a"]], ["c", ["a"]]]), 100, 60);
    // 宽：最宽那层 2 个（100 + 14 间隔）减一个间隔，两边各 8；高：两层（60 + 26 间隔）减一个间隔，上下各 8
    expect([g.width, g.height]).toEqual([230, 162]);
    expect(Object.fromEntries(g.pos)).toEqual({ a: { x: 65, y: 8, layer: 0 }, b: { x: 8, y: 94, layer: 1 }, c: { x: 122, y: 94, layer: 1 } });
    expect(g.edges).toEqual([
      { key: "a-b", from: "a", to: "b", layer: 1, d: "M115 68 C115 81 58 81 58 91" },
      { key: "a-c", from: "a", to: "c", layer: 1, d: "M115 68 C115 81 172 81 172 91" },
    ]);
  });

  test("节点大小按栏的宽高算：宽在 96 到 280 之间，高在 76（栏里能上下滑时 100）到 150 之间", () => {
    // 宽屏阶段栏 320（图那块 308 宽、700 高），杭州那份计划：最宽 3 个、6 层，栏里放不下时上下滑
    expect(fillNodeSize({ W: 308, H: 700 }, HANGZHOU, true)).toEqual({ w: 96, h: 100 });
    expect(fillNodeSize({ W: 600, H: 1200 }, HANGZHOU, true)).toEqual({ w: 185, h: 150 });
    // 不滑的（整屏的计划层）最矮 76
    expect(fillNodeSize({ W: 600, H: 400 }, HANGZHOU, false)).toEqual({ w: 185, h: 76 });
  });
});

/** 回放到第 n 个输入为止（不含） */
const until = (inputs: UiInput[], n: number) => replay(inputs.slice(0, n));

/** 一张图写成短串：阶段 编号 状态（新 / 改）；去掉的写"去掉" */
function brief(g: StageGraph | undefined): string[] {
  return (g?.nodes ?? []).map((n) => `${n.id} ${n.code} ${n.state}${n.mark ? ` ${n.mark}` : ""}`);
}

/** task-plan-change 里那个任务的维护者会话 */
const convItems = (state: UiState) => chatItems(state, "maintainer:tm-1");

describe("画哪一份计划（AgentSense milestone.tsx 的 shownPlan、PlanLayer）：回放 task-plan-change", () => {
  const inputs = load("task-plan-change");

  test("计划等你确认：画计划卡上的那份，两个阶段都没有前置，都是第 1 阶段（1a、1b）、都没开始；每个阶段标出要你留意的", () => {
    // 第 7 个输入是计划卡交上来、任务等你确认之后
    const state = until(inputs, 7);
    const g = taskStageGraph(state, "t-1", convItems(state));
    expect(g?.kind).toBe("plan");
    expect(g?.cardId).toBe(state.tasks["t-1"]!.planCardId);
    expect(brief(g)).toEqual(["s1 1a pending", "s2 1b pending"]);
    expect(g!.nodes.map((n) => n.n)).toEqual([1, 1]);
    // 没有授权项、也不会停下来问的阶段：要你留意的都是空的（界面写"只查看"）
    expect(g!.nodes.map((n) => n.marks && [n.marks.perm.length, n.marks.out.length, n.marks.ask.length])).toEqual([
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });

  test("计划变更等你确认：画变更后的那份，改过的阶段标\"改\"，状态照执行中的", () => {
    // 第 34 个输入是用户点拒绝之前：计划变更卡还在等
    const state = until(inputs, 34);
    const g = taskStageGraph(state, "t-1", convItems(state));
    expect(g?.kind).toBe("change");
    expect(brief(g)).toEqual(["s1 1a waiting 改", "s2 1b running"]);
    // 新加的授权项算在"权"里（本机的授权）
    expect(g!.nodes[0]!.marks?.perm.map((m) => m.grantId)).toEqual(["dir1"]);
  });

  test("拒绝之后、维护者自行调整了顺序：画现在生效的那份，编号按调整后的先后；执行中的状态和出过的状况", () => {
    const state = replay(inputs);
    const g = taskStageGraph(state, "t-1", convItems(state));
    expect(g?.kind).toBe("live");
    expect(brief(g)).toEqual(["s2 1a accepted", "s1 1b waiting"]);
    // 正在做的（维护者最后开始的）那一阶段
    expect(g?.current).toBe(state.tasks["t-1"]!.stages?.focus);
  });

  test("一条直线的计划（task-execution）：第 1、2 阶段，编号不带字母", () => {
    const state = replay(load("task-execution"));
    const task = Object.values(state.tasks)[0]!;
    const g = taskStageGraph(state, task.id, chatItems(state, `maintainer:${task.maintainerId}`));
    expect(g!.nodes.map((n) => [n.id, n.n, n.code])).toEqual([
      ["s1", 1, "1"],
      ["s2", 2, "2"],
    ]);
  });
});

describe("计划变更加一个阶段、去掉一个阶段（构造）", () => {
  const checkCard = schemaChecker(CardEventPayloadSchema);
  const checkTask = schemaChecker(TaskEventPayloadSchema);
  const checkPlan = schemaChecker(TaskPlanEventPayloadSchema);
  const inputs = load("task-plan-change");
  // 拿录像里计划变更卡交上来之前的那一刻做底子：s1 在等、s2 在做
  const base = until(inputs, 23);
  const planCard = base.cards[base.tasks["t-1"]!.planCardId!]!.card;
  const basePlan = (planCard.payload as { plan: PlanChangeCardPayload["plan"] }).plan;
  const s1 = basePlan.stages[0]!;
  // 变更后：s2 去掉，加 s3（在 s1 之后）
  const s3 = { ...s1, stageId: "s3", title: "写摘要", dependsOn: ["s1"], policy: { grants: [], temporalRules: [] } };
  // 录像是 76 号票之前录的，计划里还带着定时作业（现在的 schema 不收，读的地方也不认），新造的这一版不带
  const { scheduledJobs: _legacy, ...rest } = basePlan as typeof basePlan & { scheduledJobs?: unknown };
  const newPlan = { ...rest, stages: [s1, s3] };
  const payload: PlanChangeCardPayload = {
    taskId: "t-1",
    taskTitle: "拒绝",
    planId: "t-1-p2",
    revision: 2,
    basePlanId: "t-1-p1",
    why: "报告改成摘要",
    changes: [
      { kind: "stage_removed", expands: false, stageId: "s2", title: "写报告" },
      { kind: "stage_added", expands: false, stageId: "s3", title: "写摘要" },
    ],
    affectedStages: [{ stageId: "s2", title: "写报告" }],
    plan: newPlan,
    grantInfo: {},
  };
  const change: Card = { id: "c-change", type: "plan_change", typeVersion: 1, version: 1, status: "pending", payload, text: "计划变更", createdAt: "2026-10-08T15:00:00+08:00" };
  const cardEvent = { card: change };
  const pending = replay([frame("cards", 900, "card", cardEvent)], base);

  test("等你确认时：新加的标\"新\"，去掉的也画上（前置只留还在计划里的）", () => {
    expect(checkCard.firstError(cardEvent)).toBeUndefined();
    const g = taskStageGraph(pending, "t-1", []);
    expect(g?.kind).toBe("change");
    expect(g?.cardId).toBe("c-change");
    expect(brief(g)).toEqual(["s1 1 running", "s3 2 pending 新", "s2 1 removed"]);
    expect(g!.nodes.find((n) => n.id === "s2")!.after).toEqual([]);
  });

  test("确认之后：画现在生效的那份，被去掉的阶段留在图上（已取消）", () => {
    const task = base.tasks["t-1"]!;
    const confirmed: Card = { ...change, version: 2, status: "handled", outcome: { action: "confirm" } };
    const after: Task = {
      ...task,
      stages: { ...task.stages!, total: 2, list: [task.stages!.list!.find((s) => s.stageId === "s1")!, { stageId: "s3", title: "写摘要", state: "pending", dependsOn: ["s1"], acceptance: [], attempts: 0 }] },
    };
    const planEvent = { taskId: "t-1", planId: "t-1-p2", revision: 2, plan: newPlan, grantInfo: {} };
    const taskEvent = { task: after, change: "plan_changed", from: "running", by: "user" };
    expect(checkPlan.firstError(planEvent)).toBeUndefined();
    expect(checkTask.firstError(taskEvent)).toBeUndefined();
    const state = replay([frame("cards", 901, "card", { card: confirmed }), frame("board", 900, "task_plan", planEvent), frame("board", 901, "task", taskEvent)], pending);
    const g = taskStageGraph(state, "t-1", []);
    expect(g?.kind).toBe("live");
    expect(brief(g)).toEqual(["s1 1 running", "s3 2 pending", "s2 1 removed"]);

    // 聊天里被去掉的 s2 那一段（会话取整段录像里的）：框上的标题、阶段号照图上那个已取消的节点（旧版计划里的标题），不写成"s2"
    const items = chatItems(replay(inputs), "maintainer:tm-1");
    const gone = stageBoxes(state, items, "t-1", { stale: new Set() }).filter((b) => b.stageId === "s2");
    expect(gone.length).toBeGreaterThan(0);
    const node = g!.nodes.find((n) => n.id === "s2")!;
    expect(node.title).toBe(basePlan.stages.find((s) => s.stageId === "s2")!.title);
    expect(gone.map((b) => [b.no, b.title, b.caption])).toEqual(gone.map(() => [node.n, node.title, `第 ${node.n} 阶段 ${node.title}`]));
  });

  test("改的是阶段组的授权：组里的阶段都标\"改\"，不在组里的不标", () => {
    const s2 = basePlan.stages.find((x) => x.stageId === "s2")!;
    const group = { groupId: "g1", title: "整理", policy: { grants: [], temporalRules: [] } };
    const grant = { id: "out", tool: "write_file", title: "写到输出目录", scope: { path: "~/out" } };
    const before = { ...rest, stages: [{ ...s1, groupId: "g1" }, { ...s2, groupId: "g1" }, s3], stageGroups: [group] };
    const after = { ...before, stageGroups: [{ ...group, policy: { grants: [grant], temporalRules: [] } }] };
    const groupChange: PlanChangeCardPayload = {
      ...payload,
      why: "整理那一组要写到输出目录",
      changes: [{ kind: "grant_added", expands: true, owner: { kind: "group", id: "g1", title: "整理" }, grant }],
      affectedStages: [
        { stageId: "s1", title: s1.title },
        { stageId: "s2", title: s2.title },
      ],
      plan: after,
    };
    expect(checkCard.firstError({ card: { ...change, id: "c-group", payload: groupChange } })).toBeUndefined();
    const g = changeStageGraph({ cardId: "c-group", payload: groupChange }, before, new Map(), undefined);
    expect(brief(g)).toEqual(["s1 1a pending 改", "s2 1b pending 改", "s3 2 pending"]);
  });
});

describe("节点的样子（AgentSense PlanLayer 的 plBody、drawer.tsx 的 StepRail）", () => {
  test("状态：图标、两三个字、边框的样式（没开始虚线、在做蓝框、完成绿底、没通过红框、去掉的淡化划掉）；等你验收的写待验收", () => {
    const nodes = stageGraphNodes([
      { id: "a", title: "A", after: [], state: "accepted" },
      { id: "b", title: "B", after: ["a"], state: "running" },
      { id: "c", title: "C", after: ["a"], state: "waiting", waitReason: "acceptance" },
      { id: "d", title: "D", after: ["a"], state: "waiting", waitReason: "stuck" },
      { id: "e", title: "E", after: ["b", "c", "d"], state: "pending" },
      { id: "f", title: "F", after: ["e"], state: "removed" },
    ]);
    expect(nodes.map((n) => `${n.code} ${n.look.icon} ${n.look.text} st-${n.look.st}`)).toEqual([
      "1 ✓ 完成 st-accepted",
      "2a ◐ 进行中 st-in_progress",
      "2b ◑ 待验收 st-submitted",
      "2c ◐ 等你 st-submitted",
      "3 ○ 未开始 st-pending",
      "4 ⊘ 已取消 st-abandoned",
    ]);
  });

  test("出过状况（拉回、拦下、重做、要你看一眼）的节点要醒目；只问过你、只用到敏感数据的不算", () => {
    const nodes = stageGraphNodes([
      { id: "a", title: "A", after: [], state: "accepted", incidents: [{ kind: "pullback", itemId: "x", text: "拉回" }] },
      { id: "b", title: "B", after: [], state: "running", incidents: [{ kind: "ask", itemId: "y", text: "问过你" }, { kind: "data", itemId: "z", text: "敏感" }] },
    ]);
    expect(nodes.map((n) => n.trouble)).toEqual([true, false]);
  });

  test("手机抽屉半开的横向阶段条：一个阶段一列，并行的叠在同一列；去掉的不画", () => {
    const nodes = stageGraphNodes([...HANGZHOU.map((s) => ({ ...s, title: s.id, state: "pending" as const })), { id: "gone", title: "gone", after: [], state: "removed" as const }]);
    expect(railColumns(nodes).map((col) => col.map((n) => n.id))).toEqual([["weather", "places"], ["verify"], ["schedule"], ["tickets", "trains", "hotel"], ["pay"], ["tell"]]);
  });
});

describe("标题栏的阶段标签跟着聊天滚动变（AgentSense App.tsx 的 stepAt、followStep、shownStep）", () => {
  test("聊天里每一条属于哪个阶段：带着阶段的按它（验收结论的进度卡按卡上写的），没带的（回复、思考）算前面最近那一段的", () => {
    const state = replay(load("task-plan-change"));
    const items = chatItems(state, "maintainer:tm-1");
    const at = stageAtItems(state, items, "t-1");
    // 任务书、计划卡、"计划交上去了"还没有阶段；计划确认之后开始执行 s1
    expect(items.slice(0, 3).map((it) => at.get(it.id))).toEqual([undefined, undefined, undefined]);
    expect(at.get(items[3]!.id)).toBe("s1");
    // 带着阶段的按它：最后两句维护者的话归属是 s1，前面验收通过的进度卡是 s2
    expect(items.slice(-3).map((it) => at.get(it.id))).toEqual(["s2", "s1", "s1"]);
    // 没带阶段的（这里把一条回复的归属去掉）跟着前面最近的那一段
    const k = items.length - 2;
    const bare = items.map((it, i) => (i === k ? { ...it, scope: { taskId: "t-1" } } : it));
    expect(stageAtItems(state, bare, "t-1").get(items[k]!.id)).toBe("s2");
  });

  test("展开的阶段框里每次调用、每段思考一行，滚过去报上来的是它们的 id：也认得出在哪个阶段，标签不跳回正在做的那一段", () => {
    const state = replay(load("task-plan-change"));
    const items = chatItems(state, "maintainer:tm-1");
    const at = stageAtItems(state, items, "t-1");
    const groups = items.filter((it) => it.kind === "tool_group" && zoomBlocks(it).length > 0);
    const blocks = groups.flatMap((g) => zoomBlocks(g).map((b) => [b.id, at.get(g.id)] as const));
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.map(([id]) => at.get(id))).toEqual(blocks.map(([, stage]) => stage));
    // 正在做的是 s1 时，停在 s2 的一次调用上标签写 s2（以前认不出调用的 id，跳回正在做的 s1）
    const [inS2] = blocks.find(([, stage]) => stage === "s2")!;
    expect(shownStage({ pinned: undefined, focus: { id: inS2, bottom: false }, current: "s1", stepAt: at, lastItemId: items.at(-1)!.id, first: "s1" })).toBe("s2");
  });

  test("显示哪一阶段：你手动点的 > 聊天里正在看的那一段（停在最新一条时是正在做的那一阶段）> 正在做的 > 最后一条的 > 第一个", () => {
    const stepAt = new Map([
      ["m1", "s1"],
      ["m2", "s1"],
      ["m3", "s2"],
    ]);
    const base = { stepAt, lastItemId: "m3", first: "s1" };
    // 停在最新一条：正在做的那一阶段
    expect(shownStage({ ...base, focus: { bottom: true }, current: "s2" })).toBe("s2");
    // 往上翻到 m1：跟着 m1 那一段
    expect(shownStage({ ...base, focus: { id: "m1", bottom: false }, current: "s2" })).toBe("s1");
    // 手动点了别的阶段：停在那里
    expect(shownStage({ ...base, focus: { id: "m1", bottom: false }, current: "s2", pinned: "s3" })).toBe("s3");
    // 没有正在做的：最后一条那一段；什么都没有：第一个
    expect(shownStage({ ...base, focus: { bottom: true } })).toBe("s2");
    expect(shownStage({ stepAt: new Map(), focus: { bottom: true }, first: "s1" })).toBe("s1");
  });
});

describe("界面上写\"第 N 阶段\"的地方按编号（并行的写 1a、1b，和计划图一致）：回放 task-plan-change", () => {
  const inputs = load("task-plan-change");

  test("各阶段的编号：执行中按看板上的阶段列表（自行调整了先后，字母跟着变）；还没开始执行的按计划卡", () => {
    expect(Object.fromEntries(taskStageCodes(until(inputs, 7), "t-1"))).toEqual({ s1: "1a", s2: "1b" });
    const state = replay(inputs);
    expect(Object.fromEntries(taskStageCodes(state, "t-1"))).toEqual({ s2: "1a", s1: "1b" });
    expect(stageLabelIn(state, "t-1", "s1")).toBe("第 1b 阶段");
    // 认不出的阶段用给的后备
    expect(stageLabelIn(state, "t-1", "s9")).toBe("阶段 s9");
    expect(stageLabelIn(state, "t-x", "s1", "第 2 阶段")).toBe("第 2 阶段");
  });

  test("会话里验收结论的要点、调用的详情写编号（守护进程写在卡上的是顺序号 1/2）", () => {
    const state = replay(inputs);
    const items = chatItems(state, "maintainer:tm-1");
    const acceptance = items.flatMap((it) => it.marks).find((m) => m.kind === "acceptance");
    expect(acceptance?.title).toBe("第 1a 阶段「写报告」验收通过（脚本检查）");
    const write = items.filter((it) => it.kind === "tool_group").at(-1)!;
    const d = write.kind === "tool_group" ? detailContent(state, items, { type: "item", id: write.calls[0]!.id }) : undefined;
    expect(d?.kind === "tool_call" ? d.stage : d?.kind).toBe("第 1a 阶段「写报告」");
  });

  test("任务详情上的按钮：两个并行的阶段等你验收，写各自的编号", () => {
    const task = replay(inputs).tasks["t-1"]!;
    const both: Task = {
      ...task,
      state: "waiting_for_user",
      waitReason: "acceptance",
      stages: { ...task.stages!, list: task.stages!.list!.map((s) => ({ ...s, state: "waiting" as const, waitReason: "acceptance" as const })) },
    };
    expect(taskActionItems(both).flatMap((c) => (c.kind === "accept" ? [c.label] : []))).toEqual(["第 1a 阶段验收通过", "第 1b 阶段验收通过"]);
  });

  test("任务详情状态行的\"第 N/M 阶段\"：维护者正在做的那一阶段的阶段号 / 一共几个阶段号（并行的算一个）", () => {
    const state = replay(inputs);
    // 两个阶段并行：都是第 1 阶段，一共 1 个阶段号（看板上写的是第 1/2 个）
    expect(taskStageAt(state.tasks["t-1"]!)).toEqual({ current: 1, total: 1 });
    // 一条直线的：和顺序号一样
    const line = Object.values(replay(load("task-execution")).tasks)[0]!;
    expect(taskStageAt(line)).toEqual({ current: line.stages!.current, total: 2 });
    // 还没开始执行：照看板上的
    expect(taskStageAt(until(inputs, 7).tasks["t-1"]!)).toEqual({ current: 0, total: 2 });
  });

  test("工单那一栏写阶段的编号", () => {
    const state = replay(load("multi-project"));
    const taskId = Object.keys(state.tasks)[0]!;
    expect(taskWorkOrders(state, taskId).map((w) => w.stage?.replace(/ · .*$/, ""))).toEqual(expect.arrayContaining(["第 1 阶段「" + state.tasks[taskId]!.stages!.list![0]!.title + "」"]));
  });
});
