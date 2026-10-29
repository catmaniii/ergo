// 项目的服务（133 号票）：运营手段"服务"生效之后，替它到 LSM 上线、撤下，接 LSM 推来的状态，有网页的在转发登记表里登记。
// - 要求（service_desired，和确认运营方案、项目停用 / 重新启用同一事务追加）落盘之后，这里异步去做，一个服务一次只做一件
//   （同一个服务的要求排队，做的时候又来了新的就照最新的再做一遍，旧的结果不记）：
//   · 上线：经接入协议（LSM 的 link-protocol §7）登记 / 更新（put，整份替换，带开机自启）→ 没在跑的启动（等到就绪或失败）、在跑而
//     定义改了要重启的重启（force：二狗登记的服务没有停机命令）；在跑时改端口的先停再登记。成了在转发登记表里登记
//     /apps/<应用名>/（有网页的），之后在首页上跑一遍前缀下自检，有问题告诉维护者；
//   · 撤下：撤掉转发，LSM 里登记着的撤销（强制停、端口空了、拿掉登记）；
//   · LSM 版本不支持（welcome 里没有 services）、二狗不是由 LSM 启动的：记"要你手动"，不假装生效；LSM 还没连上的等连上再做。
//     重新接上（welcome 里有 services）时，没做完的、要你手动的、撤下失败的再做一遍（LSM 升级、重启后自动补上）；
//   · 做完记一条 service_rollout（上线了、上线失败及原因、要你手动、撤下了、撤下失败）；上线失败、要你手动的同一事务通知维护者。
// - LSM 推来的状态（services.status：接入时一次全量，之后只推变了的）只放内存：在线、启动中、离线、失败（及原因）……；LSM 没连上时
//   是"状态未知"。
// - 上线了的服务后来挂了（失败、停了、LSM 里没有了）持续一小段时间（outageGraceMs，默认 30 秒；中间启动中、停止中也算没好）才通知
//   维护者，写明 LSM 给的原因；又在线持续同样一段时间再说一声好了。重启一下、健康检查抖一下不报；同一次故障只报一次（报过的记一条
//   service_outage，守护进程重启了也不重报）；LSM 没连上（状态未知）时不判。用户那边照旧只在入口、项目页、秘书看板上标着。
// - 守护进程起来时（start）：上线了的、有网页的先在转发登记表里登记上（不等 LSM），没做完的接着做。
// - 给前端、秘书看的样子（ProjectServiceView）由派生视图和内存里的状态现算，变了就整份推一次（publish：项目列表频道的临时事件）。
// - 140 号票：有网页的服务首页的缩略图（thumbnails.ts 截、存）。这里定什么时候截：上线了并且在线（健康检查过了；上线时还没在线的
//   等它在线）、改了运营方案（确认了这个项目的新一份）、服务重启了（LSM 推来的状态从不在线变回在线；接上 LSM 时的第一份全量不算，
//   守护进程起来时不一口气截一堆）；取图的请求算"有人在看"，旧了（6 小时）、还没有的补一张。截出来的时间带在 ProjectServiceView 上。
// - 257 号票：项目卡片、项目页上的"启动""关闭"和秘书的工具都交给 power()：使用中、有在 LSM 上的服务、LSM 连着才收下（不然说清原因，
//   什么都不记），记一条 service_power（最新的一条算数），每个服务排进它那一串照最新的开关做：
//   · 关闭：取消开机自启、强制停（二狗登记的服务没有停机命令），记 service_power_done（关好了、没关成及原因；没关成的重新接上 LSM 时再关）；
//   · 启动：照定义整份重新登记（开机自启回到定义里的样子）、启动等到就绪——就是"上线"那一套，结果照样记 service_rollout（带 powerSeq），
//     起不来的就是上线失败（原因来自 LSM，通知维护者）；
//   · 关着的时候又要上线（改了方案、重新接上 LSM 补做）：登记时开机自启写关、不启动，在跑的停掉——关了就一直关着；
//   · 例外（用户 2026-10-24 定，259 号票）：关着的项目停用后重新启用（含取消归档回到使用中），重新启用就全部拉起——同一时刻记一条
//     "全部启动"（by user），重新上线照它做；
//   · 做的时候又点了：做完这一步，旧的结果不记，照最新的再做一遍；守护进程起来时没做完的接着做，做完了的什么都不动（关着的不拉起）；
//   · 关着、还在启动 / 关闭的不看挂没挂（不通知维护者）；转发照样登记着，打开是"服务没在线"的说明页。
// - 269 号票（用户 2026-10-25 定"二狗自己兜底"：电脑重启后 LSM 没按开机自启拉服务，使用中的项目服务一直停着）：二狗接上 LSM
//   （守护进程起来、LSM 重新接上，welcome 里有 services）时，记下上线了、用户没关（开关不是关着、不在启动 / 关闭中）、项目使用中的
//   服务；接上后的第一份全量里它没在跑（停着、失败、LSM 里没有了；启动中、停止中的是 LSM 自己在弄，不动）就排进它那一串，照"上线"
//   那一套整份登记、启动等到就绪，结果记 service_rollout（revive: true），起不来的通知维护者。只在接上时做一次：之后挂了照上面的故障
//   通知走，不自动反复拉（免得和 LSM 的挂了自动重启打架）；拉的时候不看挂没挂；还在上线中的、要你手动的照 133 补做，不算在里面。
//   start() 在接入层建好、还没连上时叫（组合根里紧跟着 linkToLsm），所以守护进程起来那一次也是收到 welcome 时记下。
// - 324 号票：同一份全量里在跑的（RUNNING / DEGRADED）照现在的方案整份再登记一次（resync）——同一份定义 LSM 不改；二狗换了 Node
//   这类让定义变了的（命令开头的 node 换成二狗自己那份），LSM 回 restartNeeded，强制重启一次让它用上。不记事件，只记日志；
//   重启时不看挂没挂（和兜底拉起同一套）。
import {
  CHANNELS,
  EVENT_TYPES,
  maintainerChannel,
  type Project,
  type ProjectEventPayload,
  type ProjectServicesAction,
  type ProjectServicesActionResult,
  type ProjectServiceView,
  type ServiceStatus,
  t,
} from "@ergo/protocol";
import type { AppRegistry } from "../apps/registry.ts";
import type { PrefixCheckResult } from "../apps/prefix-check.ts";
import { prefixCheckReport } from "../apps/prefix-check.ts";
import { buildAgentNotice } from "../conversation/messages.ts";
import type { EventStore, NewEvent } from "../events/event-store.ts";
import { RequestRejected } from "../errors.ts";
import type { LsmServices, LsmServicesReply, LsmServicesStatusMessage, LsmServiceStatus } from "../lsm/link.ts";
import { OPERATIONS_CHANNEL, OPERATIONS_EVENTS, type OperationsDecidedPayload } from "../projects/api.ts";
import type { Clock } from "../scheduler/clock.ts";
import {
  PROJECT_SERVICE_EVENTS,
  type ServiceOutagePayload,
  type ServicePowerBy,
  type ServicePowerDonePayload,
  type ServicePowerPayload,
  type ServiceRolloutPayload,
  type ServiceRolloutState,
} from "./events.ts";
import { lsmDefinition, serviceUrl } from "./spec.ts";
import { createServiceThumbnails, type ThumbnailReason } from "./thumbnails.ts";
import { noticeText, outageReasonText, powerText, rolloutText } from "./texts.ts";
import { type ServiceRow, servicePower, serviceRow, serviceRows } from "./views.ts";

export interface ProjectServicesOptions {
  store: EventStore;
  /** 接入 LSM 的名下服务（接入层建在后面：用到时现取） */
  lsm: () => LsmServices;
  /** 转发登记表（132 号票）的登记口：和插件宿主给插件的 ctx.apps 同一套（280 号票：只要登记，撤销函数自己收着） */
  apps: Pick<AppRegistry, "register">;
  /** 数据目录的密钥区（真实路径）：密钥的引用换成这里的文件 */
  secretsDir: string;
  /** 二狗自己那份 Node（守护进程的 process.execPath）：命令开头是 node 的换成它（spec 的 withOwnNode）；不给就原样登记 */
  nodePath?: string;
  /** 项目（名字、维护者、状态）；删掉的是 undefined */
  project: (projectId: string) => Project | undefined;
  /** 上线之后的前缀下自检（apps/prefix-check.ts 的 checkAppPrefix） */
  prefixCheck: (target: string, app: string, prefix: "strip" | "keep") => Promise<PrefixCheckResult>;
  /** 给前端、秘书看的样子变了：整份推一次 */
  publish: (services: ProjectServiceView[]) => void;
  /** 上线了的服务挂了 / 好了要持续多久才报（按这个时钟数） */
  clock: Clock;
  /** 挂了 / 又在线持续多久（毫秒）才报给维护者；不填是 SERVICE_OUTAGE_GRACE_MS */
  outageGraceMs?: number;
  /**
   * 服务首页的缩略图（140 号票）：存在哪（数据目录的缓存区）、怎么截（正式的用无头浏览器，测试注入假的）、二狗本机端口的地址
   * （网关开好之后才有：截的是经二狗转发的 /apps/<应用名>/）、一次最多截多久；不给就不截
   */
  thumbnails?: { dir: string; capture: (url: string, signal: AbortSignal) => Promise<Buffer>; baseUrl: () => string | undefined; timeoutMs?: number };
  now: () => string;
  log: (line: string) => void;
}

/** 上线了的服务不在线、又在线各要持续多久（毫秒）才报给维护者：LSM 重启一下、健康检查抖一下（LSM 自己也要连着两轮才判）不报 */
export const SERVICE_OUTAGE_GRACE_MS = 30_000;

export interface ProjectServices {
  /** 全部项目的服务（撤下了的也在：项目页上写"已撤下"），按项目、应用名 */
  view(): ProjectServiceView[];
  ofProject(projectId: string): ProjectServiceView[];
  /** LSM 推来的在不在线（LSM 没连上、还没推过来是 unknown） */
  status(app: string): ServiceStatus;
  /**
   * 服务首页的缩略图（140 号票，取图的接口用）：按项目编号和服务名给文件和截图时间，没有是 undefined。顺带算"有人在看"：
   * 上线了、在线的，旧了（6 小时）、还没有的补截一张（截好了推一次新的样子）
   */
  thumbnail(projectId: string, name: string): { file: string; takenAt: string } | undefined;
  /**
   * 257：这个项目的服务全部启动 / 全部关闭（项目卡片、项目页上的按钮，秘书的工具）。使用中、有在 LSM 上的服务、LSM 连着才收下，
   * 不然抛 RequestRejected 说清原因（什么都不记）；收下了记一条开关，真的拉起、停掉在事务之后异步做。idempotencyKey 是请求的幂等键
   */
  power(projectId: string, action: ProjectServicesAction, by: ServicePowerBy, idempotencyKey: string): ProjectServicesActionResult;
  /** 257：等这个项目手上的都做完（秘书的工具说结果用），最多等 timeoutMs；做完了是 true */
  settled(projectId: string, timeoutMs: number): Promise<boolean>;
  /** 守护进程起来、接入层建好之后：上线了的先登记转发，订阅事件和 LSM 的状态，没做完的接着做 */
  start(): void;
  stop(): void;
  /** 手上的都做完（测试、停机前） */
  idle(): Promise<void>;
}

/** LSM 的回复里这几种是"连接没了 / 还没连上"：等重新接上再做，不记结果 */
const WAIT_CODES = new Set(["disconnected", "not-connected", "closed"]);

/** LSM 推来的一条状态 → 在不在线和说明 */
export function statusOf(s: LsmServiceStatus): { status: ServiceStatus; detail?: string } {
  const why = s.lastError || s.detail || undefined;
  switch (s.state) {
    case "RUNNING":
    case "DEGRADED":
      return s.health === "failing" ? { status: "failed", detail: why ?? t("projectServices.healthFailing") } : { status: "online" };
    case "STARTING":
      return { status: "starting" };
    case "STOPPING":
      return { status: "stopping" };
    case "FAILED":
      return { status: "failed", ...(why ? { detail: why } : {}) };
    default:
      return { status: "offline", ...(s.detail ? { detail: s.detail } : {}) };
  }
}

/** LSM 回的失败写成一句原因：message，details 里逐条的接在后面，带着的服务状态里有起不来的原因的也接上 */
export function replyReason(reply: Extract<LsmServicesReply, { ok: false }>): string {
  const details = Array.isArray(reply.error.details) ? reply.error.details.filter((d): d is string => typeof d === "string") : [];
  const last = reply.service?.lastError && !reply.error.message.includes(reply.service.lastError) ? reply.service.lastError : undefined;
  return [reply.error.message, ...details, ...(last ? [last] : [])].join(t("projectServices.reasonSep"));
}

type Outcome = { state: ServiceRolloutState; reason?: string; registered: boolean };

/** LSM 回的失败 → 上线失败（连接没了的不记：等重新接上再做） */
const failed = (reply: Extract<LsmServicesReply, { ok: false }>, registered: boolean): Outcome | undefined => {
  if (WAIT_CODES.has(reply.error.code)) return undefined;
  return { state: "failed", reason: reply.error.code === "timeout" ? rolloutText.timeout() : replyReason(reply), registered };
};

/** 在不在线归成四种：在线、挂了（失败、停了、LSM 里没有了）、中间（启动中、停止中）、不知道（LSM 没连上） */
type Liveness = "up" | "down" | "between" | "unknown";
const livenessOf = (s: ServiceStatus): Liveness => {
  if (s === "online") return "up";
  if (s === "failed" || s === "offline" || s === "missing") return "down";
  return s === "unknown" ? "unknown" : "between";
};

/** 这一行做完了没有：没有结果的是还没做完；要你手动的、撤下失败的重新接上 LSM 时再做 */
const unfinished = (row: ServiceRow, retry: boolean): boolean =>
  row.rollout === undefined || (retry && ((row.rollout.state === "manual" && row.desired.present) || (row.rollout.state === "withdraw_failed" && !row.desired.present)));

/**
 * 257：这一行照现在的开关还要不要做——上线了、上线失败的（在 LSM 上登记过或该登记的）才归开关管，它做到的那一条比最新的旧；
 * 关闭没做成的重新接上 LSM 时（retry）再关
 */
const powerPending = (row: ServiceRow, power: { on: boolean; seq: number }, retry: boolean): boolean => {
  if (!row.desired.present || row.rollout === undefined || (row.rollout.state !== "live" && row.rollout.state !== "failed")) return false;
  if (row.powerSeq !== power.seq) return true;
  return retry && !power.on && row.powerFailed !== undefined;
};

/** 269：LSM 里没在跑（停着、失败、没人管的进程占着、LSM 里没有了）；启动中、停止中的是 LSM 自己在弄 */
const notRunning = (s: LsmServiceStatus | undefined): boolean => s === undefined || !["RUNNING", "DEGRADED", "STARTING", "STOPPING"].includes(s.state);

export function createProjectServices(options: ProjectServicesOptions): ProjectServices {
  const { store, apps, clock, log } = options;
  const outageGraceMs = options.outageGraceMs ?? SERVICE_OUTAGE_GRACE_MS;
  /** 应用名 → LSM 推来的状态 */
  const statuses = new Map<string, { status: ServiceStatus; detail?: string }>();
  /** 收到过全量推送（之后不在里面的就是 LSM 里没有了） */
  let haveFull = false;
  /** 应用名 → 排着的那一串（一个服务一次只做一件） */
  const chains = new Map<string, Promise<void>>();
  /** 应用名 → 转发登记表里的登记（撤销函数、登记的端口和前缀约定） */
  const proxied = new Map<string, { undo: () => void; port: number; prefix: string }>();
  const unsubscribe: Array<() => void> = [];
  /** 应用名 → 在等它挂了（down）/ 又在线（up）持续够久的计时器；等挂了的记着这期间 LSM 给过的最近一条原因 */
  const watches = new Map<string, { to: "down" | "up"; cancel: () => void; reason?: string }>();
  let started = false;
  let stopped = false;
  let published = "";
  /** 要截首页、还没在线的（140 号票）：上线了、改了方案，等它在线再截 */
  const shotPending = new Set<string>();
  /** 269：接上 LSM 时记下的、上线了而用户没关的服务（应用名）：等接上后的第一份全量，没在跑的拉起来；没接上、用过了是 undefined */
  let reviveOnFull: Set<string> | undefined;
  /** 269：排着、正在拉起来的（应用名 → 排着几次；拉的时候不看挂没挂） */
  const reviving = new Map<string, number>();

  const supported = () => options.lsm().support === "supported";

  const status = (app: string): ServiceStatus => {
    if (!supported()) return "unknown";
    const s = statuses.get(app);
    if (s) return s.status;
    return haveFull ? "missing" : "unknown";
  };

  const viewOf = (row: ServiceRow): ProjectServiceView => {
    const { desired } = row;
    const s = desired.service;
    const live = statuses.get(row.app);
    const url = serviceUrl(s);
    const thumbnailAt = url === undefined ? undefined : shots?.takenAt(row.app);
    // 257：你关着的、你点的启动 / 关闭还没做完的、关闭没做成的
    const power = servicePower(store.reader, row.projectId);
    const paused = desired.present && !power.on;
    const busy = powerPending(row, power, false);
    return {
      projectId: row.projectId,
      key: desired.key,
      title: desired.title,
      name: s.name,
      app: row.app,
      port: s.port,
      autostart: s.autostart,
      ...(url === undefined ? {} : { url }),
      // 没有结果的是还没做完：上线中、撤下中
      rollout: row.rollout?.state ?? (desired.present ? "pending" : "withdrawing"),
      ...(row.rollout?.reason ? { reason: row.rollout.reason } : {}),
      status: status(row.app),
      ...(live?.detail ? { detail: live.detail } : {}),
      ...(thumbnailAt === undefined ? {} : { thumbnailAt }),
      ...(paused ? { paused: true } : {}),
      ...(busy ? { power: power.on ? ("starting" as const) : ("stopping" as const) } : {}),
      ...(paused && !busy && row.powerFailed !== undefined ? { powerReason: row.powerFailed || powerText.stopFailed() } : {}),
    };
  };

  /** 项目删掉了的不算（事件换成了"已删除"标记、整体重放之后行本来就没了；这里再挡一下） */
  const rows = () => serviceRows(store.reader).filter((r) => options.project(r.projectId) !== undefined);

  const view = () => rows().map(viewOf);

  const publish = () => {
    if (!started) return;
    const services = view();
    const text = JSON.stringify(services);
    if (text === published) return;
    published = text;
    try {
      options.publish(services);
    } catch (err) {
      log(`推项目的服务时出错：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** 现在能截哪个地址（140 号票）：上线了、该在 LSM 上、在线、有网页的，经二狗本机端口的转发；别的截不了 */
  const shotTarget = (app: string): string | undefined => {
    const base = options.thumbnails?.baseUrl();
    const row = base === undefined ? undefined : serviceRow(store.reader, app);
    if (!row || !row.desired.present || row.rollout?.state !== "live" || status(app) !== "online" || options.project(row.projectId) === undefined) return undefined;
    const url = serviceUrl(row.desired.service);
    return url === undefined ? undefined : `${base}${url}`;
  };

  const shots =
    options.thumbnails &&
    createServiceThumbnails({
      dir: options.thumbnails.dir,
      capture: options.thumbnails.capture,
      target: shotTarget,
      onChange: () => publish(),
      clock,
      ...(options.thumbnails.timeoutMs === undefined ? {} : { timeoutMs: options.thumbnails.timeoutMs }),
      log,
    });

  /** 要截一张首页：现在截得了的交给 thumbnails.ts（够不够格它定）；上线了、改了方案却还没在线的记着，等在线了再截 */
  const shoot = (app: string, why: ThumbnailReason) => {
    if (!shots || stopped) return;
    if (shotTarget(app) === undefined) {
      if (why === "live" || why === "plan") shotPending.add(app);
      return;
    }
    shotPending.delete(app);
    shots.want(app, why);
  };

  /** 在转发登记表里登记（同一个地址、前缀约定已经登记着的不动） */
  const proxy = (row: ServiceRow) => {
    const s = row.desired.service;
    if (!s.web) return unproxy(row.app);
    const had = proxied.get(row.app);
    if (had && had.port === s.port && had.prefix === s.web.prefix) return;
    had?.undo();
    proxied.delete(row.app);
    try {
      const undo = apps.register({ name: row.app, target: `http://127.0.0.1:${s.port}`, title: row.desired.title, prefix: s.web.prefix });
      proxied.set(row.app, { undo, port: s.port, prefix: s.web.prefix });
    } catch (err) {
      log(`服务 ${row.app} 登记转发时出错：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const unproxy = (app: string) => {
    proxied.get(app)?.undo();
    proxied.delete(app);
  };

  /** 交给 LSM 的定义；on 是 false（257：这个项目的服务你关着）时开机自启写关 */
  const definitionOf = (row: ServiceRow, on: boolean) => {
    const project = options.project(row.projectId);
    const defined = lsmDefinition(row.desired.service, { title: row.desired.title, projectName: project?.name ?? row.projectId }, options.secretsDir, options.nodePath);
    return on ? defined : { ...defined, autostart: false };
  };

  /**
   * 上线：登记 / 更新、启动或重启、登记转发；LSM 没连上时 undefined（等连上）。
   * on 是 false（257：这个项目的服务你关着）：登记时开机自启写关、不启动，在跑的停掉
   */
  const bringUp = async (row: ServiceRow, on: boolean): Promise<Outcome | undefined> => {
    const lsm = options.lsm();
    if (lsm.support === "disabled") return { state: "manual", reason: rolloutText.notLinked(), registered: row.registered };
    if (lsm.support === "waiting") return undefined;
    if (lsm.support === "unsupported") return { state: "manual", reason: rolloutText.unsupported(), registered: row.registered };
    const definition = definitionOf(row, on);
    let put = await lsm.put(definition);
    // 在跑的时候不能改端口：先停（强制：二狗登记的服务没有停机命令）再登记
    if (!put.ok && put.error.code === "running") {
      const halted = await lsm.stop(row.app, { force: true });
      if (!halted.ok) return failed(halted, true);
      put = await lsm.put(definition);
    }
    if (!put.ok) return failed(put, row.registered);
    const up = put.service?.up === true;
    const run = !on ? (up ? await lsm.stop(row.app, { force: true }) : put) : !up ? await lsm.start(row.app) : put.restartNeeded ? await lsm.restart(row.app, { force: true }) : put;
    if (!run.ok) return failed(run, true);
    // 回复里带着的状态先记上（状态推送可能晚一点到）
    const now = run.service ?? put.service;
    if (now) statuses.set(row.app, statusOf(now));
    proxy(row);
    return { state: "live", registered: true };
  };

  /**
   * 257：关掉一个服务——取消开机自启、强制停（转发照样登记着：打开是"服务没在线"的说明页）。LSM 里没登记过、没有它了的算关好了；
   * LSM 没连上时 undefined（等连上）
   */
  const halt = async (row: ServiceRow): Promise<{ ok: boolean; reason?: string } | undefined> => {
    if (!row.registered) return { ok: true };
    const lsm = options.lsm();
    if (lsm.support === "waiting") return undefined;
    if (lsm.support === "disabled") return { ok: false, reason: rolloutText.notLinked() };
    if (lsm.support === "unsupported") return { ok: false, reason: rolloutText.unsupported() };
    for (const step of [() => lsm.autostart(row.app, false), () => lsm.stop(row.app, { force: true })]) {
      const reply = await step();
      if (reply.ok) {
        if (reply.service) statuses.set(row.app, statusOf(reply.service));
        continue;
      }
      if (reply.error.code === "not-found") return { ok: true };
      if (WAIT_CODES.has(reply.error.code)) return undefined;
      return { ok: false, reason: reply.error.code === "timeout" ? rolloutText.timeout() : replyReason(reply) };
    }
    return { ok: true };
  };

  /** 撤下：撤掉转发，LSM 里登记着的撤销；LSM 没连上时 undefined（等连上） */
  const takeDown = async (row: ServiceRow): Promise<Outcome | undefined> => {
    unproxy(row.app);
    if (!row.registered) return { state: "withdrawn", registered: false };
    const lsm = options.lsm();
    if (lsm.support === "waiting") return undefined;
    if (lsm.support === "disabled") return { state: "withdraw_failed", reason: rolloutText.withdrawNotLinked(row.app), registered: true };
    if (lsm.support === "unsupported") return { state: "withdraw_failed", reason: rolloutText.withdrawUnsupported(), registered: true };
    const removed = await lsm.remove(row.app);
    if (removed.ok || removed.error.code === "not-found") {
      statuses.delete(row.app);
      return { state: "withdrawn", registered: false };
    }
    if (WAIT_CODES.has(removed.error.code)) return undefined;
    return { state: "withdraw_failed", reason: replyReason(removed), registered: true };
  };

  /**
   * 上线失败、要你手动：通知项目的维护者（唤起它；项目已归档的不通知）。269：接上 LSM 时兜底拉不起来的说明是接上时拉的
   * （revive 是那一次结果的幂等键：每次接上各通知一次）
   */
  const notices = (row: ServiceRow, outcome: Outcome, revive?: string): NewEvent[] => {
    if (!row.desired.present || (outcome.state !== "failed" && outcome.state !== "manual")) return [];
    const project = options.project(row.projectId);
    if (!project || project.state === "archived") return [];
    const v = viewOf(row);
    const reason = outcome.reason ?? "";
    const text = outcome.state === "manual" ? noticeText.manual(v, reason) : revive ? noticeText.reviveFailed(v, reason) : noticeText.failed(v, reason);
    const key = revive ? `${revive}:notice` : `service-rollout:${row.app}:${row.desiredSeq}:${outcome.state}:notice`;
    return [buildAgentNotice(maintainerChannel(project.maintainerId), text, key, { projectId: project.id }).event];
  };

  /** 上线了的、有网页的：首页跑一遍前缀下自检，有问题告诉维护者（不挡上线） */
  const checkPrefix = (row: ServiceRow) => {
    const s = row.desired.service;
    if (!s.web) return;
    void options
      .prefixCheck(`http://127.0.0.1:${s.port}`, row.app, s.web.prefix)
      .then((result) => {
        if (result.findings.length === 0 || stopped) return;
        const project = options.project(row.projectId);
        if (!project || project.state === "archived") return;
        store.appendBatch([
          buildAgentNotice(maintainerChannel(project.maintainerId), noticeText.prefix(viewOf(row), prefixCheckReport(result)), `service-rollout:${row.app}:${row.desiredSeq}:prefix`, { projectId: project.id }).event,
        ]);
      })
      .catch(() => {
        // 首页取不到（刚起来、没有首页）：不算
      });
  };

  const unwatch = (app: string) => {
    watches.get(app)?.cancel();
    watches.delete(app);
  };

  /** 上线了、该在 LSM 上、项目没归档、LSM 连着的服务才看它挂没挂 */
  const watched = (app: string) => {
    const row = serviceRow(store.reader, app);
    if (!row || !row.desired.present || row.rollout?.state !== "live" || !supported() || reviving.has(app)) return undefined;
    const project = options.project(row.projectId);
    if (!project || project.state === "archived") return undefined;
    // 257：你关着的、你点的启动 / 关闭还没做完的不看（停着是你要的）
    const power = servicePower(store.reader, row.projectId);
    if (!power.on || powerPending(row, power, false)) return undefined;
    return { row, project };
  };

  /**
   * 看一个上线了的服务在不在线：没报过故障的，挂了（中间启动中、停止中也算没好）持续 outageGraceMs 报"挂了"；报过还没好的，
   * 又在线持续 outageGraceMs 报"好了"。中途变回去了就不报
   */
  const watch = (app: string): void => {
    if (!started || stopped) return;
    const w = watched(app);
    if (!w) return unwatch(app);
    const to = w.row.outage ? "up" : "down";
    const now = livenessOf(status(app));
    const pending = watches.get(app);
    const keep = to === "down" ? now === "down" || (now === "between" && pending?.to === "down") : now === "up";
    if (!keep) return unwatch(app);
    // 失败时 LSM 给的原因（之后重拉时的"启动中"没有原因）
    const detail = to === "down" ? statuses.get(app)?.detail : undefined;
    if (pending?.to === to) {
      if (detail !== undefined) pending.reason = detail;
      return;
    }
    unwatch(app);
    const entry: { to: "down" | "up"; cancel: () => void; reason?: string } = { to, cancel: () => {}, ...(detail === undefined ? {} : { reason: detail }) };
    entry.cancel = clock.setTimer(clock.now() + outageGraceMs, () => {
      if (watches.get(app) === entry) watches.delete(app);
      report(app, to, entry.reason);
    });
    watches.set(app, entry);
  };

  /** 挂了 / 好了持续够久了：记一条 service_outage，同一事务通知维护者 */
  const report = (app: string, to: "down" | "up", seen?: string): void => {
    if (stopped) return;
    const w = watched(app);
    if (!w) return;
    const { row, project } = w;
    const now = livenessOf(status(app));
    const still = to === "down" ? now === "down" || now === "between" : now === "up";
    if (!still || (to === "down") === (row.outage !== undefined)) return watch(app);
    const v = viewOf(row);
    const reason = to === "down" ? (statuses.get(app)?.detail ?? seen ?? outageReasonText[status(app)] ?? outageReasonText.offline!) : undefined;
    const payload: ServiceOutagePayload = {
      projectId: row.projectId,
      key: row.desired.key,
      app,
      desiredSeq: row.desiredSeq,
      down: to === "down",
      ...(reason === undefined ? {} : { reason }),
      time: options.now(),
    };
    // 第几次故障：同一次故障的"挂了""好了"用同一个号
    const key = `service-outage:${app}:${row.desiredSeq}:${to === "down" ? row.outages + 1 : row.outages}:${to}`;
    const text = to === "down" ? noticeText.down(v, reason ?? "", row.desired.service.autoRestart) : noticeText.recovered(v);
    store.appendBatch([
      { channel: OPERATIONS_CHANNEL, type: PROJECT_SERVICE_EVENTS.outage, payload, idempotencyKey: key },
      buildAgentNotice(maintainerChannel(project.maintainerId), text, `${key}:notice`, { projectId: project.id }).event,
    ]);
  };

  const watchAll = () => {
    for (const row of serviceRows(store.reader)) watch(row.app);
  };

  /**
   * 记一条上线 / 撤下的结果（上线的带着照的是哪一条开关；同一条要求照不同的开关再上线另记一条）。
   * 269：接上 LSM 时兜底拉起的（revive）每一次都另记——幂等键接上记的时候 operations 频道的序号（上一次记的就在这个频道上，不会重）；
   * 定义没变，不再跑前缀下自检
   */
  const recordRollout = (row: ServiceRow, outcome: Outcome, powerSeq: number | undefined, revive = false) => {
    const payload: ServiceRolloutPayload = {
      projectId: row.projectId,
      key: row.desired.key,
      app: row.app,
      desiredSeq: row.desiredSeq,
      state: outcome.state,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      registered: outcome.registered,
      ...(powerSeq === undefined ? {} : { powerSeq }),
      ...(revive ? { revive: true as const } : {}),
      time: options.now(),
    };
    const base = `service-rollout:${row.app}:${row.desiredSeq}:${outcome.state}${powerSeq ? `:p${powerSeq}` : ""}`;
    const key = revive ? `${base}:revive-${store.lastSeq(OPERATIONS_CHANNEL)}` : base;
    store.appendBatch([{ channel: OPERATIONS_CHANNEL, type: PROJECT_SERVICE_EVENTS.rollout, payload, idempotencyKey: key }, ...notices(row, outcome, revive ? key : undefined)]);
    if (outcome.state === "live" && !revive) checkPrefix(row);
  };

  /** 257：记一个服务照某一条"全部关闭"做完了（关好了、没关成及原因） */
  const recordHalt = (row: ServiceRow, powerSeq: number, done: { ok: boolean; reason?: string }, retry: boolean) => {
    const payload: ServicePowerDonePayload = {
      projectId: row.projectId,
      key: row.desired.key,
      app: row.app,
      desiredSeq: row.desiredSeq,
      powerSeq,
      on: false,
      ok: done.ok,
      ...(done.reason ? { reason: done.reason } : {}),
      time: options.now(),
    };
    // 没关成的重新接上 LSM 时再关：那一次另记（幂等键带着 retry）
    const key = `service-power-done:${row.app}:${row.desiredSeq}:${powerSeq}:${retry ? `retry-${options.now()}` : "first"}:${done.ok ? "ok" : "failed"}`;
    store.append({ channel: OPERATIONS_CHANNEL, type: PROJECT_SERVICE_EVENTS.powerDone, payload, idempotencyKey: key });
  };

  /**
   * 把一个服务做到它该有的样子：先是运营方案要的（上线、撤下），再是开关要的（257：全部启动、全部关闭）。
   * 做的时候又来了新的要求、又点了开关，就照最新的再做（旧的结果不记）；retry：要你手动的、撤下失败的、关闭没做成的也再做
   */
  const reconcile = async (app: string, retry: boolean): Promise<void> => {
    for (let round = 0; round < 10; round += 1) {
      if (stopped) return;
      const row = serviceRow(store.reader, app);
      if (!row) return;
      const power = servicePower(store.reader, row.projectId);
      if (unfinished(row, retry)) {
        const outcome = row.desired.present ? await bringUp(row, power.on) : await takeDown(row);
        if (!outcome || stopped) return;
        const latest = serviceRow(store.reader, app);
        if (!latest || latest.desiredSeq !== row.desiredSeq) continue;
        // 开关在做的时候又点了：登记是真的，照样记（带着照的那一条），下一轮照新的开关再做
        recordRollout(row, outcome, row.desired.present ? power.seq : undefined);
        retry = false;
        continue;
      }
      if (powerPending(row, power, retry)) {
        const outcome = power.on ? await bringUp(row, true) : await halt(row);
        if (!outcome || stopped) return;
        const latest = serviceRow(store.reader, app);
        // 做的时候又改了方案、又点了开关：这一次的结果不记，照最新的再做
        if (!latest || latest.desiredSeq !== row.desiredSeq || servicePower(store.reader, row.projectId).seq !== power.seq) continue;
        if ("state" in outcome) recordRollout(row, outcome, power.seq);
        else recordHalt(row, power.seq, outcome, retry);
        retry = false;
        continue;
      }
      return;
    }
  };

  /** 排进这个服务的那一串（一个服务一次只做一件） */
  const enqueue = (app: string, work: () => Promise<void>) => {
    const next = (chains.get(app) ?? Promise.resolve())
      .then(work)
      .catch((err: unknown) => log(`服务 ${app} 上线 / 撤下时出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
    chains.set(app, next);
    void next.finally(() => {
      if (chains.get(app) === next) chains.delete(app);
    });
  };

  const schedule = (app: string, retry = false) => enqueue(app, () => reconcile(app, retry));

  /**
   * 269：接上 LSM 时该不该替它兜底——该在 LSM 上、上线了、项目使用中、开关开着而且不在启动 / 关闭中（关着的一直关着；还在上线中的、
   * 要你手动的照 133 补做，不在这里）
   */
  const revivable = (row: ServiceRow): boolean => {
    if (!row.desired.present || row.rollout?.state !== "live") return false;
    if (options.project(row.projectId)?.state !== "in_use") return false;
    const power = servicePower(store.reader, row.projectId);
    return power.on && !powerPending(row, power, true);
  };

  /**
   * 269：把接上时没在跑的拉起来——"上线"那一套（整份登记、启动等到就绪），结果记 service_rollout（revive）。轮到它时又改了方案、
   * 不该兜底了的不做；做的时候又改了方案、点了开关的结果不记（排在后面的照最新的做）
   */
  const revive = (app: string, desiredSeq: number) => {
    reviving.set(app, (reviving.get(app) ?? 0) + 1);
    let held = true;
    /** 这一次不再挡着看挂没挂（前后接连接上两次、排着两次的，两次都做完才算放开） */
    const release = () => {
      if (!held) return;
      held = false;
      const left = (reviving.get(app) ?? 1) - 1;
      if (left > 0) reviving.set(app, left);
      else reviving.delete(app);
    };
    enqueue(app, async () => {
      try {
        const row = serviceRow(store.reader, app);
        if (stopped || !row || row.desiredSeq !== desiredSeq || !revivable(row)) return;
        const power = servicePower(store.reader, row.projectId);
        const outcome = await bringUp(row, true);
        if (!outcome || stopped) return;
        const latest = serviceRow(store.reader, app);
        if (!latest || latest.desiredSeq !== row.desiredSeq || servicePower(store.reader, row.projectId).seq !== power.seq) return;
        log(outcome.state === "live" ? `接上 LSM 时服务 ${app} 没在跑：拉起来了` : `接上 LSM 时服务 ${app} 没在跑：没拉起来（${outcome.reason ?? outcome.state}）`);
        // 先放开：记下结果时（store.onAppend）照常看挂没挂
        release();
        recordRollout(row, outcome, power.seq, true);
      } finally {
        if (held) {
          release();
          watch(app);
        }
      }
    });
  };

  /**
   * 324：接上时在跑的照现在的方案整份再登记一次：同一份定义 LSM 不改；定义变了（比如二狗换了 Node）LSM 回 restartNeeded，强制重启
   * 一次（二狗登记的服务没有停机命令）。重启时不看挂没挂；不记事件，只记日志。轮到它时又改了方案、不该兜底了的不做（排着的上线照做）
   */
  const resync = (app: string, desiredSeq: number) => {
    reviving.set(app, (reviving.get(app) ?? 0) + 1);
    enqueue(app, async () => {
      try {
        const row = serviceRow(store.reader, app);
        const lsm = options.lsm();
        if (stopped || !row || row.desiredSeq !== desiredSeq || !revivable(row) || lsm.support !== "supported") return;
        const put = await lsm.put(definitionOf(row, true));
        if (!put.ok) return log(`接上 LSM 时重新登记服务 ${app} 没成：${put.error.message}`);
        if (!put.restartNeeded || stopped) return;
        const restarted = await lsm.restart(app, { force: true });
        log(restarted.ok ? `服务 ${app} 的登记变了（比如二狗换了 Node）：重启了一次` : `服务 ${app} 的登记变了，重启没成：${restarted.error.message}`);
      } finally {
        const left = (reviving.get(app) ?? 1) - 1;
        if (left > 0) reviving.set(app, left);
        else reviving.delete(app);
        watch(app);
      }
    });
  };

  /** 269：接上后的第一份全量到了：接上时记下的、现在还该兜底的，LSM 里没在跑的拉起来；324：在跑的整份再登记一次 */
  const reviveStopped = (message: LsmServicesStatusMessage) => {
    const candidates = reviveOnFull;
    reviveOnFull = undefined;
    if (!candidates || stopped) return;
    const reported = new Map(message.services.map((s) => [s.name, s]));
    for (const app of candidates) {
      const row = serviceRow(store.reader, app);
      if (!row || !revivable(row)) continue;
      const now = reported.get(app);
      if (notRunning(now)) revive(app, row.desiredSeq);
      else if (now?.up === true) resync(app, row.desiredSeq);
    }
  };

  /** 没做完的都排上（retry：要你手动的、撤下失败的、关闭没做成的也再做） */
  const resume = (retry: boolean) => {
    for (const row of rows()) if (unfinished(row, retry) || powerPending(row, servicePower(store.reader, row.projectId), retry)) schedule(row.app, retry);
  };

  return {
    view,
    ofProject: (projectId) => view().filter((v) => v.projectId === projectId),
    status,

    thumbnail(projectId, name) {
      const app = `${projectId}-${name}`;
      const row = serviceRow(store.reader, app);
      if (!shots || !row || row.projectId !== projectId || options.project(projectId) === undefined) return undefined;
      shoot(app, "seen");
      return shots.file(app);
    },

    power(projectId, action, by, idempotencyKey) {
      const project = options.project(projectId);
      if (!project) throw new RequestRejected("not_found", powerText.noProject(projectId));
      if (project.state !== "in_use") throw new RequestRejected("not_allowed", powerText.notInUse(project.name));
      const present = rows().filter((r) => r.projectId === projectId && r.desired.present);
      if (present.length === 0) throw new RequestRejected("not_found", powerText.noServices(project.name));
      const support = options.lsm().support;
      if (support !== "supported") throw new RequestRejected("not_allowed", powerText.lsm(support));
      const payload: ServicePowerPayload = { projectId, on: action === "start", by, time: options.now() };
      store.append({ channel: OPERATIONS_CHANNEL, type: PROJECT_SERVICE_EVENTS.power, payload, idempotencyKey: `service-power:${idempotencyKey}` });
      return { projectId, action, services: present.length };
    },

    async settled(projectId, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const busy = rows().flatMap((r) => (r.projectId === projectId ? [chains.get(r.app)] : [])).filter((c): c is Promise<void> => c !== undefined);
        if (busy.length === 0) return true;
        const left = deadline - Date.now();
        if (left <= 0) return false;
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), left);
          timer.unref();
        });
        const result = await Promise.race([Promise.all(busy).then(() => "done" as const), timeout]);
        clearTimeout(timer);
        if (result === "timeout") return false;
      }
    },

    start() {
      if (started) return;
      started = true;
      // 上线了的、有网页的：先登记转发（守护进程重启后不等 LSM，/apps/<应用名>/ 马上能用；服务没在跑时转发给说明页）
      for (const row of rows()) if (row.desired.present && row.rollout?.state === "live") proxy(row);
      unsubscribe.push(
        store.onAppend((event) => {
          if (event.channel === OPERATIONS_CHANNEL && event.type === PROJECT_SERVICE_EVENTS.desired) {
            const app = (event.payload as { app: string }).app;
            schedule(app);
            watch(app);
            publish();
          } else if (event.channel === OPERATIONS_CHANNEL && event.type === PROJECT_SERVICE_EVENTS.rollout) {
            const { app, state } = event.payload as ServiceRolloutPayload;
            watch(app);
            // 上线了：在线了就截首页（还没在线的等它在线）
            if (state === "live") shoot(app, "live");
            publish();
          } else if (event.channel === OPERATIONS_CHANNEL && event.type === OPERATIONS_EVENTS.decided) {
            // 确认了这个项目的新一份运营方案：上线着的服务重截首页（服务本身改了的会重新上线，到时候再截）
            const p = event.payload as OperationsDecidedPayload;
            if (p.confirmed) for (const row of serviceRows(store.reader)) if (row.projectId === p.projectId && row.desired.present && row.rollout?.state === "live") shoot(row.app, "plan");
          } else if (event.channel === OPERATIONS_CHANNEL && event.type === PROJECT_SERVICE_EVENTS.outage) {
            watch((event.payload as { app: string }).app);
          } else if (event.channel === OPERATIONS_CHANNEL && event.type === PROJECT_SERVICE_EVENTS.power) {
            // 257：这个项目的服务全部启动 / 全部关闭——每个服务排进它那一串照最新的做；关着、在做的不看挂没挂
            const { projectId } = event.payload as ServicePowerPayload;
            for (const row of serviceRows(store.reader)) {
              if (row.projectId !== projectId) continue;
              if (powerPending(row, servicePower(store.reader, projectId), false)) schedule(row.app);
              watch(row.app);
            }
            publish();
          } else if (event.channel === OPERATIONS_CHANNEL && event.type === PROJECT_SERVICE_EVENTS.powerDone) {
            watch((event.payload as ServicePowerDonePayload).app);
            publish();
          } else if (event.channel === CHANNELS.projects && event.type === EVENT_TYPES.project) {
            // 删掉的项目：转发撤掉（它的服务早在归档时就撤下了，这里再保险一下）
            const p = event.payload as ProjectEventPayload;
            // 用户 2026-10-24 定（259 号票改 257 号票）：关着服务的项目停用后重新启用（含使用中归档后取消归档回到使用中），重新启用就把
            // 服务全部拉起来，不再保持关着——记一条"全部启动"，重新上线时照它登记（恢复开机自启）、启动
            const reactivated = p.change === "reactivated" || (p.change === "unarchived" && p.project.state === "in_use");
            if (reactivated && !servicePower(store.reader, p.project.id).on) {
              const payload: ServicePowerPayload = { projectId: p.project.id, on: true, by: "user", time: options.now() };
              store.append({ channel: OPERATIONS_CHANNEL, type: PROJECT_SERVICE_EVENTS.power, payload, idempotencyKey: `service-power:reactivated:${event.globalSeq}` });
            }
            if (p.change === "deleted") {
              for (const app of proxied.keys()) if (app.startsWith(`${p.project.id}-`) && serviceRow(store.reader, app) === undefined) unproxy(app);
              // 缩略图一起删掉（140 号票）
              shots?.forgetProject(p.project.id);
            }
            watchAll();
            publish();
          }
        }),
      );
      const lsm = options.lsm();
      unsubscribe.push(
        lsm.onStatus((message) => {
          // 之前的在不在线（140 号票：从不在线变回在线算重启了，重截首页）；接上 LSM 后的第一份全量之前的不算
          const before = haveFull ? new Map(statuses) : undefined;
          if (message.full) {
            statuses.clear();
            haveFull = true;
          }
          for (const s of message.services) statuses.set(s.name, statusOf(s));
          for (const name of message.removed) statuses.delete(name);
          // 269：接上后的第一份全量——没在跑的拉起来（在看挂没挂之前：拉的时候不看）
          if (message.full) reviveStopped(message);
          for (const s of message.services) {
            if (status(s.name) !== "online") continue;
            const was = before?.get(s.name)?.status;
            if (shotPending.has(s.name)) shoot(s.name, "live");
            else if (was !== undefined && was !== "online") shoot(s.name, "restart");
          }
          watchAll();
          publish();
        }),
        lsm.onSupport((support) => {
          if (support !== "supported") {
            statuses.clear();
            haveFull = false;
          }
          // 269：接上了（welcome 里有 services）：记下上线了、用户没关的服务，等第一份全量看它们在不在跑；断了的不等了
          reviveOnFull = support === "supported" ? new Set(rows().filter(revivable).map((r) => r.app)) : undefined;
          // 重新接上：没做完的、要你手动的、撤下失败的再做一遍；不支持的记"要你手动"
          if (support === "supported" || support === "unsupported") resume(support === "supported");
          // LSM 没连着时不判挂没挂（等着的计时器撤掉）
          watchAll();
          publish();
        }),
      );
      resume(false);
      watchAll();
      publish();
    },

    stop() {
      stopped = true;
      shots?.stop();
      for (const app of watches.keys()) unwatch(app);
      for (const u of unsubscribe.splice(0)) u();
      for (const app of proxied.keys()) unproxy(app);
    },

    async idle() {
      while (chains.size > 0) await Promise.all(chains.values());
      await shots?.idle();
    },
  };
}
