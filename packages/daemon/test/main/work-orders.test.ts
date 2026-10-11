// 主切面：工单与派单、单项目任务（规格第 11、12 节，16 号票）。真的守护进程，秘书、项目维护者、评审子 agent 都接 faux 剧本，
// 测试扮演前端。
// - 只涉及一个项目的任务（点"发起任务"时选的、秘书建卡或写任务书时写的）由这个项目的维护者起草计划并执行（不新建任务自己的
//   维护者）；执行时的工具包是计划的和项目的交集（计划里的授权项放不开项目工具包没有的能力）；起草计划的工单段只读；
// - 工单按"待接 → 进行中 ⇄ 等澄清 → 已结束"迁移，派单器把工单放进收件维护者的队列，一次只做一件、先来先做，
//   项目正忙时后到的任务留在排队中（看板上"等项目 X"），前一张工单结束后自动开始；
// - 维护者会话分段：每张工单一段新的 pi 会话，开头是固定上下文；没有工单时用户直接说话开一个对话段；
//   一段结束时没写回项目档案（进展的内容哈希没变）或没写摘要，运行时催它，这段不算完成；催到了次数转为用户拍板（卡住求助）；
// - 重置维护者（写回中途重置的工单照常算完成，如实标出）；等澄清由派单方（用户）回答，关掉提问卡就按维护者自己的理解接着做；
// - 发给已归档项目的工单直接退回；还有工单没结束的项目不能归档；
// - 项目的首个建设任务由项目维护者自己走完，项目自动进入使用中。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItem,
  type InboxItemEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  METHODS,
  type Plan,
  type PlanCardPayload,
  type Project,
  type ProjectEventPayload,
  type ResponseFrame,
  type SegmentEventPayload,
  type TaskEventPayload,
  type TimelineRecordEventPayload,
  type WorkOrderEventPayload,
  workOrderTaskId,
  workOrderStatusText,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { projectTask, seedProject } from "../helpers/projects.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const PM1 = maintainerChannel("pm-1");

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const completeStage = (stageId: string, summary = `阶段 ${stageId} 做完了`) => call("complete_stage", { stageId, summary });
const summary = (text: string) => call("write_segment_summary", { summary: text });
/** 起草计划的工单段里写回进展（这一段只读，16 号票评审后） */
const writeProgress = (content: string) => call("write_progress", { content });

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
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
const workOrderWhere = (frontend: TestFrontend, match: (e: WorkOrderEventPayload) => boolean, what = "工单", timeoutMs?: number) => eventually(() => workOrdersOf(frontend), match, what, timeoutMs);
const segmentsOf = (frontend: TestFrontend, channel = PM1) => frontend.events({ channel, type: EVENT_TYPES.segment }).map((f) => f.payload as SegmentEventPayload);
const segmentWhere = (frontend: TestFrontend, match: (e: SegmentEventPayload) => boolean, what = "会话分段") => eventually(() => segmentsOf(frontend), match, what);
/** 等某个维护者处理完 n 条输入 */
const turnsOf = (frontend: TestFrontend, channel: string, n: number) =>
  waitUntil(() => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 30_000, describe: () => `等 ${channel} 处理完 ${n} 条输入` });

/** 先定下数据目录和主目录（剧本里要写项目档案的路径），再起守护进程 */
function dirs() {
  const dataDir = makeTempDir("ergou-data-");
  return { dataDir, homeDir: makeTempDir("ergou-home-"), records: (projectId = "p-1") => path.join(fs.realpathSync.native(dataDir), "projects", projectId) };
}

/** 进展文档的一句改成另一句（维护者写回项目档案） */
const progressEdit = (records: string, oldText: string, newText: string) => call("edit", { path: path.join(records, "progress.md"), edits: [{ oldText, newText }] });
/** 进展文档一开始的那句（项目档案的最小文档集） */
const PROGRESS_INTRO = "做到哪了、下一步做什么：每段工作结束时写回。";

/** 一个已在使用中的项目（立项书已确认，工具包按给的） */
function inUseProject(td: TestDaemon, name: string, toolkit: Partial<NonNullable<Project["toolkit"]>> = {}, overrides: Partial<Project> = {}): Project {
  return seedProject(td.daemon, name, { state: "in_use", charterConfirmed: true, kind: "dev", toolkit: { skills: [], mcp: [], bash: false, network: false, ...toolkit }, ...overrides });
}

/** 只有一个阶段：在工作目录里写出 file，脚本验收它存在 */
function onePlan(file: string, overrides: Partial<Plan> = {}): Plan {
  const base = samplePlan();
  return {
    ...base,
    stages: [
      {
        stageId: "s1",
        title: "写出来",
        deliverables: [file],
        acceptance: [{ criterion: `${file} 存在`, method: "script", script: `test -f ${file}` }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 100_000, toolCalls: 30 },
      },
    ],
    stageGroups: [],
    stops: { count: 0, where: [] },
    toolkit: { skills: [], mcp: [], bash: false, network: false },
    ...overrides,
  };
}

const brief = (project: string) => ({ goal: "每周出一份周报", acceptanceCriteria: ["有周报文件"], constraints: [], projects: [project], memoryScope: "" });

async function connect(url: string, channels: string[] = [BOARD, CARDS, INBOX, PROJECTS, PM1]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

/** 用户点"发起任务"、选一个项目；秘书写好任务书（秘书那一段在 tasks.test.ts 测过，这里直接写） */
async function startProjectTask(td: TestDaemon, frontend: TestFrontend, title: string, project: string): Promise<string> {
  // 64 号票起只涉及一个项目的任务都是这个项目的内部任务：项目的维护者建、写任务书（派起草计划的工单）
  const task = projectTask(td.daemon, project, title, brief(project));
  await taskWhere(frontend, (e) => e.change === "created" && e.task.id === task.id, `任务「${title}」`);
  return task.id;
}

/** 某个任务的计划卡 */
const planCardOf = (frontend: TestFrontend, taskId: string) => cardWhere(frontend, (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === taskId, `${taskId} 的计划卡`);

describe("单项目任务", () => {
  it("只涉及一个项目的任务由这个项目的维护者起草计划并执行，不新建任务自己的维护者；起草计划这一段只读：写工作目录、改项目档案都用不了，进展经 write_progress 写回；执行时的工具包是计划的和项目的交集：项目工具包里没有 bash，计划里开了也没有", async () => {
    const d = dirs();
    const records = d.records();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        if (spawn === 1)
          return [
            // 起草计划这一段只读：先想动手写工作目录、直接改进展文档（都用不了）
            call("write", { path: "weekly.md", content: "起草时就动手" }),
            progressEdit(records, PROGRESS_INTRO, "起草时直接改进展"),
            // 交计划（计划里开了 bash），用 write_progress 写回进展、写摘要
            submitPlanStep(onePlan("weekly.md", { toolkit: { skills: [], mcp: [], bash: true, network: false } })),
            writeProgress("周报：计划交上去了，等确认。"),
            summary("起草了周报计划（一个阶段，写 weekly.md）"),
            say("计划交上去了"),
          ];
        return [
          // 执行这一段：写交付件、宣布完成，写回进展、写摘要，最后看一眼能用哪些工具
          call("write", { path: "weekly.md", content: "# 周报\n" }),
          completeStage("s1", "weekly.md 写好了"),
          progressEdit(records, "周报：计划交上去了，等确认。", "周报：做完了，在 weekly.md。"),
          summary("周报做完了"),
          { kind: "echo_context" },
        ];
      },
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url);
    const taskId = await startProjectTask(td, frontend, "给记账本加周报", "记账本");
    // 执行的维护者就是项目的维护者
    expect(td.daemon.tasks.get(taskId)).toMatchObject({ maintainerId: "pm-1", projects: ["记账本"], projectIds: ["p-1"] });

    // 起草计划：工单派给项目的维护者，计划卡由它交出
    const card = await planCardOf(frontend, taskId);
    await workOrderWhere(frontend, (e) => e.change === "ended" && e.workOrder.kind === "plan", "起草计划的工单结束");
    // 起草计划这一段：写工作目录、改项目档案的工具都没有，什么也没动；进展经 write_progress 整份写回，旧版本（没被改过的）留进了历史区
    const drafting = messagesOf(frontend, PM1).flatMap((m) => m.message.parts.filter((p) => p.type === "tool_call"));
    expect(drafting.filter((p) => (p.tool === "write" || p.tool === "edit") && p.outcome === "done")).toEqual([]);
    expect(fs.existsSync(path.join(records, "workdir", "weekly.md"))).toBe(false);
    expect(fs.readFileSync(path.join(records, "progress.md"), "utf8")).toBe("周报：计划交上去了，等确认。\n");
    const [slot] = fs.readdirSync(path.join(records, ".history"));
    const before = fs.readFileSync(path.join(records, ".history", slot!, "progress.md"), "utf8");
    expect(before).toContain(PROGRESS_INTRO);
    expect(before).not.toContain("起草时直接改进展");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));

    // 执行：同一个项目维护者，在项目的工作目录里；全部验收后完成
    await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "completed", "任务完成", 60_000);
    expect(fs.readFileSync(path.join(records, "workdir", "weekly.md"), "utf8")).toBe("# 周报\n");
    await workOrderWhere(frontend, (e) => e.change === "ended" && e.workOrder.kind === "execute", "执行的工单结束");

    // 不新建任务自己的维护者：会话区只有秘书和项目的维护者
    expect(fs.readdirSync(path.join(d.dataDir, "sessions")).toSorted()).toEqual(["pm-1", "secretary"]);
    // 维护者会话里的消息都带着所属的项目，干这个任务时也带着任务
    const inTask = messagesOf(frontend, PM1).filter((m) => m.taskId === taskId);
    expect(inTask.length).toBeGreaterThan(0);
    expect(messagesOf(frontend, PM1).every((m) => m.projectId === "p-1")).toBe(true);
    // 执行权限是交集：计划开了 bash，项目的工具包没有，会话里就没有 bash（也没有带类型的 bash 工具）
    const seen = textOf(messagesOf(frontend, PM1).find((m) => m.message.speaker === "agent" && textOf(m).includes("[tool] "))!);
    const tools = seen.split("\n").filter((l) => l.startsWith("[tool] "));
    expect(tools).toContain("[tool] complete_stage");
    expect(tools).not.toContain("[tool] bash");
    expect(tools).not.toContain("[tool] git_status_diff");
    // 执行的工单段带重注入块，边界里写的是交集之后的工具包
    expect(seen).toContain("【运行时注入】");
    expect(seen).toContain("工具包：bash 关，联网关");
  }, 120_000);
});

/** 这条消息之后的消息（按先后） */
const after = (list: readonly MessageEventPayload[], match: (m: MessageEventPayload) => boolean) => list.slice(list.findIndex(match) + 1);
/** 会话区里这个维护者的会话文件 */
const sessionFiles = (dataDir: string, maintainerId = "pm-1") => fs.readdirSync(path.join(dataDir, "sessions", maintainerId)).filter((f) => f.endsWith(".jsonl")).toSorted();

describe("维护者会话分段", () => {
  it("没有工单时用户直接说话开一个对话段；工单来了，对话段先收尾：没写回项目档案就催，写回之后才结束、工单才开始；工单段是新的会话文件，固定上下文里有工具包、项目规范、项目档案快照、上一段的摘要和这次的工单，更早分段的对话不在；用户这时说的话进当前段；计划交了但没写回，工单不结束", async () => {
    const d = dirs();
    const records = d.records();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        if (spawn === 1)
          return [
            // 对话段：用户说周报用表格
            say("好的，周报用表格"),
            // 工单来了、被催写回：先只写摘要（进展没变，还会再催一次），再写进展
            summary("聊了周报的格式：用表格"),
            say("摘要写了"),
            progressEdit(records, PROGRESS_INTRO, "周报格式定了：用表格。"),
            say("进展也写了"),
          ];
        return [
          // 工单段一开始：看一眼固定上下文
          { kind: "echo_context" },
          // 用户插话之后：交计划，没写回就收工
          submitPlanStep(onePlan("weekly.md")),
          say("计划交了"),
          // 被催了：写回进展（起草计划这一段只读，用 write_progress）、写摘要
          writeProgress("周报：计划交了，等确认。"),
          summary("起草了周报的计划"),
          say("写回了"),
        ];
      },
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url);

    // 没有工单：用户直接说话开一个对话段（分隔线在这句话之前），这段的消息只带项目
    await frontend.sendText("你好，周报的格式用表格吧", { conversation: PM1 });
    const chat = await segmentWhere(frontend, (e) => e.change === "opened", "对话段");
    // 第一段对话段：还没有这个会话时接着这个维护者以前的会话（这里没有，用这一段的名字新开）
    expect(chat.segment).toMatchObject({ segmentId: "pm-1-s1", kind: "chat", session: "pm-1-s1", continueEarlier: true, reset: false });
    await turnsOf(frontend, PM1, 1);
    const userSaid = messagesOf(frontend, PM1).find((m) => m.message.speaker === "user")!;
    expect(userSaid).toMatchObject({ projectId: "p-1" });
    expect(userSaid.taskId).toBeUndefined();
    const before = messagesOf(frontend, PM1).slice(0, messagesOf(frontend, PM1).indexOf(userSaid));
    expect(before.at(-1)!.message.parts).toEqual([{ type: "work_order_divider", workOrderId: "", title: "你直接对话", from: "你" }]);

    // 工单来了：对话段先收尾——没写回就催，写回之前工单不开始
    const taskId = await startProjectTask(td, frontend, "给记账本加周报", "记账本");
    await segmentWhere(frontend, (e) => e.segment.segmentId === "pm-1-s1" && e.change === "closing", "对话段收尾");
    await segmentWhere(frontend, (e) => e.segment.segmentId === "pm-1-s1" && e.change === "closed", "对话段结束");
    const nudges = messagesOf(frontend, PM1).filter((m) => m.agentInput && textOf(m).includes("还没写回"));
    expect(nudges.length).toBe(2);
    expect(textOf(nudges[0]!)).toContain("进展 progress.md 的内容没变；还没用 write_segment_summary 写这一段的摘要");
    expect(textOf(nudges[1]!)).toContain("进展 progress.md 的内容没变");
    expect(textOf(nudges[1]!)).not.toContain("还没用 write_segment_summary");
    const opened = await workOrderWhere(frontend, (e) => e.change === "started" && workOrderTaskId(e.workOrder) === taskId, "起草计划的工单开始");
    const closedAt = segmentsOf(frontend).findIndex((e) => e.segment.segmentId === "pm-1-s1" && e.change === "closed");
    const woSegmentAt = segmentsOf(frontend).findIndex((e) => e.segment.workOrderId === opened.workOrder.id && e.change === "opened");
    expect(closedAt).toBeLessThan(woSegmentAt);

    // 工单段：新的会话文件，固定上下文
    const woSegment = segmentsOf(frontend)[woSegmentAt]!.segment;
    expect(woSegment).toMatchObject({ segmentId: "pm-1-s2", kind: "work_order", taskId, session: "pm-1-s2" });
    expect(woSegment.continueEarlier).toBeUndefined();
    await waitUntil(() => messagesOf(frontend, PM1).some((m) => m.message.speaker === "agent" && textOf(m).includes("【固定上下文】")));
    const context = textOf(messagesOf(frontend, PM1).find((m) => m.message.speaker === "agent" && textOf(m).includes("【固定上下文】"))!);
    expect(context).toContain("【固定上下文】这是会话分段 pm-1-s2 开始时运行时给你的");
    // 起草计划的工单段同任务自己的维护者起草时：70 号票起联网开着
    expect(context).toContain("工具包：bash 关，联网开");
    expect(context).toContain("项目规范（第一阶段，内置的简短说明）");
    expect(context).toContain("### 进展（progress.md）");
    expect(context).toContain("周报格式定了：用表格。");
    expect(context).toContain("上一段的摘要（pm-1-s1，对话段）：\n聊了周报的格式：用表格");
    expect(context).toContain(`这次的工单：${opened.workOrder.id}「起草计划：给记账本加周报」，来自你，所属任务 ${taskId}「给记账本加周报」`);
    expect(context).toContain("目标：每周出一份周报");
    expect(context).toContain("这一段只起草计划：工作目录和项目档案只读");
    expect(context).toContain("这一段能用的工具：read、ls、grep、find、submit_plan、write_progress、ask_clarification、write_segment_summary、web_search、web_fetch、spoken_summary、send_voice。");
    // 更早分段的对话不在这段的上下文里
    expect(context).not.toContain("你好，周报的格式用表格吧");
    expect(sessionFiles(d.dataDir)).toEqual(["pm-1-s1.jsonl", "pm-1-s2.jsonl"]);

    // 用户这时说的话进当前段（属于这张工单的任务），不另开段
    await turnsOf(frontend, PM1, 4);
    await frontend.sendText("接着起草吧", { conversation: PM1 });
    await planCardOf(frontend, taskId);
    const interject = messagesOf(frontend, PM1).find((m) => m.message.speaker === "user" && textOf(m) === "接着起草吧")!;
    expect(interject).toMatchObject({ projectId: "p-1", taskId });
    expect(segmentsOf(frontend).filter((e) => e.change === "opened")).toHaveLength(2);

    // 计划交了但没写回：催，工单不结束；写回之后才结束
    await workOrderWhere(frontend, (e) => e.change === "ended" && e.workOrder.id === opened.workOrder.id, "起草计划的工单结束");
    const woNudge = messagesOf(frontend, PM1).filter((m) => m.agentInput && m.taskId === taskId && textOf(m).includes("还没写回"));
    expect(woNudge).toHaveLength(1);
    expect(textOf(woNudge[0]!)).toContain(`工单 ${opened.workOrder.id} 这一段要结束了`);
    expect(textOf(woNudge[0]!)).toContain("用 write_progress 写回进展 progress.md");
    const closed = segmentsOf(frontend).find((e) => e.segment.segmentId === "pm-1-s2" && e.change === "closed")!;
    expect(closed.segment).toMatchObject({ summary: "起草了周报的计划", outcome: "done" });
    // 写回之后的那条回复在收尾的催促之后
    expect(after(messagesOf(frontend, PM1), (m) => m === woNudge[0]).some((m) => textOf(m) === "写回了")).toBe(true);
  }, 120_000);

  it("对话段在维护者闲置退出时收尾：催它写回，写回之后才结束；下一次用户说话开新的一段，固定上下文里的上一段摘要就是它写的", async () => {
    const d = dirs();
    const records = d.records();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      config: { agents: { idleMinutes: 0.02 } },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        if (spawn === 1) return [say("好的，记下了")];
        // 闲置退出后被催写回：重新唤起（接着这一段的会话文件）写回
        if (spawn === 2) return [progressEdit(records, PROGRESS_INTRO, "用户想把账单按月归档。"), summary("聊了账单按月归档"), say("写回了")];
        return [{ kind: "echo_context" }];
      },
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url);
    await frontend.sendText("账单想按月归档", { conversation: PM1 });
    // 闲置退出 → 收尾、催写回 → 写回之后这段结束
    await segmentWhere(frontend, (e) => e.segment.segmentId === "pm-1-s1" && e.change === "closing", "对话段收尾");
    const closed = await segmentWhere(frontend, (e) => e.segment.segmentId === "pm-1-s1" && e.change === "closed", "对话段结束");
    expect(closed.segment).toMatchObject({ kind: "chat", summary: "聊了账单按月归档" });
    expect(messagesOf(frontend, PM1).filter((m) => m.agentInput && textOf(m).includes("这一段对话要结束了"))).toHaveLength(1);
    expect(sessionFiles(d.dataDir)).toEqual(["pm-1-s1.jsonl"]);

    await frontend.sendText("还记得我们聊了什么吗", { conversation: PM1 });
    const next = await segmentWhere(frontend, (e) => e.change === "opened" && e.segment.segmentId === "pm-1-s2", "新的对话段");
    expect(next.segment).toMatchObject({ kind: "chat", session: "pm-1-s2", reset: false });
    expect(next.segment.continueEarlier).toBeUndefined();
    await waitUntil(() => messagesOf(frontend, PM1).some((m) => textOf(m).includes("【固定上下文】这是会话分段 pm-1-s2")));
    const context = textOf(messagesOf(frontend, PM1).find((m) => textOf(m).includes("【固定上下文】这是会话分段 pm-1-s2"))!);
    expect(context).toContain("上一段的摘要（pm-1-s1，对话段）：\n聊了账单按月归档");
    expect(context).toContain("这一段是对话段：没有工单");
    expect(context).toContain("用户想把账单按月归档。");
    // 更早一段的对话不在：上下文里只有这一段的那一条用户消息
    expect(context).not.toContain("账单想按月归档");
    expect(context.split("\n").filter((l) => l.startsWith("[user]"))).toHaveLength(1);
    expect(context).toContain("还记得我们聊了什么吗");
  }, 120_000);

  it("用户在项目页上重置维护者（单独的请求，不是项目动作）：新开一段会话，上下文只来自项目档案（没有上一段的摘要）；旧会话文件原样保留，会话里的旧消息照样在", async () => {
    const d = dirs();
    const records = d.records();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        if (spawn === 1) return [progressEdit(records, PROGRESS_INTRO, "用户想要周报。"), summary("聊了周报"), say("记下了")];
        return [{ kind: "echo_context" }];
      },
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url);
    await frontend.sendText("我想要周报", { conversation: PM1 });
    await turnsOf(frontend, PM1, 1);
    const firstFile = path.join(d.dataDir, "sessions", "pm-1", "pm-1-s1.jsonl");
    await waitUntil(() => fs.existsSync(firstFile));
    const oldSession = fs.readFileSync(firstFile, "utf8");

    // 重置：当前这段直接结束，新开一段（标着重置）；已经写回的项目档案留着
    expect(ok(await frontend.request(METHODS.resetMaintainer, { projectId: "p-1" }, "k-reset"))).toEqual({ projectId: "p-1", segmentId: "pm-1-s2" });
    // 同一个幂等键重发不再重置一次
    expect(ok(await frontend.request(METHODS.resetMaintainer, { projectId: "p-1" }, "k-reset"))).toEqual({ projectId: "p-1", segmentId: "pm-1-s2" });
    const reset = await segmentWhere(frontend, (e) => e.change === "opened" && e.segment.reset, "重置开的一段");
    expect(reset.segment).toMatchObject({ segmentId: "pm-1-s2", kind: "chat", session: "pm-1-s2" });
    // 这一段写回了才重置的：不标"没写回"
    expect(segmentsOf(frontend).find((e) => e.segment.segmentId === "pm-1-s1" && e.change === "closed")!.segment.unwritten).toBeUndefined();
    expect(segmentsOf(frontend).find((e) => e.segment.segmentId === "pm-1-s1" && e.change === "closed")).toBeDefined();
    expect(segmentsOf(frontend).filter((e) => e.change === "opened")).toHaveLength(2);
    const divider = messagesOf(frontend, PM1).findLast((m) => m.message.parts.some((p) => p.type === "work_order_divider"))!;
    expect(divider.message.parts[0]).toMatchObject({ title: "重置维护者：新开一段会话，只凭项目档案重建理解" });

    await frontend.sendText("你还记得什么？", { conversation: PM1 });
    await turnsOf(frontend, PM1, 2);
    const context = textOf(messagesOf(frontend, PM1).findLast((m) => m.message.speaker === "agent")!);
    expect(context).toContain("【固定上下文】这是会话分段 pm-1-s2 开始时运行时给你的");
    expect(context).toContain("上一段的摘要：没有。用户重置了维护者：只凭项目档案重建理解。");
    expect(context).not.toContain("聊了周报");
    expect(context).toContain("用户想要周报。");
    expect(context).not.toContain("我想要周报");
    // 旧会话文件原样保留，前端照样看得到旧消息
    expect(sessionFiles(d.dataDir)).toEqual(["pm-1-s1.jsonl", "pm-1-s2.jsonl"]);
    expect(fs.readFileSync(firstFile, "utf8")).toBe(oldSession);
    expect(messagesOf(frontend, PM1).some((m) => textOf(m) === "我想要周报")).toBe(true);
    // 已归档的项目不能重置
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "archive" }, "k-archive"));
    expect(await frontend.request(METHODS.resetMaintainer, { projectId: "p-1" }, "k-reset-2")).toMatchObject({ ok: false, error: { code: "not_allowed" } });
  }, 120_000);
});

const askOne = (question: string, recommended: string, other: string) => call("ask_clarification", { intro: "有一点要你拍板", questions: [{ question, options: [recommended, other], recommended }] });
const inboxOf = (frontend: TestFrontend): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);

describe("等澄清", () => {
  it("用户发起的单项目任务执行中维护者提问：工单转等澄清，提问卡进待我处理，没有别的能推进的阶段时任务转等我（原因“澄清”）；用户回答后回答交回维护者，工单回到进行中、任务回到执行中；回答照常是“澄清问题的回答”素材", async () => {
    const d = dirs();
    const records = d.records();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        if (spawn === 1) return [submitPlanStep(onePlan("weekly.md")), writeProgress("周报：计划交了。"), summary("起草了周报的计划"), say("交了")];
        return [
          askOne("周报从周一还是周日算起？", "周一", "周日"),
          say("等你回答"),
          // 回答来了
          call("write", { path: "weekly.md", content: "# 周报（周一起）\n" }),
          completeStage("s1"),
          progressEdit(records, "周报：计划交了。", "周报做完了，周一起算。"),
          summary("周报做完了"),
          say("做完了"),
        ];
      },
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url);
    const taskId = await startProjectTask(td, frontend, "给记账本加周报", "记账本");
    const plan = await planCardOf(frontend, taskId);
    ok(await frontend.cardAction({ cardId: plan.id, action: "confirm", expectedVersion: 1, input: {} }));

    // 工单转等澄清，提问卡进待我处理（挡着任务）
    const clarifying = await workOrderWhere(frontend, (e) => e.change === "clarifying", "工单转等澄清");
    expect(clarifying).toMatchObject({ from: "in_progress", by: "maintainer", workOrder: { kind: "execute", taskId, state: "clarifying" } });
    const card = await cardWhere(frontend, (c) => c.type === "questions", "提问卡");
    expect(card.payload).toMatchObject({ taskId, askedBy: { maintainerId: "pm-1", projectId: "p-1", workOrderId: clarifying.workOrder.id } });
    expect(clarifying.workOrder.questionsCardId).toBe(card.id);
    const item = await eventually(() => inboxOf(frontend), (i) => i.kind === "card" && i.cardId === card.id, "待我处理里的提问卡");
    expect(item).toMatchObject({ urgency: "blocking", internal: { projectId: "p-1", projectName: "记账本" }, source: "项目「记账本」内部 · 任务「给记账本加周报」" });
    // 没有别的能推进的阶段：任务转等我，原因"澄清"
    const waiting = await taskWhere(frontend, (e) => e.task.id === taskId && e.task.state === "waiting_for_user", "任务转等我");
    expect(waiting.task.stages?.list?.[0]).toMatchObject({ state: "waiting", waitReason: "clarification", waitingOn: card.id });

    // 用户回答：回答交回维护者（属于这个任务和项目），工单回到进行中，任务回到执行中
    ok(await frontend.cardAction({ cardId: card.id, action: "answer", expectedVersion: 1, input: { answers: [{ questionId: "q1", answer: "周一" }] } }));
    const answered = await workOrderWhere(frontend, (e) => e.change === "answered", "工单回到进行中");
    expect(answered).toMatchObject({ from: "clarifying", by: "user", workOrder: { state: "in_progress" } });
    expect(answered.workOrder.questionsCardId).toBeUndefined();
    await taskWhere(frontend, (e) => e.task.id === taskId && e.task.state === "running" && e.from === "waiting_for_user", "任务回到执行中");
    const notice = await eventually(() => messagesOf(frontend, PM1), (m) => m.agentInput === true && textOf(m).includes("周一"), "回答交回维护者");
    expect(notice).toMatchObject({ projectId: "p-1", taskId });
    expect(textOf(notice)).toContain(`你在工单 ${clarifying.workOrder.id} 里的提问`);
    await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "completed", "任务完成", 60_000);
    expect(fs.readFileSync(path.join(records, "workdir", "weekly.md"), "utf8")).toBe("# 周报（周一起）\n");

    // 回答照常产生"澄清问题的回答"素材：属于这个任务和项目
    await waitUntil(() => td.daemon.materials.list({ kind: "clarification_answer" }).length > 0);
    expect(td.daemon.materials.list({ kind: "clarification_answer" })).toEqual([expect.objectContaining({ task: taskId, project: "p-1" })]);
    // 秘书没收到这张卡的回答
    expect(td.daemon.store.read(CHANNELS.secretary).some((e) => JSON.stringify(e.payload).includes("周报从周一还是周日算起"))).toBe(false);
  }, 120_000);
});

describe("已归档、已停用的项目", () => {
  it("项目还有正在做或排队的工单时不能归档：归档被拒，写明先完成或取消哪几个任务", async () => {
    const td = await startTestDaemon({
      secretary: [say("好的"), say("好的")],
      // 记账本的维护者：起草第一个任务的计划时先问一句（工单等澄清，项目一直忙着）
      maintainer: (id, spawn) => (id === "pm-1" && spawn === 1 ? [askOne("周报要不要带图表？", "要", "不要"), say("等你回答")] : []),
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url);
    const busy = await startProjectTask(td, frontend, "给记账本加周报", "记账本");
    await workOrderWhere(frontend, (e) => e.change === "clarifying" && workOrderTaskId(e.workOrder) === busy, "第一张工单等澄清");
    const queuedTask = await startProjectTask(td, frontend, "给记账本加月报", "记账本");
    await workOrderWhere(frontend, (e) => e.change === "created" && workOrderTaskId(e.workOrder) === queuedTask, "第二张工单排着");
    expect(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "archive" }, "k-archive")).toMatchObject({
      ok: false,
      error: { code: "not_allowed", message: `项目还有正在做或排队的工单：先完成或取消任务 ${busy}「给记账本加周报」、${queuedTask}「给记账本加月报」，再归档` },
    });
    expect(td.daemon.projects.get("p-1")?.state).toBe("in_use");
    expect(td.daemon.workOrders.openOf("p-1").map((w) => [workOrderTaskId(w), w.state])).toEqual([
      [busy, "clarifying"],
      [queuedTask, "pending"],
    ]);
  }, 120_000);

  it("发给已归档项目的工单直接以“退回”结束并附原因（同一事务），维护者不被唤起：用户确认计划、秘书写好任务书之后派的都是；取消归档后排着的任务接着做；发给已停用项目的工单照常执行", async () => {
    const d = dirs();
    const records = d.records();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的"), say("好的"), say("好的")],
      maintainer: (id, spawn) => {
        if (id === "pm-1" && spawn === 1) return [submitPlanStep(onePlan("weekly.md")), writeProgress("周报：计划交了。"), summary("起草了周报的计划"), say("交了")];
        if (id === "pm-1")
          return [call("write", { path: "weekly.md", content: "# 周报\n" }), completeStage("s1"), progressEdit(records, "周报：计划交了。", "周报做完了。"), summary("周报做完了"), say("做完了")];
        // 家电档案（已停用）的维护者照常起草计划
        if (id === "pm-2") return [submitPlanStep(onePlan("warranty.md")), writeProgress("保修：计划交了。"), summary("起草了保修的计划"), say("交了")];
        return [];
      },
    });
    inUseProject(td, "记账本");
    inUseProject(td, "家电档案", {}, { state: "retired" });
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1, maintainerChannel("pm-2")]);

    // 记账本：第一个任务的计划交了（起草计划的工单写回后结束）；第二个任务先建好，秘书还没写任务书
    const planned = await startProjectTask(td, frontend, "给记账本加周报", "记账本");
    const plan = await planCardOf(frontend, planned);
    await workOrderWhere(frontend, (e) => e.change === "ended" && workOrderTaskId(e.workOrder) === planned, "起草计划的工单结束");
    // 64 号票起只涉及一个项目的任务都是这个项目的内部任务：项目的维护者建好，还没写任务书
    const late = td.daemon.tasks.createInternal({ projectId: "p-1", title: "给记账本加年报", summary: "给记账本加年报", kind: "long_running" }, "pm-1");
    // 没有没结束的工单：能归档
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "archive" }, "k-archive"));
    const turnsBefore = frontend.events({ channel: PM1, type: EVENT_TYPES.turnStart }).length;

    // 用户确认计划：任务进排队中，执行工单派出时就以"退回"结束；任务留在排队中，维护者不被唤起
    ok(await frontend.cardAction({ cardId: plan.id, action: "confirm", expectedVersion: 1, input: {} }));
    const returned = await workOrderWhere(frontend, (e) => e.change === "ended" && workOrderTaskId(e.workOrder) === planned && e.workOrder.kind === "execute", "执行工单退回");
    expect(returned).toMatchObject({ from: "pending", workOrder: { outcome: "returned", reason: "项目「记账本」已归档：维护者不接新的工单。要接着做，先在项目页上取消归档，再重新发起" } });
    // 维护者写好任务书：起草计划的工单同样直接退回
    td.daemon.tasks.writeBrief(late.id, brief("记账本"), { maintainerId: "pm-1" });
    const direct = await workOrderWhere(frontend, (e) => e.change === "ended" && workOrderTaskId(e.workOrder) === late.id, "直接退回的工单");
    expect(direct).toMatchObject({ from: "pending", workOrder: { kind: "plan", outcome: "returned", reason: expect.stringContaining("已归档") } });
    for (const id of [returned.workOrder.id, direct.workOrder.id]) {
      const frames = frontend.events({ channel: PROJECTS, type: EVENT_TYPES.workOrder }).filter((f) => (f.payload as WorkOrderEventPayload).workOrder.id === id);
      expect(frames.map((f) => (f.payload as WorkOrderEventPayload).change)).toEqual(["created", "ended"]);
      expect(frames[1]!.seq).toBe(frames[0]!.seq + 1);
    }
    expect(td.daemon.tasks.get(planned)?.state).toBe("queued");

    // 已停用的项目照常接单：维护者起草计划
    const retiredTask = await startProjectTask(td, frontend, "家电档案补保修", "家电档案");
    expect(td.daemon.tasks.get(retiredTask)).toMatchObject({ maintainerId: "pm-2", projectIds: ["p-2"] });
    await planCardOf(frontend, retiredTask);
    // 记账本的维护者一直没被唤起，排着的任务也没再派、再退回
    expect(frontend.events({ channel: PM1, type: EVENT_TYPES.turnStart })).toHaveLength(turnsBefore);
    expect(workOrdersOf(frontend).filter((e) => e.change === "created" && workOrderTaskId(e.workOrder) === planned && e.workOrder.kind === "execute")).toHaveLength(1);

    // 取消归档：排着的任务接着做（派一张新的执行工单，维护者执行）
    ok(await frontend.request(METHODS.projectAction, { projectId: "p-1", action: "unarchive" }, "k-unarchive"));
    await taskWhere(frontend, (e) => e.task.id === planned && e.change === "completed", "取消归档后任务做完", 60_000);
    expect(fs.readFileSync(path.join(records, "workdir", "weekly.md"), "utf8")).toBe("# 周报\n");
  }, 180_000);
});

describe("项目的首个建设任务（端到端）", () => {
  it("立项问答 → 确认并开工 → 项目维护者自己经计划提交和执行工具走完首个建设任务（在守卫下、在项目的工作目录里）→ 全部阶段验收后任务完成，项目自动进入使用中", async () => {
    const d = dirs();
    const records = d.records();
    const outside = fs.realpathSync.native(makeTempDir("ergou-elsewhere-"));
    const charter = { goal: "把家里的账管起来", scope: ["导入招行流水"], firstVersion: "有一份说明怎么导入的 README", kind: "dev", bindExternal: false };
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        switch (spawn) {
          case 1:
            // 立项问答（对话段）：交立项书，写回进展、写摘要
            return [call("submit_charter", charter), progressEdit(records, PROGRESS_INTRO, "立项书交了。"), summary("立项问答：首版是一份导入说明"), say("立项书交上去了")];
          case 2:
            // 起草首个建设任务的计划
            return [submitPlanStep(onePlan("README.md")), writeProgress("首个建设任务：计划交了。"), summary("起草了首版的计划"), say("计划交了")];
          default:
            // 执行：写到外面被守卫拒绝；在工作目录里写 README，宣布完成，写回
            return [
              call("write", { path: path.join(outside, "README.md"), content: "写到外面去" }),
              call("write", { path: "README.md", content: "# 记账本\n导入招行的 CSV。\n" }),
              completeStage("s1", "README 写好了"),
              progressEdit(records, "首个建设任务：计划交了。", "首版做完了：README.md。"),
              summary("首版做完了"),
              say("首版做完了"),
            ];
        }
      },
    });
    const frontend = await connect(td.url);
    // 立项 → 立项问答 → 立项书卡"确认并开工"
    const suggestion = td.daemon.cards.create({ type: "suggest_project", payload: { name: "记账本", goal: "把家里的账管起来" } });
    ok(await frontend.cardAction({ cardId: suggestion.id, action: "kickoff", expectedVersion: 1 }));
    await frontend.sendText("开始立项问答吧", { conversation: PM1 });
    const charterCard = await cardWhere(frontend, (c) => c.type === "charter", "立项书卡");
    await turnsOf(frontend, PM1, 1);
    ok(await frontend.cardAction({ cardId: charterCard.id, action: "confirm_start", expectedVersion: 1 }));
    const build = (await taskWhere(frontend, (e) => e.change === "created" && e.task.origin === "project_build", "首个建设任务")).task;
    // 只涉及这个项目：首个建设任务也是它的内部任务（64 号票）
    expect(build).toMatchObject({ maintainerId: "pm-1", projectIds: ["p-1"], state: "planning", internal: { projectId: "p-1", projectName: "记账本" } });
    // 开发类、用二狗给的默认工作目录：立项书确认时初始化成 git 仓库（子 agent 并行时各用一个 worktree）
    await waitUntil(() => fs.existsSync(path.join(records, "workdir", ".git")), { describe: () => "等工作目录初始化成 git 仓库" });

    // 项目维护者起草计划（起草计划的工单，工单的内容指向立项书），用户确认
    const planOrder = await workOrderWhere(frontend, (e) => e.change === "started" && workOrderTaskId(e.workOrder) === build.id, "起草首个建设任务计划的工单");
    expect(planOrder.workOrder.instructions).toContain("立项书");
    const plan = await planCardOf(frontend, build.id);
    ok(await frontend.cardAction({ cardId: plan.id, action: "confirm", expectedVersion: 1, input: {} }));

    // 执行：守卫下、项目的工作目录里；全部阶段验收后任务完成，项目自动进入使用中（系统，不出卡）
    await taskWhere(frontend, (e) => e.task.id === build.id && e.change === "completed", "首个建设任务完成", 60_000);
    const inUse = await eventually(() => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.project }).map((f) => f.payload as ProjectEventPayload), (e) => e.change === "in_use", "项目进入使用中");
    expect(inUse).toMatchObject({ from: "building", by: "system", project: { state: "in_use", buildTaskId: build.id } });
    expect(fs.readFileSync(path.join(records, "workdir", "README.md"), "utf8")).toContain("导入招行的 CSV");
    expect(fs.existsSync(path.join(outside, "README.md"))).toBe(false);
    // 工单结束时这一段的会话都到齐了（任务在 complete_stage 执行时就完成了，那次调用的记录随后才追加）
    await workOrderWhere(frontend, (e) => e.change === "ended" && workOrderTaskId(e.workOrder) === build.id && e.workOrder.kind === "execute", "执行的工单结束");
    const calls = messagesOf(frontend, PM1).flatMap((m) => m.message.parts.filter((p) => p.type === "tool_call"));
    expect(calls.filter((p) => p.tool === "write").map((p) => `${p.outcome} ${p.blockedBy ?? ""}`.trim()).toSorted()).toEqual(["blocked hard_refusal", "done"]);
    expect(calls.map((p) => p.tool)).toEqual(expect.arrayContaining(["submit_charter", "submit_plan", "complete_stage"]));
  }, 180_000);
});

/** 工单事件按先后回放：任何时候同一项目进行中（含等澄清）的工单最多一张 */
function maxActiveAtOnce(events: readonly WorkOrderEventPayload[]): number {
  const active = new Set<string>();
  let max = 0;
  for (const { workOrder } of events) {
    if (workOrder.state === "in_progress" || workOrder.state === "clarifying") active.add(workOrder.id);
    else active.delete(workOrder.id);
    max = Math.max(max, active.size);
  }
  return max;
}

describe("派单：一次只做一件、先来先做", () => {
  it("给同一个项目连发两个单项目任务：后到的任务的工单排着（等项目 X），前一张工单结束后自动开始；计划确认后项目正忙的任务留在排队中，前一个任务做完它自动开始；工单不在看板上单独占卡（录给前端回放）", async () => {
    const d = dirs();
    const records = d.records();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的"), say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        switch (spawn) {
          case 1:
            return [submitPlanStep(onePlan("weekly.md")), writeProgress("周报：计划交了。"), summary("起草了周报的计划"), say("周报的计划交了")];
          case 2:
            return [submitPlanStep(onePlan("monthly.md")), writeProgress("周报、月报：计划都交了。"), summary("起草了月报的计划"), say("月报的计划交了")];
          case 3:
            return [
              call("write", { path: "weekly.md", content: "# 周报\n" }),
              completeStage("s1"),
              progressEdit(records, "周报、月报：计划都交了。", "周报做完了；月报等着。"),
              summary("周报做完了"),
              say("周报做完了"),
            ];
          default:
            return [
              call("write", { path: "monthly.md", content: "# 月报\n" }),
              completeStage("s1"),
              progressEdit(records, "周报做完了；月报等着。", "周报、月报都做完了。"),
              summary("月报做完了"),
              say("月报做完了"),
            ];
        }
      },
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url);
    const first = await startProjectTask(td, frontend, "记账本出周报", "记账本");
    const second = await startProjectTask(td, frontend, "记账本出月报", "记账本");

    // 两张起草计划的工单进了同一个维护者的队列：第一张进行中，第二张待接
    const queued = await workOrderWhere(frontend, (e) => e.change === "created" && workOrderTaskId(e.workOrder) === second, "第二个任务的工单");
    expect(queued.workOrder).toMatchObject({ projectId: "p-1", maintainerId: "pm-1", source: "user_task", kind: "plan", state: "pending", taskTitle: "记账本出月报" });
    expect(td.daemon.workOrders.get(queued.workOrder.id)?.state).toBe("pending");
    // 第一张结束后第二张自动开始
    const firstCard = await planCardOf(frontend, first);
    const secondCard = await planCardOf(frontend, second);
    await workOrderWhere(frontend, (e) => e.change === "ended" && e.workOrder.id === queued.workOrder.id, "第二张起草计划的工单结束");

    // 确认两个计划：第一个开始执行，第二个留在排队中（项目正忙），它的执行工单排着
    ok(await frontend.cardAction({ cardId: firstCard.id, action: "confirm", expectedVersion: 1, input: {} }));
    await taskWhere(frontend, (e) => e.task.id === first && e.change === "started", "第一个任务开始执行");
    ok(await frontend.cardAction({ cardId: secondCard.id, action: "confirm", expectedVersion: 1, input: {} }));
    const waiting = await workOrderWhere(frontend, (e) => e.change === "created" && workOrderTaskId(e.workOrder) === second && e.workOrder.kind === "execute", "第二个任务的执行工单");
    expect(waiting.workOrder.state).toBe("pending");
    expect(td.daemon.tasks.get(second)?.state).toBe("queued");

    // 第一个做完，第二个自动开始、做完
    await taskWhere(frontend, (e) => e.task.id === first && e.change === "completed", "第一个任务完成", 60_000);
    await taskWhere(frontend, (e) => e.task.id === second && e.change === "completed", "第二个任务完成", 60_000);
    expect(fs.readFileSync(path.join(records, "workdir", "monthly.md"), "utf8")).toBe("# 月报\n");
    // 任务完成之后这一段先收尾：维护者写回、这一轮结束，执行的工单才结束
    await workOrderWhere(frontend, (e) => e.change === "ended" && workOrderTaskId(e.workOrder) === second && e.workOrder.kind === "execute", "第二个任务的执行工单结束");
    await segmentWhere(frontend, (e) => e.segment.workOrderId === waiting.workOrder.id && e.change === "closed", "第二个任务的执行工单段结束");

    // 先来先做：工单按派出的先后开始；同一时刻只有一张进行中
    const events = workOrdersOf(frontend);
    const started = events.filter((e) => e.change === "started").map((e) => [workOrderTaskId(e.workOrder), e.workOrder.kind]);
    expect(started).toEqual([
      [first, "plan"],
      [second, "plan"],
      [first, "execute"],
      [second, "execute"],
    ]);
    expect(maxActiveAtOnce(events)).toBe(1);
    expect(events.filter((e) => e.change === "ended").map((e) => e.workOrder.outcome)).toEqual(["done", "done", "done", "done"]);
    // 工单不在看板上单独占卡：看板上只有这两个任务
    expect([...new Set(tasksOf(frontend).map((e) => e.task.id))]).toEqual([first, second]);
    // 维护者会话里每张工单一条分隔线
    const dividers = messagesOf(frontend, PM1).flatMap((m) => m.message.parts.filter((p) => p.type === "work_order_divider"));
    expect(dividers.map((p) => p.title)).toEqual(["起草计划：记账本出周报", "起草计划：记账本出月报", "执行：记账本出周报", "执行：记账本出月报"]);
    saveOrCheckRecording("work-orders-queue", frontend.recording, { perChannel: true });
  }, 180_000);
});

/** 两个互不依赖的阶段：s1 写 a.txt、s2 写 b.txt（脚本验收），可以并行 */
function twoFilesPlan(): Plan {
  const one = onePlan("a.txt");
  const stage = one.stages[0]!;
  return {
    ...one,
    stages: [
      { ...stage, stageId: "s1", title: "做 a.txt", deliverables: ["a.txt"], acceptance: [{ criterion: "a.txt 存在", method: "script", script: "test -f a.txt" }] },
      { ...stage, stageId: "s2", title: "做 b.txt", deliverables: ["b.txt"], acceptance: [{ criterion: "b.txt 存在", method: "script", script: "test -f b.txt" }] },
    ],
  };
}

type ToolCallPart = Extract<MessageEventPayload["message"]["parts"][number], { type: "tool_call" }>;
/** 维护者会话里的工具调用记录，连同所在消息的归属 */
const toolCallsOf = (frontend: TestFrontend, channel = PM1) =>
  messagesOf(frontend, channel).flatMap((m) => m.message.parts.filter((p): p is ToolCallPart => p.type === "tool_call").map((p) => ({ part: p, scope: m })));
const proposeParallel = (agents: Array<{ stageId: string; instructions: string }>) => call("propose_parallel", { reason: "两个阶段互不依赖，同时做省时间", agents });
const twoAgents = [
  { stageId: "s1", instructions: "写 a.txt，内容是 A" },
  { stageId: "s2", instructions: "写 b.txt，内容是 B" },
];

describe("子 agent 并行（20 号票）：项目的维护者执行单项目任务时", () => {
  it("提议并行、用户同意后拉起子 agent：子 agent 的装配从项目维护者执行时的装配收窄，写项目档案被守卫拒绝（不问用户），写工作目录照常；它的工具调用记录和交回的结果进项目维护者的会话，带着项目、任务、阶段和子 agent", async () => {
    const d = dirs();
    const records = d.records();
    const spec = path.join(records, "spec.md");
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        if (spawn === 1) return [submitPlanStep(twoFilesPlan()), writeProgress("两个文件：计划交了。"), summary("起草了两个文件的计划"), say("计划交了")];
        // 执行这一段：提议并行，等用户同意、等子 agent 交回结果（结果到得快时可能作为插话进同一轮，多给几句）
        return [proposeParallel(twoAgents), say("等你确认"), say("等子 agent 的结果"), say("收到"), say("收到"), say("收到")];
      },
      // sa-1 先试着改项目档案（被拒），再写自己的交付件；sa-2 照常写
      subAgent: (agentId) =>
        agentId === "sa-1"
          ? [call("write", { path: spec, content: "子 agent 改的规格\n" }), call("write", { path: "a.txt", content: "A" }), say("a.txt 写好了；项目档案改不了")]
          : [call("write", { path: "b.txt", content: "B" }), say("b.txt 写好了")],
    });
    // 一个"其他"类的项目：子 agent 不写目录时和维护者共用工作目录
    inUseProject(td, "记账本", {}, { kind: "other" });
    const specBefore = fs.readFileSync(spec, "utf8");
    const frontend = await connect(td.url);
    const taskId = await startProjectTask(td, frontend, "记账本写两个文件", "记账本");
    const plan = await planCardOf(frontend, taskId);
    await workOrderWhere(frontend, (e) => e.change === "ended" && e.workOrder.kind === "plan", "起草计划的工单结束");
    ok(await frontend.cardAction({ cardId: plan.id, action: "confirm", expectedVersion: 1, input: {} }));

    // 执行的工单段里提议并行：并行确认卡写的是项目的维护者
    const card = await cardWhere(frontend, (c) => c.type === "parallel", "并行确认卡");
    expect(card.payload).toMatchObject({ taskId, maintainerId: "pm-1", agents: [expect.objectContaining({ agentId: "sa-1", stageId: "s1" }), expect.objectContaining({ agentId: "sa-2", stageId: "s2" })] });
    await turnsOf(frontend, PM1, 2);
    ok(await frontend.cardAction({ cardId: card.id, action: "parallel", expectedVersion: 1 }));

    // 两个子 agent 的结果都交回项目维护者的会话
    const results = () => messagesOf(frontend, PM1).filter((m) => m.agentInput === true && m.agentId !== undefined);
    await waitUntil(() => results().length >= 2, { timeoutMs: 60_000, describe: () => "等两个子 agent 交回结果" });
    for (const m of results()) expect(m).toMatchObject({ projectId: "p-1", taskId });

    // sa-1 写项目档案：守卫硬拒绝，不出审批卡，文件没变；写工作目录照常
    const sa1 = toolCallsOf(frontend).filter((c) => c.scope.agentId === "sa-1");
    const recordsWrite = sa1.find((c) => c.part.tool === "write" && c.part.argsSummary.includes("spec.md"))!;
    expect(recordsWrite.part).toMatchObject({ outcome: "blocked", blockedBy: "hard_refusal" });
    expect(recordsWrite.scope).toMatchObject({ projectId: "p-1", taskId, stageId: "s1", agentId: "sa-1" });
    expect(fs.readFileSync(spec, "utf8")).toBe(specBefore);
    expect(cardsOf(frontend).filter((c) => c.type === "approval")).toEqual([]);
    expect(sa1.find((c) => c.part.tool === "write" && c.part.argsSummary.includes("a.txt"))!.part.outcome).toBe("done");
    expect(fs.readFileSync(path.join(records, "workdir", "a.txt"), "utf8")).toBe("A");
    expect(fs.readFileSync(path.join(records, "workdir", "b.txt"), "utf8")).toBe("B");
  }, 180_000);

  it("开发类按立项书的项目类型算：工作目录不是 git 仓库（比如绑定的外部目录）时并行被拒，说明原因和办法（先初始化成 git 仓库）；是 git 仓库时不给子 agent 建自己的 worktree 的提议被拒；原因都交回维护者", async () => {
    for (const git of [false, true]) {
      const d = dirs();
      const td = await startTestDaemon({
        reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
        secretary: [say("好的")],
        maintainer: (id, spawn) => {
          if (id !== "pm-1") return [];
          if (spawn === 1) return [submitPlanStep(twoFilesPlan()), writeProgress("两个文件：计划交了。"), summary("起草了两个文件的计划"), say("计划交了")];
          return [proposeParallel(twoAgents), say("被拒了，照常一个一个做")];
        },
      });
      // 立项书直接写进状态的项目：工作目录没经过立项书确认，不是 git 仓库（同绑定的外部目录）；另一遍先初始化好
      inUseProject(td, "记账本");
      if (git) execFileSync("git", ["init", "-q"], { cwd: path.join(d.records(), "workdir"), stdio: "ignore" });
      const frontend = await connect(td.url);
      const taskId = await startProjectTask(td, frontend, "记账本写两个文件", "记账本");
      const plan = await planCardOf(frontend, taskId);
      await workOrderWhere(frontend, (e) => e.change === "ended" && e.workOrder.kind === "plan", "起草计划的工单结束");
      ok(await frontend.cardAction({ cardId: plan.id, action: "confirm", expectedVersion: 1, input: {} }));
      await turnsOf(frontend, PM1, 2);
      const proposal = toolCallsOf(frontend).find((c) => c.part.tool === "propose_parallel")!;
      const reason = git ? /开发类：sa-1 要有自己的目录/ : /开发类：工作目录 .+ 不是 git 仓库，没法给每个子 agent 建自己的 git worktree——先把工作目录初始化成 git 仓库/;
      expect(proposal.part.resultSummary).toMatch(reason);
      expect(cardsOf(frontend).filter((c) => c.type === "parallel")).toEqual([]);
      await td.daemon.stop();
    }
  }, 180_000);
});

describe("秘书发起的单项目任务（16 号票评审后）", () => {
  // 64 号票起只涉及一个项目的任务一律是这个项目的内部任务：建卡时就写上一个项目的见 project-internal-tasks.test.ts
  it("建卡时没写项目、第一版任务书只涉及一个项目的：任务书交出时改由这个项目的维护者起草，成了这个项目的内部任务（64 号票）；不新建任务自己的维护者", async () => {
    const td = await startTestDaemon({
      secretary: [
        call("create_task", { title: "整理记账本的分类", summary: "用户要把记账本的分类整理清楚" }),
        call("write_task_brief", { taskId: "t-1", ...brief("记账本"), goal: "分类整理清楚" }),
        say("建好了"),
      ],
      maintainer: (id) => (id === "pm-1" ? [submitPlanStep(onePlan("categories.md")), writeProgress("分类：计划交了。"), summary("起草了分类的计划"), say("计划交了")] : []),
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url, [CHANNELS.secretary, BOARD, CARDS, INBOX, PROJECTS, PM1]);

    // 建卡时没写项目（任务自己的维护者还没接过任何输入），第一版任务书只涉及记账本：改由记账本的维护者起草
    await frontend.sendText("发起任务：再把记账本的分类整理一下");
    const handed = await taskWhere(frontend, (e) => e.task.id === "t-1" && e.change === "handed_to_project", "任务交给项目的维护者");
    expect(handed).toMatchObject({ from: "planning", by: "secretary", task: { state: "planning", maintainerId: "pm-1", projects: ["记账本"], projectIds: ["p-1"] } });
    expect(handed.task.internal).toEqual({ projectId: "p-1", projectName: "记账本" });
    expect(tasksOf(frontend).find((e) => e.task.id === "t-1" && e.change === "created")!.task.maintainerId).toBe("tm-1");
    await planCardOf(frontend, "t-1");

    // 起草计划的工单派给了记账本的维护者；会话区里没有任务自己的维护者
    expect(workOrdersOf(frontend).filter((e) => e.change === "started").map((e) => [workOrderTaskId(e.workOrder), e.workOrder.maintainerId, e.workOrder.kind])).toEqual([["t-1", "pm-1", "plan"]]);
    expect(fs.readdirSync(path.join(td.dataDir, "sessions")).toSorted()).toEqual(["pm-1", "secretary"]);
  }, 120_000);
});

describe("写回中途重置、催写回到了次数（16 号票评审后）", () => {
  it("写回中途重置维护者：这张工单照常算完成，如实标“重置时这段没写回档案”（工单上、维护者会话的时间线上）；旧会话原样保留，新的一段只凭项目档案", async () => {
    const d = dirs();
    const td = await startTestDaemon({
      reuse: { dataDir: d.dataDir, homeDir: d.homeDir },
      secretary: [say("好的")],
      // 交了计划不写回；被催时慢慢回一段长话（约 4 秒，还在说的时候用户重置了维护者）。吐字速度是整个剧本共用的：
      // 调快、那段话加长，交计划那一步（计划的 JSON 很长）就不用陪着慢慢吐（92 号票）
      maintainer: (id, spawn) => (id !== "pm-1" ? [] : spawn === 1 ? [submitPlanStep(onePlan("weekly.md")), say("计划交了"), say("这一段先不写回，".repeat(200))] : [{ kind: "echo_context" }]),
      maintainerTokensPerSecond: 100,
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url);
    const taskId = await startProjectTask(td, frontend, "给记账本加周报", "记账本");
    const wo = (await workOrderWhere(frontend, (e) => e.change === "started" && workOrderTaskId(e.workOrder) === taskId, "起草计划的工单开始")).workOrder;
    await planCardOf(frontend, taskId);
    // 计划交了、没写回：这一段收尾中，催写回；维护者正慢慢回话
    await eventually(() => messagesOf(frontend, PM1), (m) => m.agentInput === true && textOf(m).includes("还没写回"), "催写回");
    await waitUntil(() => frontend.events({ channel: PM1, type: EVENT_TYPES.turnStart }).length === 2, { describe: () => "等维护者开始回催写回的通知" });
    expect(td.daemon.workOrders.get(wo.id)?.state).toBe("in_progress");
    const oldFile = path.join(d.dataDir, "sessions", "pm-1", "pm-1-s1.jsonl");
    expect(fs.existsSync(oldFile)).toBe(true);

    // 写回中途重置：工单照常以"完成"结束，标着这一段没写回
    ok(await frontend.request(METHODS.resetMaintainer, { projectId: "p-1" }, "k-reset"));
    const ended = await workOrderWhere(frontend, (e) => e.change === "ended" && e.workOrder.id === wo.id, "工单结束");
    expect(ended.workOrder).toMatchObject({ outcome: "done", unwritten: "reset" });
    expect(workOrderStatusText(ended.workOrder)).toBe("已结束 · 完成 · 重置时这段没写回档案");
    expect(segmentsOf(frontend).find((e) => e.segment.segmentId === "pm-1-s1" && e.change === "closed")!.segment).toMatchObject({ workOrderId: wo.id, unwritten: "reset" });
    // 维护者会话的时间线上记一笔（属于这张工单的任务和项目）
    const record = await eventually(
      () => frontend.events({ channel: PM1, type: EVENT_TYPES.timelineRecord }).map((f) => f.payload as TimelineRecordEventPayload),
      (p) => p.record.kind === "write_back_missing",
      "时间线上的记录",
    );
    expect(record).toMatchObject({ projectId: "p-1", taskId, record: { summary: "重置时这段没写回档案", workOrderId: wo.id } });
    // 新的一段只凭项目档案；计划卡照常等用户确认
    const reset = await segmentWhere(frontend, (e) => e.change === "opened" && e.segment.reset, "重置开的一段");
    expect(reset.segment).toMatchObject({ segmentId: "pm-1-s2", kind: "chat" });
    expect(td.daemon.tasks.get(taskId)?.state).toBe("awaiting_confirm");
    // 旧会话原样保留：那一段慢慢说完的回话也还在里面
    await turnsOf(frontend, PM1, 2);
    await waitUntil(() => fs.readFileSync(oldFile, "utf8").includes("这一段先不写回"), { describe: () => "等旧会话里那段回话" });
    expect(sessionFiles(d.dataDir)).toEqual(["pm-1-s1.jsonl"]);
  }, 120_000);

  it("催写回到了次数（同第 8 节的催促阈值，3 次）还没写回：转为用户拍板——待我处理里一条“卡住求助”，这一段没写回就结束，工单照常结束并标出来，项目的队列接着走", async () => {
    const td = await startTestDaemon({
      secretary: [say("好的"), say("好的")],
      maintainer: (id, spawn) => {
        if (id !== "pm-1") return [];
        // 第一张工单：交了计划，怎么催都不写回
        if (spawn === 1) return [submitPlanStep(onePlan("weekly.md")), say("计划交了"), say("不写"), say("还是不写"), say("就是不写")];
        return [submitPlanStep(onePlan("monthly.md")), writeProgress("月报：计划交了。"), summary("起草了月报的计划"), say("月报的计划交了")];
      },
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url);
    const first = await startProjectTask(td, frontend, "给记账本加周报", "记账本");
    const second = await startProjectTask(td, frontend, "给记账本加月报", "记账本");
    const wo = (await workOrderWhere(frontend, (e) => e.change === "started" && workOrderTaskId(e.workOrder) === first, "第一张工单开始")).workOrder;

    // 催 3 次还没写回：卡住求助（不卡任务，动作"知道了"）
    const help = await eventually(() => inboxOf(frontend), (i) => i.kind === "notice" && i.notice === "stuck_help", "卡住求助");
    expect(help).toMatchObject({
      title: "卡住求助：项目「记账本」的维护者没写回档案",
      source: "项目「记账本」",
      urgency: "non_blocking",
      actions: ["知道了"],
      data: { projectId: "p-1", maintainerId: "pm-1", segmentId: "pm-1-s1", workOrderId: wo.id },
    });
    expect(help.kind === "notice" && help.body).toContain(`工单 ${wo.id}「起草计划：给记账本加周报」`);
    expect(messagesOf(frontend, PM1).filter((m) => m.agentInput && textOf(m).includes("还没写回"))).toHaveLength(3);
    // 这一段没写回就结束，工单照常以"完成"结束并标出来；会话里、时间线上都写着
    const ended = await workOrderWhere(frontend, (e) => e.change === "ended" && e.workOrder.id === wo.id, "第一张工单结束");
    expect(ended.workOrder).toMatchObject({ outcome: "done", unwritten: "nudged" });
    expect(segmentsOf(frontend).find((e) => e.segment.segmentId === "pm-1-s1" && e.change === "closed")!.segment).toMatchObject({ unwritten: "nudged" });
    expect(messagesOf(frontend, PM1).some((m) => !m.agentInput && textOf(m).includes("维护者催了 3 次还没写回项目档案"))).toBe(true);
    const record = frontend.events({ channel: PM1, type: EVENT_TYPES.timelineRecord }).map((f) => f.payload as TimelineRecordEventPayload).find((p) => p.record.kind === "write_back_missing");
    expect(record).toMatchObject({ taskId: first, record: { summary: "催了还没写回档案", workOrderId: wo.id } });
    // 任务停在待确认（看板的"等我"组），计划卡照常等用户
    expect(td.daemon.tasks.get(first)?.state).toBe("awaiting_confirm");

    // 项目的队列接着走：第二张工单开始、写回后结束
    await workOrderWhere(frontend, (e) => e.change === "ended" && workOrderTaskId(e.workOrder) === second, "第二张工单写回后结束");
    expect(workOrdersOf(frontend).find((e) => e.change === "ended" && workOrderTaskId(e.workOrder) === second)!.workOrder.unwritten).toBeUndefined();
  }, 120_000);
});

describe("关掉工单的提问卡（16 号票评审后保留）", () => {
  it("用户关掉项目维护者为工单问的提问卡：算“按你自己的理解接着做”——工单回到进行中，通知维护者，时间线上记一笔；维护者接着把计划交了", async () => {
    const td = await startTestDaemon({
      secretary: [say("好的")],
      maintainer: (id) =>
        id === "pm-1"
          ? [askOne("周报要不要带图表？", "要", "不要"), say("等你回答"), submitPlanStep(onePlan("weekly.md")), writeProgress("周报：按我的理解起草了计划。"), summary("起草了周报的计划"), say("按我的理解交了计划")]
          : [],
    });
    inUseProject(td, "记账本");
    const frontend = await connect(td.url);
    const taskId = await startProjectTask(td, frontend, "给记账本加周报", "记账本");
    const clarifying = await workOrderWhere(frontend, (e) => e.change === "clarifying", "工单转等澄清");
    const card = await cardWhere(frontend, (c) => c.type === "questions", "提问卡");
    await turnsOf(frontend, PM1, 1);

    ok(await frontend.cardAction({ cardId: card.id, action: "dismiss", expectedVersion: 1 }));
    const answered = await workOrderWhere(frontend, (e) => e.change === "answered", "工单回到进行中");
    expect(answered).toMatchObject({ from: "clarifying", by: "user", workOrder: { id: clarifying.workOrder.id, state: "in_progress" } });
    const notice = await eventually(() => messagesOf(frontend, PM1), (m) => m.agentInput === true && textOf(m).includes("用户关掉了你的提问卡"), "通知维护者");
    expect(notice).toMatchObject({ projectId: "p-1", taskId });
    expect(textOf(notice)).toContain("按你的理解接着做");
    const record = await eventually(
      () => frontend.events({ channel: PM1, type: EVENT_TYPES.timelineRecord }).map((f) => f.payload as TimelineRecordEventPayload),
      (p) => p.record.kind === "own_judgement",
      "时间线上的记录",
    );
    expect(record).toMatchObject({ projectId: "p-1", taskId, record: { summary: `关掉了工单 ${clarifying.workOrder.id} 的提问卡：维护者按自己的理解接着做`, workOrderId: clarifying.workOrder.id } });
    await planCardOf(frontend, taskId);
    await workOrderWhere(frontend, (e) => e.change === "ended" && e.workOrder.id === clarifying.workOrder.id, "起草计划的工单结束");
  }, 120_000);
});
