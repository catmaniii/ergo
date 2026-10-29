// 主切面：阶段自动验收（112 号票，用户 2026-10-13 定：先是项目里的任务，同日同意扩到所有长程任务）。真的守护进程，项目的维护者、
// 任务的维护者、评审子 agent 接 faux 剧本，测试扮演前端。
// - 项目的任务（项目的维护者执行的）起草计划时写由你验收（user）：计划检查退回，说明"阶段自动验收，改成 script 或 review"；
//   改好再交才出计划卡；确认后各阶段做完自动验收（脚本、评审），不出"等你验收"；任务的工具包开了 bash 的，评审也能在工作目录里跑命令；
// - 例外照旧找用户：评审连续不通过到上限（验收第 3 次还不过），这一支停下、卡住求助；
// - 已经在跑的项目任务（升级前确认的计划里写着由你验收）：守护进程启动时没验收的阶段里的改由评审（运行时调整的一版计划，事件历史不动），
//   已经在等你验收的交给评审去验、那条事项记成处理过（写明交给评审了），时间线上记一笔，进度卡上写明原定由你验收；再重启不重复；
// - 升级前交、升级后才确认的计划：确认之后马上照样改由评审；
// - 项目外的长程任务一样（升级前的也照样转）；升级前由你验收过的阶段后来重做重开了：重开时就改由评审，重做完不再找你验收。
// 不涉及项目的任务起草时被退回见 task-execution.test.ts 的"阶段自动验收"，计划检查的纯函数在 test/tasks/plan-projects.test.ts。
import fs from "node:fs";
import path from "node:path";
import {
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  nowIso,
  type Plan,
  type PlanCardPayload,
  type ProgressCardPayload,
  type Task,
  type TaskEventPayload,
  taskInboxOrigin,
  type TaskStage,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { type PlanRevisedPayload, TASK_EVENTS, TASKS_CHANNEL } from "../../src/tasks/events.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { byMaintainer, internalTask, seedProject } from "../helpers/projects.ts";
import {
  call,
  cardWhere,
  cardsOf,
  completeStage,
  eventually,
  inboxOf,
  inputsDone,
  itemWhere,
  ok,
  recordsOf,
  say,
  taskWhere,
  tasksOf,
  toolCallsOf,
  twoStagePlan,
  write,
} from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { board: BOARD, cards: CARDS, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const PM1 = maintainerChannel("pm-1");
/** 进展文档一开始的那句（项目档案的最小文档集） */
const PROGRESS_INTRO = "做到哪了、下一步做什么：每段工作结束时写回。";
const HANDED = "阶段改成自动验收，交给评审了";
const CONVERTED = "原定由你验收，按新规矩改由评审";

/** s1 收集资料（脚本 + 一条 method 的标准），s2 写报告（只有一条 method 的标准） */
function planWith(method: "review" | "user"): Plan {
  const base = twoStagePlan();
  return {
    ...base,
    stages: [
      { ...base.stages[0]!, acceptance: [...base.stages[0]!.acceptance, { criterion: "来源都是公开网页", method }] },
      { ...base.stages[1]!, acceptance: [{ criterion: "报告写清楚了每条来源的用处", method }] },
    ],
  };
}

const pass = (): FauxStep[] => [call("submit_review", { results: [{ index: 1, passed: true, reason: "看过了，满足" }] }), say("评审完了")];
const fail = (): FauxStep[] => [call("submit_review", { results: [{ index: 1, passed: false, reason: "看不到来源" }] }), say("评审完了")];

function dirs() {
  const dataDir = makeTempDir("ergo-data-");
  return { dataDir, homeDir: makeTempDir("ergo-home-"), progress: () => path.join(fs.realpathSync.native(dataDir), "projects", "p-1", "progress.md") };
}

const progressEdit = (file: string, oldText: string, newText: string) => call("edit", { path: file, edits: [{ oldText, newText }] });

async function connect(url: string) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries([BOARD, CARDS, INBOX, PROJECTS, PM1].map((c) => [c, 0])));
  return frontend;
}

/** 建设中的项目「AI 简报站」（立项书已确认）和它的一个内部长程任务（项目的维护者 pm-1 执行），写好任务书：派出起草计划的工单 */
function projectTaskWithBrief(td: TestDaemon): Task {
  seedProject(td.daemon, "AI 简报站", { state: "building", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: true, network: false } });
  const task = internalTask(td.daemon, "AI 简报站", "做一份信息源调研");
  td.daemon.tasks.writeBrief(task.id, { goal: "整理一份信息源调研", acceptanceCriteria: ["附来源"], constraints: [], projects: ["AI 简报站"], memoryScope: "" }, byMaintainer(td.daemon, task.id));
  return task;
}

/** 某个 agent 会话目录里全部会话文件的内容（评审子 agent 的调用不在任何会话频道里） */
function sessionText(td: TestDaemon, agentId: string): string {
  const dir = path.join(td.daemon.layout.sessions, agentId);
  if (!fs.existsSync(dir)) return "";
  return fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

const acceptanceCards = (frontend: TestFrontend, taskId: string) =>
  cardsOf(frontend)
    .filter((c) => c.type === "progress" && (c.payload as ProgressCardPayload).taskId === taskId && (c.payload as ProgressCardPayload).kind === "acceptance")
    .map((c) => c.payload as ProgressCardPayload);

describe("项目里的任务：起草时只写脚本、评审，之后自动验收", () => {
  it("计划里写由你验收被退回（说明阶段自动验收，改成 script 或 review），改好再交才出计划卡；确认后两个阶段做完都自动验收，不出“等你验收”，任务自动完成；工具包开了 bash，评审在工作目录里跑命令看了再判", async () => {
    const d = dirs();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        // 起草计划的工单段：先交一版写了由你验收的（被退回），改成评审再交，写回进展、写摘要
        if (spawn === 1)
          return [
            submitPlanStep(planWith("user")),
            submitPlanStep(planWith("review")),
            call("write_progress", { content: "调研：计划交了，等确认。" }),
            call("write_segment_summary", { summary: "起草了调研的计划" }),
            say("计划交上去了"),
          ];
        // 执行的工单段：两个阶段各做完宣布完成，写回进展
        return [
          write("sources.md", "- 来源\n"),
          completeStage("s1", "清单在 sources.md"),
          write("report.md", "# 报告\n"),
          completeStage("s2", "报告在 report.md"),
          progressEdit(d.progress(), "调研：计划交了，等确认。", "调研做完了。"),
          call("write_segment_summary", { summary: "调研做完了" }),
          say("做完了"),
        ];
      },
      // 评审先在工作目录里跑一条命令（任务的工具包开了 bash，112 号票返修：能跑的跑一遍再判），再交结论
      reviewer: () => [call("bash", { command: "cat sources.md report.md 2>/dev/null; echo 评审跑过了" }), ...pass()],
    });
    const frontend = await connect(td.url);
    const task = projectTaskWithBrief(td);

    // 第一次交的被计划检查退回（不出计划卡），原因交回维护者
    const card = await cardWhere(frontend, (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id, "计划卡");
    await inputsDone(frontend, PM1);
    const submits = toolCallsOf(frontend, PM1).filter((c) => c.tool === "submit_plan");
    expect(submits).toHaveLength(2);
    expect(submits[0]!.resultSummary).toContain("阶段自动验收，改成 script 或 review");
    expect(submits[0]!.resultSummary).toContain("阶段 s1 的验收标准「来源都是公开网页」写的是由用户验收（user）");
    expect(cardsOf(frontend).filter((c) => c.type === "plan")).toHaveLength(1);
    expect((card.payload as PlanCardPayload).plan.stages.flatMap((s) => s.acceptance.map((a) => a.method))).toEqual(["script", "review", "review"]);

    // 确认之后：各阶段做完自动验收（脚本、评审），任务自动完成；没有"等你验收"
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));
    const done = await taskWhere(frontend, (e) => e.task.id === task.id && e.change === "completed", "任务完成");
    expect(done.task.stages?.list?.map((s) => s.state)).toEqual(["accepted", "accepted"]);
    const verdicts = await eventually(() => [acceptanceCards(frontend, task.id)], (v) => v.length === 2, "两张验收结论卡");
    expect(verdicts.map((p) => [p.stageId, p.acceptance?.passed, p.acceptance?.judgedBy])).toEqual([
      ["s1", true, "review"],
      ["s2", true, "review"],
    ]);
    // 一直是评审的不写"原定由你验收"
    expect(verdicts.flatMap((p) => p.acceptance!.results.map((r) => r.note ?? ""))).not.toContainEqual(expect.stringContaining(CONVERTED));
    // 评审在项目的工作目录里跑了命令（照样经守卫）：看到了交付件
    const reviewed = sessionText(td, `review-${task.id}-s1-1`);
    expect(reviewed).toContain("评审跑过了");
    expect(reviewed).toContain("- 来源");
    expect(inboxOf(frontend).filter((i) => i.kind === "notice" && i.notice === "stage_acceptance")).toEqual([]);
    await inputsDone(frontend, PM1);
  }, 90_000);

  it("评审连续不通过到上限照旧找用户：前 2 次只交回维护者，第 3 次还不过，这一支停下、卡住求助（不是等你验收）", async () => {
    const d = dirs();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        if (spawn === 1)
          return [submitPlanStep(planWith("review")), call("write_progress", { content: "调研：计划交了，等确认。" }), call("write_segment_summary", { summary: "起草了调研的计划" }), say("计划交上去了")];
        return [write("sources.md", "- 来源\n"), completeStage("s1"), completeStage("s1"), completeStage("s1"), say("三次都没过"), say("等你"), say("等你")];
      },
      reviewer: fail,
    });
    const frontend = await connect(td.url);
    const task = projectTaskWithBrief(td);
    const card = await cardWhere(frontend, (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id, "计划卡");
    await inputsDone(frontend, PM1);
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));

    const waiting = await taskWhere(frontend, (e) => e.task.id === task.id && e.change === "waiting" && e.task.waitReason === "stuck", "转等我（卡住求助）");
    expect(waiting.task.stages?.list?.[0]).toMatchObject({ state: "waiting", waitReason: "stuck", returns: 3, attempts: 3 });
    expect(waiting.task.waitNote).toContain("第 3 次还没通过");
    const help = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "stuck_help", "卡住求助");
    expect(help).toMatchObject({ urgency: "blocking", data: { taskId: task.id, stageIds: ["s1"] } });
    expect(inboxOf(frontend).filter((i) => i.kind === "notice" && i.notice === "stage_acceptance")).toEqual([]);
  }, 90_000);
});

/** 升级前确认的计划（写着由你验收）：s1 脚本 + 由你验收，s2 只有由你验收，s3 一直是评审 */
function legacyPlan(): Plan {
  const base = planWith("user");
  return {
    ...base,
    stages: [
      ...base.stages,
      {
        ...base.stages[1]!,
        stageId: "s3",
        title: "写摘要",
        deliverables: ["摘要 summary.md"],
        acceptance: [{ criterion: "摘要不超过一页", method: "review" }],
        dependsOn: ["s2"],
      },
    ],
  };
}

/**
 * 升级前留下的数据：建设中的项目「AI 简报站」的内部长程任务，计划（升级前确认的一版）里写着由你验收；s1 做完了、脚本通过，
 * 在等你验收（待我处理里一条"等你验收"），s2、s3 还没开始，所有能推进的分支都在等你，任务转等我
 */
function seedLegacyTask(td: TestDaemon): { task: Task; itemId: string } {
  seedProject(td.daemon, "AI 简报站", { state: "building", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: true, network: false } });
  const created = internalTask(td.daemon, "AI 简报站", "建设「AI 简报站」首版");
  const at = nowIso();
  const item = td.daemon.inbox.buildAdd({
    kind: "notice",
    notice: "stage_acceptance",
    title: `等你验收：${created.title} 第 1 阶段「收集资料」`,
    body: "任务「建设「AI 简报站」首版」第 1/3 阶段「收集资料」做完了，计划里这几条由你验收：\n- 来源都是公开网页",
    actions: ["验收通过", "退回"],
    data: { taskId: created.id, stageId: "s1" },
    urgency: "blocking",
    ...taskInboxOrigin(created, { stageId: "s1" }),
  });
  const plan = legacyPlan();
  const list: TaskStage[] = [
    {
      stageId: "s1",
      title: "收集资料",
      state: "waiting",
      dependsOn: [],
      waitReason: "acceptance",
      waitingOn: item.item.id,
      acceptance: [
        { criterion: "资料清单存在", method: "script", result: { passed: true, note: "退出码 0", at } },
        { criterion: "来源都是公开网页", method: "user" },
      ],
      attempts: 1,
      startedAt: at,
      summary: "清单在 sources.md",
      code: "1",
    },
    { stageId: "s2", title: "写报告", state: "pending", dependsOn: ["s1"], acceptance: [{ criterion: "报告写清楚了每条来源的用处", method: "user" }], attempts: 0, code: "2" },
    { stageId: "s3", title: "写摘要", state: "pending", dependsOn: ["s2"], acceptance: [{ criterion: "摘要不超过一页", method: "review" }], attempts: 0, code: "3" },
  ];
  const task: Task = { ...created, state: "waiting_for_user", waitReason: "acceptance", stages: { total: 3, current: 1, list, focus: "s1" }, updatedAt: at };
  const revised: PlanRevisedPayload = { taskId: created.id, planId: `${created.id}-p1`, revision: 1, basePlanId: `${created.id}-p0`, plan, changes: [], why: "升级前确认的计划", grantTimes: {}, maintainerId: "pm-1", time: at };
  td.daemon.store.appendBatch([
    { channel: BOARD, type: EVENT_TYPES.task, payload: { task, change: "waiting", from: created.state, by: "system" } satisfies TaskEventPayload },
    { channel: TASKS_CHANNEL, type: TASK_EVENTS.planRevised, payload: revised },
    item.event,
  ]);
  return { task, itemId: item.item.id };
}

const systemRevisions = (td: TestDaemon, taskId: string) =>
  td.daemon.store
    .read(TASKS_CHANNEL, 0, TASK_EVENTS.planRevised)
    .map((e) => e.payload as PlanRevisedPayload)
    .filter((p) => p.taskId === taskId && p.by === "system");

describe("已经在跑的项目任务（升级前确认的计划里写着由你验收）", () => {
  it("启动时没验收的阶段里的由你验收改由评审（运行时调整的一版计划，事件历史不动）；在等你验收的交给评审去验，事项记成处理过；时间线、进度卡写明原定由你验收；再重启不重复", async () => {
    const d = dirs();
    const quiet = (): FauxStep[] => [say("收到"), say("收到"), say("收到")];
    const first = await startTestDaemon({ reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, maintainer: quiet });
    const { task, itemId } = seedLegacyTask(first);
    const before = { board: first.daemon.store.read(BOARD, 0).map((e) => JSON.stringify(e)), tasks: first.daemon.store.read(TASKS_CHANNEL, 0).map((e) => JSON.stringify(e)) };
    await first.daemon.stop();

    // 升级后重启
    const second = await startTestDaemon({ reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, maintainer: quiet, reviewer: pass });
    const frontend = await connect(second.url);
    // 运行时调整的一版计划（系统）：没验收的阶段里由你验收的改成评审，s3 一直是评审，别的不动
    const revisions = systemRevisions(second, task.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ revision: 2, basePlanId: `${task.id}-p1`, by: "system" });
    const confirmed = second.daemon.tasks.confirmedPlan(task.id)!;
    expect(confirmed).toMatchObject({ planId: `${task.id}-p2`, revision: 2 });
    expect(confirmed.plan.stages.map((s) => s.acceptance.map((a) => `${a.criterion}:${a.method}`))).toEqual([
      ["资料清单存在:script", "来源都是公开网页:review"],
      ["报告写清楚了每条来源的用处:review"],
      ["摘要不超过一页:review"],
    ]);
    // 事件历史不动（只追加）
    expect(second.daemon.store.read(BOARD, 0).slice(0, before.board.length).map((e) => JSON.stringify(e))).toEqual(before.board);
    expect(second.daemon.store.read(TASKS_CHANNEL, 0).slice(0, before.tasks.length).map((e) => JSON.stringify(e))).toEqual(before.tasks);

    // 在等你验收的那条：记成处理过（写明交给评审了），不再卡着任务
    const handed = await itemWhere(frontend, (i) => i.id === itemId && i.kind === "notice" && i.handled !== undefined, "等你验收记成处理过");
    expect(handed).toMatchObject({ handled: HANDED, handledNote: HANDED, urgency: "non_blocking" });
    // 再点旧按钮：回那句说明
    expect(await frontend.inboxAction({ itemIds: [itemId], action: "handle", choice: "验收通过" })).toMatchObject({ ok: false, error: { code: "conflict", message: HANDED } });

    // 交给评审去验：只验原定由你验收的那条（脚本的照旧算通过），通过后 s1 验收、s2 开始
    const accepted = await taskWhere(frontend, (e) => e.task.id === task.id && e.change === "stage_accepted" && e.stageId === "s1", "s1 验收通过");
    expect(accepted.by).toBe("system");
    const s1 = await eventually(() => [acceptanceCards(frontend, task.id)], (v) => v.length === 1, "s1 的验收结论卡");
    expect(s1[0]!.acceptance).toMatchObject({ passed: true, judgedBy: "review", summary: "清单在 sources.md" });
    expect(s1[0]!.acceptance!.results).toEqual([
      { criterion: "资料清单存在", method: "script", passed: true, note: "退出码 0" },
      { criterion: "来源都是公开网页", method: "review", passed: true, note: `${CONVERTED}：看过了，满足` },
    ]);
    await taskWhere(frontend, (e) => e.task.id === task.id && e.change === "stage_started" && e.stageId === "s2", "s2 开始");
    const now = second.daemon.tasks.get(task.id)!;
    expect(now.stages?.list?.map((s) => [s.stageId, s.state, s.acceptance.map((a) => a.method).join("+")])).toEqual([
      ["s1", "accepted", "script+review"],
      ["s2", "running", "review"],
      ["s3", "pending", "review"],
    ]);
    // 时间线上记一笔（属于这个任务），写明哪几条原定由你验收、改由评审，哪个阶段交给了评审
    const record = recordsOf(frontend, PM1).find((r) => r.record.kind === "auto_acceptance");
    expect(record).toMatchObject({ taskId: task.id, projectId: "p-1" });
    expect(record!.record.summary).toBe("阶段改成自动验收：2 条原定由你验收的标准改由评审验收（照标准原文判）");
    expect(record!.record.detail).toContain("第 1 阶段「收集资料」：来源都是公开网页");
    expect(record!.record.detail).toContain("第 2 阶段「写报告」：报告写清楚了每条来源的用处");
    expect(record!.record.detail).toContain("第 1 阶段「收集资料」在等你验收：交给评审去验了，待办里那条记成处理过");
    // 没有新的"等你验收"
    expect([...new Set(inboxOf(frontend).filter((i) => i.kind === "notice" && i.notice === "stage_acceptance").map((i) => i.id))]).toEqual([itemId]);
    await frontend.close();
    await second.daemon.stop();

    // 再重启：不再改一遍
    const third = await startTestDaemon({ reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, maintainer: quiet, reviewer: pass });
    expect(systemRevisions(third, task.id)).toHaveLength(1);
    expect(third.daemon.tasks.confirmedPlan(task.id)?.revision).toBe(2);
  }, 120_000);

  it("升级前交、升级后才确认的计划：确认之后马上照样改由评审（计划卡上原样留着），阶段做完自动验收，进度卡写明原定由你验收", async () => {
    const d = dirs();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      maintainer: (id) =>
        id === "pm-1"
          ? [
              write("sources.md", "- 来源\n"),
              completeStage("s1", "清单在 sources.md"),
              progressEdit(d.progress(), PROGRESS_INTRO, "调研做完了。"),
              call("write_segment_summary", { summary: "调研做完了" }),
              say("做完了"),
            ]
          : [],
      reviewer: pass,
    });
    const frontend = await connect(td.url);
    seedProject(td.daemon, "AI 简报站", { state: "building", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: true, network: false } });
    const task = internalTask(td.daemon, "AI 简报站", "做一份信息源调研");
    // 升级前交的计划（只有 s1：脚本 + 由你验收），计划卡还没确认
    const base = planWith("user");
    const plan: Plan = { ...base, stages: [base.stages[0]!] };
    const planId = `${task.id}-p1`;
    const payload: PlanCardPayload = { taskId: task.id, taskTitle: task.title, revision: 1, planId, goal: "整理一份信息源调研", plan, globalCategories: [], grantInfo: {} };
    const built = td.daemon.cards.buildCreate({ type: "plan", urgency: "blocking", payload });
    const now = td.daemon.tasks.get(task.id)!;
    td.daemon.store.appendBatch([
      { channel: TASKS_CHANNEL, type: TASK_EVENTS.planSubmitted, payload: { taskId: task.id, planId, revision: 1, plan, cardId: built.card.id, maintainerId: "pm-1", time: nowIso() } },
      built.event,
      td.daemon.tasks.buildChange(now, { ...now, state: "awaiting_confirm", planCardId: built.card.id, stages: { total: 1 } }, { by: "maintainer", change: "plan_submitted" }).event,
    ]);
    // 计划卡在、还没改（升级前交的那一版）：确认
    ok(await frontend.cardAction({ cardId: built.card.id, action: "confirm", expectedVersion: built.card.version, input: {} }));
    // 确认之后马上改由评审：运行时调整的一版，计划卡上原样留着
    await eventually(() => systemRevisions(td, task.id), () => true, "运行时调整的一版计划");
    expect(td.daemon.tasks.confirmedPlan(task.id)!.plan.stages[0]!.acceptance.map((a) => a.method)).toEqual(["script", "review"]);
    expect((td.daemon.cards.get(built.card.id)!.payload as PlanCardPayload).plan.stages[0]!.acceptance.map((a) => a.method)).toEqual(["script", "user"]);
    expect(recordsOf(frontend, PM1).find((r) => r.record.kind === "auto_acceptance")).toMatchObject({ taskId: task.id });

    // 做完自动验收，进度卡写明原定由你验收
    await taskWhere(frontend, (e) => e.task.id === task.id && e.change === "completed", "任务完成");
    const [verdict] = await eventually(() => [acceptanceCards(frontend, task.id)], (v) => v.length === 1, "验收结论卡");
    expect(verdict!.acceptance!.results).toEqual([
      expect.objectContaining({ criterion: "资料清单存在", method: "script", passed: true }),
      { criterion: "来源都是公开网页", method: "review", passed: true, note: `${CONVERTED}：看过了，满足` },
    ]);
    expect(inboxOf(frontend).filter((i) => i.kind === "notice" && i.notice === "stage_acceptance")).toEqual([]);
    await inputsDone(frontend, PM1);
  }, 90_000);
});

/**
 * 升级前留下的数据：不涉及项目的长程任务（自己的维护者 tm-1），计划（升级前确认的一版）两个阶段都写着由你验收；s1 已经由你验收过，
 * s2 正在做
 */
function seedLegacyPlainTask(td: TestDaemon): Task {
  const created = td.daemon.tasks.createByRequest({ title: "整理家里的保修单", summary: "整理家里的保修单" });
  td.daemon.tasks.writeBrief(created.id, { goal: "整理保修单", acceptanceCriteria: ["有一份清单"], constraints: [], projects: [], memoryScope: "" });
  const at = nowIso();
  const base = twoStagePlan();
  const plan: Plan = {
    ...base,
    stages: [
      { ...base.stages[0]!, acceptance: [...base.stages[0]!.acceptance, { criterion: "清单你看过", method: "user" }] },
      { ...base.stages[1]!, acceptance: [{ criterion: "报告你认可", method: "user" }] },
    ],
  };
  const list: TaskStage[] = [
    {
      stageId: "s1",
      title: "收集资料",
      state: "accepted",
      dependsOn: [],
      acceptance: [
        { criterion: "资料清单存在", method: "script", result: { passed: true, note: "退出码 0", at } },
        { criterion: "清单你看过", method: "user", result: { passed: true, at } },
      ],
      attempts: 1,
      startedAt: at,
      summary: "清单在 sources.md",
      code: "1",
    },
    { stageId: "s2", title: "写报告", state: "running", dependsOn: ["s1"], acceptance: [{ criterion: "报告你认可", method: "user" }], attempts: 0, startedAt: at, code: "2" },
  ];
  const now = td.daemon.tasks.get(created.id)!;
  const task: Task = { ...now, state: "running", stages: { total: 2, current: 2, list, focus: "s2" }, updatedAt: at };
  const revised: PlanRevisedPayload = { taskId: created.id, planId: `${created.id}-p1`, revision: 1, basePlanId: `${created.id}-p0`, plan, changes: [], why: "升级前确认的计划", grantTimes: {}, maintainerId: now.maintainerId, time: at };
  td.daemon.store.appendBatch([
    { channel: BOARD, type: EVENT_TYPES.task, payload: { task, change: "started", from: now.state, by: "system" } satisfies TaskEventPayload },
    { channel: TASKS_CHANNEL, type: TASK_EVENTS.planRevised, payload: revised },
  ]);
  return task;
}

/** 每一轮写好资料清单、试着宣布 s1 完成（重做之前 s1 已经验收了，被拒，无妨），再说一句 */
const reworkSteps = (): FauxStep[] => Array.from({ length: 4 }, () => [write("sources.md", "- 来源\n"), completeStage("s1", "重核了来源"), say("好")]).flat();

describe("项目外的长程任务一样（用户 2026-10-13 同意扩到所有长程任务）", () => {
  it("升级前的不涉及项目的任务：启动时没验收的 s2 改由评审，验收过的 s1 不动；从 s1 重做（重开了）：重开时就改由评审，重做完由评审验收，不再找你验收", async () => {
    const d = dirs();
    const TM1 = maintainerChannel("tm-1");
    const first = await startTestDaemon({ reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, maintainer: () => [say("收到")] });
    const task = seedLegacyPlainTask(first);
    await first.daemon.stop();

    // 升级后重启：s2（没验收）改由评审；s1 验收过，计划里照旧写着由你验收
    const second = await startTestDaemon({ reuse: { dataDir: d.dataDir, homeDir: d.homeDir }, maintainer: reworkSteps, reviewer: pass });
    const frontend = await TestFrontend.connect(second.url);
    await frontend.subscribe(Object.fromEntries([BOARD, CARDS, INBOX, TM1].map((c) => [c, 0])));
    expect(systemRevisions(second, task.id)).toHaveLength(1);
    expect(second.daemon.tasks.confirmedPlan(task.id)!.plan.stages.map((s) => s.acceptance.map((a) => a.method).join("+"))).toEqual(["script+user", "review"]);
    expect(recordsOf(frontend, TM1).find((r) => r.record.kind === "auto_acceptance")?.record.summary).toBe("阶段改成自动验收：1 条原定由你验收的标准改由评审验收（照标准原文判）");

    // 从 s1 重做：重开之后 s1 没验收了，照新规矩改由评审（又一版运行时调整的计划）
    ok(await frontend.taskAction({ taskId: task.id, action: "rework", stageId: "s1" }));
    await taskWhere(frontend, (e) => e.task.id === task.id && e.change === "rework", "重做");
    await eventually(() => systemRevisions(second, task.id), (r) => r.revision === 3, "重开后改由评审的一版计划");
    expect(second.daemon.tasks.confirmedPlan(task.id)!.plan.stages.map((s) => s.acceptance.map((a) => a.method).join("+"))).toEqual(["script+review", "review"]);
    // 重做完由评审验收（结论写明原定由你验收），没有"等你验收"
    const accepted = await taskWhere(frontend, (e) => e.task.id === task.id && e.change === "stage_accepted" && e.stageId === "s1", "s1 重做后验收");
    expect(accepted.by).toBe("system");
    const [verdict] = await eventually(() => [acceptanceCards(frontend, task.id)], (v) => v.length >= 1, "s1 的验收结论卡");
    expect(verdict!.acceptance).toMatchObject({ passed: true, judgedBy: "review" });
    expect(verdict!.acceptance!.results).toContainEqual({ criterion: "清单你看过", method: "review", passed: true, note: `${CONVERTED}：看过了，满足` });
    expect(inboxOf(frontend).filter((i) => i.kind === "notice" && i.notice === "stage_acceptance")).toEqual([]);
    expect(tasksOf(frontend).filter((e) => e.task.id === task.id && e.task.waitReason === "acceptance")).toEqual([]);
  }, 120_000);
});
