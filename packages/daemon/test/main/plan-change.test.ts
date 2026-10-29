// 主切面：计划变更和自行调整计划（规格第 8 节"计划变更"、第 5 节卡片，14 号票）。真的守护进程，维护者接 faux 剧本。
// - 维护者提交计划变更（扩大授权、加能力……）：待我处理出现计划变更卡，卡上只列变化的部分；只有受影响的阶段停下等确认，
//   其余阶段照常推进；用户确认后计划和授权项随之更新，受影响的阶段恢复，工具包变了维护者按新工具包重新拉起；
//   看板上推一条 task_plan（阶段抽屉显示现在生效的计划），时间线上记一笔计划变更；
// - 改目标、任务的验收标准的计划变更确认后：任务书换成新的一版，重注入块和下一次比较都用新的；
// - 用户拒绝：维护者在现有授权内重排（revise_plan 自行调整计划，记进时间线、不出卡），做不到就标做不了，任务转等我；
// - 不扩大授权的调整直接改；借调整扩大授权的被拒，提示改走计划变更；不扩大授权的变更也不出卡，提示直接调整；
//   同一任务一次只有一张计划变更卡在等；
// - 收窄工具包的计划变更确认后：维护者按新工具包重新拉起，活着的子 agent 做完手头这一步后按新的交集重新装配（20 号票的 reassemble）；
// - 阶段编号存进计划（93 号票）：第一版按依赖层定，调整时已有的不变、新加的按所在的阶段给号；看板上的阶段、进度卡写编号。
import fs from "node:fs";
import path from "node:path";
import { CHANNELS, EVENT_TYPES, maintainerChannel, type Plan, type PlanCardPayload, type PlanChangeCardPayload, type ProgressCardPayload, type TaskPlanEventPayload } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import {
  call,
  cardsOf,
  cardWhere,
  completeStage,
  confirmTask,
  connect,
  draftTask,
  eventually,
  fwd,
  inputsDone,
  itemWhere,
  maintainerScript,
  messagesOf,
  noticesOf,
  ok,
  real,
  recordsOf,
  say,
  stageStates,
  taskWhere,
  textOf,
  toolCallsOf,
  twoStagePlan,
  write,
} from "../helpers/task-flow.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const M1 = maintainerChannel("tm-1");

/** 两个互不依赖的阶段：s1 收集资料、s2 写报告；不联网 */
function parallelPlan(): Plan {
  const base = twoStagePlan();
  return { ...base, stages: [base.stages[0]!, { ...base.stages[1]!, dependsOn: [] }], toolkit: { ...base.toolkit, network: false } };
}

/** 维护者交的计划（本任务的关注类别、用户的限制、定时作业、记忆范围沿用当前计划，不写） */
function draftOf(plan: Plan): Record<string, unknown> {
  const { watchCategories: _w, userLimits: _u, memoryScope: _m, ...rest } = plan;
  return rest;
}

/** s1 加一项在 outside/s1 建目录的授权 */
function withDirGrant(plan: Plan, outside: string): Plan {
  return {
    ...plan,
    stages: plan.stages.map((s) => (s.stageId === "s1" ? { ...s, policy: { ...s.policy, grants: [{ id: "dir1", tool: "make_dir", title: "建 s1 目录", scope: { path: path.join(outside, "s1") } }] } } : s)),
  };
}

const propose = (plan: Plan, why: string, extra: Record<string, unknown> = {}): FauxStep => call("propose_plan_change", { plan: draftOf(plan), why, ...extra });
const revise = (plan: Plan, why: string): FauxStep => call("revise_plan", { plan: draftOf(plan), why });

describe("计划变更", () => {
  it("提交计划变更：出卡（只列变化），只有受影响的阶段停下、其余照常推进；确认后计划和授权更新、受影响的阶段恢复，工具包变了维护者按新工具包重新拉起", async () => {
    const outside = real(makeTempDir("ergo-out-"));
    const plan = parallelPlan();
    const changed: Plan = { ...withDirGrant(plan, outside), toolkit: { ...plan.toolkit, network: true } };
    const spawns: number[] = [];
    const td = await startTestDaemon({
      maintainer: maintainerScript(plan, (spawn) => {
        spawns.push(spawn);
        return spawn === 2
          ? [propose(changed, "资料要放到外面的共享目录，还要联网查"), write("report.md", "# 报告\n"), completeStage("s2"), say("s2 做完了，等你确认 s1 的变更")]
          : [call("bash", { command: `mkdir -p "${fwd(path.join(outside, "s1"))}"` }), write("sources.md", "- 来源\n"), completeStage("s1"), say("全做完了")];
      }),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "计划变更");

    // 计划变更卡：只列变化的部分（新增授权、工具包），停下的只有 s1；进待我处理（卡着任务）
    const card = await cardWhere(frontend, (c) => c.type === "plan_change", "计划变更卡");
    const payload = card.payload as PlanChangeCardPayload;
    expect(payload).toMatchObject({ taskId, revision: 2, basePlanId: `${taskId}-p1`, why: "资料要放到外面的共享目录，还要联网查", affectedStages: [{ stageId: "s1", title: "收集资料" }] });
    expect(payload.changes.map((c) => [c.kind, c.expands])).toEqual([
      ["grant_added", true],
      ["toolkit", true],
    ]);
    await itemWhere(frontend, (i) => i.kind === "card" && i.cardId === card.id && i.urgency === "blocking", "待我处理里的计划变更卡");
    const proposed = await taskWhere(frontend, (e) => e.change === "plan_change_proposed");
    expect(proposed).toMatchObject({ by: "maintainer", task: { state: "running" } });
    expect(proposed.task.stages?.list?.[0]).toMatchObject({ stageId: "s1", state: "waiting", waitReason: "plan_change", waitingOn: card.id });
    // 其余阶段照常推进：s2 开始、做完验收；之后只剩 s1 在等，任务转等我（计划变更）
    await taskWhere(frontend, (e) => e.change === "stage_accepted" && e.stageId === "s2", "s2 验收通过");
    const waiting = await taskWhere(frontend, (e) => e.change === "waiting", "转等我");
    expect(waiting.task).toMatchObject({ state: "waiting_for_user", waitReason: "plan_change" });
    expect(waiting.task.waitNote).toBe("资料要放到外面的共享目录，还要联网查");
    const result = toolCallsOf(frontend, M1).find((c) => c.tool === "propose_plan_change")!;
    expect(result.resultSummary).toContain("计划变更卡");

    // 确认：计划第 2 版生效（授权、工具包），s1 恢复；任务详情的计划取这张卡
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));
    const changedEvent = await taskWhere(frontend, (e) => e.change === "plan_changed");
    expect(changedEvent).toMatchObject({ by: "user", task: { planCardId: card.id } });
    const stored = td.daemon.tasks.confirmedPlan(taskId)!;
    expect(stored).toMatchObject({ planId: `${taskId}-p2`, revision: 2, status: "confirmed" });
    expect(stored.plan.toolkit.network).toBe(true);
    expect(stored.plan.stages[0]!.policy.grants.map((g) => g.id)).toEqual(["dir1"]);
    // 计划变更沿用当前计划的关注类别、定时作业、记忆范围
    expect(stored.plan.watchCategories).toEqual(td.daemon.tasks.plan(`${taskId}-p1`)!.plan.watchCategories);
    // 看板上推一条现在生效的计划（阶段抽屉按它显示：s1 有了新授权）；时间线上记一笔计划变更
    const effective = await eventually(() => taskPlansOf(frontend), (p) => p.planId === `${taskId}-p2`, "现在生效的计划");
    expect(effective).toMatchObject({ taskId, revision: 2 });
    expect(effective.plan.stages[0]!.policy.grants.map((g) => g.id)).toEqual(["dir1"]);
    expect(effective.grantInfo.dir1).toBeDefined();
    expect(recordsOf(frontend, M1).find((r) => r.record.kind === "plan_change")?.record.summary).toBe("你确认了计划变更（第 2 版）：资料要放到外面的共享目录，还要联网查");
    const confirmed = await eventually(() => noticesOf(frontend, M1), (m) => textOf(m).includes("用户确认了计划变更"), "确认的通知");
    expect(textOf(confirmed)).toContain("工具包已变更");
    expect(textOf(confirmed)).toContain("阶段 s1「收集资料」可以接着做了");

    // 工具包变了：维护者按新工具包重新拉起（第 3 次），新授权内的操作放行
    await taskWhere(frontend, (e) => e.change === "completed", "任务完成");
    expect(spawns).toContain(3);
    const mkdir = toolCallsOf(frontend, M1).find((c) => c.tool === "bash")!;
    expect([mkdir.disposition, mkdir.withinGrant, mkdir.outcome]).toEqual(["do", true, "done"]);
    expect(fs.existsSync(path.join(outside, "s1"))).toBe(true);
    // 确认是审批决定的素材（计划变更卡）
    await waitUntil(() => td.daemon.materials.list({ kind: "approval_decision" }).some((m) => m.context.includes("card:plan_change")), { timeoutMs: 10_000, describe: () => "计划变更的素材" });
    const material = td.daemon.materials.list({ kind: "approval_decision" }).find((m) => m.context.includes("card:plan_change"))!;
    expect(material.context).toContain("decision:confirmed");
  }, 90_000);

  it("用户拒绝：受影响的阶段交回维护者在现有授权内重排（记进时间线、不出卡）；借调整扩大授权被拒；做不到就标做不了，其余阶段做完后任务转等我", async () => {
    const outside = real(makeTempDir("ergo-out-"));
    const plan = parallelPlan();
    const widened = withDirGrant(plan, outside);
    // 现有授权内重排：s2 排到前面，s1 改成按步骤做（只整理工作目录里已有的资料）
    const rearranged: Plan = { ...plan, stages: [plan.stages[1]!, { ...plan.stages[0]!, mode: "steps", steps: ["只整理工作目录里已有的资料", "写清单"] }] };
    const td = await startTestDaemon({
      maintainer: maintainerScript(plan, [
        propose(widened, "资料要放到外面的共享目录"),
        say("等你确认"),
        // 被拒之后：不扩大授权的变更不出卡；借调整扩大授权被拒；在现有授权内重排；还是做不到，标做不了
        propose(rearranged, "换个顺序"),
        revise(widened, "还是想建外面的目录"),
        revise(rearranged, "先写报告，资料只在工作目录里整理"),
        call("mark_infeasible", { stageIds: ["s1"], reason: "工作目录里没有资料，不建外面的目录就收集不了" }),
        write("report.md", "# 报告\n"),
        completeStage("s2"),
        say("s1 做不了，s2 做完了"),
        say("等你拍板"),
      ]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "拒绝");

    const card = await cardWhere(frontend, (c) => c.type === "plan_change", "计划变更卡");
    await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s2", "s2 照常开始");
    await inputsDone(frontend, M1);
    ok(await frontend.cardAction({ cardId: card.id, action: "reject", expectedVersion: card.version, note: "别动外面的目录" }));
    const rejected = await taskWhere(frontend, (e) => e.change === "plan_change_rejected");
    expect(rejected.task.stages?.list?.[0]).toMatchObject({ stageId: "s1", state: "pending" });
    await taskWhere(frontend, (e) => e.change === "rejection_counted" && e.task.rejections === 1, "累计被拒 1 次");
    expect(td.daemon.tasks.plan(`${taskId}-p2`)?.status).toBe("rejected");
    const notice = await eventually(() => noticesOf(frontend, M1), (m) => textOf(m).includes("用户拒绝了计划变更"), "拒绝的通知");
    expect(textOf(notice)).toContain("「别动外面的目录」");
    expect(textOf(notice)).toContain("revise_plan");

    expect(recordsOf(frontend, M1).find((r) => r.record.kind === "plan_change")?.record.summary).toBe("你拒绝了计划变更（第 2 版），受影响的阶段交回维护者在现有授权内重排");

    // 自行调整（重排）：不出卡，计划第 3 版直接生效，时间线记一笔（timeline_record：自行调整计划），看板上推现在生效的计划
    const revised = await taskWhere(frontend, (e) => e.change === "plan_revised");
    expect(revised.by).toBe("maintainer");
    expect(revised.task.stages?.list?.map((s) => s.stageId)).toEqual(["s2", "s1"]);
    expect(td.daemon.tasks.confirmedPlan(taskId)).toMatchObject({ planId: `${taskId}-p3`, revision: 3 });
    expect(td.daemon.tasks.confirmedPlan(taskId)!.plan.stages[1]!.steps).toEqual(["只整理工作目录里已有的资料", "写清单"]);
    const record = await eventually(() => recordsOf(frontend, M1), (r) => r.record.kind === "plan_revision", "时间线上的自行调整记录");
    expect(record.record.summary).toBe("维护者自行调整了计划（第 3 版，不扩大授权）：先写报告，资料只在工作目录里整理");
    expect(record.record.detail).toContain("步骤");
    const effective = await eventually(() => taskPlansOf(frontend), (p) => p.planId === `${taskId}-p3`, "现在生效的计划");
    expect(effective.plan.stages.map((s) => s.stageId)).toEqual(["s2", "s1"]);
    expect(latestPlanChangeCards(frontend)).toEqual([card.id]);

    // 做不了：s1 停下（卡住求助），s2 做完后任务转等我
    const waiting = await taskWhere(frontend, (e) => e.change === "waiting", "转等我");
    expect(waiting.task).toMatchObject({ state: "waiting_for_user", waitReason: "stuck" });
    expect(waiting.task.waitNote).toContain("做不了：工作目录里没有资料");
    expect(stageStates(waiting.task)).toEqual({ s2: "accepted", s1: "waiting" });
    const help = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "stuck_help");
    expect(help).toMatchObject({ data: { taskId, stageIds: ["s1"] } });

    // 工具的结论：不扩大授权的变更不出卡（提示直接调整）；借调整扩大授权被拒（提示改走计划变更）
    const calls = toolCallsOf(frontend, M1);
    const proposes = calls.filter((c) => c.tool === "propose_plan_change");
    expect(proposes[1]!.resultSummary).toContain("revise_plan");
    const revises = calls.filter((c) => c.tool === "revise_plan");
    expect(revises[0]!.resultSummary).toContain("propose_plan_change");
    expect(revises[1]!.resultSummary).toContain("计划已自行调整（第 3 版）");
    // 拒绝也是审批决定的素材（带上用户写的话）
    await waitUntil(() => td.daemon.materials.list({ kind: "approval_decision" }).some((m) => m.context.includes("card:plan_change")), { timeoutMs: 10_000, describe: () => "拒绝的素材" });
    expect(td.daemon.materials.list({ kind: "approval_decision" }).find((m) => m.context.includes("card:plan_change"))!.context).toContain("decision:rejected");
    // 给 Web 的回放：计划变更卡（只列变化）、只停受影响的阶段、拒绝、重排记进时间线、做不了转等我
    await inputsDone(frontend, M1);
    saveOrCheckRecording("task-plan-change", frontend.recording, { perChannel: true });
  }, 90_000);
});

/** 三个阶段：s1 收集资料，之后 s2 写报告、s3 写摘要（都只依赖 s1）；不联网 */
function threeStagePlan(): Plan {
  const plan = twoStagePlan({ toolkit: { ...twoStagePlan().toolkit, network: false } });
  const [s1, s2] = plan.stages;
  const s3 = { ...s2!, stageId: "s3", title: "写摘要", deliverables: ["摘要 summary.md"], acceptance: [{ criterion: "摘要文件存在", method: "script" as const, script: "test -f summary.md" }] };
  return { ...plan, stages: [s1!, s2!, s3] };
}

describe("计划变更只交要改的阶段（121 号票）", () => {
  it("只交一个没验收的阶段（前置是已验收的）能提出计划变更、只停它；交全部阶段时已验收的阶段有细小出入按现在的定义保留；自行调整也能只交改动的阶段；被拒时说清是哪一处", async () => {
    const plan = threeStagePlan();
    const [s1, s2, s3] = plan.stages;
    // 第一次：只交 s2（验收口径改了），别的栏照写——前置 s1 已验收，从当前计划原样带上
    const s2Once = { ...s2!, acceptance: [{ criterion: "报告文件存在（不用等满一周）", method: "script" as const, script: "test -f report.md" }] };
    // 第二次：交全部阶段，已验收的 s1 抄得有一点出入（多了个句号），s2 多一条验收标准
    const s2Twice = { ...s2Once, acceptance: [...s2Once.acceptance, { criterion: "报告不是空的", method: "script" as const, script: "test -s report.md" }] };
    const s1Typo = { ...s1!, acceptance: [{ ...s1!.acceptance[0]!, criterion: "资料清单存在。" }] };
    const td = await startTestDaemon({
      maintainer: maintainerScript(plan, [
        write("sources.md", "- 来源\n"),
        completeStage("s1"),
        call("propose_plan_change", { plan: { ...draftOf(plan), stages: [s2Once] }, why: "用户说不用等满一周" }),
        write("summary.md", "摘要\n"),
        completeStage("s3"),
        say("s3 做完了，等你确认 s2 的变更"),
        call("propose_plan_change", { plan: draftOf({ ...plan, stages: [s1Typo, s2Twice, s3!] }), why: "报告不能是空的" }),
        say("等你确认"),
        // 自行调整：只交改动的阶段（别的栏都不写）；只动了已验收的阶段、要去掉已验收的阶段都被拒，说清哪一处
        call("revise_plan", { plan: { stages: [{ ...s2Twice, title: "写调研报告" }] }, why: "改个名字" }),
        call("revise_plan", { plan: { stages: [s1Typo] }, why: "s1 的标准改一下" }),
        call("revise_plan", { plan: {}, removeStages: ["s1"], why: "不要 s1 了" }),
        write("report.md", "# 报告\n"),
        completeStage("s2"),
        say("全做完了"),
      ]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "只交要改的阶段");
    const first = td.daemon.tasks.confirmedPlan(taskId)!.plan;

    // 只交 s2：出计划变更卡，只改了 s2 的验收标准、只停 s2；s1、s3 原样带上，s3 照常做完
    const card = await cardWhere(frontend, (c) => c.type === "plan_change", "第一张计划变更卡");
    const payload = card.payload as PlanChangeCardPayload;
    expect(payload.changes.map((c) => [c.kind, c.expands])).toEqual([["acceptance", true]]);
    expect(payload.affectedStages.map((s) => s.stageId)).toEqual(["s2"]);
    expect(payload.plan.stages.map((s) => [s.stageId, s.code])).toEqual(first.stages.map((s) => [s.stageId, s.code]));
    expect(payload.plan.stages[0]).toEqual(first.stages[0]);
    expect(payload.plan.stages[2]).toEqual(first.stages[2]);
    await taskWhere(frontend, (e) => e.change === "stage_accepted" && e.stageId === "s3", "s3 照常验收通过");
    await taskWhere(frontend, (e) => e.change === "waiting", "转等我（计划变更）");

    // 确认就生效（不用去任务详情返工）：s2 的验收标准换了
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));
    await taskWhere(frontend, (e) => e.change === "plan_changed");
    const second = td.daemon.tasks.confirmedPlan(taskId)!.plan;
    expect(second.stages[1]!.acceptance.map((a) => a.criterion)).toEqual(["报告文件存在（不用等满一周）"]);
    expect(second.stages[0]).toEqual(first.stages[0]);

    // 交全部阶段、已验收的 s1 有细小出入：不整份拒掉，按现在的定义保留，结果里说明哪一处
    const again = await cardWhere(frontend, (c) => c.type === "plan_change" && c.id !== card.id, "第二张计划变更卡");
    const againPayload = again.payload as PlanChangeCardPayload;
    expect(againPayload.changes.map((c) => [c.kind, c.expands])).toEqual([["acceptance", true]]);
    expect(againPayload.affectedStages.map((s) => s.stageId)).toEqual(["s2"]);
    expect(againPayload.plan.stages[0]).toEqual(first.stages[0]);
    const proposals = toolCallsOf(frontend, M1).filter((c) => c.tool === "propose_plan_change");
    expect(proposals[0]!.resultSummary).toContain("计划变更卡");
    expect(proposals[1]!.resultSummary).toContain("已验收的阶段 s1 交来的定义和现在不一样，已按现在的定义保留");
    expect(proposals[1]!.resultSummary).toContain("验收标准第 1 条");
    await inputsDone(frontend, M1);
    ok(await frontend.cardAction({ cardId: again.id, action: "confirm", expectedVersion: again.version, input: {} }));

    // 自行调整只交 s2：生效；只动了已验收的 s1、要去掉 s1：被拒，说清哪一处
    await taskWhere(frontend, (e) => e.change === "completed", "任务完成");
    const revises = toolCallsOf(frontend, M1).filter((c) => c.tool === "revise_plan");
    expect(revises[0]!.resultSummary).toContain("计划已自行调整（第 4 版）");
    expect(revises[1]!.resultSummary).toContain("和当前计划一样");
    expect(revises[1]!.resultSummary).toContain("阶段 s1 的验收标准第 1 条和现在不一样");
    expect(revises[2]!.resultSummary).toContain("已验收的阶段 s1 不能去掉");
    const last = td.daemon.tasks.confirmedPlan(taskId)!;
    expect(last).toMatchObject({ planId: `${taskId}-p4`, revision: 4 });
    expect(last.plan.stages.map((s) => [s.stageId, s.title])).toEqual([
      ["s1", "收集资料"],
      ["s2", "写调研报告"],
      ["s3", "写摘要"],
    ]);
    expect(last.plan.stages[0]).toEqual(first.stages[0]);
    expect(last.plan.toolkit).toEqual(first.toolkit);
  }, 90_000);
});

describe("阶段编号存进计划（93 号票）", () => {
  it("第一版并行的两个是 1a、1b；计划变更加的阶段按所在的阶段给号（1c、2），已有的不变；看板上的阶段、进度卡写编号", async () => {
    const plan = parallelPlan();
    const added: Plan = {
      ...plan,
      stages: [...plan.stages, { ...plan.stages[1]!, stageId: "s3", title: "补充材料", dependsOn: [] }, { ...plan.stages[1]!, stageId: "s4", title: "排版", dependsOn: ["s1"] }],
    };
    const td = await startTestDaemon({
      maintainer: maintainerScript(plan, [propose(added, "加两个阶段"), say("等你确认"), call("start_stage", { stageId: "s1" }), write("sources.md", "- 来源\n"), completeStage("s1"), say("s1 交了"), say("好"), say("好")]),
    });
    const frontend = await connect(td.url);
    const { taskId, card } = await draftTask(td, frontend, "编号");
    expect((card.payload as PlanCardPayload).plan.stages.map((s) => [s.stageId, s.code])).toEqual([
      ["s1", "1a"],
      ["s2", "1b"],
    ]);
    await inputsDone(frontend, M1);
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));
    const started = await taskWhere(frontend, (e) => e.change === "started", "开始执行");
    expect(started.task.stages?.list?.map((s) => s.code)).toEqual(["1a", "1b"]);

    // 加阶段要用户确认（新阶段带着验收标准）：计划变更卡，确认后生效
    const change = await cardWhere(frontend, (c) => c.type === "plan_change", "计划变更卡");
    expect((change.payload as PlanChangeCardPayload).plan.stages.map((s) => s.code)).toEqual(["1a", "1b", "1c", "2"]);
    await inputsDone(frontend, M1);
    ok(await frontend.cardAction({ cardId: change.id, action: "confirm", expectedVersion: change.version, input: {} }));
    const revised = await taskWhere(frontend, (e) => e.change === "plan_changed", "计划变更生效");
    const codes = { s1: "1a", s2: "1b", s3: "1c", s4: "2" };
    expect(Object.fromEntries(td.daemon.tasks.confirmedPlan(taskId)!.plan.stages.map((s) => [s.stageId, s.code]))).toEqual(codes);
    expect(Object.fromEntries(revised.task.stages!.list!.map((s) => [s.stageId, s.code]))).toEqual(codes);

    const verdict = await cardWhere(frontend, (c) => c.type === "progress" && (c.payload as ProgressCardPayload).stageId === "s1", "s1 的验收结论");
    expect(verdict.payload).toMatchObject({ stageCode: "1a" });
    expect(verdict.text).toContain("第 1a 阶段「收集资料」");
    await inputsDone(frontend, M1);
  }, 90_000);

  it("被拒的计划变更卡上显示过的号也算用过（93 号票评审）：下一张卡上新加的阶段不再拿这个号，旧卡上的号不会指到别的阶段", async () => {
    const plan = parallelPlan();
    const more = (stageId: string, title: string): Plan => ({ ...plan, stages: [...plan.stages, { ...plan.stages[1]!, stageId, title, dependsOn: [] }] });
    const td = await startTestDaemon({
      maintainer: maintainerScript(plan, [propose(more("s3", "补充材料"), "加一个阶段"), say("等你确认"), propose(more("s4", "换个来源"), "换一个阶段"), say("等你确认"), say("好")]),
    });
    const frontend = await connect(td.url);
    const { taskId, card } = await draftTask(td, frontend, "被拒的号");
    await inputsDone(frontend, M1);
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));
    const first = await cardWhere(frontend, (c) => c.type === "plan_change", "第一张计划变更卡");
    expect((first.payload as PlanChangeCardPayload).plan.stages.map((s) => [s.stageId, s.code])).toEqual([
      ["s1", "1a"],
      ["s2", "1b"],
      ["s3", "1c"],
    ]);
    await inputsDone(frontend, M1);
    ok(await frontend.cardAction({ cardId: first.id, action: "reject", expectedVersion: first.version, note: "不用补" }));
    const second = await cardWhere(frontend, (c) => c.type === "plan_change" && c.id !== first.id, "第二张计划变更卡");
    // 1c 在被拒的那张卡上显示过：新加的 s4 拿 1d
    expect((second.payload as PlanChangeCardPayload).plan.stages.map((s) => [s.stageId, s.code])).toEqual([
      ["s1", "1a"],
      ["s2", "1b"],
      ["s4", "1d"],
    ]);
    expect(td.daemon.tasks.usedStageCodes(taskId)).toEqual(expect.arrayContaining(["1a", "1b", "1c", "1d"]));
    await inputsDone(frontend, M1);
  }, 90_000);
});

describe("改目标和任务的验收标准", () => {
  it("确认后任务书换成新的一版：重注入块用新的目标和验收标准，下一次提交跟新的比；同一任务一次只有一张计划变更卡在等", async () => {
    const plan = parallelPlan();
    const td = await startTestDaemon({
      maintainer: maintainerScript(plan, [
        propose(plan, "用户要的其实是对比表", { goal: "整理一份 X 和 Y 的对比表", acceptanceCriteria: ["对比表至少五个维度"] }),
        // 第一张还在等：再交一张被拒
        propose(plan, "再加一条", { acceptanceCriteria: ["对比表至少五个维度", "附上来源"] }),
        say("等你确认"),
        // 确认之后：同样的目标、验收标准再交一次，没有要改的
        propose(plan, "再确认一下", { goal: "整理一份 X 和 Y 的对比表", acceptanceCriteria: ["对比表至少五个维度"] }),
        say("好"),
      ]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "改目标");
    const before = td.daemon.tasks.brief(taskId)!;

    const card = await cardWhere(frontend, (c) => c.type === "plan_change", "计划变更卡");
    const payload = card.payload as PlanChangeCardPayload;
    expect(payload.changes.map((c) => [c.kind, c.expands])).toEqual([
      ["goal", true],
      ["criteria", true],
    ]);
    expect(payload.changes[0]).toMatchObject({ before: before.brief.goal, after: "整理一份 X 和 Y 的对比表" });
    // 不落在具体阶段上的改动：停下手头在做的那个
    expect(payload.affectedStages.map((s) => s.stageId)).toEqual(["s1"]);
    await inputsDone(frontend, M1);
    const second = toolCallsOf(frontend, M1).filter((c) => c.tool === "propose_plan_change")[1]!;
    expect(second.resultSummary).toContain("还在等用户");

    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));
    await taskWhere(frontend, (e) => e.change === "plan_changed");
    // 任务书换成新的一版；重注入块里是新的目标和验收标准
    const after = td.daemon.tasks.brief(taskId)!;
    expect(after.revision).toBe(before.revision + 1);
    expect(after.brief).toMatchObject({ goal: "整理一份 X 和 Y 的对比表", acceptanceCriteria: ["对比表至少五个维度"] });
    const block = td.daemon.taskExecution.contextBlock(taskId)!;
    expect(block).toContain("目标：整理一份 X 和 Y 的对比表");
    expect(block).toContain("任务的验收标准：对比表至少五个维度");
    // 下一次提交跟新的任务书比：一样的目标、验收标准没有要改的
    await inputsDone(frontend, M1);
    const third = toolCallsOf(frontend, M1).filter((c) => c.tool === "propose_plan_change")[2]!;
    expect(third.resultSummary).toContain("和当前计划一样");
    expect(latestPlanChangeCards(frontend)).toEqual([card.id]);
  }, 90_000);
});

describe("收窄工具包的计划变更和子 agent", () => {
  it("确认后维护者按新工具包重新拉起；活着的子 agent 做完手头这一步（当前的工具调用结束）后按新的交集重新装配，接着原来的会话做", async () => {
    const homeDir = makeTempDir("ergo-home-");
    const outside = path.join(homeDir, "参考资料.txt");
    fs.writeFileSync(outside, "参考");
    const plan: Plan = { ...parallelPlan(), toolkit: { ...parallelPlan().toolkit, bash: true } };
    // 关掉 bash（收窄），同时改目标（要用户确认）
    const narrowed: Plan = { ...plan, toolkit: { ...plan.toolkit, bash: false } };
    const td = await startTestDaemon({
      reuse: { dataDir: makeTempDir("ergo-data-"), homeDir },
      maintainer: maintainerScript(plan, (spawn) =>
        spawn === 2
          ? [
              call("propose_parallel", { reason: "两个阶段互不依赖", agents: [{ stageId: "s2", instructions: "读一下参考资料，写报告" }] }),
              say("等你确认并行"),
              propose(narrowed, "不需要 bash 了，目标也改一下", { goal: "整理一份 X 的调研，附对比" }),
              say("等你确认计划变更"),
            ]
          : [say("收到"), say("子 agent 的结果收到了"), say("好")],
      ),
      // 第一次拉起：停在审批上；按新的装配重新拉起后：把看到的上下文原样交回
      subAgent: (_agentId, spawn) => (spawn === 1 ? [call("read", { path: outside }), write("report.md", "# 报告\n"), say("写好了")] : [{ kind: "echo_context" }]),
    });
    const requests = spawnRequests(td);
    const frontend = await connect(td.url);
    await confirmTask(td, frontend, "收窄工具包");

    const parallel = await cardWhere(frontend, (c) => c.type === "parallel", "并行确认卡");
    ok(await frontend.cardAction({ cardId: parallel.id, action: "parallel", expectedVersion: 1 }));
    const approval = await cardWhere(frontend, (c) => c.type === "approval", "sa-1 的审批卡");
    expect(requests().find((r) => r.agentId === "sa-1")).toMatchObject({ continueSession: false });
    expect(requests().find((r) => r.agentId === "sa-1")!.tools).toContain("bash");

    // 计划变更卡：工具包收窄（不扩大）加上改目标；确认
    const card = await cardWhere(frontend, (c) => c.type === "plan_change", "计划变更卡");
    expect((card.payload as PlanChangeCardPayload).changes.map((c) => [c.kind, c.expands])).toEqual([
      ["toolkit", false],
      ["goal", true],
    ]);
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));
    await taskWhere(frontend, (e) => e.change === "plan_changed");
    // sa-1 手头这一步（读文件，在等批准）还没做完：先不动它
    expect(requests().filter((r) => r.agentId === "sa-1")).toHaveLength(1);
    expect(td.daemon.agents.live().map((a) => a.agentId)).toContain("sa-1");

    // 批准：读文件这一步做完，按新的交集重新拉起（接着原来的会话，没有 bash 和带类型的 bash 工具），交给它"工具包已变更"
    ok(await frontend.cardAction({ cardId: approval.id, action: "approve", expectedVersion: approval.version }));
    const result = await eventually(() => messagesOf(frontend, M1), (m) => m.agentId === "sa-1" && m.message.speaker === "system" && m.agentInput === true, "sa-1 交回的结果");
    const again = requests().filter((r) => r.agentId === "sa-1");
    expect(again).toHaveLength(2);
    // 联网搜索、读网页每个会话都配（70 号票），和 bash 开关无关；给秘书发消息维护者有它就有（102 号票）
    expect(again[1]).toMatchObject({ continueSession: true, hostTools: ["web_search", "web_fetch", "tell_secretary"] });
    expect(again[1]!.tools).not.toContain("bash");
    expect(textOf(result)).toContain("工具包已变更");
    // 维护者也按新工具包重新拉起（第 3 次：起草、执行、变更之后；没有 bash）
    await waitUntil(() => requests().filter((r) => r.agentId === "tm-1").length >= 3, { timeoutMs: 30_000, describe: () => "维护者重新拉起" });
    const maintainer = requests().filter((r) => r.agentId === "tm-1");
    expect(maintainer[1]!.tools).toContain("bash");
    expect(maintainer[2]).toMatchObject({ continueSession: true });
    expect(maintainer[2]!.tools).not.toContain("bash");
  }, 120_000);
});

/** 记下 agent 管家收到的每次拉起请求（谁、pi 工具、代为执行的工具、接不接着原来的会话） */
function spawnRequests(td: TestDaemon) {
  const requests: Array<{ agentId: string; tools: string[]; hostTools: string[]; continueSession: boolean }> = [];
  const spawn = td.daemon.agents.spawn.bind(td.daemon.agents);
  td.daemon.agents.spawn = (request) => {
    requests.push({ agentId: request.agentId, tools: [...request.tools], hostTools: (request.hostTools ?? []).map((t) => t.name), continueSession: request.continueSession === true });
    return spawn(request);
  };
  return () => [...requests];
}

/** 看板上推来的现在生效的计划（task_plan） */
const taskPlansOf = (frontend: Awaited<ReturnType<typeof connect>>) => frontend.events({ channel: CHANNELS.board, type: EVENT_TYPES.taskPlan }).map((f) => f.payload as TaskPlanEventPayload);

/** 出过的计划变更卡 */
const latestPlanChangeCards = (frontend: Awaited<ReturnType<typeof connect>>) => [...new Set(cardsOf(frontend).filter((c) => c.type === "plan_change").map((c) => c.id))];
