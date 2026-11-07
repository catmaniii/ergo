// Looki 插件自己的体检项（414），在 setup 里经 ctx.doctor.register 登记，都是 passive（只读内存里的状态）。
// 二狗已经替它生成的不再重复（doctor/auto.ts）：插件本身在不在跑；数据源 Looki 那一项——Key 不认（needsAuth）是坏了，
// 每天 02:30 的定期导入超过 26 小时没同步成功是注意（数据源登记的 usages.import.staleAfterMs），最近一次同步出错是注意。
// 这里只加数据源那一项看不到的：
// - archive（存一份到本地）：没开（或者几类都关着）→ 不适用；那一块写着出了问题（problem：磁盘满、没权限、位置不在停下了，Looki 回的不对——
//   比如"Looki 换了接口"，424 起列 vlog 的出错也写在这里，照片、日记照常存）→ 注意，事实照抄原因原文；有时刻试了几次都没存下来（failed）→ 注意；
//   别的正常（写上次存下东西的时间）。动作跳到数据源 Looki 的详情（"存一份到本地"那一块在那里）。
// 判法是纯函数（archiveFinding），测试直接喂 LookiArchiveView。
import type { LookiArchiveView } from "@ergo/protocol";
import type { DoctorCheck, DoctorFinding } from "../doctor/checks.ts";
import { doctorTime } from "../doctor/auto.ts";
import { LOOKI_SOURCE_ID } from "./api.ts";

/** 数据源 Looki 的详情（"存一份到本地"那一块在这里） */
const LOOKI_ROUTE = `#/more/data-sources/${LOOKI_SOURCE_ID}`;

/** "存一份到本地"现在怎么样 */
export function archiveFinding(view: LookiArchiveView): DoctorFinding {
  const kindsOn = Object.values(view.kinds).some(Boolean);
  if (!view.on || !kindsOn) return { level: "na", fact: { key: "looki.doctor.archive.off" } };
  const open = { kind: "open" as const, route: LOOKI_ROUTE };
  if (view.problem !== undefined) return { level: "warn", fact: { key: "looki.doctor.archive.problem", params: { problem: view.problem } }, fix: { key: "looki.doctor.archive.fixProblem" }, action: open };
  if (view.failed > 0) return { level: "warn", fact: { key: "looki.doctor.archive.failed", params: { count: view.failed } }, fix: { key: "looki.doctor.archive.fixFailed" }, action: open };
  if (view.lastSavedAt === undefined) return { level: "ok", fact: { key: "looki.doctor.archive.never" } };
  return { level: "ok", fact: { key: "looki.doctor.archive.ok", params: { time: doctorTime(view.lastSavedAt) } } };
}

/** "存一份到本地"那一项：view 现取（插件的服务） */
export function lookiArchiveCheck(view: () => LookiArchiveView): DoctorCheck {
  return { id: "archive", title: "looki.doctor.archive.title", cost: "passive", run: () => archiveFinding(view()) };
}
