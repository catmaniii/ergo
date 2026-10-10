// 主切面：任务发起与计划确认（规格第 7、8 节，12 号票）。真的守护进程，秘书和维护者都接 faux 剧本，测试扮演前端。
// - 三条发起路径：点"发起任务"按钮（原话记成"用户发言"素材，选的项目写进任务）、秘书按用户在消息里的要求建任务卡、
//   秘书给"建议发起任务"卡（用户点了才建）；
// - 意图澄清：提问卡成批提问、每题带推荐，"全按推荐"一次提交，答案作为通知交回秘书；
// - 任务书交给任务自己的维护者（新拉起的子进程、新会话，起草时只能读），维护者用"提交计划"交出结构化的计划；
// - 计划卡：勾掉、收窄授权项、改假设栏后确认（任务转排队中），附意见打回（任务回到规划中，意见交回维护者，重新提交出新卡）。
// - 维护者会话里有消息被彻底删除（21 号票）：会话文件里的原话也改写成删除标记。
import fs from "node:fs";
import path from "node:path";
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  type InboxItemEventPayload,
  maintainerChannel,
  nowIso,
  type MessageEventPayload,
  type MessagesPurgedEventPayload,
  type PlanCardPayload,
  PURGED_TEXT,
  type QuestionsAnsweredPayload,
  type QuestionsCardPayload,
  type ResponseFrame,
  type TaskEventPayload,
  type TokenTotalsEventPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { buildAgentNotice } from "../../src/conversation/messages.ts";
import { BUILTIN_CATEGORY_IDS } from "../../src/guard/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { seedProject } from "../helpers/projects.ts";
import { waitUntil } from "../helpers/process.ts";
import { saveOrCheckRecording } from "../helpers/recording.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;
const MAINTAINER = maintainerChannel("tm-1");

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });

const suggest = (title: string) => call("suggest_task", { title, why: "这周你手动导出了三次账单" });
const pick = (q: string) => call("ask_questions", { questions: [{ question: q, options: ["A", "B"], recommended: "A" }, { question: "还有吗？", options: [], recommended: "没了" }] });
const createTask = call("create_task", { title: "X 的调研", summary: "帮我整理一份 X 的调研" });
const brief = {
  taskId: "t-1",
  goal: "整理一份 X 的调研",
  acceptanceCriteria: ["覆盖三种主流方案", "附来源"],
  constraints: ["只用公开资料"],
  projects: [],
  memoryScope: "用户的技术背景",
};
const writeBrief = call("write_task_brief", brief);

const messagesOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => f.payload as MessageEventPayload);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const tasksOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.task }).map((f) => f.payload as TaskEventPayload);
/** 看板上任务名下的用量合计（24 号票：维护者每次模型调用记账后一条） */
const tokenTotalsOf = (frontend: TestFrontend) => frontend.events({ channel: BOARD, type: EVENT_TYPES.tokenTotals }).map((f) => f.payload as TokenTotalsEventPayload);
/** 等维护者处理完 n 条输入 */
const maintainerTurns = (frontend: TestFrontend, n: number) =>
  waitUntil(() => frontend.events({ channel: MAINTAINER, type: EVENT_TYPES.turnEnd }).length >= n, { timeoutMs: 20_000, describe: () => `等维护者处理完 ${n} 条输入` });
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

async function connect(url: string, channels: string[] = [SECRETARY, CARDS, BOARD, INBOX]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

/** 用户说一句话，等秘书这一轮结束 */
async function tell(frontend: TestFrontend, text: string) {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
}

/**
 * 等到收到过满足条件的东西（不管和别的频道上的事件谁先谁后：秘书、维护者、用户的动作各走各的），返回最新的那个。
 * 只在同一个频道上按先后等时用 frontend.next
 */
async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs: 20_000, describe: () => `等${what}` });
  return found!;
}
const cardWhere = (frontend: TestFrontend, match: (card: Card) => boolean, what = "卡片") => eventually(() => cardsOf(frontend), match, what);
const taskWhere = (frontend: TestFrontend, match: (e: TaskEventPayload) => boolean, what = "看板上的任务") => eventually(() => tasksOf(frontend), match, what);
const ofType = (type: string) => (card: Card) => card.type === type;

describe("发起任务的三条路", () => {
  it("点“发起任务”按钮：不经秘书判断直接建出任务（规划中）并在看板频道推送；同一个幂等键重发不多建；秘书收到通知接着澄清", async () => {
    const { url, daemon } = await startTestDaemon({ secretary: [{ kind: "echo_context" }] });
    const frontend = await connect(url);
    expect(ok(await frontend.startTask("调研一下家用 NAS\n预算 3000 以内，要安静", "k-start"))).toEqual({ taskId: "t-1" });

    const created = (await frontend.next(BOARD, EVENT_TYPES.task)).payload as TaskEventPayload;
    expect(created).toMatchObject({
      change: "created",
      from: null,
      by: "user",
      task: { id: "t-1", title: "调研一下家用 NAS", summary: "调研一下家用 NAS\n预算 3000 以内，要安静", state: "planning", origin: "button", maintainerId: "tm-1", projects: [] },
    });
    expect(created.task.stages).toBeUndefined();
    expect(ok(await frontend.startTask("调研一下家用 NAS\n预算 3000 以内，要安静", "k-start"))).toEqual({ taskId: "t-1" });
    expect(daemon.tasks.list().map((t) => t.id)).toEqual(["t-1"]);

    // 秘书：一条交给它的系统通知（不是用户说的），它处理这一条
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const [notice, reply] = messagesOf(frontend, SECRETARY);
    expect(notice).toMatchObject({ agentInput: true, message: { speaker: "system" } });
    expect(textOf(notice!)).toContain("用户点「发起任务」发起了长程任务：调研一下家用 NAS");
    expect(textOf(reply!)).toMatch(/\[user\] \[系统通知\]\n\[.*\]\n用户点「发起任务」发起了长程任务：调研一下家用 NAS\n预算 3000 以内，要安静\n用户选了：不涉及项目。\n长程任务 t-1「调研一下家用 NAS」已建好（规划中）/);

    // 用户写的原话是用户发言（本人、打的字），和在会话里说的一样记成素材
    await waitUntil(() => daemon.materials.list({ kind: "user_utterance" }).length > 0);
    expect(daemon.materials.list({ kind: "user_utterance" })).toEqual([
      expect.objectContaining({
        source: "self",
        task: "t-1",
        context: ["start_task_button"],
        ref: expect.objectContaining({ recordId: "t-1" }),
        segments: [expect.objectContaining({ form: "typed", source: "self", text: "调研一下家用 NAS\n预算 3000 以内，要安静" })],
      }),
    ]);
  });

  it("“发起任务”时选了涉及的项目：写进任务，交给秘书的通知里写明（写任务书时以它为依据），也记在素材上", async () => {
    const { url, daemon } = await startTestDaemon({ secretary: [{ kind: "echo_context" }] });
    // 选的项目要在项目列表里（15 号票起核对，见 projects.test.ts）
    seedProject(daemon, "记账本");
    seedProject(daemon, "家庭网盘");
    const frontend = await connect(url);
    ok(await frontend.startTask("给记账本加周报", "k-p", ["记账本", "家庭网盘", "记账本"]));
    const created = await taskWhere(frontend, (e) => e.change === "created");
    expect(created.task).toMatchObject({ id: "t-1", projects: ["记账本", "家庭网盘"] });
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    expect(textOf(messagesOf(frontend, SECRETARY)[0]!)).toContain("用户选了涉及的项目：记账本、家庭网盘（写任务书时以它为依据）。");
    await waitUntil(() => daemon.materials.list({ kind: "user_utterance" }).length > 0);
    expect(daemon.materials.list({ kind: "user_utterance" })[0]?.context).toEqual(["start_task_button", "project:记账本", "project:家庭网盘"]);
  });

  it("用户在消息里点明了发起任务（58 号票起要点明）：秘书用建任务工具直接建任务卡（规划中），这一轮不产生“建议发起任务”卡；秘书没有建定时作业的工具", async () => {
    const { url } = await startTestDaemon({ secretary: [createTask, { kind: "echo_context" }] });
    const frontend = await connect(url);
    await tell(frontend, "发起任务：帮我整理一份 X 的调研");

    expect(tasksOf(frontend)).toEqual([
      expect.objectContaining({ change: "created", from: null, by: "secretary", task: expect.objectContaining({ id: "t-1", title: "X 的调研", summary: "帮我整理一份 X 的调研", state: "planning", origin: "request", kind: "long_running" }) }),
    ]);
    expect(cardsOf(frontend)).toEqual([]);
    const seen = textOf(messagesOf(frontend, SECRETARY).at(-1)!);
    expect(seen).toContain("[toolResult] create_task: 已建好长程任务 t-1「X 的调研」（规划中）");
    // 秘书的工具：没有对卡片做动作的，也没有建定时作业的（定时作业只通过任务的计划建）
    expect(seen.split("\n").filter((l) => l.startsWith("[tool]"))).toEqual([
      "[tool] read",
      "[tool] write",
      "[tool] edit",
      "[tool] ls",
      "[tool] grep",
      "[tool] find",
      "[tool] bash",
      "[tool] read_attachment",
      "[tool] send_attachment",
      "[tool] create_reminder",
      "[tool] update_reminder",
      "[tool] cancel_reminder",
      "[tool] search_materials",
      "[tool] propose_quick_action",
      // 58 号票：两种任务各一个发起工具（只有用户点明了才能用）
      "[tool] start_workflow",
      "[tool] create_task",
      // 75 号票：把要花时间的事交给后台（普通任务）
      "[tool] delegate_task",
      "[tool] suggest_task",
      "[tool] ask_questions",
      "[tool] write_task_brief",
      "[tool] suggest_project",
      // 22 号票的只读工具：查看板、读项目档案、列出待我处理、把卡片放进聊天（不对卡片做动作）
      "[tool] view_board",
      "[tool] read_project_records",
      "[tool] list_inbox",
      "[tool] show_card",
      // 70 号票：联网搜索、读网页
      "[tool] web_search",
      "[tool] web_fetch",
      // 32 号票：每个会话都有的口语总结（用户发语音时用）
      "[tool] spoken_summary",
    ]);
  });

  it("秘书给“建议发起任务”卡：只产生一张卡、不建任务；用户点“作为长程任务”后才建出（用户发起），秘书收到通知；另一张点“不用了”是回避信号", async () => {
    const { url, daemon } = await startTestDaemon({ secretary: [suggest("每周汇总账单"), say("要不要我发起一个任务？"), say("好，我先理解一下"), suggest("整理旧照片"), say("也可以考虑这个")] });
    const frontend = await connect(url);
    await tell(frontend, "又导出了一次账单，好烦");

    const card = await cardWhere(frontend, ofType("suggest_task"));
    expect(card).toMatchObject({ status: "pending", payload: { title: "每周汇总账单", why: "这周你手动导出了三次账单" }, text: "建议发起任务：每周汇总账单（这周你手动导出了三次账单）" });
    expect(tasksOf(frontend)).toEqual([]);
    expect(daemon.tasks.list()).toEqual([]);

    expect(ok(await frontend.cardAction({ cardId: card.id, action: "start_task", expectedVersion: 1 }))).toEqual({ cardId: card.id, version: 2 });
    const created = await taskWhere(frontend, (e) => e.change === "created");
    expect(created).toMatchObject({ change: "created", by: "user", task: { id: "t-1", title: "每周汇总账单", summary: "这周你手动导出了三次账单", state: "planning", origin: "suggestion", kind: "long_running" } });
    expect(await cardWhere(frontend, (c) => c.id === card.id && c.version === 2)).toMatchObject({ status: "handled", payload: { taskId: "t-1", kind: "long_running" }, outcome: { action: "start_task" } });
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const notice = messagesOf(frontend, SECRETARY).find((m) => m.agentInput);
    expect(textOf(notice!)).toBe("用户在建议卡上点了「作为长程任务」。长程任务 t-1「每周汇总账单」已建好（规划中）。先说出你的理解，需要时用 ask_questions 成批提问（每题带推荐答案），对齐后用 write_task_brief 写任务书。");

    await tell(frontend, "照片也乱");
    const other = await cardWhere(frontend, (c) => c.type === "suggest_task" && c.id !== card.id);
    ok(await frontend.cardAction({ cardId: other.id, action: "dismiss", expectedVersion: 1, note: "以后再说" }));
    await frontend.next(CARDS, EVENT_TYPES.cardDismissed);
    expect(daemon.tasks.list()).toHaveLength(1);
    expect(daemon.materials.list({ kind: "avoidance_signal" })).toEqual([
      expect.objectContaining({ source: "self", context: ["dismissed", "card:suggest_task", "action:dismiss"], ref: expect.objectContaining({ cardId: other.id }) }),
    ]);
  }, 60_000);
});

describe("意图澄清", () => {
  it("提问卡成批提问、每题带推荐；“全按推荐”一次提交全部答案，答案作为通知交回秘书，记成“澄清问题的回答”素材", async () => {
    const ask = call("ask_questions", {
      taskId: "t-1",
      intro: "动手之前确认几件事",
      questions: [
        { question: "调研给谁看？", options: ["自己", "团队"], recommended: "自己" },
        { question: "要不要附价格？", options: [], recommended: "要", why: "你上次问过价格" },
      ],
    });
    const { url, daemon } = await startTestDaemon({ secretary: [createTask, ask, say("我理解你要的是一份 X 的调研，对吗？先回答这两个问题。"), { kind: "echo_context" }] });
    const frontend = await connect(url);
    await tell(frontend, "发起任务：帮我整理一份 X 的调研");

    const card = await cardWhere(frontend, ofType("questions"));
    expect(card.payload).toEqual({
      taskId: "t-1",
      intro: "动手之前确认几件事",
      questions: [
        { id: "q1", question: "调研给谁看？", options: ["自己", "团队"], recommended: "自己" },
        { id: "q2", question: "要不要附价格？", options: [], recommended: "要", why: "你上次问过价格" },
      ],
    } satisfies QuestionsCardPayload);
    // 聊天里：秘书这一轮的卡片引用
    expect(messagesOf(frontend, SECRETARY).some((m) => m.message.parts.some((p) => p.type === "card_ref" && p.cardId === card.id))).toBe(true);

    // 前端的"全按推荐"：每题都填推荐的答案，一次提交
    const all = (card.payload as QuestionsCardPayload).questions.map((q) => ({ questionId: q.id, answer: q.recommended }));
    ok(await frontend.cardAction({ cardId: card.id, action: "answer", expectedVersion: 1, input: { answers: all } }));
    expect(await cardWhere(frontend, (c) => c.id === card.id && c.version === 2)).toMatchObject({ status: "handled", outcome: { action: "answer", note: "全按推荐" }, payload: { answers: all } });
    const answered = await eventually(() => frontend.events({ channel: CARDS, type: EVENT_TYPES.questionsAnswered }).map((f) => f.payload as QuestionsAnsweredPayload), () => true, "回答");
    expect(answered.answers).toEqual([
      { questionId: "q1", question: "调研给谁看？", answer: "自己", recommended: "自己", followedRecommendation: true, chosenOption: true },
      { questionId: "q2", question: "要不要附价格？", answer: "要", recommended: "要", followedRecommendation: true, chosenOption: true },
    ]);

    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const seen = textOf(messagesOf(frontend, SECRETARY).at(-1)!);
    expect(seen).toContain("用户回答了提问卡（任务 t-1），全按推荐：\n1. 调研给谁看？ → 自己（推荐的）\n2. 要不要附价格？ → 要（推荐的）");
    expect(daemon.materials.list({ kind: "clarification_answer" })).toEqual([
      expect.objectContaining({
        source: "self",
        task: "t-1",
        context: ["card:questions", "all_recommended"],
        ref: expect.objectContaining({ cardId: card.id }),
        segments: [
          expect.objectContaining({ form: "choice", source: "self", notes: ["agent_proposed"], text: "调研给谁看？ → 自己" }),
          expect.objectContaining({ form: "choice", source: "self", notes: ["agent_proposed"], text: "要不要附价格？ → 要" }),
        ],
      }),
    ]);
  }, 60_000);

  it("自己写的答案是用户自己的话；漏答的被拒；提问卡被关掉是回避信号", async () => {
    const { url, daemon } = await startTestDaemon({ secretary: [pick("选哪个？"), say("请回答"), say("收到"), pick("再选一次？"), say("请回答")] });
    const frontend = await connect(url);
    await tell(frontend, "帮我挑一个");
    const card = await cardWhere(frontend, ofType("questions"));
    const missing = await frontend.cardAction({ cardId: card.id, action: "answer", expectedVersion: 1, input: { answers: [{ questionId: "q1", answer: "A" }] } });
    expect(missing).toMatchObject({ ok: false, error: { code: "bad_params", message: "还有题没回答：q2" } });
    ok(await frontend.cardAction({ cardId: card.id, action: "answer", expectedVersion: 1, input: { answers: [{ questionId: "q1", answer: "C，都不要" }, { questionId: "q2", answer: "没了" }] } }));
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    expect(daemon.materials.list({ kind: "clarification_answer" })[0]?.segments).toEqual([
      expect.objectContaining({ form: "typed", source: "self", notes: [], text: "选哪个？ → C，都不要" }),
      expect.objectContaining({ form: "choice", notes: ["agent_proposed"], text: "还有吗？ → 没了" }),
    ]);

    await tell(frontend, "再来一个");
    const second = await cardWhere(frontend, (c) => c.type === "questions" && c.id !== card.id);
    ok(await frontend.cardAction({ cardId: second.id, action: "dismiss", expectedVersion: 1 }));
    await frontend.next(CARDS, EVENT_TYPES.cardDismissed);
    expect(daemon.materials.list({ kind: "avoidance_signal" })).toEqual([expect.objectContaining({ context: ["dismissed", "card:questions", "action:dismiss"] })]);
  }, 60_000);
});

describe("任务书交给维护者，维护者提交计划", () => {
  it("秘书写的任务书存进二狗的存储，作为输入交给任务的维护者（新拉起的子进程、新会话，起草时只能读）；维护者用“提交计划”交出结构化的计划，生成计划卡放进待我处理，任务转待确认", async () => {
    const { url, daemon } = await startTestDaemon({
      secretary: [createTask, writeBrief, say("任务书交给维护者了")],
      maintainer: [submitPlanStep(), { kind: "echo_context" }],
    });
    const frontend = await connect(url, [SECRETARY, CARDS, BOARD, INBOX, MAINTAINER]);
    await tell(frontend, "发起任务：帮我整理一份 X 的调研");
    expect(daemon.tasks.brief("t-1")).toEqual({ brief: { goal: brief.goal, acceptanceCriteria: brief.acceptanceCriteria, constraints: brief.constraints, projects: [], memoryScope: brief.memoryScope }, revision: 1 });

    const card = await cardWhere(frontend, ofType("plan"), "计划卡");
    const payload = card.payload as PlanCardPayload;
    expect(payload).toMatchObject({ taskId: "t-1", taskTitle: "X 的调研", revision: 1, planId: "t-1-p1", goal: "整理一份 X 的调研", globalCategories: [...BUILTIN_CATEGORY_IDS] });
    // 每项授权在守卫眼里的样子：卡上的授权行和停点由它生成
    expect(payload.grantInfo).toEqual({
      "fetch-docs": { toolTitle: "只读的联网命令（ping、查 GitHub 上的东西……）", categoryTitles: [], disposition: "do" },
      "push-report": { toolTitle: "git 推送", categoryTitles: ["以我的名义对外发送或发布"], disposition: "planned_only" },
    });
    // 卡上的计划就是存储里的那份：字段齐全，全局关注类别的名字由运行时补上
    expect(payload.plan).toEqual({ ...samplePlan(), watchCategories: daemon.tasks.globalWatchCategories().map((c) => ({ id: c.id, title: c.title })) });
    expect(daemon.tasks.plan("t-1-p1")).toMatchObject({ status: "pending", cardId: card.id, plan: payload.plan });
    expect(card).toMatchObject({ urgency: "blocking", text: "计划：X 的调研（第 1 版，2 个阶段，约 320000 token）" });

    const item = await eventually(() => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }).map((f) => (f.payload as InboxItemEventPayload).item), () => true, "待我处理");
    expect(item).toMatchObject({ kind: "card", cardId: card.id, title: "计划等你确认：X 的调研", source: "任务「X 的调研」", urgency: "blocking" });
    const moved = await taskWhere(frontend, (e) => e.change === "plan_submitted");
    expect(moved).toMatchObject({ change: "plan_submitted", from: "planning", by: "maintainer", task: { state: "awaiting_confirm", planCardId: card.id, stages: { total: 2 } } });

    // 维护者的会话：任务书（运行时的通知）是第一条输入，消息都带着所属的任务；计划卡出现在它的会话里
    await maintainerTurns(frontend, 1);
    const maintainerMessages = messagesOf(frontend, MAINTAINER);
    expect(maintainerMessages.every((m) => m.taskId === "t-1")).toBe(true);
    expect(maintainerMessages[0]).toMatchObject({ agentInput: true, message: { speaker: "system" } });
    expect(textOf(maintainerMessages[0]!)).toMatch(/^任务书：任务 t-1「X 的调研」\n目标：整理一份 X 的调研\n验收标准：\n- 覆盖三种主流方案\n- 附来源\n约束：\n- 只用公开资料\n涉及的项目：不涉及项目\n记忆范围提议：用户的技术背景/);
    expect(maintainerMessages.some((m) => m.message.parts.some((p) => p.type === "card_ref" && p.cardId === card.id))).toBe(true);
    const seen = textOf(maintainerMessages.at(-1)!);
    // 新会话：上下文里只有系统提示、这一份任务书、这一次提交
    expect(seen.split("\n").filter((l) => l.startsWith("[user]"))).toHaveLength(1);
    expect(seen).toContain("[system] 你是「二狗」里一个任务的维护者");
    expect(seen).toContain("[toolResult] submit_plan: 计划已提交（第 1 版）");
    // 起草计划时只能读、搜索和提交计划：确认之前不动手不只靠提示词（口语总结是每个会话都有的，没有副作用，32 号票；
    // 70 号票起 grep、find 照给，联网搜索、读网页每个维护者都有）
    expect(seen.split("\n").filter((l) => l.startsWith("[tool]"))).toEqual([
      "[tool] read",
      "[tool] ls",
      "[tool] grep",
      "[tool] find",
      "[tool] submit_plan",
      "[tool] web_search",
      "[tool] web_fetch",
      "[tool] spoken_summary",
    ]);
  }, 60_000);

  it("提交的计划不合格：少了全局关注类别（守护进程的检查）、不合 schema（pi 先拦下）都失败，原因返回给维护者，不出计划卡，任务还在规划中", async () => {
    const missing = samplePlan({ watchCategories: BUILTIN_CATEGORY_IDS.filter((id) => id !== "spend_money").map((id) => ({ id })) });
    const { url, daemon } = await startTestDaemon({
      secretary: [createTask, writeBrief, say("交给维护者了")],
      maintainer: [submitPlanStep(missing), { kind: "reply", toolCalls: [{ name: "submit_plan", arguments: { stages: [] } }] }, { kind: "echo_context" }],
    });
    const frontend = await connect(url, [SECRETARY, CARDS, BOARD, MAINTAINER]);
    await tell(frontend, "发起任务：帮我整理一份 X 的调研");
    await maintainerTurns(frontend, 1);
    const seen = textOf(messagesOf(frontend, MAINTAINER).at(-1)!);
    expect(seen).toContain("[toolResult] submit_plan: 计划没通过检查，改好再提交：\n- 本任务的关注类别少了全局的「花钱」（spend_money）：全局的类别一个都不能少，只能在其上增加");
    expect(seen.split("\n").filter((l) => l.startsWith("[toolResult] submit_plan")).at(-1)).not.toContain("计划已提交");
    expect(cardsOf(frontend)).toEqual([]);
    expect(daemon.tasks.get("t-1")?.state).toBe("planning");
    expect(daemon.tasks.latestPlan("t-1")).toBeUndefined();
  }, 60_000);
});

describe("彻底删除", () => {
  it("维护者会话里的消息被彻底删除：会话文件里的原话改写成删除标记；再来输入时接着同一个会话，看到的只有标记", async () => {
    const { url, daemon, dataDir } = await startTestDaemon({
      secretary: [createTask, writeBrief, say("交给维护者了")],
      maintainer: (_id, spawn) => (spawn === 1 ? [say("收到任务书")] : [{ kind: "echo_context" }]),
    });
    const frontend = await connect(url, [SECRETARY, CARDS, BOARD, MAINTAINER]);
    await tell(frontend, "发起任务：帮我整理一份 X 的调研");
    await maintainerTurns(frontend, 1);
    const sessionText = () => {
      const dir = path.join(dataDir, "sessions", "tm-1");
      return fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".jsonl")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
    };
    expect(sessionText()).toContain("覆盖三种主流方案");

    // 任务书那条（维护者的第一条输入）被彻底删除：事件日志由记忆模块改写，这里只看会话文件
    const notice = frontend.events({ channel: MAINTAINER, type: EVENT_TYPES.message })[0]!;
    const purge: MessagesPurgedEventPayload = {
      messages: [{ seq: notice.seq, messageId: (notice.payload as MessageEventPayload).message.id }],
      materialIds: [],
      toolCallIds: [],
      mediaIds: [],
      deletedAt: nowIso(),
    };
    daemon.store.append({ channel: MAINTAINER, type: EVENT_TYPES.messagesPurged, payload: purge });
    await waitUntil(() => !sessionText().includes("覆盖三种主流方案"), { describe: () => "等维护者的会话文件改写完" });
    expect(sessionText()).toContain(PURGED_TEXT);

    // 再来一条输入：重新唤起，接着同一个会话，上下文里那条输入只剩删除标记
    daemon.store.append(buildAgentNotice(MAINTAINER, "用户问计划什么时候好", "test-notice", { taskId: "t-1" }).event);
    await maintainerTurns(frontend, 2);
    const seen = textOf(messagesOf(frontend, MAINTAINER).at(-1)!);
    expect(seen).toContain("用户问计划什么时候好");
    expect(seen).toContain(PURGED_TEXT);
    expect(seen).not.toContain("覆盖三种主流方案");
  }, 60_000);
});

/** 走到待确认：秘书建任务、写任务书，维护者提交计划；返回计划卡 */
async function untilPlanCard(maintainer: FauxStep[] = [submitPlanStep(), say("计划交上去了")]) {
  const test = await startTestDaemon({ secretary: [createTask, writeBrief, say("交给维护者了")], maintainer });
  const frontend = await connect(test.url, [SECRETARY, CARDS, BOARD, INBOX, MAINTAINER]);
  await tell(frontend, "发起任务：帮我整理一份 X 的调研");
  const card = await cardWhere(frontend, ofType("plan"), "计划卡");
  await maintainerTurns(frontend, 1);
  return { ...test, frontend, card };
}

describe("计划卡", () => {
  it("勾掉一项、收窄一项授权后确认：存储里的计划和授权项随之改变，卡上的和存储里的逐条一致；任务转排队中；记成“审批决定”素材", async () => {
    const { frontend, card, daemon } = await untilPlanCard();
    const input = { removeGrants: ["fetch-docs"], narrowGrants: [{ grantId: "push-report", maxUses: 1, scope: { branch: ["main"] } }], assumptions: ["只用公开资料", "报告用中文"] };
    // 放宽被拒（次数加多）
    expect(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: { narrowGrants: [{ grantId: "push-report", maxUses: 9 }] } })).toMatchObject({
      ok: false,
      error: { code: "bad_params", message: "授权项只能勾掉或收窄：授权项 push-report：次数从 2 改成了 9" },
    });
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input }));

    const confirmed = await cardWhere(frontend, (c) => c.id === card.id && c.status === "handled");
    expect(confirmed).toMatchObject({ status: "handled", outcome: { action: "confirm", note: "勾掉 1 项授权，收窄 1 项，改了假设栏" } });
    const p = confirmed.payload as PlanCardPayload;
    expect(p.removedGrants).toEqual([{ id: "fetch-docs", tool: "network_read", title: "读公开网页", scope: {}, maxUses: 20 }]);
    expect(p.narrowedGrants).toEqual(["push-report"]);
    expect(p.assumptionsEdited).toBe(true);
    expect(p.plan.stages[0]!.policy.grants).toEqual([]);
    expect(p.plan.stages[1]!.policy.grants).toEqual([{ id: "push-report", tool: "git_push", title: "把报告推送到 origin 的 main", scope: { remote: "origin", branch: ["main"] }, maxUses: 1 }]);
    // 假设栏随计划一起保存
    expect(p.plan.assumptions).toEqual(["只用公开资料", "报告用中文"]);
    const stored = daemon.tasks.plan("t-1-p1")!;
    expect(stored.status).toBe("confirmed");
    expect(stored.plan).toEqual(p.plan);
    // 卡上的关注类别和存储里的逐条一致；计划里没有定时作业（76 号票）
    expect(p.plan.watchCategories).toEqual(stored.plan.watchCategories);
    expect(p.plan).not.toHaveProperty("scheduledJobs");

    const moved = await taskWhere(frontend, (e) => e.change === "plan_confirmed");
    expect(moved).toMatchObject({ change: "plan_confirmed", from: "awaiting_confirm", by: "user", task: { state: "queued", stages: { total: 2 } } });
    expect(daemon.materials.list({ kind: "approval_decision" })).toEqual([
      expect.objectContaining({
        task: "t-1",
        context: ["decision:confirmed", "card:plan", "grants_removed", "grants_narrowed", "assumptions_edited"],
        ref: expect.objectContaining({ recordId: "t-1-p1", cardId: card.id }),
        segments: [
          // 授权项的说法和卡上一样，由结构化数据生成
          expect.objectContaining({
            form: "choice",
            notes: ["agent_proposed"],
            text: "确认任务「X 的调研」的计划（第 1 版）：勾掉授权「只读的联网命令（ping、查 GitHub 上的东西……）（network_read）：不限对象；最多 20 次；7 天内有效」，收窄授权为「git 推送（git_push） · 以我的名义对外发送或发布：remote 是 origin，branch 是 main；最多 1 次；7 天内有效」",
          }),
          // 改过的假设栏是用户自己的话
          expect.objectContaining({ form: "typed", source: "self", text: "假设栏改成：只用公开资料；报告用中文" }),
        ],
      }),
    ]);
  }, 60_000);

  it("附意见打回：任务回到规划中，意见作为一条消息交回起草的维护者；它重新提交后出一张新的计划卡（第 2 版）", async () => {
    const revised = samplePlan({ assumptions: ["只用公开资料", "不写价格"] });
    const { frontend, card, daemon } = await untilPlanCard([submitPlanStep(), say("计划交上去了"), submitPlanStep(revised), say("改好了")]);
    expect(await frontend.cardAction({ cardId: card.id, action: "reject", expectedVersion: 1 })).toMatchObject({ ok: false, error: { code: "bad_params" } });
    ok(await frontend.cardAction({ cardId: card.id, action: "reject", expectedVersion: 1, note: "价格不用写" }));
    expect(await cardWhere(frontend, (c) => c.id === card.id && c.status === "handled")).toMatchObject({ status: "handled", outcome: { action: "reject", note: "价格不用写" } });
    const rejected = await taskWhere(frontend, (e) => e.change === "plan_rejected");
    expect(rejected).toMatchObject({ change: "plan_rejected", from: "awaiting_confirm", by: "user", task: { state: "planning" } });

    const second = await cardWhere(frontend, (c) => c.type === "plan" && c.id !== card.id, "第 2 版计划卡");
    expect(second.payload).toMatchObject({ revision: 2, planId: "t-1-p2", plan: { assumptions: ["只用公开资料", "不写价格"] } });
    expect(daemon.tasks.plan("t-1-p1")?.status).toBe("rejected");
    expect(daemon.tasks.get("t-1")).toMatchObject({ state: "awaiting_confirm", planCardId: second.id });
    const notice = messagesOf(frontend, MAINTAINER).find((m) => m.agentInput && textOf(m).startsWith("用户打回了计划"));
    expect(notice).toMatchObject({ taskId: "t-1" });
    expect(textOf(notice!)).toBe("用户打回了计划（第 1 版），意见：「价格不用写」\n请按意见修改后重新用 submit_plan 提交。");
    expect(daemon.materials.list({ kind: "approval_decision" })[0]).toMatchObject({
      context: ["decision:rejected", "card:plan"],
      segments: [expect.objectContaining({ form: "choice", text: "打回任务「X 的调研」的计划（第 1 版）" }), expect.objectContaining({ form: "typed", text: "价格不用写" })],
    });
  }, 60_000);
});

describe("演示流程（录给前端回放）", () => {
  it("在秘书页说“帮我整理一份 X 的调研” → 秘书直接建出任务（规划中）→ 提问卡“全按推荐” → 待我处理出现计划卡 → 收窄一行授权后确认 → 看板上任务进入排队中，有执行名额马上开始第 1 阶段（13 号票）", async () => {
    const ask = call("ask_questions", { taskId: "t-1", questions: [{ question: "调研给谁看？", options: ["自己", "团队"], recommended: "自己" }] });
    const { url, daemon } = await startTestDaemon({
      secretary: [createTask, ask, say("我理解你要的是一份 X 的调研，对吗？先回答一个问题。"), writeBrief, say("任务书交给维护者了，计划会放进你的待我处理。")],
      maintainer: (_id, spawn) => (spawn === 1 ? [submitPlanStep(), say("计划交上去了")] : [say("开始做第一阶段")]),
    });
    const frontend = await connect(url);
    await tell(frontend, "发起任务：帮我整理一份 X 的调研");
    const questions = await cardWhere(frontend, ofType("questions"));
    const answers = (questions.payload as QuestionsCardPayload).questions.map((q) => ({ questionId: q.id, answer: q.recommended }));
    ok(await frontend.cardAction({ cardId: questions.id, action: "answer", expectedVersion: 1, input: { answers } }));
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);

    const plan = await cardWhere(frontend, ofType("plan"), "计划卡");
    await eventually(() => frontend.events({ channel: INBOX, type: EVENT_TYPES.inboxItem }), () => true, "待我处理里的计划卡");
    await taskWhere(frontend, (e) => e.task.state === "awaiting_confirm");
    // 维护者起草计划的两次模型调用都记了账再确认（看板上的事件流每次一样，24 号票）
    await eventually(() => tokenTotalsOf(frontend), (t) => t.calls === 2, "维护者起草计划的两次调用记账");
    ok(await frontend.cardAction({ cardId: plan.id, action: "confirm", expectedVersion: 1, input: { narrowGrants: [{ grantId: "push-report", maxUses: 1 }] } }));
    await taskWhere(frontend, (e) => e.task.state === "queued");
    await cardWhere(frontend, (c) => c.id === plan.id && c.status === "handled");
    await taskWhere(frontend, (e) => e.change === "stage_started");
    expect(daemon.tasks.get("t-1")).toMatchObject({ state: "running", stages: { total: 2, current: 1 } });
    // 开始执行后维护者的那一次调用也记了账
    await eventually(() => tokenTotalsOf(frontend), (t) => t.calls === 3, "维护者开始执行的那次调用记账");
    saveOrCheckRecording("task-initiation", frontend.recording, { perChannel: true });
  }, 60_000);
});
