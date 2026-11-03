// 同类运行每次大概花多少（秘书提议定时任务时卡上写，tasks/schedule-tool.ts）：不属于项目的、用同一个运行时的定时或事件触发的
// 普通任务，最近结束了的几次运行（做成了、失败、部分完成；中断、没运行、撤回的不算——它们没跑完或者没跑），
// 每次运行起止之间记在任务名下的用量合起来取平均。一次都没有就估不出（卡上不写数字）；每一笔都有单价才给钱数。
import { isPlainTask, isProjectInternal, isTriggered, type JobRunState, type LedgerOwner, PI_RUNTIME_ID, type ScheduleRunEstimate, type Task } from "@ergo/protocol";
import type { ReadonlyDatabase } from "../storage/sqlite.ts";
import { jobOfTask, runsOfJob } from "./views.ts";

/** 最多按最近几次运行算（太久以前的不一定像现在） */
export const RUN_ESTIMATE_SAMPLE = 20;

/** 算进来的运行：真跑完了的 */
const ENDED_RUN_STATES: readonly JobRunState[] = ["done", "failed", "partial"];

export interface RunEstimateDeps {
  reader: ReadonlyDatabase;
  /** 现在的全部任务 */
  tasks: () => readonly Task[];
  /** 账本的 usageIn：几段时间里记在各自名下的用量合计和粗估成本 */
  usageIn(windows: ReadonlyArray<{ owner: LedgerOwner; from: string; to: string }>): { tokens: number; cost?: { amount: number; currency: string } };
}

/** runtime 不写是 pi */
export function scheduledRunEstimate(deps: RunEstimateDeps, runtime: string | undefined): ScheduleRunEstimate | undefined {
  const wanted = runtime ?? PI_RUNTIME_ID;
  const windows = deps
    .tasks()
    .filter((task) => isPlainTask(task) && isTriggered(task) && !isProjectInternal(task) && (task.runtime ?? PI_RUNTIME_ID) === wanted)
    .flatMap((task) => {
      const job = jobOfTask(deps.reader, task.id);
      if (!job) return [];
      return runsOfJob(deps.reader, job.id).flatMap((run) =>
        ENDED_RUN_STATES.includes(run.state) && run.startedAt !== undefined && run.endedAt !== undefined ? [{ owner: { kind: "task" as const, id: task.id }, from: run.startedAt, to: run.endedAt }] : [],
      );
    })
    .toSorted((a, b) => Date.parse(b.to) - Date.parse(a.to))
    .slice(0, RUN_ESTIMATE_SAMPLE);
  if (windows.length === 0) return undefined;
  const usage = deps.usageIn(windows);
  const runs = windows.length;
  return {
    runs,
    tokens: Math.round(usage.tokens / runs),
    ...(usage.cost ? { cost: { amount: usage.cost.amount / runs, currency: usage.cost.currency } } : {}),
  };
}
