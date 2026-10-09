// 消耗页（24 号票）：选一个时间范围，按天、按 agent 汇总 token，秘书单列为系统开销，拉起时没给归属的 agent 单列为未归属；
// 成本 = 用量 × 配置里的单价，标明"粗估"。
// 数据经 HTTP 取（GET /api/usage，DaemonHttp.usage）：页面由守护进程提供时是真账本，直接打开构建产物时是原型的假账本。
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { tokensLabel } from "../../model/labels.ts";
import {
  cacheHitRate,
  COST_ESTIMATE_LABEL,
  currencySymbol,
  rangeDays,
  SYSTEM_OVERHEAD_LABEL,
  tokenTotal,
  UNATTRIBUTED_LABEL,
  USAGE_RANGE_PRESET_LABEL,
  USAGE_RANGE_PRESETS,
  type UsageAgentRow,
  usageAgentName,
  usageRange,
  type UsageRangePreset,
  type UsageSummary,
} from "../../state/index.ts";
import { Section, Segmented } from "../../ui/common.tsx";
import { AssistantName, NamedText } from "../../ui/assistant-name.tsx";

type RangeChoice = UsageRangePreset | "custom";

export function UsagePage() {
  const { http, ui } = useStore();
  // 打开页面的这一刻：快捷范围（今天、近 7 天……）按它算
  const [now] = useState(() => new Date());
  const [choice, setChoice] = useState<RangeChoice>("7d");
  const [custom, setCustom] = useState(() => usageRange("7d", now));
  const [table, setTable] = useState(false);
  const [result, setResult] = useState<{ key: string; summary?: UsageSummary; error?: string }>();
  const range = choice === "custom" ? custom : usageRange(choice, now);
  const key = `${range.from}~${range.to}`;
  const valid = range.from !== "" && range.to !== "" && range.from <= range.to;

  useEffect(() => {
    if (!valid) return;
    let alive = true;
    http.usage({ from: range.from, to: range.to }).then(
      (summary) => alive && setResult({ key, summary }),
      (err: unknown) => alive && setResult({ key, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      alive = false;
    };
  }, [http, key, valid, range.from, range.to]);

  const summary = result?.key === key ? result.summary : undefined;
  const money = (n: number) => `${currencySymbol(summary?.pricing.currency || "CNY")}${n.toFixed(2)}`;
  const byDay = useMemo(() => {
    if (!summary || !valid) return [];
    const days = new Map(summary.days.map((d) => [d.date, d]));
    return rangeDays(range.from, range.to).map((date) => ({ date, tokens: tokenTotal(days.get(date)?.total.tokens ?? { cacheHit: 0, cacheMiss: 0, output: 0 }), cost: days.get(date)?.total.cost ?? 0 }));
  }, [summary, valid, range.from, range.to]);
  const max = Math.max(...byDay.map((d) => d.tokens), 1);
  const peak = byDay.reduce<(typeof byDay)[number] | undefined>((a, d) => (a === undefined || d.tokens > a.tokens ? d : a), undefined);

  const agentRow = (a: UsageAgentRow) => (
    <tr key={`${a.agentId}:${a.category}`}>
      <td>
        <NamedText text={usageAgentName(ui, a.agentId, a.role)} />
        <span className="muted"> · {a.calls} 次调用</span>
      </td>
      <td className="num">{tokensLabel(a.tokens.cacheHit)}</td>
      <td className="num">{tokensLabel(a.tokens.cacheMiss)}</td>
      <td className="num">{tokensLabel(a.tokens.output)}</td>
      <td className="num">{money(a.cost)}</td>
    </tr>
  );

  return (
    <>
      <Segmented<RangeChoice>
        value={choice}
        onChange={(v) => {
          if (v === "custom" && choice !== "custom") setCustom(range);
          setChoice(v);
        }}
        options={[...USAGE_RANGE_PRESETS.map((p) => ({ value: p as RangeChoice, label: USAGE_RANGE_PRESET_LABEL[p] })), { value: "custom", label: "自选" }]}
      />
      {choice === "custom" && (
        <div className="usage-range">
          <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="从哪天起" />
          <span className="muted">到</span>
          <input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="到哪天" />
        </div>
      )}
      {!valid && <div className="hint">起点要在终点之前</div>}
      {valid && result?.key === key && result.error && <div className="hint">取不到消耗的数据：{result.error}</div>}
      {valid && !summary && !result?.error && <div className="muted">正在算……</div>}
      {summary && (
        <>
          <div className="stat-row">
            <div className="stat">
              <div className="stat-v">{tokensLabel(tokenTotal(summary.total.tokens))}</div>
              <div className="muted">token 合计 · {summary.total.calls} 次调用</div>
            </div>
            <div className="stat">
              <div className="stat-v">{money(summary.total.cost)}</div>
              <div className="muted">成本（{COST_ESTIMATE_LABEL}）</div>
            </div>
            <div className="stat">
              <div className="stat-v">{Math.round(cacheHitRate(summary.total.tokens) * 100)}%</div>
              <div className="muted">输入缓存命中</div>
            </div>
            <div className="stat">
              <div className="stat-v">{tokensLabel(tokenTotal(summary.system.tokens))}</div>
              <div className="muted">
                {SYSTEM_OVERHEAD_LABEL}（<AssistantName />）
              </div>
            </div>
          </div>

          <Section
            title="按天（token）"
            extra={
              <button type="button" className="link" onClick={() => setTable(!table)}>
                {table ? "看图" : "看表格"}
              </button>
            }
          >
            {summary.days.length === 0 ? (
              <div className="muted">这段时间没有模型调用</div>
            ) : table ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th className="num">token</th>
                    <th className="num">其中{SYSTEM_OVERHEAD_LABEL}</th>
                    <th className="num">{COST_ESTIMATE_LABEL}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.days.map((d) => (
                    <tr key={d.date}>
                      <td>{d.date.slice(5)}</td>
                      <td className="num">{tokensLabel(tokenTotal(d.total.tokens))}</td>
                      <td className="num">{tokensLabel(tokenTotal(d.system.tokens))}</td>
                      <td className="num">{money(d.total.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="bars" role="img" aria-label={peak ? `按天的 token 用量，最高 ${peak.date.slice(5)} ${tokensLabel(peak.tokens)}` : "按天的 token 用量"}>
                {byDay.map((d) => (
                  <div key={d.date} className="bar-col" title={`${d.date.slice(5)}：${tokensLabel(d.tokens)} token`}>
                    <div className="bar-track">
                      {(d === peak || d === byDay.at(-1)) && d.tokens > 0 && <span className="bar-label">{tokensLabel(d.tokens)}</span>}
                      <div className="bar" style={{ height: `${(d.tokens / max) * 100}%` }} />
                    </div>
                    <span className="bar-x">{byDay.length > 10 ? (Number(d.date.slice(8)) % 5 === 0 ? d.date.slice(8) : "") : d.date.slice(5)}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="按 agent">
            <table className="tbl">
              <thead>
                <tr>
                  <th>agent</th>
                  <th className="num">缓存命中</th>
                  <th className="num">未命中</th>
                  <th className="num">输出</th>
                  <th className="num">{COST_ESTIMATE_LABEL}</th>
                </tr>
              </thead>
              <tbody>
                {summary.agents.filter((a) => a.category === "owned").map(agentRow)}
                <tr className="tbl-group">
                  <td colSpan={5}>
                    {SYSTEM_OVERHEAD_LABEL}（<AssistantName />） · {money(summary.system.cost)}
                  </td>
                </tr>
                {summary.agents.filter((a) => a.category === "system").map(agentRow)}
                {summary.unattributed.calls > 0 && (
                  <>
                    <tr className="tbl-group">
                      <td colSpan={5}>
                        {UNATTRIBUTED_LABEL} · {money(summary.unattributed.cost)}
                      </td>
                    </tr>
                    {summary.agents.filter((a) => a.category === "unattributed").map(agentRow)}
                  </>
                )}
              </tbody>
            </table>
            <div className="hint">
              {COST_ESTIMATE_LABEL}：用量乘配置里的单价（
              {summary.pricing.prices.length === 0
                ? "这段时间用到的模型都没配单价"
                : summary.pricing.prices.map((p) => `${p.model}：缓存命中 ${p.cacheHit}、未命中 ${p.cacheMiss}、输出 ${p.output}`).join("；")}
              ，每百万 token），不按时段计价。
              <AssistantName />
              的用量单列为{SYSTEM_OVERHEAD_LABEL}；范围审视、压缩的用量记在对应维护者所在的任务或项目名下；定时作业的记在作业名下。
              {summary.unattributed.calls > 0 && ` 有 agent 拉起时没给归属，它们的用量单列为${UNATTRIBUTED_LABEL}（${tokensLabel(tokenTotal(summary.unattributed.tokens))} token）。`}
              {summary.pricing.unpriced.length > 0 && ` 没配单价、没算进成本的模型：${summary.pricing.unpriced.join("、")}。`}
              {summary.pricing.problem && ` 配置里的单价读不出来（成本按 0）：${summary.pricing.problem}`}
            </div>
          </Section>
        </>
      )}
    </>
  );
}
