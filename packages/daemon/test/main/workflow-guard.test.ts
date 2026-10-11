// 主切面：流程执行时逐步照计划核对（59 号票，ADR 0019；照搬 AgentSense 固定计划的执行时检查：guard.ts 的 evaluateCall /
// tryAutoFix、planguardMonitor.ts、runtime.ts 的收尾提醒、sessionView.ts 的步骤推断）。真的守护进程，维护者接 faux 剧本，
// 测试扮演前端。流程直接经任务服务建出、写好任务书，维护者交计划、用户授权，之后维护者按剧本执行：
// - 每次调用先过现有的守卫判定，再和授权的计划比对（计划外、超范围、顺序错、重复、禁止），两道都要过；
// - 能修的不打扰用户：前置步骤没做的引回（redirect），参数和计划对不上的改回（rewrite）；每次修回在时间线上记一笔偏离；
// - 同一步修了 2 次还对不上、修不了的问用户；用户点过头的同一件事不再问（计划外又落进关注类别的除外，每次都问）；
// - 一轮收工时还有既没做、也没说明跳过的步骤，提醒一次；做完了的步骤没报的、报了在做没报做完的推断成做完——只推断真执行过的
//   （有对上它、执行成功的调用），被拒的、超出步骤写的调用不算；
// - 执行中维护者想改步骤，告诉它不行。
import fs from "node:fs";
import path from "node:path";
import {
  type ApprovalCardPayload,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  type ResponseFrame,
  type TaskEventPayload,
  type TimelineRecordEventPayload,
  type WorkflowPlanCardPayload,
  type WorkflowPlanDraft,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { TOOL } from "../../src/guard/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type StartTestDaemonOptions, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { bareRemote, git, initRepo } from "../helpers/git-repo.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;
const M1 = maintainerChannel("tm-1");
type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const propose = (draft: WorkflowPlanDraft) => call("propose_plan", draft as unknown as Record<string, unknown>);
const report = (stepId: string, status: string, gist?: string) => call("report_step", { stepId, status, ...(gist ? { gist } : {}) });
const echo: FauxStep = { kind: "echo_context" };

const messagesOf = (frontend: TestFrontend) => frontend.events({ channel: M1, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const recordsOf = (frontend: TestFrontend) => frontend.events({ channel: M1, type: EVENT_TYPES.timelineRecord }).map((f) => f.payload as TimelineRecordEventPayload);
const toolParts = (frontend: TestFrontend): ToolCallPart[] =>
  messagesOf(frontend)
    .flatMap((m) => m.message.parts)
    .filter((p): p is ToolCallPart => p.type === "tool_call");
/** 步骤能用的工具的调用（不含提交计划、汇报步骤这些推进流程的工具） */
const stepToolParts = (frontend: TestFrontend) => toolParts(frontend).filter((p) => p.tool !== "propose_plan" && p.tool !== "report_step");
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};
const turnsOf = (frontend: TestFrontend, n: number) =>
  waitUntil(() => frontend.events({ channel: M1, type: EVENT_TYPES.turnEnd }).length >= n, {
    timeoutMs: 60_000,
    describe: () => `等维护者处理完 ${n} 条输入；工具调用：${toolParts(frontend).map((p) => `${p.tool}:${p.outcome}${p.blockedBy ? `/${p.blockedBy}` : ""}`).join("、")}`,
  });
/** 维护者最后一次模型调用看到的上下文（剧本里 echo_context 的回显） */
const seenByMaintainer = (frontend: TestFrontend) => textOf(messagesOf(frontend).filter((m) => m.message.speaker === "agent").at(-1)!);

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}

const brief = { goal: "整理一份周报", acceptanceCriteria: ["周报写好、读过一遍"], constraints: [], projects: [], memoryScope: "" };

/** 写周报、读一遍（读在写之后） */
const notesDraft = (rules: WorkflowPlanDraft["rules"] = []): WorkflowPlanDraft => ({
  goal: "写好周报并读一遍",
  steps: [
    { id: "s1", title: "写周报", tool: TOOL.write, args: { path: "notes.md", content: "# 周报\n- 第一条\n" } },
    { id: "s2", title: "读一遍周报", tool: TOOL.read, args: { path: "notes.md" }, after: ["s1"] },
  ],
  rules,
});

/**
 * 起守护进程，建一个流程、写好任务书；维护者第一次被唤起交计划，用户授权（没有要逐项确认的事项）；执行时按 execution 的剧本做。
 * prepare：守护进程起来之前在流程的工作目录（outputs/t-1）里准备东西
 */
async function runWorkflow(draft: WorkflowPlanDraft, execution: FauxStep[], options: { prepare?: (work: string) => void; daemon?: Partial<StartTestDaemonOptions> } = {}) {
  const dataDir = makeTempDir("ergou-data-");
  const homeDir = makeTempDir("ergou-home-");
  const work = path.join(dataDirLayout(dataDir).outputs, "t-1");
  if (options.prepare) {
    fs.mkdirSync(work, { recursive: true });
    options.prepare(work);
  }
  const td: TestDaemon = await startTestDaemon({
    maintainer: (_id, spawn) => (spawn === 1 ? [propose(draft), say("计划交上去了")] : execution),
    reuse: { dataDir, homeDir },
    ...options.daemon,
  });
  const frontend = await TestFrontend.connect(td.url);
  await frontend.subscribe({ [BOARD]: 0, [CARDS]: 0, [INBOX]: 0, [M1]: 0 });
  const task = td.daemon.tasks.createByRequest({ title: "整理周报", summary: "整理周报", kind: "workflow" });
  td.daemon.tasks.writeBrief(task.id, brief);
  const card = await eventually(() => cardsOf(frontend), (c) => c.type === "workflow_plan", "流程计划卡");
  expect((card.payload as WorkflowPlanCardPayload).refused).toBeUndefined();
  await turnsOf(frontend, 1);
  ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: { confirmations: [] } }));
  await eventually(() => tasksOf(frontend), (e) => e.change === "started", "流程开始执行");
  return { td, frontend, taskId: task.id, work };
}

/** 等某个工具的第 nth 张审批卡（待处理）出来 */
async function approvalCard(frontend: TestFrontend, tool: string, nth = 1): Promise<Card> {
  let card: Card | undefined;
  await waitUntil(
    () => {
      const asked = cardsOf(frontend).filter((c) => c.type === "approval" && (c.payload as ApprovalCardPayload).tool === tool && c.status === "pending");
      card = [...new Map(asked.map((c) => [c.id, c])).values()][nth - 1];
      return card !== undefined;
    },
    { timeoutMs: 60_000, describe: () => `等 ${tool} 的第 ${nth} 张审批卡；工具调用：${toolParts(frontend).map((p) => `${p.tool}:${p.outcome}`).join("、")}` },
  );
  return card!;
}

const deviations = (frontend: TestFrontend) => recordsOf(frontend).filter((r) => r.record.kind === "deviation").map((r) => r.record.summary);

describe("顺序错：引回前置步骤，不打扰用户；修回超过次数后问用户", () => {
  it("没写就读：前两次引回写周报那一步（时间线记偏离），第三次问用户；用户点过头之后同样的不再问；照计划做完，流程完成", async () => {
    const { td, frontend, taskId } = await runWorkflow(notesDraft(), [
      call(TOOL.read, { path: "notes.md" }),
      call(TOOL.read, { path: "notes.md" }),
      call(TOOL.read, { path: "notes.md" }),
      call(TOOL.read, { path: "notes.md" }),
      report("s1", "in_progress"),
      call(TOOL.write, { path: "notes.md", content: "# 周报\n- 第一条\n" }),
      report("s1", "done", "写好了"),
      report("s2", "in_progress"),
      call(TOOL.read, { path: "notes.md" }),
      report("s2", "done", "读过了"),
      echo,
    ]);

    // 第三次：同一步自动修了 2 次还对不上，问用户（审批卡写明和计划哪里不一致）
    const card = await approvalCard(frontend, TOOL.read);
    const payload = card.payload as ApprovalCardPayload;
    expect(payload).toMatchObject({ taskId, categoryTitles: ["与已授权的计划不一致"] });
    expect(payload.reason).toContain("步骤 s2 依赖的 s1 还没有执行");
    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version }));

    const done = await eventually(() => tasksOf(frontend), (e) => e.change === "completed", "流程完成");
    expect(done.task.steps?.list?.map((s) => [s.stepId, s.state])).toEqual([
      ["s1", "done"],
      ["s2", "done"],
    ]);
    await turnsOf(frontend, 2);
    // 前两次被引回（没执行），第三次用户批准后执行（文件还不在，读出错），第四次同一件事点过头了、不再问
    expect(toolParts(frontend).filter((p) => p.tool === TOOL.read).map((p) => [p.outcome, p.blockedBy])).toEqual([
      ["blocked", "plan_redirect"],
      ["blocked", "plan_redirect"],
      ["error", undefined],
      ["error", undefined],
      ["done", undefined],
    ]);
    // 60 号票：每次调用带着和计划比对的结果（算在哪一步、查出的问题、用上的纠偏），界面把偏离标在"接下来的计划"那一格
    expect(toolParts(frontend).filter((p) => p.tool === TOOL.read || p.tool === TOOL.write).map((p) => [p.tool, p.plan])).toEqual([
      [TOOL.read, { stepId: "s2", findings: ["out_of_order"], correction: "redirect" }],
      [TOOL.read, { stepId: "s2", findings: ["out_of_order"], correction: "redirect" }],
      [TOOL.read, { stepId: "s2", findings: ["out_of_order"] }],
      // 同一件事点过头了、这次不再问，比对查出的问题照记（虚线框照样标在那一格）
      [TOOL.read, { stepId: "s2", findings: ["out_of_order"] }],
      [TOOL.write, { stepId: "s1" }],
      [TOOL.read, { stepId: "s2" }],
    ]);
    expect(cardsOf(frontend).filter((c) => c.type === "approval").map((c) => c.id).filter((id, i, all) => all.indexOf(id) === i)).toEqual([card.id]);
    // 维护者收到的是"先做哪一步、参数是什么"
    expect(seenByMaintainer(frontend)).toContain(
      '[toolResult] read: 【自动纠偏】这一步先不执行：步骤 s2 依赖的 s1 还没有执行。按用户已授权的计划，应先执行步骤 s1「写周报」：调用 write，参数 {"path":"notes.md","content":"# 周报\\n- 第一条\\n"}。做完再回来执行原来这一步。这是按计划纠偏，不需要询问用户。',
    );
    // 每次修回在时间线上记一笔偏离（口径同 14 号票：维护者会话里的 timeline_record，带着任务）
    expect(deviations(frontend)).toEqual(["自动纠偏：缺了前置步骤：先让维护者做「写周报」，再回来执行这一步", "自动纠偏：缺了前置步骤：先让维护者做「写周报」，再回来执行这一步"]);
    expect(recordsOf(frontend)[0]).toMatchObject({ taskId, record: { detail: "步骤 s2 依赖的 s1 还没有执行" } });
    // 引回不算拉回（不计入 14 号票的拉回次数）
    expect(td.daemon.tasks.get(taskId)?.stages?.list?.[0]?.pullBacks).toBeUndefined();
  }, 120_000);
});

describe("参数被改回", () => {
  it("写的内容违反了计划里的条件、计划写了该写什么：按计划改回再执行（不打扰用户），维护者知道实际执行的是哪一版；时间线记一笔", async () => {
    const rule = { id: "weekly-title", title: "周报以「# 周报」开头", trigger: { tool: TOOL.write }, require: { check: { startswith: ["$current.args.content", "# 周报"] } }, on_violation: "pull_back" };
    const { frontend, work } = await runWorkflow(notesDraft([rule]), [
      report("s1", "in_progress"),
      call(TOOL.write, { path: "notes.md", content: "# 笔记\n" }),
      report("s1", "done"),
      report("s2", "in_progress"),
      call(TOOL.read, { path: "notes.md" }),
      report("s2", "done"),
      echo,
    ]);
    await eventually(() => tasksOf(frontend), (e) => e.change === "completed", "流程完成");
    await turnsOf(frontend, 2);
    expect(fs.readFileSync(path.join(work, "notes.md"), "utf8")).toBe("# 周报\n- 第一条\n");
    expect(toolParts(frontend).find((p) => p.tool === TOOL.write)).toMatchObject({ outcome: "done", argsSummary: expect.stringContaining("notes.md") });
    // 60 号票：改回参数的调用记着用上了 rewrite（虚线框那一格写"参数已按计划改回"）
    expect(toolParts(frontend).find((p) => p.tool === TOOL.write)?.plan).toMatchObject({ stepId: "s1", correction: "rewrite" });
    expect(seenByMaintainer(frontend)).toContain("[toolResult] write: 【自动纠偏】参数和计划对不上，已按计划改回：content # 笔记\n → # 周报\n- 第一条\n。以下是按计划参数执行的结果：");
    expect(deviations(frontend)).toEqual(["自动纠偏：参数和计划对不上，已按计划改回：content # 笔记\n → # 周报\n- 第一条\n"]);
    expect(cardsOf(frontend).filter((c) => c.type === "approval")).toEqual([]);
  }, 120_000);
});

describe("计划外、超范围", () => {
  it("计划外只读的照常做；计划外会改东西的、超出步骤写的对象的问用户（照 AgentSense：这两种不自动修）", async () => {
    const { frontend } = await runWorkflow(notesDraft(), [
      call(TOOL.ls, {}),
      call(TOOL.edit, { path: "notes.md", edits: [{ oldText: "a", newText: "b" }] }),
      call(TOOL.write, { path: "other.md", content: "别的\n" }),
      // 点过一次头之后换一个文件照样问（用户定：按"工具 + 这次碰的对象"记，比 AgentSense 严；同一个对象不再问见守卫切面）
      call(TOOL.write, { path: "third.md", content: "第三个\n" }),
      report("s1", "in_progress"),
      call(TOOL.write, { path: "notes.md", content: "# 周报\n- 第一条\n" }),
      report("s1", "done"),
      report("s2", "in_progress"),
      call(TOOL.read, { path: "notes.md" }),
      report("s2", "done"),
      echo,
    ]);
    const edit = await approvalCard(frontend, TOOL.edit);
    expect((edit.payload as ApprovalCardPayload).reason).toContain("计划里没有 edit 这一步");
    ok(await frontend.cardAction({ cardId: edit.id, action: "deny", expectedVersion: edit.version, note: "别改" }));
    const other = await approvalCard(frontend, TOOL.write);
    expect((other.payload as ApprovalCardPayload).reason).toContain("write 的参数超出了计划声明的范围");
    ok(await frontend.cardAction({ cardId: other.id, action: "approve", expectedVersion: other.version }));
    const third = await approvalCard(frontend, TOOL.write, 2);
    expect((third.payload as ApprovalCardPayload).argsSummary).toContain("third.md");
    ok(await frontend.cardAction({ cardId: third.id, action: "approve", expectedVersion: third.version }));
    await eventually(() => tasksOf(frontend), (e) => e.change === "completed", "流程完成");
    await turnsOf(frontend, 2);
    expect(stepToolParts(frontend).slice(0, 4).map((p) => [p.tool, p.outcome])).toEqual([
      [TOOL.ls, "done"],
      [TOOL.edit, "denied"],
      [TOOL.write, "done"],
      [TOOL.write, "done"],
    ]);
    // 60 号票：计划外的标 offPlan（只读的放行了，没有要记的问题）；超出步骤写的对象的算在同一工具的那一步上
    expect(stepToolParts(frontend).slice(0, 4).map((p) => p.plan)).toEqual([
      { offPlan: true },
      { offPlan: true, findings: ["off_plan"] },
      { stepId: "s1", findings: ["out_of_scope"] },
      { stepId: "s1", findings: ["out_of_scope"] },
    ]);
    expect(cardsOf(frontend).filter((c) => c.type === "approval").map((c) => c.id).filter((id, i, all) => all.indexOf(id) === i)).toEqual([edit.id, other.id, third.id]);
    expect(deviations(frontend)).toEqual([]);
  }, 120_000);
});

describe("重复：只许做一次的直接拦下", () => {
  it("推送做过一次之后同一步再推一次：计划检查拦下，不问用户（照 AgentSense 的 once）", async () => {
    const remote = bareRemote();
    const { frontend } = await runWorkflow(
      {
        goal: "跑测试、推送",
        steps: [
          { id: "s1", title: "跑测试", tool: TOOL.run_tests, args: {} },
          { id: "s2", title: "推送", tool: TOOL.git_push, args: { remote: "origin", branch: "main" }, after: ["s1"] },
        ],
        rules: [],
      },
      [
        report("s1", "in_progress"),
        call(TOOL.run_tests, {}),
        report("s1", "done"),
        report("s2", "in_progress"),
        call(TOOL.git_push, { remote: "origin", branch: "main" }),
        call(TOOL.git_push, { remote: "origin", branch: "main" }),
        report("s2", "done"),
        echo,
      ],
      {
        prepare: (work) => {
          initRepo(work, { "package.json": JSON.stringify({ name: "demo", private: true, scripts: { test: "node -e \"\"" } }), ".npmrc": "update-notifier=false\nfund=false\naudit=false\n" });
          git(work, "remote", "add", "origin", remote);
        },
      },
    );
    await eventually(() => tasksOf(frontend), (e) => e.change === "completed", "流程完成", 120_000);
    await turnsOf(frontend, 2);
    expect(toolParts(frontend).filter((p) => p.tool === TOOL.git_push).map((p) => [p.outcome, p.blockedBy])).toEqual([
      ["done", undefined],
      ["blocked", "plan_check"],
    ]);
    expect(seenByMaintainer(frontend)).toContain("[toolResult] git_push: 计划检查拦截：步骤 s2 只能执行一次。这一条不会因为重试而通过");
    expect(cardsOf(frontend).filter((c) => c.type === "approval")).toEqual([]);
    expect(git(remote, "rev-parse", "refs/heads/main").trim()).toBeTruthy();
  }, 180_000);
});

describe("收尾提醒", () => {
  it("一轮收工时还有既没做、也没说明跳过的步骤：提醒一次（时间线记一笔）；补上之后，做了没报的、报了在做没报做完的推断成做完，流程完成", async () => {
    const { frontend, taskId } = await runWorkflow(notesDraft(), [
      // 第一轮：写了没报，说做完了
      call(TOOL.write, { path: "notes.md", content: "# 周报\n- 第一条\n" }),
      say("周报写好了"),
      // 第二轮（提醒）：读了一遍，报了在做，没报做完
      report("s2", "in_progress"),
      call(TOOL.read, { path: "notes.md" }),
      say("读过了"),
    ]);
    const done = await eventually(() => tasksOf(frontend), (e) => e.change === "completed", "流程完成");
    expect(done.task.steps).toMatchObject({ total: 2, done: 2 });
    expect(done.task.steps?.list).toEqual([
      { stepId: "s1", title: "写周报", state: "done", inferred: true },
      { stepId: "s2", title: "读一遍周报", state: "done", inferred: true },
    ]);
    const nudges = messagesOf(frontend).filter((m) => textOf(m).includes("【计划检查】"));
    expect(nudges.map(textOf)).toEqual([
      "【计划检查】已授权的计划里还有 s2「读一遍周报」 既没有执行，也没有报告跳过。请继续按计划执行；如果确实不需要做，用 report_step 标记 skipped，并在 gist 里说明原因。",
    ]);
    expect(nudges[0]).toMatchObject({ taskId, agentInput: true });
    expect(deviations(frontend)).toEqual(["自动纠偏：收尾前发现还有 s2「读一遍周报」 没做也没说明，已提醒维护者补上或说明跳过原因"]);
  }, 120_000);

  it("没真执行过的步骤不推断成做完：被拒的、超出步骤写的（用户批准了也一样）都不算做过那一步，报着在做的照旧在做，流程不完成", async () => {
    const { frontend, td, taskId } = await runWorkflow(notesDraft(), [
      report("s1", "in_progress"),
      // 写了别的文件：超范围，第一次用户拒了，第二次批准了（执行了，但对不上写周报那一步）
      call(TOOL.write, { path: "other.md", content: "别的\n" }),
      call(TOOL.write, { path: "other.md", content: "别的\n" }),
      // 开始下一步、再说明它跳过：写周报那一步没真执行过，不因为"开始了新步骤"推断成做完
      report("s2", "in_progress"),
      report("s2", "skipped", "不用读了"),
      say("做完了"),
      // 提醒那一轮：什么都没补
      say("好的"),
    ]);
    const denied = await approvalCard(frontend, TOOL.write);
    ok(await frontend.cardAction({ cardId: denied.id, action: "deny", expectedVersion: denied.version, note: "先别写" }));
    const approved = await approvalCard(frontend, TOOL.write, 2);
    ok(await frontend.cardAction({ cardId: approved.id, action: "approve", expectedVersion: approved.version }));
    await turnsOf(frontend, 3);
    expect(stepToolParts(frontend).map((p) => [p.tool, p.outcome])).toEqual([
      [TOOL.write, "denied"],
      [TOOL.write, "done"],
    ]);
    // 收尾时提醒了写周报那一步（它没执行过）；提醒之后还是没做：留在"在做"，流程不完成
    expect(messagesOf(frontend).filter((m) => textOf(m).includes("【计划检查】")).map(textOf)).toEqual([
      "【计划检查】已授权的计划里还有 s1「写周报」 既没有执行，也没有报告跳过。请继续按计划执行；如果确实不需要做，用 report_step 标记 skipped，并在 gist 里说明原因。",
    ]);
    expect(td.daemon.tasks.get(taskId)).toMatchObject({
      state: "running",
      steps: { done: 1, list: [{ stepId: "s1", state: "in_progress" }, { stepId: "s2", state: "skipped", gist: "不用读了" }] },
    });
    expect(td.daemon.tasks.get(taskId)?.steps?.list?.[0]?.inferred).toBeUndefined();
    expect(tasksOf(frontend).some((e) => e.change === "completed")).toBe(false);
  }, 120_000);

  it("提醒过一次还没补：这一轮不再提醒，流程留在执行中；这一轮什么都没做（只说话）的不提醒", async () => {
    const { frontend, td, taskId } = await runWorkflow(notesDraft(), [
      report("s1", "in_progress"),
      call(TOOL.write, { path: "notes.md", content: "# 周报\n- 第一条\n" }),
      say("写好了"),
      say("读就不读了"),
      say("好的"),
    ]);
    await turnsOf(frontend, 3);
    expect(messagesOf(frontend).filter((m) => textOf(m).includes("【计划检查】"))).toHaveLength(1);
    // 用户在任务的会话里说一句：新的一轮；只说话、什么都没做，不提醒
    await frontend.sendText("怎么样了？", { conversation: M1 });
    await turnsOf(frontend, 4);
    expect(messagesOf(frontend).filter((m) => textOf(m).includes("【计划检查】"))).toHaveLength(1);
    expect(td.daemon.tasks.get(taskId)).toMatchObject({ state: "running", steps: { done: 1, list: [{ stepId: "s1", state: "done", inferred: true }, { stepId: "s2", state: "pending" }] } });
  }, 120_000);
});

describe("执行中不能改步骤", () => {
  it("维护者执行中又交计划：告诉它不行（要改就由用户重新发起，先用 wait_for_user 说明）", async () => {
    const { frontend } = await runWorkflow(notesDraft(), [propose(notesDraft()), echo]);
    await turnsOf(frontend, 2);
    expect(seenByMaintainer(frontend)).toContain("[toolResult] propose_plan: 执行中不能改步骤");
    expect(cardsOf(frontend).filter((c) => c.type === "workflow_plan").map((c) => c.id).filter((id, i, all) => all.indexOf(id) === i)).toHaveLength(1);
  }, 120_000);
});
