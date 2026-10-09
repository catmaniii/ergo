// 主切面：子 agent 并行（规格第 8、11 节，20 号票）。真的守护进程，维护者、子 agent 都接 faux 剧本，测试扮演前端。
// 任务直接经任务服务建出、写好任务书，维护者交计划，用户在计划卡上确认；执行中维护者用"提议并行"工具提议派子 agent：
// - 待我处理出现并行确认卡；用户确认前不拉起任何子 agent，可并行的阶段照常按顺序做；用户拒绝则照常串行；
// - 用户确认后每个子 agent 一个子进程，拿到维护者给它的工作说明；工具包是维护者的子集，守卫按任务的计划、它的阶段判定；
//   做完即解散，结果作为一条消息回到维护者的会话里（带所属任务、阶段和子 agent），维护者下一回合用到；
// - 子 agent 不占任务的执行名额，占 agent 管家的子进程名额（满了排队，活动状态"排队"）；
// - 维护者的当前阶段是它最后一次开始的那个：子 agent 做完后维护者在自己的阶段里的调用按那个阶段的授权判，
//   切到子 agent 交回的阶段之后按那个阶段判；暂停、继续、重启后都不变；token 账本里维护者的用量记在它的当前阶段，
//   子 agent 的记在它自己被派去的阶段（角色子 agent）；
// - 子 agent 的调用挂起后用户才批准：维护者收到的通知写明那是子 agent 的调用、批准用不上了；
// - 维护者的工具包收窄：活着的子 agent 做完手头这一步后按新的交集重新拉起，接着原来的会话做；
// - 开发类：维护者在工作目录里为每个子 agent 建 git worktree（不建、用工作目录、不是 worktree、目录重叠的提议被拒），
//   子 agent 各自提交，维护者用带类型的 git 合并工具合并。
import fs from "node:fs";
import path from "node:path";
import {
  type ActivityEventPayload,
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItem,
  type InboxItemEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  type MessagePart,
  type ParallelCardPayload,
  type Plan,
  type PlanCardPayload,
  type ResponseFrame,
  type Task,
  type TaskEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import type { FauxStep, FauxUsage } from "../../src/runtime/index.ts";
import { SUB_AGENT_EVENTS, SUB_AGENTS_CHANNEL } from "../../src/sub-agents/events.ts";
import { type PlanDecidedPayload, TASK_EVENTS, TASKS_CHANNEL } from "../../src/tasks/events.ts";
import { agentSpawns, startTestDaemon, type StartTestDaemonOptions, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { git, initRepo } from "../helpers/git-repo.ts";
import { toolCallDetail } from "../helpers/http.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { cards: CARDS, board: BOARD, inbox: INBOX, activity: ACTIVITY } = CHANNELS;
const M1 = maintainerChannel("tm-1");

type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;
const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const write = (file: string, content: string) => call("write", { path: file, content });
/** 这次模型调用照给定的用量上报（账本据此记一条，24 号票） */
const withUsage = (step: FauxStep, usage: FauxUsage): FauxStep => ({ ...step, usage }) as FauxStep;
const completeStage = (stageId: string) => call("complete_stage", { stageId, summary: `阶段 ${stageId} 做完了` });
const propose = (agents: Array<{ stageId: string; step?: string; instructions: string; workDir?: string }>, reason = "两个阶段互不依赖，同时做省时间") =>
  call("propose_parallel", { reason, agents });

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
const inboxOf = (frontend: TestFrontend): InboxItem[] => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item);
const activityOf = (frontend: TestFrontend) => frontend.events({ channel: ACTIVITY, type: EVENT_TYPES.activity }).map((f) => f.payload as ActivityEventPayload);
const toolCallsOf = (frontend: TestFrontend, channel: string): Array<ToolCallPart & { scope: MessageEventPayload }> =>
  messagesOf(frontend, channel).flatMap((m) => m.message.parts.filter((p): p is ToolCallPart => p.type === "tool_call").map((p) => ({ ...p, scope: m })));
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};
const stageStates = (task: Task) => Object.fromEntries((task.stages?.list ?? []).map((s) => [s.stageId, s.state]));
/** 越出工作目录的 bash 命令里的路径（正斜杠） */
const fwd = (p: string) => p.replaceAll("\\", "/");

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs, describe: () => `等${what}` });
  return found!;
}
const cardWhere = (frontend: TestFrontend, match: (card: Card) => boolean, what = "卡片") => eventually(() => cardsOf(frontend), match, what);
const taskWhere = (frontend: TestFrontend, match: (e: TaskEventPayload) => boolean, what = "看板上的任务") => eventually(() => tasksOf(frontend), match, what);
const messageWhere = (frontend: TestFrontend, channel: string, match: (m: MessageEventPayload) => boolean, what: string) => eventually(() => messagesOf(frontend, channel), match, what);
/** 等某个维护者处理完 n 条输入 */
const turnsOf = (frontend: TestFrontend, channel: string, n: number) =>
  waitUntil(() => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 60_000, describe: () => `等 ${channel} 处理完 ${n} 条输入` });
const parallelCard = (frontend: TestFrontend) => cardWhere(frontend, (c) => c.type === "parallel", "并行确认卡");

/**
 * 一个开放模式的阶段：写一个文件，脚本验收它在不在。预算给足：faux 模型每次调用按整个上下文报用量（一次一万 token 上下），
 * 用量超过预算时运行时会让维护者说明进展（14 号票），多出来的一条输入会打乱剧本
 */
const fileStage = (stageId: string, file: string): Plan["stages"][number] => ({
  stageId,
  title: `做 ${file}`,
  deliverables: [file],
  acceptance: [{ criterion: `${file} 存在`, method: "script", script: `test -f ${file}` }],
  mode: "open",
  dependsOn: [],
  policy: { grants: [], temporalRules: [] },
  budget: { tokens: 1_000_000, toolCalls: 30 },
});

/** 两个互不依赖的阶段：s1 写 a.txt、s2 写 b.txt（脚本验收）；工具包 bash、联网照 toolkit */
function parallelPlan(toolkit: Partial<Plan["toolkit"]> = {}): Plan {
  const base = samplePlan();
  return {
    ...base,
    stages: [fileStage("s1", "a.txt"), fileStage("s2", "b.txt")],
    stageGroups: [],
    toolkit: { ...base.toolkit, bash: false, network: false, ...toolkit },
    scheduledJobs: [],
    stops: { count: 0, where: [] },
  };
}

const brief = { goal: "做两个文件", acceptanceCriteria: ["a.txt 和 b.txt 都在"], constraints: [], projects: [], memoryScope: "" };

/** 维护者的剧本：第一次唤起起草计划，之后（按计划装配重新拉起）照 run 执行 */
const maintainerScript =
  (plan: Plan, run: FauxStep[]) =>
  (_maintainerId: string, spawn: number): FauxStep[] =>
    spawn === 1 ? [submitPlanStep(plan), say("计划交上去了")] : run;

/** 前端订阅看板、卡片、待我处理、活动状态（录给前端回放的不订阅活动状态：秘书、维护者的先后每次不一样）和维护者的会话 */
async function connect(url: string, maintainers = 1, { activity = true } = {}) {
  const frontend = await TestFrontend.connect(url);
  const channels = [BOARD, CARDS, INBOX, ...(activity ? [ACTIVITY] : []), ...Array.from({ length: maintainers }, (_, i) => maintainerChannel(`tm-${i + 1}`))];
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

/** 建一个任务、写好任务书，等维护者交出计划、这一轮结束（录下的事件流每次一样），在计划卡上确认；返回任务 id */
async function confirmTask(td: TestDaemon, frontend: TestFrontend, title: string): Promise<string> {
  const task = td.daemon.tasks.createByRequest({ title, summary: title });
  td.daemon.tasks.writeBrief(task.id, brief);
  const card = await cardWhere(frontend, (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === task.id, `${task.id} 的计划卡`);
  await turnsOf(frontend, maintainerChannel(task.maintainerId), 1);
  ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));
  return task.id;
}

/** 子 agent 相关的内部事件（守护进程内部的 sub_agents 频道） */
const subAgentEvents = (td: TestDaemon, type: string) => td.daemon.store.read(SUB_AGENTS_CHANNEL, 0, type).map((e) => e.payload as Record<string, unknown>);

/** 守卫此刻看到的维护者的当前阶段 */
const currentStageOf = (td: TestDaemon, taskId: string) => td.daemon.taskExecution.guardTask(taskId)?.currentStageId;

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

describe("提议并行", () => {
  it("维护者提议后待我处理出现并行确认卡（写明任务、阶段、子 agent 个数和各自的工作说明）；用户确认前不拉起子 agent，阶段照常按顺序做；用户拒绝后维护者收到通知，照常串行做完", async () => {
    const td = await startTestDaemon({
      maintainer: maintainerScript(parallelPlan(), [
        // 开始执行（s1）：提议把 s1、s2 并行，没等确认就照常先做 s1
        propose([
          { stageId: "s1", instructions: "写 a.txt，内容是 A" },
          { stageId: "s2", instructions: "写 b.txt，内容是 B" },
        ]),
        write("a.txt", "A"),
        completeStage("s1"),
        say("s1 做完了，接着做 s2"),
        // 用户拒绝了并行：照常做 s2
        write("b.txt", "B"),
        completeStage("s2"),
        say("都做完了"),
      ]),
    });
    const spawned = agentSpawns(td.daemon);
    const frontend = await connect(td.url, 1, { activity: false });
    const taskId = await confirmTask(td, frontend, "两个文件");

    const card = await parallelCard(frontend);
    expect(card).toMatchObject({ status: "pending", version: 1, urgency: "non_blocking" });
    const payload = card.payload as ParallelCardPayload;
    expect(payload).toMatchObject({
      taskId,
      taskTitle: "两个文件",
      maintainerId: "tm-1",
      reason: "两个阶段互不依赖，同时做省时间",
      agents: [
        { agentId: "sa-1", stageId: "s1", stageTitle: "做 a.txt", instructions: "写 a.txt，内容是 A" },
        { agentId: "sa-2", stageId: "s2", stageTitle: "做 b.txt", instructions: "写 b.txt，内容是 B" },
      ],
    });
    // 纯文本降级：任务、子 agent 个数、各做什么
    expect(card.text).toContain("两个文件");
    expect(card.text).toContain("2 个子 agent");
    expect(card.text).toContain("写 a.txt，内容是 A");
    // 待我处理里有它（不卡任务：维护者照常按顺序做），维护者会话里有它的引用
    expect(inboxOf(frontend).find((i) => i.kind === "card" && i.cardId === card.id)).toMatchObject({ urgency: "non_blocking" });
    await messageWhere(frontend, M1, (m) => m.message.parts.some((p) => p.type === "card_ref" && p.cardId === card.id), "会话里的卡片引用");

    // 确认前：没拉起任何子 agent；s1 照常做完验收，接着开始 s2（一次只做一个）
    const s2Started = await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s2", "s1 验收通过后开始 s2");
    expect(stageStates(s2Started.task)).toEqual({ s1: "accepted", s2: "running" });
    expect(spawned().filter((id) => id.startsWith("sa-"))).toEqual([]);
    await turnsOf(frontend, M1, 2);

    // 用户拒绝：卡片处理掉，维护者收到通知（附用户写的话），照常串行做完；一个子 agent 都没拉起
    ok(await frontend.cardAction({ cardId: card.id, action: "sequential", expectedVersion: 1, note: "按顺序就行" }));
    const rejected = await cardWhere(frontend, (c) => c.id === card.id && c.status === "handled", "处理过的并行确认卡");
    expect(rejected.outcome).toMatchObject({ action: "sequential" });
    const notice = await messageWhere(frontend, M1, (m) => m.agentInput === true && textOf(m).includes("没同意并行"), "拒绝的通知");
    expect(textOf(notice)).toContain("按顺序就行");
    expect(notice.taskId).toBe(taskId);
    await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "completed", "任务完成");
    expect(spawned().filter((id) => id.startsWith("sa-"))).toEqual([]);

    // 审批决定：拒绝产生素材事件，记成"审批决定"素材（用户写的话是本人打的字）
    expect(subAgentEvents(td, EVENT_TYPES.parallelDecided)).toEqual([
      expect.objectContaining({ taskId, cardId: card.id, decision: "sequential", note: "按顺序就行", by: "user" }),
    ]);
    const parallelDecisions = () => td.daemon.materials.list({ kind: "approval_decision" }).filter((m) => m.context.includes("card:parallel"));
    await waitUntil(() => parallelDecisions().length > 0, { describe: () => "等并行确认卡上的审批决定素材" });
    expect(parallelDecisions()).toEqual([
      expect.objectContaining({
        task: taskId,
        source: "self",
        context: ["decision:sequential", "card:parallel"],
        segments: [
          expect.objectContaining({ form: "choice", text: expect.stringContaining("不并行") }),
          expect.objectContaining({ form: "typed", text: "按顺序就行" }),
        ],
      }),
    ]);
    // 这条路上的事件顺序是确定的：录给前端回放（parallel-sequential）
    await turnsOf(frontend, M1, 3);
    saveOrCheckRecording("parallel-sequential", frontend.recording, { perChannel: true });
  }, 120_000);

  it("用户确认后为每个子 agent 拉起独立的子进程，递送工作说明；工具包是维护者的子集；做完即退出，结果作为一条消息回到维护者的会话，维护者下一回合用到；两个前端同时点，后到的得到“已被处理”", async () => {
    const td = await startTestDaemon({
      maintainer: maintainerScript(parallelPlan(), [
        propose([
          { stageId: "s1", instructions: "写 a.txt，内容是 A" },
          { stageId: "s2", instructions: "写 b.txt，内容是 B" },
        ]),
        say("等你确认"),
        // 用户同意了
        say("等子 agent 的结果"),
        // 第一条结果
        say("收到一个"),
        // 第二条结果：两个阶段都宣布完成，再看一眼自己看到的上下文
        completeStage("s1"),
        completeStage("s2"),
        { kind: "echo_context" },
      ]),
      // sa-1 把自己看到的上下文（系统提示、工具、工作说明）原样交回；sa-2 正常交回一句话
      subAgent: (agentId) => (agentId === "sa-1" ? [write("a.txt", "A"), { kind: "echo_context" }] : [write("b.txt", "B"), say("b.txt 写好了")]),
    });
    const spawned = agentSpawns(td.daemon);
    const frontend = await connect(td.url);
    const other = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "两个文件");
    const card = await parallelCard(frontend);
    await turnsOf(frontend, M1, 2);
    expect(spawned().filter((id) => id.startsWith("sa-"))).toEqual([]);

    // 两个前端同时点"同意并行"：先到的生效，后到的"已被处理"
    const clicks = await Promise.all([
      frontend.cardAction({ cardId: card.id, action: "parallel", expectedVersion: 1 }),
      other.cardAction({ cardId: card.id, action: "parallel", expectedVersion: 1 }),
    ]);
    expect(clicks.filter((r) => r.ok)).toHaveLength(1);
    expect(clicks.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: "conflict", message: "已被处理" } });

    // 没开始的 s2 随确认一起开始（用户），两个阶段同时在做；每个子 agent 一个子进程
    const started = await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s2" && e.by === "user", "确认时开始 s2");
    expect(stageStates(started.task)).toEqual({ s1: "running", s2: "running" });
    await waitUntil(() => spawned().filter((id) => id.startsWith("sa-")).length === 2, { describe: () => `等两个子 agent 拉起：${spawned().join("、")}` });
    expect(spawned().filter((id) => id.startsWith("sa-"))).toEqual(["sa-1", "sa-2"]);
    expect(subAgentEvents(td, SUB_AGENT_EVENTS.subAgentStarted).map((p) => [p.agentId, p.stageId])).toEqual([
      ["sa-1", "s1"],
      ["sa-2", "s2"],
    ]);

    // 结果：维护者会话里各一条（交给维护者的输入，带所属任务、阶段和子 agent）
    const resultA = await messageWhere(frontend, M1, (m) => m.agentId === "sa-1" && m.message.speaker === "system", "sa-1 的结果");
    const resultB = await messageWhere(frontend, M1, (m) => m.agentId === "sa-2" && m.message.speaker === "system", "sa-2 的结果");
    expect(resultA).toMatchObject({ agentInput: true, taskId, stageId: "s1", agentId: "sa-1" });
    expect(resultB).toMatchObject({ agentInput: true, taskId, stageId: "s2", agentId: "sa-2" });
    expect(textOf(resultB)).toContain("子 agent sa-2 做阶段 s2「做 b.txt」，做完了");
    expect(textOf(resultB)).toContain("b.txt 写好了");
    // sa-1 交回的是它看到的上下文：拿到了维护者给它的工作说明和阶段的交付件；工具包是维护者的子集
    const seenBySub = textOf(resultA);
    expect(seenBySub).toContain("[user] ");
    expect(seenBySub).toContain("写 a.txt，内容是 A");
    expect(seenBySub).toContain("阶段 s1「做 a.txt」");
    const subTools = seenBySub.split("\n").filter((l) => l.startsWith("[tool] ")).map((l) => l.slice("[tool] ".length));
    // 维护者的计划里 bash、联网都关着：子 agent 只有读写文件的工具（联网关着时 grep、find 也不给，和维护者一样）
    expect(subTools.toSorted()).toEqual(["edit", "ls", "read", "write"]);

    // 子 agent 的工具调用记录在维护者的会话里，归到所属任务、阶段和子 agent
    const subCalls = toolCallsOf(frontend, M1).filter((c) => c.scope.agentId !== undefined);
    expect(subCalls.map((c) => [c.scope.agentId, c.scope.stageId, c.scope.taskId, c.tool, c.outcome]).toSorted()).toEqual([
      ["sa-1", "s1", taskId, "write", "done"],
      ["sa-2", "s2", taskId, "write", "done"],
    ]);
    // 按调用 id 取得到子 agent 那次调用的完整参数（53 号票）
    const subWrite = subCalls.find((c) => c.scope.agentId === "sa-2")!;
    expect((await toolCallDetail(td.url, subWrite.callId)).body).toMatchObject({ agentId: "sa-2", conversation: M1, taskId, stageId: "s2", tool: "write", args: { path: "b.txt", content: "B" } });

    // 做完即解散：子进程都退出了；维护者下一回合看到了两条结果，宣布两个阶段完成，任务完成
    await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "completed", "任务完成");
    await waitUntil(() => !td.daemon.agents.live().some((a) => a.agentId.startsWith("sa-")), { describe: () => "等子 agent 的子进程都退出" });
    expect(subAgentEvents(td, SUB_AGENT_EVENTS.subAgentFinished).map((p) => [p.agentId, p.outcome]).toSorted()).toEqual([
      ["sa-1", "done"],
      ["sa-2", "done"],
    ]);
    await turnsOf(frontend, M1, 5);
    const seenByMaintainer = textOf(messagesOf(frontend, M1).filter((m) => m.message.speaker === "agent" && textOf(m).includes("[system]")).at(-1)!);
    expect(seenByMaintainer).toContain("子 agent sa-1 做阶段 s1「做 a.txt」，做完了");
    expect(seenByMaintainer).toContain("b.txt 写好了");
    // 活动状态：两个子 agent 干过活，现在都休眠
    for (const id of ["sa-1", "sa-2"]) {
      expect(activityOf(frontend).filter((p) => p.agentId === id).map((p) => p.state)).toContain("working");
      expect(activityOf(frontend).filter((p) => p.agentId === id).at(-1)?.state).toBe("sleeping");
    }
    // 审批决定：同意也是一条素材事件
    expect(subAgentEvents(td, EVENT_TYPES.parallelDecided)).toEqual([expect.objectContaining({ taskId, decision: "parallel", by: "user" })]);
  }, 180_000);
});

describe("提议的检查和子 agent 在做的阶段", () => {
  it("前置阶段没验收的、目录不在工作目录里或不存在的、没有这一步的：提议被拒，原因交回维护者；新的提议让上一张没处理的卡过期；有子 agent 在做的阶段不能宣布完成，维护者先做别的阶段", async () => {
    const base = parallelPlan();
    const plan: Plan = {
      ...base,
      stages: [...base.stages, { ...base.stages[0]!, stageId: "s3", title: "做 c.txt", deliverables: ["c.txt"], acceptance: [{ criterion: "c.txt 存在", method: "script", script: "test -f c.txt" }], dependsOn: ["s1"] }],
    };
    const td = await startTestDaemon({
      maintainer: maintainerScript(plan, [
        // 开始执行（s1）：几次不行的提议
        propose([{ stageId: "s3", instructions: "写 c.txt" }]),
        propose([{ stageId: "s2", instructions: "写 b.txt", workDir: ".." }]),
        propose([{ stageId: "s2", instructions: "写 b.txt", workDir: "nope" }]),
        propose([{ stageId: "s2", step: "第一步", instructions: "写 b.txt" }]),
        // 一次提议了 s1、s2，又改成只提议 s2：上一张卡过期
        propose([
          { stageId: "s1", instructions: "写 a.txt" },
          { stageId: "s2", instructions: "写 b.txt" },
        ]),
        propose([{ stageId: "s2", instructions: "写 b.txt，内容是 B" }]),
        say("等你确认"),
        // 用户同意了（s2 交给 sa-3）：s2 还有子 agent 在做，不能宣布完成；先做完 s1，运行时接着开始 s3
        completeStage("s2"),
        write("a.txt", "A"),
        completeStage("s1"),
        write("c.txt", "C"),
        completeStage("s3"),
        say("等 sa-3 的结果"),
        // sa-3 的结果回来了
        completeStage("s2"),
        say("都做完了"),
      ]),
      subAgent: () => [write("b.txt", "B"), say("b.txt 写好了")],
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "三个文件");
    const second = await cardWhere(frontend, (c) => c.type === "parallel" && (c.payload as ParallelCardPayload).agents.length === 1, "第二张并行确认卡");
    await turnsOf(frontend, M1, 2);
    const proposals = toolCallsOf(frontend, M1).filter((c) => c.tool === "propose_parallel");
    expect(proposals.map((c) => c.outcome)).toEqual(["error", "error", "error", "error", "done", "done"]);
    expect(proposals[0]!.resultSummary).toContain("阶段 s3 的前置阶段 s1 还没验收");
    expect(proposals[1]!.resultSummary).toContain("不在工作目录");
    expect(proposals[2]!.resultSummary).toContain("不存在");
    expect(proposals[3]!.resultSummary).toContain("没有「第一步」");
    // 上一张卡过期了，点它"已被处理"；新卡的子 agent 编号接着往下排
    const first = cardsOf(frontend).find((c) => c.type === "parallel" && c.id !== second.id)!;
    expect(cardsOf(frontend).filter((c) => c.id === first.id).at(-1)?.status).toBe("expired");
    expect(await frontend.cardAction({ cardId: first.id, action: "parallel", expectedVersion: 2 })).toMatchObject({ ok: false, error: { code: "conflict", message: "已被处理" } });
    expect((second.payload as ParallelCardPayload).agents.map((a) => a.agentId)).toEqual(["sa-3"]);

    ok(await frontend.cardAction({ cardId: second.id, action: "parallel", expectedVersion: 1 }));
    await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "completed", "任务完成");
    const completes = toolCallsOf(frontend, M1).filter((c) => c.tool === "complete_stage" && c.scope.agentId === undefined);
    expect(completes[0]).toMatchObject({ outcome: "error" });
    expect(completes[0]!.resultSummary).toContain("还有子 agent（sa-3）在做");
    // s1 验收后 s2 还在子 agent 手里：运行时替维护者开始了不依赖它的 s3
    const s3Started = tasksOf(frontend).find((e) => e.change === "stage_started" && e.stageId === "s3")!;
    expect(s3Started).toMatchObject({ by: "system" });
    expect(stageStates(s3Started.task)).toEqual({ s1: "accepted", s2: "running", s3: "running" });
  }, 180_000);
});

/**
 * "子 agent 停下"的底座：维护者提议把 s1 交给 sa-1，用户同意后自己切到 s2；sa-1 去读项目外的文件，
 * 停在等用户批准上（子进程活着；等审批的时长照 config）
 */
async function stoppableSetup(reuse?: { dataDir: string; homeDir: string }, config?: StartTestDaemonOptions["config"]) {
  const dirs = reuse ?? { dataDir: makeTempDir("ergou-data-"), homeDir: makeTempDir("ergou-home-") };
  const outside = path.join(dirs.homeDir, "参考资料.txt");
  fs.writeFileSync(outside, "参考");
  const td = await startTestDaemon({
    reuse: dirs,
    ...(config ? { config } : {}),
    maintainer: maintainerScript(parallelPlan(), [
      propose([{ stageId: "s1", instructions: "读一下参考资料，写 a.txt" }]),
      say("等你确认"),
      // 用户同意了：s1 交给 sa-1，自己去做 s2
      call("start_stage", { stageId: "s2" }),
      say("我在做 s2"),
      say("收到"),
      say("好"),
    ]),
    subAgent: () => [call("read", { path: outside }), say("读到了")],
  });
  const frontend = await connect(td.url);
  return { td, frontend, dirs };
}

/** 发起任务、确认计划，同意 sa-1 的并行，等它停在审批上、维护者切到 s2；返回任务 id 和 sa-1 的审批卡 */
async function waitingSubAgent(td: TestDaemon, frontend: TestFrontend): Promise<{ taskId: string; approval: Card }> {
  const taskId = await confirmTask(td, frontend, "两个文件");
  const card = await parallelCard(frontend);
  ok(await frontend.cardAction({ cardId: card.id, action: "parallel", expectedVersion: 1 }));
  // sa-1 读项目外的文件：任务里"越出项目目录"没有授权，先问用户；审批卡写明是哪个子 agent
  const approval = await cardWhere(frontend, (c) => c.type === "approval", "sa-1 的审批卡");
  expect(approval.payload).toMatchObject({ source: `任务「两个文件」阶段 s1 的子 agent sa-1` });
  expect(td.daemon.approvals.list().at(-1)?.origin).toMatchObject({ agentId: "sa-1", taskId, stageId: "s1" });
  // 维护者切到了 s2：两个阶段都在做，维护者的当前阶段是 s2（不按计划里的顺序取 s1）
  await turnsOf(frontend, M1, 3);
  expect(stageStates(td.daemon.tasks.get(taskId)!)).toEqual({ s1: "running", s2: "running" });
  expect(currentStageOf(td, taskId)).toBe("s2");
  return { taskId, approval };
}

describe("子 agent 停下", () => {
  it("任务暂停：它的子 agent 随之停下（进程退出），维护者会话里一条说明（继续后维护者用到）；继续后维护者的当前阶段还是它自己最后开始的那个，子 agent 不自动重拉", async () => {
    const { td, frontend } = await stoppableSetup();
    const { taskId } = await waitingSubAgent(td, frontend);
    const spawned = agentSpawns(td.daemon);
    ok(await frontend.taskAction({ taskId, action: "pause" }));
    const stopped = await messageWhere(frontend, M1, (m) => m.agentId === "sa-1" && m.message.speaker === "system", "sa-1 停下的说明");
    expect(stopped).toMatchObject({ agentInput: true, taskId, stageId: "s1" });
    expect(textOf(stopped)).toContain("任务暂停了，子 agent sa-1 做阶段 s1「做 a.txt」，随之停下，没做完");
    await waitUntil(() => !td.daemon.agents.live().some((a) => a.agentId === "sa-1"), { describe: () => "等 sa-1 的子进程退出" });
    expect(subAgentEvents(td, SUB_AGENT_EVENTS.subAgentFinished)).toEqual([expect.objectContaining({ agentId: "sa-1", outcome: "stopped" })]);

    // 继续：维护者接着做（收到停下的说明），当前阶段还是 s2；sa-1 不会自动重拉
    ok(await frontend.taskAction({ taskId, action: "resume" }));
    await turnsOf(frontend, M1, 4);
    expect(td.daemon.tasks.get(taskId)?.state).toBe("running");
    expect(stageStates(td.daemon.tasks.get(taskId)!)).toEqual({ s1: "running", s2: "running" });
    expect(currentStageOf(td, taskId)).toBe("s2");
    expect(spawned().filter((id) => id.startsWith("sa-"))).toEqual([]);
  }, 120_000);

  it("守护进程重启：上次没做完的子 agent 交回一条“被打断了”，它的阶段不再算有子 agent 在做；维护者的当前阶段还是重启前的那个", async () => {
    const first = await stoppableSetup();
    const { taskId } = await waitingSubAgent(first.td, first.frontend);
    await first.td.daemon.stop();
    const { td, frontend } = await stoppableSetup(first.dirs);
    const interrupted = await messageWhere(frontend, M1, (m) => m.agentId === "sa-1" && m.message.speaker === "system", "sa-1 被打断的说明");
    expect(interrupted).toMatchObject({ agentInput: true, taskId, stageId: "s1" });
    expect(textOf(interrupted)).toContain("被打断了（守护进程重启）");
    expect(subAgentEvents(td, SUB_AGENT_EVENTS.subAgentFinished)).toEqual([expect.objectContaining({ agentId: "sa-1", outcome: "interrupted" })]);
    expect(td.daemon.subAgents.busyStages(taskId).size).toBe(0);
    expect(td.daemon.subAgents.ownerOf("sa-1")).toEqual({ taskId, stageId: "s1", maintainerId: "tm-1", proposalId: "par-1" });
    expect(currentStageOf(td, taskId)).toBe("s2");
  }, 120_000);
});

describe("子 agent 的审批", () => {
  it("子 agent 的调用挂起后用户才批准、子 agent 已结束：维护者收到的通知写明是子 agent 在哪个阶段的调用、批准用不上了、要做请在那个阶段里自己重新调用（会再问），不说原样重试会放行", async () => {
    // 等审批只等 1.2 秒：sa-1 的调用挂起，它这一轮接着做完、交回结果
    const { td, frontend } = await stoppableSetup(undefined, { approvals: { waitMinutes: 0.02 } });
    const taskId = await confirmTask(td, frontend, "两个文件");
    const card = await parallelCard(frontend);
    ok(await frontend.cardAction({ cardId: card.id, action: "parallel", expectedVersion: 1 }));
    const approval = await cardWhere(frontend, (c) => c.type === "approval", "sa-1 的审批卡");
    const result = await messageWhere(frontend, M1, (m) => m.agentId === "sa-1" && m.message.speaker === "system", "sa-1 交回的结果");
    expect(textOf(result)).toContain("做完了");
    expect(subAgentEvents(td, SUB_AGENT_EVENTS.subAgentFinished)).toEqual([expect.objectContaining({ agentId: "sa-1", outcome: "done" })]);

    // 事后批准：通知进维护者的会话（交给它的输入，带任务）
    ok(await frontend.cardAction({ cardId: approval.id, action: "approve", expectedVersion: approval.version }));
    const notice = await messageWhere(frontend, M1, (m) => m.agentInput === true && textOf(m).includes("用户事后批准了"), "事后批准的通知");
    expect(notice.taskId).toBe(taskId);
    const text = textOf(notice);
    expect(text).toContain("是子 agent sa-1 在阶段 s1 的调用");
    expect(text).toContain("子 agent 已结束，这次批准用不上了");
    expect(text).toContain("请在阶段 s1 里自己重新调用，会再问一次用户");
    // 不说"原样再调用一次会直接放行"，也不叫维护者切回 s1 原样重试（那是维护者自己的调用才有的通知）
    const notices = messagesOf(frontend, M1).filter((m) => m.agentInput === true).map(textOf);
    expect(notices.filter((t) => t.includes("直接放行") || t.includes("挂起的那次调用已获批准"))).toEqual([]);
  }, 120_000);
});

/** 剧本给定的用量（数字各不相同，账本里按它认出是哪次调用） */
const MAINTAINER_IN_S2: FauxUsage = { cacheHit: 0, cacheMiss: 1234, output: 12 };
const SUB_AGENT_IN_S1: FauxUsage = { cacheHit: 0, cacheMiss: 4321, output: 21 };

describe("维护者的当前阶段", () => {
  it("子 agent 做完 s1 后，维护者在 s2 的调用按 s2 的授权判（s1 的授权项拉回）；切到 s1（不再回“已经在做”）之后按 s1 的授权判；用量各记在各自的阶段", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const home = fs.realpathSync.native(homeDir);
    const outside = path.join(homeDir, "参考资料.txt");
    fs.writeFileSync(outside, "参考");
    const mkdir = (name: string) => call("bash", { command: `mkdir -p "${fwd(path.join(home, name))}"` });
    const base = parallelPlan({ bash: true });
    const grant = (id: string) => ({ grants: [{ id, tool: "make_dir", title: `在主目录建 ${id} 目录`, scope: { path: path.join(home, id) } }], temporalRules: [] });
    const plan: Plan = { ...base, stages: [{ ...base.stages[0]!, policy: grant("one") }, { ...base.stages[1]!, policy: grant("two") }] };
    const td = await startTestDaemon({
      reuse: { dataDir, homeDir },
      maintainer: maintainerScript(plan, [
        // 开始执行（s1）：提议把 s1 交给子 agent
        propose([{ stageId: "s1", instructions: "读一下参考资料，写 a.txt" }]),
        say("等你确认"),
        // 用户同意了：自己切到 s2
        call("start_stage", { stageId: "s2" }),
        withUsage(write("b.txt", "B"), MAINTAINER_IN_S2),
        say("s2 在做，等 sa-1"),
        // sa-1 做完了：在 s2 里建 two（s2 的授权项），建 one（s1 的授权项：拉回）
        mkdir("two"),
        mkdir("one"),
        // 切到 s1 收尾：按 s1 的授权项建 one，宣布 s1 完成；运行时接着开始放下的 s2
        call("start_stage", { stageId: "s1" }),
        mkdir("one"),
        completeStage("s1"),
        completeStage("s2"),
        say("都做完了"),
      ]),
      subAgent: () => [call("read", { path: outside }), withUsage(write("a.txt", "A"), SUB_AGENT_IN_S1), say("a.txt 写好了")],
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "两个文件");
    const card = await parallelCard(frontend);
    ok(await frontend.cardAction({ cardId: card.id, action: "parallel", expectedVersion: 1 }));

    // sa-1 停在审批上（s1 还有子 agent 在做）；维护者切到 s2：当前阶段 s2
    const approval = await cardWhere(frontend, (c) => c.type === "approval", "sa-1 的审批卡");
    await turnsOf(frontend, M1, 3);
    expect(currentStageOf(td, taskId)).toBe("s2");
    expect(td.daemon.tasks.get(taskId)?.stages?.focus).toBe("s2");

    // 批准 sa-1 的调用：它做完、交回结果；维护者接着做完
    ok(await frontend.cardAction({ cardId: approval.id, action: "approve", expectedVersion: approval.version }));
    await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "completed", "任务完成");
    // 任务完成在最后一次宣布完成的调用结束之前就推出来了：等那次调用的记录
    const maintainerCalls = () => toolCallsOf(frontend, M1).filter((c) => c.scope.agentId === undefined && c.tool !== "submit_plan" && c.tool !== "propose_parallel");
    await waitUntil(() => maintainerCalls().filter((c) => c.tool === "complete_stage" && c.outcome === "done").length === 2, { describe: () => "等第二次宣布完成的调用记录" });
    const calls = maintainerCalls();
    expect(calls.map((c) => [c.tool, c.outcome, c.blockedBy ?? null])).toEqual([
      ["start_stage", "done", null],
      ["write", "done", null],
      ["bash", "done", null],
      ["bash", "blocked", "pull_back"],
      ["start_stage", "done", null],
      ["bash", "done", null],
      ["complete_stage", "done", null],
      ["complete_stage", "done", null],
    ]);
    // 切到 s2 时 s1 交给了子 agent：不放下它
    expect(calls[0]!.resultSummary).toContain("开始阶段 s2");
    expect(calls[0]!.resultSummary).not.toContain("先放下");
    // 子 agent 做完后：在 s2 里 two 按 s2 的授权项做，one 属于 s1、拉回
    expect(calls[2]).toMatchObject({ withinGrant: true });
    expect(calls[3]!.resultSummary).toContain("属于阶段 s1，当前是阶段 s2");
    // 切到 s1：子 agent 交回之后不再回"已经在做了"，s2 先放下；之后 one 按 s1 的授权项做
    expect(calls[4]!.resultSummary).toContain("开始阶段 s1");
    expect(calls[4]!.resultSummary).toContain("阶段 s2 先放下");
    expect(calls[5]).toMatchObject({ withinGrant: true });
    expect(fs.existsSync(path.join(home, "one"))).toBe(true);
    expect(fs.existsSync(path.join(home, "two"))).toBe(true);
    // 放下的 s2 在 s1 验收后由运行时接着开始（维护者的当前阶段跟着回到 s2）
    const s2Again = tasksOf(frontend).filter((e) => e.change === "stage_started" && e.stageId === "s2").at(-1)!;
    expect(s2Again).toMatchObject({ by: "system", task: { stages: { focus: "s2" } } });

    // token 账本（24 号票）：维护者在 s2 时它的用量记在 s2（不按计划顺序记成 s1）；子 agent 的用量记在它自己的阶段 s1、角色是子 agent，
    // 不看维护者当时在哪个阶段，算进 s1 的预算
    const entries = td.daemon.ledger.entries({ kind: "task", id: taskId });
    expect(entries.find((e) => e.agentId === "tm-1" && e.tokens.cacheMiss === MAINTAINER_IN_S2.cacheMiss)).toMatchObject({ role: "maintainer", stageId: "s2" });
    const bySub = entries.filter((e) => e.agentId === "sa-1");
    expect(bySub.length).toBeGreaterThanOrEqual(3);
    expect(bySub.map((e) => [e.role, e.stageId])).toEqual(bySub.map(() => ["sub_agent", "s1"]));
    expect(bySub.find((e) => e.tokens.cacheMiss === SUB_AGENT_IN_S1.cacheMiss)?.tokens).toEqual(SUB_AGENT_IN_S1);
    const subTotal = bySub.reduce((n, e) => n + e.tokens.cacheHit + e.tokens.cacheMiss + e.tokens.output, 0);
    expect(td.daemon.ledger.stageTokens(taskId, "s1", { budget: true })).toBeGreaterThanOrEqual(subTotal);
  }, 180_000);

  it("有子 agent 在做的阶段不能切过去（等它交回结果）", async () => {
    const { td, frontend } = await stoppableSetup();
    const { taskId } = await waitingSubAgent(td, frontend);
    expect(() => td.daemon.taskExecution.startStage({ taskId, maintainerId: "tm-1" }, "s1")).toThrow("阶段 s1 有子 agent（sa-1）在做");
    expect(currentStageOf(td, taskId)).toBe("s2");
  }, 120_000);
});

describe("工具包收窄", () => {
  it("维护者的工具包收窄（模拟 14 号票改计划）后调 reassemble：活着的子 agent 做完手头这一步（当前的工具调用结束）就停掉，按新的交集重新拉起、接着原来的会话做；工具包没变的不动", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const outside = path.join(homeDir, "参考资料.txt");
    fs.writeFileSync(outside, "参考");
    const td = await startTestDaemon({
      reuse: { dataDir, homeDir },
      maintainer: maintainerScript(parallelPlan({ bash: true }), [propose([{ stageId: "s2", instructions: "读一下参考资料，写 b.txt" }]), say("等你确认"), say("等子 agent"), say("收到")]),
      // 第一次拉起：停在审批上，批准后接着写 b.txt；按新的装配重新拉起后：把看到的上下文原样交回
      subAgent: (_agentId, spawn) => (spawn === 1 ? [call("read", { path: outside }), write("b.txt", "B"), say("写好了")] : [{ kind: "echo_context" }]),
    });
    const requests = spawnRequests(td);
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "两个文件");
    const card = await parallelCard(frontend);
    ok(await frontend.cardAction({ cardId: card.id, action: "parallel", expectedVersion: 1 }));
    const approval = await cardWhere(frontend, (c) => c.type === "approval", "sa-1 的审批卡");
    const first = requests().find((r) => r.agentId === "sa-1")!;
    expect(first).toMatchObject({ continueSession: false });
    expect(first.tools).toContain("bash");
    expect(first.hostTools).toContain("git_commit");

    // 工具包没变：不动
    expect(td.daemon.subAgents.reassemble(taskId)).toEqual([]);

    // 模拟 14 号票改计划：确认的计划改成 bash 关着
    const decided = td.daemon.store.read(TASKS_CHANNEL, 0, TASK_EVENTS.planDecided).at(-1)!.payload as PlanDecidedPayload;
    td.daemon.store.append({ channel: TASKS_CHANNEL, type: TASK_EVENTS.planDecided, payload: { ...decided, plan: { ...decided.plan!, toolkit: { ...decided.plan!.toolkit, bash: false } } } });
    expect(td.daemon.subAgents.reassemble(taskId)).toEqual(["sa-1"]);
    // 手头这一步（读文件，在等批准）还没做完：先不动它
    expect(td.daemon.agents.live().map((a) => a.agentId)).toContain("sa-1");
    expect(requests().filter((r) => r.agentId === "sa-1")).toHaveLength(1);

    // 批准：读文件这一步做完，停掉它、按新的装配重新拉起（下一步写 b.txt 不再在旧的装配里做）
    ok(await frontend.cardAction({ cardId: approval.id, action: "approve", expectedVersion: approval.version }));
    // 重新拉起：接着原来的会话，没有 bash 和带类型的 bash 工具；交给它一条"工具包已变更"
    const result = await messageWhere(frontend, M1, (m) => m.agentId === "sa-1" && m.message.speaker === "system", "sa-1 的结果");
    const second = requests().filter((r) => r.agentId === "sa-1")[1]!;
    expect(second).toMatchObject({ continueSession: true, hostTools: [] });
    expect(second.tools).not.toContain("bash");
    // 它看到的上下文：原来的工作说明还在（接着原来的会话），后面是"工具包已变更"的说明（工具的增减由 pi 记在会话里）
    const seen = textOf(result);
    expect(seen).toContain("[user] 你是子 agent sa-1");
    // 读文件那一步做完了才停（结果在会话里）
    expect(seen).toContain("[toolResult] read: 参考");
    expect(seen).toContain("[user] 工具包已变更");
    expect(seen).toContain("现在 bash 关，联网关");
    expect(subAgentEvents(td, SUB_AGENT_EVENTS.subAgentStarted).map((p) => p.agentId)).toEqual(["sa-1"]);
    expect(subAgentEvents(td, SUB_AGENT_EVENTS.subAgentFinished)).toEqual([expect.objectContaining({ agentId: "sa-1", outcome: "done" })]);
  }, 120_000);
});

describe("名额", () => {
  it("子 agent 不占任务的执行名额：名额满时派出子 agent，排队中的任务不会提前开工；子 agent 占子进程名额，满了排队，活动状态显示“排队”", async () => {
    const plan = parallelPlan();
    const td = await startTestDaemon({
      // 任务的执行名额只有 1 个；子进程最多 4 个：秘书（预留）、两个维护者，只剩 1 个给子 agent
      config: { tasks: { maxRunning: 1 }, agents: { maxLive: 4 } },
      maintainer: (maintainerId, spawn) =>
        spawn === 1
          ? [submitPlanStep(plan), say("计划交上去了")]
          : maintainerId === "tm-1"
            ? [
                propose([
                  { stageId: "s1", instructions: "写 a.txt" },
                  { stageId: "s2", instructions: "写 b.txt" },
                ]),
                say("等你确认"),
                say("等子 agent 的结果"),
                say("收到一个"),
                completeStage("s1"),
                completeStage("s2"),
                say("都做完了"),
              ]
            : [say("开始做")],
      subAgent: (agentId) => (agentId === "sa-1" ? [write("a.txt", "A"), say("a.txt 写好了")] : [write("b.txt", "B"), say("b.txt 写好了")]),
    });
    const frontend = await connect(td.url, 2);
    const t1 = await confirmTask(td, frontend, "任务一");
    await taskWhere(frontend, (e) => e.task.id === t1 && e.change === "started", "任务一开始执行");
    const card = await parallelCard(frontend);
    await turnsOf(frontend, M1, 2);
    const t2 = await confirmTask(td, frontend, "任务二");
    await turnsOf(frontend, maintainerChannel("tm-2"), 1);
    expect(td.daemon.tasks.get(t2)?.state).toBe("queued");
    // 子进程：秘书、两个维护者都活着（闲着），只剩一个名额
    await waitUntil(() => td.daemon.agents.live().length === 3, { describe: () => `等三个子进程都活着：${td.daemon.agents.live().map((a) => a.agentId).join("、")}` });

    ok(await frontend.cardAction({ cardId: card.id, action: "parallel", expectedVersion: 1 }));
    // 第二个子 agent 排队（活动状态"排队"），第一个做完、名额空出来后才拉起
    await waitUntil(() => activityOf(frontend).some((p) => p.agentId === "sa-2" && p.state === "queued"), { describe: () => "等 sa-2 排队" });
    await taskWhere(frontend, (e) => e.task.id === t1 && e.change === "completed", "任务一完成");
    const sa2 = activityOf(frontend).filter((p) => p.agentId === "sa-2").map((p) => p.state);
    // 先排队；名额空出来后拉起就是"干活中"（25 号票：被唤起），做完休眠
    expect(sa2.slice(0, 2)).toEqual(["queued", "working"]);
    await waitUntil(() => activityOf(frontend).filter((p) => p.agentId === "sa-2").at(-1)?.state === "sleeping", { describe: () => "等 sa-2 休眠" });
    expect(subAgentEvents(td, SUB_AGENT_EVENTS.subAgentFinished).map((p) => [p.agentId, p.outcome]).toSorted()).toEqual([
      ["sa-1", "done"],
      ["sa-2", "done"],
    ]);

    // 任务二一直排着，任务一完成之后才开始：任何时候执行中的任务最多一个
    await taskWhere(frontend, (e) => e.task.id === t2 && e.change === "started", "任务二开始执行");
    const board = tasksOf(frontend);
    expect(board.findIndex((e) => e.task.id === t2 && e.change === "started")).toBeGreaterThan(board.findIndex((e) => e.task.id === t1 && e.change === "completed"));
    const running = new Map<string, boolean>();
    let most = 0;
    for (const e of board) {
      running.set(e.task.id, e.task.state === "running");
      most = Math.max(most, [...running.values()].filter(Boolean).length);
    }
    expect(most).toBe(1);
  }, 240_000);
});

describe("开发类：git worktree 和合并", () => {
  it("维护者在工作目录内为两个子 agent 各建一个 git worktree；子 agent 各在自己的 worktree 里改动并提交，主工作目录看不到；维护者用带类型的合并工具合并后两边的改动都在，合并在时间线上是带类型的工具调用、不带“通用 bash”标记", async () => {
    // 任务 t-1 的工作目录（输出区里的 outputs/t-1）事先建成一个临时 git 仓库，worktree 的目录不进主仓库
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const work = path.join(dataDirLayout(dataDir).outputs, "t-1");
    initRepo(work, { "README.md": "# demo\n", ".gitignore": ".worktrees/\n" });
    const subAgentScript = (file: string, content: string): FauxStep[] => [write(file, content), call("git_commit", { message: `加 ${file}` }), say(`${file} 提交了`)];
    const options: StartTestDaemonOptions = {
      reuse: { dataDir, homeDir },
      maintainer: maintainerScript(parallelPlan({ bash: true }), [
        call("bash", { command: "git worktree add -q .worktrees/a -b sub-a && git worktree add -q .worktrees/b -b sub-b" }),
        propose([
          { stageId: "s1", instructions: "在 a.txt 写 A，提交", workDir: ".worktrees/a" },
          { stageId: "s2", instructions: "在 b.txt 写 B，提交", workDir: ".worktrees/b" },
        ]),
        say("等你确认"),
        say("等子 agent 的结果"),
        say("收到一个"),
        say("两个都好了，等你说合并"),
        // 用户说"合并吧"
        call("git_merge", { branch: "sub-a" }),
        call("git_merge", { branch: "sub-b" }),
        completeStage("s1"),
        completeStage("s2"),
        say("合并好了，两个阶段都宣布完成了"),
      ]),
      subAgent: (agentId) => (agentId === "sa-1" ? subAgentScript("a.txt", "A") : subAgentScript("b.txt", "B")),
    };
    const td = await startTestDaemon(options);
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "两个文件");
    const card = await parallelCard(frontend);
    const worktreeA = fs.realpathSync.native(path.join(work, ".worktrees", "a"));
    expect((card.payload as ParallelCardPayload).agents).toMatchObject([
      { agentId: "sa-1", stageId: "s1", workDir: worktreeA, ownWorkDir: true },
      { agentId: "sa-2", stageId: "s2", ownWorkDir: true },
    ]);
    ok(await frontend.cardAction({ cardId: card.id, action: "parallel", expectedVersion: 1 }));

    // 两个子 agent 都交回了结果（维护者处理完：起草计划、开始执行、用户同意、两条结果）：各自的分支上有自己的提交，主工作目录里还看不到
    await turnsOf(frontend, M1, 5);
    expect(messagesOf(frontend, M1).filter((m) => m.agentId !== undefined && m.message.speaker === "system").map(textOf).join("\n")).toContain("合并回工作目录");
    expect(fs.existsSync(path.join(work, "a.txt"))).toBe(false);
    expect(fs.existsSync(path.join(work, "b.txt"))).toBe(false);
    expect(git(work, "show", "sub-a:a.txt")).toBe("A");
    expect(git(work, "show", "sub-b:b.txt")).toBe("B");
    expect(git(work, "status", "--porcelain")).toBe("");
    // 子 agent 的提交是带类型的提交工具，在它自己的 worktree 里
    const commits = toolCallsOf(frontend, M1).filter((c) => c.tool === "git_commit");
    expect(commits.map((c) => [c.scope.agentId, c.outcome, c.genericBash]).toSorted()).toEqual([
      ["sa-1", "done", false],
      ["sa-2", "done", false],
    ]);

    // 用户说合并：维护者用带类型的合并工具把两个分支合并回来，两边的改动都在工作目录里
    await frontend.sendText("合并吧", { conversation: M1 });
    await taskWhere(frontend, (e) => e.task.id === taskId && e.change === "completed", "任务完成");
    expect(fs.readFileSync(path.join(work, "a.txt"), "utf8")).toBe("A");
    expect(fs.readFileSync(path.join(work, "b.txt"), "utf8")).toBe("B");
    const calls = toolCallsOf(frontend, M1).filter((c) => c.scope.agentId === undefined);
    // 建 worktree 没有带类型的工具：维护者用 bash 建，标"通用 bash"
    expect(calls.find((c) => c.tool === "bash")).toMatchObject({ genericBash: true, outcome: "done" });
    expect(calls.filter((c) => c.tool === "git_merge").map((c) => ({ outcome: c.outcome, genericBash: c.genericBash }))).toEqual([
      { outcome: "done", genericBash: false },
      { outcome: "done", genericBash: false },
    ]);
  }, 240_000);
  it("开发类（工作目录是 git 仓库）提议时每个子 agent 必须有自己的、建在工作目录里的这个仓库的 git worktree：不写目录、直接用工作目录、普通目录、两个子 agent 目录重叠的提议都被拒，原因交回维护者", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const work = path.join(dataDirLayout(dataDir).outputs, "t-1");
    initRepo(work, { "README.md": "# demo\n", ".gitignore": ".worktrees/\nplain/\n" });
    const a = { stageId: "s1", instructions: "在 a.txt 写 A，提交" };
    const b = { stageId: "s2", instructions: "在 b.txt 写 B，提交" };
    const td = await startTestDaemon({
      reuse: { dataDir, homeDir },
      maintainer: maintainerScript(parallelPlan({ bash: true }), [
        call("bash", { command: "git worktree add -q .worktrees/a -b sub-a && git worktree add -q .worktrees/b -b sub-b && mkdir plain" }),
        propose([a, b]),
        propose([
          { ...a, workDir: "." },
          { ...b, workDir: ".worktrees/b" },
        ]),
        propose([
          { ...a, workDir: "plain" },
          { ...b, workDir: ".worktrees/b" },
        ]),
        propose([
          { ...a, workDir: ".worktrees/a" },
          { ...b, workDir: ".worktrees/a" },
        ]),
        propose([
          { ...a, workDir: ".worktrees/a" },
          { ...b, workDir: ".worktrees/b" },
        ]),
        say("等你确认"),
      ]),
    });
    const frontend = await connect(td.url);
    await confirmTask(td, frontend, "两个文件");
    const card = await parallelCard(frontend);
    await turnsOf(frontend, M1, 2);
    const proposals = toolCallsOf(frontend, M1).filter((c) => c.tool === "propose_parallel");
    expect(proposals.map((c) => c.outcome)).toEqual(["error", "error", "error", "error", "done"]);
    expect(proposals[0]!.resultSummary).toContain("开发类：sa-1 要有自己的目录");
    expect(proposals[1]!.resultSummary).toContain("sa-1 不能直接用工作目录");
    expect(proposals[2]!.resultSummary).toContain("sa-1 的目录 plain 不是工作目录这个仓库的 git worktree");
    expect(proposals[3]!.resultSummary).toContain("sa-1 和 sa-2 的目录重叠");
    // 只有最后一次提出了并行确认卡：两个子 agent 各在自己的 worktree 里
    expect(cardsOf(frontend).filter((c) => c.type === "parallel")).toHaveLength(1);
    expect((card.payload as ParallelCardPayload).agents.map((x) => [x.agentId, path.basename(x.workDir), x.ownWorkDir])).toEqual([
      ["sa-1", "a", true],
      ["sa-2", "b", true],
    ]);
  }, 120_000);
});
