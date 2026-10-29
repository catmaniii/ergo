// 一次对多个任务做同一个控制（task_batch_action，90 号票：看板多选的操作栏——暂停、继续、取消、归档）。
// 一个一个交给单个任务的那条路（网关的 task_action 处理：控制器的 act，定时触发的任务运营中时的暂停、恢复、取消落到它的触发上），
// 能不能做照旧按"谁能改"表各自判断；各自成败、按请求里的先后逐条回报——一个做不了不影响别的（和待我处理的批量不一样：
// 那边要么全部生效、要么全部不生效）。每个任务用由这次幂等键派生的幂等键（`<键>#<任务>`）：同一个键重发，做成了的拿到同一个结果，
// 没做成的再试一次。被拒的写原因（和单个 task_action 被拒时同一句），别的错记日志、回"内部出错"。
import { t, type TaskActionParams, type TaskActionResult, type TaskBatchActionParams, type TaskBatchActionResult, type TaskBatchItemResult } from "@ergo/protocol";
import { RequestRejected } from "../errors.ts";

export interface TaskBatchDeps {
  /** 单个任务的控制（和 task_action 同一个处理） */
  act(params: TaskActionParams, idempotencyKey: string): TaskActionResult | Promise<TaskActionResult>;
  log(line: string): void;
}

/** 这次请求里这个任务用的幂等键 */
export const batchItemKey = (idempotencyKey: string, taskId: string) => `${idempotencyKey}#${taskId}`;

export function createTaskBatch(deps: TaskBatchDeps): (params: TaskBatchActionParams, idempotencyKey: string) => Promise<TaskBatchActionResult> {
  return async (params, idempotencyKey) => {
    const results: TaskBatchItemResult[] = [];
    // 一个接一个：后一个看到的是前一个做完之后的样子（同一批里的任务互不相干，先后只为了结果好对）
    for (const taskId of params.taskIds) {
      try {
        const done = await deps.act({ taskId, action: params.action }, batchItemKey(idempotencyKey, taskId));
        results.push({ taskId, ok: true, state: done.state });
      } catch (err) {
        if (err instanceof RequestRejected) {
          results.push({ taskId, ok: false, code: err.code, message: err.message });
          continue;
        }
        deps.log(`一次处理多个任务时 ${taskId} 出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`); // @i18n-ignore log
        results.push({ taskId, ok: false, code: "internal", message: t("tasks.batch.internal") });
      }
    }
    return { results };
  };
}
