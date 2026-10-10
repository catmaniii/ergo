// 守护进程忙不忙（报给 LSM，23 号票）：有任务处于执行中、有定时触发的任务正在运行（19 号票的定时作业，76 号票），或者任何 agent 有正在执行的
// 有副作用的调用（秘书会话里跑着的脚本、维护者对话里的命令……）就是忙。LSM 据此提供"等空闲再停"——停机会等它们做完，而不是把它们杀成"说不清做没做完"。
import { ASSISTANT_DOMAIN_TERM, CHANNELS, EVENT_TYPES, fillAssistantName } from "@ergou/protocol";
import type { StoredEvent } from "../events/event-store.ts";
import { GUARD_CHANNEL, GUARD_EVENTS } from "../guard-runtime/events.ts";
import { runningExecutions } from "../guard-runtime/executions.ts";
import { getJob, runsIn } from "../scheduled-jobs/index.ts";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import type { TaskService } from "../tasks/tasks.ts";
import type { LsmBusy } from "./link.ts";

/** 现在忙不忙；忙的话原因写在跑哪些任务、哪些调用还没做完（LSM 的界面上看的：来源里的名字占位写成领域术语"秘书"，43 号票） */
export function daemonBusy(tasks: Pick<TaskService, "list">, reader: ReadonlyDatabase): LsmBusy {
  const running = tasks.list().filter((t) => t.state === "running");
  const calls = runningExecutions(reader);
  const runs = runsIn(reader, ["running"]);
  const reasons = [
    ...(running.length === 0 ? [] : [`正在执行 ${running.length} 个任务：${running.map((t) => `「${t.title}」`).join("、")}`]),
    ...(runs.length === 0 ? [] : [`${runs.length} 个定时触发的任务正在运行：${runs.map((r) => `「${getJob(reader, r.jobId)?.title ?? r.jobId}」`).join("、")}`]),
    ...(calls.length === 0 ? [] : [`${calls.length} 个有副作用的调用还没做完：${calls.map((c) => `${fillAssistantName(c.origin.source, ASSISTANT_DOMAIN_TERM)}的${c.toolTitle}`).join("、")}`]),
  ];
  return reasons.length === 0 ? { busy: false } : { busy: true, reason: reasons.join("；") };
}

/** 这条事件可能让忙闲变了：任务状态变了，定时作业的运行开始、结束了，调用开始、结束、被中断了 */
export function mayChangeBusy(event: StoredEvent): boolean {
  if (event.channel === CHANNELS.board) return event.type === EVENT_TYPES.task || event.type === EVENT_TYPES.scheduledJob;
  if (event.channel !== GUARD_CHANNEL) return false;
  return event.type === GUARD_EVENTS.toolCallStarted || event.type === GUARD_EVENTS.toolCallFinished || event.type === GUARD_EVENTS.toolCallInterrupted;
}
