// 主切面：计划卡上的关注类别和用户说过的限制（规格第 8、9 节，26 号票）。真的守护进程，秘书和维护者接 faux 剧本，测试扮演前端。
// - 计划卡上"本任务要提醒的关注类别"默认等于全局设置（内置的加用户自定义的）；维护者提交的计划少了全局的类别，提交失败并返回原因；
// - 用户确认时在卡上给这个任务加类别（和设置页同一套确定规则）：写进计划，只影响这个任务（同一调用在两个任务里判定不同）；
//   卡上没有删除；加的类别随"审批决定"素材记下；
// - 维护者把用户说过的限制编译成时序规则或授权收窄、附上原话：规则过规则校验（不过的提交失败），卡上列出，
//   确认后违反的调用被拦下。编译本身靠维护者的模型（DeepSeek 计划起草的手动冒烟），这里只测运行时一侧。
// 任务的执行（13 号票）还没接上，"判定"用确认的计划交给守卫的样子（toGuardPlan）和守卫的判定函数算，和执行时一样。
import {
  type Card,
  type CardEventPayload,
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type MessageEventPayload,
  type Plan,
  type PlanCardPayload,
  type ResponseFrame,
  type UpdateWatchCategoriesResult,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import type { Daemon } from "../../src/daemon.ts";
import { BUILTIN_CATEGORY_IDS, judgeToolCall } from "../../src/guard/index.ts";
import type { FauxStep } from "../../src/runtime/index.ts";
import { TASKS_CHANNEL } from "../../src/tasks/events.ts";
import type { PlanDecidedPayload } from "../../src/tasks/events.ts";
import { toGuardPlan } from "../../src/tasks/plan.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { samplePlan, submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import { call as guardCall, inTask, maintainer as maintainerAgent, P, task as guardTask, v1Satisfied } from "../guard/helpers/guard-input.ts";

const { secretary: SECRETARY, cards: CARDS, board: BOARD, inbox: INBOX } = CHANNELS;

const say = (text: string): FauxStep => ({ kind: "reply", text });
const call = (name: string, args: Record<string, unknown>): FauxStep => ({ kind: "reply", toolCalls: [{ name, arguments: args as never }] });
const createTask = (title: string) => call("create_task", { title, summary: `帮我${title}` });
const writeBrief = (taskId: string, constraints: string[] = ["只用公开资料"]) =>
  call("write_task_brief", { taskId, goal: "整理一份调研", acceptanceCriteria: ["附来源"], constraints, projects: [], memoryScope: "（无）" });

const cardsOf = (frontend: TestFrontend): Card[] => frontend.events({ channel: CARDS, type: EVENT_TYPES.card }).map((f) => (f.payload as CardEventPayload).card);
const textOf = (p: MessageEventPayload) => p.message.parts.map((part) => ("text" in part ? part.text : `<${part.type}>`)).join("");
const ok = (r: ResponseFrame) => {
  if (!r.ok) throw new Error(`请求失败：${r.error.code} ${r.error.message}`);
  return r.result;
};

async function eventually<T>(list: () => readonly T[], match: (x: T) => boolean, what: string): Promise<T> {
  let found: T | undefined;
  await waitUntil(() => (found = list().filter(match).at(-1)) !== undefined, { timeoutMs: 20_000, describe: () => `等${what}` });
  return found!;
}
const cardWhere = (frontend: TestFrontend, match: (card: Card) => boolean, what = "卡片") => eventually(() => cardsOf(frontend), match, what);

/** 维护者在会话里看到的工具结果（剧本最后一步 echo_context 的回显） */
async function maintainerSaw(frontend: TestFrontend, maintainerId: string): Promise<string> {
  const channel = maintainerChannel(maintainerId);
  await waitUntil(() => frontend.events({ channel, type: EVENT_TYPES.turnEnd }).length >= 1, { timeoutMs: 20_000, describe: () => `等维护者 ${maintainerId} 处理完` });
  return frontend.events({ channel, type: EVENT_TYPES.message }).map((f) => textOf(f.payload as MessageEventPayload)).join("\n");
}

/** 计划卡上的决定（守护进程内部的 tasks 频道） */
const decisionsOf = (daemon: Daemon) => daemon.store.read(TASKS_CHANNEL, 0, EVENT_TYPES.planDecided).map((e) => e.payload as PlanDecidedPayload);

/** 确认的计划交给守卫的样子（13 号票执行时就这么交）：任务在 s1 阶段，维护者在工作目录 E:\work\notes 里干活 */
function judgeInTask(daemon: Daemon, taskId: string, toolCall: ReturnType<typeof guardCall>, extra: Parameters<typeof inTask>[2] = {}) {
  const stored = daemon.tasks.latestPlan(taskId)!;
  expect(stored.status).toBe("confirmed");
  const settings = daemon.watchCategories.current();
  const plan = toGuardPlan(stored.plan, { confirmedAt: Date.now() - 60_000, settings });
  return judgeToolCall(inTask(maintainerAgent(), toolCall, { settings, now: Date.now(), task: guardTask({ taskId, currentStageId: "s1", plan }), ...extra }));
}

const MIGRATIONS = `${P.workDir}\\db\\migrations`;

describe("计划卡上本任务要提醒的关注类别", () => {
  it("默认等于全局设置（含自定义的），少了就提交失败；用户在卡上加的类别写进计划、只影响这个任务、随审批决定记下；卡上没有删除", async () => {
    const globalCategories = [...BUILTIN_CATEGORY_IDS.map((id) => ({ id })), { id: "c-1" }];
    const withGlobal = samplePlan({ watchCategories: globalCategories });
    const { url, daemon } = await startTestDaemon({
      secretary: [createTask("X 的调研"), writeBrief("t-1"), createTask("Y 的调研"), writeBrief("t-2"), say("交给维护者了")],
      // t-1 的维护者先交了一份少了全局自定义类别的计划（被拒），再交合格的；t-2 的直接交合格的
      maintainer: (id) => (id === "tm-1" ? [submitPlanStep(samplePlan()), submitPlanStep(withGlobal), { kind: "echo_context" }] : [submitPlanStep(withGlobal), say("交了")]),
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [BOARD]: 0, [INBOX]: 0, [maintainerChannel("tm-1")]: 0 });
    // 全局设置里有一个用户自定义的类别
    const created = ok(await frontend.updateWatchCategories({ op: "create_custom", category: { title: "付款超过 500", match: { amountOver: 500 }, chat: "hand_to_me", task: "hand_to_me" } })) as UpdateWatchCategoriesResult;
    expect(created.categoryId).toBe("c-1");

    await frontend.sendText("帮我做 X 和 Y 两份调研");
    const seen = await maintainerSaw(frontend, "tm-1");
    expect(seen).toContain("本任务的关注类别少了全局的「付款超过 500」（c-1）：全局的类别一个都不能少，只能在其上增加");

    const card1 = await cardWhere(frontend, (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === "t-1", "t-1 的计划卡");
    const card2 = await cardWhere(frontend, (c) => c.type === "plan" && (c.payload as PlanCardPayload).taskId === "t-2", "t-2 的计划卡");
    const p1 = card1.payload as PlanCardPayload;
    expect(card1.typeVersion).toBe(3);
    // 默认等于全局设置：全局的 id 都在，名字由运行时补上
    expect(p1.globalCategories).toEqual([...BUILTIN_CATEGORY_IDS, "c-1"]);
    expect(p1.plan.watchCategories.map((c) => c.id)).toEqual(p1.globalCategories);
    expect(p1.plan.watchCategories.at(-1)).toEqual({ id: "c-1", title: "付款超过 500" });

    // 卡上没有删除：确认的输入里没有这一项，带了就不合 schema
    expect(await frontend.cardAction({ cardId: card1.id, action: "confirm", expectedVersion: 1, input: { removeWatchCategories: ["c-1"] } })).toMatchObject({ ok: false, error: { code: "bad_params" } });
    // 加的类别规则写错了：被拒，说清楚
    const badRule = { addWatchCategories: [{ title: "迁移目录", match: { paths: ["db/migrations"] }, disposition: "ask_first" }] };
    expect(await frontend.cardAction({ cardId: card1.id, action: "confirm", expectedVersion: 1, input: badRule })).toMatchObject({
      ok: false,
      error: { code: "bad_params", message: expect.stringMatching(/加的关注类别「迁移目录」：路径要写完整的 Windows 路径/) },
    });

    // t-1：加一个只对这个任务生效的类别；t-2：原样确认
    const addition = { title: "动迁移目录", match: { paths: [MIGRATIONS] }, disposition: "ask_first" as const };
    ok(await frontend.cardAction({ cardId: card1.id, action: "confirm", expectedVersion: 1, input: { addWatchCategories: [addition] } }));
    ok(await frontend.cardAction({ cardId: card2.id, action: "confirm", expectedVersion: 1, input: {} }));
    const confirmed = await cardWhere(frontend, (c) => c.id === card1.id && c.status === "handled");
    const cp = confirmed.payload as PlanCardPayload;
    expect(confirmed.outcome).toMatchObject({ action: "confirm", note: "加了 1 个关注类别" });
    expect(cp.addedCategories).toEqual(["t-1-p1-c1"]);
    expect(cp.plan.watchCategories.at(-1)).toEqual({ id: "t-1-p1-c1", ...addition });
    expect(daemon.tasks.latestPlan("t-1")?.plan.watchCategories).toEqual(cp.plan.watchCategories);
    await cardWhere(frontend, (c) => c.id === card2.id && c.status === "handled");
    // 不进全局注册表
    expect(daemon.watchCategories.state().custom.map((c) => c.id)).toEqual(["c-1"]);

    // 同一调用：t-1 里命中这个类别、先问；t-2 里照常直接做
    const write = guardCall("write", { path: `${MIGRATIONS}\\001.sql`, content: "x" });
    const facts = { facts: { files: { [`${MIGRATIONS}\\001.sql`]: { exists: false } } } };
    const inT1 = judgeInTask(daemon, "t-1", write, facts);
    expect(inT1.disposition).toBe("ask_first");
    expect(inT1.categories).toEqual(["t-1-p1-c1"]);
    const inT2 = judgeInTask(daemon, "t-2", write, facts);
    expect(inT2.disposition).toBe("log_only");
    expect(inT2.categories).toEqual([]);
    // 全局的自定义类别两个任务里都在
    expect(judgeInTask(daemon, "t-2", guardCall("mcp_pay", { amount: 900 }), { tools: { mcp_pay: { name: "mcp_pay", title: "付款", source: "mcp", categories: [], args: { amount: { kind: "amount", type: "number" } } } } }).disposition).toBe("hand_over");

    // 加的类别随计划确认的审批决定记下（事件和素材）
    expect(decisionsOf(daemon).find((d) => d.taskId === "t-1")?.addedCategories).toEqual([{ id: "t-1-p1-c1", ...addition }]);
    await waitUntil(() => daemon.materials.list({ kind: "approval_decision" }).some((m) => m.task === "t-1"));
    const material = daemon.materials.list({ kind: "approval_decision" }).find((m) => m.task === "t-1")!;
    expect(material.context).toContain("categories_added");
    expect(material.segments).toContainEqual(expect.objectContaining({ form: "typed", source: "self", text: `给这个任务加了关注类别「动迁移目录」：路径在 ${MIGRATIONS} 之内，先问我` }));
  }, 90_000);

  it("全局设置后来改了、删了自定义类别：已确认的任务下一次判定跟着全局走", async () => {
    const plan = samplePlan({ watchCategories: [...BUILTIN_CATEGORY_IDS.map((id) => ({ id })), { id: "c-1", disposition: "never" as const }] });
    const { url, daemon } = await startTestDaemon({ secretary: [createTask("X 的调研"), writeBrief("t-1"), say("交了")], maintainer: [submitPlanStep(plan), say("交了")] });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0 });
    const migrations = { title: "动迁移目录", match: { paths: [MIGRATIONS] }, chat: "ask_first" as const, task: "ask_first" as const };
    ok(await frontend.updateWatchCategories({ op: "create_custom", category: migrations }));
    await frontend.sendText("帮我做 X 的调研");
    const card = await cardWhere(frontend, (c) => c.type === "plan", "计划卡");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));
    await cardWhere(frontend, (c) => c.id === card.id && c.status === "handled");

    const write = guardCall("write", { path: `${MIGRATIONS}\\002.sql`, content: "x" });
    const facts = { facts: { files: { [`${MIGRATIONS}\\002.sql`]: { exists: false } } } };
    // 维护者在计划里把它调成了"永不"
    expect(judgeInTask(daemon, "t-1", write, facts).disposition).toBe("never");
    // 全局改了规则：换到别的目录，迁移目录不再命中
    ok(await frontend.updateWatchCategories({ op: "update_custom", categoryId: "c-1", category: { ...migrations, match: { paths: [`${P.workDir}\\db\\seeds`] } } }));
    expect(judgeInTask(daemon, "t-1", write, facts).categories).toEqual([]);
    // 改回来再删掉：不再命中
    ok(await frontend.updateWatchCategories({ op: "update_custom", categoryId: "c-1", category: migrations }));
    expect(judgeInTask(daemon, "t-1", write, facts).disposition).toBe("never");
    ok(await frontend.updateWatchCategories({ op: "delete_custom", categoryId: "c-1" }));
    const after = judgeInTask(daemon, "t-1", write, facts);
    expect(after.categories).toEqual([]);
    expect(after.disposition).toBe("log_only");
  }, 60_000);
});

describe("用户说过的限制：编译成时序规则或授权收窄，和原话一起列在计划卡上", () => {
  const noPushMain = { id: "no-push-main", title: "不往 main 推", trigger: { tool: "git_push", where: { eq: ["$current.args.branch", "main"] } }, on_violation: "block" };
  const limited = (rules: Plan["stages"][number]["policy"]["temporalRules"]): Plan =>
    samplePlan({
      userLimits: [{ id: "l1", quote: "别往 main 推，报告只推一次", temporalRules: rules, grantNarrowings: [{ grantId: "push-report", maxUses: 1 }] }],
    });

  it("规则不过规则校验：提交失败、原因交回维护者；合格的列在卡上（附原话），授权收窄落到授权项上；确认后违反规则的调用被拦下", async () => {
    const { url, daemon } = await startTestDaemon({
      secretary: [createTask("X 的调研"), writeBrief("t-1", ["别往 main 推，报告只推一次"]), say("交给维护者了")],
      maintainer: [submitPlanStep(limited([{ id: "bad", trigger: { tool: "teleport" } }])), submitPlanStep(limited([noPushMain])), { kind: "echo_context" }],
    });
    const frontend = await TestFrontend.connect(url);
    await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [maintainerChannel("tm-1")]: 0 });
    await frontend.sendText("帮我做 X 的调研，别往 main 推，报告只推一次");
    const seen = await maintainerSaw(frontend, "tm-1");
    expect(seen).toMatch(/计划没通过检查，改好再提交：\n- 限制 l1 的时序规则：规则 bad/);

    const card = await cardWhere(frontend, (c) => c.type === "plan", "计划卡");
    expect(cardsOf(frontend).filter((c) => c.type === "plan")).toHaveLength(1);
    const p = card.payload as PlanCardPayload;
    expect(p.plan.userLimits).toEqual([{ id: "l1", quote: "别往 main 推，报告只推一次", temporalRules: [noPushMain], grantNarrowings: [{ grantId: "push-report", maxUses: 1 }] }]);
    expect(p.plan.stages[1]!.policy.grants[0]).toMatchObject({ id: "push-report", maxUses: 1 });
    expect(card.text).toContain("按你说过的话加了 1 条限制");

    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: 1, input: {} }));
    await cardWhere(frontend, (c) => c.id === card.id && c.status === "handled");
    // 执行中（第 2 阶段，推送有授权项）：推到 main 违反规则、拦下；推到 report 照授权项放行
    // v1 模板的前提（这个任务里跑过测试、都已提交、HEAD 是新提交）先满足，看的是限制编译出的规则和授权项
    const base = v1Satisfied();
    const ready = { ...base, effectLog: base.effectLog.map((e) => ({ ...e, taskId: "t-1", stageId: "s2" })) };
    const atS2 = (branch: string) => {
      const stored = daemon.tasks.latestPlan("t-1")!;
      const settings = daemon.watchCategories.current();
      const plan = toGuardPlan(stored.plan, { confirmedAt: Date.now() - 60_000, settings });
      return judgeToolCall(inTask(maintainerAgent(), guardCall("git_push", { remote: "origin", branch }), { ...ready, settings, now: Date.now(), task: guardTask({ taskId: "t-1", currentStageId: "s2", plan }) }));
    };
    const main = atS2("main");
    expect(main.disposition).toBe("never");
    expect(main.temporalRules.map((r) => r.ruleId)).toContain("no-push-main");
    const report = atS2("report");
    expect(report.disposition).toBe("log_only");
    expect(report.withinGrant).toBe(true);
  }, 60_000);
});
