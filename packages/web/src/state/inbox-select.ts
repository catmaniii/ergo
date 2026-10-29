// 待办多选（纯函数，90 号票）：勾选几条，底部操作栏一起标已读、标未读、归档（已归档页签里是取消归档）、删除、一起处理。
// - 守护进程的 inbox_action 本身就是批量的（1–500 条），但要么全部生效、要么全部不生效：卡着任务、还没处理的事项归档或删除被拒，
//   所以先把做不了的剔掉（跳过），交上去的只有会变的那几条，操作栏写明跳过了几条、为什么；
// - "一起处理"：只放行只是确认收到的选项（"知道了"），所选的还没处理的通知都有它时一起选；要做决定的（中断不确定的"已经执行了，继续"、
//   验收通过、追加预算继续、继续执行、失败后的重试 / 取消、续期……）要一条条处理，所选里有这种通知时这一项灰掉并说明（评审 2026-10-11）。
//   审批、提问、计划确认这类卡片只能一起标已读 / 未读，批准、拒绝、回答还是一张张来（用户 2026-10-11 没答，先照主会话的建议）。
//   去设置里修的那种（点了是去设置页）本来就不算处理。
import { BLOCKING_URGENCIES, INTERRUPTED_ACK, type InboxAction, type InboxItem, OUT_OF_SCOPE_ACK, t, WRITE_BACK_HELP_ACK } from "./protocol.ts";
import type { InboxEntry } from "./inbox.ts";

/** 操作栏上不用选项的几个动作 */
export type InboxBulkAction = Exclude<InboxAction, "handle">;

/** 只是确认收到、能一起选的选项（提醒、备份、越界、写回求助……的"知道了"） */
const ACK_CHOICES: ReadonlySet<string> = new Set([OUT_OF_SCOPE_ACK, INTERRUPTED_ACK, WRITE_BACK_HELP_ACK]);

/** 卡着任务、还没处理：归档、删除会被守护进程拒绝 */
const blocked = (e: InboxEntry) => (BLOCKING_URGENCIES as readonly string[]).includes(e.item.urgency) && !e.processed;

/** 这条事项做这个动作会不会变（不会变的不交：没变化守护进程也不推，但交上去的越少越好对） */
function changes(e: InboxEntry, action: InboxAction, choice: string | undefined): boolean {
  const { item } = e;
  switch (action) {
    case "read":
      return !item.read;
    case "unread":
      return item.read;
    case "archive":
      return !item.archived && !blocked(e);
    case "unarchive":
      return item.archived;
    case "delete":
      return !blocked(e);
    case "handle":
      return item.kind === "notice" && !e.processed && choice !== undefined && ACK_CHOICES.has(choice) && item.actions.includes(choice);
  }
}

/** 每个按钮能对几条做（按钮上写个数，一条都不能时灰掉） */
export function inboxBatchCounts(entries: readonly InboxEntry[]): Record<InboxBulkAction, number> {
  const count = (a: InboxBulkAction) => entries.filter((e) => changes(e, a, undefined)).length;
  return { read: count("read"), unread: count("unread"), archive: count("archive"), unarchive: count("unarchive"), delete: count("delete") };
}

/**
 * 点了一个按钮：交上去的（会变的那几条）、跳过的条数和为什么（卡着任务的、卡片要一张张处理的、已经处理过的；只是本来就是这样的
 * ——已读的再标已读——不算跳过）
 */
export function inboxBatchTargets(entries: readonly InboxEntry[], action: InboxAction, choice?: string): { ids: string[]; skipped: number; why?: string } {
  const ids = entries.filter((e) => changes(e, action, choice)).map((e) => e.item.id);
  if (action === "archive" || action === "delete") {
    const n = entries.filter(blocked).length;
    return n > 0 ? { ids, skipped: n, why: t(action === "archive" ? "state.inboxSelect.blockedArchive" : "state.inboxSelect.blockedDelete", { count: n }) } : { ids, skipped: 0 };
  }
  if (action === "handle") {
    const cards = entries.filter((e) => e.item.kind === "card").length;
    const rest = entries.length - ids.length - cards;
    const why = [cards > 0 ? t("state.inboxSelect.skippedCards", { count: cards }) : "", rest > 0 ? t("state.inboxSelect.skippedHandled", { count: rest }) : ""].filter(Boolean).join(t("state.inboxSelect.reasonSep"));
    return why ? { ids, skipped: entries.length - ids.length, why } : { ids, skipped: 0 };
  }
  return { ids, skipped: 0 };
}

/**
 * "一起处理"能选什么：所选的事项里还没处理的通知都有的、只是确认收到的选项（"知道了"）；卡片、处理过的不看（一起处理时跳过）。
 * 没有时 why 写为什么灰掉：有要做决定的通知（没有"知道了"可选）——要一条条处理；所选里没有还没处理的通知时不写
 */
export function inboxBatchHandle(entries: readonly InboxEntry[]): { choices: string[]; why?: string } {
  const notices = entries.flatMap((e) => (e.item.kind === "notice" && !e.processed ? [e.item] : []));
  const [first, ...rest] = notices;
  if (!first) return { choices: [] };
  const choices = first.actions.filter((a) => ACK_CHOICES.has(a) && rest.every((n) => n.actions.includes(a)));
  if (choices.length > 0) return { choices };
  const deciding = notices.filter((n) => !n.actions.some((a) => ACK_CHOICES.has(a))).length;
  return { choices: [], why: deciding > 0 ? t("state.inboxSelect.deciding", { count: deciding }) : t("state.inboxSelect.noCommonChoice") };
}

/** 当前页签里的事项都勾上了没有（"全选"和"取消全选"） */
export function allSelected(selected: ReadonlySet<string>, items: readonly InboxItem[]): boolean {
  return items.length > 0 && items.every((i) => selected.has(i.id));
}
