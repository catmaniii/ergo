// 任务发起和计划确认用到的三种卡（卡片类型注册表，规格第 5、7、8 节）：
// - "建议发起任务"卡（suggest_task）：秘书自己发现、用户没要求的事。"发起任务"建出任务（规划中，用户发起），
//   同一事务给秘书一条通知；"不用了"关掉（回避信号）；
// - 提问卡（questions）：成批提问、每题带推荐。"提交回答"（"全按推荐"就是每题都填推荐的那个）同一事务追加
//   questions_answered（"澄清问题的回答"素材的来源），并把答案作为一条通知交回提问的一方（秘书；16 号票起项目维护者为工单
//   提问时交回它，交回的通知由派单器的澄清给：work-orders/clarifications.ts）；"不用了"关掉（回避信号）；
// - 计划卡（plan）：代码从结构化计划生成。唯一的"确认"按钮（可带勾掉、收窄的授权项），或附意见"打回"。
import {
  CHANNELS,
  PlanCardPayload,
  PlanConfirmInput,
  QuestionsAnswerInput,
  type QuestionsAnsweredPayload,
  QuestionsCardPayload,
  SuggestTaskCardPayload,
  EVENT_TYPES,
} from "@ergou/protocol";
import { defineCardType } from "../cards/registry.ts";
import { buildAgentNotice } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { NewEvent } from "../events/event-store.ts";
import { suggestionStartedNotice, type TaskService } from "./tasks.ts";

/** "建议发起任务"卡（2：卡上可以写涉及的项目，16 号票） */
export function suggestTaskCardType(tasks: TaskService) {
  return defineCardType({
    type: "suggest_task",
    version: 2,
    payload: SuggestTaskCardPayload,
    actions: {
      start_task: {
        input: undefined,
        run: ({ payload, idempotencyKey }) => {
          // 卡上写了涉及的项目（2，16 号票）：恰好一个时由这个项目的维护者起草并执行
          const { task, events } = tasks.buildCreate({ title: payload.title, summary: payload.why, origin: "suggestion", ...(payload.projects ? { projects: payload.projects } : {}) }, "user");
          const notice = buildAgentNotice(CHANNELS.secretary, suggestionStartedNotice(task), `${idempotencyKey}#notice`);
          return { status: "handled", payload: { ...payload, taskId: task.id }, events: [...events, notice.event] };
        },
      },
      dismiss: { input: undefined, run: () => ({ status: "dismissed" }) },
    },
    toText: (p) => `建议发起任务：${p.title}（${p.why}）`,
  });
}

/** 提问卡上的回答交回项目维护者（16 号票，派单器的澄清给）：返回和卡片的处理同一事务追加的事件 */
export type WorkOrderReply = (payload: QuestionsCardPayload, answer: { lines: readonly string[]; allRecommended: boolean }, key: string) => NewEvent[];

/** 提问卡（2：项目维护者为工单提问时卡上记着是谁问的，回答交回它，16 号票） */
export function questionsCardType(workOrderReply: WorkOrderReply) {
  return defineCardType({
    type: "questions",
    version: 2,
    payload: QuestionsCardPayload,
    actions: {
      answer: {
        input: QuestionsAnswerInput,
        run: ({ card, payload, input, now, idempotencyKey }) => {
          const byId = new Map(input.answers.map((a) => [a.questionId, a.answer.trim()]));
          const unknown = input.answers.filter((a) => !payload.questions.some((q) => q.id === a.questionId)).map((a) => a.questionId);
          if (unknown.length > 0) throw new RequestRejected("bad_params", `卡上没有这些题：${unknown.join("、")}`);
          const missing = payload.questions.filter((q) => !byId.get(q.id)).map((q) => q.id);
          if (missing.length > 0) throw new RequestRejected("bad_params", `还有题没回答：${missing.join("、")}`);
          const answers = payload.questions.map((q) => {
            const answer = byId.get(q.id)!;
            return { questionId: q.id, question: q.question, answer, recommended: q.recommended, followedRecommendation: answer === q.recommended, chosenOption: answer === q.recommended || q.options.includes(answer) };
          });
          const askedBy = payload.askedBy;
          const answered: QuestionsAnsweredPayload = {
            cardId: card.id,
            ...(payload.taskId === undefined ? {} : { taskId: payload.taskId }),
            ...(askedBy ? { projectId: askedBy.projectId } : {}),
            answers,
            time: now,
          };
          const allRecommended = answers.every((a) => a.followedRecommendation);
          const lines = answers.map((a, i) => `${i + 1}. ${a.question} → ${a.answer}${a.followedRecommendation ? "（推荐的）" : ""}`);
          // 项目维护者为工单问的（16 号票）：回答交回它（派单器的澄清给通知）；别的交回秘书
          const replies = askedBy
            ? workOrderReply(payload, { lines, allRecommended }, idempotencyKey)
            : [buildAgentNotice(CHANNELS.secretary, `用户回答了提问卡${payload.taskId === undefined ? "" : `（任务 ${payload.taskId}）`}${allRecommended ? "，全按推荐" : ""}：\n${lines.join("\n")}`, `${idempotencyKey}#notice`).event];
          return {
            status: "handled",
            payload: { ...payload, answers: answers.map((a) => ({ questionId: a.questionId, answer: a.answer })) },
            note: allRecommended ? "全按推荐" : `回答了 ${answers.length} 题`,
            events: [{ channel: CHANNELS.cards, type: EVENT_TYPES.questionsAnswered, payload: answered, idempotencyKey: `${idempotencyKey}#answered` }, ...replies],
          };
        },
      },
      dismiss: { input: undefined, run: () => ({ status: "dismissed" }) },
    },
    toText: (p) => `提问（${p.questions.length} 个问题）：${p.questions.map((q) => q.question).join("；")}`,
  });
}

/** 计划卡 */
export function planCardType(tasks: TaskService) {
  return defineCardType({
    type: "plan",
    // 2：计划里定时作业的时间表多了"按我的工作日"（29 号票）
    // 3（26 号票）：计划里有用户的限制，确认时可以加本任务的关注类别
    version: 3,
    payload: PlanCardPayload,
    actions: {
      confirm: { input: PlanConfirmInput, run: ({ payload, input, idempotencyKey }) => tasks.confirmFromCard(payload, input, idempotencyKey) },
      reject: { input: undefined, run: ({ payload, note, idempotencyKey }) => tasks.rejectFromCard(payload, note, idempotencyKey) },
    },
    toText: (p) =>
      `计划：${p.taskTitle}（第 ${p.revision} 版，${p.plan.stages.length} 个阶段，约 ${p.plan.tokenEstimate} token）${p.plan.userLimits?.length ? `；按你说过的话加了 ${p.plan.userLimits.length} 条限制` : ""}`,
  });
}

