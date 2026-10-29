/**
 * 规范改写卡（261 号票）：你在会话里说这个项目不要规范里的某一份、某一份换一种写法、多一份文档、恢复照默认规范，或者要跟新版规范，
 * 项目的维护者用 propose_standard_change 提出，负载是 StandardChangeCardPayload。
 * - 逐处对照：左边是哪一份（规范里的写名字，多出来的写名字和位置），改前（划掉）和改后；没有改写的一边写"照默认规范"；
 *   跟新版规范写版本，在最前（272 号票：规范上线之前建的项目补齐规范文档，改前写"没有记版本"，下面列缺的几份）；
 * - 附上它引用、运行时核实过的你的原话（单独一栏）；
 * - 确认后才生效（记进项目档案的 standard-overrides.md，项目页"规范"一块看得出哪里不同）；拒绝（可附一句）规范不变。
 * 卡进待我处理，也出在你说话的那个会话里；项目页"规范"一块下面也列着
 */
import { Fragment, useState } from "react";
import { type StandardChangeCardPayload, standardBackfillDocText, standardChangeRows, t } from "../../state/index.ts";
import { UserWordsBlock } from "../user-words.tsx";
import { type CardProps, CardShell } from "./CardShell.tsx";

export function StandardChangeCard({ state, payload: p, act }: CardProps<StandardChangeCardPayload>) {
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  const outcome = state.card.outcome;
  const rows = standardChangeRows(p);
  return (
    <CardShell
      state={state}
      title={t("ui.standardChangeCard.title", { project: p.projectName, revision: p.revision })}
      doneLabel={
        outcome?.action === "reject"
          ? outcome.note
            ? t("ui.standardChangeCard.rejectedNote", { note: outcome.note })
            : t("ui.standardChangeCard.rejected")
          : outcome?.action === "confirm"
            ? t("ui.standardChangeCard.confirmed")
            : undefined
      }
      actions={
        rejecting ? (
          <div className="plan-reject">
            <textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t("ui.standardChangeCard.reasonPlaceholder")} rows={2} />
            <div className="auth-actions">
              <button type="button" className="btn ghost" onClick={() => setRejecting(false)}>
                {t("ui.standardChangeCard.cancel")}
              </button>
              <button type="button" className="btn danger" onClick={() => act("reject", comment.trim() || undefined)}>
                {t("ui.standardChangeCard.reject")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="btn ghost" onClick={() => setRejecting(true)}>
              {t("ui.standardChangeCard.reject")}
            </button>
            <button type="button" className="btn primary" onClick={() => act("confirm")}>
              {t("ui.standardChangeCard.confirm")}
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
              <div className="charter-before">
                <span className="charter-diff-k">{t("ui.standardChangeCard.before")}</span>
                <s>{r.before}</s>
              </div>
              <div className="charter-after">
                <span className="charter-diff-k">{t("ui.standardChangeCard.after")}</span>
                {r.after}
              </div>
            </dd>
          </Fragment>
        ))}
      </dl>
      {p.upgrade && p.upgrade.from === undefined && (p.upgrade.missing ?? []).length > 0 && (
        <div>{t("ui.standardChangeCard.adoptMissing", { docs: (p.upgrade.missing ?? []).map(standardBackfillDocText).join(t("ui.common.listSep")) })}</div>
      )}
      {p.upgrade && <div className="muted">{t(p.upgrade.from === undefined ? "ui.standardChangeCard.adoptNote" : "ui.standardChangeCard.upgradeNote")}</div>}
      <div className="muted">{t("ui.standardChangeCard.note")}</div>
    </CardShell>
  );
}
