// 主切面：涉及多个项目的任务（规格第 8、11、12 节，17 号票）。真的守护进程，秘书、任务维护者、各项目的维护者都接 faux 剧本，
// 测试扮演前端。
// - 涉及多个项目的任务在建卡时产生自己的维护者，它的工具包固定为三样：读项目档案、派工单、汇总回执（另有运行时控制工具）；
//   不能写文件、跑 bash、联网，改不了任何项目；规划时只读各项目档案、不发工单；
// - 计划里逐行列出每个项目的改动（所属阶段、这张工单的验收标准）；用户确认计划时每一行建成一张工单，所属阶段开始时才派出；
// - 项目维护者完成或退回时交回执，回执进任务维护者的会话；回执全部到齐且都完成才能跑本阶段的验收，有退回的本阶段不通过，
//   任务维护者调整做法（重新派单，或者改计划去掉那一行）算一次验收退回；评审能读到回执和各项目的工作目录，由我验收时看得到回执；
// - 任务涉及几个项目建卡时就定了：计划里只剩一个项目也还是多项目任务；单项目任务、不涉及项目的任务的计划写不进别的项目；
// - 工单的建出、派出和回执都记在任务时间线上。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItem,
  METHODS,
  type InboxItemEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  type Plan,
  type PlanCardPayload,
  type Project,
  type ResponseFrame,
  type TaskEventPayload,
  type TimelineRecordEventPayload,
  type WorkOrderCardPayload,
  type WorkOrderEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { BUILTIN_CATEGORY_IDS } from "../../src/guard/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { seedProject } from "../helpers/projects.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const TM1 = maintainerChannel("tm-1");
const PM1 = maintainerChannel("pm-1");
const PM2 = maintainerChannel("pm-2");

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const workOrdersOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.workOrder }).map((f) => f.payload as WorkOrderEventPayload);
const recordsOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.timelineRecord }).map((f) => f.payload as TimelineRecordEventPayload);
type ToolCallPart = Extract<MessageEventPayload["message"]["parts"][number], { type: "tool_call" }>;
const toolCallsOf = (frontend: TestFrontend, channel: string) => messagesOf(frontend, channel).flatMap((m) => m.message.parts.filter((p): p is ToolCallPart => p.type === "tool_call"));
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
const workOrderWhere = (frontend: TestFrontend, match: (e: WorkOrderEventPayload) => boolean, what = "工单", timeoutMs?: number) => eventually(() => workOrdersOf(frontend), match, what, timeoutMs);
/** 等到有符合的（取第一条：后面可能已经又来了同样的） */
async function firstOf<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().find(match)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}
/** 某个维护者的回复里带着这段话（echo_context 回出来的上下文） */
const agentSaid = (frontend: TestFrontend, channel: string, text: string) =>
  eventually(() => messagesOf(frontend, channel), (m) => m.message.speaker === "agent" && textOf(m).includes(text), `${channel} 回复「${text}」`);

/** 先定下数据目录和主目录（剧本里要写项目档案的路径），再起守护进程 */
function dirs() {
  const dataDir = makeTempDir("ergou-data-");
  return { dataDir, homeDir: makeTempDir("ergou-home-"), records: (projectId: string) => path.join(fs.realpathSync.native(dataDir), "projects", projectId) };
}

/** 进展文档的一句改成另一句（项目维护者写回项目档案） */
const progressEdit = (records: string, oldText: string, newText: string) => call("edit", { path: path.join(records, "progress.md"), edits: [{ oldText, newText }] });
/** 进展文档一开始的那句（项目档案的最小文档集） */
const PROGRESS_INTRO = "做到哪了、下一步做什么：每段工作结束时写回。";
const summary = (text: string) => call("write_segment_summary", { summary: text });

/** 一个已在使用中的项目（立项书已确认） */
function inUseProject(td: TestDaemon, name: string, toolkit: Partial<NonNullable<Project["toolkit"]>> = {}): Project {
  return seedProject(td.daemon, name, { state: "in_use", charterConfirmed: true, kind: "dev", toolkit: { skills: [], mcp: [], bash: false, network: false, ...toolkit } });
}

/** 一个阶段：评审验收（回执到齐之后才跑；交付件在各项目那边，评审能读到回执和各项目的工作目录）；也可以由我验收 */
function stage(stageId: string, title: string, dependsOn: string[], method: "review" | "user" = "review"): Plan["stages"][number] {
  return {
    stageId,
    title,
    deliverables: [`${title}的回执`],
    acceptance: [{ criterion: "各项目的改动都在工作目录里", method }],
    mode: "open",
    dependsOn,
    policy: { grants: [], temporalRules: [] },
    budget: { tokens: 10_000_000, toolCalls: 300 },
  };
}

/** 涉及记账本、家电档案两个项目：s1 改记账本，s2（在 s1 之后）改家电档案；每一行带所属阶段和这张工单的验收标准 */
function twoProjectPlan(): Plan {
  return {
    stages: [stage("s1", "记账本加导出", []), stage("s2", "家电档案接导入", ["s1"])],
    stageGroups: [],
    toolkit: { skills: [], mcp: [], bash: false, network: false },
    projects: [
      { project: "记账本", changes: ["加一个导出说明 export.md"], stageId: "s1", acceptance: ["工作目录里有 export.md"] },
      { project: "家电档案", changes: ["按记账本的导出说明加导入说明 import.md"], stageId: "s2", acceptance: ["工作目录里有 import.md"] },
    ],
    watchCategories: BUILTIN_CATEGORY_IDS.map((id) => ({ id })),
    scheduledJobs: [],
    assumptions: [],
    stops: { count: 0, where: [] },
    tokenEstimate: 50_000,
  };
}

const brief = { goal: "记账本的账单能导进家电档案", acceptanceCriteria: ["两边都改好"], constraints: [], projects: ["记账本", "家电档案"], memoryScope: "" };

async function connect(url: string, channels: string[] = [BOARD, CARDS, INBOX, PROJECTS, TM1, PM1, PM2]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

/** 用户点"发起任务"、选两个项目；秘书写好任务书（秘书那一段在 tasks.test.ts 测过，这里直接写） */
async function startTwoProjectTask(td: TestDaemon, frontend: TestFrontend): Promise<string> {
  ok(await frontend.startTask("记账本导出接家电档案", "start-两个项目", ["记账本", "家电档案"]));
  const created = await taskWhere(frontend, (e) => e.change === "created", "任务建出");
  td.daemon.tasks.writeBrief(created.task.id, brief);
  return created.task.id;
}

const planCardOf = (frontend: TestFrontend, taskId: string) => cardWhere(frontend, (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === taskId, `${taskId} 的计划卡`);

describe("涉及多个项目的任务：任务自己的维护者和规划", () => {
  it("建卡时产生任务自己的维护者，工具包固定为读项目档案、派工单、汇总回执三样（加上提交计划）：没有文件写入、bash、联网，写不了任何项目的档案；规划期间只读各项目档案，派工单被拒；计划卡逐行列出每个项目的改动；确认后每一行建成一张工单（带验收标准，写明所属任务和阶段），所属阶段开始时才派出，后面阶段的工单不进项目的流水线；建出和派出都记在任务时间线上", async () => {
    const d = dirs();
    const recordsA = d.records("p-1");
    const recordsB = d.records("p-2");
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "tm-1") return [];
        if (spawn === 1)
          return [
            // 想直接改项目档案、跑 bash：都没有这些工具
            call("write", { path: path.join(recordsA, "spec.md"), content: "任务维护者改的规格" }),
            call("bash", { command: `echo 改 > "${path.join(recordsB, "workdir", "x.txt")}"` }),
            // 只能读各项目的档案
            call("read_project_records", { project: "记账本", docs: ["progress"] }),
            // 规划期间不发工单
            call("dispatch_work_order", { project: "记账本", instructions: "先把导出说明写起来" }),
            submitPlanStep(twoProjectPlan()),
            { kind: "echo_context" },
          ];
        // 执行时看一眼能用哪些工具
        return [{ kind: "echo_context" }];
      },
    });
    inUseProject(td, "记账本");
    inUseProject(td, "家电档案");
    const specBefore = fs.readFileSync(path.join(recordsA, "spec.md"), "utf8");
    const frontend = await connect(td.url);
    const taskId = await startTwoProjectTask(td, frontend);
    // 涉及两个项目：任务自己的维护者，不是哪个项目的维护者
    expect(td.daemon.tasks.get(taskId)).toMatchObject({ maintainerId: "tm-1", projects: ["记账本", "家电档案"], projectIds: ["p-1", "p-2"] });

    const card = await planCardOf(frontend, taskId);
    const seen = textOf(await agentSaid(frontend, TM1, "[tool] "));
    // 工具包只有三样，加上运行时控制的"提交计划"和每个维护者会话都有的口语总结（32 号票的语音回复）；没有文件读写、bash
    expect(seen.split("\n").filter((l) => l.startsWith("[tool] ")).toSorted()).toEqual([
      "[tool] dispatch_work_order",
      "[tool] read_project_records",
      "[tool] spoken_summary",
      "[tool] submit_plan",
      "[tool] summarize_receipts",
    ]);
    // 写项目档案、跑 bash 都做不到
    expect(toolCallsOf(frontend, TM1).filter((p) => (p.tool === "write" || p.tool === "bash") && p.outcome === "done")).toEqual([]);
    expect(fs.readFileSync(path.join(recordsA, "spec.md"), "utf8")).toBe(specBefore);
    expect(fs.existsSync(path.join(recordsB, "workdir", "x.txt"))).toBe(false);
    // 读到了记账本的进展；派工单被拒
    expect(seen).toMatch(/\[toolResult\] read_project_records: 项目 p-1「记账本」/);
    expect(seen).toContain(PROGRESS_INTRO);
    expect(seen).toMatch(/\[toolResult\] dispatch_work_order: 规划期间不派工单/);
    expect(workOrdersOf(frontend)).toEqual([]);

    // 计划卡逐行列出每个项目的改动：所属阶段、这张工单的验收标准
    expect((card.payload as PlanCardPayload).plan.projects).toEqual(twoProjectPlan().projects);
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));

    // 确认时每一行建成一张工单：等阶段开始，带验收标准，写明所属任务和阶段；派单方是任务维护者
    const a = await workOrderWhere(frontend, (e) => e.change === "created" && e.workOrder.projectId === "p-1", "记账本的工单建出");
    const b = await workOrderWhere(frontend, (e) => e.change === "created" && e.workOrder.projectId === "p-2", "家电档案的工单建出");
    for (const [e, project, stageId, acceptance] of [
      [a, "pm-1", "s1", ["工作目录里有 export.md"]],
      [b, "pm-2", "s2", ["工作目录里有 import.md"]],
    ] as const) {
      expect(e).toMatchObject({ from: null, workOrder: { state: "planned", kind: "change", source: "task_maintainer", maintainerId: project, taskId, stageId, acceptance, planned: true } });
    }
    // 任务涉及几个项目建卡时就定了
    expect(td.daemon.tasks.get(taskId)?.projectScope).toBe("multi");
    // 第一阶段开始：记账本的那张派出、进了它的维护者的队列；家电档案的还没派出（前置阶段没验收）
    const dispatched = await workOrderWhere(frontend, (e) => e.change === "dispatched" && e.workOrder.id === a.workOrder.id, "记账本的工单派出");
    expect(dispatched.workOrder).toMatchObject({ state: "pending", stageId: "s1" });
    expect(dispatched.workOrder).toHaveProperty("dispatchedAt");
    expect(td.daemon.workOrders.get(b.workOrder.id)?.state).toBe("planned");
    expect(workOrdersOf(frontend).filter((e) => e.workOrder.id === b.workOrder.id).map((e) => e.change)).toEqual(["created"]);
    // 等阶段开始的工单也挡项目归档
    expect(await frontend.request(METHODS.projectAction, { projectId: "p-2", action: "archive" }, "k-archive-p2")).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    // 任务时间线上：两张建出、一张派出
    const records = await eventually(
      () => [recordsOf(frontend, TM1).filter((r) => r.record.kind === "work_order")],
      (list) => list.length >= 3,
      "任务时间线上的工单记录",
    );
    expect(records.map((r) => r.record.summary)).toEqual([
      `建出工单 ${a.workOrder.id} → 项目「记账本」（阶段 s1，阶段开始时派出）`,
      `建出工单 ${b.workOrder.id} → 项目「家电档案」（阶段 s2，阶段开始时派出）`,
      `派出工单 ${a.workOrder.id} → 项目「记账本」`,
    ]);
    expect(records.map((r) => r.record.workOrderId)).toEqual([a.workOrder.id, b.workOrder.id, a.workOrder.id]);
    expect(records.every((r) => r.taskId === taskId)).toBe(true);

    // 执行时：还是固定的三样，加上回答项目维护者、转问用户和推进任务的运行时控制；没有文件读写、bash，也没有增减 skill（27 号票的工具包四样都不开）
    const executing = await eventually(() => messagesOf(frontend, TM1), (m) => m.message.speaker === "agent" && textOf(m).includes("[tool] answer_work_order"), "执行时的工具");
    // 接着原会话换了一套工具：按先后加上 [tool]、去掉 [tool-removed]
    const execTools = new Set<string>();
    for (const line of textOf(executing).split("\n")) {
      if (line.startsWith("[tool] ")) execTools.add(line.slice("[tool] ".length));
      if (line.startsWith("[tool-removed] ")) execTools.delete(line.slice("[tool-removed] ".length));
    }
    expect([...execTools]).toEqual(expect.arrayContaining(["read_project_records", "dispatch_work_order", "summarize_receipts", "answer_work_order", "forward_to_user", "complete_stage", "revise_plan"]));
    for (const forbidden of ["write", "edit", "bash", "adjust_skills", "submit_plan", "ask_clarification"]) expect([...execTools]).not.toContain(forbidden);
  }, 120_000);
});

const completeStage = (stageId: string) => call("complete_stage", { stageId, summary: `阶段 ${stageId} 的回执到齐了` });
const receipt = (outcome: "done" | "returned", text: string, reason?: string) => call("submit_receipt", { outcome, summary: text, ...(reason ? { reason } : {}) });
/** 任务维护者会话里交给它的通知（回执、提问……） */
const noticesTo = (frontend: TestFrontend, channel: string, text: string) => messagesOf(frontend, channel).filter((m) => m.agentInput === true && textOf(m).includes(text));
/** 某个工具调用的结果摘要（按先后） */
const resultsOf = (frontend: TestFrontend, channel: string, tool: string) => toolCallsOf(frontend, channel).filter((p) => p.tool === tool && p.outcome !== "running");

/** 评审子 agent：读一眼项目那边的交付件，交出结论 */
const review = (file: string): FauxStep[] => [call("read", { path: file }), call("submit_review", { results: [{ index: 1, passed: true, reason: "看过了，改动在" }] }), say("评审完了")];

/** 某个 agent 会话目录里全部会话文件的内容 */
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

describe("涉及多个项目的任务：派单、回执和阶段验收", () => {
  it("所属阶段开始时派出工单；项目维护者完成或退回时交回执（退回附理由），回执进任务维护者的会话；回执没到齐不能宣布阶段完成；一张退回本阶段不通过，任务维护者调整做法重新派单（算一次验收退回），两张都完成、阶段验收通过；评审拿到本阶段的回执，能读项目的工作目录；工单的建出、派出、回执都在任务时间线上（录给前端回放）；返工重开 s2 时只向家电档案重新派工单", async () => {
    const d = dirs();
    const recordsA = d.records("p-1");
    const recordsB = d.records("p-2");
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      // 评审读项目那边的交付件（只读访问涉及的项目的工作目录）
      reviewer: (reviewId) => review(reviewId.includes("-s1-") ? path.join(recordsA, "workdir", "export.md") : path.join(recordsB, "workdir", "import.md")),
      maintainer: (id, spawn) => {
        if (id === "tm-1") {
          if (spawn === 1) return [submitPlanStep(twoProjectPlan()), say("计划交了")];
          return [
            // 开始执行：回执还没到齐就宣布完成，被拒
            completeStage("s1"),
            say("等记账本的回执"),
            // 记账本的回执（完成）：宣布 s1 完成，验收通过，s2 开始
            completeStage("s1"),
            say("s1 过了，等家电档案"),
            // 家电档案的回执（退回）：本阶段不通过，宣布完成被拒；汇总回执、调整做法重新派单
            completeStage("s2"),
            call("summarize_receipts", { stageId: "s2" }),
            call("dispatch_work_order", { project: "家电档案", stageId: "s2", instructions: "调整：只加一份导入说明 import.md，不动现有的表" }),
            say("重新派了"),
            // 重新派的那张完成：宣布 s2 完成，任务完成
            completeStage("s2"),
            say("全部完成"),
            // 返工：重开 s2，等家电档案重新做完
            say("等家电档案返工的回执"),
            completeStage("s2"),
            say("返工完成"),
          ];
        }
        if (id === "pm-1")
          return [
            // 先停在这里：等任务维护者回执没到齐就宣布完成被拒之后，用户在项目会话里催一句再接着做（不靠快慢）
            say("收到工单，先看看"),
            call("write", { path: "export.md", content: "# 导出说明\n" }),
            progressEdit(recordsA, PROGRESS_INTRO, "导出说明 export.md 加好了。"),
            summary("给任务 t-1 加了导出说明"),
            receipt("done", "加好了 export.md"),
            say("交回执了"),
          ];
        if (id === "pm-2") {
          if (spawn === 1)
            return [
              progressEdit(recordsB, PROGRESS_INTRO, "退回了导入的工单：会改动现有的表。"),
              summary("退回了任务 t-1 的导入工单"),
              receipt("returned", "没有改", "会改动家电档案现有的表结构，伤害本项目"),
              say("退回了"),
            ];
          const before = spawn === 2 ? "退回了导入的工单：会改动现有的表。" : "导入说明 import.md 加好了。";
          return [
            // 返工时改已有的文件用局部编辑（整体重写已有文件算覆盖，工作目录没提交过会被守卫按规则退回）
            spawn === 2 ? call("write", { path: "import.md", content: "# 导入说明\n" }) : call("edit", { path: "import.md", edits: [{ oldText: "# 导入说明", newText: "# 导入说明（返工）" }] }),
            progressEdit(recordsB, before, spawn === 2 ? "导入说明 import.md 加好了。" : "导入说明 import.md 返工过了。"),
            summary(spawn === 2 ? "加了导入说明，不动现有的表" : "返工了导入说明"),
            receipt("done", spawn === 2 ? "加好了 import.md，不动现有的表" : "import.md 返工好了"),
            say("交回执了"),
          ];
        }
        return [];
      },
    });
    inUseProject(td, "记账本");
    inUseProject(td, "家电档案");
    const frontend = await connect(td.url);
    const taskId = await startTwoProjectTask(td, frontend);
    const card = await planCardOf(frontend, taskId);
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));
    const [woA, woB] = await eventually(
      () => [workOrdersOf(frontend).filter((e) => e.change === "created").map((e) => e.workOrder)],
      (list) => list.length >= 2,
      "两张工单建出",
    );

    // 回执没到齐：宣布 s1 完成被拒
    await waitUntil(() => resultsOf(frontend, TM1, "complete_stage").length >= 1, { timeoutMs: 30_000, describe: () => "等第一次宣布完成" });
    expect(resultsOf(frontend, TM1, "complete_stage")[0]).toMatchObject({ outcome: "error" });
    expect(resultsOf(frontend, TM1, "complete_stage")[0]!.resultSummary).toContain("阶段 s1 还在等回执");
    await eventually(() => messagesOf(frontend, PM1), (m) => m.message.speaker === "agent" && textOf(m).includes("收到工单，先看看"), "记账本的维护者先停下");
    await frontend.sendParts([{ type: "text", text: "接着做吧" }], { conversation: PM1, idempotencyKey: "k-pm1-go" });

    // 记账本的回执（完成）进任务维护者的会话
    const receiptA = await eventually(() => noticesTo(frontend, TM1, `工单 ${woA!.id}「`), () => true, "记账本的回执");
    expect(textOf(receiptA)).toContain("项目「记账本」完成");
    expect(textOf(receiptA)).toContain("加好了 export.md");
    expect(textOf(receiptA)).toContain("阶段 s1 的回执全部到齐、都完成了");
    expect(receiptA).toMatchObject({ taskId, stageId: "s1" });
    expect(fs.readFileSync(path.join(recordsA, "workdir", "export.md"), "utf8")).toBe("# 导出说明\n");

    // s1 验收通过、s2 开始：家电档案的那张派出；它的维护者退回（附理由）
    const accepted1 = await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "stage_accepted" && e.stageId === "s1", "s1 验收通过");
    expect(accepted1.task.stages?.list?.find((s) => s.stageId === "s1")?.attempts).toBe(1);
    // 评审拿到了本阶段的工单和回执，读到了记账本工作目录里的交付件
    const reviewed = sessionText(td, `review-${taskId}-s1-1`);
    expect(reviewed).toContain("本阶段发往各项目的工单");
    expect(reviewed).toContain("回执：加好了 export.md");
    expect(reviewed).toContain("验收标准：工作目录里有 export.md");
    expect(reviewed).toContain("# 导出说明");
    // 家电档案的那张在 s1 验收通过之后才派出（前置阶段没验收时不派）
    const dispatchedB = await workOrderWhere(frontend, (e) => e.change === "dispatched" && e.workOrder.id === woB!.id, "家电档案的工单派出");
    expect((dispatchedB.workOrder as { dispatchedAt?: string }).dispatchedAt! >= accepted1.task.updatedAt).toBe(true);
    const returnedB = await workOrderWhere(frontend, (e) => e.change === "ended" && e.workOrder.id === woB!.id, "家电档案退回");
    expect(returnedB.workOrder).toMatchObject({ outcome: "returned", reason: "会改动家电档案现有的表结构，伤害本项目", receipt: "没有改" });
    const receiptB = await eventually(() => noticesTo(frontend, TM1, `工单 ${woB!.id}「`), () => true, "家电档案的回执");
    expect(textOf(receiptB)).toContain("项目「家电档案」退回");
    expect(textOf(receiptB)).toContain("理由：会改动家电档案现有的表结构，伤害本项目");
    expect(textOf(receiptB)).toContain("阶段 s2 不通过");

    // 本阶段不通过：宣布完成被拒；调整做法重新派单，算一次验收退回
    const woC = (await workOrderWhere(frontend, (e) => e.change === "dispatched" && e.workOrder.projectId === "p-2" && e.workOrder.id !== woB!.id, "重新派的工单")).workOrder;
    expect(woC).toMatchObject({ state: "pending", stageId: "s2", planned: true, acceptance: ["工作目录里有 import.md"], instructions: "调整：只加一份导入说明 import.md，不动现有的表" });
    expect(resultsOf(frontend, TM1, "complete_stage")[2]).toMatchObject({ outcome: "error" });
    expect(resultsOf(frontend, TM1, "complete_stage")[2]!.resultSummary).toContain("阶段 s2 不通过");
    expect(resultsOf(frontend, TM1, "summarize_receipts")[0]!.resultSummary).toContain(`${woB!.id} → 项目「家电档案」`);
    const adjusted = await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "stage_returned" && e.stageId === "s2", "调整做法算一次退回");
    expect(adjusted).toMatchObject({ by: "maintainer", task: { state: "running" } });
    expect(adjusted.task.stages?.list?.find((s) => s.stageId === "s2")).toMatchObject({ state: "running", attempts: 0, returns: 1 });

    // 两张都完成：s2 验收通过（宣布了第 2 次），任务完成
    const done = await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "completed", "任务完成", 60_000);
    expect(done.task.stages?.list?.find((s) => s.stageId === "s2")).toMatchObject({ state: "accepted", attempts: 1, returns: 1 });
    expect(fs.readFileSync(path.join(recordsB, "workdir", "import.md"), "utf8")).toBe("# 导入说明\n");
    // 工单的往来都在任务时间线上
    const summaries = recordsOf(frontend, TM1)
      .filter((r) => r.record.kind === "work_order")
      .map((r) => r.record.summary);
    expect(summaries).toEqual([
      `建出工单 ${woA!.id} → 项目「记账本」（阶段 s1，阶段开始时派出）`,
      `建出工单 ${woB!.id} → 项目「家电档案」（阶段 s2，阶段开始时派出）`,
      `派出工单 ${woA!.id} → 项目「记账本」`,
      `工单 ${woA!.id} 回执：项目「记账本」完成`,
      `派出工单 ${woB!.id} → 项目「家电档案」`,
      `工单 ${woB!.id} 回执：项目「家电档案」退回：会改动家电档案现有的表结构，伤害本项目`,
      `派出工单 ${woC.id} → 项目「家电档案」`,
      `工单 ${woC.id} 回执：项目「家电档案」完成`,
    ]);
    // 项目维护者会话里每张工单一条分隔线，来源是任务维护者
    const dividers = messagesOf(frontend, PM2).flatMap((m) => m.message.parts.filter((p) => p.type === "work_order_divider"));
    expect(dividers).toEqual([
      { type: "work_order_divider", workOrderId: woB!.id, title: "按记账本的导出说明加导入说明 import.md", from: "任务维护者" },
      { type: "work_order_divider", workOrderId: woC.id, title: "调整：只加一份导入说明 import.md，不动现有的表", from: "任务维护者" },
    ]);
    // 录之前等这一轮的尾巴（不靠快慢）：任务维护者说完、这一轮结束；每次模型调用都记了账——评审交出结论之后还说一句，
    // 任务维护者 12 次、记账本 6 次和范围审视 1 次、家电档案 9 次和范围审视 2 次、两次评审各 3 次
    await agentSaid(frontend, TM1, "全部完成");
    await waitUntil(() => frontend.events({ channel: TM1, type: EVENT_TYPES.turnEnd }).length === frontend.events({ channel: TM1, type: EVENT_TYPES.turnStart }).length, {
      timeoutMs: 30_000,
      describe: () => "等任务维护者这一轮结束",
    });
    await waitUntil(() => (frontend.events({ channel: BOARD, type: EVENT_TYPES.tokenTotals }).at(-1)?.payload as { calls?: number } | undefined)?.calls === 36, {
      timeoutMs: 30_000,
      describe: () => "等每次模型调用都记了账",
    });
    saveOrCheckRecording("multi-project", frontend.recording, { perChannel: true });

    // 返工：重开 s2，只向家电档案重新派工单（记账本那个阶段没受影响，不重派）
    ok(await frontend.taskAction({ taskId, action: "rework", stageId: "s2", note: "导入说明要补一句" }, "k-rework"));
    const woD = (await workOrderWhere(frontend, (e) => e.change === "dispatched" && e.workOrder.id !== woA!.id && e.workOrder.id !== woB!.id && e.workOrder.id !== woC.id, "返工派出的工单")).workOrder;
    expect(woD).toMatchObject({ projectId: "p-2", stageId: "s2", planned: true });
    await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "completed" && tasksOf(frontend).filter((x) => x.change === "completed").length >= 2, "返工后再完成", 60_000);
    expect(workOrdersOf(frontend).filter((e) => e.change === "created" && e.workOrder.projectId === "p-1").map((e) => e.workOrder.id)).toEqual([woA!.id]);
    expect(fs.readFileSync(path.join(recordsB, "workdir", "import.md"), "utf8")).toBe("# 导入说明（返工）\n");
  }, 240_000);
});

const question = (text: string, recommended: string, other: string) => ({ question: text, options: [recommended, other], recommended });
const inboxOf = (frontend: TestFrontend): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);

describe("涉及多个项目的任务：工单的等澄清", () => {
  it("项目维护者提问：工单转等澄清，问题作为一条消息进任务维护者的会话（不出给用户）；任务维护者直接回答，回答交回项目维护者、工单回到进行中；答不了转问用户：提问卡进待我处理，用户回答后经任务维护者交回项目维护者；用户的回答是“澄清问题的回答”素材", async () => {
    const d = dirs();
    const recordsA = d.records("p-1");
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id === "tm-1") {
          if (spawn === 1) return [submitPlanStep(twoProjectPlan()), say("计划交了")];
          return [
            say("等记账本"),
            // 第一个问题：答得了，直接答
            call("answer_work_order", { workOrderId: "wo-1", answer: "导出用 CSV" }),
            say("答了"),
            // 第二个问题：答不了，转问用户
            call("forward_to_user", { workOrderId: "wo-1", questions: [question("导出要不要带备注列？", "要", "不要")] }),
            say("转问用户了"),
            // 用户回答了：交回项目维护者
            call("answer_work_order", { workOrderId: "wo-1", answer: "用户说要带备注列" }),
            say("交回了"),
            say("收到回执"),
          ];
        }
        if (id === "pm-1")
          return [
            call("ask_clarification", { intro: "导出的格式", questions: [question("导出用 CSV 还是 JSON？", "CSV", "JSON")] }),
            say("等回答"),
            call("ask_clarification", { questions: [question("导出要不要带备注列？", "要", "不要")] }),
            say("再等回答"),
            call("write", { path: "export.md", content: "# 导出说明\nCSV，带备注列\n" }),
            progressEdit(recordsA, PROGRESS_INTRO, "导出说明 export.md 加好了：CSV，带备注列。"),
            summary("加了导出说明"),
            receipt("done", "加好了 export.md（CSV，带备注列）"),
            say("交回执了"),
          ];
        return [];
      },
    });
    inUseProject(td, "记账本");
    inUseProject(td, "家电档案");
    const frontend = await connect(td.url, [CHANNELS.secretary, BOARD, CARDS, INBOX, PROJECTS, TM1, PM1, PM2]);
    const taskId = await startTwoProjectTask(td, frontend);
    const card = await planCardOf(frontend, taskId);
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));

    // 项目维护者提问：工单转等澄清，问题进任务维护者的会话，没有提问卡
    const clarifying = await firstOf(() => workOrdersOf(frontend), (e) => e.change === "clarifying", "工单转等澄清");
    expect(clarifying).toMatchObject({ from: "in_progress", by: "maintainer", workOrder: { id: "wo-1", state: "clarifying", question: "导出的格式\n1. 导出用 CSV 还是 JSON？（推荐：CSV；选项：CSV、JSON）" } });
    const asked = await firstOf(() => noticesTo(frontend, TM1, "在工单 wo-1"), () => true, "问题交给任务维护者");
    expect(textOf(asked)).toContain("项目「记账本」的维护者在工单 wo-1「加一个导出说明 export.md」里提问");
    expect(textOf(asked)).toContain("导出用 CSV 还是 JSON？");
    expect(asked).toMatchObject({ taskId, stageId: "s1" });
    // 任务维护者直接回答：交回项目维护者，工单回到进行中
    const answered = await firstOf(() => workOrdersOf(frontend), (e) => e.change === "answered", "工单回到进行中");
    expect(answered).toMatchObject({ from: "clarifying", by: "maintainer", workOrder: { state: "in_progress" } });
    expect(answered.workOrder).not.toHaveProperty("question");
    const reply = await eventually(() => noticesTo(frontend, PM1, "导出用 CSV"), () => true, "回答交回项目维护者");
    expect(reply).toMatchObject({ projectId: "p-1", taskId });
    expect(textOf(reply)).toContain("任务 t-1 的维护者回答了你在工单 wo-1 里的提问");

    // 第二个问题任务维护者答不了：转问用户，提问卡进待我处理（问的人是任务维护者），这一支停下
    const forwarded = await cardWhere(frontend, (c) => c.type === "questions", "转问用户的提问卡");
    expect(forwarded.payload).toMatchObject({ taskId, askedBy: { maintainerId: "tm-1", projectId: "p-1", workOrderId: "wo-1" } });
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === forwarded.id, "待我处理里的提问卡");
    expect(item).toMatchObject({ urgency: "blocking", source: `任务「记账本导出接家电档案」` });
    const waiting = await taskWhere(frontend, (e) => e.task.id === taskId && e.task.state === "waiting_for_user", "任务转等我");
    expect(waiting.task.stages?.list?.find((s) => s.stageId === "s1")).toMatchObject({ state: "waiting", waitReason: "clarification", waitingOn: forwarded.id });
    // 前面那个问题没有出给用户：只有这一张提问卡
    expect(cardsOf(frontend).filter((c) => c.type === "questions").map((c) => c.id).filter((id, i, all) => all.indexOf(id) === i)).toEqual([forwarded.id]);

    // 用户回答：回答交给任务维护者（不交给项目维护者、秘书），工单还在等澄清；任务维护者交回后回到进行中
    ok(await frontend.cardAction({ cardId: forwarded.id, action: "answer", expectedVersion: 1, input: { answers: [{ questionId: "q1", answer: "要" }] } }));
    const toTask = await eventually(() => noticesTo(frontend, TM1, "用户回答了你为工单 wo-1"), () => true, "用户的回答交给任务维护者");
    expect(textOf(toTask)).toContain("导出要不要带备注列？ → 要");
    await taskWhere(frontend, (e) => e.task.id === taskId && e.task.state === "running" && e.from === "waiting_for_user", "任务回到执行中");
    await eventually(() => noticesTo(frontend, PM1, "用户说要带备注列"), () => true, "任务维护者交回项目维护者");
    expect(noticesTo(frontend, PM1, "导出要不要带备注列？ → 要")).toEqual([]);
    expect(td.daemon.store.read(CHANNELS.secretary).some((e) => JSON.stringify(e.payload).includes("导出要不要带备注列"))).toBe(false);
    // 回执照常进任务维护者的会话
    await eventually(() => noticesTo(frontend, TM1, "工单 wo-1「加一个导出说明 export.md」的回执"), () => true, "回执");
    expect(fs.readFileSync(path.join(recordsA, "workdir", "export.md"), "utf8")).toContain("带备注列");

    // 用户的回答是"澄清问题的回答"素材：属于这个任务和项目
    await waitUntil(() => td.daemon.materials.list().some((m) => m.kind === "clarification_answer"));
    expect(td.daemon.materials.list().filter((m) => m.kind === "clarification_answer")).toEqual([expect.objectContaining({ task: taskId, project: "p-1" })]);
  }, 180_000);
});

describe("涉及多个项目的任务：计划外的工单", () => {
  it("执行中派出计划外的工单命中“计划外工单”类别：工单待你确认、不进项目维护者的队列，待我处理出现工单卡；确认后才派出、照常做完交回执；拒绝则不派，告诉任务维护者；确认、拒绝都是“审批决定”素材；任务取消时还没派出的工单退回", async () => {
    const d = dirs();
    const recordsB = d.records("p-2");
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id === "tm-1") {
          if (spawn === 1) return [submitPlanStep(twoProjectPlan()), say("计划交了")];
          return [
            // s1 里给家电档案、相册库各派一张：计划里 s1 没有这两个项目的一行，都是计划外的
            call("dispatch_work_order", { project: "家电档案", stageId: "s1", instructions: "顺手把家电档案的分类对一下", acceptance: ["分类和记账本一致"] }),
            call("dispatch_work_order", { project: "相册库", instructions: "把相册库的标签也对一下", acceptance: ["标签和记账本一致"] }),
            say("等你确认"),
            ...Array.from({ length: 8 }, () => say("收到")),
          ];
        }
        // 记账本的那张一直问不完（项目正忙，s1 不会结束）
        if (id === "pm-1") return [call("ask_clarification", { questions: [question("导出用什么格式？", "CSV", "JSON")] }), say("等回答")];
        if (id === "pm-2")
          return [
            call("write", { path: "categories.md", content: "# 分类\n" }),
            progressEdit(recordsB, PROGRESS_INTRO, "分类对齐了。"),
            summary("对齐了分类"),
            receipt("done", "分类对齐了"),
            say("交回执了"),
          ];
        return [];
      },
    });
    inUseProject(td, "记账本");
    inUseProject(td, "家电档案");
    inUseProject(td, "相册库");
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, TM1, PM1, PM2, maintainerChannel("pm-3")]);
    const taskId = await startTwoProjectTask(td, frontend);
    const plan = await planCardOf(frontend, taskId);
    ok(await frontend.cardAction({ cardId: plan.id, action: "confirm", expectedVersion: 1, input: {} }));

    // 两张计划外的工单：待你确认，各有一张工单卡（卡住任务），不进项目维护者的队列
    const cardsWo = await eventually(() => [cardsOf(frontend).filter((c) => c.type === "work_order")], (list) => list.length >= 2, "两张工单卡");
    const [toB, toC] = cardsWo;
    expect(toB!.payload).toMatchObject({ taskId, projectId: "p-2", projectName: "家电档案", stageId: "s1", acceptance: ["分类和记账本一致"], categories: ["计划外工单"] });
    expect(toC!.payload).toMatchObject({ projectName: "相册库", stageId: "s1" });
    const woB = (toB!.payload as WorkOrderCardPayload).workOrderId;
    const woC = (toC!.payload as WorkOrderCardPayload).workOrderId;
    for (const id of [woB, woC]) {
      expect(td.daemon.workOrders.get(id)).toMatchObject({ state: "awaiting_confirm", planned: false, source: "task_maintainer" });
      expect(workOrdersOf(frontend).filter((e) => e.workOrder.id === id).map((e) => e.change)).toEqual(["created"]);
    }
    const dispatchResult = resultsOf(frontend, TM1, "dispatch_work_order")[0]!;
    expect(dispatchResult.resultSummary).toContain("是计划外的");
    expect(dispatchResult.resultSummary).toContain("命中「计划外工单」");
    for (const c of [toB!, toC!]) {
      expect(await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === c.id, "待我处理里的工单卡")).toMatchObject({ urgency: "blocking" });
    }
    // 这一支在等你确认
    const waitingStage = await taskWhere(frontend, (e) => e.task.id === taskId && e.task.stages?.list?.[0]?.state === "waiting", "s1 等你确认");
    expect(waitingStage.task.stages?.list?.[0]).toMatchObject({ waitReason: "approval", waitingOn: toB!.id });

    // 确认派出：进家电档案维护者的队列，做完交回执
    ok(await frontend.cardAction({ cardId: toB!.id, action: "dispatch", expectedVersion: 1 }));
    await workOrderWhere(frontend, (e) => e.change === "dispatched" && e.workOrder.id === woB, "确认后派出");
    const doneB = await workOrderWhere(frontend, (e) => e.change === "ended" && e.workOrder.id === woB, "家电档案做完");
    expect(doneB.workOrder).toMatchObject({ outcome: "done", receipt: "分类对齐了" });
    expect(fs.existsSync(path.join(recordsB, "workdir", "categories.md"))).toBe(true);
    await eventually(() => noticesTo(frontend, TM1, `用户确认派出了计划外的工单 ${woB}`), () => true, "确认告诉任务维护者");

    // 拒绝：不派，告诉任务维护者
    ok(await frontend.cardAction({ cardId: toC!.id, action: "deny", expectedVersion: 1, note: "相册库这次别动" }));
    const declined = await workOrderWhere(frontend, (e) => e.change === "ended" && e.workOrder.id === woC, "相册库的工单没派出");
    expect(declined).toMatchObject({ from: "awaiting_confirm", workOrder: { outcome: "declined", reason: "用户拒绝了：相册库这次别动" } });
    expect(declined.workOrder).not.toHaveProperty("dispatchedAt");
    expect(workOrdersOf(frontend).filter((e) => e.workOrder.id === woC).map((e) => e.change)).toEqual(["created", "ended"]);
    const told = await eventually(() => noticesTo(frontend, TM1, `用户拒绝了计划外的工单 ${woC}`), () => true, "拒绝告诉任务维护者");
    expect(textOf(told)).toContain("相册库这次别动");
    expect(frontend.events({ channel: maintainerChannel("pm-3"), type: EVENT_TYPES.turnStart })).toEqual([]);

    // 确认、拒绝都是"审批决定"素材
    await waitUntil(() => td.daemon.materials.list().filter((m) => m.kind === "approval_decision" && m.context.includes("card:work_order")).length >= 2);
    const decisions = td.daemon.materials.list().filter((m) => m.kind === "approval_decision" && m.context.includes("card:work_order"));
    expect(decisions.map((m) => [m.task, m.project, m.context.find((c) => c.startsWith("decision:"))]).toSorted()).toEqual([
      [taskId, "p-2", "decision:dispatch"],
      [taskId, "p-3", "decision:deny"],
    ]);
    const records = recordsOf(frontend, TM1).map((r) => r.record.summary);
    expect(records).toEqual(expect.arrayContaining([`计划外工单 ${woB} → 项目「家电档案」待你确认`, `你确认派出计划外工单 ${woB} → 项目「家电档案」`, `你拒绝了计划外工单 ${woC} → 项目「相册库」，没有派出`]));

    // 取消任务：还没派出的（s2 家电档案那一行）退回，进行中的那张（记账本，在等澄清）这一段收尾后退回
    ok(await frontend.taskAction({ taskId, action: "cancel" }, "k-cancel"));
    const planned = workOrdersOf(frontend).find((e) => e.change === "created" && e.workOrder.source === "task_maintainer" && e.workOrder.stageId === "s2")!.workOrder;
    const endedPlanned = await workOrderWhere(frontend, (e) => e.change === "ended" && e.workOrder.id === planned.id, "没派出的工单退回");
    expect(endedPlanned.workOrder).toMatchObject({ outcome: "returned", reason: "任务已经结束了" });
    expect(endedPlanned.workOrder).not.toHaveProperty("dispatchedAt");
    await workOrderWhere(frontend, (e) => e.change === "ended" && e.workOrder.id === "wo-1", "记账本那张退回");
    expect(td.daemon.workOrders.get("wo-1")).toMatchObject({ outcome: "returned", reason: "任务取消了" });
    // 没派出的那张没到项目那里：时间线上记"没有派出就结束了"，不算回执
    await waitUntil(() => recordsOf(frontend, TM1).some((r) => r.record.summary === `工单 ${planned.id} → 项目「家电档案」没有派出就结束了：任务已经结束了`), {
      timeoutMs: 10_000,
      describe: () => "没派出的工单记在时间线上",
    });
    expect(noticesTo(frontend, TM1, `工单 ${planned.id}「`)).toEqual([]);
  }, 180_000);
});

/** 两个项目的计划再加上相册库的一行（line 里写所属阶段、验收标准） */
function withAlbum(line: Partial<Plan["projects"][number]>): Plan {
  const plan = twoProjectPlan();
  return { ...plan, projects: [...plan.projects, { project: "相册库", changes: ["相册库加一个导出说明 album-export.md"], ...line }] };
}

/** 交给 propose_plan_change 的计划（本任务的关注类别、用户的限制、定时作业、记忆范围沿用当前计划，不写） */
function draftOf(plan: Plan) {
  const { watchCategories: _w, userLimits: _u, scheduledJobs: _s, memoryScope: _m, ...rest } = plan;
  return rest;
}

describe("涉及多个项目的任务：计划变更里加项目", () => {
  it("执行中提交计划变更加项目：新项目的那一行也要写所属阶段和验收标准；用户确认后照样建出它的工单，所属阶段在做就马上派出；原有的行不重复建单", async () => {
    const d = dirs();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id === "tm-1") {
          if (spawn === 1) return [submitPlanStep(twoProjectPlan()), say("计划交了")];
          return [
            // 新项目的那一行没写所属阶段、验收标准：没通过检查
            call("propose_plan_change", { plan: draftOf(withAlbum({})), why: "相册库也要能导出" }),
            call("propose_plan_change", { plan: draftOf(withAlbum({ stageId: "s1", acceptance: ["工作目录里有 album-export.md"] })), why: "相册库也要能导出" }),
            say("等你确认"),
            ...Array.from({ length: 6 }, () => say("收到")),
          ];
        }
        if (id === "pm-1" || id === "pm-3") return [say("收到工单，先看看")];
        return [];
      },
    });
    inUseProject(td, "记账本");
    inUseProject(td, "家电档案");
    inUseProject(td, "相册库");
    const frontend = await connect(td.url);
    const taskId = await startTwoProjectTask(td, frontend);
    const plan = await planCardOf(frontend, taskId);
    ok(await frontend.cardAction({ cardId: plan.id, action: "confirm", expectedVersion: 1, input: {} }));

    const change = await cardWhere(frontend, (c) => c.type === "plan_change", "计划变更卡");
    const proposals = resultsOf(frontend, TM1, "propose_plan_change");
    expect(proposals[0]).toMatchObject({ outcome: "error" });
    expect(proposals[0]!.resultSummary).toContain("要写所属阶段 stageId");
    expect(proposals[0]!.resultSummary).toContain("要写这张工单自己的验收标准 acceptance");
    // 确认之前没有相册库的工单
    expect(workOrdersOf(frontend).filter((e) => e.workOrder.projectId === "p-3")).toEqual([]);

    ok(await frontend.cardAction({ cardId: change.id, action: "confirm", expectedVersion: change.version, input: {} }));
    const created = await workOrderWhere(frontend, (e) => e.change === "created" && e.workOrder.projectId === "p-3", "相册库的工单建出");
    expect(created.workOrder).toMatchObject({ state: "planned", kind: "change", source: "task_maintainer", stageId: "s1", planned: true, acceptance: ["工作目录里有 album-export.md"] });
    // s1 在做：马上派出，相册库的维护者开始做
    await workOrderWhere(frontend, (e) => e.change === "dispatched" && e.workOrder.id === created.workOrder.id, "相册库的工单派出");
    await workOrderWhere(frontend, (e) => e.change === "started" && e.workOrder.id === created.workOrder.id, "相册库的维护者开始做");
    // 原有的两行不重复建单
    const createdByProject = workOrdersOf(frontend)
      .filter((e) => e.change === "created")
      .map((e) => e.workOrder.projectId);
    expect(createdByProject.toSorted()).toEqual(["p-1", "p-2", "p-3"]);
    const summaries = recordsOf(frontend, TM1)
      .filter((r) => r.record.kind === "work_order")
      .map((r) => r.record.summary);
    expect(summaries).toEqual(expect.arrayContaining([`建出工单 ${created.workOrder.id} → 项目「相册库」（阶段 s1，阶段开始时派出）`, `派出工单 ${created.workOrder.id} → 项目「相册库」`]));
  }, 180_000);
});

/** s1 两个项目一起改（由我验收），s2 记账本收尾（评审） */
function sameStagePlan(): Plan {
  return {
    ...twoProjectPlan(),
    stages: [stage("s1", "两边一起改", [], "user"), stage("s2", "记账本收尾", ["s1"])],
    projects: [
      { project: "记账本", changes: ["加一个导出说明 export.md"], stageId: "s1", acceptance: ["工作目录里有 export.md"] },
      { project: "家电档案", changes: ["加一份导入说明 import.md"], stageId: "s1", acceptance: ["工作目录里有 import.md"] },
      { project: "记账本", changes: ["导出说明里写上版本号"], stageId: "s2", acceptance: ["export.md 里有版本号"] },
    ],
  };
}

/** 去掉家电档案那一行：计划里只剩记账本 */
function withoutHomeAppliances(): Plan {
  const plan = sameStagePlan();
  return { ...plan, projects: plan.projects.filter((p) => p.project !== "家电档案") };
}

describe("涉及多个项目的任务：改计划去掉退回的那一行", () => {
  it("家电档案退回、本阶段不通过：任务维护者自行调整计划去掉那一行（算一次验收退回，时间线上记一笔），它不再挡本阶段，宣布完成后由我验收，待我处理里看得到回执；计划里只剩记账本也还是多项目任务：后面阶段的工单照样派出、回执到齐才能完成", async () => {
    const d = dirs();
    const recordsA = d.records("p-1");
    const recordsB = d.records("p-2");
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      reviewer: () => review(path.join(recordsA, "workdir", "export.md")),
      maintainer: (id, spawn) => {
        if (id === "tm-1") {
          if (spawn === 1) return [submitPlanStep(sameStagePlan()), say("计划交了")];
          return [
            say("等回执"),
            say("收到一张回执"),
            // 两张回执都到了：家电档案退回。改计划去掉那一行，再宣布 s1 完成
            call("revise_plan", { plan: draftOf(withoutHomeAppliances()), why: "家电档案这次不动，导入以后再说" }),
            completeStage("s1"),
            say("改了计划，s1 交给你验收"),
            // s2：记账本的回执到齐之前宣布完成被拒，到齐之后再宣布
            ...Array.from({ length: 5 }, () => [completeStage("s2"), say("等记账本的回执")]).flat(),
            ...Array.from({ length: 4 }, () => say("收到")),
          ];
        }
        if (id === "pm-1") {
          if (spawn === 1)
            return [
              call("write", { path: "export.md", content: "# 导出说明\n" }),
              progressEdit(recordsA, PROGRESS_INTRO, "导出说明 export.md 加好了。"),
              summary("给任务 t-1 加了导出说明"),
              receipt("done", "加好了 export.md"),
              say("交回执了"),
            ];
          return [
            call("edit", { path: "export.md", edits: [{ oldText: "# 导出说明", newText: "# 导出说明 v1" }] }),
            progressEdit(recordsA, "导出说明 export.md 加好了。", "导出说明写上了版本号。"),
            summary("导出说明写上了版本号"),
            receipt("done", "写上了版本号 v1"),
            say("交回执了"),
          ];
        }
        if (id === "pm-2")
          return [
            progressEdit(recordsB, PROGRESS_INTRO, "退回了导入的工单：家电档案现在不能加导入。"),
            summary("退回了任务 t-1 的导入工单"),
            receipt("returned", "没有改", "家电档案现在不能加导入"),
            say("退回了"),
          ];
        return [];
      },
    });
    inUseProject(td, "记账本");
    inUseProject(td, "家电档案");
    const frontend = await connect(td.url);
    const taskId = await startTwoProjectTask(td, frontend);
    const card = await planCardOf(frontend, taskId);
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));
    const created = await eventually(
      () => [workOrdersOf(frontend).filter((e) => e.change === "created").map((e) => e.workOrder)],
      (list) => list.length >= 3,
      "三张工单建出",
    );
    const [woA, woB, woA2] = created;
    expect([woA!.projectId, woB!.projectId, woA2!.projectId]).toEqual(["p-1", "p-2", "p-1"]);

    // 家电档案退回之后，任务维护者改计划去掉那一行：算一次验收退回（任务维护者调整的），时间线上记一笔
    await workOrderWhere(frontend, (e) => e.change === "ended" && e.workOrder.id === woB!.id && e.workOrder.outcome === "returned", "家电档案退回");
    const adjusted = await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "stage_returned" && e.stageId === "s1", "改计划算一次退回");
    expect(adjusted).toMatchObject({ by: "maintainer" });
    expect(adjusted.task.stages?.list?.find((s) => s.stageId === "s1")).toMatchObject({ returns: 1 });
    await eventually(
      () => recordsOf(frontend, TM1),
      (r) => r.record.summary === `工单 ${woB!.id} → 项目「家电档案」那一行从计划里去掉了，不再挡阶段 s1`,
      "去掉的那一行记在时间线上",
    );
    expect(await firstOf(() => resultsOf(frontend, TM1, "revise_plan"), () => true, "自行调整计划的结果")).toMatchObject({ outcome: "done" });

    // 不再挡 s1：宣布完成，由我验收；待我处理里看得到本阶段的工单和回执（去掉的那张不在里面）
    const notice = await eventually(() => inboxOf(frontend), (i) => i.kind === "notice" && i.notice === "stage_acceptance", "由我验收的事项");
    const body = (notice as { body: string }).body;
    expect(body).toContain("本阶段发往各项目的工单");
    expect(body).toContain(`${woA!.id} → 项目「记账本」`);
    expect(body).toContain("回执：加好了 export.md");
    expect(body).not.toContain(woB!.id);
    // 计划里只剩记账本，还是多项目任务
    expect(td.daemon.tasks.get(taskId)?.projectScope).toBe("multi");
    expect(td.daemon.workOrders.get(woA2!.id)?.state).toBe("planned");
    ok(await frontend.inboxAction({ itemIds: [notice.id], action: "handle", choice: "验收通过" }));

    // s2 开始：记账本收尾的那张派出，回执到齐之后评审通过、任务完成
    await workOrderWhere(frontend, (e) => e.change === "dispatched" && e.workOrder.id === woA2!.id, "s2 的工单派出");
    const done = await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "completed", "任务完成", 90_000);
    expect(done.task.stages?.list?.find((s) => s.stageId === "s1")).toMatchObject({ state: "accepted", returns: 1 });
    expect(done.task.stages?.list?.find((s) => s.stageId === "s2")).toMatchObject({ state: "accepted", attempts: 1 });
    expect(fs.readFileSync(path.join(recordsA, "workdir", "export.md"), "utf8")).toBe("# 导出说明 v1\n");
    expect(sessionText(td, `review-${taskId}-s2-1`)).toContain("回执：写上了版本号 v1");
  }, 180_000);
});

/** 一个阶段（由我验收），计划里的项目行另给 */
function onePlan(projects: Plan["projects"]): Plan {
  return { ...twoProjectPlan(), stages: [stage("s1", "写周报", [], "user")], projects };
}
const OWN_LINE = { project: "记账本", changes: ["加周报"] };
const OTHER_LINE = { project: "家电档案", changes: ["顺手改一下家电档案"] };

describe("计划里涉及的项目要对得上任务", () => {
  it("单项目任务的计划写不进别的项目：提交、计划变更、自行调整都拒绝（要涉及多个项目得重新发起任务）；不涉及项目的任务的计划不能写项目行；建卡时没写项目的，第一版任务书定下涉及几个项目", async () => {
    const d = dirs();
    const TM2 = maintainerChannel("tm-2");
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的"), say("好的"), say("好的")],
      maintainer: (id, spawn) => {
        if (id === "pm-1") {
          if (spawn === 1)
            return [
              submitPlanStep(onePlan([OWN_LINE, OTHER_LINE])),
              submitPlanStep(onePlan([OWN_LINE])),
              call("write_progress", { content: "周报：计划交上去了，等确认。" }),
              summary("起草了周报计划"),
              say("计划交了"),
            ];
          return [
            call("revise_plan", { plan: draftOf(onePlan([OWN_LINE, OTHER_LINE])), why: "家电档案也顺手改" }),
            call("propose_plan_change", { plan: draftOf(onePlan([OWN_LINE, OTHER_LINE])), why: "家电档案也顺手改" }),
            say("那就不动家电档案"),
          ];
        }
        if (id === "tm-2") return [submitPlanStep(onePlan([OWN_LINE])), say("计划没交上去")];
        return [];
      },
    });
    inUseProject(td, "记账本");
    inUseProject(td, "家电档案");
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1, TM2]);

    // 单项目任务（记账本）：提交时写进家电档案被拒，只写自己的项目就行
    ok(await frontend.startTask("给记账本加周报", "start-单项目", ["记账本"]));
    const single = (await taskWhere(frontend, (e) => e.change === "created" && e.task.title === "给记账本加周报", "单项目任务建出")).task.id;
    td.daemon.tasks.writeBrief(single, { goal: "每周出一份周报", acceptanceCriteria: ["有周报文件"], constraints: [], projects: ["记账本"], memoryScope: "" });
    expect(td.daemon.tasks.get(single)?.projectScope).toBe("single");
    const card = await planCardOf(frontend, single);
    const notOther = "这个任务只涉及它自己那个项目，计划里不能写进别的项目「家电档案」。要涉及多个项目就重新发起任务";
    expect(resultsOf(frontend, PM1, "submit_plan")[0]).toMatchObject({ outcome: "error" });
    expect(resultsOf(frontend, PM1, "submit_plan")[0]!.resultSummary).toContain(notOther);
    expect((card.payload as PlanCardPayload).plan.projects).toEqual([OWN_LINE]);
    // 执行中自行调整、提交计划变更也一样
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));
    await waitUntil(() => resultsOf(frontend, PM1, "propose_plan_change").length >= 1, { timeoutMs: 60_000, describe: () => "等提交计划变更" });
    for (const tool of ["revise_plan", "propose_plan_change"]) {
      expect(resultsOf(frontend, PM1, tool)[0]).toMatchObject({ outcome: "error" });
      expect(resultsOf(frontend, PM1, tool)[0]!.resultSummary).toContain(notOther);
    }
    expect(cardsOf(frontend).filter((c) => c.type === "plan_change")).toEqual([]);

    // 不涉及项目的任务：计划里不能写项目行
    ok(await frontend.startTask("整理一份周报模板", "start-不涉及项目"));
    const none = (await taskWhere(frontend, (e) => e.change === "created" && e.task.title === "整理一份周报模板", "不涉及项目的任务建出")).task.id;
    td.daemon.tasks.writeBrief(none, { goal: "一份周报模板", acceptanceCriteria: ["有模板"], constraints: [], projects: [], memoryScope: "" });
    await waitUntil(() => resultsOf(frontend, TM2, "submit_plan").length >= 1, { timeoutMs: 30_000, describe: () => "等不涉及项目的任务交计划" });
    expect(td.daemon.tasks.get(none)).toMatchObject({ maintainerId: "tm-2", projectScope: "none" });
    expect(resultsOf(frontend, TM2, "submit_plan")[0]).toMatchObject({ outcome: "error" });
    expect(resultsOf(frontend, TM2, "submit_plan")[0]!.resultSummary).toContain("这个任务不涉及项目，计划里不能写项目行（「记账本」）");

    // 建卡时没写项目、第一版任务书里写了两个：那一刻定成多项目任务（之后不再变）
    ok(await frontend.startTask("两边对一下账", "start-任务书定项目"));
    const settled = (await taskWhere(frontend, (e) => e.change === "created" && e.task.title === "两边对一下账", "没写项目的任务建出")).task.id;
    td.daemon.tasks.writeBrief(settled, brief);
    await taskWhere(frontend, (e) => e.task.id === settled && e.change === "projects_settled", "第一版任务书定下涉及的项目");
    expect(td.daemon.tasks.get(settled)).toMatchObject({ maintainerId: "tm-3", projectScope: "multi", projects: ["记账本", "家电档案"], projectIds: ["p-1", "p-2"] });
  }, 120_000);
});
