// 卡片怎么显示（纯函数）：认识的类型和版本按类型显示；不认识的类型、或负载版本比这个页面新的，
// 显示服务端给的纯文本降级版本，加上"去 Web 处理"的链接（指向 Web 里单独显示这张卡的页面）。
// 卡片种类的说法、处理结果的说法也在这里（对话里收成一行的卡片要用，状态层取得到；model/cards.ts 转出去给界面）。
import { AUTHORIZE_FOLDERS_ACTION, type CardAction, CARD_TYPE_VERSIONS, type Card, type CardType, isCardType, type PairingCardPayload, t, tTable } from "./protocol.ts";
import type { CardState, UiState } from "./ui-state.ts";

/** 卡片种类的说法 */
export const CARD_TYPE_LABEL: Readonly<Record<CardType, string>> = tTable({
  plan: "model.cards.type.plan",
  approval: "model.cards.type.approval",
  questions: "model.cards.type.questions",
  progress: "model.cards.type.progress",
  quick_action: "model.cards.type.quickAction",
  suggest_task: "model.cards.type.suggestTask",
  suggest_project: "model.cards.type.suggestProject",
  reminder: "model.cards.type.reminder",
  charter: "model.cards.type.charter",
  work_order: "model.cards.type.workOrder",
  plan_change: "model.cards.type.planChange",
  parallel: "model.cards.type.parallel",
  memory_delete: "model.cards.type.memoryDelete",
  pairing: "model.cards.type.pairing",
  toolkit_change: "model.cards.type.toolkitChange",
  mcp_change: "model.cards.type.mcpChange",
  skill_change: "model.cards.type.skillChange",
  workflow_plan: "model.cards.type.workflowPlan",
  archive_list: "model.cards.type.archiveList",
  build_done: "model.cards.type.buildDone",
  go_live: "model.cards.type.goLive",
  charter_change: "model.cards.type.charterChange",
  standard_change: "model.cards.type.standardChange",
  standard_backfill: "model.cards.type.standardBackfill",
  operations_change: "model.cards.type.operationsChange",
  service_entry: "model.cards.type.serviceEntry",
  browse_pick: "model.cards.type.browsePick",
  personal_file: "model.cards.type.personalFile",
  personal_file_suggest: "model.cards.type.personalFileSuggest",
  interview: "model.cards.type.interview",
  interview_files: "model.cards.type.interviewFiles",
  runtime_question: "model.cards.type.runtimeQuestion",
  schedule_task: "model.cards.type.scheduleTask",
});

/** 卡片动作处理完以后显示的结果文字 */
export const CARD_ACTION_LABEL: Readonly<Record<CardAction, string>> = tTable({
  confirm: "model.cards.action.confirm",
  reject: "model.cards.action.reject",
  approve: "model.cards.action.approve",
  deny: "model.cards.action.deny",
  answer: "model.cards.action.answer",
  ack: "model.cards.action.ack",
  execute: "model.cards.action.execute",
  cancel: "model.cards.action.cancel",
  start_task: "model.cards.action.startTask",
  start_workflow: "model.cards.action.startWorkflow",
  kickoff: "model.cards.action.kickoff",
  dismiss: "model.cards.action.dismiss",
  save: "model.cards.action.save",
  cancel_reminder: "model.cards.action.cancelReminder",
  confirm_start: "model.cards.action.confirmStart",
  confirm_later: "model.cards.action.confirmLater",
  dispatch: "model.cards.action.dispatch",
  return: "model.cards.action.return",
  parallel: "model.cards.action.parallel",
  sequential: "model.cards.action.sequential",
  delete: "model.cards.action.delete",
  decide: "model.cards.action.decide",
  put_in_use: "model.cards.action.putInUse",
  keep_building: "model.cards.action.keepBuilding",
  abandon: "model.cards.action.abandon",
  start: "model.cards.action.start",
  later: "model.cards.action.later",
  decline: "model.cards.action.decline",
  overwrite: "model.cards.action.overwrite",
  rename: "model.cards.action.rename",
  allow_folder: "model.cards.action.allowFolder",
});

/** 卡片的处理结果写成一句话："已确认：勾掉 1 项授权"；系统让它作废的写作废的说明（重做之后"已经重做过，这张卡作废了"） */
export function outcomeLabel(card: Card): string {
  if (!card.outcome) return card.status === "expired" ? (card.expiredNote ?? t("model.cards.expired")) : card.status === "dismissed" ? t("model.cards.dismissed") : "";
  const label = CARD_ACTION_LABEL[card.outcome.action];
  return card.outcome.note ? t("model.cards.outcomeWithNote", { label, note: card.outcome.note }) : label;
}

/** 卡片种类的说法；不认识的种类写"卡片" */
export function cardTypeLabel(type: string): string {
  return isCardType(type) ? CARD_TYPE_LABEL[type] : t("state.chatItems.card");
}

export type CardDisplay =
  | { kind: "typed"; type: CardType; state: CardState }
  | {
      kind: "fallback";
      /** 不认识这种卡，或者认识但负载版本比这个页面新 */
      reason: "unknown_type" | "newer_version";
      /** 纯文本降级版本 */
      text: string;
      /** 去 Web 处理的链接（# 路由） */
      webPath: string;
      state: CardState;
    };

export function cardDisplay(state: UiState, cardId: string): CardDisplay | undefined {
  const view = state.cards[cardId];
  if (!view) return undefined;
  const { card } = view;
  const fallback = (reason: "unknown_type" | "newer_version"): CardDisplay => ({ kind: "fallback", reason, text: card.text, webPath: cardWebPath(card.id), state: view });
  if (!isCardType(card.type)) return fallback("unknown_type");
  if (card.typeVersion > CARD_TYPE_VERSIONS[card.type]) return fallback("newer_version");
  return { kind: "typed", type: card.type, state: view };
}

/** 配对请求卡上"像网络上的自动访问"的原因（待办那一行上标一下）；别的卡、像普通浏览器的、还没收到的是 undefined */
export function automatedPairingReason(card: Card | undefined): string | undefined {
  return card?.type === "pairing" ? (card.payload as PairingCardPayload).automated?.reason : undefined;
}

/**
 * 还在等批准的配对请求（设备配对的二维码界面上就地批准）：按来的先后。过期的不算，
 * 守护进程要过一会儿才把它标成过期，这边按卡上的时间先当它没了
 */
export function pendingPairingCardIds(state: UiState, now: number): string[] {
  return Object.values(state.cards)
    .filter(({ card }) => card.type === "pairing" && card.status === "pending" && Date.parse((card.payload as PairingCardPayload).expiresAt) > now)
    .toSorted((a, b) => a.card.createdAt.localeCompare(b.card.createdAt))
    .map(({ card }) => card.id);
}

/** Web 里单独显示一张卡的页面 */
export function cardWebPath(cardId: string): string {
  return `#/card/${encodeURIComponent(cardId)}`;
}

/**
 * 快速动作卡上"对象""内容"两行的说法（按动作类型）：秘书转达（tell_task / tell_project）写"发给"和"转达的话"，
 * 卡上一眼看出发给谁、发什么；授权文件夹写"文件夹"（完整路径）和"说明"（设置里能看能改）；别的动作照旧"对象""内容"
 */
export function quickActionFieldLabels(actionType: string): { target: string; content: string } {
  if (actionType === "tell_task" || actionType === "tell_project") return { target: t("state.cards.field.sendTo"), content: t("state.cards.field.relayText") };
  if (actionType === AUTHORIZE_FOLDERS_ACTION) return { target: t("state.cards.field.folder"), content: t("state.cards.field.note") };
  return { target: t("state.cards.field.target"), content: t("state.cards.field.content") };
}
