// 看板上有哪几种东西（22 号票）：每种一行，写明看板频道上的哪类事件、事件负载里的那一个、现在的全部（派生视图）、
// 写成一项，以及给秘书看的说明。现在的看板（currentBoard）、看板事件写成的一项（entryOfEvent）、空看板的说法、
// "查看板"工具的说明都从这张表推出。19 号票的定时作业就是加的一行。
import {
  BOARD_GROUP_LABEL,
  BOARD_GROUPS,
  CHANNELS,
  ENDED_TASK_STATES,
  EVENT_TYPES,
  type Reminder,
  type ReminderEventPayload,
  type ScheduledJob,
  type ScheduledJobEventPayload,
  isProjectInternal,
  type Task,
  type TaskEventPayload,
} from "@ergou/protocol";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import { listReminders } from "../reminders/views.ts";
import { listJobs } from "../scheduled-jobs/index.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { listTasks } from "../tasks/views.ts";
import { type BoardEntry, type BoardSnapshot, boardText, reminderEntry, scheduledJobEntry, snapshotOf, taskEntry } from "./board.ts";

/** 看板上的一种东西 */
export interface BoardKind<T> {
  /** 中文名（"任务"、"简单提醒"） */
  label: string;
  /** 给秘书看的：每一项列出什么 */
  describes: string;
  /** 看板频道上的哪类事件 */
  eventType: string;
  /** 事件负载里的那一个（最新的样子） */
  fromEvent(payload: unknown): T;
  /** 现在的全部（派生视图） */
  list(db: ReadonlyDatabase): T[];
  /** 上不上看板（不给是都上）：项目内部的任务、定时作业不上（64 号票，只在项目里看得到，秘书看不到它们的细节） */
  onBoard?(item: T): boolean;
  toEntry(item: T): BoardEntry;
}

/** 定义一种（类型推导用：fromEvent、list、toEntry 是同一种东西） */
function boardKind<T>(kind: BoardKind<T>): BoardKind<unknown> {
  return kind as BoardKind<unknown>;
}

export const BOARD_KINDS: readonly BoardKind<unknown>[] = [
  boardKind<Task>({
    label: "任务",
    describes: "每个任务（编号、标题、状态，等我的写明原因，在第几阶段）",
    eventType: EVENT_TYPES.task,
    fromEvent: (payload) => (payload as TaskEventPayload).task,
    list: listTasks,
    onBoard: (task) => !isProjectInternal(task),
    toEntry: taskEntry,
  }),
  boardKind<Reminder>({
    label: "简单提醒",
    describes: "每个简单提醒（时间、下一次什么时候响）",
    eventType: EVENT_TYPES.reminder,
    fromEvent: (payload) => (payload as ReminderEventPayload).reminder,
    list: (db) => listReminders(db),
    toEntry: reminderEntry,
  }),
  boardKind<ScheduledJob>({
    label: "定时作业",
    describes: "每个定时作业（时间表、运营中还是已暂停、下一次什么时候运行、最近一次是否失败、属于哪个项目）",
    eventType: EVENT_TYPES.scheduledJob,
    fromEvent: (payload) => (payload as ScheduledJobEventPayload).job,
    list: (db) => listJobs(db),
    onBoard: (job) => !isProjectInternal(job),
    toEntry: scheduledJobEntry,
  }),
];

/** 现在的看板 */
export function currentBoard(store: EventStore): BoardSnapshot {
  return snapshotOf(BOARD_KINDS.flatMap((kind) => kind.list(store.reader).flatMap((item) => (kind.onBoard?.(item) === false ? [] : [kind.toEntry(item)]))));
}

/** 看板频道上的一条事件写成的一项（不是看板上的东西的事件是 undefined） */
export function entryOfEvent(event: StoredEvent): BoardEntry | undefined {
  if (event.channel !== CHANNELS.board) return undefined;
  const kind = BOARD_KINDS.find((k) => k.eventType === event.type);
  if (!kind) return undefined;
  const item = kind.fromEvent(event.payload);
  return kind.onBoard?.(item) === false ? undefined : kind.toEntry(item);
}

/** 空看板的说法 */
export const BOARD_EMPTY_TEXT = `看板是空的：没有${BOARD_KINDS.map((k) => k.label).join("、")}。`;

/**
 * 项目内部任务（64 号票）不上看板，秘书只知道每个项目里有几个还没结束的（用户定，2026-10-10：不给标题、进展、计划）——
 * 用户问起时说"在项目「X」里，有 N 个进行中的内部任务，到项目页看"。每个项目一行，没有的是空
 */
export function internalTaskCounts(store: EventStore): string[] {
  const counts = new Map<string, number>();
  for (const task of listTasks(store.reader)) {
    if (!isProjectInternal(task) || ENDED_TASK_STATES.includes(task.state)) continue;
    const name = task.internal!.projectName;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => `- 项目「${name}」里有 ${n} 个进行中的内部任务（细节只在项目页上，你看不到）`);
}

/** "查看板"工具的结果：看板按组列出，后面是各项目里进行中的内部任务有几个 */
export function boardToolText(store: EventStore): string {
  const internal = internalTaskCounts(store);
  const board = boardText(currentBoard(store), BOARD_EMPTY_TEXT);
  return internal.length === 0 ? board : [board, "## 项目内部任务（不上看板，只有数目）", ...internal].join("\n");
}

/** "查看板"工具的说明：看板上有什么、按哪几组 */
export const BOARD_TOOL_DESCRIPTION =
  `查看任务看板的现状：${BOARD_KINDS.map((k) => k.describes).join("、")}，按${BOARD_GROUPS.map((g) => BOARD_GROUP_LABEL[g].title).join("、")}分组。` +
  "项目内部任务不上看板，只列出每个项目里有几个在进行（用户问起时告诉他在哪个项目里、有几个，到项目页看）。" +
  "说任务进展、回答“现在在做什么”时以它为准，不要凭记忆。只读。";
