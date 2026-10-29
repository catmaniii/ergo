// 日历里的提醒（35 号票）。193 号票：从日历页（pages/CalendarPage.tsx）挪进提醒插件，登记成网页插件的日历插槽（plugins/reminders/plugin.tsx）：
// 图例里的"提醒"、每天格子里当天几条提醒的小标、点开一天的"提醒"那一节（时间、内容、重复规则、触发没有）。都排在核心的定时作业前面；
// 提醒插件停用时都没有。每天的提醒是守护进程按月给的日历条目里的（内核的日历现取提醒的服务，提醒插件停用时是空的），状态层照旧推导。
import { type CalendarCell, type CalendarDayDetail, t } from "../../state/index.ts";
import { Section } from "../../ui/common.tsx";

/** 图例里的一项："2"的小标是提醒 */
export function ReminderLegend() {
  return (
    <span>
      <b className="cal-mk cal-mk-r">2</b>
      {t("pages.calendar.legend.reminders")}
    </span>
  );
}

/** 格子里当天几条提醒 */
export function ReminderMarks({ cell }: { cell: CalendarCell }) {
  return cell.reminders > 0 ? <b className="cal-mk cal-mk-r">{cell.reminders}</b> : null;
}

/** 点开一天的"提醒"那一节 */
export function ReminderDay({ day }: { day: CalendarDayDetail }) {
  return (
    <Section title={t("pages.calendar.remindersTitle", { count: day.reminders.length })}>
      {day.reminders.length === 0 && <div className="muted">{t("pages.calendar.noReminders")}</div>}
      {day.reminders.map((r) => (
        <div key={r.key} className="cal-item">
          <span className="cal-item-time">{r.time}</span>
          <div className="cal-item-main">
            <b>{r.text}</b>
            {r.repeat && <div className="muted">{r.repeat}</div>}
          </div>
          <span className={`cal-st cal-st-${r.status}`}>{r.statusText}</span>
        </div>
      ))}
    </Section>
  );
}
