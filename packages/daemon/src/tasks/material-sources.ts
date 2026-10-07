// 任务发起和计划确认产生的素材（规格第 15 节），在 daemon.ts 里、materials.start() 之前登记：
// - 用户发言：点"发起任务"按钮时写的原话（task 事件，建出、发起方式是按钮的那条）——本人、打的字，和在会话里说的一样；
// - 澄清问题的回答：提问卡上"提交回答"（questions_answered 事件）。选的是卡上现成的选项（含推荐的那个）算用户接受了
//   agent 先提出的东西（本人，注明 agent 先提出）；自己写的答案是用户自己的话（本人）。问题本身是 agent 的产出，只留在答案的说法里；
// - 审批决定：计划卡上的确认（连同勾掉、收窄的授权项）和打回（plan_decided 事件）。确认、勾掉、收窄都是用户在 agent 先提出的
//   计划上做的选择；打回的意见、确认时改过的假设栏是用户自己的话。授权项的说法和计划卡上一样，由结构化数据生成（grantText）。
// "建议发起任务"卡、提问卡被关掉是回避信号（卡片被关闭事件，素材模块已经采集）。
import { EVENT_TYPES, grantText, planGrants, type QuestionsAnsweredPayload, type TaskEventPayload } from "@ergou/protocol";
import { type MaterialPiece, type MaterialSource, segmentPieces, userDecisionDraft } from "../materials/index.ts";
import type { PlanDecidedPayload } from "./events.ts";

export const startTaskRequestSource: MaterialSource = {
  // 素材 id 由它算出来，定了别改
  name: "start-task-request",
  eventType: EVENT_TYPES.task,
  capture(event) {
    const { task, change, by } = event.payload as TaskEventPayload;
    if (change !== "created" || task.origin !== "button" || by !== "user") return [];
    return [
      {
        kind: "user_utterance",
        source: "self",
        time: task.createdAt,
        task: task.id,
        context: ["start_task_button", ...task.projects.map((p) => `project:${p}`)],
        segments: segmentPieces([{ form: "typed", text: task.summary, locator: { field: "task.summary" } }]),
        ref: { recordId: task.id },
      },
    ];
  },
};

export const clarificationAnswerSource: MaterialSource = {
  // 素材 id 由它算出来，定了别改
  name: "clarification-answer",
  eventType: EVENT_TYPES.questionsAnswered,
  capture(event) {
    const p = event.payload as QuestionsAnsweredPayload;
    const pieces: MaterialPiece[] = p.answers.map((a, i) => ({
      form: a.chosenOption ? "choice" : "typed",
      text: `${a.question} → ${a.answer}`,
      locator: { field: `answers[${i}]` },
    }));
    return [
      {
        kind: "clarification_answer",
        source: "self",
        time: p.time,
        ...(p.taskId === undefined ? {} : { task: p.taskId }),
        context: ["card:questions", ...(p.answers.every((a) => a.followedRecommendation) ? ["all_recommended"] : [])],
        segments: segmentPieces(pieces),
        ref: { cardId: p.cardId },
      },
    ];
  },
};

export const planDecisionSource: MaterialSource = {
  name: "plan-decision",
  eventType: EVENT_TYPES.planDecided,
  capture(event) {
    const p = event.payload as PlanDecidedPayload;
    const what = `任务「${p.taskTitle}」的计划（第 ${p.revision} 版）`;
    const narrowed = p.plan === undefined ? [] : p.narrowedGrants.flatMap((id) => planGrantById(p.plan!, id) ?? []);
    const changes = [...p.removedGrants.map((g) => `勾掉授权「${grantText(g, p.grantInfo[g.id])}」`), ...narrowed.map((g) => `收窄授权为「${grantText(g, p.grantInfo[g.id])}」`)];
    const decision = p.decision === "confirmed" ? `确认${what}${changes.length > 0 ? `：${changes.join("，")}` : ""}` : `打回${what}`;
    const typed = [...(p.note ? [{ text: p.note, field: "note" }] : []), ...(p.assumptions ? [{ text: `假设栏改成：${p.assumptions.after.join("；") || "（清空）"}`, field: "assumptions" }] : [])];
    return [
      userDecisionDraft({
        kind: "approval_decision",
        time: p.time,
        task: p.taskId,
        context: [
          `decision:${p.decision}`,
          "card:plan",
          ...(p.removedGrants.length > 0 ? ["grants_removed"] : []),
          ...(p.narrowedGrants.length > 0 ? ["grants_narrowed"] : []),
          ...(p.assumptions ? ["assumptions_edited"] : []),
        ],
        ref: { recordId: p.planId, cardId: p.cardId },
        accepted: { text: decision, field: "decision" },
        typed,
      }),
    ];
  },
};

function planGrantById(plan: NonNullable<PlanDecidedPayload["plan"]>, id: string) {
  return planGrants(plan).find((g) => g.grant.id === id)?.grant;
}
