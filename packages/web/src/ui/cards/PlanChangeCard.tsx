/**
 * 计划变更卡（规格第 5、8 节，14 号票）：维护者执行中要扩大授权、加能力、加项目、改目标或验收时提交，负载是 PlanChangeCardPayload。
 * - 只列相对当前计划新增或改动的部分（文字由代码从结构化数据生成，state/plan-change-card.ts），扩大授权的那几处标"要你确认"；
 * - 新增的授权项可以勾掉（执行到那一步再问你）；只有受影响的阶段停下来等，其余照常推进；
 * - 确认后计划和授权项随之更新；拒绝（可附说明）后维护者在现有授权内重排，做不到就标做不了。
 * - 125 号票：维护者引用、运行时核实过的你的原话单独一栏（UserWordsBlock）；你在秘书那里说的、秘书转达的，卡也出在秘书会话里。
 * 维护者不在任务里时要加能力的"工具包变更"是单独的一种卡（toolkit_change，27 号票，见 cards.tsx 的 ToolkitChangeCard）。
 */
import { useState } from "react";
import { type PlanChangeCardPayload, planChangeAffectedText, planChangeConfirmInput, planChangeLines, t } from "../../state/index.ts";
import { outcomeLabel } from "../../model/cards.ts";
import { type CardProps, CardShell } from "./CardShell.tsx";
import { PlanOutline } from "./PlanOutline.tsx";
import { UserWordsBlock } from "../user-words.tsx";

export function PlanChangeCard({ state, payload: p, done, act }: CardProps<PlanChangeCardPayload>) {
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  const lines = planChangeLines(p);
  const outcome = state.card.outcome;
  const toggle = (id: string) => {
    const next = new Set(removed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setRemoved(next);
  };
  return (
    <CardShell
      state={state}
      title={t("ui.planChangeCard.title", { task: p.taskTitle, revision: p.revision })}
      // 计划变更卡上的"拒绝"不是打回重写：拒绝后维护者在现有授权内重排
      doneLabel={outcome?.action === "reject" ? (outcome.note ? t("ui.planChangeCard.rejectedNote", { note: outcome.note }) : t("ui.planChangeCard.rejected")) : outcomeLabel(state.card)}
      actions={
        rejecting ? (
          <div className="plan-reject">
            <textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("ui.planChangeCard.reasonPlaceholder")} rows={2} />
            <div className="auth-actions">
              <button type="button" className="btn ghost" onClick={() => setRejecting(false)}>
                {t("ui.planChangeCard.cancel")}
              </button>
              <button type="button" className="btn danger" onClick={() => act("reject", comment.trim() || undefined)}>
                {t("ui.planChangeCard.reject")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="btn ghost" onClick={() => setRejecting(true)}>
              {t("ui.planChangeCard.reject")}
            </button>
            <button type="button" className="btn primary" onClick={() => act("confirm", undefined, planChangeConfirmInput(removed))}>
              {t("ui.planChangeCard.confirm")}
            </button>
          </>
        )
      }
    >
      <div className="agent-says">{p.why}</div>
      <UserWordsBlock words={p.userWords} />
      {/* 93 号票：变更后的各阶段一直列着（提纲：新加的标"新"、改过的标"改"、去掉的划掉） */}
      <PlanOutline card={state.card} />
      <fieldset className="plan-sec" disabled={done}>
        <legend className="plan-sec-h">{t("ui.planChangeCard.changes")}</legend>
        {lines.map((l) =>
          l.grantId ? (
            <label key={l.key} className={`check-row grant-row${removed.has(l.grantId) ? " grant-off" : ""}`}>
              <input type="checkbox" checked={!removed.has(l.grantId)} onChange={() => toggle(l.grantId!)} />
              <span>
                {l.text}
                {l.expands && <span className="chip chip-high">{t("ui.planChangeCard.needsConfirm")}</span>}
              </span>
            </label>
          ) : (
            <div key={l.key} className="grant-row">
              {l.text}
              {l.expands && <span className="chip chip-high">{t("ui.planChangeCard.needsConfirm")}</span>}
            </div>
          ),
        )}
      </fieldset>
      <div className="muted">{planChangeAffectedText(p)}</div>
      {p.removedGrants && p.removedGrants.length > 0 && <div className="muted">{t("ui.planChangeCard.unchecked", { list: p.removedGrants.map((g) => g.title).join(t("ui.common.listSep")) })}</div>}
    </CardShell>
  );
}
