// 主切面：项目内部任务（64 号票，规格第 8 节"项目内部任务"）。真的守护进程，秘书、项目维护者都接 faux 剧本，测试扮演前端。
// - 发起的规矩和秘书一样：用户在项目的维护者会话里点明了（"按流程做：……""发起任务：……"、/流程、/任务）才建，点明的判断和秘书
//   共用一份；没点明的维护者最多给一张建议卡（卡上"作为流程""作为长程任务"），用户点了才建出，通知交给维护者；
//   用户在秘书那里点明了要做某个项目的事，秘书替用户建成这个项目的内部任务（通知交给维护者，秘书看不到细节）；
// - 种类和执行：流程或长程任务，由这个项目的维护者自己执行——任务书由它写，之后和单项目任务一样派起草计划的工单、
//   计划卡一次授权、执行（流程执行时照计划逐步核对），照常占全局执行名额，用量记在任务名下；
// - 可见范围：看板频道上的任务、定时触发的内部任务的触发登记（76 号票）带着 internal（前端不放上全局看板、放在项目页上），要用户处理的照常进待我处理、
//   来源写明"项目「X」内部"、事项带着标记，秘书的只读工具（查看板、列出待我处理、把卡片放进聊天、检索素材）看不到细节；
// - 归档：结束了的在项目页上由用户归档（task_action 的 archive；90 号票起结束了的全局任务也能这样直接归档）；
// - 只动本项目：计划里写了别的项目被拒，告诉用户改成普通任务；
// - 删除项目时它的内部任务一起删掉。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItem,
  type InboxItemEventPayload,
  isProjectInternal,
  maintainerChannel,
  type MessageEventPayload,
  type PlanCardPayload,
  type Project,
  PURGED_TEXT,
  type ResponseFrame,
  type ScheduledJobEventPayload,
  type TaskEventPayload,
  type TokenTotalsEventPayload,
  type WorkflowPlanCardPayload,
  type WorkflowPlanDraft,
  type WorkOrderEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { TOOL } from "../../src/guard/index.ts";
import { inboxTools } from "../../src/inbox/secretary-tools.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { SUB_AGENT_EVENTS, SUB_AGENTS_CHANNEL } from "../../src/sub-agents/events.ts";
import type { NewInternalTask } from "../../src/tasks/tasks.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { projectTask, seedProject } from "../helpers/projects.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX, projects: PROJECTS, secretary: SECRETARY } = CHANNELS;
const PM1 = maintainerChannel("pm-1");
/** 项目 p-1（记账本）的标记 */
const P1 = { projectId: "p-1", projectName: "记账本" };

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const summary = (text: string) => call("write_segment_summary", { summary: text });
const writeProgress = (content: string) => call("write_progress", { content });
const propose = (draft: WorkflowPlanDraft) => call("propose_plan", draft as unknown as Record<string, unknown>);
const report = (stepId: string, status: string, gist?: string) => call("report_step", { stepId, status, ...(gist ? { gist } : {}) });
const writeBrief = (taskId: string, goal: string, projects: string[] = []) =>
  call("write_task_brief", { taskId, goal, acceptanceCriteria: ["做好了"], constraints: [], projects, memoryScope: "" });

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const inboxOf = (frontend: TestFrontend): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
const workOrdersOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.workOrder }).map((f) => f.payload as WorkOrderEventPayload);
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
const taskWhere = (frontend: TestFrontend, match: (e: TaskEventPayload) => boolean, what = "看板上的任务", timeoutMs?: number) => eventually(() => tasksOf(frontend), match, what, timeoutMs);
const turnsOf = (frontend: TestFrontend, channel: string, n: number) =>
  waitUntil(() => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 30_000, describe: () => `等 ${channel} 处理完 ${n} 条输入` });
/** 某个会话里最后一次模型调用看到的上下文（剧本里 echo_context 的回显） */
const lastSeen = (frontend: TestFrontend, channel: string) => textOf(messagesOf(frontend, channel).filter((m) => m.message.speaker === "agent").at(-1)!);

/** 先定下数据目录和主目录（剧本里要写项目档案的路径），再起守护进程 */
function dirs() {
  const dataDir = makeTempDir("ergou-data-");
  return { dataDir, homeDir: makeTempDir("ergou-home-"), records: (projectId = "p-1") => path.join(fs.realpathSync.native(dataDir), "projects", projectId) };
}

/** 进展文档的一句改成另一句（维护者在对话段里写回项目档案） */
const progressEdit = (records: string, oldText: string, newText: string) => call("edit", { path: path.join(records, "progress.md"), edits: [{ oldText, newText }] });
/** 进展文档一开始的那句（项目档案的最小文档集） */
const PROGRESS_INTRO = "做到哪了、下一步做什么：每段工作结束时写回。";

/** 项目的维护者 pm-1 在项目 p-1 里建一个内部任务（用户在它的会话里点明了） */
const newInternal = (td: TestDaemon, title: string, what: string, kind: NewInternalTask["kind"]) =>
  td.daemon.tasks.createInternal({ projectId: "p-1", title, summary: what, kind }, "pm-1");

/** 一个已在使用中的项目（立项书已确认） */
function inUseProject(td: TestDaemon, name: string, overrides: Partial<Project> = {}): Project {
  return seedProject(td.daemon, name, { state: "in_use", charterConfirmed: true, kind: "dev", toolkit: { skills: [], mcp: [], bash: false, network: false }, ...overrides });
}

async function connect(url: string, channels: string[] = [BOARD, CARDS, INBOX, PROJECTS, PM1]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

/** 写笔记、读一遍（项目的工作目录里）；条件：读之前必须写过 */
const notesDraft: WorkflowPlanDraft = {
  goal: "写好周报目录说明并读一遍",
  steps: [
    { id: "s1", title: "写说明", tool: TOOL.write, args: { path: "weekly-index.md", content: "# 周报目录\n- 2026-10\n" } },
    { id: "s2", title: "读一遍", tool: TOOL.read, args: { path: "weekly-index.md" }, after: ["s1"] },
  ],
  rules: [{ id: "write-before-read", title: "先写再读", trigger: { tool: TOOL.read }, require: { before: { tool: TOOL.write } }, on_violation: "pull_back" }],
};

const INTERNAL_SOURCE = "项目「记账本」内部 · 任务「整理周报目录」";

describe("点明了才发起：用户在项目的维护者会话里点明", () => {
  it("说了“按流程做”：维护者建出项目内部流程（它执行、只动这个项目）；它写任务书后对话段收尾，起草计划的工单段用 propose_plan 交出步骤，流程计划卡进待我处理、来源写明“项目「记账本」内部”；授权后执行、照计划逐步核对，report_step 做完；看板频道上的任务带着 internal，用量记在任务名下", async () => {
    const d = dirs();
    const records = d.records();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        if (spawn === 1)
          return [
            // 对话段：用户点明了按流程做，建出项目内部流程，对齐后写任务书
            call("start_workflow", { title: "整理周报目录", summary: "把周报目录的说明写好" }),
            writeBrief("t-1", "周报目录有一份说明"),
            say("好的，我先起草计划"),
            // 起草计划的工单在等：这一段对话先收尾，被催了写回进展、写摘要
            progressEdit(records, PROGRESS_INTRO, "周报目录：发起了项目内部流程 t-1。"),
            summary("发起了项目内部流程 t-1"),
            say("写回了"),
          ];
        if (spawn === 2)
          return [
            // 起草计划的工单段：交步骤和条件，写回进展、写摘要，最后看一眼系统提示和能用的工具
            propose(notesDraft),
            writeProgress("周报目录：流程的计划交了，等授权。"),
            summary("起草了流程 t-1 的计划"),
            { kind: "echo_context" },
          ];
        return [
          // 执行的工单段：照步骤做，report_step 自报；做完被催了写回（写项目档案不在步骤里，用 write_progress）
          report("s1", "in_progress"),
          call("write", { path: "weekly-index.md", content: "# 周报目录\n- 2026-10\n" }),
          report("s1", "done", "写好了"),
          report("s2", "in_progress"),
          call("read", { path: "weekly-index.md" }),
          report("s2", "done", "读过了"),
          say("都做完了"),
          writeProgress("周报目录：流程 t-1 做完了。"),
          summary("流程 t-1 做完了"),
          say("写回了"),
        ];
      },
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url);

    await frontend.sendText("按流程做：把周报目录的说明写好", { conversation: PM1 });
    const created = await taskWhere(frontend, (e) => e.change === "created", "建出的项目内部流程");
    expect(created).toMatchObject({
      by: "maintainer",
      task: { id: "t-1", title: "整理周报目录", state: "planning", origin: "request", kind: "workflow", internal: P1, maintainerId: "pm-1", projects: ["记账本"], projectIds: ["p-1"], projectScope: "single" },
    });

    // 起草计划的工单派给它自己；对话段写回之后才开始
    const card = await cardWhere(frontend, (c) => c.type === "workflow_plan", "流程计划卡");
    const p = card.payload as WorkflowPlanCardPayload;
    expect(p).toMatchObject({ taskId: "t-1", taskTitle: "整理周报目录", revision: 1 });
    expect(p.plan.steps.map((s) => [s.id, s.tool])).toEqual([
      ["s1", "write"],
      ["s2", "read"],
    ]);
    // 起草计划这一段的系统提示里有流程的工作方式，交计划的工具是 propose_plan
    await waitUntil(() => messagesOf(frontend, PM1).some((m) => m.message.speaker === "agent" && textOf(m).includes("[system]")), { timeoutMs: 30_000, describe: () => "起草计划这一段的回显" });
    const drafting = messagesOf(frontend, PM1).find((m) => m.message.speaker === "agent" && textOf(m).includes("[system]"))!;
    expect(textOf(drafting)).toContain("这一段的工单是流程：起草时用 propose_plan 交出步骤和条件");
    expect(textOf(drafting)).toContain("[tool] propose_plan");
    expect(textOf(drafting)).not.toContain("[tool] submit_plan");
    // 计划卡在待我处理里，来源写明是项目内部的
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === card.id, "计划卡的待我处理事项");
    expect(item.source).toBe(INTERNAL_SOURCE);
    await waitUntil(() => workOrdersOf(frontend).some((e) => e.change === "ended" && e.workOrder.kind === "plan"), { timeoutMs: 30_000, describe: () => "起草计划的工单结束" });

    // 授权：排队、占全局执行名额开始执行，照步骤做完
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: { confirmations: [] } }));
    const done = await taskWhere(frontend, (e) => e.change === "completed", "流程完成", 60_000);
    expect(done.task).toMatchObject({ state: "done", internal: P1, steps: { total: 2, done: 2 } });
    expect(fs.readFileSync(path.join(records, "workdir", "weekly-index.md"), "utf8")).toContain("2026-10");
    await waitUntil(() => workOrdersOf(frontend).some((e) => e.change === "ended" && e.workOrder.kind === "execute"), { timeoutMs: 30_000, describe: () => "执行的工单结束" });
    expect(fs.readFileSync(path.join(records, "progress.md"), "utf8")).toContain("流程 t-1 做完了");
    // 看板频道上这个任务的每条事件都带着 internal（前端据此不放上全局看板）
    expect(tasksOf(frontend).every((e) => isProjectInternal(e.task))).toBe(true);
    // 用量记在这个任务名下（任务详情、项目页看得到），消耗页按项目的维护者列出
    const totals = frontend.events({ channel: BOARD, type: EVENT_TYPES.tokenTotals }).map((f) => f.payload as TokenTotalsEventPayload);
    expect(totals.some((t) => t.owner.kind === "task" && t.owner.id === "t-1" && t.byAgent.some((r) => r.agentId === "pm-1"))).toBe(true);
  }, 120_000);

  it("说了“发起任务”：维护者建出项目内部长程任务；起草计划的工单段用 submit_plan 交出，计划卡的来源写明“项目「记账本」内部”", async () => {
    const d = dirs();
    const records = d.records();
    const plan = samplePlan({ toolkit: { skills: [], mcp: [], bash: false, network: false } });
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        if (spawn === 1)
          return [
            call("create_task", { title: "给记账本加月报", summary: "每月出一份月报" }),
            writeBrief("t-1", "每月一份月报", ["记账本"]),
            say("好的"),
            progressEdit(records, PROGRESS_INTRO, "月报：发起了项目内部长程任务 t-1。"),
            summary("发起了 t-1"),
            say("写回了"),
          ];
        return [submitPlanStep(plan), writeProgress("月报：计划交了。"), summary("起草了 t-1 的计划"), say("计划交了")];
      },
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url);

    await frontend.sendText("发起任务：给记账本加月报", { conversation: PM1 });
    const created = await taskWhere(frontend, (e) => e.change === "created", "建出的项目内部长程任务");
    expect(created.task).toMatchObject({ kind: "long_running", internal: P1, origin: "request", maintainerId: "pm-1", projectIds: ["p-1"] });
    const card = await cardWhere(frontend, (c) => c.type === "plan", "计划卡");
    expect((card.payload as PlanCardPayload).taskId).toBe("t-1");
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === card.id, "计划卡的待我处理事项");
    expect(item.source).toBe("项目「记账本」内部 · 任务「给记账本加月报」");
  }, 90_000);
});

describe("项目内部流程的计划被拒", () => {
  it("用户拒绝了项目内部流程的计划（附说明）：任务回到规划中，重新起草是一张新的起草计划工单（新的一段），说明连同任务书交回维护者", async () => {
    const td = await startTestDaemon({
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        if (spawn === 1) return [propose(notesDraft), writeProgress("周报目录：计划交了。"), summary("起草了 t-1 的计划"), say("计划交了")];
        return [{ kind: "echo_context" }];
      },
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url);
    const task = newInternal(td, "整理周报目录", "把周报目录的说明写好", "workflow");
    td.daemon.tasks.writeBrief(task.id, { goal: "周报目录有一份说明", acceptanceCriteria: ["有说明"], constraints: [], projects: ["记账本"], memoryScope: "" }, { maintainerId: "pm-1" });
    const card = await cardWhere(frontend, (c) => c.type === "workflow_plan", "流程计划卡");
    await waitUntil(() => workOrdersOf(frontend).some((e) => e.change === "ended" && e.workOrder.kind === "plan"), { timeoutMs: 30_000, describe: () => "第一张起草计划的工单结束" });

    ok(await frontend.cardAction({ cardId: card.id, action: "reject", expectedVersion: 1, note: "说明里再加上 2026-09" }));
    await taskWhere(frontend, (e) => e.change === "plan_rejected", "回到规划中");
    const second = await eventually(() => workOrdersOf(frontend), (e) => e.change === "started" && e.workOrder.kind === "plan" && e.workOrder.id !== "wo-1", "第二张起草计划的工单开始");
    expect(second.workOrder.instructions).toContain("用户拒绝了计划 v1。用户说明：说明里再加上 2026-09");
    expect(second.workOrder.instructions).toContain("涉及的项目：记账本（项目内部任务：只动这个项目，只在项目里看得到）");
    await waitUntil(() => messagesOf(frontend, PM1).some((m) => m.message.speaker === "agent" && textOf(m).includes("[system]") && textOf(m).includes("用户拒绝了计划 v1")), {
      timeoutMs: 30_000,
      describe: () => "维护者在新的一段里看到拒绝的说明",
    });
  }, 90_000);
});

describe("没点明：最多给一张建议卡", () => {
  it("用户只说了要做的事：维护者去建任务被拒（原因交回它），改给一张建议卡（卡上带着项目）；一轮只能给一张；不建任务", async () => {
    const td = await startTestDaemon({
      secretary: [say("好的")],
      maintainer: (id) =>
        id === "pm-1"
          ? [
              call("create_task", { title: "升级依赖", summary: "把依赖升到最新" }),
              call("start_workflow", { title: "升级依赖", summary: "把依赖升到最新" }),
              call("suggest_task", { title: "升级依赖", why: "依赖半年没升级了" }),
              call("suggest_task", { title: "再升级一次", why: "再来一张" }),
              { kind: "echo_context" },
            ]
          : [],
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url);
    await frontend.sendText("依赖好久没升级了", { conversation: PM1 });
    await turnsOf(frontend, PM1, 1);

    const seen = lastSeen(frontend, PM1);
    expect(seen).toContain("[toolResult] create_task: 用户这一轮没有点明要发起任务");
    expect(seen).toContain("[toolResult] start_workflow: 用户这一轮没有点明要发起任务");
    expect(seen).toContain("[toolResult] suggest_task: 这一轮已经给过一张建议卡了，一轮最多一张。");
    const suggestions = cardsOf(frontend).filter((c) => c.type === "suggest_task");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ status: "pending", typeVersion: 4, payload: { title: "升级依赖", internal: { projectId: "p-1", projectName: "记账本" } } });
    expect(td.daemon.tasks.list()).toEqual([]);
    expect(tasksOf(frontend)).toEqual([]);
  });

  it("点建议卡上的“作为流程”：在这个项目里建出项目内部流程（用户发起），卡上记着种类和任务编号，通知交给维护者（不交给秘书）；另一张点“作为长程任务”", async () => {
    const td = await startTestDaemon({
      secretary: [say("好的")],
      maintainer: (id) =>
        id === "pm-1"
          ? [
              call("suggest_task", { title: "升级依赖", why: "依赖半年没升级了" }),
              say("要不要在项目里做一次？"),
              { kind: "echo_context" },
              call("suggest_task", { title: "整理测试", why: "测试越来越慢" }),
              say("这个也可以"),
              { kind: "echo_context" },
            ]
          : [],
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1, SECRETARY]);
    await frontend.sendText("依赖好久没升级了", { conversation: PM1 });
    const first = await cardWhere(frontend, (c) => c.type === "suggest_task", "建议卡");
    await turnsOf(frontend, PM1, 1);

    ok(await frontend.cardAction({ cardId: first.id, action: "start_workflow", expectedVersion: 1 }));
    const workflow = await taskWhere(frontend, (e) => e.change === "created", "建出的项目内部流程");
    expect(workflow).toMatchObject({ by: "user", task: { id: "t-1", title: "升级依赖", origin: "suggestion", kind: "workflow", internal: P1, maintainerId: "pm-1", projectIds: ["p-1"] } });
    const handled = await cardWhere(frontend, (c) => c.id === first.id && c.status === "handled", "处理过的建议卡");
    expect(handled.payload).toMatchObject({ taskId: "t-1", kind: "workflow" });
    // 通知交给维护者（带着任务编号，在对话段里接着对齐、写任务书），秘书什么都没收到
    await turnsOf(frontend, PM1, 2);
    expect(lastSeen(frontend, PM1)).toContain("用户在你的建议卡上点了「作为流程」：项目内部流程 t-1「升级依赖」已建好（规划中）");
    expect(messagesOf(frontend, SECRETARY)).toEqual([]);

    await frontend.sendText("测试也很慢", { conversation: PM1 });
    const second = await cardWhere(frontend, (c) => c.type === "suggest_task" && c.id !== first.id, "第二张建议卡");
    ok(await frontend.cardAction({ cardId: second.id, action: "start_task", expectedVersion: 1 }));
    const longRunning = await taskWhere(frontend, (e) => e.change === "created" && e.task.id === "t-2", "建出的项目内部长程任务");
    expect(longRunning.task).toMatchObject({ origin: "suggestion", kind: "long_running", internal: P1 });
  }, 60_000);
});

describe("可见范围", () => {
  it("秘书的只读工具看不到项目内部任务的细节：查看板、看板变化里没有它（查看板只说项目「记账本」里有几个在进行），列出待我处理只说是“项目「记账本」内部的事项”，它的卡片放不进秘书的聊天，任务控制、提问卡、写任务书也认不出它；它的计划卡照常进待我处理、来源写明项目内部", async () => {
    const td = await startTestDaemon({
      secretary: [
        call("view_board", {}),
        call("list_inbox", {}),
        call("propose_quick_action", { type: "pause_task", params: { task: "t-1" } }),
        call("ask_questions", { taskId: "t-1", questions: [{ question: "要不要测？", recommended: "要", options: ["要", "不要"] }] }),
        call("write_task_brief", { taskId: "t-1", goal: "重构", acceptanceCriteria: ["做完"], constraints: [], projects: [], memoryScope: "" }),
        { kind: "echo_context" },
      ],
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, SECRETARY]);
    // 项目内部的长程任务交了计划（计划卡等用户确认），另有一个普通任务
    const internal = newInternal(td, "内部重构", "重构记账逻辑", "long_running");
    td.daemon.tasks.submitPlan(internal.id, "pm-1", samplePlan({ toolkit: { skills: [], mcp: [], bash: false, network: false } }));
    td.daemon.tasks.createByRequest({ title: "整理发票", summary: "整理发票" });
    const card = await cardWhere(frontend, (c) => c.type === "plan", "项目内部任务的计划卡");
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === card.id, "待我处理里的计划卡");
    expect(item.source).toBe("项目「记账本」内部 · 任务「内部重构」");
    // 看板频道上带着 internal（前端不放上全局看板）
    expect(tasksOf(frontend).filter((e) => e.task.id === internal.id).every((e) => isProjectInternal(e.task))).toBe(true);
    // 事项带着项目内部的标记
    expect(item.internal).toEqual(P1);

    await frontend.sendText("看看看板和待我处理");
    await turnsOf(frontend, SECRETARY, 1);
    const seen = lastSeen(frontend, SECRETARY);
    const resultOf = (tool: string) => seen.slice(seen.lastIndexOf(`[toolResult] ${tool}: `)).split("\n[")[0]!;
    // 查看板、看板变化：只有普通任务；项目内部任务只有数目（用户问起时秘书引导他到项目页）
    expect(resultOf("view_board")).toContain("整理发票");
    expect(resultOf("view_board")).toContain("项目「记账本」里有 1 个进行中的内部任务");
    expect(seen).toContain("【看板变化】");
    expect(seen).not.toContain("内部重构");
    expect(seen).not.toContain("重构记账逻辑");
    // 列出待我处理：只说是哪个项目内部的事项，不给标题和卡片
    expect(resultOf("list_inbox")).toContain(`事项 ${item.id}：项目「记账本」内部的事项（细节只在项目里看得到`);
    expect(resultOf("list_inbox")).not.toContain(card.id);
    // 任务控制、提问卡、写任务书都认不出它
    expect(resultOf("propose_quick_action")).toContain("没有任务「t-1」");
    expect(resultOf("ask_questions")).toContain("没有编号为 t-1 的任务");
    expect(resultOf("write_task_brief")).toContain("没有编号为 t-1 的任务");
    // 秘书拿不到它的卡片编号；就算拿到了，把它放进聊天也被拒（对秘书来说待我处理里没有这张卡）
    const show = inboxTools(td.daemon.inbox, td.daemon.cards).find((t) => t.spec.name === "show_card")!;
    expect(await show.run({ cardIds: [card.id] }, { callId: "x", agentId: "secretary" } as never)).toMatchObject({ isError: true, text: expect.stringContaining(`待我处理里没有这些卡片：${card.id}`) });
    expect(td.daemon.tasks.get(internal.id)?.state).toBe("awaiting_confirm");
  }, 60_000);
});

describe("名额", () => {
  it("项目内部任务执行时照常占全局执行名额：只有一个名额、它在执行时，普通任务确认了也留在排队中；它取消了，普通任务才开始", async () => {
    const plan = samplePlan({ toolkit: { skills: [], mcp: [], bash: false, network: false } });
    const td = await startTestDaemon({
      secretary: [say("好的")],
      config: { tasks: { maxRunning: 1 } },
      maintainer: (id) => (id === "pm-1" ? [say("开始做内部重构")] : id === "tm-2" ? [say("开始整理发票")] : []),
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url);
    const internal = newInternal(td, "内部重构", "重构记账逻辑", "long_running");
    const internalCard = td.daemon.tasks.submitPlan(internal.id, "pm-1", plan).cardId;
    ok(await frontend.cardAction({ cardId: internalCard, action: "confirm", expectedVersion: 1, input: {} }));
    await taskWhere(frontend, (e) => e.task.id === internal.id && e.change === "started", "项目内部任务开始执行");

    const other = td.daemon.tasks.createByRequest({ title: "整理发票", summary: "整理发票" });
    const otherCard = td.daemon.tasks.submitPlan(other.id, "tm-2", plan).cardId;
    ok(await frontend.cardAction({ cardId: otherCard, action: "confirm", expectedVersion: 1, input: {} }));
    await taskWhere(frontend, (e) => e.task.id === other.id && e.change === "plan_confirmed", "普通任务确认");
    await new Promise((r) => setTimeout(r, 500));
    expect(td.daemon.tasks.get(other.id)?.state).toBe("queued");

    ok(await frontend.taskAction({ taskId: internal.id, action: "cancel" }));
    await taskWhere(frontend, (e) => e.task.id === other.id && e.change === "started", "名额空出来，普通任务开始");
  }, 60_000);
});

describe("秘书那里点明：替用户建成项目内部任务", () => {
  it("用户在秘书那里说“按流程做：记账本的……”：秘书建流程时写上这个项目，建出的是记账本的内部流程（由项目的维护者执行，通知交给它）；秘书只知道建在哪个项目里；项目名不对、写了几个项目的流程被拒；说“发起任务”的同样建成内部长程任务", async () => {
    const td = await startTestDaemon({
      secretary: [
        call("start_workflow", { title: "升级依赖", summary: "把记账本的依赖升到最新", projects: ["账本"] }),
        call("start_workflow", { title: "升级依赖", summary: "把记账本的依赖升到最新", projects: ["记账本", "家电档案"] }),
        call("start_workflow", { title: "升级依赖", summary: "把记账本的依赖升到最新", projects: ["记账本"] }),
        { kind: "echo_context" },
        call("create_task", { title: "给记账本加月报", summary: "每月出一份月报", projects: ["记账本"] }),
        say("已在项目「记账本」里建了内部任务"),
      ],
      maintainer: (id) => (id === "pm-1" ? [say("我理解你要把依赖升到最新，对吗？"), say("我理解你要加月报，对吗？")] : []),
    });
    inUseProject(td, "记账本");
    inUseProject(td, "家电档案");
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1, SECRETARY]);

    await frontend.sendText("按流程做：记账本的依赖升级一下");
    const created = await taskWhere(frontend, (e) => e.change === "created", "秘书替用户建的项目内部流程");
    expect(created).toMatchObject({ by: "secretary", task: { id: "t-1", kind: "workflow", origin: "request", internal: P1, maintainerId: "pm-1", projects: ["记账本"], projectIds: ["p-1"], projectScope: "single" } });
    await turnsOf(frontend, SECRETARY, 1);
    const seen = lastSeen(frontend, SECRETARY);
    expect(seen).toContain("[toolResult] start_workflow: 项目列表里没有「账本」（现有：记账本、家电档案）。说不清是哪个项目时先问用户，不要猜");
    expect(seen).toContain("[toolResult] start_workflow: 流程只在一个项目里做");
    expect(seen).toContain("[toolResult] start_workflow: 已在项目「记账本」里建了内部任务");
    // 秘书只知道建在哪个项目里：交回它的话里没有任务编号
    expect(seen).not.toContain("t-1");
    // 通知交给项目的维护者（在对话段里和用户对齐、写任务书）
    await turnsOf(frontend, PM1, 1);
    const notice = messagesOf(frontend, PM1).find((m) => m.agentInput && textOf(m).includes("用户在秘书那里点明了要在这个项目里做"))!;
    expect(textOf(notice)).toContain("项目内部流程 t-1「升级依赖」已建好（规划中）");
    expect(notice).toMatchObject({ projectId: "p-1", taskId: "t-1" });

    await frontend.sendText("发起任务：给记账本加个月报");
    const second = await taskWhere(frontend, (e) => e.change === "created" && e.task.id === "t-2", "秘书替用户建的项目内部长程任务");
    expect(second.task).toMatchObject({ kind: "long_running", internal: P1, maintainerId: "pm-1" });
    expect(td.daemon.tasks.list().map((t) => t.id)).toEqual(["t-1", "t-2"]);
  }, 60_000);
});

describe("秘书给的建议卡上写了一个项目", () => {
  it("用户点了卡上的按钮：建成这个项目的内部任务（只涉及一个项目的一律是内部任务），通知交给项目的维护者、不交给秘书", async () => {
    const td = await startTestDaemon({ secretary: [say("好的")], maintainer: (id) => (id === "pm-1" ? [say("我理解你要整理分类，对吗？")] : []) });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1, SECRETARY]);
    const card = td.daemon.cards.create({ type: "suggest_task", payload: { title: "整理记账本的分类", why: "分类越来越乱", projects: ["记账本"] } });
    ok(await frontend.cardAction({ cardId: card.id, action: "start_task", expectedVersion: 1 }));
    const created = await taskWhere(frontend, (e) => e.change === "created", "建出的项目内部任务");
    expect(created).toMatchObject({ by: "user", task: { origin: "suggestion", kind: "long_running", internal: P1, maintainerId: "pm-1" } });
    await turnsOf(frontend, PM1, 1);
    expect(messagesOf(frontend, PM1).some((m) => m.agentInput && textOf(m).includes("用户在秘书给的建议卡（卡上写着这个项目）上点了「作为长程任务」"))).toBe(true);
    expect(messagesOf(frontend, SECRETARY)).toEqual([]);
  }, 60_000);
});

describe("立项书确认之前", () => {
  it("项目还在立项（立项书没确认）：在秘书那里点明、点秘书给的建议卡都建不成它的内部任务，回一句“项目「家电档案」还在立项，确认立项书后再发起”（发起对话框的在 task-launch.test.ts；首个建设任务例外，在确认立项书时建出，见 work-orders.test.ts）", async () => {
    const td = await startTestDaemon({
      secretary: [call("start_workflow", { title: "升级依赖", summary: "把家电档案的依赖升到最新", projects: ["家电档案"] }), { kind: "echo_context" }],
    });
    seedProject(td.daemon, "家电档案");
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, SECRETARY]);
    await frontend.sendText("按流程做：家电档案的依赖升级一下");
    await turnsOf(frontend, SECRETARY, 1);
    expect(lastSeen(frontend, SECRETARY)).toContain("[toolResult] start_workflow: 项目「家电档案」还在立项，确认立项书后再发起");
    const card = td.daemon.cards.create({ type: "suggest_task", payload: { title: "整理家电档案", why: "档案越来越乱", projects: ["家电档案"] } });
    expect(await frontend.cardAction({ cardId: card.id, action: "start_task", expectedVersion: 1 })).toMatchObject({
      ok: false,
      error: { code: "not_allowed", message: "项目「家电档案」还在立项，确认立项书后再发起" },
    });
    expect(td.daemon.tasks.list()).toEqual([]);
    expect(td.daemon.store.read(maintainerChannel("pm-1"), 0, EVENT_TYPES.message)).toEqual([]);
  }, 60_000);
});

describe("维护者正在做工单时发起", () => {
  it("用户从发起对话框发起项目内部任务时维护者正在做别的工单：通知带着任务编号排着，不进这张工单的一段（那里没有写任务书的工具）；工单结束、维护者空下来，开一个对话段交给它，它接着写任务书，派起草计划的工单", async () => {
    const d = dirs();
    const plan = samplePlan({ toolkit: { skills: [], mcp: [], bash: false, network: false } });
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        // 起草 t-1 计划的工单段：先看看（这一轮结束，工单还在做）；交了计划之后被催写回
        if (spawn === 1) return [say("我先看看月报怎么出"), writeProgress("月报：计划交了。"), summary("起草了 t-1 的计划"), say("写回了")];
        // 空下来开的对话段：接着 t-2 的通知，写任务书；起草计划的工单在等，被催写回
        if (spawn === 2)
          return [writeBrief("t-2", "账目能导出成表格", ["记账本"]), say("任务书写好了"), progressEdit(d.records(), PROGRESS_INTRO, "导出：t-2 的任务书写好了。"), summary("写了 t-2 的任务书"), { kind: "echo_context" }];
        return [say("我来起草 t-2 的计划")];
      },
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url);
    const first = projectTask(td.daemon, "记账本", "给记账本加月报", { goal: "每月一份月报", acceptanceCriteria: ["有月报"], constraints: [], memoryScope: "" });
    await turnsOf(frontend, PM1, 1);
    expect(td.daemon.workOrders.current("pm-1")).toMatchObject({ kind: "work_order", taskId: first.id });

    ok(await frontend.startTask("给记账本加导出", "k-export", ["记账本"]));
    const created = await taskWhere(frontend, (e) => e.change === "created" && e.task.id === "t-2", "建出的项目内部任务");
    expect(created.task).toMatchObject({ internal: P1, maintainerId: "pm-1" });
    const notice = await eventually(() => messagesOf(frontend, PM1), (m) => m.agentInput === true && textOf(m).includes("用户点「发起任务」、选了这个项目"), "交给维护者的通知");
    expect(notice).toMatchObject({ taskId: "t-2", projectId: "p-1" });
    // 正在做 t-1 的工单：通知排着，不进这一段
    await new Promise((r) => setTimeout(r, 500));
    expect(frontend.events({ channel: PM1, type: EVENT_TYPES.turnEnd })).toHaveLength(1);

    // t-1 的计划交了：这张工单收尾、写回后结束；维护者空下来，开一个对话段把通知交给它，它写了 t-2 的任务书
    td.daemon.tasks.submitPlan(first.id, "pm-1", plan);
    const second = await eventually(() => workOrdersOf(frontend), (e) => e.workOrder.kind === "plan" && e.workOrder.taskId === "t-2" && e.change === "started", "t-2 起草计划的工单开始", 60_000);
    expect(second.workOrder.maintainerId).toBe("pm-1");
    expect(td.daemon.tasks.brief("t-2")?.brief.goal).toBe("账目能导出成表格");
    const ended = workOrdersOf(frontend).find((e) => e.change === "ended" && e.workOrder.kind === "plan" && e.workOrder.taskId === first.id);
    expect(ended).toBeDefined();
    // 对话段里交给它的就是这条通知（这一段的会话里看得到）
    const echo = await eventually(() => messagesOf(frontend, PM1), (m) => m.message.speaker === "agent" && textOf(m).includes("[system]"), "对话段的回显");
    expect(textOf(echo)).toContain("项目内部长程任务 t-2「给记账本加导出」已建好（规划中）");
  }, 120_000);
});

describe("没有任务编号的事项：秘书照样看不到细节", () => {
  it("项目内部任务起草计划这一段里的审批卡（负载里没有任务编号）：待我处理的事项带着标记，秘书列出时只有一行“项目「记账本」内部的事项”，卡片放不进秘书的聊天", async () => {
    const d = dirs();
    const outside = path.join(fs.realpathSync.native(d.homeDir), "notes.txt");
    fs.writeFileSync(outside, "主目录里的笔记");
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [call("list_inbox", {}), { kind: "echo_context" }],
      // 起草计划时读一个项目外的文件：先问用户
      maintainer: (id) => (id === "pm-1" ? [call("read", { path: outside }), say("读完了")] : []),
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1, SECRETARY]);
    const task = newInternal(td, "内部重构", "重构记账逻辑", "long_running");
    td.daemon.tasks.writeBrief(task.id, { goal: "记账逻辑拆清楚", acceptanceCriteria: ["拆好了"], constraints: [], projects: [], memoryScope: "" }, { maintainerId: "pm-1" });
    const approval = await cardWhere(frontend, (c) => c.type === "approval", "起草计划这一段的审批卡");
    expect((approval.payload as { taskId?: string }).taskId).toBeUndefined();
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === approval.id, "审批卡的待我处理事项");
    expect(item).toMatchObject({ internal: P1, source: "项目「记账本」内部 · 任务「内部重构」" });

    await frontend.sendText("有什么要我处理的？");
    await turnsOf(frontend, SECRETARY, 1);
    const seen = lastSeen(frontend, SECRETARY);
    expect(seen).toContain(`事项 ${item.id}：项目「记账本」内部的事项（细节只在项目里看得到`);
    expect(seen).not.toContain(approval.id);
    expect(seen).not.toContain("内部重构");
    const show = inboxTools(td.daemon.inbox, td.daemon.cards).find((t) => t.spec.name === "show_card")!;
    expect(await show.run({ cardIds: [approval.id] }, { callId: "x", agentId: "secretary" } as never)).toMatchObject({ isError: true });
    ok(await frontend.cardAction({ cardId: approval.id, action: "approve", expectedVersion: approval.version }));
  }, 60_000);

  it("项目内部任务起草计划的工单段催写回到了次数：卡住求助（正文里有工单的标题）带着标记，秘书列出时只有一行", async () => {
    const td = await startTestDaemon({
      secretary: [call("list_inbox", {}), { kind: "echo_context" }],
      // 交了计划，怎么催都不写回
      maintainer: (id) => (id === "pm-1" ? [submitPlanStep(samplePlan({ toolkit: { skills: [], mcp: [], bash: false, network: false } })), say("计划交了"), say("不写"), say("还是不写"), say("就是不写")] : []),
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1, SECRETARY]);
    const task = newInternal(td, "内部重构", "重构记账逻辑", "long_running");
    td.daemon.tasks.writeBrief(task.id, { goal: "记账逻辑拆清楚", acceptanceCriteria: ["拆好了"], constraints: [], projects: [], memoryScope: "" }, { maintainerId: "pm-1" });
    const help = await eventually(() => inboxOf(frontend), (i) => i.kind === "notice" && i.notice === "stuck_help", "卡住求助");
    expect(help.kind === "notice" && help.body).toContain("起草计划：内部重构");
    expect(help.internal).toEqual(P1);

    await frontend.sendText("有什么要我处理的？");
    await turnsOf(frontend, SECRETARY, 1);
    const seen = lastSeen(frontend, SECRETARY);
    expect(seen).toContain(`事项 ${help.id}：项目「记账本」内部的事项（细节只在项目里看得到`);
    expect(seen).not.toContain("内部重构");
  }, 60_000);
});

describe("检索素材", () => {
  it("秘书检索不到项目内部任务的记录（结局、计划的决定、建议卡被关掉）；用户在项目会话里说过的话照常检索得到；普通任务的照常", async () => {
    const td = await startTestDaemon({
      secretary: [call("search_materials", { query: "重构" }), { kind: "echo_context" }],
      maintainer: (id) => (id === "pm-1" ? [say("好，我记着")] : []),
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1, SECRETARY]);
    // 项目内部任务：计划被打回（用户写了原因），然后取消
    const internal = newInternal(td, "内部重构", "重构记账逻辑", "long_running");
    const plan = samplePlan({ toolkit: { skills: [], mcp: [], bash: false, network: false } });
    const card = td.daemon.tasks.submitPlan(internal.id, "pm-1", plan).cardId;
    ok(await frontend.cardAction({ cardId: card, action: "reject", expectedVersion: 1, note: "重构先别动 ledger" }));
    ok(await frontend.taskAction({ taskId: internal.id, action: "cancel" }));
    // 项目的维护者给的建议卡被关掉（回避信号）
    const suggestion = td.daemon.cards.create({ type: "suggest_task", payload: { title: "顺手重构日志", why: "日志太乱", internal: P1 } });
    ok(await frontend.cardAction({ cardId: suggestion.id, action: "dismiss", expectedVersion: 1 }));
    // 普通任务取消了
    const other = td.daemon.tasks.createByRequest({ title: "外部重构调研", summary: "外部重构调研" });
    ok(await frontend.taskAction({ taskId: other.id, action: "cancel" }));
    // 用户在项目的会话里说的话
    await frontend.sendText("内部重构要小心", { conversation: PM1 });
    await turnsOf(frontend, PM1, 1);
    // 素材库里都有（只是秘书检索不到项目内部的记录）
    expect(td.daemon.materials.searchKeyword("内部重构").map((m) => m.kind).toSorted()).toEqual(["approval_decision", "task_outcome", "user_utterance"]);

    await frontend.sendText("找找重构相关的");
    await turnsOf(frontend, SECRETARY, 1);
    const seen = lastSeen(frontend, SECRETARY);
    const result = seen.slice(seen.lastIndexOf("[toolResult] search_materials: ")).split("\n[")[0]!;
    expect(result).toContain("内部重构要小心");
    expect(result).toContain("任务「外部重构调研」已取消");
    expect(result).not.toContain("任务「内部重构」");
    expect(result).not.toContain("先别动 ledger");
    expect(result).not.toContain("顺手重构日志");
  }, 60_000);
});

describe("归档和定时触发", () => {
  it("项目内部任务结束了由用户在项目页上归档（task_action 的 archive）；结束了的全局任务也能这样直接归档（90 号票）；定时触发的内部任务（76 号票）由项目的维护者运行，它的触发登记带着标记，不上秘书的看板", async () => {
    const td = await startTestDaemon({
      secretary: [call("view_board", {}), { kind: "echo_context" }],
      maintainer: () => [],
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1, SECRETARY]);
    const internal = newInternal(td, "季度清理", "清理过期数据", "long_running");
    // 发起对话框里选了这个项目、定时：建成这个项目的定时触发的内部普通任务（建出就是运营中，登记触发）
    const weekly = { kind: "schedule" as const, schedule: { kind: "weekly" as const, time: "09:00", weekdays: [1] } };
    const timed = ok(await frontend.startTask("每周检查依赖\n看看依赖有没有新版本", "k-timed", ["记账本"], "plain", weekly)) as { taskId: string };
    expect(td.daemon.tasks.get(timed.taskId)).toMatchObject({ state: "operating", kind: "plain", trigger: weekly, maintainerId: "pm-1", internal: P1 });
    const job = (await eventually(() => frontend.events({ channel: BOARD, type: EVENT_TYPES.scheduledJob }).map((f) => f.payload as ScheduledJobEventPayload), (e) => e.change === "registered", "登记的触发")).job;
    expect(job).toMatchObject({ title: "每周检查依赖", projectId: "p-1", taskId: timed.taskId, ownerTaskId: timed.taskId, maintainerId: "pm-1", internal: P1 });

    await frontend.sendText("看看看板");
    await turnsOf(frontend, SECRETARY, 1);
    expect(lastSeen(frontend, SECRETARY)).not.toContain("每周检查依赖");
    // 定时触发的内部任务取消了（触发一起取消）能归档
    ok(await frontend.taskAction({ taskId: timed.taskId, action: "cancel" }));
    expect(td.daemon.scheduledJobs.get(job.id)!.state).toBe("cancelled");
    ok(await frontend.taskAction({ taskId: timed.taskId, action: "archive" }));

    // 没结束的不能归档；取消之后能
    expect(await frontend.taskAction({ taskId: internal.id, action: "archive" })).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    ok(await frontend.taskAction({ taskId: internal.id, action: "cancel" }));
    ok(await frontend.taskAction({ taskId: internal.id, action: "archive" }));
    expect(td.daemon.tasks.get(internal.id)).toMatchObject({ state: "archived", internal: P1 });
    // 全局任务（90 号票）：没结束的不能归档，取消之后能直接归档
    const other = td.daemon.tasks.createByRequest({ title: "整理发票", summary: "整理发票" });
    expect(await frontend.taskAction({ taskId: other.id, action: "archive" })).toMatchObject({ ok: false, error: { code: "not_allowed", message: "任务现在是规划中，还没结束：先取消再归档" } });
    ok(await frontend.taskAction({ taskId: other.id, action: "cancel" }));
    ok(await frontend.taskAction({ taskId: other.id, action: "archive" }));
    expect(td.daemon.tasks.get(other.id)!.state).toBe("archived");
  }, 60_000);
});

describe("删除项目", () => {
  it("删除项目时它的内部东西一起删掉：没结束的内部任务取消、它们的卡片和没点过的建议卡删掉、待我处理里的事项删掉；任务、任务书、计划、工单、定时作业、子 agent 并行、卡片上的文字一个不留（编号留着，新任务、新作业接着往下排）；别的任务不动", async () => {
    const td = await startTestDaemon({
      secretary: [say("好的")],
      maintainer: (id) => (id === "pm-1" ? [writeProgress("季度清理：开始了。"), summary("开始季度清理"), say("开始了")] : []),
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS]);
    // 一个授权执行过（派过子 agent）后取消了的内部长程任务
    const cleaned = newInternal(td, "季度清理", "清理过期数据", "long_running");
    const cleanedCard = td.daemon.tasks.submitPlan(cleaned.id, "pm-1", samplePlan({ toolkit: { skills: [], mcp: [], bash: false, network: false } })).cardId;
    ok(await frontend.cardAction({ cardId: cleanedCard, action: "confirm", expectedVersion: 1, input: {} }));
    await taskWhere(frontend, (e) => e.task.id === cleaned.id && e.change === "started", "开始执行");
    const agent = { agentId: "sa-1", stageId: "s1", stageTitle: "收集资料", instructions: "拆分 ledger.ts", workDir: "/tmp/sa-1", ownWorkDir: false };
    td.daemon.store.append({ channel: SUB_AGENTS_CHANNEL, type: SUB_AGENT_EVENTS.parallelProposed, payload: { proposalId: "pp-1", taskId: cleaned.id, maintainerId: "pm-1", cardId: "c-x", reason: "两块互不相干", agents: [agent], time: "2026-10-09T09:00:00.000+08:00" } });
    td.daemon.store.append({ channel: SUB_AGENTS_CHANNEL, type: SUB_AGENT_EVENTS.parallelDecided, payload: { proposalId: "pp-1", taskId: cleaned.id, taskTitle: "季度清理", cardId: "c-x", decision: "parallel", agents: [agent], by: "user", time: "2026-10-09T09:00:00.000+08:00" } });
    ok(await frontend.taskAction({ taskId: cleaned.id, action: "cancel" }));
    await waitUntil(() => td.daemon.workOrders.openOf("p-1").length === 0, { timeoutMs: 30_000, describe: () => "执行的工单结束" });
    // 一个交了计划、等确认的内部长程任务，一个还在规划中的内部流程，一个普通任务，一张没点过的内部建议卡
    const waiting = newInternal(td, "内部重构", "重构记账逻辑", "long_running");
    td.daemon.tasks.submitPlan(waiting.id, "pm-1", samplePlan({ toolkit: { skills: [], mcp: [], bash: false, network: false }, assumptions: ["记账逻辑在 ledger.ts"] }));
    const planning = newInternal(td, "升级依赖", "依赖升到最新", "workflow");
    const other = td.daemon.tasks.createByRequest({ title: "整理发票", summary: "整理发票" });
    // 一个定时触发的内部普通任务（76 号票，还在运营）
    const timed = ok(await frontend.startTask("每周检查依赖\n看看依赖有没有新版本", "k-timed", ["记账本"], "plain", { kind: "schedule", schedule: { kind: "weekly", time: "09:00", weekdays: [1] } })) as { taskId: string };
    const suggestion = td.daemon.cards.create({ type: "suggest_task", payload: { title: "顺手清理日志", why: "日志目录越来越大", internal: P1 } });
    const card = await cardWhere(frontend, (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === waiting.id, "内部任务的计划卡");
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === card.id, "计划卡的待我处理事项");

    ok(await frontend.request("project_action", { projectId: "p-1", action: "archive" }, "k-archive"));
    const asked = ok(await frontend.request("project_action", { projectId: "p-1", action: "delete" }, "k-del")) as { confirmItemId: string };
    ok(await frontend.inboxAction({ itemIds: [asked.confirmItemId], action: "handle", choice: "确认删除" }));
    await waitUntil(() => td.daemon.projects.list().length === 0, { timeoutMs: 30_000, describe: () => "项目删掉" });

    // 没结束的内部任务取消了，文字换成删除标记；结束了的照旧是已取消；普通任务不动
    for (const id of [waiting.id, planning.id, cleaned.id, timed.taskId]) expect(td.daemon.tasks.get(id)).toMatchObject({ state: "cancelled", internal: P1, title: PURGED_TEXT, summary: PURGED_TEXT });
    // 定时触发的内部任务的触发一起取消
    expect(td.daemon.scheduledJobs.ofTask(timed.taskId)).toMatchObject({ state: "cancelled", title: PURGED_TEXT });
    expect(td.daemon.tasks.get(other.id)).toMatchObject({ state: "planning", title: "整理发票" });
    // 计划卡、建议卡整张删掉，待我处理里计划卡的事项删掉了（不再卡着）、文字换成删除标记
    expect(td.daemon.cards.get(card.id)).toBeUndefined();
    expect(td.daemon.cards.get(suggestion.id)).toBeUndefined();
    expect(td.daemon.inbox.get(item.id)).toMatchObject({ deleted: true, title: PURGED_TEXT, source: "项目「记账本」内部" });
    expect(td.daemon.inbox.list().some((i) => i.id === item.id)).toBe(false);
    const latest = await eventually(() => inboxOf(frontend), (i) => i.id === item.id && i.deleted, "前端收到删掉的事项");
    expect(latest.title).toBe(PURGED_TEXT);
    // 事件日志里任务、任务书、计划、工单、定时作业、子 agent 并行、卡片的文字一个不留
    const log = JSON.stringify(td.daemon.store.readGlobal(0, 1_000_000));
    const gone = ["内部重构", "重构记账逻辑", "记账逻辑在 ledger.ts", "升级依赖", "依赖升到最新", "季度清理", "清理过期数据", "每周检查依赖", "看看依赖有没有新版本", "两块互不相干", "拆分 ledger.ts", "顺手清理日志", "日志目录越来越大"];
    for (const text of gone) expect({ text, found: log.includes(text) }).toEqual({ text, found: false });
    // 编号留着：新任务接着往下排
    expect(td.daemon.tasks.createByRequest({ title: "再来一个", summary: "再来一个" }).id).toBe("t-6");
  }, 90_000);
});

describe("删除项目时的素材（66 号票）", () => {
  it("素材库里这个项目的内部任务由系统记下的记录（结局、计划的决定、建议卡被关掉）随项目彻底删掉：检索不到、素材库里也没有了，记成一条出处是删除项目的彻底删除（不产生显式记忆命令素材）；用户本人在维护者会话里说的话、普通任务的记录照旧在", async () => {
    const td = await startTestDaemon({
      secretary: [say("好的")],
      maintainer: (id) => (id === "pm-1" ? [say("好，我记着")] : []),
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1]);
    // 项目内部任务：计划被打回（用户写了原因），然后取消；项目的维护者给的建议卡被关掉；普通任务取消了；用户在项目的会话里说的话
    const internal = newInternal(td, "内部重构", "重构记账逻辑", "long_running");
    const plan = samplePlan({ toolkit: { skills: [], mcp: [], bash: false, network: false } });
    const card = td.daemon.tasks.submitPlan(internal.id, "pm-1", plan).cardId;
    ok(await frontend.cardAction({ cardId: card, action: "reject", expectedVersion: 1, note: "重构先别动 ledger" }));
    ok(await frontend.taskAction({ taskId: internal.id, action: "cancel" }));
    const suggestion = td.daemon.cards.create({ type: "suggest_task", payload: { title: "顺手重构日志", why: "日志太乱", internal: P1 } });
    ok(await frontend.cardAction({ cardId: suggestion.id, action: "dismiss", expectedVersion: 1 }));
    const other = td.daemon.tasks.createByRequest({ title: "外部重构调研", summary: "外部重构调研" });
    ok(await frontend.taskAction({ taskId: other.id, action: "cancel" }));
    await frontend.sendText("内部重构要小心", { conversation: PM1 });
    await turnsOf(frontend, PM1, 1);
    const { materials } = td.daemon;
    const said = materials.searchKeyword("内部重构要小心");
    expect(said.map((m) => m.kind)).toEqual(["user_utterance"]);
    const records = [...materials.searchKeyword("内部重构"), ...materials.searchKeyword("顺手重构日志")].filter((m) => m.kind !== "user_utterance");
    expect(records.map((m) => m.kind).toSorted()).toEqual(["approval_decision", "avoidance_signal", "task_outcome"]);
    const outside = materials.searchKeyword("外部重构调研");
    expect(outside).toHaveLength(1);
    const commandsBefore = materials.list({ kind: "memory_command" }).length;

    await waitUntil(() => td.daemon.workOrders.openOf("p-1").length === 0, { timeoutMs: 30_000, describe: () => "没有没结束的工单" });
    ok(await frontend.request("project_action", { projectId: "p-1", action: "archive" }, "k-archive"));
    const asked = ok(await frontend.request("project_action", { projectId: "p-1", action: "delete" }, "k-del")) as { confirmItemId: string };
    ok(await frontend.inboxAction({ itemIds: [asked.confirmItemId], action: "handle", choice: "确认删除" }));
    await waitUntil(() => td.daemon.projects.list().length === 0, { timeoutMs: 30_000, describe: () => "项目删掉" });

    // 由系统记下的内部记录：素材库里没有了，也检索不到；记成一条彻底删除（出处是删除项目），它不产生显式记忆命令素材
    await waitUntil(() => records.every((m) => materials.get(m.id) === undefined), { timeoutMs: 10_000, describe: () => "内部记录从素材库删掉" });
    expect(materials.searchKeyword("先别动 ledger")).toEqual([]);
    expect(materials.searchKeyword("顺手重构日志")).toEqual([]);
    const command = td.daemon.store.read("materials", 0, EVENT_TYPES.memoryCommand).at(-1)!.payload as { command: string; from: unknown; materialIds: string[] };
    expect(command).toMatchObject({ command: "purge", from: { kind: "project_deletion", projectId: "p-1" } });
    expect(command.materialIds.toSorted()).toEqual(records.map((m) => m.id).toSorted());
    expect(materials.list({ kind: "memory_command" })).toHaveLength(commandsBefore);
    // 用户本人在维护者会话里说的话、普通任务的结局照旧在
    expect(materials.searchKeyword("内部重构要小心").map((m) => m.id)).toEqual(said.map((m) => m.id));
    expect(materials.searchKeyword("外部重构调研").map((m) => m.id)).toEqual(outside.map((m) => m.id));
    // 事件日志里也没有这些记录的原话
    const log = JSON.stringify(td.daemon.store.readGlobal(0, 1_000_000));
    for (const text of ["先别动 ledger", "顺手重构日志", "日志太乱"]) expect({ text, found: log.includes(text) }).toEqual({ text, found: false });
  }, 60_000);
});
