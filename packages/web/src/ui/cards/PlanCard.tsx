/**
 * 计划确认卡（规格第 8 节）：
 * - 一个"确认"按钮；可逐行勾掉或收窄授权，可附意见打回；
 * - 逐行列出涉及的项目和改动；
 * - 本任务要提醒的关注类别：默认取全局（删不掉），只能加；
 * - 列出由对话里说的限制编译出的时序规则或授权收窄；
 * - 预告"授权后还会在 N 处停下来"和 token 粗估；
 * - 细节（阶段、验收、工具包、假设）默认折叠。
 */
import { useState } from "react";
import type { PlanPayload } from "../../model/cards.ts";
import { tokensLabel } from "../../model/labels.ts";
import { type CardProps, CardShell } from "./CardShell.tsx";
import { toolkitLabel } from "./cards.tsx";

const METHOD_LABEL = { script: "脚本", review: "评审", user: "由你验收" } as const;

export function PlanCard({ view, payload: p, done, act }: CardProps<PlanPayload>) {
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [narrowed, setNarrowed] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState<string[]>([]);
  const [details, setDetails] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");

  const stageNo = (id: string) => p.stages.findIndex((s) => s.id === id) + 1;
  const confirmNote = () => {
    const bits = [];
    if (unchecked.size) bits.push(`勾掉 ${unchecked.size} 项授权`);
    const n = Object.values(narrowed).filter(Boolean).length;
    if (n) bits.push(`收窄 ${n} 项`);
    if (extra.length) bits.push(`加了关注类别：${extra.join("、")}`);
    return bits.join("，") || undefined;
  };

  return (
    <CardShell
      view={view}
      title={p.task}
      actions={
        rejecting ? (
          <div className="plan-reject">
            <textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="写下要改的地方，交回给起草计划的维护者" rows={3} />
            <div className="auth-actions">
              <button type="button" className="btn ghost" onClick={() => setRejecting(false)}>
                算了
              </button>
              <button type="button" className="btn danger" disabled={!comment.trim()} onClick={() => act("reject", comment.trim())}>
                打回
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" className="btn ghost" onClick={() => setRejecting(true)}>
              附意见打回
            </button>
            <button type="button" className="btn primary" onClick={() => act("confirm", confirmNote())}>
              确认
            </button>
          </>
        )
      }
    >
      <div className="plan-goal">{p.goal}</div>
      <div className="plan-sum">
        <span>{p.stages.length} 个阶段</span>
        <span className="look-tail-you">授权后还会在 {p.stops} 处停下来</span>
        <span>约 {tokensLabel(p.tokenEstimate)} token（粗估）</span>
      </div>

      <div className="plan-sec">
        <div className="plan-sec-h">涉及的项目和改动</div>
        {p.projects.length === 0 && <div className="muted">不涉及项目</div>}
        {p.projects.map((pr) => (
          <div key={pr.name} className="plan-proj">
            <b>{pr.name}</b>
            <ul className="plain-list">
              {pr.changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <fieldset className="plan-sec" disabled={done}>
        <legend className="plan-sec-h">授权（可以勾掉或收窄）</legend>
        {p.grants.map((g) => {
          const off = unchecked.has(g.id);
          return (
            <div key={g.id} className={`grant-row${off ? " grant-off" : ""}`}>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={!off}
                  onChange={() => {
                    const next = new Set(unchecked);
                    if (off) next.delete(g.id);
                    else next.add(g.id);
                    setUnchecked(next);
                  }}
                />
                <span>
                  <span className="grant-text">{narrowed[g.id] ? `${g.text} → ${narrowed[g.id]}` : g.text}</span>
                  <span className="muted"> · 第 {stageNo(g.stage)} 阶段</span>
                </span>
              </label>
              {g.narrowTo && !off && (
                <select className="input grant-narrow" value={narrowed[g.id] ?? ""} onChange={(e) => setNarrowed({ ...narrowed, [g.id]: e.target.value })} aria-label="收窄这项授权">
                  <option value="">不收窄</option>
                  {g.narrowTo.map((n) => (
                    <option key={n} value={n}>
                      收窄：{n}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
        <div className="muted">没勾的操作，执行到那一步再问你。</div>
      </fieldset>

      <fieldset className="plan-sec" disabled={done}>
        <legend className="plan-sec-h">本任务要提醒的关注类别</legend>
        <div className="chips">
          {p.globalCategories.map((c) => (
            <span key={c} className="chip chip-locked" title="全局设置里的，删不掉">
              {c}
            </span>
          ))}
          {extra.map((c) => (
            <button key={c} type="button" className="chip chip-op chip-x" onClick={() => setExtra(extra.filter((x) => x !== c))} aria-label={`去掉 ${c}`}>
              {c} ×
            </button>
          ))}
          {p.addableCategories.some((c) => !extra.includes(c)) && (
            <select className="input chip-add" value="" onChange={(e) => e.target.value && setExtra([...extra, e.target.value])} aria-label="加一个关注类别">
              <option value="">＋ 加一个</option>
              {p.addableCategories
                .filter((c) => !extra.includes(c))
                .map((c) => (
                  <option key={c}>{c}</option>
                ))}
            </select>
          )}
        </div>
        <div className="muted">默认取全局，只能加不能删；想少停几次，就在上面给对应操作预先授权（只对"计划里列了才做"那一档有效）。</div>
      </fieldset>

      {p.compiledRules.length > 0 && (
        <div className="plan-sec">
          <div className="plan-sec-h">从你说过的话编出来的规则</div>
          {p.compiledRules.map((r) => (
            <div key={r.text} className="rule-row">
              <div>{r.text}</div>
              <div className="muted">{r.from}</div>
            </div>
          ))}
        </div>
      )}

      <button type="button" className="link" onClick={() => setDetails(!details)} aria-expanded={details}>
        {details ? "收起细节 ▾" : "细节：阶段、验收、工具包、假设 ▸"}
      </button>
      {details && (
        <div className="plan-details fx-open">
          {p.stages.map((s, i) => (
            <div key={s.id} className="plan-stage">
              <div>
                <b>
                  第 {i + 1} 阶段 · {s.title}
                </b>
                <span className="muted">
                  {" "}
                  · {s.mode === "steps" ? "定步" : "开放"}
                  {s.after.length ? ` · 在第 ${s.after.map(stageNo).join("、")} 阶段之后` : ""} · 预算 {tokensLabel(s.budgetTokens)} token
                </span>
              </div>
              <div className="muted">交付：{s.deliverable}</div>
              <ul className="plain-list">
                {s.acceptance.map((a) => (
                  <li key={a.text}>
                    验收（{METHOD_LABEL[a.method]}）：{a.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="plan-stage">
            <b>工具包</b>
            <div className="muted">{toolkitLabel(p.toolkit)}</div>
          </div>
          <div className="plan-stage">
            <b>假设</b>
            <ul className="plain-list">
              {p.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </CardShell>
  );
}
