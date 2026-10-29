// 看板多选的操作栏（90 号票）："已选 N 个 · 暂停 · 继续 · 取消 · 归档 · 完成"。
// - 每个操作只对能做的生效（state/task-menu.ts 的 batchCounts / batchTargets：照"谁能改"表，运营中的定时任务看它的触发），
//   按钮上写个数（"取消（3）"），一个都不能做时灰掉；
// - 取消先确认一次，写清几个会取消、几个跳过；
// - 真任务交给守护进程（task_batch_action，各自成败、逐条回报；一次最多 TASK_BATCH_MAX 个，多了分批一批批交，结果接起来——
//   90 号票评审），原型看板上的假任务在页面上演（prototype/proto-task-acts.ts）；
//   做完提示结果：全成功是页面底部一句短提示，有没成的弹出来逐条写为什么（有一批整个被拒时，那一批的每个都写"没交上去"和原因）。
// 156 号票：简单提醒也能勾上；和任务混选时批量动作只给两者都能做的，别的灰掉，按钮下面写明为什么（state/board-batch.ts）。
// 185 号票：提醒能一起取消、归档、删除，操作栏多一个只对提醒的"删除"（先确认）；混选时能一起取消、归档。真提醒交 reminder_action
// （各自成败、逐条回报，一次最多 REMINDER_ACTION_MAX 条，多了分批），原型的假提醒在页面上演（取消挪进最近结束、归档挪进已归档、删除拿掉）。
// 157 号票：右边原来的"完成"换成"✕ 退出多选"（ui/select-mode.tsx），操作栏整条染一层强调色，一眼看得出在多选。
// 186 号票：任务也能删（交 task_batch_action 的 delete，没结束的守护进程先停下再删；先确认，写清几个任务、几条提醒、不能删的为什么），
// 混选时删除对两边都生效；没结束的任务也能归档（守护进程先取消再归档），有这样的时归档先确认，写明其中几个会先取消。
import { useState } from "react";
import { useStore } from "../app/store.tsx";
import type { ReminderSummary, TaskSummary } from "../model/types.ts";
import { protoAfter, protoSubject } from "../prototype/proto-task-acts.ts";
import { useProto } from "../prototype/proto-store.tsx";
import {
  BATCH_ACTION_LABEL,
  BOARD_BATCH_ACTIONS,
  type BatchItemResult,
  type BoardBatchAction,
  type BoardBatchEntry,
  boardBatchArchiveConfirm,
  boardBatchBlocked,
  boardBatchCancelConfirm,
  boardBatchCounts,
  boardBatchDeleteConfirm,
  boardBatchTargets,
  boardBatchWhy,
  batchResult,
  canBatch,
  canBatchReminder,
  inChunks,
  notEnded,
  type ReminderAction,
  type ReminderBatchEntry,
  REMINDER_ACTION_MAX,
  reminderActionOf,
  t,
  TASK_BATCH_MAX,
  type TaskBatchAction,
} from "../state/index.ts";
import { Sheet } from "../ui/common.tsx";
import { SelectExit } from "../ui/select-mode.tsx";
import { useToast } from "../ui/toast.tsx";

/** 原型的假提醒做完这件事之后的样子（删除是 undefined：从看板上拿掉） */
function protoReminderAfter(r: ReminderSummary, action: ReminderAction): ReminderSummary | undefined {
  if (action === "delete") return undefined;
  return action === "cancel" ? { ...r, status: "cancelled" } : { ...r, archived: true };
}

/**
 * 一次对几条提醒取消、归档、删除（156 号票的取消，185 号票加了归档、删除）：真提醒交 reminder_action（各自成败、逐条回报；
 * 一次最多 REMINDER_ACTION_MAX 条，多了分批，一批整个被拒时那一批每条都记成没交上去），原型的假提醒在页面上演
 */
function useReminderBatch(): (entries: readonly ReminderBatchEntry[], action: ReminderAction) => Promise<BatchItemResult[]> {
  const { ui, reminderAction } = useStore();
  const { proto, update } = useProto();
  return async (entries, action) => {
    const real = entries.filter((e) => ui.reminders[e.id] !== undefined).map((e) => e.id);
    const fake = entries.filter((e) => ui.reminders[e.id] === undefined);
    const results: BatchItemResult[] = [];
    for (const batch of inChunks(real, REMINDER_ACTION_MAX)) {
      try {
        const done = await reminderAction(batch, action);
        results.push(...done.results.map((r): BatchItemResult => (r.ok ? { taskId: r.reminderId, ok: true } : { taskId: r.reminderId, ok: false, message: r.message })));
      } catch (err) {
        const why = t("pages.boardSelect.notSubmitted", { reason: err instanceof Error ? err.message : String(err) });
        results.push(...batch.map((taskId): BatchItemResult => ({ taskId, ok: false, message: why })));
      }
    }
    if (fake.length > 0) {
      const after = new Map<string, ReminderSummary | undefined>();
      for (const e of fake) {
        const entry = proto.board.find((b): b is ReminderSummary => b.kind === "reminder" && b.id === e.id);
        if (!entry || !canBatchReminder(entry, action)) {
          results.push({ taskId: e.id, ok: false, message: t("pages.boardSelect.notNow") });
          continue;
        }
        after.set(e.id, protoReminderAfter(entry, action));
        results.push({ taskId: e.id, ok: true });
      }
      update((s) => ({
        ...s,
        board: s.board.flatMap((b) => {
          if (b.kind !== "reminder" || !after.has(b.id)) return [b];
          const next = after.get(b.id);
          return next ? [next] : [];
        }),
      }));
    }
    return entries.map((e) => results.find((r) => r.taskId === e.id)!);
  };
}

/** 一次处理多个任务：真任务交给守护进程，原型的假任务在页面上演；逐条的结果按交上来的先后 */
function useBoardBatch(): (ids: readonly string[], action: TaskBatchAction) => Promise<BatchItemResult[]> {
  const { ui, taskBatchAction } = useStore();
  const { proto, update } = useProto();
  return async (ids, action) => {
    if (ids.length === 0) return [];
    const real = ids.filter((id) => ui.tasks[id] !== undefined);
    const fake = ids.filter((id) => ui.tasks[id] === undefined);
    const results: BatchItemResult[] = [];
    for (const batch of inChunks(real, TASK_BATCH_MAX)) {
      try {
        const done = await taskBatchAction(batch, action);
        results.push(...done.results.map((r): BatchItemResult => (r.ok ? { taskId: r.taskId, ok: true } : { taskId: r.taskId, ok: false, message: r.message })));
      } catch (err) {
        // 这一批整个被拒（比如守护进程还是旧版本）：页面底部已经提示了原因，这里每个都记成没成，别的批照常
        const why = t("pages.boardSelect.notSubmitted", { reason: err instanceof Error ? err.message : String(err) });
        results.push(...batch.map((taskId): BatchItemResult => ({ taskId, ok: false, message: why })));
      }
    }
    if (fake.length > 0) {
      let running = proto.board.filter((e) => e.kind === "task" && e.status === "running" && !fake.includes(e.id)).length;
      const patches = new Map<string, Partial<TaskSummary>>();
      for (const id of fake) {
        const entry = proto.board.find((e): e is TaskSummary => e.kind === "task" && e.id === id);
        if (!entry || !canBatch(protoSubject(entry), action)) {
          results.push({ taskId: id, ok: false, message: t("pages.boardSelect.notNow") });
          continue;
        }
        const after = protoAfter(action, running);
        if (after.status === "running") running += 1;
        patches.set(id, { status: after.status, waitReason: undefined, ...(after.activity ? { activity: after.activity, activityNote: undefined } : {}) });
        results.push({ taskId: id, ok: true });
      }
      // 删除（186 号票）：假任务从看板上拿掉；别的照状态变
      update((s) => ({
        ...s,
        board: s.board.flatMap((e) => (e.kind !== "task" || !patches.has(e.id) ? [e] : action === "delete" ? [] : [{ ...e, ...patches.get(e.id) }])),
      }));
    }
    return ids.map((id) => results.find((r) => r.taskId === id)!);
  };
}

/** 底部的操作栏：entries 是勾上的、还在看板上的任务和简单提醒 */
export function BoardSelectBar({ entries, onDone }: { entries: readonly BoardBatchEntry[]; onDone(): void }) {
  const counts = boardBatchCounts(entries);
  const why = boardBatchWhy(entries);
  const runTasks = useBoardBatch();
  const runReminders = useReminderBatch();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ action: "cancel" | "delete" | "archive"; title: string; body: string; ok: string }>();
  const [result, setResult] = useState<{ summary: string; failures: string[] }>();
  const titleOf = (id: string) => entries.find((e) => e.id === id)?.title ?? id;

  const go = (action: BoardBatchAction) => {
    const { ids, skipped } = boardBatchTargets(entries, action);
    if (ids.length === 0) return;
    const reminders = entries.filter((e): e is ReminderBatchEntry => e.kind === "reminder" && ids.includes(e.id));
    const tasks = ids.filter((id) => !reminders.some((r) => r.id === id));
    const forReminders = reminderActionOf(action);
    setBusy(true);
    // 提醒交 reminder_action，任务交 task_batch_action；结果按勾上的先后接起来
    Promise.all([tasks.length > 0 ? runTasks(tasks, action) : [], forReminders && reminders.length > 0 ? runReminders(reminders, forReminders) : []])
      .then(
        ([taskResults, reminderResults]) => {
          const all = [...taskResults, ...reminderResults];
          const r = batchResult(action, ids.map((id) => all.find((x) => x.taskId === id)!), skipped, titleOf);
          if (r.failures.length > 0) setResult(r);
          else toast(r.summary);
        },
        // 一批整个被拒的已经记成没成（上面）；走到这里的是没想到的错，不再提示
        () => undefined,
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="sel-bar" role="toolbar" aria-label={t("pages.boardSelect.toolbar")}>
      <span className="sel-n">{t("pages.boardSelect.selected", { count: entries.length })}</span>
      <div className="sel-acts" aria-describedby={why ? "board-sel-why" : undefined}>
        {BOARD_BATCH_ACTIONS.map((a) => (
          <button
            key={a}
            type="button"
            className={`btn small ${a === "cancel" || a === "delete" ? "ghost sel-danger" : "ghost"}`}
            disabled={busy || counts[a] === 0}
            onClick={() => {
              const { ids, skipped } = boardBatchTargets(entries, a);
              // 删除先确认（185 号票只对提醒，186 号票起任务也能删）：写清几个任务、几条提醒，没结束的先停下，不能删的为什么
              if (a === "delete") {
                const tasks = entries.filter((e) => e.kind === "task" && ids.includes(e.id));
                const running = tasks.filter((e) => e.kind === "task" && notEnded(e.subject)).length;
                const reminders = ids.length - tasks.length;
                return setConfirm({
                  action: "delete",
                  ...boardBatchDeleteConfirm({ tasks: tasks.length, running, reminders, blocked: boardBatchBlocked(entries, "delete") }),
                  ok: tasks.length === 0 ? t("pages.boardSelect.deleteReminders") : t("pages.boardSelect.deleteAll"),
                });
              }
              // 归档里有没结束的任务（186 号票：先取消再归档）：先确认；都结束了的照旧直接归档
              if (a === "archive") {
                const asked = boardBatchArchiveConfirm(entries);
                return asked ? setConfirm({ action: "archive", ...asked, ok: t("pages.boardSelect.archiveAll") }) : go(a);
              }
              if (a !== "cancel") return go(a);
              const reminders = entries.filter((e) => e.kind === "reminder" && ids.includes(e.id)).length;
              const tasks = ids.length - reminders;
              setConfirm({
                action: "cancel",
                ...boardBatchCancelConfirm({ tasks, reminders, skipped }),
                ok: reminders === 0 ? t("pages.boardSelect.cancelTasks") : tasks === 0 ? t("pages.boardSelect.cancelReminders") : t("pages.boardSelect.cancelAll"),
              });
            }}
          >
            {BATCH_ACTION_LABEL[a]}
            {counts[a] > 0 && <span className="sel-count">{t("pages.boardSelect.count", { count: counts[a] })}</span>}
          </button>
        ))}
        {why && (
          <span id="board-sel-why" className="sel-why muted">
            {why}
          </span>
        )}
      </div>
      <SelectExit onExit={onDone} />
      {confirm && (
        <Sheet title={confirm.title} onClose={() => setConfirm(undefined)} center>
          <div className="modal-body">
            <p>{confirm.body}</p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => setConfirm(undefined)}>
              {confirm.action === "delete" ? t("pages.boardSelect.keepReminders") : confirm.action === "archive" ? t("pages.boardSelect.keepArchive") : t("pages.boardSelect.keep")}
            </button>
            <button
              type="button"
              className={confirm.action === "archive" ? "btn primary" : "btn danger"}
              onClick={() => {
                setConfirm(undefined);
                go(confirm.action);
              }}
            >
              {confirm.ok}
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
              {t("pages.boardSelect.gotIt")}
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
