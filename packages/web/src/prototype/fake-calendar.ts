// 原型用的假日历（35 号票，直接打开构建产物、没有守护进程时）：守护进程按月给出的每一天的日历条目，这里用假连接里的
// 节假日数据和个人设置算工作日判定，几条假的提醒和定时作业（和看板上的假条目同名）用共享协议包的时间规则展开到当天：
// 过了点的算响过、跑过（有一天的账单汇总失败、有一天的早报部分完成），没到点的是待触发、预计，暂停着的是已暂停。
// 299 号票：外部日历里手机日历同步来的几条；297 号票：Google 日历订阅同步来的几条（每周一的站会、出差、看牙、生日）。
import {
  activeLocale,
  type CalendarDay,
  type CalendarExternalEntry,
  type CalendarJobEntry,
  type CalendarMonthView,
  type CalendarReminderEntry,
  type HolidayYear,
  localDate,
  occurrencesBetween,
  parseMonthKey,
  type ReminderSchedule,
  workdayCalendar,
  type WorkdaySettings,
} from "../state/index.ts";
import { nowIso } from "../util/time.ts";

const FAKE_REMINDERS: { id: string; text: string; schedule: ReminderSchedule }[] = [
  { id: "r-rent", text: "交房租", schedule: { kind: "monthly", time: "09:00", days: [8] } },
  { id: "r-weekly", text: "准备周会材料", schedule: { kind: "weekly", time: "17:30", weekdays: [1, 2, 3, 4, 5] } },
  { id: "r-run", text: "跑步", schedule: { kind: "weekly", time: "19:00", weekdays: [1, 3, 5] } },
  { id: "r-mom-birthday", text: "妈妈生日，订蛋糕", schedule: { kind: "yearly", time: "09:00", month: 3, day: 2 } },
];

/** 定时触发的任务的每一次（76 号票：带着任务的点开去任务详情；fake-conversations.ts 里的「每天早上出早报」）和还没迁移的旧作业 */
const FAKE_JOBS: { id: string; title: string; schedule: ReminderSchedule; taskId?: string; projectId?: string; projectName?: string; paused?: boolean }[] = [
  { id: "sj-daily-bills", title: "每天 21:00 汇总当天账单", schedule: { kind: "daily", time: "21:00" }, projectId: "p-ledger", projectName: "记账本" },
  { id: "j-brief", title: "每天早上出早报", schedule: { kind: "workdays", time: "08:00" }, taskId: "t-brief" },
  { id: "sj-monthly", title: "每月 1 号出月报", schedule: { kind: "monthly", time: "09:00", days: [1] }, projectId: "p-ledger", projectName: "记账本", paused: true },
];

/** 假的一个月：asOf 是假连接里两个频道的序号 */
/** 原型里手机日历同步来的几条（编的） */
function fakePhoneEvents(year: number, month: number): CalendarExternalEntry[] {
  const at = (day: number, hh = 0) => nowIso(new Date(year, month - 1, day, hh));
  const source = { source: "phone-calendar", sourceTitle: activeLocale().meta.id === "en" ? "Phone · Calendar" : "手机 · 日历" };
  const en = activeLocale().meta.id === "en";
  return [
    { ...source, calendar: en ? "My calendar" : "我的日历", id: "e-1", title: en ? "Dentist" : "看牙医", at: at(8, 9), end: at(8, 10), allDay: false, location: en ? "Some dental clinic" : "某某口腔" },
    { ...source, calendar: en ? "Birthdays" : "生日", id: "e-2", title: en ? "Mom's birthday" : "妈妈生日", at: at(12), end: at(13), allDay: true },
    { ...source, calendar: en ? "Work" : "工作", id: "e-3", title: en ? "Business trip" : "出差", at: at(20), end: at(23), allDay: true },
  ];
}

/** 原型里 Google 日历订阅同步来的几条（编的；"工作""家里"是用户给两个日历起的名字）：每周一 09:30 站会，14–16 日出差，22 日看牙，25 日生日 */
function fakeGoogleEvents(year: number, month: number): CalendarExternalEntry[] {
  const at = (day: number, hh = 0, mi = 0) => nowIso(new Date(year, month - 1, day, hh, mi));
  const en = activeLocale().meta.id === "en";
  const source = { source: "google-calendar", sourceTitle: en ? "Google · Calendar" : "Google · 日历" };
  const work = en ? "Work" : "工作";
  const home = en ? "Home" : "家里";
  const mondays: CalendarExternalEntry[] = [];
  for (let day = 1; day <= new Date(year, month, 0).getDate(); day++) {
    if (new Date(year, month - 1, day).getDay() === 1) mondays.push({ ...source, calendar: work, id: `g-standup-${day}`, title: en ? "Stand-up" : "站会", at: at(day, 9, 30), end: at(day, 9, 45), allDay: false, location: en ? "Room 3F" : "3 楼会议室" });
  }
  return [
    ...mondays,
    { ...source, calendar: work, id: "g-trip", title: en ? "Trip to Shanghai" : "出差上海", at: at(14), end: at(17), allDay: true },
    { ...source, calendar: home, id: "g-dentist", title: en ? "Dentist" : "看牙", at: at(22, 15), end: at(22, 16), allDay: false, location: en ? "Ren'ai Dental" : "仁爱口腔" },
    { ...source, calendar: home, id: "g-birthday", title: en ? "Xiao Wang's birthday" : "小王生日", at: at(25), end: at(26), allDay: true },
  ];
}

export function fakeCalendarMonth(month: string, holidays: readonly HolidayYear[], settings: WorkdaySettings, asOf: CalendarMonthView["asOf"]): CalendarMonthView {
  const { year, month: m } = parseMonthKey(month);
  const calendar = workdayCalendar(holidays, settings);
  const context = { calendar };
  const from = new Date(year, m - 1, 1);
  const to = new Date(year, m, 1);
  const now = Date.now();
  const days = new Map<string, CalendarDay>(calendar.month(year, m).map((verdict) => [verdict.date, { date: verdict.date, verdict, reminders: [], jobs: [] }]));
  for (const r of FAKE_REMINDERS) {
    for (const at of occurrencesBetween(r.schedule, from, to, context)) {
      const entry: CalendarReminderEntry = { reminderId: r.id, text: r.text, schedule: r.schedule, at: nowIso(at), status: at.getTime() <= now ? "fired" : "upcoming" };
      days.get(localDate(at))?.reminders.push(entry);
    }
  }
  for (const j of FAKE_JOBS) {
    for (const at of occurrencesBetween(j.schedule, from, to, context)) {
      const due = nowIso(at);
      const base = { jobId: j.id, ...(j.taskId ? { taskId: j.taskId } : {}), title: j.title, schedule: j.schedule, ...(j.projectId ? { projectId: j.projectId, projectName: j.projectName } : {}), at: due };
      const past = at.getTime() <= now;
      // 账单汇总每月 6 号失败一次；早报每月 9 号部分完成一次（176 号票）
      const failed = past && j.id === "sj-daily-bills" && at.getDate() === 6;
      const partial = past && j.id === "j-brief" && at.getDate() === 9;
      const state = failed ? "failed" : partial ? "partial" : "done";
      const reason = failed ? "银行导出的账单格式变了" : partial ? "有一步没等到你的批准：「通用 bash」（curl -s https://rss.example.com/tech）" : undefined;
      const entry: CalendarJobEntry = past
        ? {
            ...base,
            status: state,
            run: { runId: `${j.id}-${localDate(at)}`, jobId: j.id, trigger: "scheduled", dueAt: due, state, queuedAt: due, ...(reason ? { reason } : {}) },
          }
        : { ...base, status: j.paused ? "paused" : "expected" };
      days.get(localDate(at))?.jobs.push(entry);
    }
  }
  // 外部日历（299 号票）：手机日历同步来的几条（这个月 8 日看牙医、12 日全天的妈妈生日、20–22 日出差）
  for (const e of [...fakePhoneEvents(year, m), ...fakeGoogleEvents(year, m)]) {
    const start = new Date(e.at);
    const last = e.end === undefined ? start : new Date(Date.parse(e.end) - 1);
    for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d <= last; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      const day = days.get(localDate(d));
      if (day) (day.external ??= []).push(e);
    }
  }
  for (const day of days.values()) {
    day.reminders.sort((a, b) => a.at.localeCompare(b.at));
    day.jobs.sort((a, b) => a.at.localeCompare(b.at));
    day.external?.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }
  return { month, days: [...days.values()], missing: calendar.missing(year), asOf };
}
