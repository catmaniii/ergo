// 主切面里的"本机服务"（132 号票）：起在随机端口上的一个小 HTTP 服务，扮演项目跑在这台电脑上的服务，测守护进程按 /apps/<应用名>/ 转发。
// 每个请求（连同 WebSocket 握手）都记下方法、地址、请求头、请求体，测试据此核对转发过去的样子。地址：
// - GET /：首页（<title>简报站首页</title>），带挡嵌入的头（X-Frame-Options: DENY、CSP 的 frame-ancestors 'none'）；
// - /echo…（和 /apps/…：扮演保留前缀的服务）：把收到的方法、地址、请求头、请求体按 JSON 回过去；
// - GET /stream：流式（text/event-stream）：先发一段，等测试叫 releaseStream() 再发第二段、结束；
// - GET /go/<…>：302 跳转，Location 是各种写法（服务自己的绝对地址、localhost、/ 开头的、已经在前缀下的、相对的、别的网站）；
// - GET /cookie：几条 Set-Cookie（Path=/、带 Domain 的、冒充二狗设备凭证的）；
// - /socket：WebSocket，收到什么回什么（前面加"回声："）。
// 133 号票测服务上线时也能用它当"上线的服务"。
import http from "node:http";
import type { AddressInfo } from "node:net";
import { onTestFinished } from "vitest";
import { WebSocketServer } from "ws";

export interface FakeAppRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FakeApp {
  /** http://127.0.0.1:<端口> */
  readonly url: string;
  readonly port: number;
  /** 收到的请求（WebSocket 握手也在里面），按先后 */
  readonly seen: FakeAppRequest[];
  /** 让 /stream 发第二段、结束 */
  releaseStream(): void;
  /** 停掉（服务没在跑） */
  close(): Promise<void>;
}

export const FAKE_APP_HOME = "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>简报站首页</title><link rel=\"stylesheet\" href=\"style.css\"></head><body><h1>简报站</h1></body></html>";

export async function startFakeApp(): Promise<FakeApp> {
  const seen: FakeAppRequest[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let port = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const record: FakeAppRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(record);
      const url = req.url ?? "/";
      if (url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'" });
        return void res.end(FAKE_APP_HOME);
      }
      if (url.startsWith("/echo") || url.startsWith("/apps/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return void res.end(JSON.stringify(record));
      }
      if (url === "/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.write("data: 第一段\n\n");
        return void released.then(() => res.end("data: 第二段\n\n"));
      }
      if (url.startsWith("/go/")) {
        const to: Record<string, string> = {
          "/go/absolute": `http://127.0.0.1:${port}/login?next=%2F`,
          "/go/localhost": `http://localhost:${port}/a#top`,
          "/go/root": "/login",
          "/go/prefixed": "/apps/intel/already",
          "/go/relative": "login",
          "/go/elsewhere": "https://example.com/x",
        };
        res.writeHead(302, { Location: to[url] ?? "/" });
        return void res.end();
      }
      if (url === "/cookie") {
        res.writeHead(200, {
          "Content-Type": "text/plain",
          "Set-Cookie": ["sid=s1; Path=/; HttpOnly", "theme=dark; Domain=127.0.0.1; Path=/settings", "__Host-ergo-device=evil; Path=/; Secure", "plain=1"],
        });
        return void res.end("ok");
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("没有");
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: "" });
    if (req.url !== "/socket") return void socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => ws.send(`回声：${String(data)}`));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    release();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  onTestFinished(close);
  return { url: `http://127.0.0.1:${port}`, port, seen, releaseStream: () => release(), close };
}
