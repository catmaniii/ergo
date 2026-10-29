/**
 * 补齐规范文档卡（262 号票）：规范上线之前建的项目，按它的类型和本项目的规范改写还缺哪几份，负载是 StandardBackfillCardPayload。
 * - 缺的每一份一行：名字（改写里多出来的写它的名字）、在项目档案里的位置、缺还是只有说明；
 * - "补齐"：项目改用这一版规范，有模板的几份先放进项目档案，再建一个任务交给维护者照项目现状写好（已有的文档不动）；
 *   "不补"：照旧用，不会再问。不硬卡：卡一直挂着也不碍事。
 * 卡进待我处理，项目页"规范"一块下面也列着
 */
import { PROJECT_KIND_LABEL, STANDARD_BACKFILL_CHOICE_LABEL, type StandardBackfillCardPayload, standardBackfillRows, t } from "../../state/index.ts";
import { type CardProps, CardShell } from "./CardShell.tsx";

/** 选过之后写什么：补齐（建了哪个任务；确认时都齐了就没建）、不补 */
function doneLabel(p: StandardBackfillCardPayload): string | undefined {
  if (!p.decided) return undefined;
  if (p.decided.choice === "skip") return t("ui.standardBackfillCard.skipped");
  return p.decided.taskId ? t("ui.standardBackfillCard.backfilled", { version: p.version, task: p.decided.taskId }) : t("ui.standardBackfillCard.adopted", { version: p.version });
}

export function StandardBackfillCard({ state, payload: p, act }: CardProps<StandardBackfillCardPayload>) {
  const rows = standardBackfillRows(p);
  return (
    <CardShell
      state={state}
      title={p.projectName}
      doneLabel={doneLabel(p)}
      actions={
        <>
          <button type="button" className="btn ghost" onClick={() => act("dismiss")}>
            {STANDARD_BACKFILL_CHOICE_LABEL.skip}
          </button>
          <button type="button" className="btn primary" onClick={() => act("confirm")}>
            {STANDARD_BACKFILL_CHOICE_LABEL.backfill}
          </button>
        </>
      }
    >
      <div className="agent-says">{t("ui.standardBackfillCard.intro", { version: p.version, kind: PROJECT_KIND_LABEL[p.kind] })}</div>
      <ul className="backfill-docs">
        {rows.map((r) => (
          <li key={r.key} className="backfill-doc" data-state={r.state}>
            <span className="backfill-doc-label">{r.label}</span>
            <code className="backfill-doc-path">{r.path}</code>
            <span className={`chip ${r.state === "missing" ? "chip-no" : "chip-quiet"}`}>{r.stateLabel}</span>
          </li>
        ))}
      </ul>
      <div className="muted">{t("ui.standardBackfillCard.note", { version: p.version })}</div>
    </CardShell>
  );
}
