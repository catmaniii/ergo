// 涉及多个项目的任务（17 号票）里工单往来的说法：交给项目维护者、任务维护者的通知，任务时间线上的记录，待我处理里的标题，
// 工单卡的纯文本，被拒的原因。编排（multi-project.ts、clarifications.ts、card.ts）里不写文字，都在这里。工具名一律插值。
// 173 号票：给用户看的（时间线上的记录、待我处理的标题和来源、工单卡、素材、退回的原因、这一支在等什么）走 t()，生成时按当时的语言；
// 交给维护者的通知、工具结果、被拒的原因（给模型看的）标 @i18n-ignore model
import {
  namedIdLabel,
  type QuestionDraft,
  type Task,
  type TaskMaintainerWorkOrder,
  WORK_ORDER_OUTCOME_LABEL,
  WORK_ORDER_STATE_LABEL,
  type WorkOrderCardPayload,
  t,
  forModel,
} from "@ergo/protocol";
import { EXECUTION_TOOL } from "../tasks/tool-names.ts";
import { MULTI_PROJECT_TOOL, WORK_ORDER_TOOL } from "./tool-names.ts";

/** 一张任务维护者派来的工单和收件项目的名字（说法里总是一起用） */
export interface OrderRef {
  wo: TaskMaintainerWorkOrder;
  projectName: string;
}

/** 工单在一行里的写法："wo-2（项目「家电档案」）" */
const refText = (r: OrderRef) => `${r.wo.id}（项目「${r.projectName}」）`; // @i18n-ignore model：交给 agent 的通知里的写法

const outcomeText = (wo: TaskMaintainerWorkOrder) => WORK_ORDER_OUTCOME_LABEL[wo.outcome ?? "done"];
/** 给维护者看的话里引的状态、结果：在中文下取（协议包的标签跟着当前语言，172 号票） */
const modelOutcome = (wo: TaskMaintainerWorkOrder) => forModel(() => outcomeText(wo));
const modelState = (state: TaskMaintainerWorkOrder["state"]) => forModel(() => WORK_ORDER_STATE_LABEL[state]);

/** 工单的内容（交给项目维护者的话）：这个项目要做的改动、所属任务和阶段 */
export function changeInstructions(task: Task, stage: { stageId: string; title: string }, projectName: string, changes: readonly string[], goal: string | undefined): string {
  // 交给项目维护者的工单内容（给模型看）
  return [
    `任务 ${task.id}「${task.title}」阶段 ${stage.stageId}「${stage.title}」里，项目「${projectName}」要做的改动：`, // @i18n-ignore model
    ...changes.map((c) => `- ${c}`),
    ...(goal ? [`任务的目标（整体，不全是你这边的事）：${goal}`] : []), // @i18n-ignore model
  ].join("\n");
}

/** 计划变更、自行调整计划之后新的计划里没有这一行了：还没派出的工单退回的原因 */
export const lineDroppedReason = () => t("workOrders.reason.lineDropped");

/** 计划外的工单用户拒绝了：没派出的原因 */
export const declinedReason = (note: string | undefined) => (note ? t("workOrders.reason.declinedNote", { note }) : t("workOrders.reason.declined"));

// ───────────────────────── 任务时间线上的记录 ─────────────────────────

/** 给用户看的工单（159 号票，163 号票写成 t-3「标题」）："wo-2「加一个导出说明」"；交给 agent 的通知照旧只写编号（refText） */
const shown = (wo: TaskMaintainerWorkOrder) => namedIdLabel(wo.id, wo.title);

const said = (key: string, r: OrderRef, more: Record<string, unknown> = {}) => t(key, { order: shown(r.wo), project: r.projectName, ...more });

export const timelineText = {
  created: (r: OrderRef) => said("workOrders.timeline.created", r, { stage: r.wo.stageId }),
  dispatched: (r: OrderRef) => said("workOrders.timeline.dispatched", r),
  awaiting: (r: OrderRef) => said("workOrders.timeline.awaiting", r),
  /** 对话审批关着，任务的 agent 超出授权先不管（101 号票）：计划外的工单直接派出 */
  unplannedDirect: (r: OrderRef) => said("workOrders.timeline.unplannedDirect", r),
  confirmed: (r: OrderRef) => said("workOrders.timeline.confirmed", r),
  declined: (r: OrderRef) => said("workOrders.timeline.declined", r),
  /** 没派出就结束了（任务结束、新的计划里没有这一行）：没到项目那里，不算回执 */
  undispatched: (r: OrderRef) => said(r.wo.reason ? "workOrders.timeline.undispatchedReason" : "workOrders.timeline.undispatched", r, { reason: r.wo.reason ?? "" }),
  receipt: (r: OrderRef) => said(r.wo.reason ? "workOrders.timeline.receiptReason" : "workOrders.timeline.receipt", r, { outcome: outcomeText(r.wo), reason: r.wo.reason ?? "" }),
  /** 已经派出的工单，它那一行在计划变更、自行调整之后去掉了：不再挡所属阶段 */
  lineDropped: (r: OrderRef) => said("workOrders.timeline.lineDropped", r, { stage: r.wo.stageId }),
};

// ───────────────────────── 交给项目维护者的通知 ─────────────────────────

// @i18n-ignore-start model：交给项目维护者、任务维护者的通知
/** 任务维护者派来的工单开始：交给项目维护者的通知 */
export const changeStartText = (wo: TaskMaintainerWorkOrder) =>
  `开始工单 ${wo.id}「${wo.title}」（来自任务 ${wo.taskId} 的维护者）：要做的改动和验收标准在固定上下文里的“这次的工单”。` +
  `做完（或者这个改动会伤害本项目、要退回，或者做不了）用 ${WORK_ORDER_TOOL.submitReceipt} 交回执，退回、做不了必须写明理由；` +
  `拿不准要问的用 ${WORK_ORDER_TOOL.askClarification}（问题交给派单的任务维护者）。交回执之前照常把进展写回项目档案、用 ${WORK_ORDER_TOOL.writeSegmentSummary} 写这一段的摘要。`;

/** 任务维护者回答了项目维护者在工单里问的 */
export const answerText = (wo: TaskMaintainerWorkOrder, answer: string) => `任务 ${wo.taskId} 的维护者回答了你在工单 ${wo.id} 里的提问：\n${answer}\n接着做。`;

/** 任务暂停后又继续了：接着做手上的工单 */
export const resumedText = (wo: TaskMaintainerWorkOrder) => `任务 ${wo.taskId} 继续了：接着做工单 ${wo.id}「${wo.title}」。`;

// ───────────────────────── 交给任务维护者的通知 ─────────────────────────

/** 项目维护者在工单里提问：问题交给派单的任务维护者 */
export const questionText = (r: OrderRef, question: string) =>
  [
    `项目「${r.projectName}」的维护者在工单 ${r.wo.id}「${r.wo.title}」里提问，工单转为等澄清：`,
    question,
    `你答得了就用 ${MULTI_PROJECT_TOOL.answerWorkOrder} 回答（交回项目维护者，工单回到进行中）；答不了用 ${MULTI_PROJECT_TOOL.forwardToUser} 指明这张工单转问用户，用户回答后再用 ${MULTI_PROJECT_TOOL.answerWorkOrder} 交回。`,
  ].join("\n");

/** 提问写成几行（交给任务维护者） */
export const questionLines = (intro: string | undefined, questions: readonly QuestionDraft[]) =>
  [
    ...(intro ? [intro] : []),
    ...questions.map((q, i) => `${i + 1}. ${q.question}（推荐：${q.recommended}${q.options?.length ? `；选项：${q.options.join("、")}` : ""}）`),
  ].join("\n");

// @i18n-ignore-end

/** 转问用户的提问卡开头的一句（任务维护者没写时） */
export const forwardIntro = (r: OrderRef) => t("workOrders.forward.intro", { project: r.projectName, id: r.wo.id, title: r.wo.title });

/** 转问用户的提问卡在待我处理里的标题 */
export const forwardInboxTitle = (task: Pick<Task, "title">) => t("workOrders.forward.inboxTitle", { title: task.title });

/** 转问用户时这一支在等什么 */
export const forwardWait = () => t("workOrders.forward.wait");

// @i18n-ignore-start model：交给任务维护者的通知
/** 用户回答了任务维护者转问的问题：交回任务维护者，由它交回项目维护者 */
export const forwardedAnswerText = (r: OrderRef, lines: readonly string[], allRecommended: boolean) =>
  `用户回答了你为工单 ${refText(r)}转问的问题${allRecommended ? "，全按推荐" : ""}：\n${lines.join("\n")}\n用 ${MULTI_PROJECT_TOOL.answerWorkOrder} 把回答交回项目维护者。`;

/** 用户关掉了任务维护者转问的提问卡：按它自己的理解回答项目维护者 */
export const forwardDismissedText = (wo: TaskMaintainerWorkOrder) =>
  `用户关掉了你为工单 ${wo.id} 转问的提问卡，没有回答。按你的理解用 ${MULTI_PROJECT_TOOL.answerWorkOrder} 回答项目维护者，让它接着做。`;

// @i18n-ignore-end

/** 时间线上的记录：用户关掉了转问的提问卡 */
export const forwardDismissedRecord = (wo: TaskMaintainerWorkOrder) => ({
  summary: t("workOrders.forward.dismissedSummary", { order: shown(wo) }),
  detail: t("workOrders.taskRef", { id: wo.taskId, title: wo.taskTitle }),
});

// @i18n-ignore-start model：交给任务维护者的通知
/** 用户确认派出了计划外的工单 */
export const confirmedText = (r: OrderRef, note: string | undefined) =>
  `用户确认派出了计划外的工单 ${refText(r)}，已进入项目维护者的队列。${note ? `用户附的话：「${note}」` : ""}`;

/** 用户拒绝了计划外的工单 */
export const declinedText = (r: OrderRef, note: string | undefined) =>
  `用户拒绝了计划外的工单 ${refText(r)}，没有派出。${note ? `用户附的话：「${note}」。` : ""}在现有的计划里调整做法；做不到就用 ${EXECUTION_TOOL.waitForUser} 转为等我。`;

// @i18n-ignore-end

/** 待我处理里的来源：任务「X」 */
export const taskSource = (task: Pick<Task, "title">) => t("workOrders.taskSource", { title: task.title });

/** 计划外的工单在待我处理里的标题 */
export const unplannedInboxTitle = (r: OrderRef) => t("workOrders.unplanned.inboxTitle", { project: r.projectName, title: r.wo.title });

/** 计划外的工单等用户确认时这一支在等什么 */
export const unplannedWait = () => t("workOrders.unplanned.wait");

/** "审批决定"素材里的一句话："确认派出计划外工单 wo-3 → 项目「家电档案」：……（任务「X」阶段 s1）" */
export function decisionText(p: Pick<WorkOrderCardPayload, "workOrderId" | "projectName" | "title" | "taskTitle" | "stageId"> & { decision: "dispatch" | "deny" }): string {
  const what = t("workOrders.unplanned.what", { id: p.workOrderId, project: p.projectName, title: p.title, task: p.taskTitle, stage: p.stageId });
  return t(p.decision === "dispatch" ? "workOrders.unplanned.decisionDispatch" : "workOrders.unplanned.decisionDeny", { what });
}

/** 工单卡的纯文本降级版本 */
export const workOrderCardText = (p: WorkOrderCardPayload) =>
  t("workOrders.unplanned.cardText", { id: p.workOrderId, project: p.projectName, title: p.title, task: p.taskTitle, stage: p.stageId, acceptance: p.acceptance.join(t("workOrders.sep")) });

// ───────────────────────── 阶段：回执到齐没有、算一次验收退回 ─────────────────────────

/** 本阶段的回执算一次验收退回时，阈值的说法里"怎么判的" */
export const receiptsJudged = () => t("workOrders.returns.judged");

/** 重新派单算一次验收退回：怎么调整的 */
export const redispatchWhy = (r: OrderRef, previous: TaskMaintainerWorkOrder) => t("workOrders.returns.redispatch", { project: r.projectName, previous: previous.id, outcome: outcomeText(previous) });

/** 改了计划、去掉了没通过的那几行算一次验收退回：怎么调整的 */
export const droppedWhy = (failed: readonly OrderRef[]) =>
  t("workOrders.returns.dropped", { orders: failed.map((r) => t("workOrders.returns.droppedOrder", { id: r.wo.id, project: r.projectName, outcome: outcomeText(r.wo) })).join(t("pages.common.listSep")) });

/** 一个阶段的工单现在怎样（回执里、汇总回执里写） */
export interface StageOrders {
  stageId: string;
  /** 本阶段现在算数的工单：计划里这个阶段每个项目的一行（重新派过的取最新的）、计划外确认派出的 */
  current: OrderRef[];
}

// @i18n-ignore-start model：阶段的交代、重注入块、工具结果、被拒的原因（给维护者看的）
/** 阶段的交代、重注入块里写本阶段工单的那几行的开头 */
export const STAGE_ORDERS_HEADER = "本阶段发往各项目的工单（回执全部到齐、都完成之后才能宣布阶段完成）：";

/** 本阶段的回执到没到齐、能不能宣布完成 */
export function stageStatusText(s: StageOrders): string {
  if (s.current.length === 0) return "";
  const open = s.current.filter((x) => x.wo.state !== "ended");
  if (open.length > 0) return `阶段 ${s.stageId} 还在等回执：${open.map((x) => `${refText(x)}${modelState(x.wo.state)}`).join("、")}。`;
  const failed = s.current.filter((x) => x.wo.outcome === "returned" || x.wo.outcome === "unable");
  if (failed.length > 0) return notPassedText(s.stageId, failed);
  return `阶段 ${s.stageId} 的回执全部到齐、都完成了：用 ${EXECUTION_TOOL.completeStage} 宣布阶段完成，由运行时跑本阶段的验收。`;
}

/** 有工单被退回、做不了：本阶段不通过 */
export function notPassedText(stageId: string, failed: readonly OrderRef[]): string {
  const which = failed.map((x) => `${refText(x)}${modelOutcome(x.wo)}${x.wo.reason ? `：${x.wo.reason}` : ""}`).join("；");
  return (
    `阶段 ${stageId} 不通过：${which}。可以调整做法——用 ${MULTI_PROJECT_TOOL.dispatchWorkOrder} 重新派单，或者用 ${EXECUTION_TOOL.revisePlan}、${EXECUTION_TOOL.proposePlanChange} 改计划——` +
    `算一次验收退回；或者用 ${EXECUTION_TOOL.waitForUser} 转为等我，让用户拍板。`
  );
}

/** 宣布阶段完成被拒：还在等回执的另加一句 */
export const gateText = (status: string, open: boolean) => `${status}${open ? "回执全部到齐、都完成之后再宣布完成。" : ""}`;

/** 项目维护者的回执：交给任务维护者 */
export function receiptText(r: OrderRef, status: string): string {
  return [
    `工单 ${r.wo.id}「${r.wo.title}」的回执：项目「${r.projectName}」${modelOutcome(r.wo)}。`,
    ...(r.wo.reason ? [`理由：${r.wo.reason}`] : []),
    ...(r.wo.receipt ? [`项目维护者的说明：${r.wo.receipt}`] : []),
    ...(status ? [status] : []),
  ].join("\n");
}

/** 一张工单写成一行（汇总回执、重注入块、评审、由我验收） */
export function orderLine(r: OrderRef): string {
  const { wo } = r;
  const state = wo.state === "ended" ? `${modelState("ended")} · ${modelOutcome(wo)}` : modelState(wo.state);
  return [
    `- ${wo.id} → 项目「${r.projectName}」（${wo.planned ? "计划内" : "计划外"}，${state}）：${wo.title}`,
    `  验收标准：${wo.acceptance.join("；")}`,
    ...(wo.reason ? [`  理由：${wo.reason}`] : []),
    ...(wo.receipt ? [`  回执：${wo.receipt}`] : []),
  ].join("\n");
}

/** 汇总回执：一个阶段的标题 */
export const receiptsStageTitle = (stageId: string, stage: { title: string; state: string } | undefined) => `阶段 ${stageId}${stage ? `「${stage.title}」（${stage.state}）` : ""}：`;

/** 汇总回执：还没有工单 */
export const noOrdersText = (stageId: string | undefined) => (stageId === undefined ? "这个任务还没有工单。" : `阶段 ${stageId} 还没有工单。`);

// ───────────────────────── 被拒的原因 ─────────────────────────

export const refusal = {
  planning: `规划期间不派工单：在计划里逐行写出每个项目的改动（所属阶段、这张工单的验收标准），用户确认计划时运行时建出工单，所属阶段开始时派出。`,
  notRunning: (task: Task) => `任务 ${task.id} 现在不在执行中，不能派工单`,
  notMulti: "只有涉及多个项目的任务的维护者能派工单",
  notYourTask: (taskId: string) => `任务 ${taskId} 不是你执行的`,
  knownProjects: (known: ReadonlyArray<{ id: string; name: string }>) => `现有的项目：${known.map((p) => `${p.id}「${p.name}」`).join("、")}`,
  noTask: (taskId: string) => `没有任务 ${taskId}`,
  noStage: (stageId: string | undefined, all: readonly string[]) => `计划里没有阶段 ${stageId ?? "（没写）"}（${all.join("、")}）`,
  stageNotActive: (stageId: string, state: string) => `阶段 ${stageId} 现在是${state}：先用 ${EXECUTION_TOOL.startStage} 开始它，再给它派工单`,
  noInstructions: "要写清楚这张工单要做什么（instructions）",
  noAcceptance: "要写这张工单自己的验收标准（acceptance）：计划里这个阶段没有这个项目的一行",
  stillOpen: (r: OrderRef) => `这个阶段发给项目「${r.projectName}」的工单 ${r.wo.id} 还没结束（${modelState(r.wo.state)}）：等它交回执再重新派`,
  stuck: (stageId: string) => `阶段 ${stageId} 验收退回的次数超了阈值，这一支停下等用户拍板，工单没有派出：等用户在待我处理里看过、让它接着走再重新派`,
  /** 任务维护者现在没在执行这个任务（守卫判不了计划外的工单） */
  notExecuting: (taskId: string) => `任务 ${taskId} 的维护者现在没在执行它，派不了计划外的工单`,
  receiptOnlyInChange: `只有做任务维护者派来的工单时能交回执`,
  receiptClosing: (wo: TaskMaintainerWorkOrder) => `工单 ${wo.id} 已经交过回执了：照常写回项目档案、写这一段的摘要`,
  receiptClarifying: (wo: TaskMaintainerWorkOrder) => `工单 ${wo.id} 在等澄清：等任务维护者回答再交回执`,
  reasonRequired: "退回、做不了必须写明理由（会伤害本项目的什么、为什么做不了）",
  notClarifying: (wo: TaskMaintainerWorkOrder) => `工单 ${wo.id} 现在不在等澄清（${modelState(wo.state)}）`,
  notYours: (woId: string) => `工单 ${woId} 不是这个任务派的`,
  alreadyForwarded: (wo: TaskMaintainerWorkOrder) => `工单 ${wo.id} 的问题已经转问用户了，等用户回答`,
  emptyAnswer: "回答是空的",
  /** 用户在工单卡上点的：给用户看（173 号票） */
  get notAwaiting() {
    return t("workOrders.unplanned.notAwaiting");
  },
};
// @i18n-ignore-end
