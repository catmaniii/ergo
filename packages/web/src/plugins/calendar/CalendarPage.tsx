// 主导航的日历（35 号票，规格第 19 节"日历"）：按月看，每天标上班或休息（原因的短词、手动标记），用小标记标出当天几条提醒、
// 几次定时作业，有作业失败的标红点。标题里的年份、月份都能点：点年份出年份列表（今年前后若干年，缺节假日数据的年份标出来），
// 点月份出 12 个月，选了直接跳过去；"回到今天"一键回来。点某一天展开这一天的详情：手机上是单独一页（能返回），宽屏是日历旁边的面板。
// 详情里有工作日判定和原因、当天的提醒（时间、内容、触发没有）、当天的定时作业（几点、属于哪个项目、这一次的结果或预计），
// 点作业去它在看板或项目页上的位置；把这天改成上班或休息、清掉手动标记也在详情里。额外上班规则在设置的"工作日规则"里加。
//
// 数据：守护进程按月给出每一天的日历条目（DaemonHttp.calendarMonth），并进前端状态层；提醒、作业、工作日历变了的事件推来后，
// 手里这份算旧了（状态层的 calendarMonthOf），这里重新取（取的时候先接着显示旧的，不闪）。地址：#/calendar[/YYYY-MM | /YYYY-MM-DD]。
// 193 号票：提醒那几样（图例里的"提醒"、格子里提醒的小标、详情里"提醒"那一节）由提醒插件画（网页插件的日历插槽，排在核心的定时作业前面）；
// 提醒插件停用时都没有（守护进程那边当天的提醒也是空的）。
// 213 号票：整页挪进日历插件（pages/CalendarPage.tsx → plugins/calendar/，plugin.tsx 登记成网页插件的页面），一行没改；地址照旧是核心的
// #/calendar，核心的路由经 CalendarSection 交过来（地址里那一段是月份或日期）。日历插槽、工作日判定、定时作业的推导还在核心。
// 299 号票：外部日历（数据源交来的日程：手机日历……）——格子上的小标、图例（这个月有才出）、详情里"外部日历"一节（时间或全天、标题、
// 来自哪里），只读。306 号票：数据源同步来新的外部日程（工作日历频道上的临时事件 external_calendar），开着的月视图、当天详情自己重新取。
import { type ComponentType, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import type { Navigate } from "../../app/route.ts";
import { useBackLayer } from "../../app/page-back.ts";
import { useStore } from "../../app/store.tsx";
import { MONDAY_FIRST, weekdayLabel } from "../../model/labels.ts";
import {
  type CalendarCell,
  calendarCells,
  calendarDayDetail,
  calendarMonthOf,
  type CalendarMonthView,
  calendarYearChoices,
  type DayMarkKind,
  DAY_SHORT_LABEL_LEGEND,
  HOLIDAY_REGION_LABEL,
  jobPlace,
  localDate,
  missingHolidayDataText,
  monthKey,
  parseMonthKey,
  shiftMonthKey,
  t,
  tTable,
} from "../../state/index.ts";
import { ListDetail, Section, TopBar } from "../../ui/common.tsx";
import { T } from "../../ui/i18n.tsx";
import { useToast } from "../../ui/toast.tsx";
import { type PageSectionProps, usePlugins } from "../api.ts";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 月份的名字（中文"10 月"，英文"October"；171 号票） */
const MONTH_NAMES = tTable({
  "1": "pages.calendar.month.1",
  "2": "pages.calendar.month.2",
  "3": "pages.calendar.month.3",
  "4": "pages.calendar.month.4",
  "5": "pages.calendar.month.5",
  "6": "pages.calendar.month.6",
  "7": "pages.calendar.month.7",
  "8": "pages.calendar.month.8",
  "9": "pages.calendar.month.9",
  "10": "pages.calendar.month.10",
  "11": "pages.calendar.month.11",
  "12": "pages.calendar.month.12",
});
const monthName = (m: number) => MONTH_NAMES[String(m) as keyof typeof MONTH_NAMES];

/**
 * 某个月的日历：状态层里的那一份，旧了（或还没取过）就去取。按"月份 + 最近一次会让日历变的事件"记下取过的：同样的样子只取一次，
 * 取的路上又来了事件就再取一次（晚到的旧响应由状态层丢掉）；取失败的说明原因，有新的事件来了或点"重试"时再取
 */
function useCalendarMonth(month: string): { view: CalendarMonthView | undefined; error: string | undefined; retry(): void } {
  const { ui, loadCalendarMonth } = useStore();
  const { view, stale } = calendarMonthOf(ui, month);
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const requested = useRef<string>(undefined);
  const { board, workdayCalendar, external } = ui.calendar.changedAt;
  const key = `${month}@${board}/${workdayCalendar}/${external}`;
  const load = useCallback(
    (asKey: string) => {
      requested.current = asKey;
      loadCalendarMonth(month).then(
        () => setFailure(undefined),
        (err: unknown) => setFailure({ key: asKey, message: errorText(err) }),
      );
    },
    [month, loadCalendarMonth],
  );
  useEffect(() => {
    if (stale && requested.current !== key) load(key);
  }, [stale, key, load]);
  return { view, error: failure?.key === key ? failure.message : undefined, retry: () => load(key) };
}

export function CalendarPage({ wide, month, date, navigate }: { wide: boolean; month?: string; date?: string; navigate: Navigate }) {
  // 打开页面这一刻的今天（"回到今天"、今天的格子）
  const [today] = useState(() => localDate(new Date()));
  const shown = date ? date.slice(0, 7) : (month ?? today.slice(0, 7));
  const data = useCalendarMonth(shown);
  const monthView = <MonthPane month={shown} selected={date} today={today} wide={wide} data={data} navigate={navigate} />;
  const detail = date ? <DayPane date={date} view={data.view} onBack={wide ? undefined : () => navigate({ tab: "calendar", month: shown })} navigate={navigate} /> : undefined;
  if (!wide) return detail ?? monthView;
  return <ListDetail wide list={monthView} detail={detail ?? <div className="page-placeholder">{t("pages.calendar.pickDay")}</div>} listWidth={440} />;
}

function MonthPane({
  month,
  selected,
  today,
  wide,
  data,
  navigate,
}: {
  month: string;
  selected?: string;
  today: string;
  wide: boolean;
  data: ReturnType<typeof useCalendarMonth>;
  navigate: Navigate;
}) {
  const { view, error, retry } = data;
  const thisMonth = today.slice(0, 7);
  const { year } = parseMonthKey(month);
  const go = (m: string) => navigate({ tab: "calendar", month: m });
  // 宽屏回到今天顺手展开今天的详情；手机上只回到这个月（详情是单独一页，不自动打开）
  const backToToday = () => navigate(wide ? { tab: "calendar", date: today } : { tab: "calendar" });
  const cells = view ? calendarCells(view) : [];
  // 网页插件的日历插槽（193 号票）：图例、格子里的小标排在核心的定时作业前面
  const slots = usePlugins().list("calendar");
  const marks = slots.flatMap((slot) => (slot.CellMarks ? [{ id: slot.id, Marks: slot.CellMarks }] : []));
  // 周一在前
  const lead = view ? (view.days[0]!.verdict.weekday + 6) % 7 : 0;
  // 外部日历（299 号票）：这个月有才在图例里出
  const hasExternal = cells.some((c) => c.external > 0);
  return (
    <div className="chat-col">
      <TopBar title={t("pages.calendar.title")}>
        <button type="button" className="btn ghost small" disabled={month === thisMonth && (!wide || selected === today)} onClick={backToToday}>
          {t("pages.calendar.today")}
        </button>
      </TopBar>
      <div className="scroll page-pad">
        <MonthTitle month={month} today={today} onPick={go} />
        {view && view.missing.length > 0 && (
          <div className="hint">
            {t("pages.calendar.missingHint", { text: missingHolidayDataText(year, view.missing), regions: view.missing.map((r) => HOLIDAY_REGION_LABEL[r]).join(t("pages.common.listSep")) })}
          </div>
        )}
        {error && (
          <div className="hint">
            {t("pages.calendar.loadFailed", { error })}{" "}
            <button type="button" className="link" onClick={retry}>
              {t("pages.calendar.retry")}
            </button>
          </div>
        )}
        {!view ? (
          !error && <div className="muted">{t("pages.calendar.loading")}</div>
        ) : (
          <div className="cal" role="group" aria-label={t("pages.calendar.yearMonth", { year, month: monthName(parseMonthKey(month).month) })}>
            {MONDAY_FIRST.map((d) => weekdayLabel(d, true)).map((w) => (
              <div key={w} className="cal-wd" aria-hidden="true">
                {w}
              </div>
            ))}
            {Array.from({ length: lead }, (_, i) => (
              <div key={`lead-${i}`} />
            ))}
            {cells.map((c) => (
              <DayCell key={c.date} cell={c} marks={marks} today={c.date === today} on={c.date === selected} onOpen={() => navigate({ tab: "calendar", date: c.date })} />
            ))}
          </div>
        )}
        <div className="cal-legend muted">
          <span>
            <i className="lg-work" />
            {t("pages.calendar.work")}
          </span>
          <span>
            <i className="lg-rest" />
            {t("pages.calendar.rest")}
          </span>
          <span>
            <i className="lg-manual" />
            {t("pages.calendar.legend.manual")}
          </span>
          {slots.map((slot) => slot.Legend && <slot.Legend key={slot.id} />)}
          <span>
            <b className="cal-mk cal-mk-j">1</b>
            {t("pages.calendar.legend.jobs")}
          </span>
          {hasExternal && (
            <span>
              <b className="cal-mk cal-mk-x">1</b>
              {t("pages.calendar.legend.external")}
            </span>
          )}
          <span>
            <i className="cal-mk-fail" />
            {t("pages.calendar.legend.failed")}
          </span>
          <span>{DAY_SHORT_LABEL_LEGEND}</span>
        </div>
        <div className="hint">
          <T
            k="pages.calendar.rulesHint"
            params={{
              link: (
                <button type="button" className="link" onClick={() => navigate({ tab: "more", page: "workday-rules" })}>
                  {t("pages.calendar.rulesLink")}
                </button>
              ),
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** 一天的格子：几号、班 / 休、原因的短词，下面一行是提醒数（提醒插件画的，193 号票）、作业数和失败的红点（不挤掉班 / 休） */
function DayCell({
  cell: c,
  marks,
  today,
  on,
  onOpen,
}: {
  cell: CalendarCell;
  marks: readonly { id: string; Marks: ComponentType<{ cell: CalendarCell }> }[];
  today: boolean;
  on: boolean;
  onOpen(): void;
}) {
  return (
    <button
      type="button"
      className={`cal-day ${c.workday ? "cal-work" : "cal-rest"}${c.manual ? " cal-manual" : ""}${today ? " cal-today" : ""}${on ? " cal-on" : ""}`}
      aria-label={c.label}
      aria-current={today ? "date" : undefined}
      aria-pressed={on}
      title={c.label}
      onClick={onOpen}
    >
      <span className="cal-n">{c.day}</span>
      <span className="cal-s">{c.workday ? t("pages.calendar.cellWork") : t("pages.calendar.cellRest")}</span>
      <span className="cal-r">{c.short}</span>
      <span className="cal-marks" aria-hidden="true">
        {marks.map(({ id, Marks }) => (
          <Marks key={id} cell={c} />
        ))}
        {c.jobs > 0 && <b className="cal-mk cal-mk-j">{c.jobs}</b>}
        {c.external > 0 && <b className="cal-mk cal-mk-x">{c.external}</b>}
        {c.failedJobs > 0 && <i className="cal-mk-fail" />}
      </span>
    </button>
  );
}

/**
 * 月视图的标题：上个月 · [2026 年] [10 月] · 下个月。点年份、月份各出一个选择面板，选了直接跳过去；
 * 面板打开时焦点在当前选中的那一项上，Esc 关掉、焦点回到标题上
 */
function MonthTitle({ month, today, onPick }: { month: string; today: string; onPick(month: string): void }) {
  const { ui } = useStore();
  const { year, month: mon } = parseMonthKey(month);
  const [picker, setPicker] = useState<"year" | "month">();
  const yearRef = useRef<HTMLButtonElement>(null);
  const monthRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 面板打开时焦点放到当前选中的那一项上
  useEffect(() => {
    if (picker) panelRef.current?.querySelector<HTMLButtonElement>("[aria-current='true']")?.focus();
  }, [picker]);
  const close = () => {
    const back = picker === "year" ? yearRef : monthRef;
    setPicker(undefined);
    back.current?.focus();
  };
  useBackLayer("overlay", picker !== undefined, close);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  const pick = (m: string) => {
    setPicker(undefined);
    onPick(m);
  };
  const thisYear = Number(today.slice(0, 4));
  return (
    <div className="cal-title" onKeyDown={onKeyDown}>
      <div className="cal-nav">
        <button type="button" className="icon-btn" onClick={() => onPick(shiftMonthKey(month, -1))} aria-label={t("pages.calendar.prevMonth")}>
          ‹
        </button>
        <button ref={yearRef} type="button" className={`cal-pick-btn${picker === "year" ? " on" : ""}`} aria-expanded={picker === "year"} aria-label={t("pages.calendar.pickYearLabel", { year })} onClick={() => setPicker(picker === "year" ? undefined : "year")}>
          {t("pages.calendar.year", { year })} ▾
        </button>
        <button ref={monthRef} type="button" className={`cal-pick-btn${picker === "month" ? " on" : ""}`} aria-expanded={picker === "month"} aria-label={t("pages.calendar.pickMonthLabel", { month: monthName(mon) })} onClick={() => setPicker(picker === "month" ? undefined : "month")}>
          {monthName(mon)} ▾
        </button>
        <button type="button" className="icon-btn" onClick={() => onPick(shiftMonthKey(month, 1))} aria-label={t("pages.calendar.nextMonth")}>
          ›
        </button>
      </div>
      {picker === "year" && (
        <div ref={panelRef} className="cal-picker cal-picker-years" role="group" aria-label={t("pages.calendar.pickYear")}>
          {calendarYearChoices(ui, thisYear, year).map((c) => (
            <button
              key={c.year}
              type="button"
              className={`cal-pick${c.year === year ? " on" : ""}${c.year === thisYear ? " now" : ""}`}
              aria-current={c.year === year ? "true" : undefined}
              aria-label={c.missing ? t("pages.calendar.yearMissing", { year: c.year, missing: c.missing }) : t("pages.calendar.year", { year: c.year })}
              title={c.missing}
              onClick={() => pick(monthKey(c.year, mon))}
            >
              {c.year}
              {c.missing && <small>{t("pages.calendar.noData")}</small>}
            </button>
          ))}
        </div>
      )}
      {picker === "month" && (
        <div ref={panelRef} className="cal-picker cal-picker-months" role="group" aria-label={t("pages.calendar.pickMonth")}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <button
              key={m}
              type="button"
              className={`cal-pick${m === mon ? " on" : ""}${monthKey(year, m) === today.slice(0, 7) ? " now" : ""}`}
              aria-current={m === mon ? "true" : undefined}
              onClick={() => pick(monthKey(year, m))}
            >
              {monthName(m)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 某一天的详情：手机上是单独一页（onBack 回到这个月），宽屏是日历旁边的面板 */
function DayPane({ date, view, onBack, navigate }: { date: string; view: CalendarMonthView | undefined; onBack?: () => void; navigate: Navigate }) {
  const { http } = useStore();
  const toast = useToast();
  const detail = view && calendarDayDetail(view, date);
  // 网页插件的日历插槽（193 号票）：这一天的几节排在核心的定时作业前面
  const daySlots = usePlugins().list("calendar");
  const mark = (m: DayMarkKind | undefined) => {
    http.changeWorkday(m ? { kind: "mark", date, mark: m } : { kind: "clear_mark", date }).catch((err: unknown) => toast(t("pages.calendar.markFailed", { error: errorText(err) })));
  };
  if (!detail) {
    return (
      <div className="chat-col">
        <TopBar title={date} onBack={onBack} />
        <div className="scroll page-pad">
          <div className="muted">{t("pages.calendar.loading")}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="chat-col">
      <TopBar title={detail.title} onBack={onBack} />
      <div className="scroll page-pad">
        <div className="cal-verdict">
          <div>
            <b className={detail.workday ? "cal-verdict-work" : "cal-verdict-rest"}>{detail.workday ? t("pages.calendar.work") : t("pages.calendar.rest")}</b>
            <span> · {detail.reasons.join(t("pages.common.listSep"))}</span>
          </div>
          {detail.holidays.map((h) => (
            <div key={h} className="muted">
              {h}
            </div>
          ))}
          {detail.missing && <div className="muted">{t("pages.calendar.dayMissing", { text: detail.missing })}</div>}
          <div className="auth-actions">
            {detail.workday ? (
              <button type="button" className="btn ghost small" onClick={() => mark("rest")}>
                {t("pages.calendar.markRest")}
              </button>
            ) : (
              <button type="button" className="btn ghost small" onClick={() => mark("work")}>
                {t("pages.calendar.markWork")}
              </button>
            )}
            {detail.manual && (
              <button type="button" className="btn ghost small" onClick={() => mark(undefined)}>
                {t("pages.calendar.clearMark")}
              </button>
            )}
          </div>
        </div>

        {daySlots.map((slot) => slot.Day && <slot.Day key={slot.id} day={detail} navigate={navigate} />)}

        {detail.external.length > 0 && (
          <Section title={t("pages.calendar.externalTitle", { count: detail.external.length })}>
            {detail.external.map((e) => (
              <div key={e.key} className="cal-item" data-external={e.key}>
                <span className="cal-item-time">{e.time}</span>
                <div className="cal-item-main">
                  <b>{e.title}</b>
                  <div className="muted">{e.from}</div>
                </div>
              </div>
            ))}
          </Section>
        )}

        <Section title={t("pages.calendar.jobsTitle", { count: detail.jobs.length })}>
          {detail.jobs.length === 0 && <div className="muted">{t("pages.calendar.noJobs")}</div>}
          {detail.jobs.map((j) => {
            const place = jobPlace(j);
            return (
              <button
                key={j.key}
                type="button"
                className="cal-item cal-item-link"
                title={place.kind === "task" ? t("pages.calendar.openTask") : place.kind === "project" ? t("pages.calendar.openProjectJob") : t("pages.calendar.openBoardJob")}
                onClick={() =>
                  navigate(
                    place.kind === "task"
                      ? { tab: "tasks", taskId: place.taskId }
                      : place.kind === "project"
                        ? { tab: "projects", projectId: place.projectId, jobId: place.jobId }
                        : { tab: "tasks", jobId: place.jobId },
                  )
                }
              >
                <span className="cal-item-time">{j.time}</span>
                <span className="cal-item-main">
                  <b>{j.title}</b>
                  <span className="muted">
                    {j.project} · {j.schedule}
                  </span>
                </span>
                <span className={`cal-st cal-st-${j.status}`}>{j.statusText}</span>
                <span className="muted" aria-hidden="true">
                  ›
                </span>
              </button>
            );
          })}
        </Section>
      </div>
    </div>
  );
}

/** 日期的写法 YYYY-MM-DD（月份是 YYYY-MM） */
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 核心的路由交过来的日历页（213 号票，网页插件页面的 Section）：#/calendar[/YYYY-MM | /YYYY-MM-DD] 里那一段是 item（核心已经核对过写法），
 * 是日期的展开那一天，是月份的看那个月，不给是这个月
 */
export function CalendarSection({ wide, item, navigate }: PageSectionProps) {
  const date = item !== undefined && DATE_KEY.test(item) ? item : undefined;
  return <CalendarPage wide={wide} month={date ? undefined : item} date={date} navigate={navigate} />;
}
