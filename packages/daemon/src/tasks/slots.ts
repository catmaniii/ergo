// 全局执行名额（规格第 8 节"并发"、第 13 节，13、19 号票）：执行中的任务和真正开始了的定时作业运行共用 tasks.maxRunning 个名额。
// 谁占着名额只在这里数（都从派生视图现数，占名额和状态变化在同一事务里，不会数错）：
// - 执行中的任务；
// - 作业自己的维护者正在做的运行（不属于项目的作业）；
// - 进行中的定时作业运行工单（属于项目的作业：工单真正开始才占，在项目的队列里排着不占）。
// 名额可能空出来时（任务离开执行中、运行结束、运行工单结束）叫等名额的几家，各自看看能不能开始：执行控制器（排队的任务）、
// 派单器（项目队列里排到的运行工单）、定时作业（作业自己的维护者那边排队的运行）。
import { CHANNELS, EVENT_TYPES, type ScheduledJobEventPayload, type TaskEventPayload, type WorkOrderEventPayload } from "@ergo/protocol";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import { countRunningOwnRuns } from "../scheduled-jobs/index.ts";
import { countActiveRunWorkOrders } from "../projects/api.ts";
import { countRunningTasks } from "./views.ts";

export interface ExecutionSlots {
  /** 一共几个名额（配置 tasks.maxRunning） */
  readonly max: number;
  /** 占着的有几个；except 是不算的那个任务（它自己要回到执行中时） */
  used(except?: { taskId: string }): number;
  /** 还有没有名额 */
  hasSlot(except?: { taskId: string }): boolean;
  /** 等名额的登记：名额可能空出来时叫它（几家按登记的先后叫） */
  onFreed(listener: () => void): void;
  /** 接上事件：占名额的可能少了时叫等名额的 */
  attach(): void;
  stop(): void;
}

/** 这条事件之后占名额的可能少了：任务变了（可能离开执行中）、作业的一次运行结束了、工单结束了 */
function mayFree(event: StoredEvent): boolean {
  if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.task) return (event.payload as TaskEventPayload).from === "running";
  if (event.channel === CHANNELS.board && event.type === EVENT_TYPES.scheduledJob) return (event.payload as ScheduledJobEventPayload).change === "run_finished";
  if (event.channel === CHANNELS.projects && event.type === EVENT_TYPES.workOrder) return (event.payload as WorkOrderEventPayload).change === "ended";
  return false;
}

export function createExecutionSlots(options: { max: number; store: EventStore; log: (line: string) => void }): ExecutionSlots {
  const { store } = options;
  const listeners: Array<() => void> = [];
  let unsubscribe: (() => void) | undefined;
  let queued = false;

  const used = (except?: { taskId: string }) => countRunningTasks(store.reader, except?.taskId) + countRunningOwnRuns(store.reader) + countActiveRunWorkOrders(store.reader);

  /** 同一轮同步代码里空出好几次只叫一遍 */
  const freed = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const listener of listeners) {
        try {
          listener();
        } catch (err) {
          options.log(`名额空出来后叫等名额的出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }
    });
  };

  return {
    max: options.max,
    used,
    hasSlot: (except) => used(except) < options.max,
    onFreed: (listener) => void listeners.push(listener),
    attach() {
      unsubscribe = store.onAppend((event) => {
        if (mayFree(event)) freed();
      });
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
