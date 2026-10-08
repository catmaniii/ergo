/**
 * 计划变更卡（规格第 5、8 节，14 号票）：维护者执行中要扩大授权、加能力、加项目、改目标或验收时提交，负载是 PlanChangeCardPayload。
 * - 只列相对当前计划新增或改动的部分（文字由代码从结构化数据生成，state/plan-change-card.ts），扩大授权的那几处标"要你确认"；
 * - 新增的授权项可以勾掉（执行到那一步再问你）；只有受影响的阶段停下来等，其余照常推进；
 * - 确认后计划和授权项随之更新；拒绝（可附说明）后维护者在现有授权内重排，做不到就标做不了。
 * 维护者不在任务里时要加能力的"工具包变更"（规格第 21 节）由 27 号票做。
 */
import { useState } from "react";
import { type PlanChangeCardPayload, planChangeAffectedText, planChangeConfirmInput, planChangeLines } from "../../state/index.ts";
import { outcomeLabel } from "../../model/cards.ts";
import { type CardProps, CardShell } from "./CardShell.tsx";

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
      title={`${p.taskTitle}（第 ${p.revision} 版计划）`}
      // 计划变更卡上的"拒绝"不是打回重写：拒绝后维护者在现有授权内重排
      doneLabel={outcome?.action === "reject" ? `已拒绝${outcome.note ? `：${outcome.note}` : ""}` : outcomeLabel(state.card)}
      actions={
        rejecting ? (
          <div className="plan-reject">
            <textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="可以写一句为什么（交给维护者，它会在现有授权内重排）" rows={2} />
            <div className="auth-actions">
              <button type="button" className="btn ghost" onClick={() => setRejecting(false)}>
                算了
              </button>
              <button type="button" className="btn danger" onClick={() => act("reject", comment.trim() || undefined)}>
                拒绝
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="btn ghost" onClick={() => setRejecting(true)}>
              拒绝
            </button>
            <button type="button" className="btn primary" onClick={() => act("confirm", undefined, planChangeConfirmInput(removed))}>
              确认变更
            </button>
          </>
        )
      }
    >
      <div className="agent-says">{p.why}</div>
      <fieldset className="plan-sec" disabled={done}>
        <legend className="plan-sec-h">改了什么（只列新增或改动的部分）</legend>
        {lines.map((l) =>
          l.grantId ? (
            <label key={l.key} className={`check-row grant-row${removed.has(l.grantId) ? " grant-off" : ""}`}>
              <input type="checkbox" checked={!removed.has(l.grantId)} onChange={() => toggle(l.grantId!)} />
              <span>
                {l.text}
                {l.expands && <span className="chip chip-high">要你确认</span>}
              </span>
            </label>
          ) : (
            <div key={l.key} className="grant-row">
              {l.text}
              {l.expands && <span className="chip chip-high">要你确认</span>}
            </div>
          ),
        )}
      </fieldset>
      <div className="muted">{planChangeAffectedText(p)}</div>
      {p.removedGrants && p.removedGrants.length > 0 && <div className="muted">你勾掉了：{p.removedGrants.map((g) => g.title).join("、")}</div>}
    </CardShell>
  );
}
