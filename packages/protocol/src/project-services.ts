// 项目的服务（133 号票）：运营手段"服务"生效之后，服务在 LSM 上的样子——二狗替它做到哪了（上线、失败、要手动、撤下），
// LSM 推来的在不在线，有网页的入口（/apps/<应用名>/…）。守护进程按项目、服务现算（project-services/），
// 经项目列表频道的临时事件 project_services 推给前端（订阅时补推一次全量），项目卡、项目页、两张运营方案的卡、秘书给的入口卡都看它。
// 名字、说法、能不能点开，守护进程（秘书的看板、工具结果）和 Web 用同一份。不引用 TypeBox。
// 257 号票：使用中的项目在项目卡片、项目页上有"启动""关闭"两个按钮（秘书也走同一个入口），经 LSM 把这个项目的服务全部拉起或全部关掉；
// 关了就一直关着（取消开机自启），直到再点启动。一个服务关着、在启动 / 关闭的说法，一个项目的开关现在什么样（projectPower）也在这里。
import { forModel, t, tTable } from "./i18n/runtime.ts";

/** 项目的服务全部启动、全部关闭（257 号票：项目卡片、项目页上的两个按钮，秘书的工具也是它） */
export const PROJECT_SERVICES_ACTIONS = ["start", "stop"] as const;
export type ProjectServicesAction = (typeof PROJECT_SERVICES_ACTIONS)[number];

/**
 * 二狗替它做到哪了：
 * - pending 正在上线（交给 LSM 登记、启动；LSM 还没连上时也是它）；live 上线了（LSM 里登记着、启动过；之后在不在线看 status）；
 * - failed 上线失败（原因来自 LSM：端口撞了、命令起不来、健康检查不过……）；
 * - manual 要你手动（LSM 版本不支持名下的服务，或者二狗不是由 LSM 启动的）：不假装生效，LSM 升级、重新接上后二狗自动补上；
 * - withdrawing 正在撤下（方案里去掉了、项目停用或归档了）；withdrawn 已撤下；withdraw_failed 撤下失败（原因来自 LSM）
 */
export const SERVICE_ROLLOUTS = ["pending", "live", "failed", "manual", "withdrawing", "withdrawn", "withdraw_failed"] as const;
export type ServiceRollout = (typeof SERVICE_ROLLOUTS)[number];

/**
 * LSM 推来的在不在线（上线了的才看它）：online 在线（在跑、健康检查没挂）、starting 启动中、stopping 停止中、offline 离线（停着）、
 * failed 失败（起不来、健康检查不过、挂了）、missing LSM 里没有它了（被手动撤销了）、unknown 不知道（LSM 没连上、还没推过来）
 */
export const SERVICE_STATUSES = ["online", "starting", "stopping", "offline", "failed", "missing", "unknown"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/** 项目的一个服务 */
export interface ProjectServiceView {
  projectId: string;
  /** 运营方案里这一条的 key */
  key: string;
  /** 这一条的名字（入口上写"打开「X」"） */
  title: string;
  /** 维护者写的服务名 */
  name: string;
  /** LSM 里的名字、转发的应用名（<项目编号>-<服务名>） */
  app: string;
  port: number;
  autostart: boolean;
  /** 有网页的：入口打开的地址（/apps/<应用名>/<首页>） */
  url?: string;
  rollout: ServiceRollout;
  /** 上线失败、要你手动、撤下失败的原因 */
  reason?: string;
  status: ServiceStatus;
  /** LSM 给的说明（起不来的原因、健康检查的结果……） */
  detail?: string;
  /**
   * 有网页的：首页缩略图的截图时间（140 号票，守护进程自己用无头浏览器截的，按项目和服务名经 HTTP_PATHS.serviceThumbnail 取）；
   * 还没截过、截不成的没有。撤下了的照样留着最后一张（项目停用后项目页上灰着显示）
   */
  thumbnailAt?: string;
  /**
   * 257：这个项目的服务被你关着（点了"关闭"，或者秘书照你说的关了）——LSM 里停着、开机自启取消了，二狗、电脑重启后也不起来，
   * 直到再点"启动"。没关过、又启动了的没有。不是停用：项目照旧使用中
   */
  paused?: boolean;
  /** 257：你点的"启动""关闭"这一个服务还没做完（在经 LSM 拉起 / 停掉）；做完了没有 */
  power?: "starting" | "stopping";
  /** 257：关闭没做成的原因（LSM 回的）；启动没做成的照"上线失败"写在 reason 里 */
  powerReason?: string;
}

/** 服务首页的缩略图多久算旧（140 号票）：有人看的时候比这旧的补截一张，所以之后最多这么久截一次 */
export const SERVICE_THUMBNAIL_REFRESH_MS = 6 * 60 * 60 * 1000;

/**
 * 缩略图地址里的 seen（140 号票）：手里没有、或者那张旧了（超过 SERVICE_THUMBNAIL_REFRESH_MS）时，按现在落在第几个 6 小时里给一个号，
 * 地址每 6 小时换一次——浏览器手里有同一个地址的图就不再请求，换了号才会发出"有人在看"的请求；新的那张还够新时不带（undefined）
 */
export function serviceThumbnailSeen(takenAt: string | undefined, nowMs: number): string | undefined {
  const taken = takenAt === undefined ? Number.NaN : Date.parse(takenAt);
  if (!Number.isNaN(taken) && nowMs - taken < SERVICE_THUMBNAIL_REFRESH_MS) return undefined;
  return String(Math.floor(nowMs / SERVICE_THUMBNAIL_REFRESH_MS));
}

/** 临时事件 project_services 的负载：现在全部的项目的服务（整份换掉） */
export interface ProjectServicesEventPayload {
  services: ProjectServiceView[];
}

/** 入口上的字 */
export const serviceOpenLabel = (title: string): string => t("protocol.projectServices.open", { title });

/** 状态的几种样子（界面上的颜色按它）：在线、离线、失败、在路上（上线中、启动中、撤下中）、要你手动、已撤下 */
export type ServiceStateKind = "online" | "offline" | "failed" | "busy" | "manual" | "withdrawn";

const STATUS_TEXT: Readonly<Record<ServiceStatus, { kind: ServiceStateKind; text: () => string }>> = {
  online: { kind: "online", text: () => t("protocol.projectServices.status.online") },
  starting: { kind: "busy", text: () => t("protocol.projectServices.status.starting") },
  stopping: { kind: "busy", text: () => t("protocol.projectServices.status.stopping") },
  offline: { kind: "offline", text: () => t("protocol.projectServices.status.offline") },
  failed: { kind: "failed", text: () => t("protocol.projectServices.status.failed") },
  missing: { kind: "failed", text: () => t("protocol.projectServices.status.missing") },
  unknown: { kind: "offline", text: () => t("protocol.projectServices.status.unknown") },
};

/** 开关管得着的（257）：上线了、上线失败的（在 LSM 上登记过或该登记的）；上线中、要你手动、撤下的照原来的说 */
const powered = (rollout: ServiceRollout) => rollout === "live" || rollout === "failed";

type StateInput = Pick<ProjectServiceView, "rollout" | "status" | "reason" | "detail" | "paused" | "power" | "powerReason">;

/** 服务现在的样子：几个字和补充（原因、LSM 的说明）。257：在启动、关闭的写"启动中…""关闭中…"，你关着的写"已关闭" */
export function serviceStateText(view: StateInput): { kind: ServiceStateKind; text: string; detail?: string } {
  if (powered(view.rollout)) {
    if (view.power === "stopping") return { kind: "busy", text: t("protocol.projectServices.power.stopping") };
    if (view.power === "starting") return { kind: "busy", text: t("protocol.projectServices.power.starting") };
    if (view.paused) {
      return view.powerReason
        ? { kind: "failed", text: t("protocol.projectServices.power.stopFailed"), detail: view.powerReason }
        : { kind: "offline", text: t("protocol.projectServices.power.off") };
    }
  }
  const why = view.reason ? { detail: view.reason } : {};
  switch (view.rollout) {
    case "pending":
      return { kind: "busy", text: t("protocol.projectServices.rollout.pending") };
    case "failed":
      return { kind: "failed", text: t("protocol.projectServices.rollout.failed"), ...why };
    case "manual":
      return { kind: "manual", text: t("protocol.projectServices.rollout.manual"), ...why };
    case "withdrawing":
      return { kind: "busy", text: t("protocol.projectServices.rollout.withdrawing") };
    case "withdrawn":
      return { kind: "withdrawn", text: t("protocol.projectServices.rollout.withdrawn") };
    case "withdraw_failed":
      return { kind: "failed", text: t("protocol.projectServices.rollout.withdrawFailed"), ...why };
    case "live": {
      const s = STATUS_TEXT[view.status];
      return { kind: s.kind, text: s.text(), ...(view.detail && view.status !== "online" ? { detail: view.detail } : {}) };
    }
  }
}

/** 一行写清（秘书的看板、工具结果）："服务「简报站」（p-1 · 端口 8899）：在线，入口 /apps/p-1-web/" */
export function serviceLine(view: ProjectServiceView): string {
  // 只给模型看（秘书的看板、工具结果）：照旧中文
  const state = forModel(() => serviceStateText(view));
  return `服务「${view.title}」（${view.projectId} · ${view.app} · 端口 ${view.port}）：${state.text}${state.detail ? `（${state.detail}）` : ""}${view.url && serviceCanOpen(view) ? `，入口 ${view.url}` : ""}`; // @i18n-ignore model
}

/** 入口能不能点开：上线了、有网页（转发登记着；不在线时转发给出"现在没在运行"的说明页） */
export function serviceCanOpen(view: Pick<ProjectServiceView, "rollout" | "url">): boolean {
  return view.rollout === "live" && view.url !== undefined;
}

/** 还算在这个项目上的（入口、状态要显示的）：撤下了的不算 */
export function serviceShown(view: Pick<ProjectServiceView, "rollout">): boolean {
  return view.rollout !== "withdrawn";
}

/**
 * 一个项目的服务开关现在什么样（257）：online 全部在线、off 你关着、starting 启动中、stopping 关闭中、failed 上线 / 启动失败或挂了、
 * stopFailed 关闭没做成、offline 有的停着、unknown 不知道（LSM 没连上）
 */
export type ProjectPowerState = "online" | "off" | "starting" | "stopping" | "failed" | "stopFailed" | "offline" | "unknown";

/** 项目卡片、项目页上"启动""关闭"那一块 */
export interface ProjectPowerView {
  state: ProjectPowerState;
  /** "在线"、"已关闭"、"启动中…"…… */
  text: string;
  /** 失败的原因（几个服务时写是哪一个） */
  detail?: string;
  /** "启动"能不能点：全部在线、正在启动时不能 */
  canStart: boolean;
  /** "关闭"能不能点：关着、正在关闭时不能 */
  canStop: boolean;
  /** 两个都不能点的原因：LSM 没连上、LSM 版本不支持、二狗不是由 LSM 启动的 */
  blocked?: string;
}

/** 开关那一块写的几个字 */
const POWER_STATE_TEXT: Readonly<Record<ProjectPowerState, string>> = tTable({
  online: "protocol.projectServices.power.state.online",
  off: "protocol.projectServices.power.state.off",
  starting: "protocol.projectServices.power.state.starting",
  stopping: "protocol.projectServices.power.state.stopping",
  failed: "protocol.projectServices.power.state.failed",
  stopFailed: "protocol.projectServices.power.state.stopFailed",
  offline: "protocol.projectServices.power.state.offline",
  unknown: "protocol.projectServices.power.state.unknown",
});

/**
 * 一个项目的服务开关（257）：只有使用中的项目、有在 LSM 上的服务（撤下了的、撤下中的不算）才有，别的是 undefined。
 * 一拉起就是全部拉起、一关就是全部关掉，所以按整个项目说；按钮按下去之后守护进程照最新的那一下做，启动中也能点"关闭"，反过来一样
 */
export function projectPower(projectState: string, views: readonly ProjectServiceView[]): ProjectPowerView | undefined {
  if (projectState !== "in_use") return undefined;
  const on = views.filter((v) => v.rollout !== "withdrawn" && v.rollout !== "withdrawing");
  if (on.length === 0) return undefined;
  /** 几个服务时原因前面写是哪一个 */
  const which = (v: ProjectServiceView, detail: string) => (on.length > 1 ? t("protocol.projectServices.power.which", { title: v.title, detail }) : detail);
  const manual = on.find((v) => v.rollout === "manual");
  const blocked = manual ? (manual.reason ?? t("protocol.projectServices.rollout.manual")) : on.every((v) => v.status === "unknown") ? t("protocol.projectServices.power.lsmUnknown") : undefined;
  const state = ((): { state: ProjectPowerState; detail?: string } => {
    if (on.some((v) => v.paused)) {
      if (on.some((v) => v.power === "stopping")) return { state: "stopping" };
      const stuck = on.find((v) => v.powerReason);
      return stuck?.powerReason ? { state: "stopFailed", detail: which(stuck, stuck.powerReason) } : { state: "off" };
    }
    if (on.some((v) => v.power === "starting" || v.rollout === "pending")) return { state: "starting" };
    const broken = on.find((v) => v.rollout === "failed" || (v.rollout === "live" && (v.status === "failed" || v.status === "missing")));
    if (broken) {
      const why = broken.rollout === "failed" ? broken.reason : (broken.detail ?? serviceStateText(broken).text);
      return why ? { state: "failed", detail: which(broken, why) } : { state: "failed" };
    }
    if (on.every((v) => v.rollout === "live" && v.status === "online")) return { state: "online" };
    if (on.some((v) => v.status === "unknown")) return { state: "unknown" };
    return { state: "offline" };
  })();
  return {
    ...state,
    text: POWER_STATE_TEXT[state.state],
    canStart: blocked === undefined && state.state !== "online" && state.state !== "starting",
    canStop: blocked === undefined && state.state !== "off" && state.state !== "stopping",
    ...(blocked === undefined ? {} : { blocked }),
  };
}
