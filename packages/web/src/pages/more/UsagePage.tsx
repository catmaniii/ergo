// 消耗页：按天、按 agent 汇总 token，秘书单列为系统开销；选一个时间范围，用量乘配置里的单价得粗估成本。
import { useState } from "react";
import { tokensLabel } from "../../model/labels.ts";
import type { UsageRecord } from "../../model/types.ts";
import { FAKE_PRICES, FAKE_USAGE } from "../../prototype/fake-data.ts";
import { Section, Segmented } from "../../ui/common.tsx";

type Range = "1" | "7" | "30";

const total = (r: UsageRecord) => r.inputCached + r.inputUncached + r.output;
const cost = (r: Pick<UsageRecord, "inputCached" | "inputUncached" | "output">) =>
  (r.inputCached * FAKE_PRICES.inputCached + r.inputUncached * FAKE_PRICES.inputUncached + r.output * FAKE_PRICES.output) / 1_000_000;

function sum(rs: UsageRecord[]) {
  return rs.reduce((a, r) => ({ inputCached: a.inputCached + r.inputCached, inputUncached: a.inputUncached + r.inputUncached, output: a.output + r.output }), { inputCached: 0, inputUncached: 0, output: 0 });
}

export function UsagePage() {
  const [range, setRange] = useState<Range>("7");
  const [table, setTable] = useState(false);
  const days = [...new Set(FAKE_USAGE.map((r) => r.day))].slice(-Number(range));
  const rows = FAKE_USAGE.filter((r) => days.includes(r.day));
  const byDay = days.map((d) => ({ day: d, tokens: rows.filter((r) => r.day === d).reduce((a, r) => a + total(r), 0) }));
  const max = Math.max(...byDay.map((d) => d.tokens), 1);
  const agents = [...new Set(rows.map((r) => r.agent))];
  const byAgent = agents.map((a) => {
    const rs = rows.filter((r) => r.agent === a);
    const s = sum(rs);
    return { agent: a, system: rs[0]?.system, ...s, total: s.inputCached + s.inputUncached + s.output, cost: cost(s) };
  });
  const all = sum(rows);
  const allTotal = all.inputCached + all.inputUncached + all.output;
  const peak = byDay.reduce((a, d) => (d.tokens > a.tokens ? d : a), byDay[0]!);

  return (
    <>
      <Segmented<Range>
        value={range}
        onChange={setRange}
        options={[
          { value: "1", label: "今天" },
          { value: "7", label: "近 7 天" },
          { value: "30", label: "近 30 天" },
        ]}
      />
      <div className="stat-row">
        <div className="stat">
          <div className="stat-v">{tokensLabel(allTotal)}</div>
          <div className="muted">token 合计</div>
        </div>
        <div className="stat">
          <div className="stat-v">¥{cost(all).toFixed(2)}</div>
          <div className="muted">粗估成本</div>
        </div>
        <div className="stat">
          <div className="stat-v">{Math.round((all.inputCached / Math.max(1, all.inputCached + all.inputUncached)) * 100)}%</div>
          <div className="muted">输入缓存命中</div>
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
        {table ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>日期</th>
                <th className="num">token</th>
              </tr>
            </thead>
            <tbody>
              {byDay.map((d) => (
                <tr key={d.day}>
                  <td>{d.day.slice(5)}</td>
                  <td className="num">{tokensLabel(d.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="bars" role="img" aria-label={`按天的 token 用量，最高 ${peak.day.slice(5)} ${tokensLabel(peak.tokens)}`}>
            {byDay.map((d) => (
              <div key={d.day} className="bar-col" title={`${d.day.slice(5)}：${tokensLabel(d.tokens)} token`}>
                <div className="bar-track">
                  {(d === peak || d === byDay.at(-1)) && <span className="bar-label">{tokensLabel(d.tokens)}</span>}
                  <div className="bar" style={{ height: `${(d.tokens / max) * 100}%` }} />
                </div>
                <span className="bar-x">{byDay.length > 10 ? (Number(d.day.slice(8)) % 5 === 0 ? d.day.slice(8) : "") : d.day.slice(5)}</span>
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
              <th className="num">粗估</th>
            </tr>
          </thead>
          <tbody>
            {byAgent
              .filter((a) => !a.system)
              .map((a) => (
                <tr key={a.agent}>
                  <td>{a.agent}</td>
                  <td className="num">{tokensLabel(a.inputCached)}</td>
                  <td className="num">{tokensLabel(a.inputUncached)}</td>
                  <td className="num">{tokensLabel(a.output)}</td>
                  <td className="num">¥{a.cost.toFixed(2)}</td>
                </tr>
              ))}
            <tr className="tbl-group">
              <td colSpan={5}>系统开销</td>
            </tr>
            {byAgent
              .filter((a) => a.system)
              .map((a) => (
                <tr key={a.agent}>
                  <td>{a.agent}</td>
                  <td className="num">{tokensLabel(a.inputCached)}</td>
                  <td className="num">{tokensLabel(a.inputUncached)}</td>
                  <td className="num">{tokensLabel(a.output)}</td>
                  <td className="num">¥{a.cost.toFixed(2)}</td>
                </tr>
              ))}
          </tbody>
        </table>
        <div className="hint">
          粗估：用量乘配置里的单价（缓存命中 {FAKE_PRICES.inputCached}、未命中 {FAKE_PRICES.inputUncached}、输出 {FAKE_PRICES.output} 元 / 百万 token，原型里是示例值），不按时段计价。范围审视的用量记在对应维护者名下。
        </div>
      </Section>
    </>
  );
}
