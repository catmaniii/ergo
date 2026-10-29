// LSM 接入层的替身（23 号票）：按 LSM 的 link 协议 v1（LSM 仓库的 docs/link-protocol.md）当管理器那一端，
// 只认带 Authorization: Bearer <令牌> 的连接；收到 hello 回 welcome（心跳间隔由测试定）或 conflict；记下服务发来的每条消息，
// 测试可以往服务发停机、撤销、ping。守护进程的环境里放 env 就会连上它。测试结束时关掉。
// 133 号票：owned 打开时扮演支持名下服务的新管理器（协议 §7）——welcome 里带 features: ["services"]、接入时推一次全量状态，
// services.put / start / stop / restart / autostart / remove / list 照协议回（在内存里记着名下的服务，不起真进程：启动就算起来了，
// 测试可以让某个服务下次启动失败、把端口登记给别人、改它的状态并推送）。不开时 welcome 里没有 features（老管理器）。
// 257 号票：holdNextStart 让某个服务下次启动停在"启动中"、等测试放行才回（做到一半又点）。
// 269 号票：owned.reboot 扮演"电脑重启了、LSM 没按开机自启拉"（名下的服务全停、不推送）；drop 断开现在的连接（服务端照开着），
// 守护进程按退避重连，重连后照常 welcome、推全量（扮演 LSM 重启了、二狗重新接上）。
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { waitUntil } from "./process.ts";

/** 服务发来的一条消息 */
export interface LinkMessage {
  type: string;
  [key: string]: unknown;
}

/** 替身记着的一个名下服务 */
export interface OwnedService {
  definition: Record<string, unknown> & { name: string; port: number };
  state: "STOPPED" | "STARTING" | "RUNNING" | "STOPPING" | "FAILED";
  autostart: boolean;
  lastError: string | null;
}

/** 名下服务的模拟（owned 打开时有） */
export interface OwnedServices {
  /** 名字（短名）→ 服务 */
  readonly services: Map<string, OwnedService>;
  /** 让这个服务下次启动（start、restart）失败，原因是 message */
  failNextStart(name: string, message: string): void;
  /** 这个端口已经登记给别的服务了（put 时回 port-conflict） */
  takePort(port: number, holder: string): void;
  /** 改一个服务的状态并推给守护进程（模拟它挂了、被手动停了） */
  setState(name: string, state: OwnedService["state"], lastError?: string): void;
  /** 这个服务下次启动（start、restart）停在"启动中"，等返回的放行函数叫了才起来、才回（257 号票） */
  holdNextStart(name: string): () => void;
  /** 电脑重启了、LSM 没按开机自启拉（269 号票）：名下的服务全变成停着，不推送（守护进程下次接上时的全量里是停着的） */
  reboot(): void;
}

export interface LsmStandIn {
  /** 放进守护进程环境的四个变量 */
  env: Record<string, string>;
  /** 服务发来的消息（按到达顺序），连同收到的时间 */
  readonly messages: Array<{ message: LinkMessage; at: number }>;
  /** 带着对的令牌连上来的次数、令牌不对被拒的次数 */
  readonly connections: number;
  readonly rejected: number;
  /** 名下服务的模拟（owned 打开时有） */
  readonly owned: OwnedServices;
  /** 等服务发来某条消息（已经收到的也算；from 是从第几条起找） */
  waitFor(match: (message: LinkMessage) => boolean, what: string, options?: { from?: number; timeoutMs?: number }): Promise<LinkMessage>;
  /** 服务发来的名下服务请求（services.*），按到达顺序 */
  serviceRequests(): LinkMessage[];
  /** 往服务发一条（最近的那条连接） */
  send(message: Record<string, unknown>): void;
  /** 断开现在的连接（服务端照开着）：守护进程按退避（1 秒起）重连（269 号票） */
  drop(): void;
  close(): Promise<void>;
}

export async function startLsmStandIn(
  options: { heartbeatIntervalMs?: number; conflict?: boolean; port?: number; token?: string; serviceId?: string; owned?: boolean } = {},
): Promise<LsmStandIn> {
  const token = options.token ?? randomUUID();
  const serviceId = options.serviceId ?? "ergo-daemon";
  const messages: Array<{ message: LinkMessage; at: number }> = [];
  let connections = 0;
  let rejected = 0;
  let latest: WebSocket | undefined;
  const services = new Map<string, OwnedService>();
  const failStart = new Map<string, string>();
  const takenPorts = new Map<number, string>();
  const startHolds = new Map<string, Promise<void>>();

  const send = (message: Record<string, unknown>) => latest?.send(JSON.stringify(message));
  const statusOf = (name: string, s: OwnedService) => ({
    id: `${serviceId}--${name}`,
    name,
    owner: serviceId,
    title: s.definition.title ?? name,
    port: s.definition.port,
    state: s.state,
    desired: s.state === "RUNNING" ? "running" : "stopped",
    up: s.state === "RUNNING",
    listening: s.state === "RUNNING",
    health: s.definition.health ? (s.state === "RUNNING" ? "ok" : null) : null,
    tier: s.definition.health ? "health" : "port",
    autostart: s.autostart,
    linked: false,
    busy: false,
    busyReason: null,
    pendingStop: false,
    capabilities: ["start", ...(s.definition.health ? ["health"] : [])],
    detail: s.state === "RUNNING" ? "HTTP 200" : s.state === "FAILED" ? "起不来" : "停着",
    lastError: s.lastError,
  });
  const push = (changed: string[], removed: string[] = []) =>
    send({ type: "services.status", full: false, services: changed.flatMap((n) => (services.has(n) ? [statusOf(n, services.get(n)!)] : [])), removed });
  const reply = (id: unknown, body: Record<string, unknown>) => send({ type: "services.reply", id, ...body });
  const short = (name: unknown) => String(name ?? "").replace(`${serviceId}--`, "");
  const start = (name: string) => {
    const s = services.get(name)!;
    const failure = failStart.get(name);
    failStart.delete(name);
    s.state = failure ? "FAILED" : "RUNNING";
    s.lastError = failure ?? null;
    push([name]);
    return failure;
  };

  /** 照协议 §7 回名下服务的请求 */
  const handleService = (m: LinkMessage) => {
    const { id } = m;
    if (m.type === "services.put") {
      const def = m.service as OwnedService["definition"];
      const holder = takenPorts.get(def.port);
      if (holder) return reply(id, { ok: false, error: { code: "port-conflict", message: `端口 ${def.port} 已经登记给 ${holder}（探活端口）——管理器不分配端口，换一个（ADR-0008）` } });
      const had = services.get(def.name);
      if (had && had.state === "RUNNING" && had.definition.port !== def.port) {
        return reply(id, { ok: false, error: { code: "running", message: `${def.name} 在跑，不能改端口：先停再登记` }, service: statusOf(def.name, had) });
      }
      const runtime = (d: OwnedService["definition"] | undefined) => JSON.stringify([d?.command, d?.cwd, d?.env ?? []]);
      const changed = !had || JSON.stringify(had.definition) !== JSON.stringify(def);
      const restartNeeded = had?.state === "RUNNING" && runtime(had.definition) !== runtime(def);
      const s: OwnedService = { definition: def, state: had?.state ?? "STOPPED", autostart: typeof def.autostart === "boolean" ? def.autostart : (had?.autostart ?? false), lastError: had?.lastError ?? null };
      services.set(def.name, s);
      push([def.name]);
      return reply(id, { ok: true, created: !had, changed, restartNeeded, service: statusOf(def.name, s) });
    }
    const name = short(m.name);
    const s = services.get(name);
    if (m.type === "services.list") return reply(id, { ok: true, services: [...services].map(([n, x]) => statusOf(n, x)) });
    if (!s) return reply(id, { ok: false, error: { code: "not-found", message: `你名下没有 ${name}` } });
    switch (m.type) {
      case "services.start":
      case "services.restart": {
        if (m.type === "services.restart" && s.state === "RUNNING" && m.force !== true) return reply(id, { ok: false, error: { code: "no-capability", message: "没有重启能力：带 force" } });
        const finish = () => {
          const failure = start(name);
          return failure ? reply(id, { ok: false, error: { code: "failed", message: failure }, service: statusOf(name, s) }) : reply(id, { ok: true, service: statusOf(name, s) });
        };
        const hold = startHolds.get(name);
        if (!hold) return finish();
        startHolds.delete(name);
        s.state = "STARTING";
        push([name]);
        return void hold.then(finish);
      }
      case "services.stop":
        if (s.state === "RUNNING" && m.force !== true) return reply(id, { ok: false, error: { code: "no-capability", message: "没有停机能力：带 force" } });
        s.state = "STOPPED";
        push([name]);
        return reply(id, { ok: true, service: statusOf(name, s) });
      case "services.autostart":
        s.autostart = m.on === true;
        push([name]);
        return reply(id, { ok: true, service: statusOf(name, s) });
      case "services.remove":
        services.delete(name);
        push([], [name]);
        return reply(id, { ok: true, removed: { id: `${serviceId}--${name}`, name } });
      default:
        return reply(id, { ok: false, error: { code: "bad-request", message: `不认识 ${m.type}` } });
    }
  };

  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: options.port ?? 0,
    path: "/link",
    verifyClient: (info: { req: { headers: Record<string, string | string[] | undefined> } }) => {
      const ok = info.req.headers.authorization === `Bearer ${token}`;
      if (!ok) rejected += 1;
      return ok;
    },
  });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  wss.on("connection", (ws) => {
    connections += 1;
    latest = ws;
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString()) as LinkMessage;
      messages.push({ message, at: Date.now() });
      if (options.owned && message.type.startsWith("services.")) return handleService(message);
      if (message.type !== "hello") return;
      if (options.conflict) return ws.send(JSON.stringify({ type: "conflict", reason: "该 serviceId 已有活跃会话" }));
      ws.send(JSON.stringify({ type: "welcome", sessionId: "s-test", heartbeatIntervalMs: options.heartbeatIntervalMs ?? 5000, ...(options.owned ? { features: ["services"] } : {}) }));
      // 新管理器：hello 里声明了要用名下的服务，welcome 之后推一次全量
      const features = message.features;
      if (options.owned && Array.isArray(features) && features.includes("services")) {
        ws.send(JSON.stringify({ type: "services.status", full: true, services: [...services].map(([n, s]) => statusOf(n, s)), removed: [] }));
      }
    });
  });
  const port = (wss.address() as AddressInfo).port;
  const standIn: LsmStandIn = {
    env: { LSM_URL: `ws://127.0.0.1:${port}/link`, LSM_SERVICE_ID: serviceId, LSM_TOKEN: token, LSM_PROTOCOL: "1" },
    messages,
    get connections() {
      return connections;
    },
    get rejected() {
      return rejected;
    },
    owned: {
      services,
      failNextStart: (name, message) => void failStart.set(name, message),
      takePort: (p, holder) => void takenPorts.set(p, holder),
      setState(name, state, lastError) {
        const s = services.get(name);
        if (!s) return;
        s.state = state;
        s.lastError = lastError ?? null;
        push([name]);
      },
      holdNextStart(name) {
        let release: (() => void) | undefined;
        startHolds.set(name, new Promise<void>((resolve) => (release = resolve)));
        return () => release?.();
      },
      reboot() {
        for (const s of services.values()) {
          s.state = "STOPPED";
          s.lastError = null;
        }
      },
    },
    async waitFor(match, what, { from = 0, timeoutMs = 20_000 } = {}) {
      let found: LinkMessage | undefined;
      await waitUntil(() => (found = messages.slice(from).find((m) => match(m.message))?.message) !== undefined, {
        timeoutMs,
        describe: () => `等服务发来${what}；收到的：${JSON.stringify(messages.map((m) => m.message.type))}`,
      });
      return found!;
    },
    serviceRequests: () => messages.map((m) => m.message).filter((m) => m.type.startsWith("services.")),
    send,
    drop() {
      for (const client of wss.clients) client.terminate();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
  onTestFinished(() => standIn.close());
  return standIn;
}
