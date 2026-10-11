// 秘书眼里的任务看板（规格第 7、8 节，22 号票）：看板频道上的任务、简单提醒、定时触发的任务（19 号票的定时作业，76 号票起是
// 定时触发的任务的触发登记，写成它的任务那一项）各写成一项，
// 秘书的"查看板"工具按看板的五组列出全部，"看板变化"消息列出两次之间变了的项。纯函数；看板上有哪几种东西、
// 各从哪里来在 kinds.ts 的种类表里。
// 分组、状态的中文名只用共享协议包的那一份（BOARD_GROUP_OF_TASK_STATE、boardGroupOfReminder、TASK_STATE_LABEL、
// REMINDER_STATUS_LABEL），和看板频道推给前端的、Web 的看板一致。
import {
  jobTriggerKind,
  jobTriggerDetail,
  BOARD_GROUP_LABEL,
  BOARD_GROUP_OF_TASK_STATE,
  BOARD_GROUPS,
  type BoardGroup,
  boardGroupOfReminder,
  boardGroupOfScheduledJob,
  jobTriggerText,
  lastTriggerEvent,
  describeTime,
  type Reminder,
  REMINDER_STATUS_LABEL,
  LAST_RUN_FAILED_LABEL,
  type ScheduledJob,
  scheduledJobStatusText,
  type Task,
  stageCodeAt,
  TASK_END_KIND_LABEL,
  TASK_STATE_LABEL,
  TASK_WAIT_REASON_LABEL,
  taskName,
  isPlainTask,
  onceAt,
} from "@ergou/protocol";
import { oneLine } from "../util/text.ts";

/** 看板上的一项 */
export interface BoardEntry {
  /** 在看板上唯一："task:t-1"、"reminder:r-1" */
  key: string;
  /** 怎么称呼它："任务 t-1「整理发票」"、"提醒 r-2「交电费」" */
  name: string;
  /** 状态（看板变化按它比较）：任务的状态，等我的带原因，失败的带原因；提醒的待触发、已触发、已取消 */
  status: string;
  /** 在看板的哪一组；不上看板的（已取消的提醒）没有 */
  group: BoardGroup | undefined;
  /** 任务在第几阶段（"第 2/4 阶段"）：变了也算看板变化 */
  stage?: string;
  /** 列出来时的补充（涉及的项目、时间表和下一次响的时间……），不参与比较 */
  detail?: string;
}

/** 任务的状态写法：等我的带原因（卡住求助带维护者写的话），失败的带原因，转为项目结束的标出来 */
function taskStatus(task: Task): string {
  const label = TASK_STATE_LABEL[task.state];
  if (task.state === "waiting_for_user" && task.waitReason) {
    return `${label}（${TASK_WAIT_REASON_LABEL[task.waitReason]}${task.waitNote ? `：${oneLine(task.waitNote, 80)}` : ""}）`;
  }
  if (task.state === "failed" && task.failReason) return `${label}（${oneLine(task.failReason, 80)}）`;
  if (task.state === "done" && task.endKind) return `${label} · ${TASK_END_KIND_LABEL[task.endKind]}`;
  return label;
}

/**
 * 看板上写的"第 1a/4 阶段"（93 号票）：正在做的那一阶段的编号（计划里存的，和界面一致）/ 一共几个阶段号；
 * 看板上还没有阶段列表的照旧写计划里的第几个 / 共几个
 */
function stageAt(stages: NonNullable<Task["stages"]>): string {
  const list = stages.list ?? [];
  const at = list.find((s) => s.stageId === stages.focus) ?? list[(stages.current ?? 1) - 1];
  const here = at && stageCodeAt(list, at.stageId);
  return here ? `${here.code}/${here.total}` : `${stages.current}/${stages.total}`;
}

export function taskEntry(task: Task): BoardEntry {
  return {
    key: `task:${task.id}`,
    name: taskName({ id: task.id, title: oneLine(task.title, 60) }),
    status: taskStatus(task),
    group: BOARD_GROUP_OF_TASK_STATE[task.state],
    ...(task.stages?.current === undefined ? {} : { stage: `第 ${stageAt(task.stages)} 阶段` }),
    ...taskDetail(task),
  };
}

/** 任务的补充：普通任务（75 号票：交给后台、做完自动完成的）标出来，某个时间做一次的那个时间（76 号票），涉及的项目 */
function taskDetail(task: Task): { detail?: string } {
  const at = onceAt(task);
  const parts = [
    ...(isPlainTask(task) ? ["普通任务（交给后台的）"] : []),
    ...(at === undefined ? [] : [`定在 ${describeTime(new Date(at))} 做一次${task.state === "scheduled" ? "（还没到点）" : ""}`]),
    ...(task.projects.length > 0 ? [`涉及项目：${task.projects.join("、")}`] : []),
  ];
  return parts.length > 0 ? { detail: parts.join("；") } : {};
}

export function reminderEntry(reminder: Reminder): BoardEntry {
  const detail = [
    jobTriggerText(reminder),
    reminder.nextAt ? `下一次 ${describeTime(new Date(reminder.nextAt))}` : undefined,
    // 事件发生时提醒的（77 号票）：最近一次是什么事件
    reminder.event && reminder.lastEvent && reminder.lastFiredAt ? `最近一次：${reminder.lastEvent}（${describeTime(new Date(reminder.lastFiredAt))}）` : undefined,
  ].filter((x) => x !== undefined);
  return {
    key: `reminder:${reminder.id}`,
    name: `提醒 ${reminder.id}「${oneLine(reminder.text, 60)}」`,
    status: REMINDER_STATUS_LABEL[reminder.status],
    group: boardGroupOfReminder(reminder.status),
    detail: detail.join("；"),
  };
}

/**
 * 定时触发的任务（76 号票；19 号票的定时作业）：键和名字是它的任务的（task:<任务>），状态是触发的（运营中、已暂停及原因，带上"最近一次失败"）；
 * 补充写定时触发、时间表、下一次、属于哪个项目。还没迁移的定时作业照旧写成"定时作业 j-1"。
 * 事件触发的（77 号票）写在等什么事件、最近一次触发是什么事件
 */
export function scheduledJobEntry(job: ScheduledJob): BoardEntry {
  const last = lastTriggerEvent(job.lastRun);
  const detail = [
    `${jobTriggerKind(job)}：${jobTriggerDetail(job)}`,
    job.nextAt ? `下一次 ${describeTime(new Date(job.nextAt))}` : undefined,
    job.event && last ? `最近一次触发：${last.summary}（${describeTime(new Date(last.at))}）` : undefined,
    job.projectName ? `属于项目：${job.projectName}` : undefined,
  ].filter((x) => x !== undefined);
  return {
    key: job.ownerTaskId === undefined ? `scheduled_job:${job.id}` : `task:${job.ownerTaskId}`,
    name: job.ownerTaskId === undefined ? `定时作业 ${job.id}「${oneLine(job.title, 60)}」` : taskName({ id: job.ownerTaskId, title: oneLine(job.title, 60) }),
    status: `${scheduledJobStatusText(job)}${job.lastFailed ? ` · ${LAST_RUN_FAILED_LABEL}` : ""}`,
    group: boardGroupOfScheduledJob(job.state),
    detail: detail.join("；"),
  };
}

export type BoardSnapshot = ReadonlyMap<string, BoardEntry>;

export function snapshotOf(entries: Iterable<BoardEntry>): Map<string, BoardEntry> {
  return new Map([...entries].map((e) => [e.key, e]));
}

/** 列出来时的一行：状态、第几阶段、补充 */
const entryLine = (e: BoardEntry) => `- ${e.name}：${[e.status, e.stage, e.detail].filter((x) => x !== undefined && x !== "").join("；")}`;

/** 看板的全貌：按五组列出，每项一行（"查看板"工具的结果）；空看板写 emptyText */
export function boardText(snapshot: BoardSnapshot, emptyText: string): string {
  const entries = [...snapshot.values()];
  const sections = BOARD_GROUPS.flatMap((group) => {
    const items = entries.filter((e) => e.group === group);
    if (items.length === 0) return [];
    return [`## ${BOARD_GROUP_LABEL[group].title}（${items.length}）`, ...items.map(entryLine)];
  });
  return sections.length > 0 ? sections.join("\n") : emptyText;
}

/**
 * 两次之间看板的变化（每项一行）：新出现的、状态变了的、换了阶段的（"进入第 2/4 阶段"）。没上过看板就已经不在看板上的
 * （建了又取消的提醒）不算；刚有阶段（开始执行）的由状态那一行说明，不另报
 */
export function boardChanges(before: BoardSnapshot, after: BoardSnapshot): string[] {
  const lines: string[] = [];
  for (const entry of after.values()) {
    const old = before.get(entry.key);
    if (!old) {
      if (entry.group !== undefined) lines.push(`- 新${entry.name}：${entry.status}`);
      continue;
    }
    if (old.status !== entry.status) lines.push(`- ${entry.name}：${old.status} → ${entry.status}`);
    if (old.stage !== undefined && entry.stage !== undefined && old.stage !== entry.stage) lines.push(`- ${entry.name}进入${entry.stage}`);
  }
  return lines;
}
