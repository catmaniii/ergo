// 任务看板的视图（纯函数，12 号票）：看板频道上的任务和简单提醒按规格的五组排好：
// 等我（等我、待确认）、进行中（规划中、排队中、执行中、已暂停）、运营中（简单提醒、定时触发的任务）、
// 最近结束（已完成、失败、已取消，以及已触发的一次性简单提醒、185 号票起已取消的简单提醒）、已归档（185 号票起有归档了的提醒；删了的不上看板）。
// 分组表只有共享协议包里的一份（BOARD_GROUP_OF_TASK_STATE、boardGroupOfReminder），守护进程和 Web 共用。
// 定时触发的任务（76 号票）是一张任务卡（在运营中一组：它的触发登记暂停着也在），卡上带着它的触发登记（时间表、下一次、最近一次运行、
// 暂停恢复取消，triggers.ts）；触发登记不再单独占一张卡。还没迁移的定时作业（19 号票）照旧是一张作业卡，见 scheduled-jobs.ts。任务卡上带它的维护者的活动状态（活动状态频道，排队、干活中……）和说明
// （干活中在做什么、等你批准什么，25 号票），以及这个任务名下的 token 总量（看板频道上的 token_totals，24 号票）；
// 16 号票起还带它在等哪个项目（它的工单还排着：看板上标"等项目 X"，见 work-orders.ts）。
// 64 号票：项目内部的任务、定时作业不上全局看板（在项目页的"内部任务"一栏和定时作业里）。141 号票起运营方案建的内部任务例外
// （协议包的 taskOnBoard）：在对应的组里，卡上带着属于哪个项目（点了进项目）；项目在用时它的菜单只有暂停、恢复（taskMenuSubject）。
// 任务卡上的状态写明原因（taskStatusText）：等我的写等什么（卡住求助、超预算……），系统暂停的写为什么（14 号票：累计被拒）。
import {
  BOARD_GROUP_LABEL,
  BOARD_GROUP_OF_TASK_STATE,
  BOARD_GROUPS,
  type BoardGroup,
  isProjectInternal,
  taskOnBoard,
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
  taskDeleteRefusal,
  t,
} from "./protocol.ts";
import { taskOperationsLock } from "./operations-lock.ts";
import { type ScheduledJobView, scheduledJobView } from "./scheduled-jobs.ts";
import { type TaskMenuSubject, voiceAnnounceOf } from "./task-menu.ts";
import { taskTriggerView } from "./triggers.ts";
import { type AgentActivity, agentActivity, type UiState } from "./ui-state.ts";
import { taskTokenCacheHit, taskTokenTotal } from "./usage.ts";
import { taskWaitingForProject } from "./work-orders.ts";

export type BoardItem =
  | {
      kind: "task";
      task: Task;
      activity: AgentActivity;
      tokens: number;
      /** 其中缓存命中的（311 号票：任务卡上写"（其中缓存命中 …）"） */
      cacheHitTokens: number;
      /** 在等哪个项目（名字）：它的工单还排着 */
      waitingForProject: string | undefined;
      /** 定时触发的任务（76 号票）：它的触发登记（时间表、下一次、最近一次运行、能做的动作） */
      trigger?: ScheduledJobView;
      /** 运营方案建的内部任务（141 号票）：属于哪个项目（卡上的小标签，点了进项目；名字是项目现在的名字） */
      project?: { id: string; name: string };
    }
  | { kind: "reminder"; reminder: Reminder }
  | { kind: "scheduled_job"; view: ScheduledJobView }
  /** 记忆管理员每天的整理（242 号票）：点进去是记忆管理员的整页对话（285 号票） */
  | { kind: "memory_curator"; route: { tab: "more"; page: string; item?: string } };

export interface BoardGroupView {
  group: BoardGroup;
  title: string;
  /** 这一组包括哪些状态（"等我、待确认"） */
  sub: string;
  items: BoardItem[];
}

const KIND_ORDER: readonly BoardItem["kind"][] = ["task", "reminder", "scheduled_job", "memory_curator"];

/** 同一组里：任务在前（新近有变化的在前），提醒其次（下一次响得早的在前，已触发的按最近一次），定时作业最后（先登记的在前），记忆整理垫底 */
function order(a: BoardItem, b: BoardItem): number {
  if (a.kind !== b.kind) return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (a.kind === "task" && b.kind === "task") return b.task.updatedAt.localeCompare(a.task.updatedAt);
  if (a.kind === "scheduled_job" && b.kind === "scheduled_job") return a.view.job.createdAt.localeCompare(b.view.job.createdAt) || a.view.job.id.localeCompare(b.view.job.id);
  if (a.kind === "memory_curator" || b.kind === "memory_curator") return 0;
  const at = (i: BoardItem) => (i.kind === "reminder" ? (i.reminder.nextAt ?? i.reminder.lastFiredAt ?? i.reminder.updatedAt) : "");
  return at(a).localeCompare(at(b));
}

/** 看板的五组，每组里的任务、简单提醒、定时作业排好序 */
export function boardGroups(state: UiState): BoardGroupView[] {
  // 242 号票：记忆插件在运行时"运营中"多一张"记忆整理 · 每天 03:00"（点进去是记忆页的管理员那一层）。
  // 插件没在运行、或者还没收到插件的状况（原型之外极少）时没有，别的卡片照旧
  const memoryCurator: BoardItem[] = state.pluginStatus?.plugins.some((plugin) => plugin.name === "memory" && plugin.state === "running")
    ? [{ kind: "memory_curator", route: { tab: "more", page: "memory", item: "curator" } }]
    : [];
  const items: Array<{ group: BoardGroup; item: BoardItem }> = [
    // 项目内部任务（64 号票）不上全局看板：在项目页的"内部任务"一栏（projects.ts 的 projectInternalTasks）；
    // 运营方案建的例外（141 号票），标出属于哪个项目
    ...Object.values(state.tasks)
      .filter((task) => taskOnBoard(task))
      .map((task) => {
        const trigger = taskTriggerView(state, task.id);
        const project = task.internal && { id: task.internal.projectId, name: state.projects[task.internal.projectId]?.name ?? task.internal.projectName };
        return {
          group: BOARD_GROUP_OF_TASK_STATE[task.state],
          item: {
            kind: "task" as const,
            task,
            activity: agentActivity(state, task.maintainerId),
            tokens: taskTokenTotal(state, task.id),
            cacheHitTokens: taskTokenCacheHit(state, task.id),
            waitingForProject: taskWaitingForProject(state, task.id),
            ...(trigger ? { trigger } : {}),
            ...(project ? { project } : {}),
          },
        };
      }),
    ...Object.values(state.reminders).flatMap((reminder) => {
      const group = boardGroupOfReminder(reminder);
      return group ? [{ group, item: { kind: "reminder" as const, reminder } }] : [];
    }),
    // 项目内部的（64 号票）也不上：在项目页的定时触发里；定时触发的任务的触发登记（76 号票）在它的任务卡上，不单独占卡
    ...Object.values(state.scheduledJobs).flatMap((job) => {
      const owned = job.ownerTaskId !== undefined && state.tasks[job.ownerTaskId] !== undefined;
      const group = isProjectInternal(job) || owned ? undefined : boardGroupOfScheduledJob(job.state);
      return group ? [{ group, item: { kind: "scheduled_job" as const, view: scheduledJobView(state, job) } }] : [];
    }),
    // 242 号票：记忆管理员每天的整理，在"运营中"一组（别的组没有）
    ...memoryCurator.map((item) => ({ group: "ops" as const, item })),
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
  if (task.state === "waiting_for_user" && task.waitReason) return t("state.board.status.waiting", { reason: TASK_WAIT_REASON_LABEL[task.waitReason] });
  // 某个时间做一次、还没到点（76 号票）：写那个时间
  const at = onceAt(task);
  if (task.state === "scheduled" && at !== undefined) return t("state.board.status.scheduledAt", { time: describeTime(new Date(at)) });
  if (task.state === "awaiting_confirm") return t("state.board.status.awaitingConfirm");
  if (task.state === "done" && task.endKind) return t("state.board.status.done", { kind: TASK_END_KIND_LABEL[task.endKind] });
  if (task.state === "paused" && task.pauseReason) return t("state.board.status.paused", { reason: TASK_PAUSE_REASON_LABEL[task.pauseReason] });
  return TASK_STATE_LABEL[task.state];
}

/**
 * 任务的菜单（看板卡的长按 / 右键、任务详情的"⋯"、多选）按什么判断（task-menu.ts）：看板频道上的任务，运营中的定时、事件触发的
 * 带上它的触发登记现在能做的（76、98、100 号票），能开关的带上跑完自动播报开没开，项目在用时运营方案里的一条带上只能暂停、恢复（141 号票）
 */
export function taskMenuSubject(state: UiState, task: Task): TaskMenuSubject {
  const trigger = task.state === "operating" ? taskTriggerView(state, task.id) : undefined;
  const lock = taskOperationsLock(state, task);
  // 能不能删（186 号票，和守护进程同一份规则）：还在的项目里由这个维护者维护的那一个
  const deleteRefusal = taskDeleteRefusal(task, (maintainerId) => Object.values(state.projects).find((p) => p.maintainerId === maintainerId));
  return {
    ...task,
    ...(trigger ? { triggerActions: trigger.actions, reschedule: trigger.reschedule, runNow: trigger.runNow } : {}),
    announce: voiceAnnounceOf(task),
    ...(lock ? { operationsLock: lock } : {}),
    ...(deleteRefusal ? { deleteRefusal } : {}),
  };
}

/** 某个任务的最新状态 */
export function selectTask(state: UiState, taskId: string): Task | undefined {
  return state.tasks[taskId];
}
