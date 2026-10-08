// 定时作业每次运行的授权（19 号票）：随计划卡确认的授权项和时序规则，作业卡、项目页的作业列表上都能看到（默认折叠）。
// 作业在就一直有效，暂停、取消作业即收回；超出的照常先问。

export function JobAuthorization({ grants, rules }: { grants: readonly string[]; rules: readonly string[] }) {
  return (
    <details className="job-auth">
      <summary className="muted">每次运行的授权 {grants.length} 项{rules.length > 0 ? ` · 规则 ${rules.length} 条` : ""}</summary>
      {grants.length === 0 && <div className="muted">没有预先授权的操作：落在关注类别里的事都会先问你</div>}
      <ul className="plain-list">
        {grants.map((g) => (
          <li key={g}>{g}</li>
        ))}
        {rules.map((r) => (
          <li key={r} className="muted">
            规则：{r}
          </li>
        ))}
      </ul>
    </details>
  );
}
