// 会话回退的确认（150 号票，不自动恢复的那一种）：标题是回退点的说法，
// "这之后的历史会变成一条灰色的已废弃分支，保留可查"；这一段已经在真实世界里做了的事（守护进程现取：本机还是对外、能不能申请撤回），
// "撤回会话不会动这些"；取消什么都不变，撤回交给守护进程（停稳二狗、写分支摘要、长出新分支）。
// 152 号票：长程任务阶段开始的回退点多一句"撤回之后维护者从这一阶段接着做"。
// 155 号票：一次性的流程步骤开始的回退点多一句"撤回之后停在这一步，等你说一句再接着做"（用户 2026-10-18 定：一分钟没说话提醒一次）。
// 293 号票：维护者用的运行时按能力清单多说几句（rollbackRuntimeNotes）——分支摘要不是它自己写的（Claude Code：从这条之前另起一个会话接着，摘要由二狗写）；
// 撤回时它会把改过的文件恢复到这条之前（只追它的 Write、Edit，Bash 改的文件追不到；阶段、步骤开始前的不恢复），"做了的事"下面的说明跟着改。
// 二狗的框是 Sheet center（和左侧卡的完整情况、从这里重做一样），按钮在做的时候写"正在撤回…"，做完关掉；没做成的原因进顶上的失败提示。
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../../app/store.tsx";
import {
  type ConversationId,
  conversationRuntime,
  describeCall,
  fallbackLine,
  isTriggered,
  type RollbackEffect,
  type RollbackPreview,
  rollbackRuntimeNotes,
  STAGE_ROLLBACK_CONTINUES,
  t,
  WORKFLOW_ROLLBACK_WAITS,
  type ZoomRollbackPoint,
} from "../../state/index.ts";
import { Sheet } from "../common.tsx";
import { useRuntimes } from "../runtimes.tsx";

type PreviewState = { state: "loading" } | { state: "ready"; preview: RollbackPreview } | { state: "failed"; error: string };

/** 现取这一段做了的事 */
function usePreview(conversation: ConversationId, point: ZoomRollbackPoint): PreviewState {
  const { http } = useStore();
  const key = `${conversation}\u0000${"messageId" in point.before ? `m:${point.before.messageId}` : "branchId" in point.before ? `b:${point.before.branchId}` : `s:${point.before.stageStart}`}`;
  const [got, setGot] = useState<{ key: string; view: PreviewState }>();
  useEffect(() => {
    const abort = new AbortController();
    const done = (view: PreviewState) => {
      if (!abort.signal.aborted) setGot({ key, view });
    };
    http.rollbackPreview(conversation, point.before, abort.signal).then(
      (preview) => done({ state: "ready", preview }),
      (err: unknown) => done({ state: "failed", error: err instanceof Error ? err.message : String(err) }),
    );
    return () => abort.abort();
  }, [http, conversation, point.before, key]);
  return got?.key === key ? got.view : { state: "loading" };
}

/** 一件事说成人话：照工具调用那一行（StageDetail 的"已经做了的事"同一个写法；151 号票分支详情的遗留效果同一个） */
export const effectTitle = (e: RollbackEffect) => describeCall(e.tool, e.argsSummary) ?? fallbackLine(e.tool, e.argsSummary);

export function RollbackDialog({ conversation, point, onClose }: { conversation: ConversationId; point: ZoomRollbackPoint; onClose(): void }) {
  const { rollbackSession, ui } = useStore();
  /** 撤回之后维护者会接着做（任务没暂停、没在排队） */
  const taskRuns = (taskId: string) => {
    const task = ui.tasks[taskId];
    return task !== undefined && task.state !== "paused" && task.state !== "queued";
  };
  /** 撤回之后流程停在这一步等你说话（155 号票）：一次性的流程（定时、事件触发的按次运行，撤回只回退这一次运行的会话）、没暂停着 */
  const flowWaits = (taskId: string) => {
    const task = ui.tasks[taskId];
    return task !== undefined && !isTriggered(task) && task.state !== "paused";
  };
  const view = usePreview(conversation, point);
  const [busy, setBusy] = useState(false);
  // 维护者用的运行时多说的（293 号票）：阶段、步骤开始前的回退点是一次工具调用前后
  const notes = rollbackRuntimeNotes(useRuntimes(), conversationRuntime(ui, conversation), point.stage !== undefined || point.step !== undefined);
  const effects = view.state === "ready" ? view.preview.effects : [];
  const external = effects.filter((e) => e.scope === "external");
  const undoable = effects.filter((e) => e.undoable);
  const confirm = () => {
    setBusy(true);
    // 没做成：原因进顶上的失败提示（request_failed），框照样关掉
    void rollbackSession(conversation, point.before)
      .catch(() => undefined)
      .finally(onClose);
  };
  return createPortal(
    <Sheet center title={point.label} onClose={busy ? () => undefined : onClose}>
      <div className="rb-pop-note">
        {t("ui.rollback.becomesBranch")}
        {/* 长程任务阶段开始的回退点（152 号票，"撤回之后从这一步接着做"）：任务暂停着、排着队的不说 */}
        {point.stage && taskRuns(point.stage.taskId) ? STAGE_ROLLBACK_CONTINUES : ""}
        {point.step && flowWaits(point.step.taskId) ? WORKFLOW_ROLLBACK_WAITS : ""}
      </div>
      {notes.lines.map((line) => (
        <div key={line} className="rb-pop-note rb-pop-runtime">
          {line}
        </div>
      ))}
      {view.state === "loading" ? (
        <div className="rb-pop-note muted">{t("ui.rollback.loading")}</div>
      ) : view.state === "failed" ? (
        <div className="rb-pop-note rb-pop-failed">{view.error}</div>
      ) : effects.length > 0 ? (
        <div className="rb-pop-eff">
          <div className="rb-pop-eff-head">
            {t("ui.rollback.effectsDone", { count: effects.length })}
            {external.length > 0 && <span className="rb-pop-warn">{t("ui.rollback.external", { count: external.length })}</span>}
          </div>
          <ul>
            {effects.map((e) => (
              <li key={e.callId} className={e.undoable ? "eff-undoable" : "eff-stuck"}>
                <span className="eff-scope">{e.scope === "local" ? t("ui.rollback.local") : t("ui.rollback.outside")}</span>
                {effectTitle(e)}
                <span className="muted">{` · ${e.undoable ? t("ui.rollback.canRequestUndo") : (e.why ?? t("ui.rollback.irreversible"))}`}</span>
              </li>
            ))}
          </ul>
          <div className="muted">
            {notes.restoresFiles
              ? undoable.length > 0
                ? t("ui.rollback.noteUndoableFiles", { count: undoable.length, runtime: notes.runtimeTitle })
                : t("ui.rollback.noteNoUndoableFiles", { runtime: notes.runtimeTitle })
              : undoable.length > 0
                ? t("ui.rollback.noteUndoable", { count: undoable.length })
                : t("ui.rollback.noteNoUndoable")}
          </div>
        </div>
      ) : (
        <div className="rb-pop-note muted">{t("ui.rollback.noEffects")}</div>
      )}
      <div className="auth-actions rb-pop-actions">
        <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
          {t("ui.rollback.cancel")}
        </button>
        <button type="button" className="btn danger" disabled={busy || view.state === "failed"} onClick={confirm}>
          {busy ? t("ui.rollback.rollingBack") : t("ui.rollback.rollBack")}
        </button>
      </div>
    </Sheet>,
    document.body,
  );
}
