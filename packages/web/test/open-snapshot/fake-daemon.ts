// 打开页面量补发用的假守护进程（388）：在 127.0.0.1 上系统挑的端口提供构建好的安装版页面和 /ws，照守护进程的规矩补发合成的事件日志
// （gateway.ts 的 subscribe：先回响应，再按游标补发；游标为 0 时会话频道只补最近一页；带来的游标比最后一条还大的点名重新同步；
// 空订阅当回执，只回响应）。数每条连接上推了多少帧、多少字节、回执什么时候回的。
// 不碰真的守护进程、真的数据目录、固定端口。
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { HISTORY_PAGE_SIZE } from "../../src/state/index.ts";
import type { SyntheticLog } from "./synthetic.ts";

/** 一条连接上的补发：推了几帧、多少字节，主订阅的回执什么时候回的 */
export interface ConnectionCount {
  frames: number;
  bytes: number;
  subscribedAt?: number;
  receiptAt?: number;
  /** 订阅带来的游标（第一次真的订阅） */
  cursors?: Record<string, number>;
}

export interface FakeDaemon {
  readonly url: string;
  /** 每条连接一份，按连上的先后 */
  readonly connections: ConnectionCount[];
  /** 订阅之后先等这么久再回、再补（看补完之前界面是什么样子）；0 是马上 */
  holdReplay(ms: number): void;
  /** 换一个页面给（模拟网页升级：只换 index.html 里的版本号） */
  setWebVersion(version: string): void;
  /** 吊销这台设备：断开所有连接，之后问"被信任吗"回 none（revoked） */
  revoke(): void;
  close(): Promise<void>;
}

const WEB_VERSION_META = /<meta name="ergo-web-version" content="([^"]*)"\s*\/?>/;

/** html：构建出的安装版 index.html（单个文件，脚本样式都内联了）；assets：构建目录（字体从这里给，不给就 404） */
export async function startFakeDaemon(page: string, log: SyntheticLog, assets?: string): Promise<FakeDaemon> {
  const builtVersion = WEB_VERSION_META.exec(page)?.[1];
  if (builtVersion === undefined) throw new Error("构建出的 index.html 里没有网页版本号");
  let webVersion = builtVersion;
  let revoked = false;
  let holdMs = 0;
  const connections: ConnectionCount[] = [];
  const sockets = new Set<WebSocket>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(page.replace(WEB_VERSION_META, `<meta name="ergo-web-version" content="${webVersion}">`));
    }
    if (url.pathname === "/api/access") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(revoked ? { access: "none", reason: "revoked" } : { access: "local" }));
    }
    const file = assets === undefined ? undefined : path.join(assets, decodeURIComponent(url.pathname));
    if (assets !== undefined && file !== undefined && !url.pathname.startsWith("/api/") && file.startsWith(assets) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200);
      return res.end(fs.readFileSync(file));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (revoked || !req.url?.startsWith("/ws")) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws: WebSocket) => {
    sockets.add(ws);
    ws.on("close", () => sockets.delete(ws));
    const count: ConnectionCount = { frames: 0, bytes: 0 };
    connections.push(count);
    let mainReceipt = true;
    let queue = Promise.resolve();
    const send = (value: unknown, frame: boolean) => {
      const text = JSON.stringify(value);
      if (frame) {
        count.frames += 1;
        count.bytes += Buffer.byteLength(text, "utf8");
      }
      ws.send(text);
    };
    ws.on("message", (data) => {
      const request = JSON.parse(String(data)) as { id: string; method: string; params?: { cursors?: Record<string, number> } };
      if (request.method !== "subscribe") return send({ id: request.id, ok: true, result: {} }, false);
      const cursors = request.params?.cursors ?? {};
      const channels = Object.keys(cursors);
      if (channels.length === 0) {
        // 回执：补发都推完了
        const receipt = () => {
          if (mainReceipt) count.receiptAt = Date.now();
          mainReceipt = false;
          send({ id: request.id, ok: true, result: { protocolVersion: 1, resync: [] } }, false);
        };
        queue = queue.then(receipt);
        return;
      }
      if (count.cursors === undefined) {
        count.cursors = cursors;
        count.subscribedAt = Date.now();
      }
      const reply = () => {
        const resync = channels.filter((c) => cursors[c]! > log.lastSeq(c));
        send({ id: request.id, ok: true, result: { protocolVersion: 1, resync, webVersion } }, false);
        for (const channel of channels) {
          const known = resync.includes(channel) ? 0 : cursors[channel]!;
          const from = known === 0 ? firstReplayAfter(log, channel) : known;
          for (const frame of log.channels.get(channel) ?? []) if (frame.seq > from) send(frame, true);
        }
      };
      // 同一条连接上的请求按到的先后办（回执排在补发后面）：等着的时候后到的回执也跟着等
      const hold = holdMs;
      queue = queue.then(() => (hold === 0 ? reply() : new Promise<void>((resolve) => setTimeout(() => resolve(reply()), hold))));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    connections,
    holdReplay(ms) {
      holdMs = ms;
    },
    setWebVersion(version) {
      webVersion = version;
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

/** 游标为 0 时从哪条之后补：会话频道只补最近一页消息起的，别的从头（照 conversation/history.ts，这里没有回退、排队） */
function firstReplayAfter(log: SyntheticLog, channel: string): number {
  if (channel !== "secretary" && !channel.startsWith("maintainer:")) return 0;
  const messages = (log.channels.get(channel) ?? []).filter((f) => f.type === "message");
  if (messages.length < HISTORY_PAGE_SIZE) return 0;
  return messages[messages.length - HISTORY_PAGE_SIZE]!.seq - 1;
}
