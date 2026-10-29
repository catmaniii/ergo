// 流程撤回之后等你（155 号票，用户 2026-10-18 定："撤回后停在那里，等我再用，你说句话再接着做，我不说话的话，隔一分钟后提醒一次"）。
//
// 一次性的流程（含某个时间做一次的；定时、事件触发的按次运行，任务状态不跟着会话推导，运行中撤回的那次运行记"已撤回"，见 scheduled-jobs）
// 撤回会话、切换分支之后，任务跟着保留的分支推导（execution.ts 的 followSession），停在那里：运行时不交代、不自己接着做（153 号票：
// 固定计划的做法）。从看板上那条 rolled_back 起、任务在执行中或排队中，就算"在等你说话"：
// - 一分钟（ROLLBACK_WAIT_REMIND_MS，按可注入的时钟）内你没在这个任务里说话：待办里放一条"流程在等你"（卡着这个流程，来源是这个任务，
//   点了进任务会话），推送；只放一次；
// - 等的期间无进展的催促不算它（执行控制器的 stall 问 waiting）：原来维护者活着时 20 分钟没进展会被催一次，这时它是在等你，不催；
// - 不等了：你在这个任务里说了话、维护者开始处理这个任务的一条输入（你点了它在等的卡、秘书替你转达……都是你让它接着做）、
//   任务不在执行中也不在排队中了（暂停、取消、做完、回到待授权……）。放过的那条还没处理的，系统替你记成处理过
//   （接着做了的"已接着做"，不在执行中的"已作废"）；
// - 又撤回、切换了一次：从新的那条 rolled_back 重新算（上一条提醒在被放弃的那段里，跟着走时已经作废）。
// 只在内存里记；守护进程启动时按事件日志重新认一遍：每个还在执行中、排队中的流程最后一条 rolled_back 之后你说过话没有、
// 维护者开始处理过它的输入没有；提醒过没有按事项的 data（rollbackSeq）认。
import {
  CHANNELS,
  EVENT_TYPES,
  isTriggered,
  MAINTAINER_CHANNEL_PREFIX,
  maintainerChannel,
  type MessageEventPayload,
  ROLLBACK_WAIT_ACK,
  ROLLBACK_WAIT_REMIND_MS,
  ROLLBACK_WAIT_SETTLED,
  rollbackWaitNotice,
  type RollbackWaitNoticeData,
  type SessionBranchEventPayload,
  SETTLED_STEP_STATES,
  type StageStartEventPayload,
  type Task,
  type TaskEventPayload,
  taskInboxOrigin,
  taskKind,
  type TurnStartEventPayload,
} from "@ergo/protocol";
import { inputOf } from "../conversation/views.ts";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import type { InboxService } from "../inbox/inbox.ts";
import type { Clock } from "../scheduler/clock.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import type { TaskService } from "./tasks.ts";

export interface RollbackWaitOptions {
  store: EventStore;
  tasks: Pick<TaskService, "get" | "list">;
  inbox: Pick<InboxService, "buildAdd" | "buildUpdate" | "get" | "list" | "isProcessed" | "alert">;
  scheduler: Scheduler;
  clock: Clock;
  now: () => string;
  log: (line: string) => void;
  /** 多久没说话提醒你（默认 ROLLBACK_WAIT_REMIND_MS，一分钟） */
  remindMs?: number;
}

export interface RollbackWait {
  /** 这个流程是不是撤回之后在等你说话（无进展的计时不算它） */
  waiting(taskId: string): boolean;
  /** 落盘的一条事件（执行控制器的订阅先交给这里）：开始等、不等了；返回这次不再等的任务（无进展的计时从现在重新算） */
  onEvent(event: StoredEvent): string[];
  /** 守护进程启动时按事件日志认出还在等的，登记一分钟的提醒（错过的马上提醒） */
  start(): void;
  stop(): void;
}

/** 在等的一个流程：从哪条 rolled_back 起（全局序号）、那一刻（毫秒）、放过的提醒 */
interface Wait {
  taskId: string;
  rollbackSeq: number;
  at: number;
  reminder?: string;
}

/** 撤回之后会停住等你的：一次性的流程（定时、事件触发的按次运行，不跟着会话推导） */
const followsSession = (task: Task) => taskKind(task) === "workflow" && !isTriggered(task);
/** 还在等你的那几种状态：执行中、排队中（名额满了，开始执行时也不交代） */
const stillWaits = (task: Task) => followsSession(task) && (task.state === "running" || task.state === "queued");

const timerKey = (taskId: string) => `rollback-wait:${taskId}`;

/**
 * 一条输入、用户的话说的是不是这个任务（只看它维护者的会话里的）：写了任务的按任务认；没写的也算——任务自己的维护者的会话里就是它，
 * 项目维护者的会话里它此刻执行的就是这一件（你在项目页上跟它说话，它照样接着做）
 */
const concerns = (task: Task, taskId: string | undefined) => taskId === undefined || taskId === task.id;

export function createRollbackWait(options: RollbackWaitOptions): RollbackWait {
  const { store, tasks, inbox, scheduler, clock, now, log } = options;
  const remindMs = options.remindMs ?? ROLLBACK_WAIT_REMIND_MS;
  const waits = new Map<string, Wait>();

  /** 这个会话里在等你的流程 */
  const waitingIn = (channel: string): Task[] =>
    [...waits.keys()].flatMap((id) => {
      const task = tasks.get(id);
      return task && maintainerChannel(task.maintainerId) === channel ? [task] : [];
    });

  const arm = (wait: Wait) => {
    waits.set(wait.taskId, wait);
    if (wait.reminder === undefined) scheduler.schedule(timerKey(wait.taskId), wait.at + remindMs, () => remind(wait.taskId, wait.rollbackSeq));
  };

  /** 那次撤回怎么撤的（rolled_back 同一批前面那条 session_branch）：切换了分支、撤回到哪个步骤开始前 */
  const howOf = (task: Task, rollbackSeq: number): { switched?: boolean; step?: string } => {
    const conversation = maintainerChannel(task.maintainerId);
    const branch = store.read(conversation, 0, EVENT_TYPES.sessionBranch).findLast((e) => e.globalSeq < rollbackSeq)?.payload as SessionBranchEventPayload | undefined;
    if (!branch) return {};
    if (branch.change === "switch") return { switched: true };
    const before = branch.before;
    if (!before || !("stageStart" in before)) return {};
    const mark = store.read(conversation, 0, EVENT_TYPES.stageStart).find((e) => (e.payload as StageStartEventPayload).id === before.stageStart)?.payload as StageStartEventPayload | undefined;
    return mark?.stepId === undefined ? {} : { step: mark.title };
  };

  /** 一分钟到了：还在等、还没提醒过，待办里放一条"流程在等你"（卡着这个流程），推送 */
  const remind = (taskId: string, rollbackSeq: number) => {
    const wait = waits.get(taskId);
    const task = tasks.get(taskId);
    if (!wait || wait.rollbackSeq !== rollbackSeq || wait.reminder !== undefined || !task || !stillWaits(task)) return;
    const next = task.steps?.list?.find((s) => !SETTLED_STEP_STATES.includes(s.state))?.title;
    const { title, body } = rollbackWaitNotice(task.title, { ...howOf(task, rollbackSeq), next });
    const data: RollbackWaitNoticeData = { taskId, rollbackSeq };
    const { item, event } = inbox.buildAdd({
      kind: "notice",
      notice: "rollback_wait",
      ...taskInboxOrigin(task),
      urgency: "blocking",
      pinned: false,
      title,
      body,
      actions: [ROLLBACK_WAIT_ACK],
      data,
    });
    store.append(event);
    wait.reminder = item.id;
    inbox.alert(item);
    log(`流程 ${taskId} 撤回之后一分钟没等到你说话，提醒了一次`);
  };

  /** 不等了：放过的提醒还没处理的，替你记成处理过 */
  const settle = (taskId: string, how: keyof typeof ROLLBACK_WAIT_SETTLED) => {
    const wait = waits.get(taskId);
    if (!wait) return;
    waits.delete(taskId);
    scheduler.cancel(timerKey(taskId));
    const item = wait.reminder === undefined ? undefined : inbox.get(wait.reminder);
    if (!item || item.kind !== "notice" || inbox.isProcessed(item)) return;
    const { handled, note } = ROLLBACK_WAIT_SETTLED[how];
    store.append(inbox.buildUpdate(item, { handled, handledAt: now(), handledNote: note, urgency: "non_blocking", read: true }).event);
  };

  /** 这个会话里你说了话、维护者开始处理一条输入（taskId 是它说的是哪个任务）：说的是在等的那个就不等了 */
  const resumedIn = (channel: string, taskId: string | undefined): string[] =>
    waitingIn(channel).flatMap((task) => {
      if (!concerns(task, taskId)) return [];
      settle(task.id, "resumed");
      return [task.id];
    });

  return {
    waiting: (taskId) => waits.has(taskId),

    onEvent(event) {
      if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.task) {
        const { task, change } = event.payload as TaskEventPayload;
        if (change === "rolled_back" && stillWaits(task)) {
          settle(task.id, "voided");
          arm({ taskId: task.id, rollbackSeq: event.globalSeq, at: clock.now() });
        } else if (waits.has(task.id) && !stillWaits(task)) {
          settle(task.id, "voided");
        }
        return [];
      }
      if (waits.size === 0 || !event.channel.startsWith(MAINTAINER_CHANNEL_PREFIX)) return [];
      if (event.type === EVENT_TYPES.message) {
        const payload = event.payload as Partial<MessageEventPayload>;
        return payload.message?.speaker === "user" ? resumedIn(event.channel, payload.taskId) : [];
      }
      if (event.type === EVENT_TYPES.turnStart) {
        const { inputMessageId } = event.payload as TurnStartEventPayload;
        return resumedIn(event.channel, inputOf(store.reader, inputMessageId)?.scope.taskId);
      }
      return [];
    },

    start() {
      const candidates = new Map(tasks.list().filter(stillWaits).map((t) => [t.id, t]));
      if (candidates.size === 0) return;
      // 每个候选最后一条 rolled_back
      const last = new Map<string, StoredEvent>();
      for (const event of store.read(CHANNELS.board, 0, EVENT_TYPES.task)) {
        const { task, change } = event.payload as TaskEventPayload;
        if (change === "rolled_back" && candidates.has(task.id)) last.set(task.id, event);
      }
      const reminders = inbox.list().flatMap((item) => (item.kind === "notice" && item.notice === "rollback_wait" && item.data ? [{ id: item.id, data: item.data as RollbackWaitNoticeData }] : []));
      for (const [taskId, rolled] of last) {
        const task = candidates.get(taskId)!;
        const conversation = maintainerChannel(task.maintainerId);
        // 从那次撤回的 session_branch（和 rolled_back 同一批、在它前面）往后看
        const from = store.read(conversation, 0, EVENT_TYPES.sessionBranch).findLast((e) => e.globalSeq < rolled.globalSeq)?.seq ?? 0;
        const later = (type: string) => store.read(conversation, from, type).filter((e) => e.globalSeq > rolled.globalSeq);
        const spoke = later(EVENT_TYPES.message).some((e) => {
          const payload = e.payload as Partial<MessageEventPayload>;
          return payload.message?.speaker === "user" && concerns(task, payload.taskId);
        });
        const resumed = later(EVENT_TYPES.turnStart).some((e) => concerns(task, inputOf(store.reader, (e.payload as TurnStartEventPayload).inputMessageId)?.scope.taskId));
        if (spoke || resumed) continue;
        const reminder = reminders.find((r) => r.data.taskId === taskId && r.data.rollbackSeq === rolled.globalSeq);
        arm({ taskId, rollbackSeq: rolled.globalSeq, at: Date.parse(rolled.time), ...(reminder ? { reminder: reminder.id } : {}) });
      }
    },

    stop() {
      for (const taskId of waits.keys()) scheduler.cancel(timerKey(taskId));
      waits.clear();
    },
  };
}
