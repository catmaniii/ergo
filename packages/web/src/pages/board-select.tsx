// 看板多选的操作栏（90 号票）："已选 N 个 · 暂停 · 继续 · 取消 · 归档 · 完成"。
// - 每个操作只对能做的生效（state/task-menu.ts 的 batchCounts / batchTargets：照"谁能改"表，运营中的定时任务看它的触发），
//   按钮上写个数（"取消（3）"），一个都不能做时灰掉；
// - 取消先确认一次，写清几个会取消、几个跳过；
// - 真任务交给守护进程（task_batch_action，各自成败、逐条回报；一次最多 TASK_BATCH_MAX 个，多了分批一批批交，结果接起来——
//   90 号票评审），原型看板上的假任务在页面上演（prototype/proto-task-acts.ts）；
//   做完提示结果：全成功是页面底部一句短提示，有没成的弹出来逐条写为什么（有一批整个被拒时，那一批的每个都写"没交上去"和原因）。
import { useState } from "react";
import { useStore } from "../app/store.tsx";
import type { TaskSummary } from "../model/types.ts";
import { protoAfter, protoSubject } from "../prototype/proto-task-acts.ts";
import { useProto } from "../prototype/proto-store.tsx";
import {
  BATCH_ACTION_LABEL,
  type BatchEntry,
  type BatchItemResult,
  batchCancelConfirm,
  batchCounts,
  batchResult,
  batchTargets,
  canBatch,
  inChunks,
  TASK_BATCH_ACTIONS,
  TASK_BATCH_MAX,
  type TaskBatchAction,
} from "../state/index.ts";
import { Sheet } from "../ui/common.tsx";
import { useToast } from "../ui/toast.tsx";

/** 一次处理多个任务：真任务交给守护进程，原型的假任务在页面上演；逐条的结果按交上来的先后 */
function useBoardBatch(): (ids: readonly string[], action: TaskBatchAction) => Promise<BatchItemResult[]> {
  const { ui, taskBatchAction } = useStore();
  const { proto, update } = useProto();
  return async (ids, action) => {
    const real = ids.filter((id) => ui.tasks[id] !== undefined);
    const fake = ids.filter((id) => ui.tasks[id] === undefined);
    const results: BatchItemResult[] = [];
    for (const batch of inChunks(real, TASK_BATCH_MAX)) {
      try {
        const done = await taskBatchAction(batch, action);
        results.push(...done.results.map((r): BatchItemResult => (r.ok ? { taskId: r.taskId, ok: true } : { taskId: r.taskId, ok: false, message: r.message })));
      } catch (err) {
        // 这一批整个被拒（比如守护进程还是旧版本）：页面底部已经提示了原因，这里每个都记成没成，别的批照常
        const why = `没交上去：${err instanceof Error ? err.message : String(err)}`;
        results.push(...batch.map((taskId): BatchItemResult => ({ taskId, ok: false, message: why })));
      }
    }
    if (fake.length > 0) {
      let running = proto.board.filter((e) => e.kind === "task" && e.status === "running" && !fake.includes(e.id)).length;
      const patches = new Map<string, Partial<TaskSummary>>();
      for (const id of fake) {
        const entry = proto.board.find((e): e is TaskSummary => e.kind === "task" && e.id === id);
        if (!entry || !canBatch(protoSubject(entry), action)) {
          results.push({ taskId: id, ok: false, message: "现在不能这样做" });
          continue;
        }
        const after = protoAfter(action, running);
        if (after.status === "running") running += 1;
        patches.set(id, { status: after.status, waitReason: undefined, ...(after.activity ? { activity: after.activity, activityNote: undefined } : {}) });
        results.push({ taskId: id, ok: true });
      }
      update((s) => ({ ...s, board: s.board.map((e) => (e.kind === "task" && patches.has(e.id) ? { ...e, ...patches.get(e.id) } : e)) }));
    }
    return ids.map((id) => results.find((r) => r.taskId === id)!);
  };
}

/** 底部的操作栏：entries 是勾上的、还在看板上的任务 */
export function BoardSelectBar({ entries, onDone }: { entries: readonly BatchEntry[]; onDone(): void }) {
  const counts = batchCounts(entries);
  const run = useBoardBatch();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; body: string }>();
  const [result, setResult] = useState<{ summary: string; failures: string[] }>();
  const titleOf = (id: string) => entries.find((e) => e.id === id)?.title ?? id;

  const go = (action: TaskBatchAction) => {
    const { ids, skipped } = batchTargets(entries, action);
    if (ids.length === 0) return;
    setBusy(true);
    run(ids, action).then(
      (results) => {
        const r = batchResult(action, results, skipped, titleOf);
        if (r.failures.length > 0) setResult(r);
        else toast(r.summary);
      },
      // 一批整个被拒的已经记成没成（上面）；走到这里的是没想到的错，不再提示
      () => undefined,
    ).finally(() => setBusy(false));
  };

  return (
    <div className="sel-bar" role="toolbar" aria-label="多选的操作">
      <span className="sel-n">已选 {entries.length} 个</span>
      <div className="sel-acts">
        {TASK_BATCH_ACTIONS.map((a) => (
          <button
            key={a}
            type="button"
            className={`btn small ${a === "cancel" ? "ghost sel-danger" : "ghost"}`}
            disabled={busy || counts[a] === 0}
            onClick={() => {
              if (a !== "cancel") return go(a);
              const { ids, skipped } = batchTargets(entries, a);
              setConfirm(batchCancelConfirm(ids.length, skipped));
            }}
          >
            {BATCH_ACTION_LABEL[a]}
            {counts[a] > 0 && <span className="sel-count">（{counts[a]}）</span>}
          </button>
        ))}
      </div>
      <button type="button" className="btn small primary sel-done" onClick={onDone}>
        完成
      </button>
      {confirm && (
        <Sheet title={confirm.title} onClose={() => setConfirm(undefined)} center>
          <div className="modal-body">
            <p>{confirm.body}</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirm(undefined)}>
              先不取消
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                setConfirm(undefined);
                go("cancel");
              }}
            >
              取消这些任务
            </button>
          </div>
        </Sheet>
      )}
      {result && (
        <Sheet title={result.summary} onClose={() => setResult(undefined)} center>
          <ul className="sel-failures">
            {result.failures.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <div className="auth-actions">
            <button type="button" className="btn primary" onClick={() => setResult(undefined)}>
              知道了
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
