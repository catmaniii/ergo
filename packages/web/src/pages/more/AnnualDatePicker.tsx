// 449：生日、纪念日的选择器（个人档案页里"改""填写"这几类字段时换掉文本框）：公历 / 农历切换；年（第一项"不记得哪年"，
// 往下是今年到 1900 年）、月、日三个下拉；公历的日按年月限（2 月 29 日只在闰年或"不记得哪年"时有），农历的月是正月…腊月、
// 可勾"闰月"，日是初一…三十。草稿的规矩（预选、往回收、拼成存的样子）在 state/personal-files.ts，这里只画。
import { useState } from "react";
import {
  type AnnualCalendar,
  annualDayChoices,
  type AnnualDraft,
  annualYearChoices,
  changeAnnualDraft,
  lunarDayName,
  lunarMonthName,
  monthName,
  t,
} from "../../state/index.ts";

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const CALENDARS: readonly AnnualCalendar[] = ["solar", "lunar"];

/** 下拉里"没选"那一项的值 */
const NONE = "";
/** 今年（这台设备的日历）：年份从它往下列 */
const currentYear = () => new Date().getFullYear();

export function AnnualDatePicker({ label, draft, disabled, onChange }: { label: string; draft: AnnualDraft; disabled?: boolean; onChange(next: AnnualDraft): void }) {
  const lunar = draft.calendar === "lunar";
  const [thisYear] = useState(currentYear);
  const years = annualYearChoices(thisYear, draft.year);
  const change = (patch: Parameters<typeof changeAnnualDraft>[1]) => onChange(changeAnnualDraft(draft, patch));
  return (
    <div className="pf-date" role="group" aria-label={label}>
      <div className="seg pf-date-cal" role="radiogroup" aria-label={t("pages.personalFiles.date.calendar")}>
        {CALENDARS.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={draft.calendar === c} className={draft.calendar === c ? "on" : ""} disabled={disabled} onClick={() => change({ calendar: c })}>
            {t(c === "solar" ? "pages.personalFiles.date.solar" : "pages.personalFiles.date.lunar")}
          </button>
        ))}
      </div>
      <div className="pf-date-selects">
        <select
          className="input pf-date-year"
          aria-label={t("pages.personalFiles.date.year")}
          value={draft.year === undefined ? NONE : String(draft.year)}
          disabled={disabled}
          onChange={(e) => change({ year: e.currentTarget.value === NONE ? null : Number(e.currentTarget.value) })}
        >
          <option value={NONE}>{t("pages.personalFiles.date.yearUnknown")}</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {t("pages.personalFiles.date.yearOption", { year: y })}
            </option>
          ))}
        </select>
        <select
          className="input pf-date-month"
          aria-label={t("pages.personalFiles.date.month")}
          value={draft.month === undefined ? NONE : String(draft.month)}
          disabled={disabled}
          onChange={(e) => e.currentTarget.value !== NONE && change({ month: Number(e.currentTarget.value) })}
        >
          {draft.month === undefined && <option value={NONE}>{t("pages.personalFiles.date.monthPick")}</option>}
          {MONTHS.map((m) => (
            <option key={m} value={m}>
              {lunar ? lunarMonthName(m) : monthName(m)}
            </option>
          ))}
        </select>
        <select
          className="input pf-date-day"
          aria-label={t("pages.personalFiles.date.day")}
          value={draft.day === undefined ? NONE : String(draft.day)}
          disabled={disabled}
          onChange={(e) => e.currentTarget.value !== NONE && change({ day: Number(e.currentTarget.value) })}
        >
          {draft.day === undefined && <option value={NONE}>{t("pages.personalFiles.date.dayPick")}</option>}
          {annualDayChoices(draft).map((d) => (
            <option key={d} value={d}>
              {lunar ? lunarDayName(d) : t("pages.personalFiles.date.dayOption", { day: d })}
            </option>
          ))}
        </select>
        {lunar && (
          <label className="pf-date-leap">
            <input type="checkbox" checked={draft.leap} disabled={disabled} onChange={(e) => change({ leap: e.currentTarget.checked })} />
            <span>{t("pages.personalFiles.date.leap")}</span>
          </label>
        )}
      </div>
    </div>
  );
}
