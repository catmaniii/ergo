// 看板上有哪几种东西（22 号票）：每种一行，写明看板频道上的哪类事件、事件负载里的那一个、现在的全部（派生视图）、
// 写成一项，以及给秘书看的说明。现在的看板（currentBoard）、看板事件写成的一项（entryOfEvent）、空看板的说法、
// "查看板"工具的说明都从这张表推出。19 号票的定时作业就是加的一行。
import {
  BOARD_GROUP_LABEL,
  BOARD_GROUPS,
  CHANNELS,
  EVENT_TYPES,
  type Reminder,
  type ReminderEventPayload,
  type ScheduledJob,
  type ScheduledJobEventPayload,
  type Task,
  type TaskEventPayload,
} from "@ergou/protocol";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import { listReminders } from "../reminders/views.ts";
import { listJobs } from "../scheduled-jobs/index.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { listTasks } from "../tasks/views.ts";
import { type BoardEntry, type BoardSnapshot, reminderEntry, scheduledJobEntry, snapshotOf, taskEntry } from "./board.ts";

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
    toEntry: scheduledJobEntry,
  }),
];

/** 现在的看板 */
export function currentBoard(store: EventStore): BoardSnapshot {
  return snapshotOf(BOARD_KINDS.flatMap((kind) => kind.list(store.reader).map((item) => kind.toEntry(item))));
}

/** 看板频道上的一条事件写成的一项（不是看板上的东西的事件是 undefined） */
export function entryOfEvent(event: StoredEvent): BoardEntry | undefined {
  if (event.channel !== CHANNELS.board) return undefined;
  const kind = BOARD_KINDS.find((k) => k.eventType === event.type);
  return kind ? kind.toEntry(kind.fromEvent(event.payload)) : undefined;
}

/** 空看板的说法 */
export const BOARD_EMPTY_TEXT = `看板是空的：没有${BOARD_KINDS.map((k) => k.label).join("、")}。`;

/** "查看板"工具的说明：看板上有什么、按哪几组 */
export const BOARD_TOOL_DESCRIPTION = `查看任务看板的现状：${BOARD_KINDS.map((k) => k.describes).join("、")}，按${BOARD_GROUPS.map((g) => BOARD_GROUP_LABEL[g].title).join("、")}分组。说任务进展、回答“现在在做什么”时以它为准，不要凭记忆。只读。`;
