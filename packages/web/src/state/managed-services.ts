// 设置 · 服务（428）页面要的纯函数：服务管家里和二狗有关的服务，状态、用途、受保护的原因按当前语言说成话；
// 每个服务现在能点哪些操作、点了要不要先弹确认框；操作的结果说成一句。不碰 DOM、不引 React（测试在 Node 里直接调）。
// 能不能做由守护进程和服务管家最后裁决（受保护的本地先拒、服务管家回 protected），这里只决定页面上露出哪些按钮。
import { uptimeText } from "./debug-tools.ts";
import { type ErgoUse, MANAGED_SERVICE_CONFIRM_ACTIONS, type ManagedServiceAction, type ManagedServiceActionResult, type ManagedServiceProtection, type ManagedServiceView, t } from "./protocol.ts";

/** 服务管家的状态在语言文件里的名字（key 的段用小驼峰） */
const STATE_KEY: Readonly<Record<string, string>> = {
  RUNNING: "running",
  DEGRADED: "degraded",
  STARTING: "starting",
  STOPPING: "stopping",
  STOPPED: "stopped",
  FAILED: "failed",
  ORPHAN: "orphan",
};

/** 状态说成人话（认不得的照原样） */
export function managedServiceStateText(state: string): string {
  const key = Object.hasOwn(STATE_KEY, state) ? STATE_KEY[state] : undefined;
  return key === undefined ? state : t(`pages.services.state.${key}`);
}

/** 状态的颜色档：ok 在跑；warn 在跑但有问题、端口被别人占着；bad 出错了；busy 正在起、正在停；idle 停着 */
export type ManagedServiceTone = "ok" | "warn" | "bad" | "busy" | "idle";
export function managedServiceStateTone(state: string): ManagedServiceTone {
  switch (state) {
    case "RUNNING":
      return "ok";
    case "DEGRADED":
    case "ORPHAN":
      return "warn";
    case "FAILED":
      return "bad";
    case "STARTING":
    case "STOPPING":
      return "busy";
    default:
      return "idle";
  }
}

/** 为什么和二狗有关（用途）说成人话 */
export function managedServiceUseText(use: ErgoUse): string {
  return t(`pages.services.use.${use}`);
}

/** 受保护的原因：二狗自己、外网隧道、tailnet 网关写明；别的带上服务管家写的原因 */
export function managedServiceProtectionText(protection: ManagedServiceProtection): string {
  if (protection.kind !== "other") return t(`pages.services.protected.${protection.kind}`);
  return t("pages.services.protected.other", { why: protection.why.join(t("pages.services.listSep")) || "—" });
}

/** 端口、在跑多久这一行的几段（没有的不写） */
export function managedServiceMeta(s: ManagedServiceView, now: number): string[] {
  return [...(s.port === null ? [] : [t("pages.services.port", { port: s.port })]), ...(s.up && s.since !== null ? [t("pages.services.upFor", { duration: uptimeText(now - s.since) })] : [])];
}

/**
 * 现在能点的操作（开机自启开关另算，见 managedServiceAutostartLocked）：
 * - 没在跑（停着、出错了、端口被别人占着）：启动；
 * - 在跑：停止、重启，有正常停止办法的再多一个强制停止（先确认）；受保护的这几样都没有；
 * - 正在停（有正常停止办法、卡住了的）：强制停止；正在起：等它；
 * - 挂着"等空闲再停"：取消（受保护的也能取消，不停东西）。
 */
export function managedServiceActions(s: ManagedServiceView): ManagedServiceAction[] {
  const guarded = s.protection !== undefined;
  const out: ManagedServiceAction[] = [];
  if (s.up) {
    if (!guarded) out.push("stop", "restart", ...(s.canStop ? (["force_stop"] as const) : []));
  } else if (s.state === "STOPPING") {
    if (!guarded && s.canStop) out.push("force_stop");
  } else if (s.state !== "STARTING") {
    out.push("start");
  }
  if (s.pendingStop) out.push("cancel_stop");
  return out;
}

/** 开机自启的开关点不动：受保护的开着时不能关（关掉要在服务管家的网页上自己做） */
export function managedServiceAutostartLocked(s: ManagedServiceView): boolean {
  return s.protection !== undefined && s.autostart;
}

/** 点了先弹确认框的：强制停、关开机自启 */
export function managedServiceActionNeedsConfirm(action: ManagedServiceAction): boolean {
  return MANAGED_SERVICE_CONFIRM_ACTIONS.includes(action);
}

/** 按钮上的字 */
export function managedServiceActionLabel(action: ManagedServiceAction): string {
  return t(`pages.services.action.${ACTION_KEY[action]}`);
}

const ACTION_KEY: Readonly<Record<ManagedServiceAction, string>> = {
  start: "start",
  stop: "stop",
  force_stop: "forceStop",
  restart: "restart",
  cancel_stop: "cancelStop",
  autostart_on: "autostartOn",
  autostart_off: "autostartOff",
};

/** 确认框的标题、正文、按钮（只有要确认的两种） */
export function managedServiceConfirmText(action: ManagedServiceAction, name: string): { title: string; body: string; ok: string } {
  const key = action === "force_stop" ? "forceStop" : "autostartOff";
  return { title: t(`pages.services.confirm.${key}Title`, { name }), body: t(`pages.services.confirm.${key}Body`), ok: t(`pages.services.confirm.${key}Ok`) };
}

/** 一个服务的称呼：登记里的名字，和 id 不一样时带上 id */
export function managedServiceName(s: Pick<ManagedServiceView, "id" | "title">): string {
  return s.title && s.title !== s.id ? t("pages.services.named", { title: s.title, id: s.id }) : s.id;
}

/** 操作的结果说成一句：成了说做了什么（服务管家另外交代的跟在后面），没成照实说原因 */
export function managedServiceResultText(result: ManagedServiceActionResult, name: string, protection?: ManagedServiceProtection): { ok: boolean; text: string } {
  if (result.ok) {
    const { action } = result;
    let said: string;
    if (result.forced) said = t(action === "restart" ? "pages.services.done.forcedRestart" : "pages.services.done.forcedStop", { name });
    else if (result.pending) said = t("pages.services.done.pending", { name });
    else if (result.already) said = t(action === "start" ? "pages.services.done.alreadyUp" : action === "stop" || action === "force_stop" ? "pages.services.done.alreadyStopped" : "pages.services.done.already", { name });
    else said = t(`pages.services.done.${ACTION_KEY[action]}`, { name });
    return { ok: true, text: result.note ? `${said} ${t("pages.services.managerNote", { note: result.note })}` : said };
  }
  switch (result.code) {
    case "protected": {
      const why = protection ? managedServiceProtectionText(protection) : t("pages.services.protected.other", { why: result.message || "—" });
      return { ok: false, text: t("pages.services.err.protected", { why }) };
    }
    case "not-related":
      return { ok: false, text: t("pages.services.err.notRelated", { name }) };
    case "not-linked":
      return { ok: false, text: t("pages.services.err.notLinked") };
    case "not-connected":
    case "closed":
      return { ok: false, text: t("pages.services.err.notConnected") };
    case "unsupported":
      return { ok: false, text: t("pages.services.err.unsupported") };
    case "timeout":
      return { ok: false, text: t("pages.services.err.timeout") };
    case "disconnected":
      return { ok: false, text: t("pages.services.err.disconnected") };
    default:
      return { ok: false, text: t("pages.services.err.other", { message: result.message || result.code }) };
  }
}
