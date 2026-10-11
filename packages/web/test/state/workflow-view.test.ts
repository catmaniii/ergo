// 三种做法的界面（60 号票）要的数据：流程的进度条、计划台账、"接下来的计划"、计划详情和检测项全览（state/workflow-view.ts、ltl.ts），
// 看板卡上的进度，长程任务的阶段详情（state/stage-detail.ts）。
// 流程用 58 号票主切面录下的事件流（workflow.json：两步的计划，执行时每次调用带着和计划比对的结果），
// 定时触发的流程（自己的和项目的）、往上翻之前和之后、阶段详情用手写的事件（录像里没有）。
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  canReopenStage,
  type Card,
  chatItems,
  type HistoryPage,
  historyNeededSince,
  type JobRun,
  latestGuardPing,
  maintainerChannel,
  type MessageEnvelope,
  type MessagePart,
  ownMaintainerId,
  type PlanGrant,
  type ProgressCardPayload,
  ON_VIOLATION_TEXT,
  onViolationOf,
  type Plan,
  reopenScope,
  replay,
  ruleBook,
  ruleBookEntry,
  type ScheduledJob,
  slotRiskMarks,
  stageDetailFacts,
  stageMarks,
  stageToolCalls,
  stepsDone,
  type Task,
  taskBoardProgress,
  taskIncidents,
  type TaskStage,
  type TimelineRecordEventPayload,
  timelineItems,
  type UiInput,
  type UiState,
  workflowFuture,
  type WorkflowPlanCardPayload,
  workflowPlanDetail,
  workflowPlanLedger,
  workflowProgress,
  workflowSlots,
  zoomTaskFacts,
} from "../../src/state/index.ts";
import { apiFormulaOf, costText, expr, formulaOf, repairsOf } from "../../src/state/ltl.ts";
import { frame } from "./events.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

const at = (hm: string) => `2026-10-12T${hm}:00+08:00`;
/** 录像里流程 t-1 的维护者会话 */
const flowItems = (state: UiState) => chatItems(state, maintainerChannel(ownMaintainerId("t-1")));
/** 定时触发的流程 t-w 第 r 次运行开始处的分隔线 */
const divider = (r: number): MessagePart => ({ type: "run_divider", jobId: "j-w", runId: `j-w-r${r}`, title: `第 ${r} 次运行` });
/** 项目维护者会话里一张工单那一段开头的分隔线 */
const woDivider = (wo: string): MessagePart => ({ type: "work_order_divider", workOrderId: wo, title: "每天检查依赖", from: "定时作业" });
/** 一次带着和计划比对结果的工具调用 */
const planCall = (id: string, tool: string, plan: Extract<MessagePart, { type: "tool_call" }>["plan"]): MessagePart => ({
  type: "tool_call",
  callId: id,
  tool,
  argsSummary: "notes.md",
  categoryTitles: [],
  disposition: "do",
  withinGrant: false,
  genericBash: false,
  outcome: "done",
  nature: "act",
  ...(plan ? { plan } : {}),
});
/** 宣布第 1 阶段完成（代为执行的内部工具），summary 是维护者写的那一两句 */
const completed = (summary: string): MessagePart => ({
  type: "tool_call",
  callId: `call-done-${summary.length}`,
  tool: "complete_stage",
  argsSummary: `stageId=s1 summary=${summary}`,
  categoryTitles: [],
  disposition: "do",
  withinGrant: false,
  genericBash: false,
  outcome: "done",
  nature: "act",
});
/** 看板上长程任务的一个阶段 */
const stage = (stageId: string, state: TaskStage["state"]): TaskStage => ({ stageId, title: stageId, state, dependsOn: [], acceptance: [], attempts: 0 });

describe("流程（录像 workflow.json）", () => {
  const inputs = load("workflow");
  const final = replay(inputs);
  const cardId = Object.values(final.cards).find((c) => c.card.type === "workflow_plan")!.card.id;
  // 执行到一半：第一步做完、第二步在做
  const halfway = inputs.findIndex((i) => i.kind === "frame" && i.frame.type === "task" && (i.frame.payload as { task: Task }).task.steps?.list?.[1]?.state === "in_progress");
  const mid = replay(inputs.slice(0, halfway + 1));

  test("顶栏的进度条：做完几步 / 共几步，第几版；一次性的流程没有运行", () => {
    expect(workflowProgress(mid, "t-1")).toEqual({ done: 1, total: 2, version: 1 });
    expect(workflowProgress(final, "t-1")).toEqual({ done: 2, total: 2, version: 1 });
    // 授权之前没有进度（AgentSense：task.plan 有了才显示）
    const submitted = inputs.findIndex((i) => i.kind === "frame" && i.frame.type === "card");
    expect(workflowProgress(replay(inputs.slice(0, submitted + 1)), "t-1")).toBeUndefined();
  });

  test("看板卡上的进度：流程按步数；授权之前是“尚无计划”（0/0）；普通任务没有", () => {
    const task = final.tasks["t-1"]!;
    expect(taskBoardProgress(final, task)).toEqual({ done: 2, total: 2, unit: "step" });
    const submitted = inputs.findIndex((i) => i.kind === "frame" && i.frame.type === "card");
    const waiting = replay(inputs.slice(0, submitted + 1));
    expect(taskBoardProgress(waiting, waiting.tasks["t-1"]!)).toEqual({ done: 0, total: 0, unit: "step" });
    expect(taskBoardProgress(final, { ...task, kind: "plain" })).toBeUndefined();
  });

  test("做完几步只算报了“做完”的，跳过的不算（AgentSense 的口径；进度条、看板、虚线框、“运行”一栏、任务卡、项目页同一个函数）", () => {
    expect(stepsDone([{ state: "done" }, { state: "skipped" }, { state: "in_progress" }, { state: "done" }])).toBe(2);
  });

  test("计划台账：提过的每一份计划；当前那份写做完几步、点了打开会话里那张卡", () => {
    const rows = workflowPlanLedger(final, "t-1", flowItems(final));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cardId, version: 1, state: "已授权", live: true, steps: "2/2 步", goal: "写好笔记并读一遍" });
    expect(rows[0]!.itemId).toBe(flowItems(final).find((it) => it.kind === "card" && it.cardId === cardId)!.id);
    // 涉及的关注类别（CONTEXT：不说"敏感操作"）
    expect(rows[0]!.meta).toContain("⚠ 涉及 1 个关注类别");
    expect(rows[0]!.meta).toMatch(/ms$/);
  });

  test("每次调用和计划比对的结果落在对应的格子上；没有偏差", () => {
    expect(workflowSlots(final, "t-1", flowItems(final)).map((s) => [s.step.id, s.status, s.actual, s.deviations, s.fixed])).toEqual([
      ["s1", "done", 1, [], []],
      ["s2", "done", 1, [], []],
    ]);
  });

  test("接下来的计划：做完的不再列；在做的那一步还在；都做完了就没有虚线框", () => {
    const future = workflowFuture(mid, "t-1", flowItems(mid))!;
    expect(future.slots.map((s) => [s.step.id, s.status])).toEqual([["s2", "in_progress"]]);
    expect([future.done, future.total, future.offPlan]).toEqual([1, 2, 0]);
    expect(workflowFuture(final, "t-1", flowItems(final))).toBeUndefined();
  });

  test("卡缩成一行：计划 v1 · 2 步 · 已授权", () => {
    const card = flowItems(final).find((it) => it.kind === "card" && it.cardId === cardId)!;
    expect(card.keyLine).toBe("计划 v1 · 2 步 · 已授权");
  });

  test("虚线框右侧的标注：计划步骤上的关注类别命中全部标出（对应 AgentSense 的 op）", () => {
    const p = final.cards[cardId]!.card.payload as WorkflowPlanCardPayload;
    const step = p.plan.steps.find((x) => x.marks.length > 0)!;
    expect(slotRiskMarks(step)).toEqual(step.marks);
  });

  test("计划详情：敏感信息（同一类只列一次）、各步的状态、版本（第一版没有差异）", () => {
    const d = workflowPlanDetail(final, cardId)!;
    expect(d).toMatchObject({ version: 1, state: "已授权", tone: "ok", versions: 1, diff: undefined });
    expect(d.marks.map((m) => [m.category, m.disposition])).toEqual([["delete_or_overwrite", "do_then_tell"]]);
    expect(Object.values(d.progress!).map((s) => [s.stepId, s.state])).toEqual([
      ["s1", "done"],
      ["s2", "done"],
    ]);
  });

  test("检测项全览：审查用的 7 条规则原文（框架 6 条、计划里写的 1 条），各自的结论、公式、修法", () => {
    const p = final.cards[cardId]!.card.payload as WorkflowPlanCardPayload;
    const book = ruleBook(p.plan.review)!;
    expect(book.rules).toHaveLength(7);
    expect(book.rules.map((r) => [r.id, r.source, r.status])).toEqual([
      ["v1.backup-before-overwrite", "template", "deferred"],
      ["v1.test-before-push", "template", "ok"],
      ["v1.no-send-after-secret-read", "template", "ok"],
      ["v1.no-duplicate-send", "template", "ok"],
      ["v1.no-secret-in-outbound", "template", "ok"],
      ["v1.no-force-push-or-rm-rf-outside", "template", "ok"],
      ["write-before-read", "plan", "ok"],
    ]);
    const push = book.rules[1]!;
    // 违反了怎么办和计划卡、阶段详情同一个说法（协议包的 ON_VIOLATION_TEXT，84 号票合成一份；不说"拦截"，CONTEXT）
    expect([push.onViolation, push.modes]).toEqual(["违反时退回，先补上再做", "规划时 + 执行时"]);
    expect(book.rules[2]!.onViolation).toBe("违反就不做");
    expect(push.repairs.map((r) => r.kind)).toEqual(["insert"]);
    expect(push.formula.formula).toMatch(/^G\(/);
    expect(push.formula.antecedent).toContain("git_push");
    expect(push.api).toContain("git_push");
    expect(book.rules[0]!.deferred).toHaveLength(1);
    // 60 号票之前的计划没有规则原文：不显示检测项全览
    expect(ruleBook({ ...p.plan.review, docs: undefined })).toBeUndefined();
  });
});

// ───────────────────────── 定时触发的流程：按这一次运行 ─────────────────────────

describe("定时触发的流程：进度条、虚线框按这一次运行算", () => {
  const recorded = replay(load("workflow"));
  const base = Object.values(recorded.cards).find((c) => c.card.type === "workflow_plan")!.card;
  const conversation = maintainerChannel(ownMaintainerId("t-w"));
  const planCard: Card = { ...base, id: "c-w", payload: { ...(base.payload as WorkflowPlanCardPayload), taskId: "t-w" } };
  const task: Task = {
    id: "t-w",
    title: "每周写笔记",
    summary: "每周写笔记",
    state: "operating",
    origin: "button",
    kind: "workflow",
    trigger: { kind: "schedule", schedule: { kind: "weekly", time: "09:00", weekdays: [1] } },
    maintainerId: ownMaintainerId("t-w"),
    projects: [],
    projectIds: [],
    projectScope: "none",
    planCardId: "c-w",
    createdAt: at("08:00"),
    updatedAt: at("08:00"),
  };
  const run = (n: number, state: JobRun["state"], steps: [string, string][]): JobRun => ({
    runId: `j-w-r${n}`,
    jobId: "j-w",
    trigger: "scheduled",
    dueAt: at(`0${n}:00`),
    state,
    queuedAt: at(`0${n}:00`),
    startedAt: at(`0${n}:00`),
    ...(state === "running" ? {} : { endedAt: at(`0${n}:30`) }),
    steps: steps.map(([stepId, s]) => ({ stepId, title: stepId, state: s as "done" })),
  });
  const job = (runCount: number, lastRun: JobRun): ScheduledJob => ({
    id: "j-w",
    title: task.title,
    schedule: { kind: "weekly", time: "09:00", weekdays: [1] },
    each: task.summary,
    maintainerId: task.maintainerId,
    taskId: "t-w",
    taskTitle: task.title,
    ownerTaskId: "t-w",
    grants: [],
    temporalRules: [],
    grantInfo: {},
    state: "active",
    lastFailed: false,
    consecutiveFailures: 0,
    runCount,
    lastRun,
    createdAt: at("08:00"),
    updatedAt: at("08:00"),
  });
  let n = 0;
  const call = (tool: string, plan: Extract<MessagePart, { type: "tool_call" }>["plan"]): MessagePart => ({
    type: "tool_call",
    callId: `call-${++n}`,
    tool,
    argsSummary: "notes.md",
    categoryTitles: [],
    disposition: "do",
    withinGrant: false,
    genericBash: false,
    outcome: "done",
    nature: "act",
    ...(plan ? { plan } : {}),
  });
  const message = (id: string, time: string, ...parts: MessagePart[]): MessageEnvelope => ({ id, conversation, speaker: "agent", time, parts });
  const r1 = run(1, "done", [
    ["s1", "done"],
    ["s2", "done"],
  ]);
  const r2 = run(2, "running", [
    ["s1", "done"],
    ["s2", "pending"],
  ]);
  const scope = { taskId: "t-w", scheduledJobId: "j-w" };
  const events = [
    frame("cards", 1, "card", { card: planCard }),
    frame("board", 1, "task", { task, change: "plan_confirmed", from: "awaiting_confirm", by: "user" }),
    frame("board", 2, "scheduled_job", { job: job(1, r1), change: "run_finished", by: "system", run: r1 }),
    frame("board", 3, "scheduled_job", { job: job(2, r2), change: "run_started", by: "system", run: r2 }),
    frame(conversation, 1, "message", { message: message("m1", at("01:00"), divider(1)), ...scope }),
    // 第 1 次运行里的偏差：抢在依赖步骤之前（这一次的事，不算到第 2 次）
    frame(conversation, 2, "message", { message: message("m2", at("01:05"), call("read", { stepId: "s2", findings: ["out_of_order"] }), call("write", { stepId: "s1" })), ...scope }),
    frame(conversation, 3, "message", { message: message("m3", at("02:00"), divider(2)), ...scope }),
    frame(conversation, 4, "message", { message: message("m4", at("02:05"), call("write", { stepId: "s1" }), call("ls", { offPlan: true })), ...scope }),
  ];
  const ui = replay(events);
  const items = chatItems(ui, conversation);

  test("进度条：第 2 次运行做完 1/2；看板卡上带着第几次运行", () => {
    const progress = workflowProgress(ui, "t-w")!;
    expect(progress).toEqual({ done: 1, total: 2, version: 1, run: { no: 2 } });
    expect(taskBoardProgress(ui, ui.tasks["t-w"]!)).toEqual({ done: 1, total: 2, unit: "step", run: 2 });
  });

  test("缩小后点开的任务卡：做完几步和标题栏同一个口径（这一次运行），关注类别的个数", () => {
    const rows = zoomTaskFacts(ui, "t-w", items).rows;
    expect(rows.find(([k]) => k === "计划")).toEqual(["计划", "计划 v1 · 第 2 次运行 · 1/2 步"]);
    expect(rows.find(([k]) => k === "关注类别")).toEqual(["关注类别", "⚠ 涉及 1 个"]);
  });

  test("虚线框：只列这一次还没做的；偏差、计划外动作只看这一次运行的调用", () => {
    const future = workflowFuture(ui, "t-w", items)!;
    expect(future.slots.map((s) => [s.step.id, s.status, s.deviations])).toEqual([["s2", "pending", []]]);
    expect([future.done, future.total, future.offPlan]).toEqual([1, 2, 1]);
    // 第 1 次运行那一段：抢在依赖步骤之前
    const first = replay([...events.slice(0, 3), ...events.slice(4, 6)]);
    expect(workflowSlots(first, "t-w", chatItems(first, conversation)).find((s) => s.step.id === "s2")!.deviations).toEqual(["抢在依赖步骤之前"]);
  });

  test("这一次跑完了：都做完，没有虚线框；没在跑时按最近开始过的那一次", () => {
    const done = run(2, "done", [
      ["s1", "done"],
      ["s2", "done"],
    ]);
    const after = replay([frame("board", 4, "scheduled_job", { job: job(2, done), change: "run_finished", by: "system", run: done })], ui);
    expect(workflowProgress(after, "t-w")).toMatchObject({ done: 2, total: 2, run: { no: 2 } });
    expect(workflowFuture(after, "t-w", chatItems(after, conversation))).toBeUndefined();
  });

  test("事件触发的流程（77 号票）：一批两个事件各走一遍，进度、看板卡、虚线框按这次运行展开的步骤算（s1.e1……，标题是代入了值的）", () => {
    const evented: Task = { ...task, trigger: { kind: "event", source: "folder", events: ["added"], filter: { path: "D:\\收件箱" } } };
    const r3: JobRun = {
      ...run(3, "running", []),
      trigger: "event",
      steps: [
        { stepId: "s1.e1", title: "写 a（第 1 个事件）", state: "done" },
        { stepId: "s2.e1", title: "读 a（第 1 个事件）", state: "done" },
        { stepId: "s1.e2", title: "写 b（第 2 个事件）", state: "done" },
        { stepId: "s2.e2", title: "读 b（第 2 个事件）", state: "pending" },
      ],
    };
    const state = replay(
      [frame("board", 4, "task", { task: evented, change: "updated", from: "operating", by: "system" }), frame("board", 5, "scheduled_job", { job: job(3, r3), change: "run_started", by: "system", run: r3 })],
      ui,
    );
    expect(workflowProgress(state, "t-w")).toEqual({ done: 3, total: 4, version: 1, run: { no: 3 } });
    expect(taskBoardProgress(state, state.tasks["t-w"]!)).toEqual({ done: 3, total: 4, unit: "step", run: 3 });
    const future = workflowFuture(state, "t-w", chatItems(state, conversation))!;
    expect(future.slots.map((s) => [s.step.id, s.step.title, s.status, s.step.after])).toEqual([["s2.e2", "读 b（第 2 个事件）", "pending", ["s1.e2"]]]);
    expect([future.done, future.total]).toEqual([3, 4]);
  });
});

// ───────────────────────── 属于项目的定时流程：这一次运行是一张工单 ─────────────────────────

describe("属于项目的定时流程：这一次运行按它的工单段切出来（项目的运行不发运行分隔线）", () => {
  const recorded = replay(load("workflow"));
  const base = Object.values(recorded.cards).find((c) => c.card.type === "workflow_plan")!.card;
  const conversation = maintainerChannel("pm-p-1");
  const planCard: Card = { ...base, id: "c-p", payload: { ...(base.payload as WorkflowPlanCardPayload), taskId: "t-p" } };
  const task: Task = {
    id: "t-p",
    title: "每天检查依赖",
    summary: "每天检查依赖",
    state: "operating",
    origin: "button",
    kind: "workflow",
    trigger: { kind: "schedule", schedule: { kind: "daily", time: "09:00" } },
    maintainerId: "pm-p-1",
    projects: ["记账本"],
    projectIds: ["p-1"],
    projectScope: "single",
    planCardId: "c-p",
    createdAt: at("08:00"),
    updatedAt: at("08:00"),
  };
  const run = (n: number, state: JobRun["state"], steps: [string, string][]): JobRun => ({
    runId: `j-p-r${n}`,
    jobId: "j-p",
    trigger: "scheduled",
    dueAt: at(`0${n}:00`),
    state,
    queuedAt: at(`0${n}:00`),
    startedAt: at(`0${n}:00`),
    workOrderId: `wo-${n}`,
    steps: steps.map(([stepId, s]) => ({ stepId, title: stepId, state: s as "done" })),
  });
  const job = (lastRun: JobRun): ScheduledJob => ({
    id: "j-p",
    title: task.title,
    schedule: { kind: "daily", time: "09:00" },
    each: task.summary,
    projectId: "p-1",
    projectName: "记账本",
    maintainerId: "pm-p-1",
    taskId: "t-p",
    taskTitle: task.title,
    ownerTaskId: "t-p",
    grants: [],
    temporalRules: [],
    grantInfo: {},
    state: "active",
    lastFailed: false,
    consecutiveFailures: 0,
    runCount: 2,
    lastRun,
    createdAt: at("08:00"),
    updatedAt: at("08:00"),
  });
  const message = (id: string, time: string, ...parts: MessagePart[]): MessageEnvelope => ({ id, conversation, speaker: "agent", time, parts });
  // 这一段的消息只带作业、项目的归属（守护进程 segments.ts 的 scopeIn），不带任务
  const scope = { projectId: "p-1", scheduledJobId: "j-p" };
  const r2 = run(2, "running", [
    ["s1", "done"],
    ["s2", "pending"],
  ]);
  const ui = replay([
    frame("cards", 1, "card", { card: planCard }),
    frame("board", 1, "task", { task, change: "plan_confirmed", from: "awaiting_confirm", by: "user" }),
    frame("board", 2, "scheduled_job", { job: job(r2), change: "run_started", by: "system", run: r2 }),
    frame(conversation, 1, "message", { message: message("m1", at("01:00"), woDivider("wo-1")), ...scope }),
    frame(conversation, 2, "message", { message: message("m2", at("01:05"), planCall("c1", "read", { stepId: "s2", findings: ["out_of_order"] })), ...scope }),
    frame(conversation, 3, "message", { message: message("m3", at("02:00"), woDivider("wo-2")), ...scope }),
    frame(conversation, 4, "message", { message: message("m4", at("02:05"), planCall("c2", "read", { stepId: "s1" }), planCall("c3", "ls", { offPlan: true })), ...scope }),
    frame(conversation, 5, "message", { message: message("m5", at("02:06"), planCall("c4", "read", { stepId: "s2", findings: ["out_of_scope"] })), ...scope }),
    // 下一张工单（别的事）开了新的一段：不算这一次运行的
    frame(conversation, 6, "message", { message: message("m6", at("02:30"), woDivider("wo-9")), ...scope }),
    frame(conversation, 7, "message", { message: message("m7", at("02:31"), planCall("c5", "ls", { offPlan: true })), ...scope }),
  ]);
  const items = chatItems(ui, conversation);

  test("偏差、计划外动作、格子上的调用数：只算这一次运行那张工单的一段", () => {
    const future = workflowFuture(ui, "t-p", items)!;
    expect(future.slots.map((s) => [s.step.id, s.status, s.actual, s.deviations])).toEqual([["s2", "pending", 1, ["参数超出计划范围"]]]);
    expect([future.done, future.total, future.offPlan]).toEqual([1, 2, 1]);
    expect(workflowSlots(ui, "t-p", items).find((s) => s.step.id === "s1")!.actual).toBe(1);
  });
});

// ───────────────────────── 往上翻：按整段会话算 ─────────────────────────

describe("偏差个数、计划外动作按整段会话算：往上翻取回旧页之前要取，取齐之后数字不再变", () => {
  const recorded = replay(load("workflow"));
  const base = Object.values(recorded.cards).find((c) => c.card.type === "workflow_plan")!.card;
  const conversation = maintainerChannel(ownMaintainerId("t-o"));
  const planCard: Card = { ...base, id: "c-o", payload: { ...(base.payload as WorkflowPlanCardPayload), taskId: "t-o" } };
  const task: Task = {
    id: "t-o",
    title: "整理笔记",
    summary: "整理笔记",
    state: "running",
    origin: "button",
    kind: "workflow",
    maintainerId: ownMaintainerId("t-o"),
    projects: [],
    projectIds: [],
    projectScope: "none",
    planCardId: "c-o",
    steps: {
      total: 2,
      done: 1,
      list: [
        { stepId: "s1", title: "写笔记", state: "done" },
        { stepId: "s2", title: "读一遍笔记", state: "in_progress" },
      ],
    },
    createdAt: at("08:00"),
    updatedAt: at("09:30"),
  };
  const message = (id: string, time: string, ...parts: MessagePart[]): MessageEnvelope => ({ id, conversation, speaker: "agent", time, parts });
  const scope = { taskId: "t-o", stageId: "flow" };
  // WebSocket 第一次只补发最近一页：手里只有第 3 条
  const live = replay([
    frame("cards", 1, "card", { card: planCard }),
    frame("board", 1, "task", { task, change: "step_reported", from: "running", by: "maintainer" }),
    frame(conversation, 3, "message", { message: message("m3", at("09:20"), planCall("c3", "ls", { offPlan: true })), ...scope }),
  ]);
  const page: HistoryPage = {
    conversation,
    messages: [
      { seq: 1, message: message("m1", at("09:00"), planCall("c1", "read", { stepId: "s2", findings: ["out_of_order"] })), ...scope },
      { seq: 2, message: message("m2", at("09:05"), planCall("c2", "write", { stepId: "s1" })), ...scope },
    ],
    records: [],
    hasMore: false,
  };
  const full = replay([{ kind: "history_page", conversation, page }], live);

  test("只有最近一页时：还要往前取（最早那条不比任务开始早，更早还有）", () => {
    expect(historyNeededSince(live, conversation, task.createdAt)).toBe(true);
    expect(historyNeededSince(full, conversation, task.createdAt)).toBe(false);
    // 手里最早那条已经比要的早了：不用再取
    expect(historyNeededSince(live, conversation, at("09:30"))).toBe(false);
  });

  test("取齐之后：第 2 步上抢在依赖步骤之前的那次也算上，计划外动作 1 个", () => {
    const future = workflowFuture(full, "t-o", chatItems(full, conversation))!;
    expect(future.slots.map((s) => [s.step.id, s.deviations])).toEqual([["s2", ["抢在依赖步骤之前"]]]);
    expect(future.offPlan).toBe(1);
  });
});

// ───────────────────────── 长程任务的阶段详情 ─────────────────────────

describe("阶段详情：出过的状况、尝试记录、第几轮、从这里重做的范围", () => {
  const conversation = maintainerChannel(ownMaintainerId("t-l"));
  const task = (stages: [string, TaskStage["state"]][], updatedAt: string): Task => ({
    id: "t-l",
    title: "长程任务",
    summary: "长程任务",
    state: "running",
    origin: "button",
    maintainerId: ownMaintainerId("t-l"),
    projects: [],
    projectIds: [],
    projectScope: "none",
    stages: { total: stages.length, list: stages.map(([id, s]) => stage(id, s)) },
    createdAt: at("08:00"),
    updatedAt,
  });
  const acceptance = (id: string, passed: boolean): Card => ({
    id,
    type: "progress",
    typeVersion: 1,
    version: 1,
    status: "pending",
    text: "验收结论",
    createdAt: at("09:00"),
    payload: {
      taskId: "t-l",
      taskTitle: "长程任务",
      stageId: "s1",
      stageTitle: "s1",
      stageIndex: 1,
      stageTotal: 2,
      kind: "acceptance",
      text: passed ? "通过" : "没通过",
      acceptance: { passed, judgedBy: "script", results: [{ criterion: "清单覆盖两个目录", method: "script", passed }] },
    } satisfies ProgressCardPayload,
  });
  const message = (id: string, time: string, stageId: string, ...parts: MessagePart[]) => ({ message: { id, conversation, speaker: "agent", time, parts } satisfies MessageEnvelope, taskId: "t-l", stageId });
  const pulledBack: MessagePart = {
    type: "tool_call",
    callId: "call-pb",
    tool: "write",
    argsSummary: "回收区/清单.md",
    categoryTitles: [],
    disposition: "do",
    withinGrant: false,
    genericBash: false,
    outcome: "blocked",
    blockedBy: "pull_back",
    nature: "act",
  };
  const ui = replay([
    frame("cards", 1, "card", { card: acceptance("c-a1", false) }),
    frame("cards", 2, "card", { card: acceptance("c-a2", true) }),
    frame("board", 1, "task", {
      task: task(
        [
          ["s1", "running"],
          ["s2", "pending"],
        ],
        at("09:00"),
      ),
      change: "plan_confirmed",
      from: "awaiting_confirm",
      by: "user",
    }),
    frame(conversation, 1, "message", message("m1", at("09:10"), "s1", pulledBack)),
    frame(conversation, 2, "message", message("m2", at("09:15"), "s1", completed("清单出来了"))),
    frame(conversation, 3, "message", message("m3", at("09:20"), "s1", { type: "card_ref", cardId: "c-a1" })),
    frame(conversation, 4, "message", message("m4", at("09:35"), "s1", completed("补上了网盘那一边"))),
    frame(conversation, 5, "message", message("m5", at("09:40"), "s1", { type: "card_ref", cardId: "c-a2" })),
    frame(conversation, 6, "message", { message: { id: "m6", conversation, speaker: "system", time: at("09:50"), parts: [{ type: "text", text: "维护者这次没能回复：模型调用超时" }] } satisfies MessageEnvelope, taskId: "t-l", stageId: "s2" }),
    frame(conversation, 7, "message", message("m7", at("10:00"), "s2", { type: "text", text: "开始第 2 阶段" })),
    // 做完之后返工第 1 阶段（连同下游）
    frame("board", 2, "task", {
      task: task(
        [
          ["s1", "pending"],
          ["s2", "pending"],
        ],
        at("11:00"),
      ),
      change: "rework",
      from: "done",
      by: "user",
    }),
  ]);
  const items = chatItems(ui, conversation);

  test("第 1 阶段：两次交上来（先没过、再过了，各带宣布完成时写的备注）、重开过一次，第 2 轮；状况是被拉回两次", () => {
    const facts = stageDetailFacts(ui, items, "t-l", "s1");
    expect([facts.rounds, facts.submissions, facts.reopens]).toEqual([2, 2, 1]);
    expect(facts.attempts.map((a) => (a.kind === "attempt" ? [a.kind, a.passed, a.failed, a.note] : [a.kind, a.scope]))).toEqual([
      ["attempt", false, ["清单覆盖两个目录"], "清单出来了"],
      ["attempt", true, [], "补上了网盘那一边"],
      ["reopen", ["s1", "s2"]],
    ]);
    expect(facts.incidents.map((i) => [i.kind, i.text])).toEqual([
      ["pullback", "想写 回收区/清单.md，已拉回计划"],
      ["pullback", "交上来的被退回重做：清单覆盖两个目录"],
    ]);
    expect(facts.firstItemId).toBe(items.find((it) => it.scope.stageId === "s1")!.id);
  });

  test("第 2 阶段：还没交过；这一轮出错算一件“要你看一眼”（AgentSense 把出错归这一类）", () => {
    const facts = stageDetailFacts(ui, items, "t-l", "s2");
    expect([facts.rounds, facts.submissions]).toEqual([2, 0]);
    expect(facts.incidents.map((i) => [i.kind, i.text, i.attention])).toEqual([["look", "维护者这次没能回复：模型调用超时", true]]);
  });

  test("整个任务出过的状况（阶段抽屉下面那一行、出过的状况一页），最近一次拉回让阶段标签闪", () => {
    expect(taskIncidents(ui, items, "t-l").map((i) => i.kind)).toEqual(["pullback", "pullback", "look"]);
    expect(latestGuardPing(items, "t-l")).toEqual({ key: expect.any(String), kind: "pullback" });
  });

  test("授权和用量：每个阶段用了几次工具调用（会话里归属这个阶段的调用记录数）", () => {
    expect(stageToolCalls(ui, conversation, "t-l")).toEqual({ s1: 3 });
  });

  test("从这里重做：这个阶段和依赖它的（一直往下游找），不相干的不动（协议包的 reopenScope，和守护进程同一份）", () => {
    const stages = [
      { stageId: "a", dependsOn: [] },
      { stageId: "b", dependsOn: ["a"] },
      { stageId: "c", dependsOn: ["b"] },
      { stageId: "d", dependsOn: [] },
    ];
    expect(reopenScope(stages, "b", () => true)).toEqual(["b", "c"]);
    expect(reopenScope(stages, "a", () => true)).toEqual(["a", "b", "c"]);
    expect(reopenScope(stages, "d", () => true)).toEqual(["d"]);
  });

  test("看板卡上的进度：长程任务是已验收的阶段数；计划还在等你确认时和流程一样是“尚无计划”", () => {
    const running = task(
      [
        ["s1", "accepted"],
        ["s2", "running"],
      ],
      at("10:00"),
    );
    expect(taskBoardProgress(ui, running)).toEqual({ done: 1, total: 2, unit: "stage" });
    const waiting: Task = { ...running, state: "awaiting_confirm", stages: { total: 2 }, planCardId: "c-plan" };
    expect(taskBoardProgress(ui, waiting)).toEqual({ done: 0, total: 0, unit: "stage" });
    // 计划卡点了确认（还没开始执行，没有各阶段的状态）：0/2
    const confirmed = replay([frame("cards", 3, "card", { card: { ...acceptance("c-plan", true), type: "plan", status: "handled", outcome: { action: "confirm" } } })], ui);
    expect(taskBoardProgress(confirmed, { ...waiting, state: "queued" })).toEqual({ done: 0, total: 2, unit: "stage" });
  });
});


describe("阶段详情补上的几块（84 号票）：重做记录、两种备注、执行中重做的范围、要你留意的、规则详情", () => {
  const conversation = maintainerChannel(ownMaintainerId("t-r"));
  const task = (state: Task["state"], stages: [string, TaskStage["state"], string?][], updatedAt: string, extra: Partial<Task> = {}): Task => ({
    id: "t-r",
    title: "执行中重做",
    summary: "执行中重做",
    state,
    origin: "button",
    maintainerId: ownMaintainerId("t-r"),
    projects: [],
    projectIds: [],
    projectScope: "none",
    stages: { total: stages.length, list: stages.map(([id, s, startedAt]) => ({ ...stage(id, s), dependsOn: id === "s1" ? [] : ["s1"], ...(startedAt ? { startedAt } : {}) })) },
    createdAt: at("08:00"),
    updatedAt,
    ...extra,
  });
  // 第 1 阶段交上来、你退回（由你验收那条写了原因），卡上记着维护者宣布完成时写的那句
  const returned: Card = {
    id: "c-r1",
    type: "progress",
    typeVersion: 1,
    version: 1,
    status: "handled",
    text: "验收结论",
    createdAt: at("09:00"),
    payload: {
      taskId: "t-r",
      taskTitle: "执行中重做",
      stageId: "s1",
      stageTitle: "s1",
      stageIndex: 1,
      stageTotal: 2,
      kind: "acceptance",
      text: "你退回了",
      acceptance: {
        passed: false,
        judgedBy: "user",
        summary: "草稿写好了",
        results: [
          { criterion: "格式对", method: "script", passed: true, note: "两个文件都在" },
          { criterion: "你看过草稿", method: "user", passed: false, note: "营销号的来源去掉" },
        ],
      },
    } satisfies ProgressCardPayload,
  };
  const notice: MessageEnvelope = { id: "m-notice", conversation, speaker: "system", time: at("10:00"), parts: [{ type: "text", text: "用户从第 1 阶段重做（你手头那一轮已经停下）……" }] };
  const reopenRecord: TimelineRecordEventPayload = {
    record: { id: "rec-1", kind: "reopen", summary: "你从「s1」重做（连带后面的 「s2」）。你说：「换个角度」", time: at("10:00"), noticeId: "m-notice" },
    taskId: "t-r",
    stageId: "s1",
  };
  const ui = replay([
    frame("cards", 1, "card", { card: returned }),
    frame("board", 1, "task", { task: task("running", [["s1", "running"], ["s2", "pending"]], at("08:30")), change: "plan_confirmed", from: "awaiting_confirm", by: "user" }),
    frame(conversation, 1, "message", { message: { id: "m1", conversation, speaker: "system", time: at("09:00"), parts: [{ type: "card_ref", cardId: "c-r1" }] } satisfies MessageEnvelope, taskId: "t-r", stageId: "s1" }),
    // 执行中（第 2 阶段在做）从第 1 阶段重做：事件上写着重开了哪几个（这一刻两个都回到未开始，s2 开始过）
    frame("board", 2, "task", {
      task: task("running", [["s1", "running", at("10:00")], ["s2", "pending", at("09:30")]], at("10:00")),
      change: "rework",
      from: "running",
      by: "user",
      reopened: ["s1", "s2"],
    }),
    frame(conversation, 2, "timeline_record", reopenRecord),
    frame(conversation, 3, "message", { message: notice, taskId: "t-r", stageId: "s1" }),
  ]);
  const items = chatItems(ui, conversation);

  test("重做记录是出过的状况里的“撤回”一类；交给维护者接着做的那句通知不再重复显示", () => {
    const facts = stageDetailFacts(ui, items, "t-r", "s1");
    expect(facts.incidents.map((i) => [i.kind, i.text])).toEqual([
      ["pullback", "交上来的被退回重做：你看过草稿"],
      ["undo", "你从「s1」重做（连带后面的 「s2」）。你说：「换个角度」"],
    ]);
    expect(timelineItems(ui, conversation).map((it) => (it.kind === "record" ? `记录 ${it.record.type === "timeline" ? it.record.timeline.kind : ""}` : it.kind === "message" ? it.message.id : it.kind))).toEqual(["m1", "记录 reopen"]);
  });

  test("尝试记录：维护者宣布完成时写的那句取卡上的，你退回时写的说明挂在同一次上（脚本的备注不算）；重开按事件上写的范围", () => {
    const facts = stageDetailFacts(ui, items, "t-r", "s1");
    expect(facts.attempts).toEqual([
      { kind: "attempt", at: at("09:00"), passed: false, failed: ["你看过草稿"], note: "草稿写好了", userNote: "营销号的来源去掉", itemId: expect.any(String) },
      { kind: "reopen", at: at("10:00"), scope: ["s1", "s2"] },
    ]);
    expect(ui.taskReopens["t-r"]).toEqual([{ time: at("10:00"), stageIds: ["s1", "s2"] }]);
  });

  test("从这里重做的范围只算开始过的下游（和守护进程一个口径）；照 AgentSense 阶段开始过就能重做（用户 2026-10-11 定）", () => {
    const refs = [
      { stageId: "a", dependsOn: [], started: true },
      { stageId: "b", dependsOn: ["a"], started: true },
      { stageId: "c", dependsOn: ["b"], started: false },
    ];
    expect(reopenScope(refs, "a", (s) => s.started)).toEqual(["a", "b"]);
    expect(reopenScope(refs, "c", (s) => s.started)).toEqual(["c"]);
    const running = task("running", [["s1", "accepted"], ["s2", "running"]], at("11:00"));
    expect([canReopenStage(running, "s1"), canReopenStage(running, "s2")]).toEqual([true, true]);
    const fresh = task("running", [["s1", "running"], ["s2", "pending"]], at("11:00"));
    expect(canReopenStage(fresh, "s2")).toBe(false);
    // 开始过又放下的（startedAt 还在）也算开始过
    expect(canReopenStage(task("running", [["s1", "running"], ["s2", "pending", at("10:30")]], at("11:00")), "s2")).toBe(true);
    // 等我（哪种原因都行）、暂停、排队、失败、已完成都能；取消了、归档了的不能
    for (const state of ["waiting_for_user", "paused", "queued", "failed", "done"] as const) expect(canReopenStage({ ...running, state, ...(state === "waiting_for_user" ? { waitReason: "interrupted" as const } : {}) }, "s1")).toBe(true);
    for (const state of ["cancelled", "archived"] as const) expect(canReopenStage({ ...running, state }, "s1")).toBe(false);
  });

  test("要你留意的：算授权的授权项按守护进程给的 outward 分“权”“外”（旧的授权说法没有它的算本机）；“问”是计划停点里落在这个阶段上的", () => {
    const grants: PlanGrant[] = [
      { id: "g-write", tool: "write", title: "写报告", scope: { path: "out" }, maxUses: 5 },
      { id: "g-push", tool: "git_push", title: "推送", scope: {}, maxUses: 1 },
      { id: "g-mail", tool: "send_mail", title: "发邮件", scope: {} },
      { id: "g-rm", tool: "delete", title: "删旧稿", scope: {} },
      { id: "g-pay", tool: "pay", title: "付款", scope: {} },
    ];
    const info = {
      "g-write": { toolTitle: "写文件", categoryTitles: ["删除或覆盖"], disposition: "do" as const, outward: false },
      "g-push": { toolTitle: "git 推送", categoryTitles: [], disposition: "do" as const, outward: true },
      "g-mail": { toolTitle: "发邮件", categoryTitles: ["以我的名义对外发送或发布"], disposition: "do_then_tell" as const },
      "g-rm": { toolTitle: "删除", categoryTitles: ["删除或覆盖"], disposition: "ask_first" as const },
      "g-pay": { toolTitle: "付款", categoryTitles: [], disposition: "hand_to_me" as const },
    };
    const plan = {
      stages: [
        { stageId: "s0", title: "准备", dependsOn: [], acceptance: [{ criterion: "你看过提纲", method: "user" }], policy: { grants: [], temporalRules: [] } },
        { stageId: "s1", title: "写稿", dependsOn: ["s0"], acceptance: [{ criterion: "格式对", method: "script" }, { criterion: "你看过草稿", method: "user" }], policy: { grants, temporalRules: [] } },
      ],
      stageGroups: [],
    } as unknown as Plan;
    const marks = stageMarks({ plan, grantInfo: info, narrowedGrants: ["g-write"] }, "s1", grants);
    expect(marks.perm.map((m) => [m.grantId, m.limit])).toEqual([
      ["g-write", 5],
      ["g-mail", undefined],
    ]);
    expect(marks.out.map((m) => [m.grantId, m.limit])).toEqual([["g-push", 1]]);
    // 和计划卡上"执行时会在哪几处停下来"同一份（协议包的 stageStops）：别的阶段由你验收的不算
    expect(marks.ask.map((m) => m.text)).toEqual([
      "第 2 阶段「写稿」由你验收",
      expect.stringMatching(/^第 2 阶段「写稿」：写文件（write）.*（收窄了，超出的部分执行时问你）$/),
      expect.stringMatching(/^第 2 阶段「写稿」：删除（delete）.*（落在「先问我」类别里/),
      expect.stringMatching(/^第 2 阶段「写稿」：付款（pay）.*（落在「交给我做」类别里/),
    ]);
  });

  test("规则详情：长程任务一个阶段的规则没有规划时的审查，算通过、生效阶段是执行时；违反之后怎么办分三级", () => {
    const rule = { id: "test-before-push", title: "push 之前必须跑过测试", trigger: { tool: "git_push" }, require: { before: { tool: "run_tests" } }, on_violation: "pull_back" };
    const entry = ruleBookEntry(rule, undefined, ["runtime"]);
    expect([entry.status, entry.modes, entry.onViolation, entry.formula.formula, entry.violations, entry.chosen]).toEqual(["ok", "执行时", "违反时退回，先补上再做", "G( 调用(git_push)  →  O(调用(run_tests)) )", [], []]);
    expect([onViolationOf(rule), onViolationOf({ on_violation: "block" }), onViolationOf({})].map((v) => ON_VIOLATION_TEXT[v])).toEqual(["违反时退回，先补上再做", "违反就不做", "违反时先问你"]);
  });
});

// ───────────────────────── 规则的写法（state/ltl.ts，照 AgentSense ltl.ts） ─────────────────────────

describe("规则写成公式", () => {
  const rule = { id: "write-before-read", trigger: { tool: "read" }, require: { before: { tool: "write" } }, on_violation: "pull_back", repairs: [{ replan: { text: "先写再读" } }, { move_after: { tool: "write" }, cost: { ops: 1 } }] };

  test("中文形式化：只看过去的时序逻辑；接口写法", () => {
    expect(formulaOf(rule)).toEqual({ formula: "G( 调用(read)  →  O(调用(write)) )", antecedent: "调用(read)", consequent: "调用(write)", past: true, negated: false });
    expect(apiFormulaOf(rule)).toBe("G( read(…)  →  O( write(…) ) )");
    expect(expr({ and: [{ eq: ["$p.replaced", true] }, { eq: ["$p.area", "project"] }] })).toBe('($p.replaced = true ∧ $p.area = "project")');
  });

  test("修法和代价：说法换成维护者、你", () => {
    expect(repairsOf(rule)).toEqual([
      { kind: "replan", title: "退回维护者重写：先写再读", costs: {} },
      { kind: "move_after", title: "把这一步挪到 write 之后", costs: { ops: 1 } },
    ]);
    expect(costText({ interaction: 1, ops: 2 })).toBe("打扰用户 1、多做动作 2");
  });
});
