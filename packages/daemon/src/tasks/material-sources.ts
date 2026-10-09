// 任务发起和计划确认产生的素材（规格第 15 节），在 daemon.ts 里、materials.start() 之前登记：
// - 用户发言：点"发起任务"按钮时写的原话（task 事件，建出、发起方式是按钮的那条）——本人、打的字，和在会话里说的一样；
// - 澄清问题的回答：提问卡上"提交回答"（questions_answered 事件）。选的是卡上现成的选项（含推荐的那个）算用户接受了
//   agent 先提出的东西（本人，注明 agent 先提出）；自己写的答案是用户自己的话（本人）。问题本身是 agent 的产出，只留在答案的说法里；
// - 审批决定：计划卡上的确认（连同勾掉、收窄的授权项）和打回（plan_decided 事件）。确认、勾掉、收窄都是用户在 agent 先提出的
//   计划上做的选择；打回的意见、确认时改过的假设栏、在卡上给这个任务加的关注类别（26 号票）是用户自己的话。
//   授权项的说法和计划卡上一样，由结构化数据生成（grantText）。
// - 审批决定（14 号票）：计划变更卡上的确认、拒绝（也是 plan_decided，带 change），授权到期续期事项上的续期、不续
//   （grant_renewal_decided）。改动的说法和卡上一样由结构化数据生成（planChangeItemText）；拒绝时写的话是用户自己的话。
// - 审批决定（58 号票）：流程计划卡上的授权执行（连同逐项勾了的确认事项）、拒绝、判定不可执行的那版上的"让维护者改"
//   （也是 plan_decided，带 workflow；让维护者改的 decision 是 returned）；
//   拒绝时写的说明是用户自己的话。
// "建议发起任务"卡、提问卡被关掉是回避信号（卡片被关闭事件，素材模块已经采集）。
import {
  categoryMatchText,
  DISPOSITION_LABEL,
  EVENT_TYPES,
  grantText,
  planChangeItemText,
  planGrants,
  type PlanWatchCategory,
  PURGED_TEXT,
  type QuestionsAnsweredPayload,
  type Task,
  type TaskEventPayload,
  workflowConfirmationItems,
} from "@ergou/protocol";
import { type MaterialPiece, type MaterialSource, segmentPieces, userDecisionDraft } from "../materials/index.ts";
import { type PurgeRewriter, purgedField } from "../events/purge.ts";
import type { GrantRenewalDecidedPayload, OutputReactionPayload, PlanDecidedPayload } from "./events.ts";

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
        // 项目维护者为工单问的（16 号票）：属于那个项目
        ...(p.projectId === undefined ? {} : { project: p.projectId }),
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
    // 计划变更卡上的决定（14 号票）：写明维护者要改什么（卡上列的那几处）
    // 流程计划卡上的决定（58 号票）：授权执行（连同逐项勾了的确认事项）或拒绝（可以附说明）
    const what = p.change
      ? `任务「${p.taskTitle}」的计划变更（${p.change.changes.map((c) => planChangeItemText(c, p.grantInfo)).join("；")}）`
      : p.workflow
        ? `流程「${p.taskTitle}」的计划（第 ${p.revision} 版，${p.workflow.steps.length} 步）`
        : `任务「${p.taskTitle}」的计划（第 ${p.revision} 版）`;
    const narrowed = p.plan === undefined ? [] : p.narrowedGrants.flatMap((id) => planGrantById(p.plan!, id) ?? []);
    const changes = [...p.removedGrants.map((g) => `勾掉授权「${grantText(g, p.grantInfo[g.id])}」`), ...narrowed.map((g) => `收窄授权为「${grantText(g, p.grantInfo[g.id])}」`)];
    const confirmations = p.workflow ? workflowConfirmationItems(p.workflow.review, p.workflow.steps).filter((i) => p.confirmations?.includes(i.key)) : [];
    if (confirmations.length > 0) changes.push(`同意了需要确认的事项（${confirmations.map((i) => i.text).join("；")}）`);
    const decision =
      p.decision === "confirmed"
        ? `${p.workflow ? "授权执行" : "确认"}${what}${changes.length > 0 ? `：${changes.join("，")}` : ""}`
        : p.decision === "returned"
          ? `让维护者改${what}（审查判定不可执行）`
          : p.change || p.workflow
            ? `拒绝${what}`
            : `打回${what}`;
    const typed = [
      ...(p.note ? [{ text: p.note, field: "note" }] : []),
      ...(p.assumptions ? [{ text: `假设栏改成：${p.assumptions.after.join("；") || "（清空）"}`, field: "assumptions" }] : []),
      // 卡上加的关注类别：名字和规则都是用户自己写的（26 号票）
      ...(p.addedCategories ?? []).map((c) => ({ text: addedCategoryText(c), field: "categories" })),
    ];
    return [
      userDecisionDraft({
        kind: "approval_decision",
        time: p.time,
        task: p.taskId,
        context: [
          `decision:${p.decision}`,
          p.change ? "card:plan_change" : p.workflow ? "card:workflow_plan" : "card:plan",
          ...(confirmations.length > 0 ? ["items_confirmed"] : []),
          ...(p.removedGrants.length > 0 ? ["grants_removed"] : []),
          ...(p.narrowedGrants.length > 0 ? ["grants_narrowed"] : []),
          ...(p.assumptions ? ["assumptions_edited"] : []),
          ...(p.addedCategories?.length ? ["categories_added"] : []),
        ],
        ref: { recordId: p.planId, cardId: p.cardId },
        accepted: { text: decision, field: "decision" },
        typed,
      }),
    ];
  },
};

/** 卡上加的一个关注类别写成一句话："给这个任务加了关注类别「动迁移目录」：路径在 D:\app\db 之内，先问我" */
function addedCategoryText(c: PlanWatchCategory): string {
  const rule = c.match ? categoryMatchText(c.match) : "";
  const disposition = c.disposition ? DISPOSITION_LABEL[c.disposition] : "";
  return `给这个任务加了关注类别「${c.title ?? c.id}」：${[rule, disposition].filter(Boolean).join("，")}`;
}

function planGrantById(plan: NonNullable<PlanDecidedPayload["plan"]>, id: string) {
  return planGrants(plan).find((g) => g.grant.id === id)?.grant;
}

// ───────────────────────── 13 号票：任务结局、用户对产出的反应 ─────────────────────────

/** 任务结局是谁定的：全部验收后自动完成是系统，判失败是维护者（agent），取消是用户 */
const OUTCOME_SOURCE = { completed: "system", failed: "agent", cancelled: "self" } as const;

/**
 * 任务结局（完成、失败、取消）：看板频道上的 task 事件。结局本身不是谁的原话，只留一条引用（说明里写任务名和结局，
 * 失败带上维护者写的原因），来源是定下这个结局的一方
 */
export const taskOutcomeSource: MaterialSource = {
  // 素材 id 由它算出来，定了别改
  name: "task-outcome",
  eventType: EVENT_TYPES.task,
  capture(event) {
    const { task, change, by } = event.payload as TaskEventPayload;
    if (change !== "completed" && change !== "failed" && change !== "cancelled") return [];
    const label =
      change === "completed" ? `任务「${task.title}」已完成` : change === "failed" ? `任务「${task.title}」失败${task.failReason ? `：${task.failReason}` : ""}` : `任务「${task.title}」已取消`;
    return [
      {
        kind: "task_outcome",
        source: OUTCOME_SOURCE[change],
        time: task.updatedAt,
        task: task.id,
        context: [`outcome:${change}`, `by:${by}`],
        segments: segmentPieces([{ form: "agent_output", label, locator: { field: "task" } }]),
        ref: { recordId: task.id },
      },
    ];
  },
};

const REACTION_TEXT: Record<OutputReactionPayload["reaction"], string> = { accepted: "验收通过", returned: "退回", rework: "要求返工" };

/**
 * 用户对产出的反应："由你验收"的阶段验收通过或退回、对已完成的任务要求返工（tasks 频道的 output_reaction）。
 * 用户在 agent 的产出上做的选择（本人，注明 agent 先提出）；退回、返工时写的原因是用户自己的话
 */
export const outputReactionSource: MaterialSource = {
  // 素材 id 由它算出来，定了别改
  name: "output-reaction",
  eventType: EVENT_TYPES.outputReaction,
  capture(event) {
    const p = event.payload as OutputReactionPayload;
    return [
      userDecisionDraft({
        kind: "output_reaction",
        time: p.time,
        task: p.taskId,
        context: [`reaction:${p.reaction}`, `stage:${p.stageId}`, ...(p.reopened ?? []).map((s) => `reopened:${s}`)],
        ref: { recordId: p.taskId },
        accepted: { text: `${REACTION_TEXT[p.reaction]}：任务「${p.taskTitle}」阶段 ${p.stageId}「${p.stageTitle}」的产出`, field: "reaction" },
        typed: p.note ? [{ text: p.note, field: "note" }] : [],
      }),
    ];
  },
};

/**
 * 彻底删除：任务事件只改写等我的说明（waitNote：被杀后"中断：不确定 X 是否已执行"里的调用摘要，23 号票），
 * 任务的状态、阶段、原因不变。别的字段还没有改写规则（比如发起任务时写的原话在之后每个快照里都有）：
 * 没有等我说明的任务事件被要求改写时报错，整个删除被拒，不悄悄删一半
 */
export const taskWaitNotePurge: PurgeRewriter = {
  eventType: EVENT_TYPES.task,
  rewrite: (event) => {
    const p = event.payload as TaskEventPayload;
    if (p.task.waitNote === undefined) throw new Error(`彻底删除：任务事件（${event.channel}#${event.seq}）只能改写等我的说明，别的字段还没有改写规则`);
    return { ...p, task: { ...p.task, waitNote: PURGED_TEXT } } satisfies TaskEventPayload;
  },
};

/**
 * 删除项目时它的内部任务一起删掉（64 号票，projects/deletion.ts）：任务的文字换成删除标记——标题、说明、等我和失败的原因、
 * 步骤和阶段的名字、要点、验收标准；编号、状态、种类、归属这些结构字段原样（看板的行留着，新任务的编号接着往下排）
 */
export function purgedTask(task: Task): Task {
  const steps = task.steps?.list && { ...task.steps, list: task.steps.list.map((s) => ({ ...s, title: PURGED_TEXT, ...(s.gist === undefined ? {} : { gist: PURGED_TEXT }) })) };
  const stages = task.stages?.list && {
    ...task.stages,
    list: task.stages.list.map((s) => ({
      ...s,
      title: PURGED_TEXT,
      ...(s.waitNote === undefined ? {} : { waitNote: PURGED_TEXT }),
      acceptance: s.acceptance.map((a) => ({ ...a, criterion: PURGED_TEXT, ...(a.result ? { result: { ...a.result, ...(a.result.note === undefined ? {} : { note: PURGED_TEXT }) } } : {}) })),
    })),
  };
  return {
    ...task,
    title: PURGED_TEXT,
    summary: PURGED_TEXT,
    ...(task.waitNote === undefined ? {} : { waitNote: PURGED_TEXT }),
    ...(task.failReason === undefined ? {} : { failReason: PURGED_TEXT }),
    ...(steps ? { steps } : {}),
    ...(stages ? { stages } : {}),
  };
}

/** 彻底删除：用户对产出的反应只换掉用户写的原因，任务、阶段、反应不变 */
export const outputReactionPurge: PurgeRewriter = {
  eventType: EVENT_TYPES.outputReaction,
  rewrite: (event) => {
    const p = event.payload as OutputReactionPayload;
    return { ...p, ...purgedField(p, "note") } satisfies OutputReactionPayload;
  },
};

// ───────────────────────── 14 号票：授权项续期 ─────────────────────────

/**
 * 审批决定：用户在"授权到期续期"事项上续期或不续（tasks 频道的 grant_renewal_decided）。
 * 续期是用户在运行时提出的事项上做的选择（本人，注明 agent 先提出）；授权项的说法取维护者写的那一句
 */
export const grantRenewalSource: MaterialSource = {
  // 素材 id 由它算出来，定了别改
  name: "grant-renewal",
  eventType: EVENT_TYPES.grantRenewalDecided,
  capture(event) {
    const p = event.payload as GrantRenewalDecidedPayload;
    const what = p.grants.map((g) => `「${g.title}」`).join("、");
    return [
      userDecisionDraft({
        kind: "approval_decision",
        time: p.time,
        task: p.taskId,
        context: [`decision:${p.decision}`, "notice:grant_renewal"],
        ref: { recordId: p.planId },
        accepted: { text: `${p.decision === "renewed" ? "续期" : "不续"}任务「${p.taskTitle}」的授权：${what}`, field: "decision" },
        typed: [],
      }),
    ];
  },
};
