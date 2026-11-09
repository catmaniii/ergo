// 手机本机存的聊天记录（457）的页面测试用的假守护进程：在 127.0.0.1 上系统挑的端口提供构建好的安装版页面、/ws 和往上翻的接口。
// 秘书会话的事件日志照守护进程的规矩补发、分页（history-log.ts：游标 0 只补最近一页，先补最新那条会话树；往上翻按 historyPage），
// 别的频道什么都没有。数往上翻向它要了几次；能让往上翻的接口不通（断网）、吊销这台设备。
// 不碰真的守护进程、真的数据目录、固定端口。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { EventFrame } from "../../src/state/index.ts";
import type { ConversationLog } from "./history-log.ts";

export interface ChatFakeDaemon {
  readonly url: string;
  /** 往上翻向它要过的（before） */
  readonly historyRequests: number[];
  /** 订阅带来的秘书会话的游标（每次连上的第一次真的订阅） */
  readonly subscribedCursors: number[];
  /** 断网：往上翻的接口不通，WebSocket 断掉、再连不上 */
  setOffline(on: boolean): void;
  /** 记进日志的新事件推给连着的页面 */
  pushNew(): void;
  /** 吊销这台设备：断开所有连接，之后问"被信任吗"回 none（revoked） */
  revoke(): void;
  close(): Promise<void>;
}

const send = (ws: WebSocket, value: unknown) => ws.send(JSON.stringify(value));

export async function startChatFakeDaemon(page: string, log: ConversationLog): Promise<ChatFakeDaemon> {
  const historyRequests: number[] = [];
  const subscribedCursors: number[] = [];
  let offline = false;
  let revoked = false;
  const sockets = new Set<WebSocket>();
  /** 每条连接秘书会话推到第几条了（没订阅的没有） */
  const sent = new Map<WebSocket, number>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(page);
    }
    if (url.pathname === "/api/access") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(revoked ? { access: "none", reason: "revoked" } : { access: "local" }));
    }
    const history = /^\/api\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
    if (history && decodeURIComponent(history[1]!) === log.channel) {
      if (offline) {
        res.writeHead(503, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "offline" }));
      }
      const before = url.searchParams.get("before");
      const limit = url.searchParams.get("limit");
      historyRequests.push(Number(before));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(log.page(before === null ? undefined : Number(before), limit === null ? undefined : Number(limit))));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (revoked || offline || !req.url?.startsWith("/ws")) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws: WebSocket) => {
    sockets.add(ws);
    let first = true;
    ws.on("close", () => {
      sockets.delete(ws);
      sent.delete(ws);
    });
    ws.on("message", (data) => {
      const request = JSON.parse(String(data)) as { id: string; method: string; params?: { cursors?: Record<string, number> } };
      if (request.method !== "subscribe") return send(ws, { id: request.id, ok: true, result: {} });
      const cursors = request.params?.cursors ?? {};
      const resync = Object.entries(cursors)
        .filter(([c, cursor]) => cursor > (c === log.channel ? log.last : 0))
        .map(([c]) => c);
      send(ws, { id: request.id, ok: true, result: { protocolVersion: 1, resync } });
      if (!(log.channel in cursors)) return;
      const cursor = resync.includes(log.channel) ? 0 : cursors[log.channel]!;
      if (first) subscribedCursors.push(cursor);
      first = false;
      for (const frame of log.replay(cursor)) send(ws, frame);
      sent.set(ws, log.last);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    historyRequests,
    subscribedCursors,
    setOffline(on) {
      offline = on;
      if (on) for (const ws of sockets) ws.terminate();
    },
    pushNew() {
      for (const [ws, upTo] of sent) {
        const fresh: EventFrame[] = log.frames.filter((f) => f.seq > upTo);
        for (const frame of fresh) send(ws, frame);
        sent.set(ws, log.last);
      }
    },
    revoke() {
      revoked = true;
      for (const ws of sockets) ws.close(4401, "revoked");
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
