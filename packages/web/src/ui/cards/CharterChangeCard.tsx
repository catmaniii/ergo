/**
 * 立项要求变更卡（125 号票）：立项书确认之后，你在会话里说要改立项要求（目标、范围、首版），项目的维护者用 propose_charter_change
 * 提出，负载是 CharterChangeCardPayload。
 * - 逐条对照新旧：目标、首版写改前（划掉）和改后，范围写去掉的和加上的条目；
 * - 附上它引用、运行时核实过的你的原话（单独一栏）；写明项目类型、工作目录、工具包不走这条路；
 * - 确认后运行时改写立项书（末尾记一条变更记录）；拒绝（可附一句）立项书不变，维护者照原来的立项书做。
 * 卡进待我处理，也出在你说话的那个会话里；项目页立项书一节下面也列着
 */
import { Fragment, useState } from "react";
import { CHARTER_FIXED_NOTE, type CharterChangeCardPayload, charterChangeRows, t } from "../../state/index.ts";
import { UserWordsBlock } from "../user-words.tsx";
import { type CardProps, CardShell } from "./CardShell.tsx";

export function CharterChangeCard({ state, payload: p, act }: CardProps<CharterChangeCardPayload>) {
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  const outcome = state.card.outcome;
  const rows = charterChangeRows(p);
  return (
    <CardShell
      state={state}
      title={t("ui.charterChangeCard.title", { project: p.projectName, revision: p.revision })}
      doneLabel={
        outcome?.action === "reject"
          ? outcome.note
            ? t("ui.charterChangeCard.rejectedNote", { note: outcome.note })
            : t("ui.charterChangeCard.rejected")
          : outcome?.action === "confirm"
            ? t("ui.charterChangeCard.confirmed")
            : undefined
      }
      actions={
        rejecting ? (
          <div className="plan-reject">
            <textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("ui.charterChangeCard.reasonPlaceholder")} rows={2} />
            <div className="auth-actions">
              <button type="button" className="btn ghost" onClick={() => setRejecting(false)}>
                {t("ui.charterChangeCard.cancel")}
              </button>
              <button type="button" className="btn danger" onClick={() => act("reject", comment.trim() || undefined)}>
                {t("ui.charterChangeCard.reject")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="btn ghost" onClick={() => setRejecting(true)}>
              {t("ui.charterChangeCard.reject")}
            </button>
            <button type="button" className="btn primary" onClick={() => act("confirm")}>
              {t("ui.charterChangeCard.confirm")}
            </button>
          </>
        )
      }
    >
      <div className="agent-says">{p.why}</div>
      <UserWordsBlock words={p.userWords} />
      <dl className="kv charter-diff">
        {rows.map((r) => (
          <Fragment key={r.key}>
            <dt>{r.label}</dt>
            <dd>
              {r.kind === "replace" ? (
                <>
                  <div className="charter-before">
                    <span className="charter-diff-k">{t("ui.charterChangeCard.before")}</span>
                    <s>{r.before}</s>
                  </div>
                  <div className="charter-after">
                    <span className="charter-diff-k">{t("ui.charterChangeCard.after")}</span>
                    {r.after}
                  </div>
                </>
              ) : (
                <ul className="plain-list">
                  {r.removed.map((s) => (
                    <li key={`-${s}`} className="charter-before">
                      <span className="charter-diff-k">{t("ui.charterChangeCard.removed")}</span>
                      <s>{s}</s>
                    </li>
                  ))}
                  {r.added.map((s) => (
                    <li key={`+${s}`} className="charter-after">
                      <span className="charter-diff-k">{t("ui.charterChangeCard.added")}</span>
                      {s}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </Fragment>
        ))}
      </dl>
      <div className="muted">{t("ui.charterChangeCard.note", { fixed: CHARTER_FIXED_NOTE })}</div>
    </CardShell>
  );
}
