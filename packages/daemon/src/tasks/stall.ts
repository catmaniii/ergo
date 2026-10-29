// 无进展的计时（规格第 8 节"阈值"，14 号票）：维护者活着、但 stallMs（默认 20 分钟）内没有成功的工具调用、也没有阶段推进，
// 算一次停滞，交给执行控制器催一次（或者催满了让这一支停下）。
// - 只在任务执行中、维护者手头的阶段在做时计时（它的当前阶段，20 号票的 focus；交给子 agent 的不算，由调用方给 working）；
//   别的时候（等我、暂停、验收中、只剩子 agent 在做……）不计；
// - 进展：成功的工具调用（效果日志）、看板上任务非计数类的变化（阶段开始、验收、等用户、恢复……），由控制器告诉这里，
//   从那一刻重新计时；催过一次，下一段停滞也从那一刻算；
// - 到点时维护者的子进程不在运行（闲置退出、还没拉起），不算停滞，从现在重新计时；
// - 计时挂在调度器上（键 task-stall:<任务 id>），按可注入时钟走。
// 催几次、什么时候停下这一支（nextNudge）是纯函数。
import type { Task, TaskStage } from "@ergo/protocol";
import type { Clock } from "../scheduler/clock.ts";
import type { Scheduler } from "../scheduler/scheduler.ts";
import type { TaskService } from "./tasks.ts";

/** 又一次停滞：催第 n 次，或者已经催满了（nudges 是催过的次数），这一支停下 */
export type NudgeStep = { kind: "nudge"; n: number } | { kind: "stop"; nudges: number };

/** 这个阶段又停滞了一次：催过的次数加 1，超过 max 就停下 */
export function nextNudge(stage: Pick<TaskStage, "nudges">, max: number): NudgeStep {
  const n = (stage.nudges ?? 0) + 1;
  return n > max ? { kind: "stop", nudges: n - 1 } : { kind: "nudge", n };
}

export interface StallWatchOptions {
  tasks: Pick<TaskService, "get" | "list">;
  clock: Clock;
  scheduler: Scheduler;
  /** 多久没进展算停滞（阈值的 stallMs） */
  stallMs: number;
  /** 维护者手头在做的阶段（它的当前阶段在做、没交给子 agent）；没有就不计时 */
  working(task: Task): TaskStage | undefined;
  /** 这个任务的维护者现在有没有在运行的子进程 */
  alive(task: Task): boolean;
  /** 停滞了（维护者活着、它手头的阶段在做、stallMs 内没有进展）：控制器催一次或让这一支停下，之后叫 restart */
  onStall(taskId: string): void;
}

export interface StallWatch {
  /** 任务有了变化：执行中、有阶段在做就计时（progress 为真时从现在重新计时），否则不计 */
  track(task: Task, progress: boolean): void;
  /** 有了成功的工具调用：从现在重新计时 */
  progressed(taskId: string): void;
  /** 催过一次：下一段停滞从现在算 */
  restart(taskId: string): void;
  /** 给每个任务看一眼（守护进程启动时：无进展从现在算） */
  start(): void;
  stop(): void;
}

const stallKey = (taskId: string) => `task-stall:${taskId}`;

export function createStallWatch(options: StallWatchOptions): StallWatch {
  const { tasks, clock, scheduler, stallMs } = options;
  /** 每个任务最近一次有进展的时刻（毫秒） */
  const last = new Map<string, number>();
  /** 计时的时候：任务执行中，维护者手头的阶段在做 */
  const watching = (task: Task) => task.state === "running" && options.working(task) !== undefined;

  const untrack = (taskId: string) => {
    scheduler.cancel(stallKey(taskId));
    last.delete(taskId);
  };

  const arm = (taskId: string) => scheduler.schedule(stallKey(taskId), (last.get(taskId) ?? clock.now()) + stallMs, () => fire(taskId));

  const fire = (taskId: string) => {
    const task = tasks.get(taskId);
    if (!task || !watching(task)) return untrack(taskId);
    const since = last.get(taskId) ?? clock.now();
    if (clock.now() - since < stallMs) return arm(taskId);
    // 维护者不在运行：不是停滞（没有人在干活，也就没有"活着却没进展"），从现在重新计时
    if (!options.alive(task)) {
      last.set(taskId, clock.now());
      return arm(taskId);
    }
    options.onStall(taskId);
  };

  const track = (task: Task, progress: boolean) => {
    if (!watching(task)) return untrack(task.id);
    if (progress || !last.has(task.id)) last.set(task.id, clock.now());
    arm(task.id);
  };

  return {
    track,
    progressed(taskId) {
      last.set(taskId, clock.now());
      const task = tasks.get(taskId);
      if (task) track(task, false);
    },
    restart(taskId) {
      last.set(taskId, clock.now());
      arm(taskId);
    },
    start() {
      for (const task of tasks.list()) track(task, true);
    },
    stop() {
      for (const taskId of last.keys()) untrack(taskId);
    },
  };
}
