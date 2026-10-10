// 任务看板的视图（纯函数，12 号票）：看板频道上的任务和简单提醒按规格的五组排好：
// 等我（等我、待确认）、进行中（规划中、排队中、执行中、已暂停）、运营中（简单提醒、定时触发的任务）、
// 最近结束（已完成、失败、已取消，以及已触发的一次性简单提醒）、已归档。
// 分组表只有共享协议包里的一份（BOARD_GROUP_OF_TASK_STATE、boardGroupOfReminder），守护进程和 Web 共用。
// 定时触发的任务（76 号票）是一张任务卡（在运营中一组：它的触发登记暂停着也在），卡上带着它的触发登记（时间表、下一次、最近一次运行、
// 暂停恢复取消，triggers.ts）；触发登记不再单独占一张卡。还没迁移的定时作业（19 号票）照旧是一张作业卡，见 scheduled-jobs.ts。任务卡上带它的维护者的活动状态（活动状态频道，排队、干活中……）和说明
// （干活中在做什么、等你批准什么，25 号票），以及这个任务名下的 token 总量（看板频道上的 token_totals，24 号票）；
// 16 号票起还带它在等哪个项目（它的工单还排着：看板上标"等项目 X"，见 work-orders.ts）。
// 64 号票：项目内部的任务、定时作业不上全局看板（在项目页的"内部任务"一栏和定时作业里）。
// 任务卡上的状态写明原因（taskStatusText）：等我的写等什么（卡住求助、超预算……），系统暂停的写为什么（14 号票：累计被拒）。
import {
  BOARD_GROUP_LABEL,
  BOARD_GROUP_OF_TASK_STATE,
  BOARD_GROUPS,
  type BoardGroup,
  isProjectInternal,
  boardGroupOfReminder,
  boardGroupOfScheduledJob,
  describeTime,
  onceAt,
  type Reminder,
  type Task,
  TASK_END_KIND_LABEL,
  TASK_PAUSE_REASON_LABEL,
  TASK_STATE_LABEL,
  TASK_WAIT_REASON_LABEL,
} from "./protocol.ts";
import { type ScheduledJobView, scheduledJobView } from "./scheduled-jobs.ts";
import { taskTriggerView } from "./triggers.ts";
import { type AgentActivity, agentActivity, type UiState } from "./ui-state.ts";
import { taskTokenTotal } from "./usage.ts";
import { taskWaitingForProject } from "./work-orders.ts";

export type BoardItem =
  | {
      kind: "task";
      task: Task;
      activity: AgentActivity;
      tokens: number;
      /** 在等哪个项目（名字）：它的工单还排着 */
      waitingForProject: string | undefined;
      /** 定时触发的任务（76 号票）：它的触发登记（时间表、下一次、最近一次运行、能做的动作） */
      trigger?: ScheduledJobView;
    }
  | { kind: "reminder"; reminder: Reminder }
  | { kind: "scheduled_job"; view: ScheduledJobView };

export interface BoardGroupView {
  group: BoardGroup;
  title: string;
  /** 这一组包括哪些状态（"等我、待确认"） */
  sub: string;
  items: BoardItem[];
}

const KIND_ORDER: readonly BoardItem["kind"][] = ["task", "reminder", "scheduled_job"];

/** 同一组里：任务在前（新近有变化的在前），提醒其次（下一次响得早的在前，已触发的按最近一次），定时作业最后（先登记的在前） */
function order(a: BoardItem, b: BoardItem): number {
  if (a.kind !== b.kind) return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (a.kind === "task" && b.kind === "task") return b.task.updatedAt.localeCompare(a.task.updatedAt);
  if (a.kind === "scheduled_job" && b.kind === "scheduled_job") return a.view.job.createdAt.localeCompare(b.view.job.createdAt) || a.view.job.id.localeCompare(b.view.job.id);
  const at = (i: BoardItem) => (i.kind === "reminder" ? (i.reminder.nextAt ?? i.reminder.lastFiredAt ?? i.reminder.updatedAt) : "");
  return at(a).localeCompare(at(b));
}

/** 看板的五组，每组里的任务、简单提醒、定时作业排好序 */
export function boardGroups(state: UiState): BoardGroupView[] {
  const items: Array<{ group: BoardGroup; item: BoardItem }> = [
    // 项目内部任务（64 号票）不上全局看板：在项目页的"内部任务"一栏（projects.ts 的 projectInternalTasks）
    ...Object.values(state.tasks)
      .filter((task) => !isProjectInternal(task))
      .map((task) => {
        const trigger = taskTriggerView(state, task.id);
        return {
          group: BOARD_GROUP_OF_TASK_STATE[task.state],
          item: {
            kind: "task" as const,
            task,
            activity: agentActivity(state, task.maintainerId),
            tokens: taskTokenTotal(state, task.id),
            waitingForProject: taskWaitingForProject(state, task.id),
            ...(trigger ? { trigger } : {}),
          },
        };
      }),
    ...Object.values(state.reminders).flatMap((reminder) => {
      const group = boardGroupOfReminder(reminder.status);
      return group ? [{ group, item: { kind: "reminder" as const, reminder } }] : [];
    }),
    // 项目内部的（64 号票）也不上：在项目页的定时触发里；定时触发的任务的触发登记（76 号票）在它的任务卡上，不单独占卡
    ...Object.values(state.scheduledJobs).flatMap((job) => {
      const owned = job.ownerTaskId !== undefined && state.tasks[job.ownerTaskId] !== undefined;
      const group = isProjectInternal(job) || owned ? undefined : boardGroupOfScheduledJob(job.state);
      return group ? [{ group, item: { kind: "scheduled_job" as const, view: scheduledJobView(state, job) } }] : [];
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

/** 任务卡、任务详情上的状态：等我 · 卡住求助、已暂停 · 累计被拒、待确认 · 计划等你确认、已完成 · 已转为项目…… */
export function taskStatusText(task: Pick<Task, "state" | "waitReason" | "pauseReason" | "endKind" | "trigger">): string {
  if (task.state === "waiting_for_user" && task.waitReason) return `等我 · ${TASK_WAIT_REASON_LABEL[task.waitReason]}`;
  // 某个时间做一次、还没到点（76 号票）：写那个时间
  const at = onceAt(task);
  if (task.state === "scheduled" && at !== undefined) return `等时间 · ${describeTime(new Date(at))} 做`;
  if (task.state === "awaiting_confirm") return "待确认 · 计划等你确认";
  if (task.state === "done" && task.endKind) return `已完成 · ${TASK_END_KIND_LABEL[task.endKind]}`;
  if (task.state === "paused" && task.pauseReason) return `已暂停 · ${TASK_PAUSE_REASON_LABEL[task.pauseReason]}`;
  return TASK_STATE_LABEL[task.state];
}

/** 某个任务的最新状态 */
export function selectTask(state: UiState, taskId: string): Task | undefined {
  return state.tasks[taskId];
}
