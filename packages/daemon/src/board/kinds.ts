// @i18n-ignore-file model：看板的种类名、说明和"查看板"的工具说明只给秘书（模型）看（174 号票）；登记出错是编程错误
// 看板上有哪几种东西（22 号票）：每种一行，写明看板频道上的哪类事件、事件负载里的那一个、现在的全部（派生视图）、
// 写成一项，以及给秘书看的说明。现在的看板（currentBoard）、看板事件写成的一项（entryOfEvent）、空看板的说法、
// "查看板"工具的说明都从这张表推出。19 号票的定时作业就是加的一行；76 号票起它是定时触发的任务的触发登记：
// 运营中的定时触发的任务由这一行写成一项（键和任务的一样，task:<任务>），取消了之后由任务那一行写（在最近结束）。
// 126 号票起这张表是一个登记表（BoardKindRegistry）：内核登记任务、定时触发的任务两行，插件经插件宿主登记自己的那一行
// （提醒插件登记"简单提醒"），停用时撤掉；按 order 排（任务 10、简单提醒 20、定时触发的任务 30），说法里的先后跟着它。
// 141 号票：项目运营方案建的内部任务也上看板（协议包的 internalTaskOnBoard，项目删掉了的不再列），写明属于哪个项目；
// 上不上看板要看它的项目、定时触发的任务要看它的任务，onBoard 带着派生视图。
import {
  BOARD_GROUP_LABEL,
  BOARD_GROUPS,
  CHANNELS,
  ENDED_TASK_STATES,
  EVENT_TYPES,
  forModel,
  type ScheduledJob,
  type ScheduledJobEventPayload,
  internalTaskOnBoard,
  isProjectInternal,
  type Task,
  type TaskEventPayload,
} from "@ergo/protocol";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import { getProject } from "../projects/api.ts";
import { listJobs } from "../scheduled-jobs/index.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { getTask, listTasks } from "../tasks/views.ts";
import { type BoardEntry, type BoardSnapshot, boardText, scheduledJobEntry, snapshotOf, taskEntry } from "./board.ts";

/** 看板上的一种东西 */
export interface BoardKind<T> {
  /** 中文名（"任务"、"简单提醒"） */
  label: string;
  /** 在表里的先后（小的在前）：看板的说法、空看板的说法里按它排 */
  order: number;
  /** 给秘书看的：每一项列出什么 */
  describes: string;
  /** 看板频道上的哪类事件 */
  eventType: string;
  /** 事件负载里的那一个（最新的样子） */
  fromEvent(payload: unknown): T;
  /** 现在的全部（派生视图） */
  list(db: ReadonlyDatabase): T[];
  /**
   * 上不上看板（不给是都上）：项目内部的任务、定时作业不上（64 号票，只在项目里看得到，秘书看不到它们的细节），
   * 运营方案建的例外（141 号票）；db 是现在的派生视图（看它的项目、它的任务）
   */
  onBoard?(item: T, db: ReadonlyDatabase): boolean;
  toEntry(item: T): BoardEntry;
}

/** 定义一种（类型推导用：fromEvent、list、toEntry 是同一种东西） */
export function boardKind<T>(kind: BoardKind<T>): BoardKind<unknown> {
  return kind as BoardKind<unknown>;
}

/**
 * 任务上不上看板（141 号票）：不是项目内部的都上；项目内部的只有运营方案建的（internalTaskOnBoard），而且项目还在——
 * 删掉了的随项目一起删掉（行留着、文字换成了删除标记，ADR-0023），不再列；用户删掉了的任务（186 号票）同样不再列
 */
function taskOnBoardNow(task: Task, db: ReadonlyDatabase): boolean {
  // 用户删掉了的（186 号票）：不再列
  if (task.deleted) return false;
  if (!isProjectInternal(task)) return true;
  if (!internalTaskOnBoard(task)) return false;
  return getProject(db, task.internal!.projectId) !== undefined;
}

/**
 * 定时触发的任务的触发登记上不上看板：取消了的不上（由它的任务那一行写，最近结束）；还没迁移的定时作业照旧（项目内部的不上）；
 * 项目内部的定时触发的任务只在它的任务在运营、上看板时上（141 号票：跟着项目归档了的由任务那一行写，在已归档）
 */
function jobOnBoardNow(job: ScheduledJob, db: ReadonlyDatabase): boolean {
  if (job.state === "cancelled") return false;
  if (!isProjectInternal(job)) return true;
  if (job.ownerTaskId === undefined) return false;
  const owner = getTask(db, job.ownerTaskId);
  return owner !== undefined && owner.state === "operating" && taskOnBoardNow(owner, db);
}

/** 内核的两行：任务、定时触发的任务 */
export const KERNEL_BOARD_KINDS: readonly BoardKind<unknown>[] = [
  boardKind<Task>({
    label: "任务",
    order: 10,
    describes: "每个任务（编号、标题、状态，等我的写明原因，在第几阶段）",
    eventType: EVENT_TYPES.task,
    fromEvent: (payload) => (payload as TaskEventPayload).task,
    list: listTasks,
    // 运营中的定时触发的任务（76 号票）由它的触发登记写成一项（时间表、暂停着没有、下一次）
    onBoard: (task, db) => task.state !== "operating" && taskOnBoardNow(task, db),
    toEntry: taskEntry,
  }),
  boardKind<ScheduledJob>({
    label: "定时触发的任务",
    order: 30,
    describes: "每个定时触发的任务（时间表、运营中还是已暂停、下一次什么时候运行、最近一次是否失败、属于哪个项目）",
    eventType: EVENT_TYPES.scheduledJob,
    fromEvent: (payload) => (payload as ScheduledJobEventPayload).job,
    list: (db) => listJobs(db),
    // 取消了的由它的任务那一行写（最近结束）；还没迁移的定时作业照旧（取消了不上看板）
    onBoard: jobOnBoardNow,
    toEntry: scheduledJobEntry,
  }),
];

/** 看板上现在有哪几种（读的一侧） */
export interface BoardKinds {
  /** 按 order 排好 */
  list(): readonly BoardKind<unknown>[];
}

/** 看板种类的登记表：内核的两行先登记好；同一类事件只能有一行 */
export class BoardKindRegistry implements BoardKinds {
  private readonly kinds: BoardKind<unknown>[] = [];

  constructor(initial: readonly BoardKind<unknown>[] = KERNEL_BOARD_KINDS) {
    for (const kind of initial) this.register(kind);
  }

  /** 登记一种；返回撤销函数（插件停用时撤掉） */
  register(kind: BoardKind<unknown>): () => void {
    if (this.kinds.some((k) => k.eventType === kind.eventType)) throw new Error(`看板上 ${kind.eventType} 事件的那一种已经登记过了`);
    this.kinds.push(kind);
    // 同一个 order 的按登记的先后（sort 是稳定的）
    this.kinds.sort((a, b) => a.order - b.order);
    return () => {
      const at = this.kinds.indexOf(kind);
      if (at >= 0) this.kinds.splice(at, 1);
    };
  }

  list(): readonly BoardKind<unknown>[] {
    return [...this.kinds];
  }
}

/** 现在的看板 */
export function currentBoard(store: EventStore, kinds: BoardKinds): BoardSnapshot {
  // 给秘书看的、前后比较的：按中文写（174 号票，换语言也不会多出一堆假的变化）
  return forModel(() => snapshotOf(kinds.list().flatMap((kind) => kind.list(store.reader).flatMap((item) => (kind.onBoard?.(item, store.reader) === false ? [] : [kind.toEntry(item)])))));
}

/** 看板频道上的一条事件写成的一项（不是看板上的东西的事件、没登记的那种是 undefined）；上不上看板按现在的派生视图（db）判断 */
export function entryOfEvent(event: StoredEvent, kinds: BoardKinds, db: ReadonlyDatabase): BoardEntry | undefined {
  if (event.channel !== CHANNELS.board) return undefined;
  const kind = kinds.list().find((k) => k.eventType === event.type);
  if (!kind) return undefined;
  const item = kind.fromEvent(event.payload);
  return kind.onBoard?.(item, db) === false ? undefined : forModel(() => kind.toEntry(item));
}

/** 空看板的说法 */
export function boardEmptyText(kinds: BoardKinds): string {
  return `看板是空的：没有${kinds
    .list()
    .map((k) => k.label)
    .join("、")}。`;
}

/**
 * 项目内部任务（64 号票）不上看板，秘书只知道每个项目里有几个还没结束的（用户定，2026-10-10：不给标题、进展、计划）——
 * 用户问起时说"在项目「X」里，有 N 个进行中的内部任务，到项目页看"。每个项目一行，没有的是空。
 * 运营方案建的（141 号票）列在看板上，不算在这里
 */
export function internalTaskCounts(store: EventStore): string[] {
  const counts = new Map<string, number>();
  for (const task of listTasks(store.reader)) {
    if (!isProjectInternal(task) || internalTaskOnBoard(task) || ENDED_TASK_STATES.includes(task.state)) continue;
    const name = task.internal!.projectName;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => `- 项目「${name}」里有 ${n} 个进行中的内部任务（细节只在项目页上，你看不到）`);
}

/** "查看板"工具的结果：看板按组列出，后面是各项目里进行中的内部任务有几个 */
export function boardToolText(store: EventStore, kinds: BoardKinds): string {
  return forModel(() => boardToolLines(store, kinds));
}

function boardToolLines(store: EventStore, kinds: BoardKinds): string {
  const internal = internalTaskCounts(store);
  const board = boardText(currentBoard(store, kinds), boardEmptyText(kinds));
  return internal.length === 0 ? board : [board, "## 项目内部任务（不上看板，只有数目）", ...internal].join("\n");
}

/** "查看板"工具的说明：看板上有什么、按哪几组（工具建出来时的那几种） */
export function boardToolDescription(kinds: BoardKinds): string {
  return forModel(() =>
    `查看任务看板的现状：${kinds
      .list()
      .map((k) => k.describes)
      .join("、")}，按${BOARD_GROUPS.map((g) => BOARD_GROUP_LABEL[g].title).join("、")}分组。` +
    "项目运营方案里的那几条（项目的内部任务）也列出来、写明属于哪个项目：你的任务工具管不了它们，用户要改、要去掉，转给项目的维护者改运营方案。" +
    "别的项目内部任务不上看板，只列出每个项目里有几个在进行（用户问起时告诉他在哪个项目里、有几个，到项目页看）。" +
    "说任务进展、回答“现在在做什么”时以它为准，不要凭记忆。只读。",
  );
}
