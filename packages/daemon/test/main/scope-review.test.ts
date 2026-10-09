// 主切面：范围审视（规格第 10 节，18 号票）。真的守护进程，秘书、维护者接 faux 剧本，审视用的便宜模型也由 faux 扮演，测试扮演前端。
// - 每张工单结束时（写回之后、维护者子进程退出之前），子进程里另开一次模型调用审视这段工作：输入有这段工作的对话、立项书、
//   任务计划和授权（含用户在会话里直接说的话），输出范围记录交给守护进程保存；这次调用不出现在维护者的会话里，用量记在任务名下；
// - 越界：待我处理里一条不推送的越界通知（不卡任务，照常算未读）；范围变更：写进项目档案的范围记录；两种都不暂停维护者；
// - 每条范围记录都作为事件出现在维护者会话的频道里（timeline_record，带种类），项目列表频道上另有 scope_record（项目页显示）；
// - 维护者会话压缩时，扩展把待压缩的消息送审，结果 appendEntry 进会话、同时交给守护进程保存；
// - 下一次唤起维护者（新的一段会话，旧段的 appendEntry 不在上下文里）时，系统提示末尾有"近期范围记录"（最近 5 条）；
// - 不属于项目的任务：压缩时同样审视（对照任务书、计划和用户的话），范围记录写进任务自己的产出区，越界同样放通知；
// - 审视没做成（回复不是约定的 JSON、超时）：工单照常结束，会话里一条说明；
// - 重置维护者时没审视的那段工作（工单做到一半、写回中途、审视做到一半）：不强行审视，时间线上如实记"重置时这段没做范围审视"；
// - 对照物里有用户在审批卡上批准过的调用（算授权过）；
// - 彻底删除一条被范围记录引用的用户消息：范围记录、时间线、越界通知、项目档案、维护者的会话文件里都不再有原话。
import fs from "node:fs";
import path from "node:path";
import {
  type ApprovalCardPayload,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItem,
  type InboxItemEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  METHODS,
  type NotifyEventPayload,
  OUT_OF_SCOPE_ACK,
  type Plan,
  type PlanCardPayload,
  PURGED_TEXT,
  type ResponseFrame,
  type ScopeRecordEventPayload,
  type SegmentEventPayload,
  type TaskEventPayload,
  type TimelineRecordEventPayload,
  type WorkOrderEventPayload,
  workOrderTaskId,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { materialsApi } from "../helpers/http.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { byMaintainer, internalTask, seedProject } from "../helpers/projects.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const PM1 = maintainerChannel("pm-1");

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const summary = (text: string) => call("write_segment_summary", { summary: text });
const writeProgress = (content: string) => call("write_progress", { content });
const ECHO: FauxStep = { kind: "echo_context" };

/** 审视模型（faux 扮演便宜模型）的回复：这段工作都在范围之内 */
const IN_SCOPE: FauxStep = { kind: "reply", text: '{"records":[]}' };
/** 审视模型的回复：一条记录，说明里放着它这次收到的全部输入（核对审视的输入） */
const finding = (kind: "scope_change" | "out_of_scope", summaryText: string, basis?: string): FauxStep => ({
  kind: "reply_with_context",
  text: JSON.stringify({ records: [{ kind, summary: summaryText, detail: "@@", ...(basis === undefined ? {} : { basis }) }] }).replace('"@@"', '"审视的输入：{{context}}"'),
});

/** 很长的一句（约 2.5 万 token）：压缩时留下它和它之后的，它之前的写进摘要 */
const LONG = `材料：${"一段很长的材料。".repeat(12_500)}`;

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const scopeRecordEvents = (frontend: TestFrontend, channel: string = PROJECTS) => frontend.events({ channel, type: EVENT_TYPES.scopeRecord }).map((f) => f.payload as ScopeRecordEventPayload);
const scopeRecordsOf = (frontend: TestFrontend, channel: string = PROJECTS) => scopeRecordEvents(frontend, channel).map((p) => p.record);
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const segmentsOf = (frontend: TestFrontend) => frontend.events({ channel: PM1, type: EVENT_TYPES.segment }).map((f) => f.payload as SegmentEventPayload);
/** 维护者会话目录里全部会话文件的内容 */
const sessionText = (dataDir: string, maintainerId = "pm-1") => {
  const dir = path.join(dataDir, "sessions", maintainerId);
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n") : "";
};
const timelineOf = (frontend: TestFrontend, channel: string = PM1) => frontend.events({ channel, type: EVENT_TYPES.timelineRecord }).map((f) => f.payload as TimelineRecordEventPayload);
const inboxOf = (frontend: TestFrontend) => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
const outOfScopeNotices = (frontend: TestFrontend) => latestItems(inboxOf(frontend)).filter((i) => i.kind === "notice" && i.notice === "out_of_scope");
/** 推送过（notify）的越界通知：越界不推送，应当没有 */
const pushedOutOfScope = (frontend: TestFrontend) => {
  const ids = new Set(outOfScopeNotices(frontend).map((i) => i.id));
  return frontend.events({ channel: INBOX, type: EVENT_TYPES.notify }).filter((f) => ids.has((f.payload as NotifyEventPayload).itemId ?? ""));
};
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const workOrdersOf = (frontend: TestFrontend) => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.workOrder }).map((f) => f.payload as WorkOrderEventPayload);
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

/** 每条事项的最新状态 */
function latestItems(items: readonly InboxItem[]): InboxItem[] {
  return [...new Map(items.map((i) => [i.id, i])).values()];
}

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}
const turnsOf = (frontend: TestFrontend, channel: string, n: number) =>
  waitUntil(() => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 60_000, describe: () => `等 ${channel} 处理完 ${n} 条输入` });

/** 先定下数据目录和主目录（剧本里要写项目档案的路径），再起守护进程 */
function dirs() {
  const dataDir = makeTempDir("ergou-data-");
  return { dataDir, homeDir: makeTempDir("ergou-home-"), records: (projectId = "p-1") => path.join(fs.realpathSync.native(dataDir), "projects", projectId) };
}

const progressEdit = (records: string, oldText: string, newText: string) => call("edit", { path: path.join(records, "progress.md"), edits: [{ oldText, newText }] });

/** 只有一个阶段：在工作目录里写出 file，脚本验收它存在 */
function onePlan(file: string): Plan {
  const base = samplePlan();
  return {
    ...base,
    stages: [
      {
        stageId: "s1",
        title: "写出周报",
        deliverables: [file],
        acceptance: [{ criterion: `${file} 存在`, method: "script", script: `test -f ${file}` }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 100_000, toolCalls: 30 },
      },
    ],
    stageGroups: [],
    scheduledJobs: [],
    stops: { count: 0, where: [] },
    toolkit: { skills: [], mcp: [], bash: false, network: false },
  };
}

const brief = (project: string) => ({ goal: "每周出一份周报", acceptanceCriteria: ["有周报文件"], constraints: ["别动账本数据"], projects: [project], memoryScope: "" });

async function connect(url: string, channels: string[]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

/** 立项书确认过的、使用中的项目；立项书写明范围（审视对照它） */
function bookkeeping(td: TestDaemon, records: string) {
  const project = seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: false } });
  fs.writeFileSync(path.join(records, "charter.md"), "# 立项书\n\n## 范围\n\n- 只做记账和报表，不碰项目说明文档 README\n");
  return project;
}

describe("范围审视：项目的维护者", () => {
  it("工单结束时审视（子进程退出之前、另开一次调用）：越界进待我处理（不推送、不卡任务、未读）、项目页和时间线上有记录、项目档案里记下；下一段会话的系统提示末尾有近期范围记录；用户在会话里说了先做 X，压缩时审视把它记为范围变更写进项目档案，结果也 appendEntry 进会话", async () => {
    const d = dirs();
    const records = d.records();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        // 起草计划的工单段
        if (spawn === 1) return [submitPlanStep(onePlan("weekly.md")), writeProgress("周报：计划交上去了。"), summary("起草了周报计划"), say("计划交上去了")];
        // 执行的工单段：写周报，又顺手改了立项书范围外的 README
        if (spawn === 2)
          return [
            call("write", { path: "weekly.md", content: "# 周报\n" }),
            call("write", { path: "README.md", content: "# 顺手改的说明\n" }),
            call("complete_stage", { stageId: "s1", summary: "weekly.md 写好了" }),
            progressEdit(records, "周报：计划交上去了。", "周报：做完了，在 weekly.md。"),
            summary("周报做完了"),
            say("做完了"),
          ];
        // 用户直接对话（新的一段）：先回显看到的上下文；第三句时上下文溢出、自动压缩（写摘要的一次）再重试
        return [ECHO, say("收到了一大段"), { kind: "context_overflow" }, say("摘要：用户让先导出分类表 CSV，又发过一大段材料"), say("好，导出了 CSV")];
      },
      scopeReviewer: (id, spawn) => {
        if (id !== "pm-1") return [];
        if (spawn === 1) return [IN_SCOPE];
        if (spawn === 2) return [finding("out_of_scope", "顺手改了立项书范围外的 README")];
        return [finding("scope_change", "按用户说的先导出了分类表 CSV", "用户在会话里说：先帮我做下 X")];
      },
    });
    const project = bookkeeping(td, records);
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1]);
    // 前端回放用：只录项目列表、待我处理、看板、卡片（维护者会话里有很长的材料，不录）
    const recorder = await connect(td.url, [PROJECTS, INBOX, BOARD, CARDS]);

    internalTask(td.daemon, "记账本", "给记账本加周报");
    const created = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "任务");
    const taskId = created.task.id;
    td.daemon.tasks.writeBrief(taskId, brief("记账本"), byMaintainer(td.daemon, taskId));
    const card = await eventually(
      () => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as { card: { id: string; type: string; payload: unknown } }).card),
      (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === taskId,
      "计划卡",
    );
    // 起草计划的工单结束时也审视了（都在范围之内：什么都不记）
    const planOrder = await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && e.workOrder.kind === "plan", "起草计划的工单结束");
    expect(scopeRecordsOf(frontend)).toEqual([]);
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));

    // 执行的工单结束：先写回、再审视，审视的结果和工单的结束同一事务
    const executed = await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && e.workOrder.kind === "execute", "执行的工单结束", 60_000);
    expect(executed.workOrder).toMatchObject({ outcome: "done" });
    expect(executed.workOrder.unwritten).toBeUndefined();
    const [overreach] = scopeRecordsOf(frontend);
    expect(scopeRecordsOf(frontend)).toHaveLength(1);
    expect(overreach).toMatchObject({
      kind: "out_of_scope",
      summary: "顺手改了立项书范围外的 README",
      trigger: "work_order_end",
      maintainerId: "pm-1",
      projectId: project.id,
      taskId,
      workOrderId: executed.workOrder.id,
    });
    expect(overreach!.workOrderId).not.toBe(planOrder.workOrder.id);
    // 审视的输入：这段工作的对话（写了 README）、立项书、任务计划（阶段、交付件）和任务书的约束
    const input = overreach!.detail!;
    expect(input).toContain("README.md");
    expect(input).toContain("只做记账和报表，不碰项目说明文档 README");
    expect(input).toContain("写出周报");
    expect(input).toContain("weekly.md");
    expect(input).toContain("别动账本数据");
    // 维护者没被暂停：任务照常完成
    expect(tasksOf(frontend).at(-1)!.task).toMatchObject({ id: taskId, state: "done" });

    // 越界：待我处理里一条不推送、不卡任务、未读的通知
    const [notice] = outOfScopeNotices(frontend);
    expect(outOfScopeNotices(frontend)).toHaveLength(1);
    expect(notice).toMatchObject({ kind: "notice", notice: "out_of_scope", urgency: "non_blocking", read: false, actions: [OUT_OF_SCOPE_ACK] });
    expect(notice!.title).toContain("顺手改了立项书范围外的 README");
    expect(notice!.kind === "notice" && notice!.data).toMatchObject({ recordId: overreach!.id, maintainerId: "pm-1", projectId: project.id, taskId, workOrderId: executed.workOrder.id });
    expect(pushedOutOfScope(frontend)).toEqual([]);
    // 维护者会话频道上的时间线记录（带种类、工单、归属）
    const marks = timelineOf(frontend).filter((r) => r.record.kind === "out_of_scope");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ record: { summary: "顺手改了立项书范围外的 README", workOrderId: executed.workOrder.id }, projectId: project.id, taskId });
    // 项目档案的范围记录里记下（越界写成越界，不写成范围变更）
    const file = () => fs.readFileSync(path.join(records, "scope-records.md"), "utf8");
    expect(file()).toContain(`越界 · 工单结束时 · 工单 ${executed.workOrder.id}（任务 ${taskId}）：顺手改了立项书范围外的 README`);
    expect(file()).not.toContain("范围变更 ·");
    // 审视那次调用不在维护者的会话里；用量记在刚处理完的那条输入所属的任务名下，标"范围审视"
    expect(messagesOf(frontend, PM1).some((m) => textOf(m).includes("范围审视员"))).toBe(false);
    await waitUntil(() => td.daemon.ledger.entries({ kind: "task", id: taskId }).filter((e) => e.purpose === "scope_review").length >= 2, { describe: () => "等审视的用量记账" });
    expect(td.daemon.ledger.entries({ kind: "task", id: taskId }).filter((e) => e.purpose === "scope_review").map((e) => e.agentId)).toEqual(["pm-1", "pm-1"]);

    // 用户直接和维护者说话：新的一段会话（旧段的 appendEntry 不在上下文里），系统提示末尾有近期范围记录
    await frontend.sendText("先帮我做下 X：把分类表导出成 CSV", { conversation: PM1 });
    const echoed = await eventually(() => messagesOf(frontend, PM1), (m) => m.message.speaker === "agent" && textOf(m).includes("[system]"), "维护者回显上下文");
    const system = textOf(echoed).slice(0, textOf(echoed).indexOf("[user]"));
    expect(system).toContain("## 近期范围记录");
    expect(system).toContain("越界");
    expect(system).toContain("顺手改了立项书范围外的 README");
    expect(system.indexOf("## 近期范围记录")).toBeGreaterThan(system.indexOf("项目「记账本」"));

    // 接着发一大段材料，第三句时上下文溢出：压缩会话，扩展把要压缩的消息（含用户说的"先帮我做下 X"）送审
    await frontend.sendText(LONG, { conversation: PM1 });
    await eventually(() => messagesOf(frontend, PM1), (m) => textOf(m) === "收到了一大段", "维护者收下材料");
    await frontend.sendText("第三句", { conversation: PM1 });
    const change = await eventually(() => scopeRecordsOf(frontend), (r) => r.kind === "scope_change", "范围变更", 60_000);
    expect(change).toMatchObject({ summary: "按用户说的先导出了分类表 CSV", basis: "用户在会话里说：先帮我做下 X", trigger: "compaction", projectId: project.id });
    expect(change.taskId).toBeUndefined();
    expect(change.detail).toContain("先帮我做下 X：把分类表导出成 CSV");
    // 范围变更写进项目档案；不放通知；时间线上标出；维护者照常回话
    await waitUntil(() => file().includes("范围变更"), { describe: () => "等范围变更写进项目档案" });
    expect(file()).toContain("范围变更 · 压缩会话时：按用户说的先导出了分类表 CSV（依据：用户在会话里说：先帮我做下 X）");
    expect(outOfScopeNotices(frontend)).toHaveLength(1);
    expect(timelineOf(frontend).filter((r) => r.record.kind === "scope_change")).toHaveLength(1);
    await eventually(() => messagesOf(frontend, PM1), (m) => textOf(m) === "好，导出了 CSV", "维护者重试这一轮");
    // 审视的结果 appendEntry 进了这一段的会话文件（副本）
    const sessionDir = path.join(d.dataDir, "sessions", "pm-1");
    const entries = fs
      .readdirSync(sessionDir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => fs.readFileSync(path.join(sessionDir, f), "utf8").split("\n"))
      .filter((l) => l.includes('"ergou-scope-review"'));
    // 压缩时子进程自己做的那次没有 requestId（工单结束时守护进程要的有）
    expect(entries.some((l) => l.includes("按用户说的先导出了分类表 CSV") && !l.includes('"requestId"'))).toBe(true);

    saveOrCheckRecording("scope-review", recorder.recording, { perChannel: true });
  }, 180_000);

  it("近期范围记录只取最近 5 条：一次审视记下 6 条越界，下一段会话的系统提示里是后 5 条", async () => {
    const d = dirs();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        if (spawn === 1) return [submitPlanStep(onePlan("weekly.md")), writeProgress("周报：计划交上去了。"), summary("起草了周报计划"), say("计划交上去了")];
        return [ECHO];
      },
      scopeReviewer: (id, spawn) =>
        id === "pm-1" && spawn === 1
          ? [{ kind: "reply", text: JSON.stringify({ records: [1, 2, 3, 4, 5, 6].map((n) => ({ kind: "out_of_scope", summary: `越界的第 ${n} 件事` })) }) }]
          : [],
    });
    bookkeeping(td, d.records());
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1]);
    internalTask(td.daemon, "记账本", "给记账本加周报");
    const created = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "任务");
    td.daemon.tasks.writeBrief(created.task.id, brief("记账本"), byMaintainer(td.daemon, created.task.id));
    await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && e.workOrder.kind === "plan", "起草计划的工单结束");
    expect(scopeRecordsOf(frontend).map((r) => r.summary)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `越界的第 ${n} 件事`));
    expect(outOfScopeNotices(frontend)).toHaveLength(6);

    await frontend.sendText("现在怎么样了", { conversation: PM1 });
    const echoed = await eventually(() => messagesOf(frontend, PM1), (m) => m.message.speaker === "agent" && textOf(m).includes("[system]"), "维护者回显上下文");
    const system = textOf(echoed).slice(0, textOf(echoed).indexOf("[user]"));
    expect(system).toContain("## 近期范围记录");
    expect(system).not.toContain("越界的第 1 件事");
    for (const n of [2, 3, 4, 5, 6]) expect(system).toContain(`越界的第 ${n} 件事`);
    // 越早的在前
    expect(system.indexOf("越界的第 2 件事")).toBeLessThan(system.indexOf("越界的第 6 件事"));
  }, 120_000);
});

describe("范围审视：子进程退出之前", () => {
  it("工单结束时的审视做得比闲置退出的时间还久：子进程等审视的结果交给守护进程之后才闲置退出，记录照常记下", async () => {
    const d = dirs();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      // 闲置 1.2 秒就退出；审视的回复慢慢吐（约 3 秒）
      config: { agents: { idleMinutes: 0.02 } },
      secretary: [say("好的")],
      maintainer: (id, spawn) => (id === "pm-1" && spawn === 1 ? [submitPlanStep(onePlan("weekly.md")), writeProgress("周报：计划交上去了。"), summary("起草了周报计划"), say("计划交上去了")] : []),
      scopeReviewer: (id, spawn) => (id === "pm-1" && spawn === 1 ? [{ kind: "reply", text: JSON.stringify({ records: [{ kind: "out_of_scope", summary: `慢慢审出来的越界${"。".repeat(40)}` }] }) }] : []),
      scopeReviewerTokensPerSecond: 20,
    });
    bookkeeping(td, d.records());
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1, CHANNELS.activity]);
    internalTask(td.daemon, "记账本", "给记账本加周报");
    const created = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "任务");
    td.daemon.tasks.writeBrief(created.task.id, brief("记账本"), byMaintainer(td.daemon, created.task.id));

    const ended = await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && e.workOrder.kind === "plan", "起草计划的工单结束");
    expect(scopeRecordsOf(frontend)).toMatchObject([{ kind: "out_of_scope", workOrderId: ended.workOrder.id }]);
    // 审视照常做完：会话里没有"范围审视没做成"的说明；子进程一直活到审视的结果交上来，之后才闲置退出（只拉起过一次）
    expect(messagesOf(frontend, PM1).some((m) => textOf(m).includes("范围审视没做成"))).toBe(false);
    await waitUntil(
      () =>
        frontend
          .events({ channel: CHANNELS.activity, type: EVENT_TYPES.activity })
          .some((f) => (f.payload as { agentId: string; detail?: { kind: string } }).agentId === "pm-1" && (f.payload as { detail?: { kind: string } }).detail?.kind === "idle_exit"),
      { describe: () => "等维护者闲置退出" },
    );
    expect(messagesOf(frontend, PM1).filter((m) => m.message.parts.some((p) => p.type === "work_order_divider"))).toHaveLength(1);
  }, 120_000);
});

describe("范围审视：和工具包的重新装配（27 号票）", () => {
  it("工单结束时的审视做到一半，用户改了项目的工具包（27 号票）：审视在做时不换装配，等审视的结果交上来之后才停掉子进程，记录照常记下", async () => {
    const d = dirs();
    const records = d.records();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        // 计划里开了 bash，项目的工具包没开：执行时没有 bash
        if (spawn === 1) return [submitPlanStep({ ...onePlan("weekly.md"), toolkit: { skills: [], mcp: [], bash: true, network: false } }), writeProgress("周报：计划交上去了。"), summary("起草了周报计划"), say("计划交上去了")];
        if (spawn === 2)
          return [
            call("write", { path: "weekly.md", content: "# 周报\n" }),
            call("complete_stage", { stageId: "s1", summary: "weekly.md 写好了" }),
            progressEdit(records, "周报：计划交上去了。", "周报：做完了，在 weekly.md。"),
            summary("周报做完了"),
            say("做完了"),
          ];
        return [];
      },
      // 执行的工单结束时的审视慢慢吐（约 6 秒）；只有拉起第二次的子进程（执行的那一段）给得出这条记录
      scopeReviewer: (id, spawn) => (id !== "pm-1" ? [] : spawn === 1 ? [IN_SCOPE] : spawn === 2 ? [{ kind: "reply", text: JSON.stringify({ records: [{ kind: "out_of_scope", summary: `慢慢审出来的越界${"。".repeat(100)}` }] }) }] : []),
      scopeReviewerTokensPerSecond: 20,
    });
    const project = bookkeeping(td, records);
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1]);
    internalTask(td.daemon, "记账本", "给记账本加周报");
    const created = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "任务");
    td.daemon.tasks.writeBrief(created.task.id, brief("记账本"), byMaintainer(td.daemon, created.task.id));
    const card = await eventually(
      () => cardsOf(frontend),
      (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === created.task.id,
      "计划卡",
    );
    await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && e.workOrder.kind === "plan", "起草计划的工单结束");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));

    // 执行完、写回之后开始审视；审视在做时用户在项目页打开 bash（执行时的交集跟着变了）
    await eventually(() => messagesOf(frontend, PM1), (m) => m.message.speaker === "agent" && textOf(m).includes("做完了"), "维护者做完了");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(workOrdersOf(frontend).some((e) => e.change === "ended" && e.workOrder.kind === "execute")).toBe(false);
    ok(await frontend.request(METHODS.setToolkit, { target: { kind: "project", projectId: project.id }, toolkit: { skills: [], mcp: [], bash: true, network: false } }, "k-bash"));

    // 审视照常在原来的子进程里做完：记录记下了，会话里没有"范围审视没做成"
    const ended = await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && e.workOrder.kind === "execute", "执行的工单结束", 60_000);
    expect(scopeRecordsOf(frontend)).toMatchObject([{ kind: "out_of_scope", summary: expect.stringContaining("慢慢审出来的越界"), workOrderId: ended.workOrder.id }]);
    expect(messagesOf(frontend, PM1).some((m) => textOf(m).includes("范围审视没做成"))).toBe(false);
  }, 120_000);
});

describe("范围审视：不属于项目的任务", () => {
  it("任务自己的维护者压缩会话时同样审视（对照任务书、计划和用户的话）：范围记录写进任务的产出区、看板频道上有记录，越界放不推送的通知", async () => {
    const td = await startTestDaemon({
      secretary: [say("好的")],
      maintainer: (id) => (id === "tm-1" ? [say("收到任务书"), say("收到了一大段"), { kind: "context_overflow" }, say("摘要：任务书和一大段材料"), say("好")] : []),
      scopeReviewer: (id) => (id === "tm-1" ? [finding("out_of_scope", "起草计划时就去翻了别的项目的文件")] : []),
    });
    const TM1 = maintainerChannel("tm-1");
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, TM1]);
    const task = td.daemon.tasks.createByRequest({ title: "X 的调研", summary: "X 的调研" });
    td.daemon.tasks.writeBrief(task.id, { goal: "调研 X 的现状", acceptanceCriteria: ["有调研报告"], constraints: ["只看公开资料"], projects: [], memoryScope: "" });
    await turnsOf(frontend, TM1, 1);
    await frontend.sendText(LONG, { conversation: TM1 });
    await turnsOf(frontend, TM1, 2);
    await frontend.sendText("第三句", { conversation: TM1 });

    const record = await eventually(() => scopeRecordsOf(frontend, BOARD), (r) => r.kind === "out_of_scope", "看板频道上的范围记录", 60_000);
    expect(record).toMatchObject({ summary: "起草计划时就去翻了别的项目的文件", trigger: "compaction", maintainerId: "tm-1", taskId: task.id });
    expect(record.projectId).toBeUndefined();
    // 审视的输入：要压缩掉的对话（交给它的任务书）、任务书里的目标和约束
    expect(record.detail).toContain("调研 X 的现状");
    expect(record.detail).toContain("只看公开资料");
    // 写进任务自己的产出区
    const file = path.join(td.daemon.layout.outputs, task.id, "scope-records.md");
    await waitUntil(() => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("起草计划时就去翻了别的项目的文件"), { describe: () => "等范围记录写进任务的产出区" });
    expect(fs.readFileSync(file, "utf8")).toContain(`越界 · 压缩会话时：起草计划时就去翻了别的项目的文件`);
    // 越界通知：不推送、不卡任务、未读
    const [notice] = outOfScopeNotices(frontend);
    expect(notice).toMatchObject({ notice: "out_of_scope", urgency: "non_blocking", read: false });
    expect(notice!.kind === "notice" && notice!.data).toMatchObject({ recordId: record.id, maintainerId: "tm-1", taskId: task.id });
    expect(pushedOutOfScope(frontend)).toEqual([]);
    // 时间线上标出；维护者照常回话
    expect(timelineOf(frontend, TM1).map((r) => r.record.kind)).toEqual(["out_of_scope"]);
    await eventually(() => messagesOf(frontend, TM1), (m) => textOf(m) === "好", "维护者重试这一轮");
  }, 120_000);
});

/** 起草计划的工单：交计划、写回进展和摘要、回一句 */
const draftPlan = (): FauxStep[] => [submitPlanStep(onePlan("weekly.md")), writeProgress("周报：计划交上去了。"), summary("起草了周报计划"), say("计划交上去了")];

/** 用户发起一个项目的任务、写好任务书，等起草计划的工单开始 */
async function startWeekly(td: TestDaemon, frontend: TestFrontend) {
  internalTask(td.daemon, "记账本", "给记账本加周报");
  const created = await eventually(() => tasksOf(frontend), (e) => e.change === "created", "任务");
  td.daemon.tasks.writeBrief(created.task.id, brief("记账本"), byMaintainer(td.daemon, created.task.id));
  const started = await eventually(() => workOrdersOf(frontend), (e) => e.change === "started" && workOrderTaskId(e.workOrder) === created.task.id, "起草计划的工单开始");
  return { taskId: created.task.id, wo: started.workOrder };
}

const failureNotes = (frontend: TestFrontend) => messagesOf(frontend, PM1).filter((m) => m.message.speaker === "system" && textOf(m).startsWith("范围审视没做成"));
const unreviewed = (frontend: TestFrontend) => timelineOf(frontend).filter((r) => r.record.kind === "scope_review_missing");

describe("范围审视没做成（18 号票评审后）", () => {
  it("审视模型回了不合约定的结果：工单照常结束，维护者会话里一条说明（给用户看），不记范围记录", async () => {
    const d = dirs();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => (id === "pm-1" && spawn === 1 ? draftPlan() : []),
      scopeReviewer: (id, spawn) => (id === "pm-1" && spawn === 1 ? [say("这段工作都在范围里，没什么要记的。")] : []),
    });
    bookkeeping(td, d.records());
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1]);
    const { wo } = await startWeekly(td, frontend);
    const ended = await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && e.workOrder.id === wo.id, "起草计划的工单结束");
    expect(ended.workOrder).toMatchObject({ outcome: "done" });
    expect(ended.workOrder.unwritten).toBeUndefined();
    const [note] = failureNotes(frontend);
    expect(failureNotes(frontend)).toHaveLength(1);
    expect(textOf(note!)).toContain("审视模型的回复里没有约定的 JSON：这段工作都在范围里，没什么要记的。");
    expect(textOf(note!)).toContain("这段工作这次没有记范围记录");
    // 说明不交给维护者（不是给它的输入），也不记范围记录、不出越界通知
    expect(note!.agentInput).toBeUndefined();
    expect(scopeRecordsOf(frontend)).toEqual([]);
    expect(outOfScopeNotices(frontend)).toEqual([]);
  }, 120_000);

  it("审视超时（守护进程等不到结果）：工单照常结束，会话里一条说明写明超时", async () => {
    const d = dirs();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => (id === "pm-1" && spawn === 1 ? draftPlan() : []),
      // 审视的回复慢慢吐（几十秒），守护进程最多等 2 秒
      scopeReviewer: (id, spawn) => (id === "pm-1" && spawn === 1 ? [say(JSON.stringify({ records: [{ kind: "out_of_scope", summary: `来不及交的越界${"。".repeat(200)}` }] }))] : []),
      scopeReviewerTokensPerSecond: 5,
      scopeReviewTimeoutMs: 2000,
    });
    bookkeeping(td, d.records());
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1]);
    const { wo } = await startWeekly(td, frontend);
    const ended = await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && e.workOrder.id === wo.id, "起草计划的工单结束");
    expect(ended.workOrder).toMatchObject({ outcome: "done" });
    expect(failureNotes(frontend).map(textOf)).toEqual(["范围审视没做成：范围审视超过 2 秒没有结果（这段工作这次没有记范围记录）"]);
    expect(scopeRecordsOf(frontend)).toEqual([]);
  }, 120_000);
});

describe("重置维护者时的范围审视（18 号票评审后）", () => {
  it("工单做到一半重置：这一段不强行审视，时间线上如实记“重置时这段没做范围审视”；工单留在新的一段接着做", async () => {
    const d = dirs();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      // 起草计划时慢慢想（还在说的时候用户重置了维护者）
      maintainer: (id, spawn) => (id === "pm-1" && spawn === 1 ? [say("先想想周报怎么排，".repeat(40))] : []),
      maintainerTokensPerSecond: 20,
    });
    bookkeeping(td, d.records());
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1]);
    const { taskId, wo } = await startWeekly(td, frontend);
    await waitUntil(() => frontend.events({ channel: PM1, type: EVENT_TYPES.turnStart }).length === 1, { describe: () => "等维护者开始起草" });

    ok(await frontend.request(METHODS.resetMaintainer, { projectId: "p-1" }, "k-reset"));
    const [record] = await eventually(() => [unreviewed(frontend)], (list) => list.length > 0, "时间线上的记录");
    expect(unreviewed(frontend)).toHaveLength(1);
    expect(record).toMatchObject({ projectId: "p-1", taskId, record: { summary: "重置时这段没做范围审视", workOrderId: wo.id } });
    expect(record!.record.detail).toContain("会话分段 pm-1-s1");
    // 工单还在做：新的一段（标着重置）接着它
    const reset = segmentsOf(frontend).find((e) => e.change === "opened" && e.segment.reset);
    expect(reset?.segment).toMatchObject({ segmentId: "pm-1-s2", kind: "work_order", workOrderId: wo.id });
    expect(td.daemon.workOrders.get(wo.id)?.state).not.toBe("ended");
    expect(failureNotes(frontend)).toEqual([]);
    expect(scopeRecordsOf(frontend)).toEqual([]);
  }, 120_000);

  it("写回中途重置：工单照常算完成，时间线上另记“重置时这段没做范围审视”（和“重置时这段没写回档案”一起）", async () => {
    const d = dirs();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      // 交了计划不写回；被催时慢慢回一段长话（还在说的时候用户重置了维护者）
      maintainer: (id, spawn) => (id !== "pm-1" ? [] : spawn === 1 ? [submitPlanStep(onePlan("weekly.md")), say("计划交了"), say("这一段先不写回，".repeat(40))] : []),
      maintainerTokensPerSecond: 20,
    });
    bookkeeping(td, d.records());
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1]);
    const { wo } = await startWeekly(td, frontend);
    await eventually(() => messagesOf(frontend, PM1), (m) => m.agentInput === true && textOf(m).includes("还没写回"), "催写回");
    await waitUntil(() => frontend.events({ channel: PM1, type: EVENT_TYPES.turnStart }).length === 2, { describe: () => "等维护者开始回催写回的通知" });

    ok(await frontend.request(METHODS.resetMaintainer, { projectId: "p-1" }, "k-reset"));
    const ended = await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && e.workOrder.id === wo.id, "工单结束");
    expect(ended.workOrder).toMatchObject({ outcome: "done", unwritten: "reset" });
    await eventually(() => [unreviewed(frontend)], (list) => list.length > 0, "时间线上的记录");
    expect(timelineOf(frontend).map((r) => [r.record.kind, r.record.summary, r.record.workOrderId])).toEqual([
      ["write_back_missing", "重置时这段没写回档案", wo.id],
      ["scope_review_missing", "重置时这段没做范围审视", wo.id],
    ]);
    expect(failureNotes(frontend)).toEqual([]);
    expect(scopeRecordsOf(frontend)).toEqual([]);
  }, 120_000);

  it("审视做到一半遇上重置：那次审视的结果回来时这一段已经结束了，不用；时间线上如实记“重置时这段没做范围审视”", async () => {
    const d = dirs();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => (id === "pm-1" && spawn === 1 ? draftPlan() : []),
      // 审视的回复慢慢吐（约十几秒）：工单写回之后、审视还没交上来的时候用户重置了维护者
      scopeReviewer: (id, spawn) => (id === "pm-1" && spawn === 1 ? [say(JSON.stringify({ records: [{ kind: "out_of_scope", summary: `审到一半的越界${"。".repeat(60)}` }] }))] : []),
      scopeReviewerTokensPerSecond: 10,
    });
    bookkeeping(td, d.records());
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1]);
    const { taskId, wo } = await startWeekly(td, frontend);
    // 写回了：这一段收尾中，等审视
    await eventually(() => segmentsOf(frontend), (e) => e.change === "closing" && e.segment.workOrderId === wo.id, "这一段收尾");
    await turnsOf(frontend, PM1, 1);
    expect(td.daemon.workOrders.get(wo.id)?.state).not.toBe("ended");

    ok(await frontend.request(METHODS.resetMaintainer, { projectId: "p-1" }, "k-reset"));
    const ended = await eventually(() => workOrdersOf(frontend), (e) => e.change === "ended" && e.workOrder.id === wo.id, "工单结束");
    expect(ended.workOrder).toMatchObject({ outcome: "done" });
    expect(ended.workOrder.unwritten).toBeUndefined();
    const [record] = await eventually(() => [unreviewed(frontend)], (list) => list.length > 0, "时间线上的记录");
    expect(record).toMatchObject({ taskId, record: { summary: "重置时这段没做范围审视", workOrderId: wo.id } });
    // 那次审视做完了（用量记了账），结果没用上：没有范围记录、越界通知，也没有"没做成"的说明
    await waitUntil(() => td.daemon.ledger.entries({ kind: "task", id: taskId }).some((e) => e.purpose === "scope_review"), { timeoutMs: 60_000, describe: () => "等那次审视做完" });
    expect(scopeRecordsOf(frontend)).toEqual([]);
    expect(outOfScopeNotices(frontend)).toEqual([]);
    expect(failureNotes(frontend)).toEqual([]);
    expect(unreviewed(frontend)).toHaveLength(1);
  }, 120_000);
});

describe("对照物里的审批（18 号票评审后）", () => {
  it("用户在审批卡上批准过的调用进审视的对照物（算授权过）：审视的输入里列着这次调用，范围记录记着这次批准", async () => {
    const d = dirs();
    const records = d.records();
    const glossary = path.join(records, "glossary.md");
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      // 整体重写项目档案里的术语表（覆盖：在对话里先问用户）；之后一大段材料、第三句时上下文溢出、压缩
      maintainer: (id) =>
        id === "pm-1"
          ? [
              call("write", { path: glossary, content: "# 术语表\n\n流水：银行导出的交易记录\n" }),
              say("术语表重写好了"),
              say("收到了一大段"),
              { kind: "context_overflow" },
              say("摘要：重写了术语表，又收到一大段材料"),
              say("好"),
            ]
          : [],
      scopeReviewer: (id) => (id === "pm-1" ? [finding("scope_change", "重写了项目档案里的术语表", "用户在审批卡上批准过这次重写")] : []),
    });
    bookkeeping(td, records);
    const frontend = await connect(td.url, [CARDS, INBOX, PROJECTS, PM1]);
    await frontend.sendText("把术语表重写一下", { conversation: PM1 });
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "approval", "审批卡");
    ok(await frontend.cardAction({ cardId: card.id, action: "approve", expectedVersion: 1 }));
    await turnsOf(frontend, PM1, 1);
    await frontend.sendText(LONG, { conversation: PM1 });
    await turnsOf(frontend, PM1, 2);
    await frontend.sendText("第三句", { conversation: PM1 });

    const change = await eventually(() => scopeRecordsOf(frontend), (r) => r.kind === "scope_change", "范围变更", 60_000);
    const { approvalId, toolTitle, argsSummary } = card.payload as ApprovalCardPayload;
    const input = change.detail!;
    const section = input.slice(input.indexOf("【用户在审批卡上批准过的调用】"), input.indexOf("【用户在会话里直接说的话】"));
    expect(section).toContain("批准过的算授权过");
    expect(section).toContain(`${toolTitle}：${argsSummary}`);
    // 范围记录记着这次审视看到的批准：彻底删除这次批准（审批决定）时，这条记录里的文字一起换成删除标记
    expect(scopeRecordEvents(frontend).find((p) => p.record.id === change.id)!.sources.approvalIds).toEqual([approvalId]);
    await waitUntil(() => td.daemon.materials.list().some((m) => m.kind === "approval_decision" && m.ref.recordId === approvalId), { describe: () => "等审批决定成为素材" });
    const decision = td.daemon.materials.list().find((m) => m.kind === "approval_decision" && m.ref.recordId === approvalId)!;
    expect((await materialsApi.delete(td.url, { scope: { kind: "time_range", from: decision.time, to: decision.time }, mode: "purge", idempotencyKey: "purge-approval" })).body).toEqual({ count: 1 });
    const purged = await eventually(() => scopeRecordsOf(frontend), (r) => r.id === change.id && r.summary === PURGED_TEXT, "改写后的范围记录");
    expect(purged).toMatchObject({ kind: "scope_change", detail: PURGED_TEXT, basis: PURGED_TEXT, trigger: "compaction" });
  }, 180_000);
});

describe("彻底删除范围记录里的原话（18 号票评审后）", () => {
  it("彻底删除一条被范围记录引用的用户消息：范围记录（追加一条改写后的）、时间线、越界通知、项目档案的范围记录、维护者的会话文件（含审视结果的副本）里都不再有原话", async () => {
    const d = dirs();
    const records = d.records();
    const SECRET = "顺便把分类表导出成 CSV，暗号是青蛙";
    const twoFindings: FauxStep = {
      kind: "reply_with_context",
      text: JSON.stringify({
        records: [
          { kind: "scope_change", summary: "按用户说的导出了分类表", detail: "@@", basis: `用户说：${SECRET}` },
          { kind: "out_of_scope", summary: "顺手翻了账本数据", detail: "@@" },
        ],
      }).replaceAll('"@@"', '"审视的输入：{{context}}"'),
    };
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id) => (id === "pm-1" ? [say("好"), say("收到了一大段"), { kind: "context_overflow" }, say("摘要：用户交代了一件事，又发过一大段材料"), say("好，导出了")] : []),
      scopeReviewer: (id) => (id === "pm-1" ? [twoFindings] : []),
    });
    bookkeeping(td, records);
    const frontend = await connect(td.url, [INBOX, PROJECTS, PM1]);
    const secret = await frontend.sendText(SECRET, { conversation: PM1 });
    await turnsOf(frontend, PM1, 1);
    await frontend.sendText(LONG, { conversation: PM1 });
    await turnsOf(frontend, PM1, 2);
    await frontend.sendText("第三句", { conversation: PM1 });
    await eventually(() => scopeRecordsOf(frontend), (r) => r.kind === "out_of_scope", "范围记录", 60_000);
    await eventually(() => messagesOf(frontend, PM1), (m) => textOf(m) === "好，导出了", "维护者重试这一轮");
    const file = path.join(records, "scope-records.md");
    // 删除之前：原话在范围记录（依据、审视的输入）、时间线、项目档案、会话文件的副本里；记录记着审视看到了这条消息
    const before = scopeRecordEvents(frontend);
    expect(before).toHaveLength(2);
    for (const p of before) expect(p.sources.messageIds).toContain(secret.messageId);
    expect(before.find((p) => p.record.kind === "scope_change")!.record.basis).toBe(`用户说：${SECRET}`);
    await waitUntil(() => fs.readFileSync(file, "utf8").includes("暗号是青蛙"), { describe: () => "等范围记录写进项目档案" });
    expect(timelineOf(frontend).some((r) => r.record.detail?.includes("暗号是青蛙"))).toBe(true);
    expect(sessionText(d.dataDir)).toContain("暗号是青蛙");
    const [notice] = outOfScopeNotices(frontend);

    // 在设置里彻底删除这条消息
    await waitUntil(() => td.daemon.materials.list().some((m) => m.ref.messageId === secret.messageId), { describe: () => "等这条消息成为素材" });
    const material = td.daemon.materials.list().find((m) => m.ref.messageId === secret.messageId)!;
    expect((await materialsApi.delete(td.url, { scope: { kind: "time_range", from: material.time, to: material.time }, mode: "purge", idempotencyKey: "purge-secret" })).body).toEqual({ count: 1 });

    // 范围记录：各追加一条改写后的（同一个 id），摘要、说明、依据换成删除标记；种类、哪次审视、归属不变
    await waitUntil(() => scopeRecordEvents(frontend).length === 4, { describe: () => "等改写后的范围记录" });
    const latest = [...new Map(scopeRecordsOf(frontend).map((r) => [r.id, r])).values()];
    expect(latest.map((r) => r.id)).toEqual(before.map((p) => p.record.id));
    for (const r of latest) expect(r).toMatchObject({ summary: PURGED_TEXT, detail: PURGED_TEXT, trigger: "compaction", maintainerId: "pm-1", projectId: "p-1" });
    expect(latest.find((r) => r.kind === "scope_change")).toMatchObject({ basis: PURGED_TEXT });
    // 事件日志里一个字不剩：那条消息、范围记录（原来的和新版本）、时间线记录、越界通知
    expect(JSON.stringify(td.daemon.store.readGlobal(0, 100_000))).not.toContain("暗号是青蛙");
    const timeline = td.daemon.store.read(PM1, 0, EVENT_TYPES.timelineRecord).map((e) => (e.payload as TimelineRecordEventPayload).record);
    expect(timeline.filter((r) => r.kind === "scope_change" || r.kind === "out_of_scope").map((r) => [r.kind, r.summary, r.detail])).toEqual([
      ["scope_change", PURGED_TEXT, PURGED_TEXT],
      ["out_of_scope", PURGED_TEXT, PURGED_TEXT],
    ]);
    // 越界通知：标题、正文换成删除标记，状态不变（照常未读）
    expect(td.daemon.inbox.get(notice!.id)).toMatchObject({ title: PURGED_TEXT, body: PURGED_TEXT, read: false, notice: "out_of_scope" });
    // 项目档案的范围记录：那两条换成改写后的（记录号不变），不再有原话
    await waitUntil(() => !fs.readFileSync(file, "utf8").includes("暗号是青蛙"), { describe: () => "等项目档案里的范围记录换掉" });
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain(`范围变更 · 压缩会话时：${PURGED_TEXT}（依据：${PURGED_TEXT}） <!-- ${latest[0]!.id} -->`);
    expect(text).toContain(`越界 · 压缩会话时：${PURGED_TEXT} <!-- ${latest[1]!.id} -->`);
    expect(text.split("<!-- sr-")).toHaveLength(3);
    // 维护者的会话文件：用户的那条输入、审视结果的副本（appendEntry）都改写了
    await waitUntil(() => !sessionText(d.dataDir).includes("暗号是青蛙"), { describe: () => "等维护者的会话文件改写" });
    expect(td.daemon.materials.get(material.id)).toBeUndefined();
    // 重新连上的页面拿到的也只有改写后的
    const fresh = await connect(td.url, [INBOX, PROJECTS, PM1]);
    await waitUntil(() => fresh.cursors[PM1] === td.daemon.store.lastSeq(PM1) && fresh.cursors[PROJECTS] === td.daemon.store.lastSeq(PROJECTS));
    expect(JSON.stringify(fresh.events())).not.toContain("暗号是青蛙");
  }, 180_000);
});
