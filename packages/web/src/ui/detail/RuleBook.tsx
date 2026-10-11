/**
 * 检测项全览（60 号票）：照搬 AgentSense web/src/ui/RuleBook.tsx（D:\code\claudecode\user_agent_sense_of_security，bedf5a5）——
 * 这次审查一共用了哪些规则、每条的形式化写法是什么、本次审查在它上面查到了什么、它声明了几种修法、最后为什么选了那一种。
 * 结构、类名、文案照原样；"接口"那一行照 formal.tsx 的 ApiLine。
 * 规则原文从审查结果里带着的那一份取（WorkflowReview.docs：守护进程审查真正用的，v1 模板加计划里写的，没写修补方案的已补上；
 * AgentSense 取场景的规则文档），判定结果从本次审查结果里取，两边用规则 id 对上；数据由状态层的 ruleBook 给（state/workflow-view.ts）。
 * 二狗多的：违反后有三种（直接拦下、按规则退回、当场确认；AgentSense 写"直接拦截"）；规则来自框架还是计划，写在生效阶段那一行。
 */
import { useState } from "react";
import { costText, expr, RULE_BOOK_STATUS_TEXT, type RuleBookRule, ruleBook, type WorkflowReview, WORKFLOW_CONDITION_SOURCE_LABEL } from "../../state/index.ts";

export function RuleBook({ review }: { review: WorkflowReview }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const book = ruleBook(review);
  if (!book) return null;
  return (
    <section className="dt-section">
      <h4>
        检测项全览
        <button type="button" className="link rb-toggle" onClick={() => setOpen(!open)}>
          {open ? "收起" : `展开 ${book.rules.length} 条 ›`}
        </button>
      </h4>
      {open && (
        <>
          {book.phases && (
            <div className="rb-phases">
              <div className="rb-obj-title">这次检查的时间都花在哪</div>
              <table className="vv-table">
                <thead>
                  <tr>
                    <th>阶段</th>
                    <th>做了什么</th>
                    <th>耗时</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>取事实</td>
                    {/* AgentSense 原文"从当前世界读出文件 / 联系人 / 订单等环境事实"：二狗是真实环境、没有联系人和订单，换成 git 状态 */}
                    <td>从当前环境读出文件 / git 状态等环境事实</td>
                    <td>{book.phases.facts}ms</td>
                  </tr>
                  <tr>
                    <td>编译规则</td>
                    <td>解析规则文档、把事实转成判定用的形式</td>
                    <td>{book.phases.compile}ms</td>
                  </tr>
                  <tr>
                    <td>扫描 + 求解</td>
                    <td>逐条规则比对计划，并在修复方案里穷举出代价最小的一组</td>
                    <td>{book.phases.solve}ms</td>
                  </tr>
                  <tr>
                    <td>逐条复测</td>
                    <td>每条规则单独再跑一次，拿到下面这张表的单条耗时</td>
                    <td>{book.phases.probe}ms</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <div className="rb-objective">
            <div className="rb-obj-title">修复方案怎么挑</div>
            <ol>
              {book.objective.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ol>
            <div className="muted">同一处问题往往有多种修法，引擎按上面的顺序逐层比较，选出整体代价最小、又不破坏目标的一组。</div>
          </div>
          {book.rules.map((rule) => (
            <RuleRow key={rule.id} rule={rule} open={!!expanded[rule.id]} onToggle={() => setExpanded((e) => ({ ...e, [rule.id]: !e[rule.id] }))} />
          ))}
        </>
      )}
    </section>
  );
}

function RuleRow({ rule, open, onToggle }: { rule: RuleBookRule; open: boolean; onToggle(): void }) {
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
            生效阶段 {rule.modes}· 违反后{rule.onViolation}
            {probe && ` · 本次单独跑 ${probe.ms}ms，查出 ${probe.violated} 处违规、${probe.unknown} 处判不了`}
            {probe?.error && ` · 复测出错：${probe.error}`}
          </div>
          <div className="rb-label">形式化（只看过去的时序逻辑）</div>
          <pre className="rb-formula">{rule.formula.formula}</pre>
          <code className="fm-api">
            <span className="fm-api-k">接口</span>
            {rule.api}
          </code>
          <div className="muted rb-legend">G = 任何时候都成立{rule.formula.past ? "；O = 过去曾经发生过" : ""}</div>

          {violations.length > 0 && (
            <>
              <div className="rb-label">本次查到</div>
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
              <div className="rb-label">本次判不了（推迟到执行时）</div>
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

          <div className="rb-label">可选的修复方案 {repairs.length ? `（找到 ${repairs.length} 种）` : "（0 种，只能拦或问）"}</div>
          {repairs.length > 0 && (
            <ul className="rb-list rb-repairs">
              {repairs.map((o) => (
                <li key={`${o.kind}${o.title}`} className={chosenKinds.includes(o.kind) ? "rb-picked" : ""}>
                  <span className="rb-kind">{o.kind}</span>
                  {o.title}
                  <span className="rb-cost">代价：{costText(o.costs)}</span>
                  {chosenKinds.includes(o.kind) && <span className="rb-picked-tag">已采用</span>}
                </li>
              ))}
            </ul>
          )}
          {chosen.length > 0 && (
            <div className="rb-chosen">
              <b>推荐给你的是</b>：{chosen.map((c) => c.title).join("；")}
              <div className="muted">
                {repairs.length > 1
                  ? `理由：这 ${repairs.length} 种修法里，它的代价最小（${costText(repairs.find((o) => chosenKinds.includes(o.kind))?.costs ?? {})}），并且选它之后目标仍然达得成。`
                  : "理由：这条规则只声明了这一种修法。"}
              </div>
            </div>
          )}
          {violations.length > 0 && chosen.length === 0 && (
            <div className="rb-chosen rb-chosen-none">
              <b>没有给出修复方案</b>
              <div className="muted">{repairs.length ? "声明的修法在这次的约束下都用不上，只能交给你判断。" : "这条规则本来就没声明修法，只能拦下或当场问你。"}</div>
            </div>
          )}
          <details className="rb-raw">
            <summary>规则原文</summary>
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
