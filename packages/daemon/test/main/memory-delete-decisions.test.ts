// 主切面：彻底删除计划的决定、提问卡的回答、授权续期的决定（规格第 15 节，80 号票）。秘书和维护者接 faux 剧本，测试扮演前端。
// 三类事件产生的素材都能在记忆删除卡上彻底删除（设置里的批量删除同一套），只换用户写的话，决定和状态不变：
// - 提问卡的回答：事件里每题的答案、卡上记的答案换成删除标记，交回秘书的那条通知整条换成"已删除"，秘书的会话文件里也没有；
// - 计划卡打回的意见：事件和卡上处理结果里的话换成删除标记，交回维护者的那条通知整条换成"已删除"，维护者的会话文件里也没有；
//   计划还是已拒绝；计划变更卡上拒绝时写的话同样（交给维护者的通知按引着这段话找）；
// - 授权续期的决定：没有用户写的话，事件原样，续期后的有效期不变；
// 整体重建派生视图后也一样。
import fs from "node:fs";
import path from "node:path";
import {
  CHANNELS,
  EVENT_TYPES,
  isDeletedEventPayload,
  maintainerChannel,
  type MessageEventPayload,
  type MessagesPurgedEventPayload,
  type Plan,
  PURGED_TEXT,
  type QuestionsCardPayload,
} from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import type { FauxStep } from "../../src/runtime/index.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { materialsApi } from "../helpers/http.ts";
import { submitPlanStep } from "../helpers/plans.ts";
import { waitUntil } from "../helpers/process.ts";
import {
  call,
  cardWhere,
  confirmTask,
  eventually,
  inputsDone,
  itemWhere,
  maintainerScript,
  noticesOf,
  ok,
  real,
  say,
  taskWhere,
  textOf,
  twoStagePlan,
} from "../helpers/task-flow.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const { secretary: SECRETARY, cards: CARDS, inbox: INBOX, board: BOARD } = CHANNELS;
const M1 = maintainerChannel("tm-1");
const MATERIAL_ID = "mat-[0-9a-f]{24}";
const MINUTE = 60_000;
const DAY = 86_400_000;

const search = (query: string): FauxStep => call("search_materials", { query });
/** 秘书照着检索结果里的素材 id 提议彻底删除 */
const proposePurge: FauxStep = {
  kind: "call_with_matches",
  toolCall: { name: "propose_quick_action", arguments: { type: "purge", params: {} } },
  argument: "params.materialIds",
  pattern: MATERIAL_ID,
};

async function connect(url: string): Promise<TestFrontend> {
  const frontend = await TestFrontend.connect(url);
  await frontend.subscribe({ [SECRETARY]: 0, [CARDS]: 0, [INBOX]: 0, [BOARD]: 0, [M1]: 0 });
  return frontend;
}

/** 用户说一句话，等秘书这一轮结束 */
async function tell(frontend: TestFrontend, text: string) {
  await frontend.sendText(text);
  await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
}

/** 在秘书出的记忆删除卡上选彻底删除这几条（卡上可以去掉几条） */
async function purgeOnCard(frontend: TestFrontend, materialIds: string[]) {
  const card = await cardWhere(frontend, (c) => c.type === "memory_delete", "记忆删除卡");
  const listed = (card.payload as { matches: Array<{ materialId: string }> }).matches.map((m) => m.materialId);
  expect(listed).toEqual(expect.arrayContaining(materialIds));
  ok(await frontend.cardAction({ cardId: card.id, action: "delete", expectedVersion: card.version, input: { mode: "purge", materialIds } }));
  await frontend.next(SECRETARY, EVENT_TYPES.quickActionExecuted);
}

/** 某个 agent 会话区里的全部会话文件 */
const sessionText = (dataDir: string, agentId: string): string => {
  const dir = path.join(dataDir, "sessions", agentId);
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
        .join("\n")
    : "";
};

const messagesPurgedOf = (frontend: TestFrontend, channel: string) => frontend.events({ channel, type: EVENT_TYPES.messagesPurged }).map((f) => f.payload as MessagesPurgedEventPayload);

describe("彻底删除提问卡的回答、计划卡打回的意见", () => {
  it("记忆删除卡上彻底删除后：事件、卡片、交回秘书和维护者的通知、会话文件里都没有原话；提问卡还是已处理、计划还是已拒绝，重建派生视图后也一样", async () => {
    const answer = "给我爸看，他眼神不好字要大";
    const note = "别用英文资料，我爸看不懂";
    const { url, daemon, dataDir } = await startTestDaemon({
      secretary: [
        call("ask_questions", {
          taskId: "t-1",
          questions: [
            { question: "调研给谁看？", options: ["自己", "团队"], recommended: "自己" },
            { question: "要不要附价格？", options: [], recommended: "要" },
          ],
        }),
        say("先回答这两个问题"),
        say("收到"),
        search("我爸"),
        proposePurge,
        say("请核对"),
      ],
      maintainer: (_id, spawn) => (spawn === 1 ? [submitPlanStep(), say("计划交上去了"), say("好，照意见改")] : [say("好")]),
    });
    const frontend = await connect(url);
    const task = daemon.tasks.createByRequest({ title: "X 的调研", summary: "帮我整理一份 X 的调研" });
    expect(task.id).toBe("t-1");

    // 提问卡：第一题自己写的答案，第二题选推荐的；答案作为通知交回秘书
    await tell(frontend, "先问我几个问题");
    const questions = await cardWhere(frontend, (c) => c.type === "questions", "提问卡");
    ok(await frontend.cardAction({ cardId: questions.id, action: "answer", expectedVersion: 1, input: { answers: [{ questionId: "q1", answer }, { questionId: "q2", answer: "要" }] } }));
    await frontend.next(SECRETARY, EVENT_TYPES.turnEnd);
    const answersNotice = await eventually(() => noticesOf(frontend, SECRETARY), (m) => textOf(m).includes(answer), "交回秘书的回答");

    // 计划卡：附意见打回，意见交回维护者
    daemon.tasks.writeBrief(task.id, { goal: "整理一份 X 的调研", acceptanceCriteria: ["附来源"], constraints: [], projects: [], memoryScope: "" });
    const planCard = await cardWhere(frontend, (c) => c.type === "plan", "计划卡");
    await inputsDone(frontend, M1);
    ok(await frontend.cardAction({ cardId: planCard.id, action: "reject", expectedVersion: 1, note }));
    const rejectNotice = await eventually(() => noticesOf(frontend, M1), (m) => textOf(m).includes(note), "交回维护者的意见");
    await inputsDone(frontend, M1);
    expect(daemon.tasks.plan("t-1-p1")?.status).toBe("rejected");

    // 两条素材：澄清问题的回答、审批决定（计划卡上打回）
    await waitUntil(() => daemon.materials.list({ kind: "clarification_answer" }).length > 0 && daemon.materials.list({ kind: "approval_decision" }).length > 0, {
      timeoutMs: 10_000,
      describe: () => "等两条素材",
    });
    const answered = daemon.materials.list({ kind: "clarification_answer" })[0]!;
    const decided = daemon.materials.list({ kind: "approval_decision" }).find((m) => m.context.includes("card:plan"))!;
    expect(sessionText(dataDir, "secretary")).toContain("他眼神不好");
    expect(sessionText(dataDir, "tm-1")).toContain("别用英文资料");

    // 记忆删除卡上彻底删除这两条
    await tell(frontend, "彻底删除我说的我爸那两句");
    await purgeOnCard(frontend, [answered.id, decided.id]);

    // 整个事件日志里一个字都不剩
    const log = JSON.stringify(daemon.store.readGlobal(0, 100_000));
    expect(log).not.toContain("他眼神不好");
    expect(log).not.toContain("别用英文资料");
    expect(daemon.materials.get(answered.id)).toBeUndefined();
    expect(daemon.materials.get(decided.id)).toBeUndefined();

    // 提问卡的回答：每题的答案换成删除标记，哪一题、问题、按没按推荐原样；卡还是已处理，卡上的答案也换掉
    const answeredEvent = daemon.store.read(CARDS).find((e) => e.type === EVENT_TYPES.questionsAnswered)!;
    expect(answeredEvent.payload).toMatchObject({
      cardId: questions.id,
      taskId: "t-1",
      answers: [
        { questionId: "q1", question: "调研给谁看？", answer: PURGED_TEXT, recommended: "自己", followedRecommendation: false, chosenOption: false },
        { questionId: "q2", question: "要不要附价格？", answer: PURGED_TEXT, recommended: "要", followedRecommendation: true, chosenOption: true },
      ],
    });
    const questionsAfter = () => daemon.cards.get(questions.id)!;
    expect(questionsAfter()).toMatchObject({ status: "handled", outcome: { action: "answer" } });
    expect((questionsAfter().payload as QuestionsCardPayload).answers).toEqual([
      { questionId: "q1", answer: PURGED_TEXT },
      { questionId: "q2", answer: PURGED_TEXT },
    ]);

    // 计划的决定：打回的意见换成删除标记，决定、计划、卡片原样；计划卡还是已处理（打回），计划还是已拒绝
    const planDecided = daemon.store.read("tasks").find((e) => e.type === EVENT_TYPES.planDecided)!;
    expect(planDecided.payload).toMatchObject({ taskId: "t-1", planId: "t-1-p1", revision: 1, cardId: planCard.id, decision: "rejected", note: PURGED_TEXT });
    expect(daemon.cards.get(planCard.id)).toMatchObject({ status: "handled", outcome: { action: "reject", note: PURGED_TEXT } });
    expect(daemon.tasks.plan("t-1-p1")?.status).toBe("rejected");
    expect(daemon.tasks.get("t-1")?.state).toBe("planning");

    // 交回秘书、维护者的通知整条换成"已删除"；两个会话各追加 messages_purged（前端据此换掉，agent 据此改写会话文件）
    for (const [channel, notice] of [
      [SECRETARY, answersNotice],
      [M1, rejectNotice],
    ] as const) {
      const event = daemon.store.read(channel).find((e) => e.type === EVENT_TYPES.message && (e.payload as MessageEventPayload).message?.id === notice.message.id);
      expect(event).toBeUndefined();
      const marker = daemon.store.read(channel).find((e) => isDeletedEventPayload(e.payload) && (e.payload as { messageId?: string }).messageId === notice.message.id);
      expect(marker).toBeDefined();
      await waitUntil(() => messagesPurgedOf(frontend, channel).some((p) => p.messages.some((m) => m.messageId === notice.message.id)), {
        describe: () => `等 ${channel} 的 messages_purged`,
      });
    }

    // 会话文件：秘书（停下、改写、接着同一个会话拉起）和维护者的都改写了
    await waitUntil(() => !sessionText(dataDir, "secretary").includes("他眼神不好") && !sessionText(dataDir, "tm-1").includes("别用英文资料"), {
      timeoutMs: 20_000,
      describe: () => "等秘书和维护者的会话文件改写完",
    });
    expect(sessionText(dataDir, "secretary")).toContain(PURGED_TEXT);
    expect(sessionText(dataDir, "tm-1")).toContain(PURGED_TEXT);

    // 从事件日志整体重建派生视图：状态不变，原话也不回来
    daemon.store.rebuildViews();
    expect(daemon.tasks.plan("t-1-p1")?.status).toBe("rejected");
    expect(daemon.cards.get(planCard.id)).toMatchObject({ status: "handled", outcome: { action: "reject", note: PURGED_TEXT } });
    expect(questionsAfter()).toMatchObject({ status: "handled", payload: { answers: [{ answer: PURGED_TEXT }, { answer: PURGED_TEXT }] } });
  }, 90_000);
});

describe("彻底删除计划变更卡上拒绝时写的话", () => {
  it("设置里按时间段彻底删除：决定和卡上的话换成删除标记，交给维护者的通知整条换成“已删除”（按引着这段话找），这版计划还是已拒绝", async () => {
    const note = "别动外面的目录，那是我放私人照片的";
    const outside = real(makeTempDir("ergou-out-"));
    const base = twoStagePlan();
    const plan: Plan = { ...base, stages: [base.stages[0]!, { ...base.stages[1]!, dependsOn: [] }], toolkit: { ...base.toolkit, network: false } };
    const widened: Plan = {
      ...plan,
      stages: plan.stages.map((s) => (s.stageId === "s1" ? { ...s, policy: { ...s.policy, grants: [{ id: "dir1", tool: "make_dir", title: "建 s1 目录", scope: { path: path.join(outside, "s1") } }] } } : s)),
    };
    const { watchCategories: _w, userLimits: _u, memoryScope: _m, ...draft } = widened;
    const td = await startTestDaemon({
      maintainer: maintainerScript(plan, [call("propose_plan_change", { plan: draft, why: "资料要放到外面的共享目录" }), say("等你确认"), say("先做 s2"), say("好，不动外面的目录"), say("嗯")]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "拒绝");
    const card = await cardWhere(frontend, (c) => c.type === "plan_change", "计划变更卡");
    await taskWhere(frontend, (e) => e.change === "stage_started" && e.stageId === "s2", "s2 照常开始");
    await inputsDone(frontend, M1);
    ok(await frontend.cardAction({ cardId: card.id, action: "reject", expectedVersion: card.version, note }));
    const notice = await eventually(() => noticesOf(frontend, M1), (m) => textOf(m).includes("用户拒绝了计划变更"), "拒绝的通知");
    expect(textOf(notice)).toContain(`「${note}」`);
    await inputsDone(frontend, M1);
    await waitUntil(() => td.daemon.materials.list({ kind: "approval_decision" }).some((m) => m.context.includes("card:plan_change")), { timeoutMs: 10_000, describe: () => "拒绝的素材" });
    const material = td.daemon.materials.list({ kind: "approval_decision" }).find((m) => m.context.includes("card:plan_change"))!;
    // 拒绝之前的那条（不是拒绝的通知）留着
    const others = noticesOf(frontend, M1).filter((m) => m.message.id !== notice.message.id).map((m) => m.message.id);

    expect((await materialsApi.delete(td.url, { scope: { kind: "time_range", from: material.time, to: material.time }, mode: "purge", idempotencyKey: "purge-change" })).body).toEqual({ count: 1 });

    expect(JSON.stringify(td.daemon.store.readGlobal(0, 100_000))).not.toContain("私人照片");
    const decided = td.daemon.store.read("tasks").filter((e) => e.type === EVENT_TYPES.planDecided).at(-1)!;
    expect(decided.payload).toMatchObject({ planId: `${taskId}-p2`, decision: "rejected", note: PURGED_TEXT, change: { why: "资料要放到外面的共享目录" } });
    expect(td.daemon.cards.get(card.id)).toMatchObject({ status: "handled", outcome: { action: "reject", note: PURGED_TEXT } });
    expect(td.daemon.tasks.plan(`${taskId}-p2`)?.status).toBe("rejected");
    // 只有拒绝的那条通知换成"已删除"，别的通知还在
    const live = td.daemon.store
      .read(M1)
      .filter((e) => e.type === EVENT_TYPES.message && !isDeletedEventPayload(e.payload))
      .map((e) => (e.payload as MessageEventPayload).message.id);
    expect(live).not.toContain(notice.message.id);
    expect(live).toEqual(expect.arrayContaining(others));
    const purged = await eventually(() => messagesPurgedOf(frontend, M1), () => true, "维护者会话的 messages_purged");
    expect(purged.messages.map((m) => m.messageId)).toEqual([notice.message.id]);
    await waitUntil(() => !sessionText(td.dataDir, "tm-1").includes("私人照片"), { timeoutMs: 20_000, describe: () => "等维护者的会话文件改写完" });

    td.daemon.store.rebuildViews();
    expect(td.daemon.tasks.plan(`${taskId}-p2`)?.status).toBe("rejected");
    expect(td.daemon.tasks.confirmedPlan(taskId)?.planId).toBe(`${taskId}-p1`);
  }, 90_000);
});

describe("彻底删除授权续期的决定", () => {
  it("记忆删除卡上彻底删除：素材删掉，事件里没有用户写的话、原样保留；续期后的有效期不变，重建派生视图后也一样", async () => {
    const t0 = new Date(2026, 9, 8, 9, 0).getTime();
    const clock = new ManualClock(t0);
    const outside = real(makeTempDir("ergou-out-"));
    const base = twoStagePlan();
    const plan: Plan = {
      ...base,
      stages: [{ ...base.stages[0]!, policy: { grants: [{ id: "dir1", tool: "make_dir", title: "建 s1 目录", scope: { path: path.join(outside, "s1") } }], temporalRules: [] } }, base.stages[1]!],
    };
    const td = await startTestDaemon({
      clock,
      // 不让无进展的催促掺进来
      config: { tasks: { thresholds: { stallMinutes: 365 * 24 * 60 } } },
      secretary: [search("续期"), proposePurge, say("请核对")],
      maintainer: maintainerScript(plan, [say("开始了")]),
    });
    const frontend = await connect(td.url);
    const taskId = await confirmTask(td, frontend, "周报");
    await inputsDone(frontend, M1);

    clock.advanceTo(t0 + 6 * DAY + MINUTE);
    const item = await itemWhere(frontend, (i) => i.kind === "notice" && i.notice === "grant_renewal", "续期事项");
    ok(await frontend.inboxAction({ itemIds: [item.id], action: "handle", choice: "续期" }));
    await waitUntil(() => td.daemon.tasks.confirmedPlan(taskId)?.grantTimes?.dir1?.expiresAt === t0 + 14 * DAY, { timeoutMs: 10_000, describe: () => "有效期延长" });
    const renewals = () => td.daemon.materials.list({ kind: "approval_decision" }).filter((m) => m.context.includes("notice:grant_renewal"));
    await waitUntil(() => renewals().length === 1, { timeoutMs: 10_000, describe: () => "续期的素材" });
    const material = renewals()[0]!;
    const before = td.daemon.store.read("tasks").find((e) => e.type === EVENT_TYPES.grantRenewalDecided)!;

    await tell(frontend, "彻底删除续期那件事");
    await purgeOnCard(frontend, [material.id]);

    expect(td.daemon.materials.get(material.id)).toBeUndefined();
    // 事件原样：决定、授权项、续期前后的到期时间、这一版的全部有效期
    expect(td.daemon.store.eventAt("tasks", before.seq)!.payload).toEqual(before.payload);
    expect(before.payload).toMatchObject({ taskId, decision: "renewed", grants: [{ grantId: "dir1", title: "建 s1 目录" }] });
    expect(td.daemon.tasks.confirmedPlan(taskId)?.grantTimes?.dir1?.expiresAt).toBe(t0 + 14 * DAY);
    td.daemon.store.rebuildViews();
    expect(td.daemon.tasks.confirmedPlan(taskId)?.grantTimes?.dir1?.expiresAt).toBe(t0 + 14 * DAY);
    expect(td.daemon.inbox.get(item.id)).toMatchObject({ kind: "notice", handled: "续期" });
  }, 90_000);
});
