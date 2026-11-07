// 日历插件自己的体检项（414），在 setup 里经 ctx.doctor.register 登记，passive（只读内核内存里记着的）。
// 二狗已经替它生成的只有"插件本身"（日历没有数据源、运行时）。这里加"数据源交来的日程"（external-events；external 是二狗本身"外网入口"那一项的 id，留给二狗）：
// 日历按月取外部日程时，哪个数据源的日程拿不到（插件出错抛了）内核记下次数和原因（data-sources/service.ts 的 calendarProblems，
// 以前只记日志）——
// - 有数据源现在还拿不到（最近一次没拿到，连着几次）→ 注意，写哪个数据源、连着几次、最近一次的时间和原因，从这一串开头起；
// - 这次开机以来拿不到过、后来又拿到了 → 正常（写一共几次）；没拿不到过 → 正常。
// 只在打开日历、按月取的时候才拿外部日程，所以"拿不到"只在有人看过日历之后才知道；都在内存里，重启就没。
import { t } from "@ergo/protocol";
import type { CalendarFetchProblem } from "../data-sources/index.ts";
import { doctorTime } from "../doctor/auto.ts";
import type { DoctorCheck, DoctorFinding } from "../doctor/checks.ts";

/** 数据源交来的日程拿得到没有 */
export function externalFinding(problems: readonly CalendarFetchProblem[]): DoctorFinding {
  const failing = problems.filter((p) => p.failures > 0);
  if (failing.length > 0) {
    const lines = failing.map((p) => t("calendar.doctor.external.source", { name: p.title, count: p.failures, time: doctorTime(p.at), error: p.error }));
    const since = failing.map((p) => p.since).toSorted((a, b) => Date.parse(a) - Date.parse(b))[0]!;
    return { level: "warn", fact: { key: "calendar.doctor.external.failing", params: { sources: lines.join(t("calendar.doctor.external.sep")) } }, fix: { key: "calendar.doctor.external.fix" }, since, action: { kind: "open", route: "#/more/data-sources" } };
  }
  const total = problems.reduce((n, p) => n + p.total, 0);
  if (total > 0) return { level: "ok", fact: { key: "calendar.doctor.external.recovered", params: { count: total } } };
  return { level: "ok", fact: { key: "calendar.doctor.external.ok" } };
}

/** "数据源交来的日程"那一项：problems 现取（内核的外部日历） */
export function externalCalendarCheck(problems: () => readonly CalendarFetchProblem[]): DoctorCheck {
  return { id: "external-events", title: "calendar.doctor.external.title", cost: "passive", run: () => externalFinding(problems()) };
}
