// 秘书眼里的任务看板（规格第 7、8 节，22 号票）：看板频道上的任务、简单提醒（19 号票加定时作业）各写成一项，
// 秘书的"查看板"工具按看板的五组列出全部，"看板变化"消息列出两次之间变了的项。纯函数；看板上有哪几种东西、
// 各从哪里来在 kinds.ts 的种类表里。
// 分组、状态的中文名只用共享协议包的那一份（BOARD_GROUP_OF_TASK_STATE、boardGroupOfReminder、TASK_STATE_LABEL、
// REMINDER_STATUS_LABEL），和看板频道推给前端的、Web 的看板一致。
import {
  BOARD_GROUP_LABEL,
  BOARD_GROUP_OF_TASK_STATE,
  BOARD_GROUPS,
  type BoardGroup,
  boardGroupOfReminder,
  describeSchedule,
  describeTime,
  type Reminder,
  REMINDER_STATUS_LABEL,
  type Task,
  TASK_END_KIND_LABEL,
  TASK_STATE_LABEL,
  TASK_WAIT_REASON_LABEL,
  taskName,
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

export function taskEntry(task: Task): BoardEntry {
  return {
    key: `task:${task.id}`,
    name: taskName({ id: task.id, title: oneLine(task.title, 60) }),
    status: taskStatus(task),
    group: BOARD_GROUP_OF_TASK_STATE[task.state],
    ...(task.stages?.current === undefined ? {} : { stage: `第 ${task.stages.current}/${task.stages.total} 阶段` }),
    ...(task.projects.length > 0 ? { detail: `涉及项目：${task.projects.join("、")}` } : {}),
  };
}

export function reminderEntry(reminder: Reminder): BoardEntry {
  const detail = [describeSchedule(reminder.schedule), reminder.nextAt ? `下一次 ${describeTime(new Date(reminder.nextAt))}` : undefined].filter((x) => x !== undefined);
  return {
    key: `reminder:${reminder.id}`,
    name: `提醒 ${reminder.id}「${oneLine(reminder.text, 60)}」`,
    status: REMINDER_STATUS_LABEL[reminder.status],
    group: boardGroupOfReminder(reminder.status),
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
