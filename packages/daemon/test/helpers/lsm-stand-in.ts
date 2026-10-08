// LSM 接入层的替身（23 号票）：按 LSM 的 link 协议 v1（LSM 仓库的 docs/link-protocol.md）当管理器那一端，
// 只认带 Authorization: Bearer <令牌> 的连接；收到 hello 回 welcome（心跳间隔由测试定）或 conflict；记下服务发来的每条消息，
// 测试可以往服务发停机、撤销、ping。守护进程的环境里放 env 就会连上它。测试结束时关掉。
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

export interface LsmStandIn {
  /** 放进守护进程环境的四个变量 */
  env: Record<string, string>;
  /** 服务发来的消息（按到达顺序），连同收到的时间 */
  readonly messages: Array<{ message: LinkMessage; at: number }>;
  /** 带着对的令牌连上来的次数、令牌不对被拒的次数 */
  readonly connections: number;
  readonly rejected: number;
  /** 等服务发来某条消息（已经收到的也算；from 是从第几条起找） */
  waitFor(match: (message: LinkMessage) => boolean, what: string, options?: { from?: number; timeoutMs?: number }): Promise<LinkMessage>;
  /** 往服务发一条（最近的那条连接） */
  send(message: Record<string, unknown>): void;
  close(): Promise<void>;
}

export async function startLsmStandIn(options: { heartbeatIntervalMs?: number; conflict?: boolean; port?: number; token?: string; serviceId?: string } = {}): Promise<LsmStandIn> {
  const token = options.token ?? randomUUID();
  const serviceId = options.serviceId ?? "ergou-daemon";
  const messages: Array<{ message: LinkMessage; at: number }> = [];
  let connections = 0;
  let rejected = 0;
  let latest: WebSocket | undefined;
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
      if (message.type !== "hello") return;
      ws.send(JSON.stringify(options.conflict ? { type: "conflict", reason: "该 serviceId 已有活跃会话" } : { type: "welcome", sessionId: "s-test", heartbeatIntervalMs: options.heartbeatIntervalMs ?? 5000 }));
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
    async waitFor(match, what, { from = 0, timeoutMs = 20_000 } = {}) {
      let found: LinkMessage | undefined;
      await waitUntil(() => (found = messages.slice(from).find((m) => match(m.message))?.message) !== undefined, {
        timeoutMs,
        describe: () => `等服务发来${what}；收到的：${JSON.stringify(messages.map((m) => m.message.type))}`,
      });
      return found!;
    },
    send(message) {
      latest?.send(JSON.stringify(message));
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
