// 主切面：流程（58 号票，ADR 0019；照搬 AgentSense 的固定计划）。真的守护进程，维护者接 faux 剧本，测试扮演前端。
// 流程直接经任务服务建出、写好任务书（发起那一段在 task-launch.test.ts 测过），之后：
// - 维护者用 propose_plan 交出步骤（每步一次工具调用：工具、参数、前置步骤）和条件（时序规则）；
// - 运行时审查修补（插入步骤、改写参数），给每一步加敏感标注和要满足的条件（写成人话，连同审查时查出的结果），
//   出流程计划卡；审查退回的交回维护者、判定不可执行的让维护者告诉用户（都不出卡，时间线上记一笔）；
// - 需要你确认的事项勾完才能授权，授权后排队、开始执行，维护者照（修补后的）步骤做，report_step 自报，步骤都做完时流程完成；
// - 用户拒绝计划（可以附说明）：回到规划中，说明交回维护者。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
  type ResponseFrame,
  type TaskEventPayload,
  type InboxItem,
  type InboxItemEventPayload,
  type WorkflowPlanCardPayload,
  type WorkflowPlanDraft,
  workflowConfirmationItems,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { TOOL, V1_TEMPLATE_IDS } from "../../src/guard/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { TASK_EVENTS, TASKS_CHANNEL, type PlanDecidedPayload, type PlanSubmittedPayload } from "../../src/tasks/events.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;
const M1 = maintainerChannel("tm-1");

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const propose = (draft: WorkflowPlanDraft) => call("propose_plan", draft as unknown as Record<string, unknown>);
const report = (stepId: string, status: string, gist?: string) => call("report_step", { stepId, status, ...(gist ? { gist } : {}) });

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const inboxOf = (frontend: TestFrontend): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}
const cardWhere = (frontend: TestFrontend, match: (card: Card) => boolean, what = "卡片") => eventually(() => cardsOf(frontend), match, what);
const taskWhere = (frontend: TestFrontend, match: (e: TaskEventPayload) => boolean, what = "看板上的任务") => eventually(() => tasksOf(frontend), match, what);
const turnsOf = (frontend: TestFrontend, n: number) =>
  waitUntil(() => frontend.events({ channel: M1, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 30_000, describe: () => `等维护者处理完 ${n} 条输入` });
/** 维护者最后一次模型调用看到的上下文（剧本里 echo_context 的回显） */
const seenByMaintainer = (frontend: TestFrontend) => textOf(messagesOf(frontend, M1).at(-1)!);

const brief = { goal: "整理一份笔记", acceptanceCriteria: ["笔记写好、读过一遍"], constraints: [], projects: [], memoryScope: "" };

async function connect(url: string) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [INBOX]: 0, [M1]: 0 });
  return frontend;
}

/** 建一个流程、写好任务书（交给维护者起草） */
function startWorkflow(td: TestDaemon, title = "整理笔记"): string {
  const task = td.daemon.tasks.createByRequest({ title, summary: title, kind: "workflow" });
  td.daemon.tasks.writeBrief(task.id, brief);
  return task.id;
}

const flowCard = (frontend: TestFrontend) => cardWhere(frontend, (c) => c.type === "workflow_plan", "流程计划卡");

/** 写笔记、读一遍；条件：读之前必须写过（计划里写的） */
const notesDraft: WorkflowPlanDraft = {
  goal: "写好笔记并读一遍",
  steps: [
    { id: "s1", title: "写笔记", tool: TOOL.write, args: { path: "notes.md", content: "# 笔记\n- 第一条\n" } },
    { id: "s2", title: "读一遍笔记", tool: TOOL.read, args: { path: "notes.md" }, after: ["s1"] },
  ],
  rules: [{ id: "write-before-read", title: "先写再读", trigger: { tool: TOOL.read }, require: { before: { tool: TOOL.write } }, on_violation: "pull_back" }],
};

describe("起草 → 审查 → 计划卡 → 授权 → 执行到完成（录给前端回放：workflow）", () => {
  it("维护者交出步骤和条件；卡上逐步列出工具、参数和每一步要满足的条件（写成人话、审查时查出的结果）；授权后照步骤执行，report_step 自报，步骤都做完时流程完成", async () => {
    const td = await startTestDaemon({
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [propose(notesDraft), say("计划交上去了")]
          : [
              report("s1", "in_progress"),
              call("write", { path: "notes.md", content: "# 笔记\n- 第一条\n" }),
              report("s1", "done", "笔记写在 notes.md"),
              report("s2", "in_progress"),
              call("read", { path: "notes.md" }),
              report("s2", "done", "读过了，一条"),
              say("都做完了：笔记写好、读过一遍"),
            ],
    });
    const frontend = await connect(td.url);
    const taskId = startWorkflow(td);

    const card = await flowCard(frontend);
    const p = card.payload as WorkflowPlanCardPayload;
    expect(card).toMatchObject({ typeVersion: 2, status: "pending" });
    expect(p).toMatchObject({ taskId, taskTitle: "整理笔记", revision: 1, planId: `${taskId}-p1`, goal: "整理一份笔记" });
    // 现在做一次的流程不带时间表（76 号票：定时触发的才带，卡上写明授权一直有效）
    expect(p.schedule).toBeUndefined();
    expect(p.plan).toMatchObject({ version: 1, goal: "写好笔记并读一遍", toolkit: { bash: false, network: false, skills: [], mcp: [] } });
    // 审查：没有违规；写文件要不要先备份得看文件在不在，推迟到执行时再查
    expect(p.plan.review).toMatchObject({ verdict: "pass", status: "pass", violations: [], actions: [], confirmations: [], scanned: { rules: 7, steps: 2 } });
    // 逐条规则的复测（照 AgentSense 的 RuleProbe）：框架的 6 条加计划里写的 1 条
    expect(p.plan.review.rules.map((r) => [r.id, r.source, r.violated, r.unknown])).toEqual([
      ...Object.values(V1_TEMPLATE_IDS).map((id) => [id, "template", 0, id === V1_TEMPLATE_IDS.backupBeforeOverwrite ? 1 : 0]),
      ["write-before-read", "plan", 0, 0],
    ]);
    expect(p.plan.review.deferred).toEqual([expect.objectContaining({ stepId: "s1", property: V1_TEMPLATE_IDS.backupBeforeOverwrite })]);
    expect(workflowConfirmationItems(p.plan.review)).toEqual([]);
    // 每一步：工具、参数（照维护者写的）、前置步骤，连同要满足的条件
    expect(p.plan.steps.map((s) => [s.id, s.tool, s.args, s.after])).toEqual([
      ["s1", "write", { path: "notes.md", content: "# 笔记\n- 第一条\n" }, []],
      ["s2", "read", { path: "notes.md" }, ["s1"]],
    ]);
    expect(p.plan.steps[0]!.conditions).toEqual([
      expect.objectContaining({
        ruleId: V1_TEMPLATE_IDS.backupBeforeOverwrite,
        title: "删除或覆盖项目档案和工作目录里的文件之前，必须已备份或已 git 提交",
        text: "write 之前必须已经成功做过 copy（只在满足条件时检查，有例外）；违反时退回，先补上再做",
        source: "template",
        status: "unknown",
        note: "规划时事实不足（文件在不在、git 状态这些要执行时才知道），执行时再查",
      }),
    ]);
    expect(p.plan.steps[1]!.conditions).toEqual([
      { ruleId: "write-before-read", title: "先写再读", text: "read 之前必须已经成功做过 write；违反时退回，先补上再做", source: "plan", status: "pass" },
    ]);
    // 计划卡在待我处理里；任务转待确认，看板上带着步数
    expect(td.daemon.cards.get(card.id)?.text).toBe("流程的计划：整理笔记（第 1 版，2 步，审查通过）");
    const submitted = await taskWhere(frontend, (e) => e.change === "plan_submitted");
    expect(submitted.task).toMatchObject({ state: "awaiting_confirm", kind: "workflow", planCardId: card.id, steps: { total: 2, done: 0 } });
    // 授权项由步骤推出：写死的参数全部进对象范围（路径换成绝对路径），只认写了的参数，路径另记真实路径，次数按步骤数
    const execution = td.daemon.store.read(TASKS_CHANNEL, 0, TASK_EVENTS.planSubmitted).map((e) => (e.payload as PlanSubmittedPayload).plan)[0]!;
    // 维护者的工作目录（这个任务的输出目录）按真实路径解析
    expect(taskId).toBe("t-1");
    const notes = expect.stringMatching(/outputs[\\/]t-1[\\/]notes\.md$/);
    expect(execution.stages.map((s) => [s.stageId, s.policy.grants])).toEqual([
      [
        "flow",
        [
          { id: "g-s1", tool: "write", title: "s1「写笔记」", scope: { path: notes, content: "# 笔记\n- 第一条\n" }, realScope: { path: notes }, maxUses: 1, exactArgs: true },
          { id: "g-s2", tool: "read", title: "s2「读一遍笔记」", scope: { path: notes }, realScope: { path: notes }, maxUses: 1, exactArgs: true },
        ],
      ],
    ]);
    await turnsOf(frontend, 1);

    // 授权：没有需要确认的事项，一次授权；排队、开始执行
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: { confirmations: [] } }));
    const started = await taskWhere(frontend, (e) => e.change === "started");
    expect(started.task).toMatchObject({ state: "running", steps: { total: 2, done: 0, list: [{ stepId: "s1", title: "写笔记", state: "pending" }, { stepId: "s2", title: "读一遍笔记", state: "pending" }] } });
    const decided = td.daemon.store.read(TASKS_CHANNEL, 0, TASK_EVENTS.planDecided).map((e) => e.payload as PlanDecidedPayload);
    expect(decided).toEqual([expect.objectContaining({ decision: "confirmed", workflow: expect.objectContaining({ version: 1 }) })]);

    const done = await taskWhere(frontend, (e) => e.change === "completed", "流程完成");
    expect(done).toMatchObject({ by: "system", task: { state: "done", steps: { total: 2, done: 2 } } });
    expect(done.task.steps?.list).toEqual([
      { stepId: "s1", title: "写笔记", state: "done", gist: "笔记写在 notes.md" },
      { stepId: "s2", title: "读一遍笔记", state: "done", gist: "读过了，一条" },
    ]);
    // 每报一步看板上推一次
    expect(tasksOf(frontend).filter((e) => e.change === "step_reported").map((e) => e.task.steps?.done)).toEqual([0, 1, 1, 2]);
    expect(fs.readFileSync(path.join(td.daemon.layout.outputs, taskId, "notes.md"), "utf8")).toContain("第一条");
    await turnsOf(frontend, 2);
    // 开始执行时交给维护者的说明：按计划执行，列出步骤和每一步的条件；会话里一条"流程完成"
    const startedNotice = messagesOf(frontend, M1).find((m) => m.agentInput && textOf(m).includes("用户已授权计划 v1"));
    expect(textOf(startedNotice!)).toContain(`开始执行流程 ${taskId}「整理笔记」，请按计划执行`);
    expect(textOf(startedNotice!)).toContain('s2. 读一遍笔记（read {"path":"notes.md"}），在 s1 之后');
    expect(textOf(startedNotice!)).toContain("- s2：先写再读：read 之前必须已经成功做过 write");
    expect(messagesOf(frontend, M1).some((m) => textOf(m) === "全部步骤都做完了（或说明跳过），流程完成。")).toBe(true);
    // 已完成的流程没有返工
    expect(await frontend.taskAction({ taskId, action: "rework", stageId: "flow" })).toMatchObject({ ok: false, error: { code: "not_allowed", message: "流程没有返工：要重做就重新发起" } });
    saveOrCheckRecording("workflow", frontend.recording, { perChannel: true });
  }, 90_000);
});

describe("审查修补", () => {
  it("推送之前没跑测试：审查插入一步跑测试，推送那一步记上它；卡上标出插入的步骤和修补动作，推送的条件写明并已满足；授权后交给维护者的说明里是修补后的计划", async () => {
    const td = await startTestDaemon({
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [
              propose({
                goal: "把改动推上去",
                steps: [
                  { id: "s1", title: "提交改动", tool: TOOL.git_commit, args: { message: "整理笔记" } },
                  { id: "s2", title: "推送到 origin", tool: TOOL.git_push, args: { remote: "origin", branch: "main" }, after: ["s1"] },
                ],
                rules: [],
              }),
              { kind: "echo_context" },
            ]
          : [{ kind: "echo_context" }],
    });
    const frontend = await connect(td.url);
    const taskId = startWorkflow(td, "推送改动");
    const card = await flowCard(frontend);
    const p = card.payload as WorkflowPlanCardPayload;
    expect(p.plan.review).toMatchObject({ verdict: "fail", status: "patched", replans: [] });
    expect(p.plan.review.violations).toEqual([expect.objectContaining({ stepId: "s2", property: V1_TEMPLATE_IDS.testBeforePush })]);
    expect(p.plan.review.actions).toEqual([expect.objectContaining({ kind: "insert", title: "推送之前先在这个仓库里跑一遍测试" })]);
    expect(p.plan.steps.map((s) => [s.id, s.tool, s.inserted === true, s.after])).toEqual([
      ["s1", TOOL.git_commit, false, []],
      ["p1", TOOL.run_tests, true, []],
      ["s2", TOOL.git_push, false, ["s1", "p1"]],
    ]);
    // 推送那一步的条件：推送之前要跑过测试（框架规则，插入之后满足）
    expect(p.plan.steps[2]!.conditions).toContainEqual(
      expect.objectContaining({ ruleId: V1_TEMPLATE_IDS.testBeforePush, source: "template", status: "pass", text: "git_push 之前必须已经成功做过 run_tests；违反时退回，先补上再做" }),
    );
    // 工具包按步骤推出：带类型的 bash 工具要 bash，推送要联网；推送落在"以我的名义对外发送"，计划授权了它
    expect(p.plan.toolkit).toMatchObject({ bash: true, network: true });
    expect(p.plan.steps[2]!.marks).toContainEqual(expect.objectContaining({ category: "external_send", authorized: true }));
    expect(td.daemon.cards.get(card.id)?.text).toBe("流程的计划：推送改动（第 1 版，3 步，审查已修补，审查插入了 1 步）");
    // 维护者知道交上去的是修补后的版本
    await turnsOf(frontend, 1);
    expect(seenByMaintainer(frontend)).toContain("计划审查改过这份计划（审查已修补），用户授权的是改过之后的版本");

    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: { confirmations: [] } }));
    await taskWhere(frontend, (e) => e.change === "started");
    await turnsOf(frontend, 2);
    const seen = seenByMaintainer(frontend);
    expect(seen).toContain("计划审查改过这份计划，用户授权的是改过之后的版本，必须照它执行——插进来的步骤即使你认为之前做过也要再做一遍。");
    expect(seen).toContain("p1. 推送之前先在这个仓库里跑一遍测试（run_tests");
    // 重注入块：流程的步骤、状态、条件和边界
    expect(seen).toContain(`流程 ${taskId}「推送改动」：执行中，已做完 0/3 步（计划 v1）`);
    expect(seen).toContain("  条件：push 之前必须跑过测试：git_push 之前必须已经成功做过 run_tests");
  }, 90_000);

  it("要你逐项确认的（计划里写的、违反时先问我的条件）：没勾完不能授权，勾完一次授权", async () => {
    const td = await startTestDaemon({
      maintainer: () => [
        propose({
          ...notesDraft,
          steps: [...notesDraft.steps, { id: "s3", title: "再写一版", tool: TOOL.write, args: { path: "notes.md", content: "# 笔记 v2\n" }, after: ["s2"] }],
          rules: [{ id: "write-once", title: "笔记只写一次", trigger: { tool: TOOL.write }, require: { not_before: { tool: TOOL.write } }, message: "笔记要再写一次，问一下用户" }],
        }),
        say("交了"),
      ],
    });
    const frontend = await connect(td.url);
    startWorkflow(td);
    const card = await flowCard(frontend);
    const p = card.payload as WorkflowPlanCardPayload;
    expect(p.plan.review).toMatchObject({ status: "needs_confirmation", confirmations: ["笔记要再写一次，问一下用户"] });
    expect(p.plan.steps[2]!.conditions).toContainEqual(expect.objectContaining({ ruleId: "write-once", source: "plan", status: "violated" }));
    const items = workflowConfirmationItems(p.plan.review);
    expect(items).toEqual([{ key: "c:笔记要再写一次，问一下用户", text: "笔记要再写一次，问一下用户" }]);

    const refused = await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: { confirmations: [] } });
    expect(refused).toMatchObject({ ok: false, error: { code: "bad_params", message: "需要你确认的事项还没勾完：笔记要再写一次，问一下用户" } });
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: { confirmations: items.map((i) => i.key) } }));
    const handled = await cardWhere(frontend, (c) => c.id === card.id && c.status === "handled", "授权过的卡");
    expect((handled.payload as WorkflowPlanCardPayload).confirmed).toEqual(["c:笔记要再写一次，问一下用户"]);
    await taskWhere(frontend, (e) => e.change === "plan_confirmed");
  }, 60_000);

  it("审查退回、判定不可执行：照 AgentSense 把这版计划显示出来——一张不能授权的卡进待我处理，写明原因和下一步；任务还在规划中；没通过检查的不出卡", async () => {
    const td = await startTestDaemon({
      maintainer: () => [
        // 计划里写的条件要退回补上：提交之前先看一眼改动
        propose({
          goal: "提交改动",
          steps: [{ id: "s1", title: "提交", tool: TOOL.git_commit, args: { message: "x" } }],
          rules: [{ id: "status-first", trigger: { tool: TOOL.git_commit }, require: { before: { tool: TOOL.git_status_diff } }, message: "提交之前先看一眼改动", on_violation: "pull_back" }],
        }),
        // 一律禁止的（force push）
        propose({ goal: "强推", steps: [{ id: "s1", title: "跑测试", tool: TOOL.run_tests }, { id: "s2", title: "强推", tool: TOOL.git_push, args: { remote: "origin", force: true }, after: ["s1"] }], rules: [] }),
        // 没通过检查：工具写错、前置步骤不在计划里
        propose({ goal: "乱写", steps: [{ id: "s1", title: "发邮件", tool: "send_mail", after: ["s9"] }], rules: [] }),
        { kind: "echo_context" },
        // 用户让它改（附了说明）：改好重新提交
        propose(notesDraft),
        { kind: "echo_context" },
      ],
    });
    const frontend = await connect(td.url);
    const taskId = startWorkflow(td);
    await turnsOf(frontend, 1);
    const seen = seenByMaintainer(frontend);
    expect(seen).toContain("[toolResult] propose_plan: 计划 v1 没有提交给用户：审查要求先补充下面几点，改好后重新调用 propose_plan。\n- 提交之前先看一眼改动");
    expect(seen).toContain("[toolResult] propose_plan: 计划 v2 不能执行，审查给出的原因：");
    expect(seen).toContain("请把这件事告诉用户，不要再提交同样的计划。");
    expect(seen).toMatch(/\[toolResult\] propose_plan: 计划没通过检查，改好再提交：\n- 步骤 s1：send_mail 不能写进步骤/);
    expect(seen).toContain("- 步骤 s1 的前置步骤 s9 不在计划里");
    expect(td.daemon.tasks.get(taskId)?.state).toBe("planning");

    // 两张卡：退回的那版不卡任务（维护者会改好重新提交），不可执行的那版卡着任务（等你决定）；交了新的一版，之前没处理的那张过期
    const latest = new Map(cardsOf(frontend).map((c) => [c.id, c]));
    const refused = [...latest.values()].filter((c) => c.type === "workflow_plan");
    expect(refused.map((c) => [(c.payload as WorkflowPlanCardPayload).revision, (c.payload as WorkflowPlanCardPayload).refused, c.urgency, c.status])).toEqual([
      [1, "needs_replan", "non_blocking", "expired"],
      [2, "blocked", "blocking", "pending"],
    ]);
    expect(td.daemon.cards.get(refused[0]!.id)?.text).toBe("流程的计划没交给你授权：整理笔记（第 1 版，审查已退回维护者）");
    expect((refused[1]!.payload as WorkflowPlanCardPayload).plan.review).toMatchObject({ status: "blocked", violations: [expect.objectContaining({ property: V1_TEMPLATE_IDS.noForcePushOrRmRfOutside })] });
    const items = inboxOf(frontend).filter((i) => i.kind === "card");
    expect(items.map((i) => [i.title, i.urgency])).toEqual([
      ["流程的计划被审查退回维护者补充：整理笔记", "non_blocking"],
      ["流程的计划不能执行：整理笔记", "blocking"],
    ]);
    // 这样的卡不能授权
    const refusedConfirm = await frontend.cardAction({ cardId: refused[1]!.id, action: "confirm", expectedVersion: 1, input: { confirmations: [] } });
    expect(refusedConfirm).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    // 不可执行的那版没有"知道了"（点了任务会一直停在规划中）
    expect(await frontend.cardAction({ cardId: refused[1]!.id, action: "ack", expectedVersion: 1 })).toMatchObject({ ok: false, error: { code: "not_allowed" } });

    // 不可执行的那版：让维护者改（附说明），交回维护者；它改好重新提交，是第 3 版、等你授权的卡
    ok(await frontend.cardAction({ cardId: refused[1]!.id, action: "return", expectedVersion: 1, note: "不要强推，写笔记就行" }));
    const third = await cardWhere(frontend, (c) => c.type === "workflow_plan" && (c.payload as WorkflowPlanCardPayload).revision === 3, "第 3 版的卡");
    expect((third.payload as WorkflowPlanCardPayload).refused).toBeUndefined();
    await turnsOf(frontend, 2);
    expect(seenByMaintainer(frontend)).toContain("用户看了计划 v2 的审查结果（判定不可执行），让你改。用户说明：不要强推，写笔记就行");
    const decided = td.daemon.store.read(TASKS_CHANNEL, 0, TASK_EVENTS.planDecided).map((e) => e.payload as PlanDecidedPayload);
    expect(decided).toEqual([expect.objectContaining({ revision: 2, decision: "returned", note: "不要强推，写笔记就行" })]);
  }, 60_000);

  it("不可执行的那版卡上点取消任务：任务取消（和任务详情里的取消同一个控制）", async () => {
    const td = await startTestDaemon({
      maintainer: () => [
        propose({ goal: "强推", steps: [{ id: "s1", title: "跑测试", tool: TOOL.run_tests }, { id: "s2", title: "强推", tool: TOOL.git_push, args: { remote: "origin", force: true }, after: ["s1"] }], rules: [] }),
        say("不能执行，已经告诉用户"),
      ],
    });
    const frontend = await connect(td.url);
    const taskId = startWorkflow(td);
    const card = await flowCard(frontend);
    expect((card.payload as WorkflowPlanCardPayload).refused).toBe("blocked");
    ok(await frontend.cardAction({ cardId: card.id, action: "cancel", expectedVersion: 1 }));
    const cancelled = await taskWhere(frontend, (e) => e.change === "cancelled", "取消了的任务");
    expect(cancelled).toMatchObject({ by: "user", task: { id: taskId, state: "cancelled" } });
    const handled = await cardWhere(frontend, (c) => c.id === card.id && c.status === "handled", "处理过的卡");
    expect(handled.outcome).toMatchObject({ action: "cancel", note: "取消了任务" });
  }, 60_000);
});

describe("用户拒绝计划", () => {
  it("拒绝（附说明）：任务回到规划中，说明交回维护者；维护者改好重新提交，是第 2 版、新的一张卡", async () => {
    const td = await startTestDaemon({
      maintainer: () => [propose(notesDraft), say("交了"), propose({ ...notesDraft, steps: [notesDraft.steps[0]!] }), { kind: "echo_context" }],
    });
    const frontend = await connect(td.url);
    const taskId = startWorkflow(td);
    const first = await flowCard(frontend);
    await turnsOf(frontend, 1);
    ok(await frontend.cardAction({ cardId: first.id, action: "reject", expectedVersion: 1, note: "只写不用读" }));
    const back = await taskWhere(frontend, (e) => e.change === "plan_rejected");
    expect(back).toMatchObject({ from: "awaiting_confirm", by: "user", task: { state: "planning" } });
    const decided = td.daemon.store.read(TASKS_CHANNEL, 0, TASK_EVENTS.planDecided).map((e) => e.payload as PlanDecidedPayload);
    expect(decided).toEqual([expect.objectContaining({ decision: "rejected", note: "只写不用读", workflow: expect.objectContaining({ version: 1 }) })]);

    const second = await cardWhere(frontend, (c) => c.type === "workflow_plan" && c.id !== first.id, "第 2 版的卡");
    expect(second.payload).toMatchObject({ revision: 2, planId: `${taskId}-p2`, plan: { version: 2 } });
    expect((second.payload as WorkflowPlanCardPayload).plan.steps.map((s) => s.id)).toEqual(["s1"]);
    await turnsOf(frontend, 2);
    expect(seenByMaintainer(frontend)).toContain("用户拒绝了计划 v1。用户说明：只写不用读\n照用户的说明改好后重新用 propose_plan 提交。");
    const handled = cardsOf(frontend).filter((c) => c.id === first.id).at(-1)!;
    expect(handled).toMatchObject({ status: "handled", outcome: { action: "reject" } });
  }, 60_000);
});
