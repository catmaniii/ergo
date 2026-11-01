// 定时作业每次运行的授权（19 号票）：随计划卡确认的授权项和时序规则，作业卡、项目页的作业列表上都能看到（默认折叠）。
// 作业在就一直有效，暂停、取消作业即收回；超出的按"有风险的事先问我"：开着先问，关着直接做（378 号票）。
import { useStore } from "../app/store.tsx";
import { asksOffIn, t } from "../state/index.ts";

export function JobAuthorization({ grants, rules }: { grants: readonly string[]; rules: readonly string[] }) {
  const { ui } = useStore();
  return (
    <details className="job-auth">
      <summary className="muted">
        {t("ui.jobAuthorization.grants", { count: grants.length })}
        {rules.length > 0 ? ` · ${t("ui.jobAuthorization.rules", { count: rules.length })}` : ""}
      </summary>
      {grants.length === 0 && <div className="muted">{t(asksOffIn(ui) ? "ui.jobAuthorization.noneAskOff" : "ui.jobAuthorization.none")}</div>}
      <ul className="plain-list">
        {grants.map((g) => (
          <li key={g}>{g}</li>
        ))}
        {rules.map((r) => (
          <li key={r} className="muted">
            {t("ui.jobAuthorization.rule", { rule: r })}
          </li>
        ))}
      </ul>
    </details>
  );
}
