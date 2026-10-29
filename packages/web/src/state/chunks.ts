// 批量请求分批（90 号票评审）：协议上一次 task_batch_action 最多 TASK_BATCH_MAX 个任务、inbox_action 最多 INBOX_ACTION_MAX 条，
// 全选超过上限时整批被拒、提示看不懂，所以前端按上限分成几批一批批交，结果按原来的先后接起来。

/** 按 size 切成几批（保持先后；空的没有批；size 小于 1 当 1） */
export function inChunks<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}
