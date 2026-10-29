// 看板多选里任务和简单提醒混着选（纯函数，156 号票）。90 号票的多选只有任务（task-menu.ts 的 batchCounts / batchTargets：
// 每个操作只对能做的生效，按钮上写个数）；156 号票起提醒卡也能勾上；185 号票起提醒能一起做的是取消、归档、删除
// （reminder-menu.ts 的 canBatchReminder）；186 号票起任务也能删（连会话、工作目录一起删），没结束的任务归档先取消。
// - 只选了任务：暂停、继续、取消、归档、删除（各自能做的算个数；归档里没结束的会先取消，删除里没结束的会先停下）；
// - 只选了提醒：取消、归档、删除；暂停、继续灰掉，操作栏上写明提醒能一起做的（boardBatchWhy）；
// - 混选：批量动作只给两者都能做的（156 号票的规则）——取消、归档、删除（任务、提醒各自能做的都算）；暂停、继续提醒做不了，
//   整个灰掉（任务能做的也不做），操作栏上写明为什么；
// - 取消先确认一次（boardBatchCancelConfirm）：只有任务照原来的说法，有提醒的写清几个任务、几条提醒会取消、几个跳过；
//   删除先确认一次（boardBatchDeleteConfirm：几个任务、几条提醒，没结束的会先停下，不能删的写明为什么）；
//   归档有没结束的任务时先确认一次（boardBatchArchiveConfirm：其中几个会先取消），都结束了的照旧不确认。
// 勾上的用 id 记（任务 t-…、提醒 r-…，守护进程和原型都是这样编号，不会撞）。
import { t, TASK_BATCH_ACTIONS } from "./protocol.ts";
import { canBatchReminder, type ReminderMenuSubject } from "./reminder-menu.ts";
import { type BatchEntry, batchCancelConfirm, canBatch, notEnded } from "./task-menu.ts";

/** 看板多选操作栏上的按钮：暂停、继续、取消、归档、删除（185 号票加删除，186 号票起任务也能删） */
export const BOARD_BATCH_ACTIONS = TASK_BATCH_ACTIONS;
export type BoardBatchAction = (typeof BOARD_BATCH_ACTIONS)[number];

/** 多选里的一条提醒；cardId 是它的提醒卡（真提醒才有），原型的假提醒没有 */
export interface ReminderBatchEntry {
  readonly kind: "reminder";
  readonly id: string;
  readonly title: string;
  readonly reminder: ReminderMenuSubject;
  readonly cardId?: string | undefined;
}

/** 看板多选里勾上的一项：任务或者简单提醒 */
export type BoardBatchEntry = (BatchEntry & { readonly kind: "task" }) | ReminderBatchEntry;

/** 两边都能做的（混选时只给这些） */
const BOTH: ReadonlySet<BoardBatchAction> = new Set(["cancel", "archive", "delete"]);

/** 这个操作给不给：只有任务时都给；只有提醒、混选时只给两边都能做的 */
function offered(entries: readonly BoardBatchEntry[], action: BoardBatchAction): boolean {
  return !entries.some((e) => e.kind === "reminder") || BOTH.has(action);
}

const can = (e: BoardBatchEntry, action: BoardBatchAction) => (e.kind === "reminder" ? canBatchReminder(e.reminder, action) : canBatch(e.subject, action));

/** 点了一个按钮：交上去的（能做的）和跳过的；不给的操作一个都不交 */
export function boardBatchTargets(entries: readonly BoardBatchEntry[], action: BoardBatchAction): { ids: string[]; skipped: number } {
  const ids = offered(entries, action) ? entries.filter((e) => can(e, action)).map((e) => e.id) : [];
  return { ids, skipped: entries.length - ids.length };
}

/** 每个按钮能做几个（按钮上写"取消（3）"，一个都不能做、或者不给时灰掉） */
export function boardBatchCounts(entries: readonly BoardBatchEntry[]): Record<BoardBatchAction, number> {
  const count = (a: BoardBatchAction) => boardBatchTargets(entries, a).ids.length;
  return { pause: count("pause"), resume: count("resume"), cancel: count("cancel"), archive: count("archive"), delete: count("delete") };
}

/** 操作栏上写明为什么有的按钮灰掉（选中里有提醒时）；只选了任务、什么都没选是 undefined */
export function boardBatchWhy(entries: readonly BoardBatchEntry[]): string | undefined {
  if (!entries.some((e) => e.kind === "reminder")) return undefined;
  if (entries.every((e) => e.kind === "reminder")) return t("state.boardBatch.why.onlyReminders");
  return t("state.boardBatch.why.mixed");
}

/** 取消先确认一次：tasks、reminders 是会取消的任务、提醒各几个，skipped 是跳过的 */
export function boardBatchCancelConfirm({ tasks, reminders, skipped }: { tasks: number; reminders: number; skipped: number }): { title: string; body: string } {
  if (reminders === 0) return batchCancelConfirm(tasks, skipped);
  if (tasks === 0) {
    return {
      title: t("state.boardBatch.reminders.title", { count: reminders }),
      body: t("state.boardBatch.reminders.body", { count: reminders, skipped: skipped > 0 ? t("state.boardBatch.reminders.skipped", { count: skipped }) : "" }),
    };
  }
  const counted = { tasks: t("state.boardBatch.nTasks", { count: tasks }), reminders: t("state.boardBatch.nReminders", { count: reminders }) };
  return {
    title: t("state.boardBatch.mixed.title", counted),
    body: t("state.boardBatch.mixed.body", { ...counted, skipped: skipped > 0 ? t("state.boardBatch.mixed.skipped", { count: skipped }) : "" }),
  };
}

/** 勾上的任务里这件事做不了的，各自为什么（186 号票：删除、归档的确认里写明）；只写有说法的（不能删的说明、运营方案里的那一条） */
export function boardBatchBlocked(entries: readonly BoardBatchEntry[], action: "delete" | "archive"): Array<{ title: string; why: string }> {
  return entries.flatMap((e) => {
    if (e.kind !== "task" || canBatch(e.subject, action)) return [];
    const why = e.subject.operationsLock?.note ?? (action === "delete" ? e.subject.deleteRefusal : undefined);
    return why ? [{ title: e.title, why }] : [];
  });
}

/** 不能做的那几个写成一句："2 个不能删：「A」：…；「B」：…。" */
const blockedText = (key: string, blocked: ReadonlyArray<{ title: string; why: string }>) =>
  blocked.length === 0 ? "" : t(key, { count: blocked.length, list: blocked.map((b) => t("state.boardBatch.blockedItem", { title: b.title, why: b.why })).join(t("state.boardBatch.blockedSep")) });

/**
 * 删除先确认一次（185 号票只对提醒，186 号票起任务也能删）：写清几个任务、几条提醒，删了以后什么样、收不回；
 * 任务里还没结束的会先停下（running），本人的话作为素材保留；不能删的写明为什么（blocked）
 */
export function boardBatchDeleteConfirm({
  tasks = 0,
  running = 0,
  reminders,
  blocked = [],
}: {
  tasks?: number;
  running?: number;
  reminders: number;
  blocked?: ReadonlyArray<{ title: string; why: string }>;
}): { title: string; body: string } {
  // 只有提醒：照 185 号票的说法
  if (tasks === 0 && blocked.length === 0) return { title: t("state.boardBatch.delete.title", { count: reminders }), body: t("state.boardBatch.delete.body", { count: reminders }) };
  const nTasks = t("state.boardBatch.nTasks", { count: tasks });
  const nReminders = t("state.boardBatch.nReminders", { count: reminders });
  const parts = [
    ...(tasks > 0 ? [t("state.boardBatch.deleteTasks.tasks", { tasks: nTasks, running: running > 0 ? t("state.boardBatch.deleteTasks.running", { count: running }) : "" })] : []),
    ...(reminders > 0 ? [t("state.boardBatch.deleteTasks.reminders", { reminders: nReminders })] : []),
    blockedText("state.boardBatch.deleteTasks.blocked", blocked),
    t("state.boardBatch.deleteTasks.tail"),
  ];
  return {
    title: reminders > 0 ? t("state.boardBatch.deleteTasks.titleMixed", { tasks: nTasks, reminders: nReminders }) : t("state.boardBatch.deleteTasks.title", { tasks: nTasks }),
    body: parts.join(""),
  };
}

/**
 * 归档有还没结束的任务时先确认一次（186 号票）：其中几个会先取消（运营中的定时、事件触发的连同触发一起取消），取消不了的不归档；
 * 跳过的（不能归档的提醒、项目在用的运营任务）写明。都结束了的不用确认：undefined
 */
export function boardBatchArchiveConfirm(entries: readonly BoardBatchEntry[]): { title: string; body: string } | undefined {
  const { ids, skipped } = boardBatchTargets(entries, "archive");
  const cancelsFirst = entries.filter((e) => e.kind === "task" && ids.includes(e.id) && notEnded(e.subject)).length;
  if (cancelsFirst === 0) return undefined;
  const blocked = boardBatchBlocked(entries, "archive");
  const others = skipped - blocked.length;
  return {
    title: t("state.boardBatch.archive.title", { count: ids.length }),
    body: [
      t("state.boardBatch.archive.body", { count: cancelsFirst }),
      blockedText("state.boardBatch.archive.blocked", blocked),
      others > 0 ? t("state.boardBatch.archive.skipped", { count: others }) : "",
    ].join(""),
  };
}

/** 交给守护进程的提醒动作（reminder_action）：操作栏上的取消、归档、删除 */
export function reminderActionOf(action: BoardBatchAction): "cancel" | "archive" | "delete" | undefined {
  return action === "cancel" || action === "archive" || action === "delete" ? action : undefined;
}
