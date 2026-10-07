// 网关的本机端口（规格第 5、6 节）：只监听 127.0.0.1，校验 Host 和 Origin。提供
// - Web UI 的静态文件（单文件构建产物 index.html，每次请求重新读，重新构建后不用重启；原样发出，不往页面里塞任何密钥或令牌）；
// - 健康探针 /healthz（LSM 用）：秘书和 Web UI 构建产物的状况，不健康时回 503 并写明原因；
// - /ws：每个前端一条 WebSocket，帧分请求、响应、事件三种（共享协议包定义）。
// 外网端口和设备凭证在 10 号票。
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  type CardActionParams,
  type CardActionResult,
  type ErrorBody,
  type EventFrame,
  FRONTEND_PROTOCOL_VERSION,
  type InboxActionParams,
  type InboxActionResult,
  isChannel,
  isEphemeralEventType,
  METHODS,
  type ParsedRequest,
  parseRequest,
  type ResponseFrame,
  type SubscribeResult,
} from "@ergou/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { MessageRejected, postUserMessage } from "../conversation/messages.ts";
import type { StreamHub } from "../conversation/stream-hub.ts";
import { RequestRejected } from "../errors.ts";
import type { EphemeralSource } from "../events/ephemeral.ts";
import type { EventStore, StoredEvent } from "../events/event-store.ts";
import { checkLocalRequest } from "./local-origin.ts";

export const LOCAL_HOST = "127.0.0.1";
/** 单帧上限：文本消息足够；图片和文件走 HTTP 上传（09） */
const MAX_FRAME_BYTES = 1024 * 1024;

/** 守护进程其他部分报给 /healthz 的健康状况 */
export interface HealthReport {
  ok: boolean;
  /** 原样放进 /healthz 返回里的细节（比如秘书的状态） */
  details: Record<string, unknown>;
  /** 不健康的原因 */
  reasons: string[];
}

/** 网关交给别的模块处理的请求（不满足时抛 RequestRejected，网关回成错误响应） */
export interface RequestHandlers {
  /** 对卡片做动作（cards/cards.ts） */
  cardAction(params: CardActionParams, idempotencyKey: string): CardActionResult;
  /** 对待我处理事项做动作（inbox/inbox.ts） */
  inboxAction(params: InboxActionParams, idempotencyKey: string): InboxActionResult;
}

export interface GatewayOptions {
  /** 端口；0 表示由系统挑一个空闲端口（测试用） */
  port: number;
  store: EventStore;
  streams: StreamHub;
  /** 别的临时事件（到点的提醒这类通知），和流式增量一样只推给正连着、订阅了那个频道的前端 */
  notifications: EphemeralSource;
  requests: RequestHandlers;
  /** Web UI 构建产物所在的目录（里面有 index.html） */
  webRoot: string;
  /** 守护进程其他部分的健康状况，合进 /healthz */
  health: () => HealthReport;
  log: (line: string) => void;
}

export interface Gateway {
  /** 实际监听的端口 */
  readonly port: number;
  /** 本机地址，如 http://127.0.0.1:8810 */
  readonly url: string;
  close(): Promise<void>;
}

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const { store, streams, log } = options;
  const indexFile = path.join(options.webRoot, "index.html");
  const connections = new Set<FrontendConnection>();
  let port = options.port;

  const health = (): { status: number; body: Record<string, unknown> } => {
    const webUi = fs.existsSync(indexFile);
    const rest = options.health();
    const reasons = [...rest.reasons, ...(webUi ? [] : ["Web UI 还没构建：在仓库根目录运行 npm run build:web"])];
    const ok = rest.ok && webUi;
    return { status: ok ? 200 : 503, body: { ok, ...rest.details, webUi, reasons } };
  };

  const server = http.createServer((req, res) => {
    const check = checkLocalRequest(req.headers, port);
    if (!check.ok) return reply(res, 403, "text/plain; charset=utf-8", `拒绝：${check.reason}\n`);
    if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, "text/plain; charset=utf-8", "只支持 GET\n");
    const url = new URL(req.url ?? "/", `http://${LOCAL_HOST}`);
    if (url.pathname === "/healthz") {
      const { status, body } = health();
      return reply(res, status, "application/json; charset=utf-8", JSON.stringify(body));
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      let page: Buffer;
      try {
        page = fs.readFileSync(indexFile);
      } catch {
        return reply(res, 503, "text/plain; charset=utf-8", "Web UI 还没构建：在仓库根目录运行 npm run build:web\n");
      }
      return reply(res, 200, "text/html; charset=utf-8", page);
    }
    return reply(res, 404, "text/plain; charset=utf-8", "没有这个地址\n");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  server.on("upgrade", (req, socket, head) => {
    const check = checkLocalRequest(req.headers, port);
    const pathname = new URL(req.url ?? "/", `http://${LOCAL_HOST}`).pathname;
    if (!check.ok || pathname !== "/ws") {
      const status = check.ok ? "404 Not Found" : "403 Forbidden";
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const connection = new FrontendConnection(ws, store, options.requests, log);
      connections.add(connection);
      ws.on("close", () => connections.delete(connection));
    });
  });

  // 落盘事件和临时事件都推给订阅了那个频道的前端
  const offAppend = store.onAppend((event) => {
    for (const c of connections) c.pushStored(event);
  });
  const offStream = streams.onFrame((frame) => {
    for (const c of connections) c.pushEphemeral(frame);
  });
  const offNotifications = options.notifications.onFrame((frame) => {
    for (const c of connections) c.pushEphemeral(frame);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, LOCAL_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  server.on("error", (err) => log(`本机端口出错：${err.message}`));

  return {
    port,
    url: `http://${LOCAL_HOST}:${port}`,
    async close() {
      offAppend();
      offStream();
      offNotifications();
      for (const c of connections) c.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function reply(res: http.ServerResponse, status: number, contentType: string, body: string | Buffer): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(res.req.method === "HEAD" ? undefined : body);
}

/**
 * 一个前端的 WebSocket。订阅时补发每个频道缺的落盘事件，之后推送新事件；临时事件只推给正连着的。
 * 存储的接口是同步的（node:sqlite），读补发的事件和登记订阅在同一段同步代码里完成，中间不会插进新事件，
 * 所以补发和实时推送之间不重不漏。
 */
class FrontendConnection {
  /** 订阅的频道 → 已经推给这个前端的最后一个落盘事件序号 */
  private readonly subscriptions = new Map<string, number>();
  private readonly ws: WebSocket;
  private readonly store: EventStore;
  private readonly requests: RequestHandlers;
  private readonly log: (line: string) => void;

  constructor(ws: WebSocket, store: EventStore, requests: RequestHandlers, log: (line: string) => void) {
    this.ws = ws;
    this.store = store;
    this.requests = requests;
    this.log = log;
    ws.on("message", (data, isBinary) => {
      if (isBinary) return this.respond({ id: null, ok: false, error: { code: "bad_frame", message: "只收文本帧" } });
      this.onRequest(String(data));
    });
    ws.on("error", (err) => log(`WebSocket 出错：${err.message}`));
  }

  pushStored(event: StoredEvent): void {
    const sent = this.subscriptions.get(event.channel);
    if (sent === undefined || event.seq <= sent) return;
    this.subscriptions.set(event.channel, event.seq);
    this.send({ channel: event.channel, seq: event.seq, type: event.type, payload: event.payload });
  }

  pushEphemeral(frame: EventFrame): void {
    if (this.subscriptions.has(frame.channel) && isEphemeralEventType(frame.type)) this.send(frame);
  }

  terminate(): void {
    this.ws.terminate();
  }

  private onRequest(raw: string): void {
    const parsed = parseRequest(raw);
    if (!parsed.ok) return this.respond({ id: parsed.id, ok: false, error: parsed.error });
    const { request } = parsed;
    try {
      this.dispatch(request);
    } catch (err) {
      if (err instanceof MessageRejected || err instanceof RequestRejected) return this.fail(request.id, { code: err.code, message: err.message });
      this.log(`处理请求 ${request.method} 出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      this.fail(request.id, { code: "internal", message: "守护进程内部出错" });
    }
  }

  private dispatch(request: ParsedRequest): void {
    switch (request.method) {
      case METHODS.subscribe: {
        const { protocolVersion, cursors } = request.params;
        if (protocolVersion !== FRONTEND_PROTOCOL_VERSION) {
          return this.fail(request.id, { code: "protocol_mismatch", message: `前端协议版本 ${protocolVersion}，守护进程是 ${FRONTEND_PROTOCOL_VERSION}：请刷新页面` });
        }
        const unknown = Object.keys(cursors).filter((c) => !isChannel(c));
        if (unknown.length > 0) return this.fail(request.id, { code: "bad_params", message: `没有这些频道：${unknown.join("、")}` });
        // 前端带来的序号比这个频道的最后序号还大（比如数据目录恢复成了旧快照）：让前端清掉这个频道，从头补发
        const resync = Object.entries(cursors)
          .filter(([channel, cursor]) => cursor > this.store.lastSeq(channel))
          .map(([channel]) => channel);
        const result: SubscribeResult = { protocolVersion: FRONTEND_PROTOCOL_VERSION, resync };
        this.respond({ id: request.id, ok: true, result });
        // 补发：每个频道序号大于前端游标的落盘事件；之后的新事件由 pushStored 接着推
        for (const [channel, cursor] of Object.entries(cursors)) {
          const from = resync.includes(channel) ? 0 : Math.max(cursor, this.subscriptions.get(channel) ?? 0);
          this.subscriptions.set(channel, from);
          for (const event of this.store.read(channel, from)) this.pushStored(event);
        }
        return;
      }
      case METHODS.sendMessage: {
        const result = postUserMessage(this.store, { ...request.params, idempotencyKey: request.idempotencyKey });
        return this.respond({ id: request.id, ok: true, result });
      }
      case METHODS.cardAction:
        return this.respond({ id: request.id, ok: true, result: this.requests.cardAction(request.params, request.idempotencyKey) });
      case METHODS.inboxAction:
        return this.respond({ id: request.id, ok: true, result: this.requests.inboxAction(request.params, request.idempotencyKey) });
    }
  }

  private fail(id: string, error: ErrorBody): void {
    this.respond({ id, ok: false, error });
  }

  private respond(frame: ResponseFrame): void {
    this.send(frame);
  }

  private send(frame: EventFrame | ResponseFrame): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }
}
