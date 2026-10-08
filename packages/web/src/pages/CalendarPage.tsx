// 主导航的日历（35 号票，规格第 19 节"日历"）：按月看，每天标上班或休息（原因的短词、手动标记），用小标记标出当天几条提醒、
// 几次定时作业，有作业失败的标红点。标题里的年份、月份都能点：点年份出年份列表（今年前后若干年，缺节假日数据的年份标出来），
// 点月份出 12 个月，选了直接跳过去；"回到今天"一键回来。点某一天展开这一天的详情：手机上是单独一页（能返回），宽屏是日历旁边的面板。
// 详情里有工作日判定和原因、当天的提醒（时间、内容、触发没有）、当天的定时作业（几点、属于哪个项目、这一次的结果或预计），
// 点作业去它在看板或项目页上的位置；把这天改成上班或休息、清掉手动标记也在详情里。额外上班规则在设置的"工作日规则"里加。
//
// 数据：守护进程按月给出每一天的日历条目（DaemonHttp.calendarMonth），并进前端状态层；提醒、作业、工作日历变了的事件推来后，
// 手里这份算旧了（状态层的 calendarMonthOf），这里重新取（取的时候先接着显示旧的，不闪）。地址：#/calendar[/YYYY-MM | /YYYY-MM-DD]。
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import type { Navigate } from "../app/route.ts";
import { useStore } from "../app/store.tsx";
import { MONDAY_FIRST, weekdayLabel } from "../model/labels.ts";
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
} from "../state/index.ts";
import { ListDetail, Section, TopBar } from "../ui/common.tsx";
import { useToast } from "../ui/toast.tsx";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * 某个月的日历：状态层里的那一份，旧了（或还没取过）就去取。按"月份 + 最近一次会让日历变的事件"记下取过的：同样的样子只取一次，
 * 取的路上又来了事件就再取一次（晚到的旧响应由状态层丢掉）；取失败的说明原因，有新的事件来了或点"重试"时再取
 */
function useCalendarMonth(month: string): { view: CalendarMonthView | undefined; error: string | undefined; retry(): void } {
  const { ui, loadCalendarMonth } = useStore();
  const { view, stale } = calendarMonthOf(ui, month);
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const requested = useRef<string>(undefined);
  const { board, workdayCalendar } = ui.calendar.changedAt;
  const key = `${month}@${board}/${workdayCalendar}`;
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
  return <ListDetail wide list={monthView} detail={detail ?? <div className="page-placeholder">点左边的某一天，看当天的详情</div>} listWidth={440} />;
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
  // 周一在前
  const lead = view ? (view.days[0]!.verdict.weekday + 6) % 7 : 0;
  return (
    <div className="chat-col">
      <TopBar title="日历">
        <button type="button" className="btn ghost small" disabled={month === thisMonth && (!wide || selected === today)} onClick={backToToday}>
          回到今天
        </button>
      </TopBar>
      <div className="scroll page-pad">
        <MonthTitle month={month} today={today} onPick={go} />
        {view && view.missing.length > 0 && (
          <div className="hint">
            {missingHolidayDataText(year, view.missing)}：这一年{view.missing.map((r) => HOLIDAY_REGION_LABEL[r]).join("、")}那边先按周一到周五算（没有调休补班）。
          </div>
        )}
        {error && (
          <div className="hint">
            日历没取到：{error}{" "}
            <button type="button" className="link" onClick={retry}>
              重试
            </button>
          </div>
        )}
        {!view ? (
          !error && <div className="muted">正在读取日历…</div>
        ) : (
          <div className="cal" role="group" aria-label={`${year} 年 ${parseMonthKey(month).month} 月`}>
            {MONDAY_FIRST.map((d) => weekdayLabel(d, true)).map((w) => (
              <div key={w} className="cal-wd" aria-hidden="true">
                {w}
              </div>
            ))}
            {Array.from({ length: lead }, (_, i) => (
              <div key={`lead-${i}`} />
            ))}
            {cells.map((c) => (
              <DayCell key={c.date} cell={c} today={c.date === today} on={c.date === selected} onOpen={() => navigate({ tab: "calendar", date: c.date })} />
            ))}
          </div>
        )}
        <div className="cal-legend muted">
          <span>
            <i className="lg-work" />
            上班
          </span>
          <span>
            <i className="lg-rest" />
            休息
          </span>
          <span>
            <i className="lg-manual" />
            手动标记
          </span>
          <span>
            <b className="cal-mk cal-mk-r">2</b>
            提醒
          </span>
          <span>
            <b className="cal-mk cal-mk-j">1</b>
            定时作业（已暂停的不算）
          </span>
          <span>
            <i className="cal-mk-fail" />
            有作业失败
          </span>
          <span>{DAY_SHORT_LABEL_LEGEND}</span>
        </div>
        <div className="hint">
          额外上班规则（比如每月最后一个周六上班）在
          <button type="button" className="link" onClick={() => navigate({ tab: "more", page: "workday-rules" })}>
            设置 · 工作日规则
          </button>
          里加。
        </div>
      </div>
    </div>
  );
}

/** 一天的格子：几号、班 / 休、原因的短词，下面一行是提醒数、作业数和失败的红点（不挤掉班 / 休） */
function DayCell({ cell: c, today, on, onOpen }: { cell: CalendarCell; today: boolean; on: boolean; onOpen(): void }) {
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
      <span className="cal-s">{c.workday ? "班" : "休"}</span>
      <span className="cal-r">{c.short}</span>
      <span className="cal-marks" aria-hidden="true">
        {c.reminders > 0 && <b className="cal-mk cal-mk-r">{c.reminders}</b>}
        {c.jobs > 0 && <b className="cal-mk cal-mk-j">{c.jobs}</b>}
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
        <button type="button" className="icon-btn" onClick={() => onPick(shiftMonthKey(month, -1))} aria-label="上个月">
          ‹
        </button>
        <button ref={yearRef} type="button" className={`cal-pick-btn${picker === "year" ? " on" : ""}`} aria-expanded={picker === "year"} aria-label={`${year} 年，选年份`} onClick={() => setPicker(picker === "year" ? undefined : "year")}>
          {year} 年 ▾
        </button>
        <button ref={monthRef} type="button" className={`cal-pick-btn${picker === "month" ? " on" : ""}`} aria-expanded={picker === "month"} aria-label={`${mon} 月，选月份`} onClick={() => setPicker(picker === "month" ? undefined : "month")}>
          {mon} 月 ▾
        </button>
        <button type="button" className="icon-btn" onClick={() => onPick(shiftMonthKey(month, 1))} aria-label="下个月">
          ›
        </button>
      </div>
      {picker === "year" && (
        <div ref={panelRef} className="cal-picker cal-picker-years" role="group" aria-label="选年份">
          {calendarYearChoices(ui, thisYear, year).map((c) => (
            <button
              key={c.year}
              type="button"
              className={`cal-pick${c.year === year ? " on" : ""}${c.year === thisYear ? " now" : ""}`}
              aria-current={c.year === year ? "true" : undefined}
              aria-label={c.missing ? `${c.year} 年（${c.missing}）` : `${c.year} 年`}
              title={c.missing}
              onClick={() => pick(monthKey(c.year, mon))}
            >
              {c.year}
              {c.missing && <small>缺数据</small>}
            </button>
          ))}
        </div>
      )}
      {picker === "month" && (
        <div ref={panelRef} className="cal-picker cal-picker-months" role="group" aria-label="选月份">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <button
              key={m}
              type="button"
              className={`cal-pick${m === mon ? " on" : ""}${monthKey(year, m) === today.slice(0, 7) ? " now" : ""}`}
              aria-current={m === mon ? "true" : undefined}
              onClick={() => pick(monthKey(year, m))}
            >
              {m} 月
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
  const mark = (m: DayMarkKind | undefined) => {
    http.changeWorkday(m ? { kind: "mark", date, mark: m } : { kind: "clear_mark", date }).catch((err: unknown) => toast(`没改成：${errorText(err)}`));
  };
  if (!detail) {
    return (
      <div className="chat-col">
        <TopBar title={date} onBack={onBack} />
        <div className="scroll page-pad">
          <div className="muted">正在读取日历…</div>
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
            <b className={detail.workday ? "cal-verdict-work" : "cal-verdict-rest"}>{detail.workday ? "上班" : "休息"}</b>
            <span> · {detail.reasons.join("、")}</span>
          </div>
          {detail.holidays.map((h) => (
            <div key={h} className="muted">
              {h}
            </div>
          ))}
          {detail.missing && <div className="muted">{detail.missing}：缺的那边按周一到周五算</div>}
          <div className="auth-actions">
            {detail.workday ? (
              <button type="button" className="btn ghost small" onClick={() => mark("rest")}>
                标为休息
              </button>
            ) : (
              <button type="button" className="btn ghost small" onClick={() => mark("work")}>
                标为上班
              </button>
            )}
            {detail.manual && (
              <button type="button" className="btn ghost small" onClick={() => mark(undefined)}>
                清除手动标记
              </button>
            )}
          </div>
        </div>

        <Section title={`提醒 · ${detail.reminders.length}`}>
          {detail.reminders.length === 0 && <div className="muted">这天没有提醒</div>}
          {detail.reminders.map((r) => (
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

        <Section title={`定时作业 · ${detail.jobs.length}`}>
          {detail.jobs.length === 0 && <div className="muted">这天没有定时作业</div>}
          {detail.jobs.map((j) => {
            const place = jobPlace(j);
            return (
              <button
                key={j.key}
                type="button"
                className="cal-item cal-item-link"
                title={place.kind === "project" ? "去项目页上看这个作业" : "去看板上看这个作业"}
                onClick={() => navigate(place.kind === "project" ? { tab: "projects", projectId: place.projectId, jobId: place.jobId } : { tab: "tasks", jobId: place.jobId })}
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
