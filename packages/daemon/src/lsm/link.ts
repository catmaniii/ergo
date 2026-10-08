// 接入 Local Service Manager（LSM）的 link 协议（LSM 仓库的 docs/link-protocol.md v1，规格第 1 节，23 号票）。
// LSM 拉起 ergou-daemon 时注入 LSM_URL / LSM_SERVICE_ID / LSM_TOKEN / LSM_PROTOCOL，这里出站连上它：
// - 握手（hello）报上 pid、本机端口、版本和能力（busy、stop、restart、health）；
// - 心跳（默认每 5 秒，按管理器 welcome 里给的间隔）报健康（秘书在不在）和忙不忙（忙不忙怎么算见 busy.ts）；
//   忙闲变了马上补一次心跳，不等下一拍。管理器据此提供"等空闲再停"，WebUI 显示忙的原因；
// - 停机（stop / restart）：先应答，"立即"的马上优雅停机（停守护进程：关端口、停 agent、关库），"等空闲"的等不忙了再停，
//   期间管理器可以撤销（cancel）；停完由守护进程断开连接、发 bye（daemon.ts 的停止流程最后一步，只在那里断）；
// - 管理器说同一个服务已经有活跃的会话（conflict）：被重复启动了，交给调用方退出。
// 铁律（协议第 0 节）：没有注入身份（四个变量缺一个、协议版本不是 1）时静默跳过，什么都不连；连不上、断线一律只是重连
// （1 秒起翻倍、最多 30 秒，无限重试），从不抛错、从不挡守护进程启动。
// 照 LSM 的参考客户端 clients/lsm-link.mjs 的做法写，没有照搬它（它用 Node 自带的 WebSocket，零依赖）：
// 这里用工作区已有的 ws 包，握手时带 Authorization: Bearer <令牌> 请求头。
import { WebSocket } from "ws";

/** link 协议的版本（LSM 注入的环境变量 LSM_PROTOCOL 要和它一样） */
export const LSM_LINK_PROTOCOL_VERSION = 1;

/** 默认心跳间隔（管理器的 welcome 给了就按它的） */
const DEFAULT_HEARTBEAT_MS = 5_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** 忙不忙：有任务在跑时忙，原因写跑的是什么 */
export interface LsmBusy {
  busy: boolean;
  reason?: string;
}

/** 健康：秘书在运行是 ok，否则 degraded（协议里还有 failing，守护进程起来了就不会报它） */
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

export interface LsmLink {
  /** 注入了身份、在接入（连没连上另说） */
  readonly enabled: boolean;
  /** 忙闲变了：马上补一次心跳；有"等空闲再停"挂着、现在不忙了就停机 */
  notifyBusy(): void;
  /** 守护进程停完时：发 bye、断开、不再重连 */
  close(): void;
}

const DISABLED: LsmLink = { enabled: false, notifyBusy() {}, close() {} };

/** 管理器发来的消息 */
type ManagerMessage =
  | { type: "welcome"; sessionId?: string; heartbeatIntervalMs?: number }
  | { type: "conflict"; reason?: string }
  | { type: "ping"; id: string }
  | { type: "cancel"; id: string }
  | { type: "stop" | "restart"; id: string; mode?: "now" | "when-idle"; deadlineMs?: number };

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
      send({ type: "hello", serviceId, pid: process.pid, port: options.port, version: options.version, protocol: LSM_LINK_PROTOCOL_VERSION, capabilities: ["busy", "stop", "restart", "health"], logs: [] });
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
      scheduleRetry();
    });
    socket.on("close", () => {
      if (beat) clearInterval(beat);
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

  const link: LsmLink = {
    enabled: true,
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
    },
  };

  connect();
  return link;
}
