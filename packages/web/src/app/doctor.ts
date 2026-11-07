// 体检（319b、409）在网页上的这一半里"不碰浏览器"的那部分：取一遍（loadDoctor：经 DaemonHttp 的 GET /api/doctor，
// 演示页是原型的假 HTTP，prototype/fake-doctor.ts）、总状态那几句、五种结果的叫法、"从什么时候起"、停用的插件那一行、
// 动作按钮上的字、查的时刻。每项的句子守护进程已经按当前语言拼好了（DoctorItemView 的 text——插件的文案键在插件自己的
// 语言文件里，网页的词典里没有那些区域），这里照着显示，不自己拼。真相在守护进程，这边一个字节也不存。
// 这些函数都不碰 window、不引 React（Node 里直接查，test/pages/doctor.test.ts）：钩子在 app/page-doctor.ts。
import { DOCTOR_ACTION_KINDS, type DoctorAction, type DoctorLevel, doctorOpensUrl, type DoctorView, formatDate, formatList, t } from "../state/index.ts";
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
