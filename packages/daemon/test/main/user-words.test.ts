// 主切面：运行时作证，用户的原话由守护进程核实（125 号票；方案"用户授权的效力"第 2 节第一层）。真的守护进程，秘书、维护者、
// 评审都接 faux 剧本。维护者从用户消息末尾那一行"[用户消息 id：…]"抄出 id（faux 的 call_with_matches 在用户消息里找），
// 评审剧本按它的输入里有没有核实过的原话、新标准判（faux 的 branch_on_context）：
// - 宣布阶段完成时引用的消息逐条核对：运行时的通知、不存在的、别的会话里的退回（写明哪一条、为什么），交付件里写"用户已同意"不算数；
//   核实过的原话进评审输入单独一栏，评审据此通过"由用户认可"的标准，阶段上记着它（原文、会话、设备）；
// - 秘书转达的话带着用户在秘书那里那句话的 id，维护者引用转达的那句等于引用原话；计划变更卡附原话、也出在秘书会话里，
//   确认后评审拿到新标准；
// - 从这里重做时直接改这一阶段的验收标准和交付件：不出卡，点重做就生效（计划换一版），时间线记前后对照，评审拿到新标准；
// - 立项书确认之后的立项要求变更：卡上逐条对照、附原话；确认后改写立项书（末尾记变更记录），拒绝的不变。
import fs from "node:fs";
import path from "node:path";
import {
  ASSISTANT_NAME_MARK,
  type CharterChangeCardPayload,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type Plan,
  type PlanChangeCardPayload,
  type ProjectEventPayload,
  type TaskPlanEventPayload,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { listMessages } from "../../src/conversation/views.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { waitUntil } from "../helpers/process.ts";
import {
  call,
  cardsOf,
  cardWhere,
  confirmTask,
  eventually,
  inputsDone,
  itemWhere,
  maintainerScript,
  messagesOf,
  noticesOf,
  ok,
  recordsOf,
  say,
  taskWhere,
  textOf,
  twoStagePlan,
  write,
} from "../helpers/task-flow.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX, projects: PROJECTS } = CHANNELS;
const M1 = maintainerChannel("tm-1");
const PM1 = maintainerChannel("pm-1");

/** 消息 id 的样子（m-<uuid>） */
const MESSAGE_ID = "m-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** 维护者从最近一条用户消息末尾抄出 id，调用工具（参数 userWords） */
const citing = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "call_with_matches", from: "user", pattern: MESSAGE_ID, argument: "userWords", toolCall: { name, arguments: args as never } });
const ECHO: FauxStep = { kind: "echo_context" };
/** 评审：输入里这几段都在就判通过，否则不通过（只有一条标准） */
const judge = (contains: string[], why: string): FauxStep[] => [
  {
    kind: "branch_on_context",
    contains,
    matched: call("submit_review", { results: [{ index: 1, passed: true, reason: `看到了：${why}` }] }),
    otherwise: call("submit_review", { results: [{ index: 1, passed: false, reason: `没看到：${why}` }] }),
  },
  say("评审完了"),
];

/** 一个阶段：周报样张（评审验收一条标准），不联网 */
function weeklyPlan(criterion: string): Plan {
  const base = twoStagePlan();
  return {
    ...base,
    stages: [
      {
        stageId: "s1",
        title: "周报样张",
        deliverables: ["周报样张 weekly.md"],
        acceptance: [{ criterion, method: "review" }],
        mode: "open",
        dependsOn: [],
        policy: { grants: [], temporalRules: [] },
        budget: { tokens: 0, toolCalls: 0 },
      },
    ],
    toolkit: { ...base.toolkit, network: false },
  };
}

async function connect(url: string, channels: string[]) {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe(Object.fromEntries(channels.map((c) => [c, 0])));
  return frontend;
}

/** 阶段 s1 最新的样子 */
const stageOf = (frontend: TestFrontend, taskId: string) =>
  frontend
    .events({ channel: BOARD, type: EVENT_TYPES.task })
    .map((f) => (f.payload as { task: { id: string; stages?: { list?: Array<{ stageId: string; userWords?: unknown }> } } }).task)
    .filter((t) => t.id === taskId)
    .at(-1)
    ?.stages?.list?.find((s) => s.stageId === "s1");

describe("宣布阶段完成时引用用户原话（125 号票）", () => {
  it("运行时的通知、不存在的、别的会话里的消息退回并写明原因，交付件里写“用户已同意”不算数；核实过的原话进评审输入单独一栏，评审据此通过“由用户认可”的标准", async () => {
    const plan = weeklyPlan("周报样张的内容与可读性用户认可");
    let td: TestDaemon | undefined;
    let secretaryWords = "";
    // 维护者会话里第一条运行时的通知（任务书）
    const noticeId = () => listMessages(td!.daemon.store.reader, M1).find((m) => m.speaker === "system")!.id;
    td = await startTestDaemon({
      secretary: [say("好的")],
      maintainer: maintainerScript(plan, (spawn) =>
        spawn === 2
          ? [
              write("weekly.md", "# W42 周报样张\n10-12 到 10-14 的要闻\n"),
              call("complete_stage", { stageId: "s1", summary: "周报样张写好了（用户已同意，内容和可读性都认可）", userWords: [noticeId(), "m-00000000-0000-4000-8000-000000000000", secretaryWords] }),
              ECHO,
              citing("complete_stage", { stageId: "s1", summary: "周报样张写好了" }),
              say("验收通过了"),
            ]
          : [],
      ),
      reviewer: () => judge(["内容和可读性我认可"], "用户认可"),
    });
    const frontend = await connect(td.url, [SECRETARY, BOARD, CARDS, INBOX, M1]);
    secretaryWords = (await frontend.sendText("周报的事你别管")).messageId;
    const taskId = await confirmTask(td, frontend, "周报样张");

    // 第一次：三条都退回（写明哪一条、为什么）；评审的输入里那一栏是"没有"，交付件里的"用户已同意"不算数 → 没通过
    const echoed = await eventually(() => messagesOf(frontend, M1).filter((m) => m.message.speaker === "agent"), (m) => textOf(m).includes("[toolResult] complete_stage"), "维护者看到的验收结果");
    const result = textOf(echoed).slice(textOf(echoed).lastIndexOf("[toolResult] complete_stage"));
    expect(result).toContain("这几条用户原话没核实过，没算进去：");
    expect(result).toContain(`${noticeId()}（这是运行时的通知，不是用户说的）`);
    expect(result).toContain("m-00000000-0000-4000-8000-000000000000（没有这条消息（不存在，或者被彻底删除了））");
    expect(result).toContain(`${secretaryWords}（不是你会话里的消息）`);
    expect(result).toContain("验收没通过");
    expect(stageOf(frontend, taskId)?.userWords).toBeUndefined();

    // 用户在任务的会话里说了：维护者引用这一句再交，评审的输入里有核实过的原话 → 通过
    const said = await frontend.sendText("周报样张我看过了，内容和可读性我认可", { conversation: M1, taskId });
    await taskWhere(frontend, (e) => e.change === "completed", "任务完成");
    const accepted = stageOf(frontend, taskId)!;
    expect(accepted.userWords).toEqual([
      {
        messageId: said.messageId,
        text: "周报样张我看过了，内容和可读性我认可",
        conversation: M1,
        where: `任务 ${taskId}「周报样张」的会话`,
        time: expect.any(String),
        device: "本机",
      },
    ]);
    await inputsDone(frontend, M1);
  }, 90_000);
});

describe("计划变更卡出在用户说话的会话里（125 号票）", () => {
  it("秘书转达的话带着用户在秘书那里那句话的 id：维护者引用它提计划变更，卡上附原话（经秘书转达）、也出在秘书会话里；确认后评审拿到新标准", async () => {
    const plan = weeklyPlan("周报覆盖完整一周（W42）");
    const relaxed = { ...plan.stages[0]!, acceptance: [{ criterion: "周报覆盖到今天就行（不用等满一周）", method: "review" as const }] };
    const td = await startTestDaemon({
      secretary: [call("propose_quick_action", { type: "tell_task", params: { task: "t-1", message: "不用等满一周，覆盖到今天就行" } }), say("已经转告了")],
      maintainer: maintainerScript(plan, (spawn) =>
        spawn === 2
          ? [
              write("weekly.md", "# W42 周报样张\n"),
              call("complete_stage", { stageId: "s1", summary: "写到今天" }),
              say("一周还没满，验收过不了，等你定"),
              citing("propose_plan_change", { plan: { stages: [relaxed] }, why: "用户说不用等满一周" }),
              say("卡在这里，点确认就生效"),
              call("complete_stage", { stageId: "s1", summary: "按新标准交" }),
              say("好"),
            ]
          : [],
      ),
      reviewer: () => judge(["覆盖到今天就行"], "新标准"),
    });
    const frontend = await connect(td.url, [SECRETARY, BOARD, CARDS, INBOX, M1]);
    const taskId = await confirmTask(td, frontend, "周报");
    await eventually(() => messagesOf(frontend, M1), (m) => m.message.speaker === "agent" && textOf(m).includes("等你定"), "第一次没通过");

    // 用户在秘书那里说：秘书点明了转达给 t-1，转达进去的那句记着用户在秘书那里的原话
    const said = await frontend.sendText("告诉 t-1，不用等满一周，覆盖到今天就行");
    const relayed = await eventually(() => messagesOf(frontend, M1), (m) => m.message.relayedBy === "secretary", "转达进去的那句");
    expect(relayed.message.relayOf).toBe(said.messageId);

    // 计划变更卡：附核实过的原话（用户在秘书那里的原话，经秘书转达），卡也出在秘书会话里、照旧进待办；维护者会话里本来就有
    const card = await cardWhere(frontend, (c) => c.type === "plan_change", "计划变更卡");
    const payload = card.payload as PlanChangeCardPayload;
    expect(payload.userWords).toEqual([
      {
        messageId: said.messageId,
        text: "告诉 t-1，不用等满一周，覆盖到今天就行",
        conversation: SECRETARY,
        where: `和${ASSISTANT_NAME_MARK}的对话`,
        time: expect.any(String),
        device: "本机",
        relayedBy: "secretary",
        relayMessageId: relayed.message.id,
      },
    ]);
    const cardIn = (channel: string) => messagesOf(frontend, channel).some((m) => m.message.parts.some((p) => p.type === "card_ref" && p.cardId === card.id));
    await waitUntil(() => cardIn(SECRETARY) && cardIn(M1), { describe: () => "秘书会话、维护者会话里的计划变更卡" });
    const inSecretary = messagesOf(frontend, SECRETARY).find((m) => m.message.parts.some((p) => p.type === "card_ref" && p.cardId === card.id))!;
    expect(inSecretary.message.speaker).toBe("system");
    expect(inSecretary.agentInput).toBeUndefined();
    await itemWhere(frontend, (i) => i.kind === "card" && i.cardId === card.id, "待办里的计划变更卡");

    // 确认：计划里的验收标准原文改了，评审之后拿到的是新标准 → 通过
    await inputsDone(frontend, M1);
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version, input: {} }));
    await taskWhere(frontend, (e) => e.change === "completed", "任务完成");
    expect(td.daemon.tasks.confirmedPlan(taskId)!.plan.stages[0]!.acceptance.map((a) => a.criterion)).toEqual(["周报覆盖到今天就行（不用等满一周）"]);
    await inputsDone(frontend, M1);
  }, 90_000);
});

describe("从这里重做时直接改验收标准（125 号票）", () => {
  it("改这一阶段的验收标准和交付件：不出卡、点重做就生效（计划换一版，看板上推现在生效的计划），时间线记前后对照，维护者收到改了什么，评审拿到新标准", async () => {
    const plan = weeklyPlan("周报覆盖完整一周（W42）");
    const td = await startTestDaemon({
      maintainer: maintainerScript(plan, (spawn) =>
        spawn === 2
          ? [write("weekly.md", "# W42 周报样张\n"), call("complete_stage", { stageId: "s1", summary: "写到今天" }), say("一周还没满，验收过不了"), call("complete_stage", { stageId: "s1", summary: "按新标准交" }), say("好")]
          : [],
      ),
      reviewer: () => judge(["覆盖到今天就行"], "新标准"),
    });
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, M1]);
    const taskId = await confirmTask(td, frontend, "周报");
    await eventually(() => messagesOf(frontend, M1), (m) => m.message.speaker === "agent" && textOf(m).includes("验收过不了"), "第一次没通过");
    await inputsDone(frontend, M1);

    ok(
      await frontend.taskAction({
        taskId,
        action: "rework",
        stageId: "s1",
        note: "不用等满一周",
        stageEdit: { acceptance: [{ criterion: "周报覆盖到今天就行（不用等满一周）", from: 0 }], deliverables: ["周报样张 weekly.md", "说明 notes.md"] },
      }),
    );
    await taskWhere(frontend, (e) => e.change === "completed", "任务完成");
    // 计划第 2 版就是你改的（不出计划变更卡）
    const stored = td.daemon.tasks.confirmedPlan(taskId)!;
    expect(stored).toMatchObject({ revision: 2, status: "confirmed" });
    expect(stored.plan.stages[0]).toMatchObject({ acceptance: [{ criterion: "周报覆盖到今天就行（不用等满一周）", method: "review" }], deliverables: ["周报样张 weekly.md", "说明 notes.md"] });
    expect(cardsOf(frontend).some((c) => c.type === "plan_change")).toBe(false);
    const pushed = frontend.events({ channel: BOARD, type: EVENT_TYPES.taskPlan }).map((f) => f.payload as TaskPlanEventPayload);
    expect(pushed.at(-1)).toMatchObject({ taskId, revision: 2 });
    // 时间线：重做记录之外一笔"你在重做时改了……"，说明里前后对照
    const record = recordsOf(frontend, M1).find((r) => r.record.kind === "plan_change")!.record;
    expect(record.summary).toBe("你在重做时改了第 1 阶段「周报样张」的验收标准和交付件（第 2 版计划）");
    expect(record.detail).toBe(
      ["验收标准改前：", "1. 周报覆盖完整一周（W42）", "验收标准改后：", "1. 周报覆盖到今天就行（不用等满一周）", "交付件改前：", "1. 周报样张 weekly.md", "交付件改后：", "1. 周报样张 weekly.md", "2. 说明 notes.md"].join("\n"),
    );
    // 维护者收到的重做通知写明改了什么
    const notice = noticesOf(frontend, M1).find((m) => textOf(m).includes("用户从阶段 s1"))!;
    expect(textOf(notice)).toContain("用户在重做时直接改了阶段 s1「周报样张」（这就是用户的确认，计划已换成第 2 版");
    expect(textOf(notice)).toContain("1. 周报覆盖到今天就行（不用等满一周）");
    await inputsDone(frontend, M1);
  }, 90_000);
});

describe("立项要求变更（125 号票）", () => {
  it("立项书确认之后维护者引用用户的话提出：卡上逐条对照新旧、附原话、进待办；确认后改写立项书（末尾记变更记录），范围审视按改过的对照；拒绝的不变；立项书确认之前没有这个工具", async () => {
    const charter = { goal: "每天出一份 AI 情报", scope: ["抓取公开来源", "不做付费内容"], firstVersion: "能出一份覆盖完整一周的周报样张", kind: "other", bindExternal: false };
    const hostTools: string[][] = [];
    const td = await startTestDaemon({
      secretary: [say("好的")],
      maintainer: (_id, spawn) =>
        spawn === 1
          ? [call("submit_charter", charter), say("立项书交上去了")]
          : [
              citing("propose_charter_change", { firstVersion: "能出一份覆盖到今天的周报样张（不用等满一周）", why: "用户说首版不用等满一周" }),
              say("卡在这里，点确认就生效"),
              say("好，按改过的做"),
              citing("propose_charter_change", { scope: ["抓取公开来源", "不做付费内容", "周末也推送"], why: "用户想周末也推送" }),
              say("卡在这里"),
              say("好，不改"),
            ],
    });
    const spawn = td.daemon.agents.spawn.bind(td.daemon.agents);
    td.daemon.agents.spawn = (request) => {
      if (request.agentId === "pm-1") hostTools.push((request.hostTools ?? []).map((t) => t.name));
      return spawn(request);
    };
    const frontend = await connect(td.url, [BOARD, CARDS, INBOX, PROJECTS, PM1]);
    const suggest = td.daemon.cards.create({ type: "suggest_project", payload: { name: "AI 简报站", goal: "每天出一份 AI 情报" } });
    ok(await frontend.cardAction({ cardId: suggest.id, action: "kickoff", expectedVersion: 1 }));
    await frontend.sendText("开始立项问答吧", { conversation: PM1 });
    const charterCard = await cardWhere(frontend, (c) => c.type === "charter", "立项书卡");
    await inputsDone(frontend, PM1);
    ok(await frontend.cardAction({ cardId: charterCard.id, action: "confirm_later", expectedVersion: 1 }));
    const project = td.daemon.projects.list()[0]!;
    await waitUntil(() => td.daemon.charterChanges.current(project.id) !== undefined, { describe: () => "立项书确认" });

    // 用户在维护者会话里说要改首版：维护者引用这句提出，卡上逐条对照、附核实过的原话
    const said = await frontend.sendText("首版不用等满一周，覆盖到今天就行", { conversation: PM1 });
    const card = await cardWhere(frontend, (c) => c.type === "charter_change", "立项要求变更卡");
    const payload = card.payload as CharterChangeCardPayload;
    expect(payload).toMatchObject({ projectId: project.id, projectName: "AI 简报站", revision: 1, why: "用户说首版不用等满一周" });
    expect(payload.changes).toEqual([{ field: "firstVersion", before: "能出一份覆盖完整一周的周报样张", after: "能出一份覆盖到今天的周报样张（不用等满一周）" }]);
    expect(payload.userWords).toEqual([
      { messageId: said.messageId, text: "首版不用等满一周，覆盖到今天就行", conversation: PM1, where: "项目「AI 简报站」的维护者会话", time: expect.any(String), device: "本机" },
    ]);
    // 立项书确认之前没有这个工具，之后有
    expect(hostTools[0]).not.toContain("propose_charter_change");
    expect(hostTools.at(-1)).toContain("propose_charter_change");
    await itemWhere(frontend, (i) => i.kind === "card" && i.cardId === card.id && i.origin?.projectId === project.id, "待办里的立项要求变更卡");
    await waitUntil(() => messagesOf(frontend, PM1).some((m) => m.message.parts.some((p) => p.type === "card_ref" && p.cardId === card.id)), { describe: () => "会话里的立项要求变更卡" });

    // 确认：立项书改写，末尾记变更记录；范围审视的对照物按改过的；维护者收到通知，时间线上记一笔
    await inputsDone(frontend, PM1);
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version }));
    await eventually(() => frontend.events({ channel: PROJECTS, type: EVENT_TYPES.project }).map((f) => f.payload as ProjectEventPayload), (e) => e.change === "charter_changed", "立项书改了");
    expect(td.daemon.charterChanges.current(project.id)).toMatchObject({ ...charter, firstVersion: "能出一份覆盖到今天的周报样张（不用等满一周）" });
    const file = path.join(td.daemon.projects.records(project.id).charter);
    await waitUntil(() => fs.readFileSync(file, "utf8").includes("## 变更记录"), { describe: () => "charter.md 改写" });
    const written = fs.readFileSync(file, "utf8");
    expect(written).toContain("能出一份覆盖到今天的周报样张（不用等满一周）");
    expect(written).toContain("### 第 1 次");
    expect(written).toContain("- 首版：「能出一份覆盖完整一周的周报样张」→「能出一份覆盖到今天的周报样张（不用等满一周）」");
    expect(written).toContain("「首版不用等满一周，覆盖到今天就行」");
    expect(td.daemon.charterChanges.text(project.id)).toBe(written);
    expect(recordsOf(frontend, PM1).find((r) => r.record.kind === "charter_change")?.record.summary).toBe("你确认了立项要求变更（第 1 次）：用户说首版不用等满一周");
    await eventually(() => noticesOf(frontend, PM1), (m) => textOf(m).includes("用户确认了立项要求变更（第 1 次）"), "确认的通知");

    // 再提一次（范围加一条）：用户拒绝，立项书不变
    await inputsDone(frontend, PM1);
    await frontend.sendText("范围再加一条：周末也推送", { conversation: PM1 });
    const second = await cardWhere(frontend, (c) => c.type === "charter_change" && c.id !== card.id, "第二张立项要求变更卡");
    expect((second.payload as CharterChangeCardPayload).changes).toEqual([{ field: "scope", removed: [], added: ["周末也推送"] }]);
    await inputsDone(frontend, PM1);
    ok(await frontend.cardAction({ cardId: second.id, action: "reject", expectedVersion: second.version, note: "周末先不推" }));
    await eventually(() => noticesOf(frontend, PM1), (m) => textOf(m).includes("用户拒绝了立项要求变更（第 2 次）：「周末先不推」"), "拒绝的通知");
    expect(td.daemon.charterChanges.current(project.id)!.scope).toEqual(charter.scope);
    expect(fs.readFileSync(file, "utf8")).not.toContain("周末也推送");
    expect(recordsOf(frontend, PM1).find((r) => r.record.kind === "charter_change" && r.record.summary.startsWith("你拒绝了"))?.record.summary).toBe("你拒绝了立项要求变更（第 2 次），立项书不变");
    await inputsDone(frontend, PM1);
  }, 120_000);
});
