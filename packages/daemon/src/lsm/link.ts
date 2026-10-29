// 接入 Local Service Manager（LSM）的 link 协议（LSM 仓库的 docs/link-protocol.md v1，规格第 1 节，23 号票）。
// LSM 拉起 ergo-daemon 时注入 LSM_URL / LSM_SERVICE_ID / LSM_TOKEN / LSM_PROTOCOL，这里出站连上它：
// - 握手（hello）报上 pid、本机端口、版本和能力（busy、stop、restart、health）；
// - 心跳（默认每 5 秒，按管理器 welcome 里给的间隔）报健康（秘书在不在）和忙不忙（忙不忙怎么算见 busy.ts）；
//   忙闲变了马上补一次心跳，不等下一拍。管理器据此提供"等空闲再停"，WebUI 显示忙的原因；
// - 停机（stop / restart）：先应答，"立即"的马上优雅停机（停守护进程：关端口、停 agent、关库），"等空闲"的等不忙了再停，
//   期间管理器可以撤销（cancel）；停完由守护进程断开连接、发 bye（daemon.ts 的停止流程最后一步，只在那里断）；
// - 管理器说同一个服务已经有活跃的会话（conflict）：被重复启动了，交给调用方退出；
// - 名下的服务（协议 §7，见 packages/supervisor/docs/link-protocol.md；133 号票）：hello 里声明 features: ["services"]，管理器的 welcome 里 features 含 "services"
//   才算支持（老管理器没有这个字段：当成不支持，什么都不发）。支持时经 services 登记 / 更新（put）、启动、停止、重启、开关开机自启、
//   撤销、列出名下的服务，每条请求带自己编的 id、等回复（启动要等服务就绪，给足 180 秒）；状态推送（services.status，接入时一次全量，
//   之后只推变了的）交给 onStatus 的订阅者。断线时在途的请求一律回"断了"（管理器那边可能做完了也可能没做，以重连后的全量推送为准）。
// 铁律（协议第 0 节）：没有注入身份（四个变量缺一个、协议版本不是 1）时静默跳过，什么都不连；连不上、断线一律只是重连
// （1 秒起翻倍、最多 30 秒，无限重试），从不抛错、从不挡守护进程启动。services 的方法也从不抛错，失败一律 { ok: false, error }。
// 照 LSM 的参考客户端 clients/lsm-link.mjs 的做法写，没有照搬它（它用 Node 自带的 WebSocket，零依赖）：
// 这里用工作区已有的 ws 包，握手时带 Authorization: Bearer <令牌> 请求头。
import { t } from "@ergo/protocol";
import { WebSocket } from "ws";

/** link 协议的版本（LSM 注入的环境变量 LSM_PROTOCOL 要和它一样） */
export const LSM_LINK_PROTOCOL_VERSION = 1;

/** 名下的服务（协议 §7）这个扩展的名字：hello、welcome 的 features 里写它 */
export const LSM_SERVICES_FEATURE = "services";

/** 默认心跳间隔（管理器的 welcome 给了就按它的） */
const DEFAULT_HEARTBEAT_MS = 5_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** 启动要等服务就绪（LSM 的 readyTimeoutMs 默认 60 秒）：给足 */
const SERVICES_REQUEST_TIMEOUT_MS = 180_000;

/** 忙不忙：有任务在跑时忙，原因写跑的是什么 */
export interface LsmBusy {
  busy: boolean;
  reason?: string;
}

/**
 * 健康：秘书在运行、启用着的插件都装上了是 ok，否则 degraded（126 号票起插件没装上也算降级）。
 * 协议里还有 failing，守护进程起来了就不会报它
 */
export type LsmHealth = "ok" | "degraded";

export interface LsmLinkOptions {
  /** 守护进程的环境：从这里取 LSM 注入的身份 */
  env: Readonly<Record<string, string | undefined>>;
  /** 本机端口 */
  port: number;
  version: string;
  busy(): LsmBusy;
  health(): LsmHealth;
  /** 管理器要求停机（立即，或等不忙了）：优雅停机（停完调 close，发 bye），完成后 resolve */
  onShutdown(): Promise<void>;
  /** 管理器说同一个服务已经有活跃的会话：被重复启动了 */
  onConflict(reason: string): void;
  log(line: string): void;
}

/** 名下的服务（协议 §7.6）的一条状态：管理器推来的样子（只列用得到的字段，别的原样留着） */
export interface LsmServiceStatus {
  /** <登记方>--<名字> */
  id: string;
  /** 名字（短名） */
  name: string;
  title?: string;
  port: number;
  /** STOPPED / STARTING / RUNNING / DEGRADED / STOPPING / FAILED / ORPHAN */
  state: string;
  /** state 是 RUNNING / DEGRADED */
  up: boolean;
  /** 端口有没有人听；null 是还没探过 */
  listening?: boolean | null;
  /** 健康检查：ok / failing（接入了的还有 degraded）；没有健康检查是 null */
  health?: string | null;
  autostart?: boolean;
  /** 给人看的一句话 */
  detail?: string | null;
  /** 起不来、停不下时的原因 */
  lastError?: string | null;
  [key: string]: unknown;
}

/** 名下的服务的定义（协议 §7.4，services.put 的 service；不认识的字段管理器直接拒） */
export interface LsmServiceDefinition {
  name: string;
  title?: string;
  project?: string;
  command: string;
  cwd: string;
  port: number;
  env?: Array<{ name: string; from: "literal" | "file" | "userEnv"; value?: string; path?: string; optional?: boolean }>;
  health?: { path: string; timeoutMs?: number };
  autostart?: boolean;
  /** 挂了自动重拉（默认关，和服务管家的默认一样） */
  autoRestart?: boolean;
}

/** 管理器的回复（services.reply），或者这边造的失败（没接入、不支持、断了、超时） */
export type LsmServicesReply =
  | {
      ok: true;
      created?: boolean;
      changed?: boolean;
      restartNeeded?: boolean;
      already?: boolean;
      pending?: boolean;
      service?: LsmServiceStatus;
      services?: LsmServiceStatus[];
      removed?: { id: string; name: string };
    }
  | { ok: false; error: { code: string; message: string; details?: unknown }; service?: LsmServiceStatus };

/** 状态推送（services.status） */
export interface LsmServicesStatusMessage {
  /** 全量：services 是名下的全部，之前知道、这里没有的就是没了 */
  full: boolean;
  services: LsmServiceStatus[];
  /** 撤掉了的名字 */
  removed: string[];
}

/**
 * 管理器支不支持名下的服务：disabled 没接入（没有注入身份）；waiting 接入了但还没收到 welcome（没连上、断了）；
 * supported 支持；unsupported 管理器版本太老（welcome 里没有 services）
 */
export type LsmServicesSupport = "disabled" | "waiting" | "supported" | "unsupported";

/** 名下的服务（协议 §7）：方法都不抛错，失败一律 { ok: false, error: { code, message } } */
export interface LsmServices {
  readonly support: LsmServicesSupport;
  put(definition: LsmServiceDefinition): Promise<LsmServicesReply>;
  /** 等到就绪（或失败）才回 */
  start(name: string): Promise<LsmServicesReply>;
  /** 没有停机能力的服务（二狗登记的都是）要带 force：杀进程树 */
  stop(name: string, options?: { force?: boolean }): Promise<LsmServicesReply>;
  restart(name: string, options?: { force?: boolean }): Promise<LsmServicesReply>;
  autostart(name: string, on: boolean): Promise<LsmServicesReply>;
  /** 撤销：强制停止、确认端口空了、拿掉登记 */
  remove(name: string): Promise<LsmServicesReply>;
  list(): Promise<LsmServicesReply>;
  /** 订阅状态推送；返回退订 */
  onStatus(listener: (message: LsmServicesStatusMessage) => void): () => void;
  /** 支不支持变了（收到 welcome、断开、关掉）；返回退订 */
  onSupport(listener: (support: LsmServicesSupport) => void): () => void;
}

export interface LsmLink {
  /** 注入了身份、在接入（连没连上另说） */
  readonly enabled: boolean;
  /** 名下的服务（133 号票） */
  readonly services: LsmServices;
  /** 忙闲变了：马上补一次心跳；有"等空闲再停"挂着、现在不忙了就停机 */
  notifyBusy(): void;
  /** 守护进程停完时：发 bye、断开、不再重连 */
  close(): void;
}

const notLinked = async (): Promise<LsmServicesReply> => ({ ok: false, error: { code: "not-linked", message: t("lsm.notLinked") } });

/** 没接入时的名下服务：什么都做不了，也不抛错 */
export const DISABLED_LSM_SERVICES: LsmServices = {
  support: "disabled",
  put: notLinked,
  start: notLinked,
  stop: notLinked,
  restart: notLinked,
  autostart: notLinked,
  remove: notLinked,
  list: notLinked,
  onStatus: () => () => {},
  onSupport: () => () => {},
};

const DISABLED: LsmLink = { enabled: false, services: DISABLED_LSM_SERVICES, notifyBusy() {}, close() {} };

/** 管理器发来的消息 */
type ManagerMessage =
  | { type: "welcome"; sessionId?: string; heartbeatIntervalMs?: number; features?: unknown }
  | { type: "conflict"; reason?: string }
  | { type: "ping"; id: string }
  | { type: "cancel"; id: string }
  | { type: "stop" | "restart"; id: string; mode?: "now" | "when-idle"; deadlineMs?: number }
  | ({ type: "services.reply"; id: string } & Record<string, unknown>)
  | { type: "services.status"; full?: boolean; services?: LsmServiceStatus[]; removed?: string[] };

/** LSM 注入的身份：四个变量都在、协议版本是 1 才算 */
export function lsmIdentity(env: Readonly<Record<string, string | undefined>>): { url: string; serviceId: string; token: string } | undefined {
  const url = env.LSM_URL;
  const serviceId = env.LSM_SERVICE_ID;
  const token = env.LSM_TOKEN;
  if (!url || !serviceId || !token || Number(env.LSM_PROTOCOL) !== LSM_LINK_PROTOCOL_VERSION) return undefined;
  return { url, serviceId, token };
}

/** 接入 LSM（没有注入身份时返回一个什么都不做的） */
export function linkToLsm(options: LsmLinkOptions): LsmLink {
  const identity = lsmIdentity(options.env);
  if (!identity) return DISABLED;
  const { url, serviceId, token } = identity;
  const { log } = options;

  let ws: WebSocket | undefined;
  let beat: NodeJS.Timeout | undefined;
  let retry: NodeJS.Timeout | undefined;
  let backoff = RECONNECT_MIN_MS;
  let intervalMs = DEFAULT_HEARTBEAT_MS;
  let closed = false;
  /** 挂着的"等空闲再停" */
  let pendingIdle: string | undefined;
  let shuttingDown: Promise<void> | undefined;
  let byeReason = "closing";
  // 名下的服务：welcome 带来的支不支持（没收到 welcome 前是 waiting）、在途的请求、订阅者
  let support: LsmServicesSupport = "waiting";
  const pending = new Map<string, { resolve: (reply: LsmServicesReply) => void; timer: NodeJS.Timeout }>();
  let requestSeq = 0;
  const statusListeners = new Set<(message: LsmServicesStatusMessage) => void>();
  const supportListeners = new Set<(support: LsmServicesSupport) => void>();

  const send = (message: unknown) => {
    try {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    } catch {
      // 断了：等重连
    }
  };
  const readBusy = (): LsmBusy => {
    try {
      return options.busy();
    } catch {
      return { busy: false };
    }
  };
  const readHealth = (): LsmHealth => {
    try {
      return options.health();
    } catch {
      return "degraded";
    }
  };
  /** 订阅者出错只记日志（接入层从不抛错） */
  const notifyAll = <T>(listeners: ReadonlySet<(value: T) => void>, value: T, what: string) => {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (err) {
        log(`${what}出错：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  const setSupport = (next: LsmServicesSupport) => {
    if (next === support) return;
    support = next;
    notifyAll(supportListeners, next, "名下服务的接入状态通知"); // @i18n-ignore log：出错时日志里的说明
  };
  /** 在途的请求一律回失败（断了、关掉了） */
  const failPending = (code: string, message: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.resolve({ ok: false, error: { code, message } });
    }
  };
  /** 连接断了：在途的请求回"断了"，等重连后的 welcome */
  const lost = () => {
    failPending("disconnected", t("lsm.disconnected"));
    if (!closed) setSupport("waiting");
  };

  const shutdown = () => {
    pendingIdle = undefined;
    shuttingDown ??= (async () => {
      byeReason = "shutdown-complete";
      log("LSM 要求停机：优雅停止守护进程");
      try {
        await options.onShutdown();
      } catch (err) {
        log(`按 LSM 的要求停机时出错：${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  const heartbeat = () => {
    const { busy, reason } = readBusy();
    send({ type: "heartbeat", ts: Date.now(), health: readHealth(), busy, busyReason: reason ?? null });
    if (pendingIdle !== undefined && !busy) shutdown();
  };

  const startBeating = () => {
    if (beat) clearInterval(beat);
    beat = setInterval(heartbeat, intervalMs);
    beat.unref();
  };

  const handle = (message: ManagerMessage) => {
    switch (message.type) {
      case "welcome":
        backoff = RECONNECT_MIN_MS;
        if (typeof message.heartbeatIntervalMs === "number" && message.heartbeatIntervalMs > 0) intervalMs = message.heartbeatIntervalMs;
        startBeating();
        heartbeat();
        // 老管理器的 welcome 没有 features：当成不支持名下的服务，别发了等不到回复
        setSupport(Array.isArray(message.features) && message.features.includes(LSM_SERVICES_FEATURE) ? "supported" : "unsupported");
        return;
      case "conflict":
        // 同一个 serviceId 已有活跃会话：被重复启动了，交给调用方退出，别抢端口
        log(`LSM 拒绝接入：${message.reason ?? "该 serviceId 已有活跃会话"}`);
        stopConnecting();
        options.onConflict(message.reason ?? "");
        return;
      case "ping":
        send({ type: "ack", id: message.id, ok: true });
        return;
      case "cancel":
        // 撤销挂着的"等空闲再停"：两边都撤，免得不忙了还是自己停了
        if (pendingIdle !== undefined) log("LSM 撤销了等空闲再停");
        pendingIdle = undefined;
        send({ type: "ack", id: message.id, ok: true });
        return;
      case "stop":
      case "restart": {
        send({ type: "ack", id: message.id, ok: true });
        const { busy, reason } = readBusy();
        if (message.mode === "when-idle" && busy) {
          log(`LSM 要求等空闲再${message.type === "stop" ? "停" : "重启"}；现在忙（${reason ?? "未说明"}），挂起等待`);
          pendingIdle = message.id;
          return;
        }
        shutdown();
        return;
      }
      case "services.reply": {
        const p = pending.get(message.id);
        if (!p) return;
        pending.delete(message.id);
        clearTimeout(p.timer);
        const { type: _type, id: _id, ...reply } = message;
        p.resolve(reply as LsmServicesReply);
        return;
      }
      case "services.status":
        notifyAll(
          statusListeners,
          { full: message.full === true, services: Array.isArray(message.services) ? message.services : [], removed: Array.isArray(message.removed) ? message.removed : [] },
          "名下服务的状态推送处理", // @i18n-ignore log：出错时日志里的说明
        );
        return;
    }
  };

  const scheduleRetry = () => {
    if (closed || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      connect();
    }, backoff);
    retry.unref();
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  };

  const connect = () => {
    if (closed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch {
      return scheduleRetry();
    }
    ws = socket;
    socket.on("open", () => {
      // features：会用名下的服务（133 号票），接入时请管理器推一次全量状态
      send({
        type: "hello",
        serviceId,
        pid: process.pid,
        port: options.port,
        version: options.version,
        protocol: LSM_LINK_PROTOCOL_VERSION,
        capabilities: ["busy", "stop", "restart", "health"],
        logs: [],
        features: [LSM_SERVICES_FEATURE],
      });
      // 管理器回 welcome 之前也按默认间隔报（老的管理器可能不回 welcome）
      startBeating();
      log(`已接入 LSM（${serviceId}）`);
    });
    socket.on("message", (data) => {
      try {
        handle(JSON.parse(data.toString()) as ManagerMessage);
      } catch {
        // 看不懂的消息不理
      }
    });
    // error 和 close 都可能单独出现（连不上时只有 error）：都排一次重连
    socket.on("error", () => {
      if (beat) clearInterval(beat);
      if (ws === socket) lost();
      scheduleRetry();
    });
    socket.on("close", () => {
      if (beat) clearInterval(beat);
      if (ws === socket) lost();
      scheduleRetry();
    });
  };

  /** 不再连：清掉计时器 */
  const stopConnecting = () => {
    closed = true;
    if (beat) clearInterval(beat);
    if (retry) clearTimeout(retry);
    retry = undefined;
  };

  /** 发一条名下服务的请求，等回复（不支持、没连上、超时、断了都回失败，不抛错） */
  const request = (type: string, body: Record<string, unknown>): Promise<LsmServicesReply> => {
    if (closed) return Promise.resolve({ ok: false, error: { code: "closed", message: t("lsm.closed") } });
    if (support === "waiting") return Promise.resolve({ ok: false, error: { code: "not-connected", message: t("lsm.notConnected") } });
    if (support === "unsupported") return Promise.resolve({ ok: false, error: { code: "unsupported", message: t("lsm.unsupported") } });
    requestSeq += 1;
    const id = `q-${requestSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: { code: "timeout", message: t("lsm.timeout") } });
      }, SERVICES_REQUEST_TIMEOUT_MS);
      timer.unref();
      pending.set(id, { resolve, timer });
      send({ type, id, ...body });
    });
  };

  const services: LsmServices = {
    get support() {
      return support;
    },
    put: (definition) => request("services.put", { service: definition }),
    start: (name) => request("services.start", { name }),
    stop: (name, { force = false } = {}) => request("services.stop", { name, force, mode: "now" }),
    restart: (name, { force = false } = {}) => request("services.restart", { name, force }),
    autostart: (name, on) => request("services.autostart", { name, on }),
    remove: (name) => request("services.remove", { name }),
    list: () => request("services.list", {}),
    onStatus(listener) {
      statusListeners.add(listener);
      return () => void statusListeners.delete(listener);
    },
    onSupport(listener) {
      supportListeners.add(listener);
      return () => void supportListeners.delete(listener);
    },
  };

  const link: LsmLink = {
    enabled: true,
    services,
    notifyBusy() {
      if (closed) return;
      heartbeat();
    },
    close() {
      if (closed) return;
      stopConnecting();
      send({ type: "bye", reason: byeReason });
      try {
        ws?.close();
      } catch {
        // 已经断了
      }
      failPending("closed", t("lsm.closed"));
    },
  };

  connect();
  return link;
}
