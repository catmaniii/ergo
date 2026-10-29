// 任务发起和计划确认用到的三种卡（卡片类型注册表，规格第 5、7、8 节）：
// - "建议发起任务"卡（suggest_task）：秘书觉得该发起、但用户没点明的事。"作为流程""作为长程任务"建出这种任务
//   （规划中，用户发起，58 号票），同一事务给一条通知（建成项目内部任务的交给项目的维护者，别的交给秘书，64 号票）；
//   "不用了"关掉（回避信号）；
// - 提问卡（questions）：成批提问、每题带推荐。"提交回答"（"全按推荐"就是每题都填推荐的那个）同一事务追加
//   questions_answered（"澄清问题的回答"素材的来源），并把答案作为一条通知交回提问的一方（秘书；16 号票起项目维护者为工单
//   提问时交回它，交回的通知由派单器的澄清给：work-orders/clarifications.ts）；"不用了"关掉（回避信号）。
//   彻底删除这份回答时卡上记的答案换成删除标记（purge，80 号票）；
// - 计划卡（plan）：代码从结构化计划生成。唯一的"确认"按钮（可带勾掉、收窄的授权项），或附意见"打回"；
// - 流程计划卡（workflow_plan，58 号票）：审查结果、步骤和每一步的条件；需要你确认的事项逐条勾完，"授权执行"一次授权，
//   或"拒绝"（可以附说明）。
// 172 号票：卡上处理结果的一句（note）、点按钮被拒的原因按当时的语言写；交给秘书的回答照旧中文。
// 175 号票：toText（卡片的纯文字说法：网页卡片详情的标题、引用卡片那一行、认不得的卡都显示它）和别的卡一样按当时的语言写
import {
  CHANNELS,
  describeSchedule,
  t,
  internalScopeLabel,
  PlanCardPayload,
  PlanConfirmInput,
  PURGED_TEXT,
  QuestionsAnswerInput,
  type QuestionsAnsweredPayload,
  QuestionsCardPayload,
  SuggestTaskCardPayload,
  type PlannedTaskKind,
  EVENT_TYPES,
  TIMED_WORKFLOW_GRANT_TEXT,
  describeEventTrigger,
  EVENT_PLACEHOLDER_NOTE,
  EVENT_WORKFLOW_GRANT_TEXT,
  WORKFLOW_REVIEW_STATUS_LABEL,
  WorkflowConfirmInput,
  WorkflowPlanCardPayload,
} from "@ergo/protocol";
import { defineCardType } from "../cards/registry.ts";
import { buildAgentNotice } from "../conversation/messages.ts";
import { RequestRejected } from "../errors.ts";
import type { NewEvent } from "../events/event-store.ts";
import type { TaskExecution } from "./execution.ts";
import type { TaskService } from "./tasks.ts";

/**
 * "建议发起任务"卡（2：卡上可以写涉及的项目，16 号票；3：两个按钮"作为流程"（start_workflow）"作为长程任务"（start_task），
 * 建出后记着种类，58 号票）
 */
export function suggestTaskCardType(tasks: TaskService) {
  /**
   * 用户点了哪个按钮，就建哪种任务（用户发起），同一事务的通知由 TaskService 定：建成项目内部任务的交给项目的维护者
   * （64 号票：项目的维护者给的卡、秘书给的卡上恰好写了一个项目），别的交给秘书
   */
  const start = (kind: PlannedTaskKind) => ({
    input: undefined,
    run: ({ payload, idempotencyKey }: { payload: SuggestTaskCardPayload; idempotencyKey: string }) => {
      const base = { title: payload.title, summary: payload.why, origin: "suggestion" as const, kind };
      const { task, events } = payload.internal
        ? tasks.buildInternal({ ...base, projectId: payload.internal.projectId }, "user", { how: "maintainer_suggestion", key: idempotencyKey })
        : tasks.buildCreate({ ...base, ...(payload.projects ? { projects: payload.projects } : {}) }, "user", { how: "secretary_suggestion", key: idempotencyKey });
      return { status: "handled" as const, payload: { ...payload, taskId: task.id, kind }, events };
    },
  });
  return defineCardType({
    type: "suggest_task",
    // 4（64 号票）：项目的维护者给的建议卡带着项目（internal），点了建出的是这个项目的内部任务
    version: 4,
    payload: SuggestTaskCardPayload,
    actions: {
      start_workflow: start("workflow"),
      start_task: start("long_running"),
      dismiss: { input: undefined, run: () => ({ status: "dismissed" }) },
    },
    toText: (p) =>
      p.internal
        ? t("tasks.cards.text.suggestInternal", { scope: internalScopeLabel(p.internal.projectName), title: p.title, why: p.why })
        : t("tasks.cards.text.suggest", { title: p.title, why: p.why }),
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
          if (unknown.length > 0) throw new RequestRejected("bad_params", t("tasks.cards.unknownQuestions", { ids: unknown.join(t("protocol.common.listSep")) }));
          const missing = payload.questions.filter((q) => !byId.get(q.id)).map((q) => q.id);
          if (missing.length > 0) throw new RequestRejected("bad_params", t("tasks.cards.unanswered", { ids: missing.join(t("protocol.common.listSep")) }));
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
          // 交回提问的一方（秘书、项目维护者）的回答，照旧中文
          // @i18n-ignore-start model
          const lines = answers.map((a, i) => `${i + 1}. ${a.question} → ${a.answer}${a.followedRecommendation ? "（推荐的）" : ""}`);
          // 项目维护者为工单问的（16 号票）：回答交回它（派单器的澄清给通知）；别的交回秘书
          const replies = askedBy
            ? workOrderReply(payload, { lines, allRecommended }, idempotencyKey)
            : [buildAgentNotice(CHANNELS.secretary, `用户回答了提问卡${payload.taskId === undefined ? "" : `（任务 ${payload.taskId}）`}${allRecommended ? "，全按推荐" : ""}：\n${lines.join("\n")}`, `${idempotencyKey}#notice`).event];
          // @i18n-ignore-end
          return {
            status: "handled",
            payload: { ...payload, answers: answers.map((a) => ({ questionId: a.questionId, answer: a.answer })) },
            note: allRecommended ? t("tasks.cards.allRecommended") : t("tasks.cards.answered", { n: answers.length, count: answers.length }),
            events: [{ channel: CHANNELS.cards, type: EVENT_TYPES.questionsAnswered, payload: answered, idempotencyKey: `${idempotencyKey}#answered` }, ...replies],
          };
        },
      },
      dismiss: { input: undefined, run: () => ({ status: "dismissed" }) },
    },
    toText: (p) => t("tasks.cards.text.questions", { n: p.questions.length, questions: p.questions.map((q) => q.question).join(t("protocol.common.semiSep")) }),
    // 彻底删除提问卡的回答（80 号票）：卡上记的答案换成删除标记，题目、选项、推荐（agent 问的）不变
    purge: (p) => (p.answers === undefined ? p : { ...p, answers: p.answers.map((a) => ({ ...a, answer: PURGED_TEXT })) }),
  });
}

/** 计划卡 */
export function planCardType(tasks: TaskService) {
  return defineCardType({
    type: "plan",
    // 2：计划里定时作业的时间表多了"按我的工作日"（29 号票）
    // 3（26 号票）：计划里有用户的限制，确认时可以加本任务的关注类别
    // 4（17 号票）：涉及的项目每一行可以写所属阶段和这张工单的验收标准
    // 5（76 号票）：计划里不再有定时作业（要定时做的事建成定时触发的普通任务或流程）
    version: 5,
    payload: PlanCardPayload,
    actions: {
      confirm: { input: PlanConfirmInput, run: ({ payload, input, idempotencyKey }) => tasks.confirmFromCard(payload, input, idempotencyKey) },
      reject: { input: undefined, run: ({ payload, note, idempotencyKey }) => tasks.rejectFromCard(payload, note, idempotencyKey) },
    },
    toText: (p) =>
      t("tasks.cards.text.plan", { title: p.taskTitle, revision: p.revision, stages: p.plan.stages.length, count: p.plan.stages.length, tokens: p.plan.tokenEstimate }) +
      (p.plan.userLimits?.length ? t("tasks.cards.text.planLimits", { n: p.plan.userLimits.length, count: p.plan.userLimits.length }) : ""),
  });
}


/**
 * 审查没让它交给你授权的那一版上的动作：取消任务两种都有；让维护者改只在判定不可执行的上有，
 * 知道了只在退回维护者补充的上有（维护者自己会改好重新提交；不可执行的点"知道了"任务会一直停在规划中）
 */
function refusedOnly(payload: WorkflowPlanCardPayload, only?: NonNullable<WorkflowPlanCardPayload["refused"]>): void {
  if (!payload.refused) throw new RequestRejected("not_allowed", t("tasks.cards.planWaiting"));
  if (only === "blocked" && payload.refused !== "blocked") throw new RequestRejected("not_allowed", t("tasks.cards.planReturned"));
  if (only === "needs_replan" && payload.refused !== "needs_replan") throw new RequestRejected("not_allowed", t("tasks.cards.planBlocked"));
}

/**
 * 流程计划卡（58 号票）：授权执行（confirm）、拒绝（reject，可以附说明）；审查退回、判定不可执行的那一版（refused）
 * 判定不可执行的只能让维护者改（return，可以附说明）或者取消任务（cancel：和任务详情里的"取消"同一个控制），
 * 退回维护者补充的只能知道了（ack）或者取消任务
 */
export function workflowPlanCardType(tasks: TaskService, execution: () => Pick<TaskExecution, "prepareAct">) {
  return defineCardType({
    type: "workflow_plan",
    // 2（76 号票）：定时触发的流程带着时间表；3（282 号票）：时间表多了每年某月某日
    version: 3,
    payload: WorkflowPlanCardPayload,
    actions: {
      confirm: { input: WorkflowConfirmInput, run: ({ payload, input, idempotencyKey }) => tasks.confirmWorkflowFromCard(payload, input, idempotencyKey) },
      reject: { input: undefined, run: ({ payload, note, idempotencyKey }) => tasks.rejectWorkflowFromCard(payload, note, idempotencyKey) },
      return: {
        input: undefined,
        run: ({ payload, note, idempotencyKey }) => {
          refusedOnly(payload, "blocked");
          return tasks.reviseWorkflowFromCard(payload, note, idempotencyKey);
        },
      },
      ack: {
        input: undefined,
        run: ({ payload }) => {
          refusedOnly(payload, "needs_replan");
          return { status: "handled" };
        },
      },
      cancel: {
        input: undefined,
        run: ({ payload, idempotencyKey }) => {
          refusedOnly(payload);
          const prepared = execution().prepareAct({ taskId: payload.taskId, action: "cancel" }, `${idempotencyKey}#task`);
          return { status: "handled", note: t("tasks.cards.cancelledTask"), events: prepared.events, afterCommit: prepared.afterCommit };
        },
      },
    },
    toText: workflowPlanText,
  });
}

/** 流程计划卡的纯文字说法（175 号票起按当时的语言） */
function workflowPlanText(p: WorkflowPlanCardPayload): string {
  const status = p.plan.review.status ? WORKFLOW_REVIEW_STATUS_LABEL[p.plan.review.status].label : t("tasks.cards.text.workflow.notReviewed");
  if (p.refused) return t("tasks.cards.text.workflow.refused", { title: p.taskTitle, revision: p.revision, status });
  const inserted = p.plan.steps.filter((s) => s.inserted).length;
  const timed = p.schedule ? t("tasks.cards.text.workflow.timed", { schedule: describeSchedule(p.schedule), grant: TIMED_WORKFLOW_GRANT_TEXT }) : "";
  // 事件触发的流程（77 号票）：在等什么事件、授权管多久、步骤里的占位怎么代入
  const evented = p.event ? t("tasks.cards.text.workflow.evented", { trigger: describeEventTrigger(p.event), grant: EVENT_WORKFLOW_GRANT_TEXT, placeholder: EVENT_PLACEHOLDER_NOTE }) : "";
  return t("tasks.cards.text.workflow.plan", {
    title: p.taskTitle,
    revision: p.revision,
    steps: p.plan.steps.length,
    count: p.plan.steps.length,
    status,
    inserted: inserted > 0 ? t("tasks.cards.text.workflow.inserted", { n: inserted, count: inserted }) : "",
    timed,
    evented,
  });
}
