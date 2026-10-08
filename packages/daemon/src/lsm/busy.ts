// 守护进程忙不忙（报给 LSM，23 号票）：有任务处于执行中，或者任何 agent 有正在执行的有副作用的调用（秘书会话里跑着的脚本、
// 维护者对话里的命令……）就是忙。LSM 据此提供"等空闲再停"——停机会等它们做完，而不是把它们杀成"说不清做没做完"。
import { CHANNELS, EVENT_TYPES } from "@ergou/protocol";
import type { StoredEvent } from "../events/event-store.ts";
import { GUARD_CHANNEL, GUARD_EVENTS } from "../guard-runtime/events.ts";
import { runningExecutions } from "../guard-runtime/executions.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import type { TaskService } from "../tasks/tasks.ts";
import type { LsmBusy } from "./link.ts";

/** 现在忙不忙；忙的话原因写在跑哪些任务、哪些调用还没做完 */
export function daemonBusy(tasks: Pick<TaskService, "list">, reader: ReadonlyDatabase): LsmBusy {
  const running = tasks.list().filter((t) => t.state === "running");
  const calls = runningExecutions(reader);
  const reasons = [
    ...(running.length === 0 ? [] : [`正在执行 ${running.length} 个任务：${running.map((t) => `「${t.title}」`).join("、")}`]),
    ...(calls.length === 0 ? [] : [`${calls.length} 个有副作用的调用还没做完：${calls.map((c) => `${c.origin.source}的${c.toolTitle}`).join("、")}`]),
  ];
  return reasons.length === 0 ? { busy: false } : { busy: true, reason: reasons.join("；") };
}

/** 这条事件可能让忙闲变了：任务状态变了，调用开始、结束、被中断了 */
export function mayChangeBusy(event: StoredEvent): boolean {
  if (event.channel === CHANNELS.board) return event.type === EVENT_TYPES.task;
  if (event.channel !== GUARD_CHANNEL) return false;
  return event.type === GUARD_EVENTS.toolCallStarted || event.type === GUARD_EVENTS.toolCallFinished || event.type === GUARD_EVENTS.toolCallInterrupted;
}
