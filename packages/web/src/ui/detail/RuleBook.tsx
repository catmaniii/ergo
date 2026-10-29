/**
 * 检测项全览（60 号票）——
 * 这次审查一共用了哪些规则、每条的形式化写法是什么、本次审查在它上面查到了什么、它声明了几种修法、最后为什么选了那一种。
 * "接口"那一行是调用写法（ApiLine）。
 * 规则原文从审查结果里带着的那一份取（WorkflowReview.docs：守护进程审查真正用的，v1 模板加计划里写的，没写修补方案的已补上），
 * 判定结果从本次审查结果里取，两边用规则 id 对上；数据由状态层的 ruleBook 给（state/workflow-view.ts）。
 * 二狗多的：违反了怎么办有三种（协议包的 ON_VIOLATION_TEXT，计划卡、阶段详情同一个说法，84 号票合成一份，不只是"违反后直接拦截"）；
 * 规则来自框架还是计划，写在生效阶段那一行。
 */
import { useState } from "react";
import { costText, expr, RULE_BOOK_STATUS_TEXT, type RuleBookRule, ruleBook, t, type WorkflowReview, WORKFLOW_CONDITION_SOURCE_LABEL } from "../../state/index.ts";

export function RuleBook({ review }: { review: WorkflowReview }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const book = ruleBook(review);
  if (!book) return null;
  return (
    <section className="dt-section">
      <h4>
        {t("ui.ruleBook.title")}
        <button type="button" className="link rb-toggle" onClick={() => setOpen(!open)}>
          {open ? t("ui.ruleBook.collapse") : t("ui.ruleBook.expand", { count: book.rules.length })}
        </button>
      </h4>
      {open && (
        <>
          {book.phases && (
            <div className="rb-phases">
              <div className="rb-obj-title">{t("ui.ruleBook.phases.title")}</div>
              <table className="vv-table">
                <thead>
                  <tr>
                    <th>{t("ui.ruleBook.phases.phase")}</th>
                    <th>{t("ui.ruleBook.phases.what")}</th>
                    <th>{t("ui.ruleBook.phases.time")}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{t("ui.ruleBook.phases.facts")}</td>
                    {/* 环境事实是真实环境里的文件、git 状态（没有联系人和订单） */}
                    <td>{t("ui.ruleBook.phases.factsWhat")}</td>
                    <td>{book.phases.facts}ms</td>
                  </tr>
                  <tr>
                    <td>{t("ui.ruleBook.phases.compile")}</td>
                    <td>{t("ui.ruleBook.phases.compileWhat")}</td>
                    <td>{book.phases.compile}ms</td>
                  </tr>
                  <tr>
                    <td>{t("ui.ruleBook.phases.solve")}</td>
                    <td>{t("ui.ruleBook.phases.solveWhat")}</td>
                    <td>{book.phases.solve}ms</td>
                  </tr>
                  <tr>
                    <td>{t("ui.ruleBook.phases.probe")}</td>
                    <td>{t("ui.ruleBook.phases.probeWhat")}</td>
                    <td>{book.phases.probe}ms</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <div className="rb-objective">
            <div className="rb-obj-title">{t("ui.ruleBook.objective.title")}</div>
            <ol>
              {book.objective.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
            <div className="muted">{t("ui.ruleBook.objective.note")}</div>
          </div>
          {book.rules.map((rule) => (
            <RuleRow key={rule.id} rule={rule} open={!!expanded[rule.id]} onToggle={() => setExpanded((e) => ({ ...e, [rule.id]: !e[rule.id] }))} />
          ))}
        </>
      )}
    </section>
  );
}

/** 检测项全览里的一条（84 号票：长程任务阶段规则的详情页也用它） */
export function RuleRow({ rule, open, onToggle }: { rule: RuleBookRule; open: boolean; onToggle(): void }) {
  const { probe, status, violations, deferred, repairs, chosen } = rule;
  const chosenKinds = chosen.map((c) => c.kind);
  return (
    <div className={`rb-rule rb-${status}`}>
      <button type="button" className="rb-head" onClick={onToggle}>
        <span className="rb-id">{rule.id}</span>
        <span className="rb-title">{rule.title}</span>
        {probe && <span className="rb-ms">{probe.ms}ms</span>}
        <span className={`rb-status rb-s-${status}`}>
          {RULE_BOOK_STATUS_TEXT[status]}
          {status === "violated" ? ` ${violations.length}` : ""}
        </span>
        <span className="rb-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="rb-body">
          <div className="rb-meta">
            {rule.source && `${WORKFLOW_CONDITION_SOURCE_LABEL[rule.source]} · `}
            {t("ui.ruleBook.activeIn", { modes: rule.modes })} · {rule.onViolation}
            {probe && ` · ${t("ui.ruleBook.probe", { ms: probe.ms, violated: probe.violated, unknown: probe.unknown })}`}
            {probe?.error && ` · ${t("ui.ruleBook.probeError", { error: probe.error })}`}
          </div>
          <div className="rb-label">{t("ui.ruleBook.formal")}</div>
          <pre className="rb-formula">{rule.formula.formula}</pre>
          <code className="fm-api">
            <span className="fm-api-k">{t("ui.ruleBook.api")}</span>
            {rule.api}
          </code>
          <div className="muted rb-legend">
            {t("ui.ruleBook.legendG")}
            {rule.formula.past ? t("ui.ruleBook.legendO") : ""}
          </div>

          {violations.length > 0 && (
            <>
              <div className="rb-label">{t("ui.ruleBook.found")}</div>
              <ul className="rb-list">
                {violations.map((v) => (
                  <li key={v.key ?? v.message}>
                    <span className="rb-where">{v.stepId}</span>
                    {v.message}
                  </li>
                ))}
              </ul>
            </>
          )}
          {deferred.length > 0 && (
            <>
              <div className="rb-label">{t("ui.ruleBook.deferred")}</div>
              <ul className="rb-list">
                {deferred.map((v) => (
                  <li key={v.key ?? v.message}>
                    <span className="rb-where">{v.stepId}</span>
                    {v.message}
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="rb-label">
            {t("ui.ruleBook.repairs")} {repairs.length ? t("ui.ruleBook.repairsFound", { count: repairs.length }) : t("ui.ruleBook.repairsNone")}
          </div>
          {repairs.length > 0 && (
            <ul className="rb-list rb-repairs">
              {repairs.map((o) => (
                <li key={`${o.kind}${o.title}`} className={chosenKinds.includes(o.kind) ? "rb-picked" : ""}>
                  <span className="rb-kind">{o.kind}</span>
                  {o.title}
                  <span className="rb-cost">{t("ui.ruleBook.cost", { cost: costText(o.costs) })}</span>
                  {chosenKinds.includes(o.kind) && <span className="rb-picked-tag">{t("ui.ruleBook.picked")}</span>}
                </li>
              ))}
            </ul>
          )}
          {chosen.length > 0 && (
            <div className="rb-chosen">
              <b>{t("ui.ruleBook.recommended")}</b>
              {t("ui.ruleBook.colon")}
              {chosen.map((c) => c.title).join(t("ui.ruleBook.titleSep"))}
              <div className="muted">
                {repairs.length > 1
                  ? t("ui.ruleBook.whyCheapest", { count: repairs.length, cost: costText(repairs.find((o) => chosenKinds.includes(o.kind))?.costs ?? {}) })
                  : t("ui.ruleBook.whyOnly")}
              </div>
            </div>
          )}
          {violations.length > 0 && chosen.length === 0 && (
            <div className="rb-chosen rb-chosen-none">
              <b>{t("ui.ruleBook.noRepair")}</b>
              <div className="muted">{repairs.length ? t("ui.ruleBook.noRepairUnusable") : t("ui.ruleBook.noRepairDeclared")}</div>
            </div>
          )}
          <details className="rb-raw">
            <summary>{t("ui.ruleBook.raw")}</summary>
            <div className="rb-raw-body">
              <dl className="rb-parts">
                {rule.parts.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{typeof v === "string" ? v : expr(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
