// 待我处理事项算不算处理过：只有这一份，守护进程（卡着任务的事项能不能归档、删除）、Web 状态层（待处理 / 已处理分组、
// tab 上的提示）、原型的假连接都用它。事项的先后（compareInboxItems）也只有这一份（Web 的待我处理页、秘书的列出待我处理）。
import { URGENCIES } from "./constants.ts";
import { t } from "./i18n/runtime.ts";
import type { CardStatus, InboxItem } from "./schema.ts";

/**
 * 处理过了：
 * - 通知类事项：选过它的一个动作；
 * - 卡片事项：卡片不再是待处理（在哪里处理都算）。
 *
 * cardStatus 是事项那张卡的状态；不知道（前端还没收到这张卡、或者找不到）时传 undefined，算**没处理过**：
 * 卡着任务的事项宁可多留着、不让归档或删除，等卡片到了再说。
 */
export function isInboxItemProcessed(item: InboxItem, cardStatus: CardStatus | undefined): boolean {
  if (item.kind === "notice") return item.handled !== undefined;
  return cardStatus !== undefined && cardStatus !== "pending";
}

/**
 * 待我处理的先后（待我处理页、秘书列出待我处理时共用）：置顶的（到点的提醒）在最前，然后按紧急度三档
 * （URGENCIES 的先后：卡住任务且有时限、卡住任务、不卡任务），同一档里新的在前
 */
export function compareInboxItems(a: InboxItem, b: InboxItem): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const u = URGENCIES.indexOf(a.urgency) - URGENCIES.indexOf(b.urgency);
  if (u !== 0) return u;
  return b.createdAt.localeCompare(a.createdAt);
}

/**
 * 事项的动作、处理结果显示成当前语言（172 号票）：存进事件、点了按字找处理的是中文原字（STUCK_HELP_ACTIONS 这些，不跟着语言变），
 * 界面上（按钮、"已处理：…"）和二狗写的说明里提到按钮时用它换；认不得的原样返回。中文下就是原字
 */
export function inboxActionText(label: string): string {
  const key = INBOX_ACTION_TEXT_KEYS[label];
  return key === undefined ? label : t(key);
}

// @i18n-ignore-start fixed：左边是存进事件的原字
const INBOX_ACTION_TEXT_KEYS: Readonly<Record<string, string>> = {
  知道了: "protocol.inboxAction.gotIt",
  已完成: "protocol.inboxAction.done",
  去导入参考音色: "protocol.inboxAction.importVoice",
  去装组件: "protocol.inboxAction.installComponent",
  去设置页修复: "protocol.inboxAction.fixInSettings",
  发起更新任务: "protocol.inboxAction.startUpdate",
  确认删除: "protocol.inboxAction.confirmDelete",
  不删了: "protocol.inboxAction.keep",
  恢复: "protocol.inboxAction.resume",
  保持暂停: "protocol.inboxAction.keepPaused",
  已接着做: "protocol.inboxAction.continued",
  已作废: "protocol.inboxAction.voided",
  验收通过: "protocol.inboxAction.accept",
  退回: "protocol.inboxAction.return",
  重试: "protocol.inboxAction.retry",
  立即备份: "protocol.inboxAction.backupNow",
  取消任务: "protocol.inboxAction.cancelTask",
  继续执行: "protocol.inboxAction.continue",
  "已经执行了，继续": "protocol.inboxAction.executed",
  "没执行，重做这一步": "protocol.inboxAction.notExecuted",
  追加预算继续: "protocol.inboxAction.addBudget",
  续期: "protocol.inboxAction.renew",
  不续: "protocol.inboxAction.skipRenew",
  "阶段改成自动验收，交给评审了": "protocol.inboxAction.handedToReview",
  先不管: "protocol.inboxAction.ignoreForNow",
  把没过的阶段也重做: "protocol.inboxAction.redoFailed",
};
// @i18n-ignore-end
