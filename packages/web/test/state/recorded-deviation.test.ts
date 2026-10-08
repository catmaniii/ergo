// 前端状态层回放 14 号票（偏离、阈值与计划变更）主切面录下的事件流：
// - task-plan-change（plan-change.test.ts）：计划变更卡（只列变化）、只停受影响的阶段、拒绝、自行调整计划（时间线上一条记录，
//   阶段抽屉按现在生效的计划显示）、做不了转等我；
// - task-over-budget（deviation.test.ts）：用量超过预算让维护者说明进展（状态不变），超过 2 倍转等我（超预算）、追加预算继续；
// - task-rejections（deviation.test.ts）：授权内的一笔、累计被拒 5 次转已暂停；
// - task-nudge（stall-renewal.test.ts）：无进展的催促、催满了转等我（卡住求助）；
// 偏离、计划变更、自行调整计划都是时间线上的记录（timeline_record），要点层里各占一行。
// - grant-renewal（stall-renewal.test.ts）：授权到期前一天的续期事项、续期和不续、过期后的审批卡。
// 重新录：ERGOU_RECORD_EVENTS=1 npx vitest run packages/daemon/test/main/deviation.test.ts packages/daemon/test/main/plan-change.test.ts packages/daemon/test/main/stall-renewal.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  conversationView,
  gistView,
  inboxEntries,
  type MessagePart,
  type PlanChangeCardPayload,
  planChangeAffectedText,
  planChangeConfirmInput,
  planChangeLines,
  replay,
  selectCard,
  selectTask,
  taskControls,
  taskStages,
  taskStatusText,
  timelineItems,
  type TimelineRecord,
  type UiInput,
  type UiState,
} from "../../src/state/index.ts";
import { msg } from "./events.ts";

function load(name: string): UiInput[] {
  return JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "recordings", `${name}.json`), "utf8")) as UiInput[];
}

/** 看板上任务 t-1 的某种变化（第 nth 次）在事件流里的下标 */
function atChange(inputs: readonly UiInput[], change: string, nth = 0): number {
  const at = inputs.flatMap((i, j) => (i.kind === "frame" && i.frame.type === "task" && (i.frame.payload as { change: string }).change === change ? [j] : []))[nth];
  if (at === undefined) throw new Error(`录好的事件流里没有任务变化 ${change}`);
  return at;
}

const stateAt = (inputs: readonly UiInput[], index: number) => replay(inputs.slice(0, index + 1));
const maintainer = (state: UiState) => conversationView(state, "maintainer:tm-1");
/** 维护者会话里系统说的话（交给维护者的通知、只给人看的说明） */
const systemTexts = (state: UiState) =>
  maintainer(state)
    .filter((it) => it.kind === "message" && msg(it).speaker === "system")
    .map((it) => msg(it).parts.map((p) => ("text" in p ? p.text : "")).join(""));
const toolCalls = (state: UiState) =>
  maintainer(state)
    .flatMap((it) => (it.kind === "message" ? msg(it).parts : []))
    .filter((p): p is Extract<MessagePart, { type: "tool_call" }> => p.type === "tool_call");
const notices = (state: UiState, notice: string) => Object.values(state.inbox).filter((i) => i.kind === "notice" && i.notice === notice);
/** 维护者会话的时间线上的记录（偏离、计划变更、自行调整计划……） */
const records = (state: UiState): TimelineRecord[] =>
  timelineItems(state, "maintainer:tm-1").flatMap((it) => (it.kind === "record" && it.record.type === "timeline" ? [it.record.timeline] : []));
/** 要点层里这些记录的种类（按出现的先后） */
const gistRecordKinds = (state: UiState) =>
  gistView(state, "maintainer:tm-1").flatMap((row) => (row.kind === "marks" ? row.marks.filter((m) => m.severity !== undefined).map((m) => m.kind) : []));

describe("回放：计划变更、拒绝、重排、做不了（task-plan-change）", () => {
  const inputs = load("task-plan-change");
  const proposed = atChange(inputs, "plan_change_proposed");

  test("提交计划变更：待我处理里是一张卡着任务的计划变更卡，卡上只列变化（新增授权，可以勾掉），只有 s1 停下等、s2 照常推进", () => {
    const state = stateAt(inputs, atChange(inputs, "stage_started", 1));
    const entry = inboxEntries(state, "open").find((e) => e.card?.card.type === "plan_change")!;
    expect(entry).toMatchObject({ item: { kind: "card", urgency: "blocking" }, processed: false });
    const payload = entry.card!.card.payload as PlanChangeCardPayload;
    const lines = planChangeLines(payload);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ expands: true, grantId: "dir1" });
    expect(lines[0]!.text).toMatch(/^新增授权（阶段 s1「收集资料」）：/);
    expect(planChangeAffectedText(payload)).toBe("只有这些阶段停下来等：s1「收集资料」；其余照常推进");
    expect(planChangeConfirmInput(new Set(["dir1"]))).toEqual({ removeGrants: ["dir1"] });
    // 任务还在执行中：s1 等计划变更（写明为什么），s2 开始了
    expect(selectTask(state, "t-1")?.state).toBe("running");
    expect(taskStages(state, "t-1").map((s) => [s.stageId, s.state, s.waitReason ?? null])).toEqual([
      ["s1", "waiting", "plan_change"],
      ["s2", "running", null],
    ]);
    expect(taskStages(state, "t-1")[0]!.waitNote).toBe("资料要放到外面的共享目录");
    expect(proposed).toBeGreaterThan(0);
  });

  test("用户拒绝：卡记成已处理（拒绝，带说明）；维护者在现有授权内自行调整计划，时间线上记一笔、不出新卡；阶段抽屉显示调整后现在生效的计划", () => {
    const end = replay(inputs);
    const cards = Object.values(end.cards).filter((c) => c.card.type === "plan_change");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.card).toMatchObject({ status: "handled", outcome: { action: "reject", note: "别动外面的目录" } });
    // 时间线上的记录：拒绝了计划变更、自行调整计划（详细说明列出改了什么），要点层里各一行
    expect(records(end).map((r) => [r.kind, r.summary])).toContainEqual(["plan_change", "你拒绝了计划变更（第 2 版），受影响的阶段交回维护者在现有授权内重排"]);
    const revision = records(end).find((r) => r.kind === "plan_revision")!;
    expect(revision.summary).toBe("维护者自行调整了计划（第 3 版，不扩大授权）：先写报告，资料只在工作目录里整理");
    expect(revision.detail).toContain("步骤");
    expect(gistRecordKinds(end)).toEqual(expect.arrayContaining(["plan_change", "plan_revision", "deviation"]));
    // 重排后的阶段顺序：s2 在前；阶段抽屉按看板上推来的现在生效的计划（第 3 版）：s1 改成了定步
    const state = stateAt(inputs, atChange(inputs, "plan_revised"));
    expect(selectTask(state, "t-1")?.stages?.list?.map((s) => s.stageId)).toEqual(["s2", "s1"]);
    expect(end.taskPlans["t-1"]).toMatchObject({ planId: "t-1-p3", revision: 3 });
    const s1 = taskStages(end, "t-1").find((s) => s.stageId === "s1")!;
    expect(s1).toMatchObject({ n: 2, mode: "steps", steps: ["只整理工作目录里已有的资料", "写清单"], deliverables: ["资料清单 sources.md"] });
    expect(s1.grants).toEqual([]);
  });

  test("做不了：s1 停下（卡住求助），s2 做完后任务转等我；看板写明原因，待我处理出现卡住求助", () => {
    const end = replay(inputs);
    const task = selectTask(end, "t-1")!;
    expect(taskStatusText(task)).toBe("等我 · 卡住求助");
    expect(task.waitNote).toBe("做不了：工作目录里没有资料，不建外面的目录就收集不了");
    expect(taskStages(end, "t-1").find((s) => s.stageId === "s1")).toMatchObject({ state: "waiting", waitReason: "stuck", waitNote: "做不了：工作目录里没有资料，不建外面的目录就收集不了" });
    // 停下这一支是一条偏离记录（属于 s1）
    expect(records(end).find((r) => r.kind === "deviation")?.summary).toContain("做不了：工作目录里没有资料");
    expect(notices(end, "stuck_help")).toMatchObject([{ urgency: "blocking", actions: ["继续执行"] }]);
    expect(taskControls(task).map((c) => c.action)).toEqual(["pause", "resume", "cancel"]);
  });
});

describe("回放：预算（task-over-budget）", () => {
  const inputs = load("task-over-budget");

  test("用量超过预算：维护者会话里一条说明进展的通知，任务状态不变，时间线上一条偏离；之后它报了一次进展", () => {
    const explain = inputs.findIndex((i) => i.kind === "frame" && i.frame.type === "message" && JSON.stringify(i.frame.payload).includes("用量已经超过预算"));
    expect(explain).toBeGreaterThan(0);
    const state = stateAt(inputs, explain);
    expect(selectTask(state, "t-1")?.state).toBe("running");
    expect(taskStatusText(selectTask(state, "t-1")!)).toBe("执行中");
    expect(records(replay(inputs)).map((r) => r.kind)).toEqual(["deviation", "deviation"]);
  });

  test("超过 2 倍：转等我（超预算），看板写明原因；待我处理出现超预算事项，能在任务详情里继续执行", () => {
    const state = stateAt(inputs, atChange(inputs, "waiting"));
    const task = selectTask(state, "t-1")!;
    expect(taskStatusText(task)).toBe("等我 · 超预算");
    expect(taskStages(state, "t-1")[0]).toMatchObject({ state: "waiting", waitReason: "over_budget" });
    expect(taskStages(state, "t-1")[0]!.waitNote).toMatch(/用了 \d+ token、5 次工具调用（预算 0 token、2 次），超过预算的 2 倍/);
    const end = replay(inputs);
    expect(notices(end, "over_budget")).toMatchObject([{ urgency: "blocking", actions: ["追加预算继续"], handled: "追加预算继续" }]);
    expect(taskControls(task).map((c) => c.action)).toContain("resume");
  });

  test("追加预算继续：回到执行中，s1 验收通过", () => {
    const end = replay(inputs);
    expect(selectTask(end, "t-1")?.state).toBe("running");
    expect(taskStages(end, "t-1")[0]?.state).toBe("accepted");
  });
});

describe("回放：授权内的一笔、累计被拒（task-rejections）", () => {
  const inputs = load("task-rejections");

  test("授权内的调用只在时间线上记一笔（做、授权内、已执行），没有审批卡；超出授权的五次都问过", () => {
    const end = replay(inputs);
    const calls = toolCalls(end).filter((p) => p.tool === "bash");
    expect(calls[0]).toMatchObject({ disposition: "do", withinGrant: true, outcome: "done" });
    expect(calls.slice(1).map((p) => [p.disposition, p.withinGrant, p.outcome])).toEqual(Array.from({ length: 5 }, () => ["ask_first", false, "denied"]));
    expect(Object.values(end.cards).filter((c) => c.card.type === "approval")).toHaveLength(5);
  });

  test("累计被拒 5 次：整个任务转已暂停，看板写明原因；继续后原因去掉", () => {
    const paused = stateAt(inputs, atChange(inputs, "paused"));
    expect(taskStatusText(selectTask(paused, "t-1")!)).toBe("已暂停 · 累计被拒");
    expect(records(stateAt(inputs, atChange(inputs, "paused") + 1)).some((r) => r.kind === "deviation" && r.summary.includes("累计拒绝了 5 次"))).toBe(true);
    const end = replay(inputs);
    expect(taskStatusText(selectTask(end, "t-1")!)).toBe("执行中");
  });
});

describe("回放：无进展的催促（task-nudge）", () => {
  const inputs = load("task-nudge");

  test("催促是维护者会话里的系统通知，写明第几次；中间有了进展计数清零；催满了转等我（卡住求助）", () => {
    const end = replay(inputs);
    const nudges = systemTexts(end).filter((t) => t.includes("次催促"));
    expect(nudges.map((t) => /第 (\d)\/3 次催促/.exec(t)?.[1])).toEqual(["1", "2", "1", "2", "1", "2", "3"]);
    const task = selectTask(end, "t-1")!;
    expect(taskStatusText(task)).toBe("等我 · 卡住求助");
    expect(task.waitNote).toBe("20 分钟没有进展，催了 3 次仍没有进展");
    expect(notices(end, "stuck_help")).toHaveLength(1);
    // 每次催促、最后停下都是时间线上的一条偏离（要点层里各占一行）
    expect(records(end).filter((r) => r.kind === "deviation")).toHaveLength(8);
    expect(gistRecordKinds(end).filter((k) => k === "deviation")).toHaveLength(8);
  });
});

describe("回放：授权项续期（grant-renewal）", () => {
  const inputs = load("grant-renewal");

  test("到期前一天出现续期事项（不卡任务）；一次续期、一次不续；过期后的那次出了审批卡", () => {
    const end = replay(inputs);
    const renewals = notices(end, "grant_renewal");
    expect(renewals).toMatchObject([
      { urgency: "non_blocking", actions: ["续期", "不续"], handled: "续期" },
      { urgency: "non_blocking", actions: ["续期", "不续"], handled: "不续" },
    ]);
    expect(renewals[0]!.kind === "notice" && renewals[0]!.body).toContain("建 s1 目录");
    const approval = Object.values(end.cards).find((c) => c.card.type === "approval")!;
    expect(JSON.stringify(selectCard(end, approval.card.id)?.card.payload)).toContain("已过期");
    expect(selectTask(end, "t-1")?.state).toBe("running");
  });
});
