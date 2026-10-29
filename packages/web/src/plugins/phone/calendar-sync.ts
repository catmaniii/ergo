// 手机日历同步一次（299 号票）：在鸿蒙 App 里，网页经原生桥读手机日历、交给守护进程（"手机 · 日历"这个数据源）。纯逻辑，测试换假的
// 原生桥和 HTTP。两种：
// - 连上（link）：用户在数据源页点了"连上手机日历"——先要授权（系统的授权框；拒过的拉起二次授权），给了就读同步范围、交过去
//   （带 link，守护进程记下连着了）；没给就不交，告诉用户；
// - 平常（App 开着时每 30 分钟、回到前台、点"现在同步"）：先问守护进程连没连着（没连着、插件没启用、导入关着都不做）；
//   授权给着就读、交；被撤回了交一次状况和原因（守护进程那边已经写着出错的不再交），之后等用户在手机设置里重新打开；
// - 306 号票：用户点"现在同步"（userAction）而授权没给着：先再要一次（系统的授权框；拒过、在设置里关掉的拉起二次授权），给了就照常读、交
//   （守护进程那边回到连着）；还是没给照上面那样交状况和原因，已经写着出错的回"还是没给"。后台的同步不弹框。
import type { NativePhone } from "../../app/native-phone.ts";
import { type DataSourcePushResult, type DataSourcesView, nowIso, PHONE_CALENDAR_SOURCE, type PhoneCalendarPush, phoneCalendarWindow, t } from "../../state/index.ts";

export interface PhoneCalendarSyncDeps {
  phone: NativePhone;
  http: { dataSources(): Promise<DataSourcesView>; dataSourcePush(id: string, body: { data: PhoneCalendarPush; idempotencyKey: string }): Promise<DataSourcePushResult> };
  now: () => Date;
  newKey: () => string;
}

/** 同步一次的结果：没做（为什么）、没给授权（连上时；点"现在同步"再要了一次还是没给的是 again）、交过去了（守护进程回的） */
export type PhoneCalendarSyncOutcome =
  | { kind: "skipped"; why: "not_linked" | "plugin_off" | "import_off" | "already_reported" }
  | { kind: "denied"; again?: true }
  | { kind: "unreadable"; message?: string }
  | { kind: "pushed"; result: DataSourcePushResult; state: PhoneCalendarPush["state"] };

/**
 * 同步一次；link 为真是用户点了"连上手机日历"，userAction 为真是用户点了"现在同步"（授权没给着时再要一次，306 号票）。
 * 守护进程拒收、网络出错时抛错（message 是原因）
 */
export async function syncPhoneCalendar(deps: PhoneCalendarSyncDeps, options: { link?: boolean; userAction?: boolean } = {}): Promise<PhoneCalendarSyncOutcome> {
  const { phone, http } = deps;
  const link = options.link === true;
  const userAction = link || options.userAction === true;
  let reported = false;
  if (!link) {
    const source = (await http.dataSources()).sources.find((s) => s.id === PHONE_CALENDAR_SOURCE);
    if (!source || !source.available) return { kind: "skipped", why: "plugin_off" };
    if (source.connection === "not_connected") return { kind: "skipped", why: "not_linked" };
    if (!source.usages.some((u) => u.usage === "import" && u.on)) return { kind: "skipped", why: "import_off" };
    reported = source.connection === "error";
  }
  let state = phone.calendarState();
  // 用户点的（连上、现在同步）：没给着就再要一次（拒过、撤回了的拉起二次授权）
  if (userAction && state?.granted !== true) state = await phone.prepareCalendar(true);
  const device = state?.device;
  const push = async (data: PhoneCalendarPush, kind: PhoneCalendarPush["state"]): Promise<PhoneCalendarSyncOutcome> => ({
    kind: "pushed",
    state: kind,
    result: await http.dataSourcePush(PHONE_CALENDAR_SOURCE, { data, idempotencyKey: deps.newKey() }),
  });
  if (state?.granted !== true) {
    if (link) return { kind: "denied" };
    // 以前给过、现在没了：交一次状况（守护进程已经写着出错的不再交；点"现在同步"再要了一次还是没给的说一句）
    if (reported) return userAction ? { kind: "denied", again: true } : { kind: "skipped", why: "already_reported" };
    return push({ ...(device === undefined ? {} : { device }), state: "revoked", reason: t("ui.plugins.phone.calendar.revokedReason") }, "revoked");
  }
  const window = phoneCalendarWindow(deps.now());
  const read = await phone.readCalendar(window.from, window.to);
  if (!read.ok) {
    if (link) return read.state === "denied" ? { kind: "denied" } : { kind: "unreadable", ...(read.message === undefined ? {} : { message: read.message }) };
    if (reported) return { kind: "skipped", why: "already_reported" };
    return push({ ...(device === undefined ? {} : { device }), state: read.state === "denied" ? "revoked" : "unavailable", ...(read.message === undefined ? {} : { reason: read.message }) }, read.state === "denied" ? "revoked" : "unavailable");
  }
  return push({ ...(device === undefined ? {} : { device }), state: "granted", ...(link ? { link: true } : {}), from: nowIso(window.from), to: nowIso(window.to), events: read.events }, "granted");
}
