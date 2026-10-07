// 设置 · 工作日历（29 号票）：按月看，每天标明上班或休息及原因；可以加删额外上班规则、点某天改成上班或休息、清掉标记。
// 每天的结果由前端状态层里的节假日数据和个人设置算出（和守护进程同一个纯函数）；改个人设置走 HTTP，
// 守护进程改完在工作日历频道上推一条事件，打开着的页面（别的设备上的也一样）跟着变。
import { useMemo, useState } from "react";
import { useStore } from "../../app/store.tsx";
import { MONDAY_FIRST, weekdayLabel } from "../../model/labels.ts";
import {
  DAY_SHORT_LABEL_LEGEND,
  type DayMarkKind,
  dayReasonLabel,
  dayShortLabel,
  describeExtraRule,
  type ExtraWorkdayRule,
  HOLIDAY_REGION_LABEL,
  isManualDay,
  localDate,
  missingHolidayDataText,
  type WorkdayChange,
  workdayCalendarOf,
  workdaySettingsOf,
} from "../../state/index.ts";
import { Section, Sheet } from "../../ui/common.tsx";
import { useToast } from "../../ui/toast.tsx";

const ORDINALS = ["第一个", "第二个", "第三个", "第四个", "第五个"];

/** 加规则的下拉：写法和周几 */
type RuleKind = ExtraWorkdayRule["kind"];

function ruleFrom(kind: RuleKind, n: number, weekday: number): ExtraWorkdayRule {
  return kind === "nth_weekday" ? { kind, n, weekday } : { kind, weekday };
}

export function WorkCalendarPage() {
  const { ui, http } = useStore();
  const toast = useToast();
  const calendar = useMemo(() => workdayCalendarOf(ui), [ui]);
  const settings = workdaySettingsOf(ui);
  const [today] = useState(() => localDate(new Date()));
  const [ym, setYm] = useState(() => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }));
  const [picked, setPicked] = useState<string>();
  const [ruleKind, setRuleKind] = useState<RuleKind>("last_weekday");
  const [ruleN, setRuleN] = useState(1);
  const [ruleWeekday, setRuleWeekday] = useState(6);

  if (!calendar) return <div className="muted">正在读取工作日历…</div>;

  const days = calendar.month(ym.year, ym.month);
  const missing = calendar.missing(ym.year);
  // 周一在前
  const lead = (days[0]!.weekday + 6) % 7;
  const pickedDay = picked ? calendar.day(picked) : undefined;
  const shift = (delta: number) => {
    const m = ym.month - 1 + delta;
    setYm({ year: ym.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 + 1 });
  };
  const change = (c: WorkdayChange) => {
    http.changeWorkday(c).catch((err: unknown) => toast(`没改成：${err instanceof Error ? err.message : String(err)}`));
  };
  const mark = (date: string, m: DayMarkKind | undefined) => {
    change(m ? { kind: "mark", date, mark: m } : { kind: "clear_mark", date });
    setPicked(undefined);
  };
  return (
    <>
      <div className="muted">你的上班日 = 新加坡工作日 ∪ 国内工作日（含调休补班）∪ 额外上班规则 ∪ 手动标记的上班日 − 手动标记的休息日。新加坡放假、国内上班的撞日算上班。</div>
      <div className="cal-nav">
        <button type="button" className="icon-btn" onClick={() => shift(-1)} aria-label="上个月">
          ‹
        </button>
        <b>
          {ym.year} 年 {ym.month} 月
        </b>
        <button type="button" className="icon-btn" onClick={() => shift(1)} aria-label="下个月">
          ›
        </button>
      </div>
      {missing.length > 0 && <div className="hint">{missingHolidayDataText(ym.year, missing)}：这一年{missing.map((r) => HOLIDAY_REGION_LABEL[r]).join("、")}那边先按周一到周五算（没有调休补班）。</div>}
      <div className="cal" role="grid" aria-label={`${ym.year} 年 ${ym.month} 月`}>
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
            className={`cal-day ${d.workday ? "cal-work" : "cal-rest"}${isManualDay(d) ? " cal-manual" : ""}${d.date === today ? " cal-today" : ""}`}
            title={`${d.date}：${d.workday ? "上班" : "休息"} · ${d.reasons.map(dayReasonLabel).join("、")}`}
            onClick={() => setPicked(d.date)}
          >
            <span className="cal-n">{Number(d.date.slice(8))}</span>
            <span className="cal-s">{d.workday ? "班" : "休"}</span>
            <span className="cal-r">{dayShortLabel(d)}</span>
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
        <span>{DAY_SHORT_LABEL_LEGEND}</span>
      </div>

      <Section title="额外上班规则">
        {settings.rules.length === 0 && <div className="muted">没有</div>}
        {settings.rules.map((r) => (
          <div key={describeExtraRule(r)} className="rule-item">
            <span>{describeExtraRule(r)}</span>
            <button type="button" className="link danger-text" onClick={() => change({ kind: "remove_rule", rule: r })}>
              删除
            </button>
          </div>
        ))}
        <div className="add-row">
          <select className="input" value={ruleKind} onChange={(e) => setRuleKind(e.target.value as RuleKind)} aria-label="规则的写法">
            <option value="weekly">每周</option>
            <option value="nth_weekday">每月第几个</option>
            <option value="last_weekday">每月最后一个</option>
          </select>
          {ruleKind === "nth_weekday" && (
            <select className="input" value={ruleN} onChange={(e) => setRuleN(Number(e.target.value))} aria-label="第几个">
              {ORDINALS.map((label, i) => (
                <option key={label} value={i + 1}>
                  {label}
                </option>
              ))}
            </select>
          )}
          <select className="input" value={ruleWeekday} onChange={(e) => setRuleWeekday(Number(e.target.value))} aria-label="周几">
            {MONDAY_FIRST.map((d) => (
              <option key={d} value={d}>
                {weekdayLabel(d)}
              </option>
            ))}
          </select>
          <button type="button" className="btn primary small" onClick={() => change({ kind: "add_rule", rule: ruleFrom(ruleKind, ruleN, ruleWeekday) })}>
            加上
          </button>
        </div>
        <div className="hint">也可以对秘书说"下周一我不上班"，它出一张快速动作卡，确认后改这里。</div>
      </Section>
      <div className="hint">
        节假日数据是框架自带的公开数据（新加坡人力部、中国政府网）。每年 12 月检查一次下一年的数据，缺了在待我处理里提醒你，点一下发起联网任务去更新。
      </div>

      {pickedDay && (
        <Sheet title={pickedDay.date} onClose={() => setPicked(undefined)} center>
          <div className="modal-body">
            <p>
              <b>{pickedDay.workday ? "上班" : "休息"}</b> · {pickedDay.reasons.map(dayReasonLabel).join("、")}
            </p>
            {pickedDay.holidays.map((h) => (
              <p key={h.region} className="muted">
                {HOLIDAY_REGION_LABEL[h.region]}：{h.name}
              </p>
            ))}
            {pickedDay.missing.length > 0 && <p className="muted">{missingHolidayDataText(Number(pickedDay.date.slice(0, 4)), pickedDay.missing)}</p>}
          </div>
          <div className="auth-actions">
            <button type="button" className="btn ghost" onClick={() => mark(pickedDay.date, "work")}>
              标为上班
            </button>
            <button type="button" className="btn ghost" onClick={() => mark(pickedDay.date, "rest")}>
              标为休息
            </button>
            {isManualDay(pickedDay) && (
              <button type="button" className="btn ghost" onClick={() => mark(pickedDay.date, undefined)}>
                清除手动标记
              </button>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}
