// 生日、纪念日"每年提前几天提醒"的勾和天数（283 号票）：个人档案的核对卡、候选核对卡、档案页共用。默认勾着、提前 3 天。
import { ANNUAL_REMINDER_DAY_CHOICES, annualDaysLabel, t } from "../../state/index.ts";

export function AnnualRemindPick({
  label,
  on,
  days,
  disabled,
  onChange,
}: {
  /** 哪个字段（"生日""结婚纪念日"） */
  label: string;
  on: boolean;
  days: number;
  disabled?: boolean;
  onChange(next: { on: boolean; days: number }): void;
}) {
  return (
    <div className="pf-remind">
      <label className="pf-remind-check">
        <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange({ on: e.currentTarget.checked, days })} />
        <span>{t("ui.cards.personalFile.remindEvery", { label })}</span>
      </label>
      <select
        className="input pf-remind-days"
        aria-label={t("ui.cards.personalFile.remindDays")}
        value={days}
        disabled={disabled === true || !on}
        onChange={(e) => onChange({ on, days: Number(e.currentTarget.value) })}
      >
        {ANNUAL_REMINDER_DAY_CHOICES.map((n) => (
          <option key={n} value={n}>
            {annualDaysLabel(n)}
          </option>
        ))}
      </select>
    </div>
  );
}
