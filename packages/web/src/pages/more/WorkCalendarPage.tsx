// 设置 · 工作日历：按月看，每天标明上班或休息及原因；可以加额外上班规则、点某天改成上班或休息。
import { useState } from "react";
import { type DayInfo, dayInfo, type ExtraRule, firstWeekday, type ManualMark, monthDays, ruleLabel } from "../../prototype/calendar.ts";
import { MONDAY_FIRST, weekdayLabel } from "../../model/labels.ts";
import { useProto } from "../../prototype/proto-store.tsx";
import { Section, Sheet } from "../../ui/common.tsx";

/** 原型只带了 2026 年 9–12 月的节假日数据 */
const MONTHS = [9, 10, 11, 12];

const RULE_TEMPLATES: Omit<ExtraRule, "id">[] = [
  { kind: "last_weekday", weekday: 6 },
  { kind: "nth_weekday", weekday: 6, n: 1 },
  { kind: "every_weekday", weekday: 6 },
  { kind: "every_weekday", weekday: 0 },
];

function shortReason(d: DayInfo): string {
  if (d.manual) return "手动";
  if (d.reason === "新加坡工作日") return d.note ? "新加坡" : "工作日";
  if (d.reason === "国内工作日") return "国内";
  if (d.reason === "调休补班") return "补班";
  if (d.reason.startsWith("额外规则")) return "规则";
  return d.reason.length > 4 ? `${d.reason.slice(0, 4)}…` : d.reason;
}

export function WorkCalendarPage() {
  const { proto, update } = useProto();
  const { rules, marks } = proto.calendar;
  const [month, setMonth] = useState(10);
  const [picked, setPicked] = useState<string>();
  const [tpl, setTpl] = useState(0);
  const setCalendar = (f: (c: typeof proto.calendar) => typeof proto.calendar) => update((s) => ({ ...s, calendar: f(s.calendar) }));
  const days = monthDays(2026, month).map((d) => dayInfo(d, rules, marks));
  // 周一在前
  const lead = (firstWeekday(2026, month) + 6) % 7;
  const pickedInfo = picked ? dayInfo(picked, rules, marks) : undefined;

  const mark = (date: string, m: ManualMark | undefined) =>
    setCalendar((c) => {
      const next = { ...c.marks };
      if (m) next[date] = m;
      else delete next[date];
      return { ...c, marks: next };
    });

  return (
    <>
      <div className="muted">你的上班日 = 新加坡工作日 ∪ 国内工作日（含调休补班）∪ 额外上班规则 ∪ 手动标记的上班日 − 手动标记的休息日。新加坡放假、国内上班的撞日算上班。</div>
      <div className="cal-nav">
        <button type="button" className="icon-btn" disabled={month === MONTHS[0]} onClick={() => setMonth(month - 1)} aria-label="上个月">
          ‹
        </button>
        <b>2026 年 {month} 月</b>
        <button type="button" className="icon-btn" disabled={month === MONTHS.at(-1)} onClick={() => setMonth(month + 1)} aria-label="下个月">
          ›
        </button>
      </div>
      <div className="cal" role="grid" aria-label={`2026 年 ${month} 月`}>
        {MONDAY_FIRST.map((d) => weekdayLabel(d, true)).map((w) => (
          <div key={w} className="cal-wd" role="columnheader">
            {w}
          </div>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <div key={`lead-${i}`} />
        ))}
        {days.map((d) => (
          <button
            key={d.date}
            type="button"
            role="gridcell"
            className={`cal-day ${d.work ? "cal-work" : "cal-rest"}${d.manual ? " cal-manual" : ""}${d.date === "2026-10-07" ? " cal-today" : ""}`}
            title={`${d.date}：${d.work ? "上班" : "休息"} · ${d.reason}${d.note ? `（${d.note}）` : ""}`}
            onClick={() => setPicked(d.date)}
          >
            <span className="cal-n">{d.day}</span>
            <span className="cal-s">{d.work ? "班" : "休"}</span>
            <span className="cal-r">{shortReason(d)}</span>
          </button>
        ))}
      </div>
      <div className="cal-legend muted">
        <span>
          <i className="lg-work" />上班
        </span>
        <span>
          <i className="lg-rest" />休息
        </span>
        <span>
          <i className="lg-manual" />手动标记
        </span>
        <span>原因：工作日（两边都上班）、新加坡、国内、补班（调休补班）、规则（额外规则）、手动</span>
      </div>

      <Section title="额外上班规则">
        {rules.length === 0 && <div className="muted">没有</div>}
        {rules.map((r) => (
          <div key={r.id} className="rule-item">
            <span>{ruleLabel(r)}</span>
            <button type="button" className="link danger-text" onClick={() => setCalendar((c) => ({ ...c, rules: c.rules.filter((x) => x.id !== r.id) }))}>
              删除
            </button>
          </div>
        ))}
        <div className="add-row">
          <select className="input" value={tpl} onChange={(e) => setTpl(Number(e.target.value))} aria-label="选一条规则">
            {RULE_TEMPLATES.map((t, i) => (
              <option key={i} value={i}>
                {ruleLabel({ ...t, id: "" })}
              </option>
            ))}
          </select>
          <button type="button" className="btn primary small" onClick={() => setCalendar((c) => ({ ...c, rules: [...c.rules, { ...RULE_TEMPLATES[tpl]!, id: `rule-${Date.now()}` }] }))}>
            加上
          </button>
        </div>
        <div className="hint">也可以对秘书说"下周一我不上班"，它出一张快速动作卡，确认后改这里。</div>
      </Section>
      <div className="hint">节假日数据是框架自带的公开数据（新加坡人力部、中国政府网）。原型只带了 2026 年 9–12 月；国内 2027 年的安排还没公布，每年 12 月会检查一次，缺了在待我处理里提醒你。</div>

      {pickedInfo && (
        <Sheet title={pickedInfo.date} onClose={() => setPicked(undefined)} center>
          <div className="modal-body">
            <p>
              <b>{pickedInfo.work ? "上班" : "休息"}</b> · {pickedInfo.reason}
              {pickedInfo.note && <span className="muted">（{pickedInfo.note}）</span>}
            </p>
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => (mark(pickedInfo.date, "work"), setPicked(undefined))}>
              标为上班
            </button>
            <button type="button" className="btn ghost" onClick={() => (mark(pickedInfo.date, "rest"), setPicked(undefined))}>
              标为休息
            </button>
            {pickedInfo.manual && (
              <button type="button" className="btn ghost" onClick={() => (mark(pickedInfo.date, undefined), setPicked(undefined))}>
                清除手动标记
              </button>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}
