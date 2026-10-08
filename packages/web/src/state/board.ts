// 任务看板的视图（纯函数，12 号票）：看板频道上的任务和简单提醒按规格的五组排好：
// 等我（等我、待确认）、进行中（规划中、排队中、执行中、已暂停）、运营中（简单提醒、定时作业）、
// 最近结束（已完成、失败、已取消，以及已触发的一次性简单提醒）、已归档。
// 分组表只有共享协议包里的一份（BOARD_GROUP_OF_TASK_STATE、boardGroupOfReminder），守护进程和 Web 共用。
// 定时作业（19 号票）以后加进运营中。任务卡上带它的维护者的活动状态（活动状态频道，排队、干活中……）和说明
// （干活中在做什么、等你批准什么，25 号票），以及这个任务名下的 token 总量（看板频道上的 token_totals，24 号票）。
import { BOARD_GROUP_LABEL, BOARD_GROUP_OF_TASK_STATE, BOARD_GROUPS, type BoardGroup, boardGroupOfReminder, type Reminder, type Task } from "./protocol.ts";
import { type AgentActivity, agentActivity, type UiState } from "./ui-state.ts";
import { taskTokenTotal } from "./usage.ts";

export type BoardItem = { kind: "task"; task: Task; activity: AgentActivity; tokens: number } | { kind: "reminder"; reminder: Reminder };

export interface BoardGroupView {
  group: BoardGroup;
  title: string;
  /** 这一组包括哪些状态（"等我、待确认"） */
  sub: string;
  items: BoardItem[];
}

/** 同一组里：任务在前（新近有变化的在前），提醒在后（下一次响得早的在前，已触发的按最近一次） */
function order(a: BoardItem, b: BoardItem): number {
  if (a.kind !== b.kind) return a.kind === "task" ? -1 : 1;
  if (a.kind === "task" && b.kind === "task") return b.task.updatedAt.localeCompare(a.task.updatedAt);
  const at = (i: BoardItem) => (i.kind === "reminder" ? (i.reminder.nextAt ?? i.reminder.lastFiredAt ?? i.reminder.updatedAt) : "");
  return at(a).localeCompare(at(b));
}

/** 看板的五组，每组里的任务和简单提醒排好序 */
export function boardGroups(state: UiState): BoardGroupView[] {
  const items: Array<{ group: BoardGroup; item: BoardItem }> = [
    ...Object.values(state.tasks).map((task) => ({
      group: BOARD_GROUP_OF_TASK_STATE[task.state],
      item: { kind: "task" as const, task, activity: agentActivity(state, task.maintainerId), tokens: taskTokenTotal(state, task.id) },
    })),
    ...Object.values(state.reminders).flatMap((reminder) => {
      const group = boardGroupOfReminder(reminder.status);
      return group ? [{ group, item: { kind: "reminder" as const, reminder } }] : [];
    }),
  ];
  return BOARD_GROUPS.map((group) => ({
    group,
    ...BOARD_GROUP_LABEL[group],
    items: items
      .filter((x) => x.group === group)
      .map((x) => x.item)
      .toSorted(order),
  }));
}

/** 某个任务的最新状态 */
export function selectTask(state: UiState, taskId: string): Task | undefined {
  return state.tasks[taskId];
}
