// 体检（319b、409）在网页上的这一半里"不碰浏览器"的那部分：取一遍（loadDoctor：经 DaemonHttp 的 GET /api/doctor，
// 演示页是原型的假 HTTP，prototype/fake-doctor.ts）、总状态那几句、五种结果的叫法、"从什么时候起"、停用的插件那一行、
// 动作按钮上的字、查的时刻。每项的句子守护进程已经按当前语言拼好了（DoctorItemView 的 text——插件的文案键在插件自己的
// 语言文件里，网页的词典里没有那些区域），这里照着显示，不自己拼。真相在守护进程，这边一个字节也不存。
// 这些函数都不碰 window、不引 React（Node 里直接查，test/pages/doctor.test.ts）：钩子在 app/page-doctor.ts。
// 415 加了深度体检的几句：取、开测、"几分钟前测的"、"几秒后能再测"、按钮上的字、按块分好。
import {
  DOCTOR_ACTION_KINDS,
  type DoctorAction,
  type DoctorDeepItemView,
  type DoctorDeepView,
  type DoctorLevel,
  doctorOpensUrl,
  type DoctorView,
  formatDate,
  formatList,
  t,
  worstLevel,
} from "../state/index.ts";
import type { DaemonHttp } from "./daemon-http.ts";

/** 八项的事实拼句、修法、名字：319b 时写在这里，409 挪进了协议包（守护进程也要拼），这里照旧能取 */
export { doctorCheckTitle, doctorFactText, doctorFixText } from "../state/index.ts";

/** 取一遍：打开页面时、点"再查一遍"时、换了语言时都走这一条（每次现查，不缓存） */
export function loadDoctor(http: Pick<DaemonHttp, "doctor">): Promise<DoctorView> {
  return http.doctor();
}

/** 五种结果的叫法（正常、注意、坏了、没查出来、不适用） */
export function doctorLevelText(level: DoctorLevel): string {
  return t(`doctor.level.${level}`);
}

/** 总状态那几句：坏了几项、要注意几项（都没有是"都正常"），没查出来的另起一句（灰字，不算进总状态） */
export function doctorSummary(view: DoctorView): Array<{ level: DoctorLevel; text: string }> {
  const { error, warn, unknown } = view.counts;
  const out: Array<{ level: DoctorLevel; text: string }> = [];
  if (error > 0) out.push({ level: "error", text: t("doctor.summary.error", { count: error }) });
  if (warn > 0) out.push({ level: "warn", text: t("doctor.summary.warn", { count: warn }) });
  if (out.length === 0) out.push({ level: "ok", text: t("doctor.summary.ok") });
  if (unknown > 0) out.push({ level: "unknown", text: t("doctor.summary.unknown", { count: unknown }) });
  return out;
}

/** "从什么时候起"那一句（本地的月日和时刻） */
export function doctorSinceText(since: string): string {
  return t("doctor.since", { time: formatDate(since, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) });
}

/** 后台盯着（416）里点了"不再提醒"的一项："11/6 21:40 起不再提醒" */
export function doctorMutedAtText(at: string): string {
  return t("doctor.watch.mutedAt", { time: formatDate(at, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) });
}

/** 停用、移除了的插件那一行；没有是 undefined */
export function doctorOffText(view: DoctorView): string | undefined {
  return view.off.length === 0 ? undefined : t("doctor.off", { plugins: formatList(view.off.map((plugin) => plugin.title)) });
}

/** 网页认得这个动作没有（不认得的不画按钮：守护进程比网页新时） */
export function knownDoctorAction(action: DoctorAction | undefined): action is DoctorAction {
  return action !== undefined && (DOCTOR_ACTION_KINDS as readonly string[]).includes(action.kind);
}

/** 动作按钮上的字：跳过去看是"去看看"，打开本机的网址（服务管家的网页，410）是"打开服务管家"，压缩是"现在压缩"（busy：正在压） */
export function doctorActionText(action: DoctorAction, busy = false): string {
  if (action.kind === "compact") return busy ? t("doctor.action.compacting") : t("doctor.action.compact");
  return doctorOpensUrl(action.route) ? t("doctor.action.openManager") : t("doctor.action.open");
}

/** 查的时刻写成一句话（本地日期和时间） */
export function doctorAtText(view: DoctorView): string {
  return t("doctor.at", { time: formatDate(view.at, { dateStyle: "short", timeStyle: "medium" }) });
}

// ───────── 深度体检（415）：点了才跑、真试一遍。结果在守护进程内存里，打开页面只取上一次的（不跑）；正在测时每秒取一次 ─────────

/** 取上一次的深度体检（打开页面、换了语言时；不跑） */
export function loadDoctorDeep(http: Pick<DaemonHttp, "doctorDeep">): Promise<DoctorDeepView> {
  return http.doctorDeep();
}

/** 开测（点了"深度体检""再测一遍"） */
export function startDoctorDeep(http: Pick<DaemonHttp, "startDoctorDeep">): Promise<DoctorDeepView> {
  return http.startDoctorDeep();
}

/**
 * 守护进程的"此刻"：取到那一份时它报的 now，加上取到以后本机走过的时间——"几分钟前测的"、"几秒后能再测"按守护进程的时钟算，
 * 手机自己的时钟不准也不要紧
 */
export function doctorDeepNow(view: Pick<DoctorDeepView, "now">, fetchedAt: number, localNow: number): number {
  return Date.parse(view.now) + Math.max(0, localNow - fetchedAt);
}

/** 测完的时刻写成"刚测的""3 分钟前测的""2 小时前测的"，一天以上写日期 */
export function doctorDeepAgoText(finishedAt: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(finishedAt));
  if (ms < 60_000) return t("doctor.deep.justNow");
  if (ms < 3_600_000) return t("doctor.deep.minutesAgo", { count: Math.floor(ms / 60_000) });
  if (ms < 86_400_000) return t("doctor.deep.hoursAgo", { count: Math.floor(ms / 3_600_000) });
  return t("doctor.deep.at", { time: formatDate(finishedAt, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) });
}

/** 还要等几秒才能再测（防连点）；现在就能测是 0 */
export function doctorDeepWaitSeconds(view: Pick<DoctorDeepView, "nextAt">, now: number): number {
  if (view.nextAt === undefined) return 0;
  const ms = Date.parse(view.nextAt) - now;
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

/** 按钮上的字：正在测、几秒后能再测、第一次是"深度体检"、测过的是"再测一遍" */
export function doctorDeepButtonText(view: DoctorDeepView | undefined, now: number): string {
  if (view?.state === "running") return t("doctor.deep.running");
  const wait = view === undefined ? 0 : doctorDeepWaitSeconds(view, now);
  if (wait > 0) return t("doctor.deep.cooldown", { seconds: wait });
  return view?.state === "done" ? t("doctor.deep.again") : t("doctor.deep.start");
}

/** 状态那一句：还没做过；正在测（几项里测完了几项）；测完了是"几分钟前测的" */
export function doctorDeepStatusText(view: DoctorDeepView, now: number): string {
  if (view.state === "never") return t("doctor.deep.never");
  if (view.state === "running") return t("doctor.deep.progress", { done: view.items.filter((entry) => entry.state === "done").length, total: view.items.length });
  if (view.items.length === 0) return t("doctor.deep.empty");
  return doctorDeepAgoText(view.finishedAt ?? view.now, now);
}

/** 测完了的总状态那几句（和平时体检同一套：坏了几项、要注意几项、都正常、没查出来的另起）；没测完、没做过是空的 */
export function doctorDeepSummary(view: DoctorDeepView): Array<{ level: DoctorLevel; text: string }> {
  if (view.state !== "done" || view.items.length === 0) return [];
  return doctorSummary({ counts: view.counts } as DoctorView);
}

/** 深度体检的一块：哪一块、标题、测完的里最差的（全在测是 undefined）、这一块的各项（照守护进程给的先后） */
export interface DoctorDeepGroup {
  id: string;
  title: string;
  level: DoctorLevel | undefined;
  entries: DoctorDeepItemView[];
}

/** 按块分好：块的先后照各项第一次出现的先后（守护进程给的是二狗本身在前、插件按清单） */
export function doctorDeepGroups(view: DoctorDeepView): DoctorDeepGroup[] {
  const groups: DoctorDeepGroup[] = [];
  for (const entry of view.items) {
    let group = groups.find((g) => g.id === entry.group);
    if (!group) {
      group = { id: entry.group, title: entry.groupTitle, level: undefined, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  for (const group of groups) {
    const done = group.entries.flatMap((entry) => (entry.item === undefined ? [] : [entry.item.level]));
    group.level = done.length === 0 ? undefined : worstLevel(done);
  }
  return groups;
}

