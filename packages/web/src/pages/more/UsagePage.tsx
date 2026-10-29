// 消耗页（24 号票）：选一个时间范围，按天、按 agent 汇总 token，秘书单列为系统开销，拉起时没给归属的 agent 单列为未归属；
// 成本 = 用量 × 单价，标明"粗估"：配置里写了单价的按配置（不分时段），没写的按框架自带的价格表、按每一笔的时段算（94 号票），
// 单价那块列出用到的单价（自带价格表的分高峰、空闲），写明高峰时段怎么算、价格取自官网哪天。
// 数据经 HTTP 取（GET /api/usage，DaemonHttp.usage）：页面由守护进程提供时是真账本，直接打开构建产物时是原型的假账本。
// 154 号票：按次计费的联网调用（DeepSeek 的联网搜索、读网页）另起一节"联网搜索、读网页"，按 agent 列次数和花费；
// 上面的成本合计把它算进去（写明"含联网 ¥x"），按天、按 agent 的 token 表照旧只有模型调用。
// 266 号票：按 agent 那张表的系统开销一组里单列"记忆简报"一行（带了几次、估的 token、粗估的钱）：这些 token 已经算在秘书的输入里，
// 不另加进合计。
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
  usagePriceRows,
  usagePricingNotes,
  usageRange,
  type UsageRangePreset,
  type UsageSummary,
  type UsageWebAgentRow,
  t,
  usageWebNotes,
  usageWebTotal,
  WEB_CALL_KIND_LABEL,
} from "../../state/index.ts";
import { Section, Segmented } from "../../ui/common.tsx";
import { AssistantName, NamedText } from "../../ui/assistant-name.tsx";
import { T } from "../../ui/i18n.tsx";

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
  // 联网调用每次 ¥0.005：三位小数才看得出来
  const webMoney = (n: number) => `${currencySymbol(summary?.pricing.currency || "CNY")}${n.toFixed(3)}`;
  const unitPrice = (n: number) => `${currencySymbol(summary?.pricing.currency || "CNY")}${n}`;
  const priceRows = summary ? usagePriceRows(summary.pricing) : [];
  const priceNotes = summary ? usagePricingNotes(summary.pricing) : [];
  const web = summary ? usageWebTotal(summary.web) : { calls: 0, cost: 0 };
  const webNotes = summary ? usageWebNotes(summary.web) : [];
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
        <span className="muted"> · {t("pages.usage.calls", { count: a.calls })}</span>
      </td>
      <td className="num">{tokensLabel(a.tokens.cacheHit)}</td>
      <td className="num">{tokensLabel(a.tokens.cacheMiss)}</td>
      <td className="num">{tokensLabel(a.tokens.output)}</td>
      <td className="num">{money(a.cost)}</td>
    </tr>
  );

  const webRow = (a: UsageWebAgentRow) => (
    <tr key={`${a.agentId}:${a.category}`}>
      <td>
        <NamedText text={usageAgentName(ui, a.agentId, a.role)} />
      </td>
      <td className="num">{a.search.calls}</td>
      <td className="num">{a.fetch.calls}</td>
      <td className="num">{webMoney(a.search.cost + a.fetch.cost)}</td>
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
        options={[...USAGE_RANGE_PRESETS.map((p) => ({ value: p as RangeChoice, label: USAGE_RANGE_PRESET_LABEL[p] })), { value: "custom", label: t("pages.usage.custom") }]}
      />
      {choice === "custom" && (
        <div className="usage-range">
          <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label={t("pages.materials.from")} />
          <span className="muted">{t("pages.materials.to")}</span>
          <input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label={t("pages.materials.until")} />
        </div>
      )}
      {!valid && <div className="hint">{t("pages.materials.badRange")}</div>}
      {valid && result?.key === key && result.error && <div className="hint">{t("pages.usage.loadFailed", { reason: result.error })}</div>}
      {valid && !summary && !result?.error && <div className="muted">{t("pages.usage.calculating")}</div>}
      {summary && (
        <>
          <div className="stat-row">
            <div className="stat">
              <div className="stat-v">{tokensLabel(tokenTotal(summary.total.tokens))}</div>
              <div className="muted">{t("pages.usage.totalTokens", { count: summary.total.calls })}</div>
            </div>
            <div className="stat">
              <div className="stat-v">{money(summary.total.cost + web.cost)}</div>
              <div className="muted">
                {t("pages.usage.cost", { estimate: COST_ESTIMATE_LABEL })}
                {web.cost > 0 && t("pages.usage.costWeb", { amount: webMoney(web.cost) })}
              </div>
            </div>
            <div className="stat">
              <div className="stat-v">{Math.round(cacheHitRate(summary.total.tokens) * 100)}%</div>
              <div className="muted">{t("pages.usage.cacheHitRate")}</div>
            </div>
            <div className="stat">
              <div className="stat-v">{tokensLabel(tokenTotal(summary.system.tokens))}</div>
              <div className="muted">
                <T k="pages.usage.systemOverhead" params={{ label: SYSTEM_OVERHEAD_LABEL, name: <AssistantName /> }} />
              </div>
            </div>
          </div>

          <Section
            title={t("pages.usage.byDay")}
            extra={
              <button type="button" className="link" onClick={() => setTable(!table)}>
                {table ? t("pages.usage.showChart") : t("pages.usage.showTable")}
              </button>
            }
          >
            {summary.days.length === 0 ? (
              <div className="muted">{t("pages.usage.noCalls")}</div>
            ) : table ? (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t("pages.usage.date")}</th>
                    <th className="num">token</th>
                    <th className="num">{t("pages.usage.ofWhich", { label: SYSTEM_OVERHEAD_LABEL })}</th>
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
              <div className="bars" role="img" aria-label={peak ? t("pages.usage.chartPeak", { date: peak.date.slice(5), tokens: tokensLabel(peak.tokens) }) : t("pages.usage.chart")}>
                {byDay.map((d) => (
                  <div key={d.date} className="bar-col" title={t("pages.usage.barTitle", { date: d.date.slice(5), tokens: tokensLabel(d.tokens) })}>
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

          <Section title={t("pages.usage.byAgent")}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("pages.usage.agent")}</th>
                  <th className="num">{t("pages.usage.cacheHit")}</th>
                  <th className="num">{t("pages.usage.cacheMiss")}</th>
                  <th className="num">{t("pages.usage.output")}</th>
                  <th className="num">{COST_ESTIMATE_LABEL}</th>
                </tr>
              </thead>
              <tbody>
                {summary.agents.filter((a) => a.category === "owned").map(agentRow)}
                <tr className="tbl-group">
                  <td colSpan={5}>
                    <T k="pages.usage.systemOverhead" params={{ label: SYSTEM_OVERHEAD_LABEL, name: <AssistantName /> }} /> · {money(summary.system.cost)}
                  </td>
                </tr>
                {summary.agents.filter((a) => a.category === "system").map(agentRow)}
                {/* 266 号票：记忆简报单列一项——估的 token 已经算在秘书的输入里（没命中缓存那一栏），这里另列出来 */}
                <tr className="usage-brief">
                  <td>
                    <span className="usage-brief-name">{t("pages.usage.memoryBrief")}</span>
                    <div className="muted usage-brief-note">
                      <span className="usage-brief-times">{t("pages.usage.memoryBriefTimes", { count: summary.memoryBrief.count })}</span> · <T k="pages.usage.memoryBriefNote" params={{ name: <AssistantName /> }} />
                    </div>
                  </td>
                  <td className="num muted">—</td>
                  <td className="num">{t("pages.usage.memoryBriefTokens", { tokens: tokensLabel(summary.memoryBrief.tokens) })}</td>
                  <td className="num muted">—</td>
                  <td className="num">{money(summary.memoryBrief.cost)}</td>
                </tr>
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
              <T k="pages.usage.costHint" params={{ estimate: COST_ESTIMATE_LABEL, name: <AssistantName />, overhead: SYSTEM_OVERHEAD_LABEL }} />
              {summary.unattributed.calls > 0 && t("pages.usage.unattributedHint", { label: UNATTRIBUTED_LABEL, tokens: tokensLabel(tokenTotal(summary.unattributed.tokens)) })}
            </div>
          </Section>

          <Section title={t("pages.usage.web")}>
            {web.calls === 0 ? (
              <div className="muted">{t("pages.usage.noWeb")}</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t("pages.usage.agent")}</th>
                    <th className="num">{WEB_CALL_KIND_LABEL.search}</th>
                    <th className="num">{WEB_CALL_KIND_LABEL.fetch}</th>
                    <th className="num">{COST_ESTIMATE_LABEL}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.web.agents.map(webRow)}
                  <tr className="tbl-group">
                    <td>{t("pages.usage.total")}</td>
                    <td className="num">{t("pages.usage.times", { count: summary.web.search.calls })}</td>
                    <td className="num">{t("pages.usage.times", { count: summary.web.fetch.calls })}</td>
                    <td className="num">{webMoney(web.cost)}</td>
                  </tr>
                </tbody>
              </table>
            )}
            {webNotes.length > 0 && (
              <div className="hint">
                {webNotes.map((n) => (
                  <div key={n}>{n}</div>
                ))}
              </div>
            )}
          </Section>

          <Section title={t("pages.usage.prices")}>
            {priceRows.length === 0 ? (
              <div className="muted">{t("pages.usage.noPrices")}</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t("pages.usage.model")}</th>
                    <th className="num">{t("pages.usage.cacheHit")}</th>
                    <th className="num">{t("pages.usage.cacheMiss")}</th>
                    <th className="num">{t("pages.usage.output")}</th>
                  </tr>
                </thead>
                <tbody>
                  {priceRows.map((r) => (
                    <tr key={r.key}>
                      <td>
                        {r.model}
                        <span className="muted">
                          {" "}
                          · {r.period}
                          {r.note && ` · ${r.note}`}
                        </span>
                      </td>
                      <td className="num">{unitPrice(r.price.cacheHit)}</td>
                      <td className="num">{unitPrice(r.price.cacheMiss)}</td>
                      <td className="num">{unitPrice(r.price.output)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {priceNotes.length > 0 && (
              <div className="hint">
                {priceNotes.map((n) => (
                  <div key={n}>{n}</div>
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </>
  );
}
