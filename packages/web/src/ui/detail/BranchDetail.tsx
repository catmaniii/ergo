// 一条废弃分支的详情（151 号票）：点 ⑂ 展开的预览打开，依次是
// "已废弃分支 · 只读"、遗留效果（N 件：本机 / 对外、这件事、原因；能撤的「申请撤回」，点了变"已提交撤销请求"；不能撤的"无法撤回"）、
// 分支摘要、完整历史。数据在状态层的 abandoned-branch.ts（守护进程那份经 HTTP 取：遗留效果、分支摘要、手里没有的消息）。
// 「申请撤回」不只在这一页记着（那样刷新就没了），交给守护进程记进事件日志、调撤销接口
// （默认什么都不做，用户定的第 4 条），几台设备、刷新之后都还是"已提交"；点下去先显示"已提交撤销请求"，被拒了收回来（原因进顶上的失败提示）。
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { abandonedBranch, type BranchEffectView, type ConversationId, currentBranch, t } from "../../state/index.ts";
import { ChatItemView } from "../conversation/ChatItemView.tsx";
import { effectTitle } from "../zoom/rollback.tsx";
import { Section } from "./section.tsx";

/** 完整历史只读：不开详情、不引用卡片（不传 onDecide、onDetail） */
const READ_ONLY = {};

export function BranchDetail({ conversation, branchId }: { conversation: ConversationId; branchId: string }) {
  const { ui, loadBranch } = useStore();
  const view = useMemo(() => abandonedBranch(ui, conversation, branchId), [ui, conversation, branchId]);
  const isCurrent = currentBranch(ui, conversation) === branchId;
  // 守护进程那份（和现在的当前分支比的）还没取回：去取；会话树变了（切换、回退）会作废，再取
  const [failed, setFailed] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (view.loaded || isCurrent) return;
    let live = true;
    loadBranch(conversation, branchId).then(
      () => live && setFailed(undefined),
      (err: unknown) => live && setFailed(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [view.loaded, isCurrent, loadBranch, conversation, branchId]);
  // 切换到了这条分支（详情还开着）：它现在就是会话里的那一条，不再是废弃分支
  if (isCurrent) return <div className="page-placeholder">{t("ui.branchDetail.nowCurrent")}</div>;
  return (
    <>
      <div className="dt-head">
        <span className="tag tag-ab">{t("ui.branches.abandoned")}</span>
        <span className="dt-status">{t("ui.branchDetail.readOnly")}</span>
      </div>
      {view.loaded ? (
        <EffectLedger conversation={conversation} branchId={branchId} effects={view.effects} />
      ) : (
        <div className="muted dt-note">{failed ? t("ui.branchDetail.loadFailed", { error: failed }) : t("ui.branchDetail.loading")}</div>
      )}
      {view.summary && (
        <Section title={t("ui.branchDetail.summary")}>
          <div className="dt-doc">{view.summary}</div>
        </Section>
      )}
      <Section title={t("ui.branchDetail.history")}>
        <div className="dt-branch">
          {view.items.map((c) => (
            <div key={c.id} className="chat-item">
              <ChatItemView item={c} actions={READ_ONLY} />
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

/**
 * 遗留效果清单：这条被放弃的分支已经在真实世界里做了什么。
 * 本机操作（删文件、覆盖文件）能交给系统级撤销能力去收，对外发生的（消息、扣款）收不回来。
 * 撤销本身由外部能力实现，这里只把这个动作摆出来、把边界说清楚。
 */
function EffectLedger({ conversation, branchId, effects }: { conversation: ConversationId; branchId: string; effects: readonly BranchEffectView[] }) {
  const { requestEffectUndo } = useStore();
  /** 点了、守护进程还没回（或者回了、频道上那条还没到）的：先当已提交 */
  const [asked, setAsked] = useState<Readonly<Record<string, boolean>>>({});
  if (!effects.length) return null;
  const undoable = effects.filter((e) => e.undoable);
  const ask = (callId: string) => {
    setAsked((a) => ({ ...a, [callId]: true }));
    requestEffectUndo(conversation, branchId, callId).catch(() =>
      setAsked((a) => {
        const next = { ...a };
        delete next[callId];
        return next;
      }),
    );
  };
  return (
    <Section title={t("ui.branchDetail.effects", { count: effects.length })}>
      <div className="muted dt-note">{t("ui.branchDetail.effectsNote")}</div>
      <ul className="eff-list">
        {effects.map((e) => (
          <li key={e.callId} className={e.undoable ? "eff-undoable" : "eff-stuck"}>
            <span className="eff-scope">{e.scope === "local" ? t("ui.rollback.local") : t("ui.rollback.outside")}</span>
            <span className="eff-title">{effectTitle(e)}</span>
            {e.why && <span className="muted eff-why">{e.why}</span>}
            {e.undoable ? (
              e.requested !== undefined || asked[e.callId] ? (
                <span className="eff-asked">{t("ui.branchDetail.undoRequested")}</span>
              ) : (
                <button type="button" className="btn ghost eff-btn" onClick={() => ask(e.callId)}>
                  {t("ui.branchDetail.requestUndo")}
                </button>
              )
            ) : (
              <span className="eff-none">{t("ui.branchDetail.cantUndo")}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="muted dt-note">
        {undoable.length ? t("ui.branchDetail.undoableNote", { count: undoable.length }) : t("ui.branchDetail.noUndoable")}
      </div>
    </Section>
  );
}
