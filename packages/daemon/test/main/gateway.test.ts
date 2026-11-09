// 主切面：网关的本机端口。只听 127.0.0.1、端口从配置读；Origin 和 Host 不对的 HTTP 和 WebSocket 请求被拒
// （DNS 重绑定、跨站 WebSocket）；提供 Web UI 静态文件和健康探针；格式不对的请求得到错误响应，连接不断。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { FRONTEND_PROTOCOL_VERSION, type SubscribeResult, webVersionInHtml } from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { COMPRESS_MIN_CHARS } from "../../src/gateway/gateway.ts";
import { serviceKey } from "../../src/plugins/host.ts";
import { startTestDaemon, TEST_PAGE } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { writePortConfig } from "../helpers/ports.ts";
import { SECRETARY_START_TIMEOUT_MS, waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { fakeSecret } from "../helpers/fake-secrets.ts";

const LAN_ADDRESS = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a !== undefined && a.family === "IPv4" && !a.internal)?.address;

describe("本机端口", () => {
  it("只监听 127.0.0.1，端口号从配置读", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const homeDir = makeTempDir("ergo-home-");
    const port = await writePortConfig(dataDir);

    const { url } = await startTestDaemon({ reuse: { dataDir, homeDir }, portFromConfig: true });
    expect(url).toBe(`http://127.0.0.1:${port}`);
    expect((await get(url, "/healthz")).status).toBe(200);
  });

  // 本机有别的 IPv4 地址（网卡）时：从那个地址连不进来
  it.skipIf(LAN_ADDRESS === undefined)("从本机的网卡地址连不进来", async () => {
    const { url } = await startTestDaemon();
    await expect(connectTcp(LAN_ADDRESS!, Number(new URL(url).port))).rejects.toThrow(/ECONNREFUSED|连接超时|EHOSTUNREACH|ENETUNREACH/);
  });

  it("健康探针 /healthz：秘书在运行时健康；插件的状况也在里面", async () => {
    const { url, daemon } = await startTestDaemon();
    await waitUntil(() => daemon.secretary.status === "idle", { timeoutMs: SECRETARY_START_TIMEOUT_MS, describe: () => `秘书现在是 ${daemon.secretary.status}` });
    const res = await get(url, "/healthz");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.body)).toEqual({ ok: true, status: "ok", secretary: "idle", plugins: { running: ["reminders", "memory", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki", "codex", "map", "google-maps"], disabled: [], skipped: [] }, webUi: true, reasons: [] });
  });

  it("健康探针 /healthz：启用着的插件没装上（缺依赖、装配出错）算降级，status 是 degraded、写明哪个插件为什么，照旧回 200；配置里停用的不算", async () => {
    const nowhere = serviceKey<unknown>("nowhere");
    const { url, daemon } = await startTestDaemon({
      extraPlugins: [
        { name: "orphan", title: "缺依赖的", needs: [nowhere], setup() {} },
        {
          name: "crashing",
          title: "装配出错的",
          setup() {
            throw new Error("故意装不上");
          },
        },
        // 配置里主动停用的：它要的服务也没有，但不算降级
        { name: "off", title: "停用的", needs: [nowhere], setup() {} },
      ],
      config: { plugins: { disabled: ["off"] } },
    });
    await waitUntil(() => daemon.secretary.status === "idle", { timeoutMs: SECRETARY_START_TIMEOUT_MS, describe: () => `秘书现在是 ${daemon.secretary.status}` });
    const res = await get(url, "/healthz");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      status: "degraded",
      secretary: "idle",
      plugins: {
        running: ["reminders", "memory", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki", "codex", "map", "google-maps"],
        disabled: ["off"],
        skipped: [
          { plugin: "orphan", reason: "要的服务 nowhere 没有谁提供" },
          { plugin: "crashing", reason: "装配出错：故意装不上" },
        ],
      },
      webUi: true,
      reasons: ["插件 orphan 没装上：要的服务 nowhere 没有谁提供", "插件 crashing 没装上：装配出错：故意装不上"],
    });
  });

  it("健康探针 /healthz：配置里停用了插件不算降级", async () => {
    const { url, daemon } = await startTestDaemon({ plugins: [] });
    await waitUntil(() => daemon.secretary.status === "idle", { timeoutMs: SECRETARY_START_TIMEOUT_MS, describe: () => `秘书现在是 ${daemon.secretary.status}` });
    const res = await get(url, "/healthz");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, status: "ok", plugins: { running: [], disabled: ["reminders", "memory", "calendar", "voice", "browsing", "claude-code", "phone", "google", "looki", "codex", "map", "google-maps"], skipped: [] }, reasons: [] });
  });

  it("健康探针 /healthz：秘书不在运行超过阈值时不健康，写明原因", async () => {
    // 模型目录里没有的模型：秘书子进程每次装配都失败退出，一直在重新拉起
    const { url } = await startTestDaemon({
      secretaryModel: { kind: "catalog", provider: "nowhere", modelId: "none", thinkingLevel: "off" },
      secretaryDownThresholdMs: 300,
    });
    let health = await get(url, "/healthz");
    for (let i = 0; i < 100 && health.status !== 503; i++) {
      await new Promise((r) => setTimeout(r, 100));
      health = await get(url, "/healthz");
    }
    expect(health.status).toBe(503);
    const body = JSON.parse(health.body) as { ok: boolean; secretary: string; reasons: string[] };
    expect(body).toMatchObject({ ok: false, status: "unhealthy", webUi: true });
    expect(["starting", "restarting"]).toContain(body.secretary);
    expect(body.reasons.join("")).toMatch(/秘书子进程已经 \d+ 秒没在运行/);
  });

  it("提供 Web UI 静态文件：原样发出，不往页面里塞东西", async () => {
    const { url, webRoot } = await startTestDaemon();
    const res = await get(url, "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toBe(fs.readFileSync(path.join(webRoot, "index.html"), "utf8"));
    expect(res.body).toBe(TEST_PAGE);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect((await get(url, "/nope")).status).toBe(404);
  });

  it("浏览器说收 gzip 时页面压缩了发（450：手机切回前台要重新下页面时少等几秒），解开和原文一字不差；不说的原样发；页面换了跟着换", async () => {
    const webRoot = makeTempDir("ergo-gzip-web-");
    const big = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>${"const 二狗 = '把记忆还给你';\n".repeat(20_000)}</script></body></html>`;
    fs.writeFileSync(path.join(webRoot, "index.html"), big);
    const { url, externalUrl } = await startTestDaemon({ webRoot });
    const zipped = await getRaw(url, "/", "gzip, deflate, br");
    expect(zipped.status).toBe(200);
    expect(zipped.headers["content-encoding"]).toBe("gzip");
    expect(zipped.headers["vary"]).toBe("Accept-Encoding");
    expect(zipped.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(zipped.body.length).toBeLessThan(Buffer.byteLength(big) / 10);
    expect(zlib.gunzipSync(zipped.body).toString("utf8")).toBe(big);
    // 外网端口上还没配对的新设备拿到的配对页同样压缩
    const viaTunnel = await getRaw(externalUrl, "/", "gzip");
    expect(viaTunnel.headers["content-encoding"]).toBe("gzip");
    expect(zlib.gunzipSync(viaTunnel.body).toString("utf8")).toBe(big);
    // 不收 gzip（没说、q=0）：原样
    for (const accept of [undefined, "identity", "gzip;q=0", "br"]) {
      const plain = await getRaw(url, "/", accept);
      expect({ accept, encoding: plain.headers["content-encoding"] }).toEqual({ accept, encoding: undefined });
      expect(plain.body.toString("utf8")).toBe(big);
    }
    // 重新构建了（页面换了）：压的是新的
    const rebuilt = big.replace("把记忆还给你", "越懂你，越放心");
    fs.writeFileSync(path.join(webRoot, "index.html"), rebuilt);
    expect(zlib.gunzipSync((await getRaw(url, "/", "gzip")).body).toString("utf8")).toBe(rebuilt);
  });

  it("页面脚本里没有任何私钥或令牌：现场构建真正的 Web UI，经本机端口和外网端口（还没配对的新设备）取回来扫一遍", async () => {
    const webRoot = buildWebUi();
    const key = fakeSecret("sk-", "MARKERnotARealKey0123456789abcdef");
    const { url, externalUrl } = await startTestDaemon({ webRoot, env: { DEEPSEEK_API_KEY: key, LSM_TOKEN: "lsm-token-MARKER-0123456789" } });
    // 外网端口上没有凭证也拿得到页面本身（它显示配对等待页）：和本机端口的一字不差，不带 cookie
    const viaTunnel = await get(externalUrl, "/");
    expect(viaTunnel.status).toBe(200);
    expect(viaTunnel.body).toBe(fs.readFileSync(path.join(webRoot, "index.html"), "utf8"));
    expect(viaTunnel.headers["set-cookie"]).toBeUndefined();
    // 设备凭证只在 HttpOnly cookie 里：页面脚本不读也不写 cookie
    expect(viaTunnel.body).not.toContain("document.cookie");
    const page = await get(url, "/");
    expect(page.status).toBe(200);
    expect(page.body).toBe(fs.readFileSync(path.join(webRoot, "index.html"), "utf8"));
    expect(page.body).toContain('<div id="root">');
    expect(page.body.length).toBeGreaterThan(100_000);
    for (const pattern of SECRET_PATTERNS) expect(page.body, `页面里出现了 ${pattern}`).not.toMatch(pattern);
    expect(page.body).not.toContain(key);
    // 构建产物带着版本号，连上时订阅的响应里就是它（开着的页面据此知道服务端的页面更新了）
    const version = webVersionInHtml(page.body);
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    const frontend = await TestFrontend.connect(url);
    const subscribed = await frontend.subscribe({});
    expect(subscribed.ok && (subscribed.result as SubscribeResult).webVersion).toBe(version);
    expect(page.body).not.toContain("lsm-token-MARKER");
    const health = (await get(url, "/healthz")).body;
    for (const pattern of SECRET_PATTERNS) expect(health).not.toMatch(pattern);
    // 视觉风格的字体：构建时拷进了 fonts/，经本机端口取得到，样式表里引用的字体文件也在；
    // 外网端口上还没配对的新设备取不到
    const fonts = await get(url, "/fonts/grid.css");
    expect(fonts.status).toBe(200);
    const firstFont = /url\("([^"]+\.woff2)"\)/.exec(fonts.body)?.[1];
    expect(firstFont).toBeDefined();
    expect((await get(url, `/fonts/${firstFont}`)).status).toBe(200);
    expect((await get(externalUrl, "/fonts/grid.css")).status).toBe(401);
    // 设置里风格预览用的那份（只收预览里那几个字的 @font-face），引用的字体文件也在
    const preview = await get(url, "/fonts/preview.css");
    expect(preview.status).toBe(200);
    const previewFont = /url\("([^"]+\.woff2)"\)/.exec(preview.body)?.[1];
    expect(previewFont).toBeDefined();
    expect((await get(url, `/fonts/${previewFont}`)).status).toBe(200);
  });

  it("Web UI 还没构建：页面返回 503 并说明怎么构建，健康探针报告不健康", async () => {
    const { url } = await startTestDaemon({ webRoot: makeTempDir("ergo-empty-web-") });
    const page = await get(url, "/");
    expect(page.status).toBe(503);
    expect(page.body).toContain("npm run build:web");
    const health = await get(url, "/healthz");
    expect(health.status).toBe(503);
    const body = JSON.parse(health.body) as { ok: boolean; webUi: boolean; reasons: string[] };
    expect(body).toMatchObject({ ok: false, webUi: false });
    expect(body.reasons.join("")).toContain("npm run build:web");
  });
});

describe("Origin 和 Host 校验", () => {
  it("DNS 重绑定：Host 是外部域名的 HTTP 请求和 WebSocket 握手都被拒", async () => {
    const { url } = await startTestDaemon();
    const port = new URL(url).port;
    expect((await get(url, "/", { host: `attacker.example:${port}` })).status).toBe(403);
    expect((await get(url, "/healthz", { host: `attacker.example:${port}` })).status).toBe(403);
    await expect(TestFrontend.connect(url, { host: `attacker.example:${port}` })).rejects.toThrow("HTTP 403");
    // 端口不对的 Host 同样不认
    expect((await get(url, "/", { host: "127.0.0.1:1" })).status).toBe(403);
  });

  it("跨站：别的网站发起的 HTTP 请求和 WebSocket 握手都被拒", async () => {
    const { url } = await startTestDaemon();
    expect((await get(url, "/", { origin: "https://attacker.example" })).status).toBe(403);
    expect((await get(url, "/", { origin: "null" })).status).toBe(403);
    await expect(TestFrontend.connect(url, { origin: "https://attacker.example" })).rejects.toThrow("HTTP 403");
    await expect(TestFrontend.connect(url, { origin: "null" })).rejects.toThrow("HTTP 403");
  });

  it("本机页面自己的源（127.0.0.1 或 localhost）和不带 Origin 的本机程序（不在浏览器里）都放行", async () => {
    const { url } = await startTestDaemon();
    const port = new URL(url).port;
    expect((await get(url, "/", { origin: url })).status).toBe(200);
    expect((await get(url, "/", { host: `localhost:${port}`, origin: `http://localhost:${port}` })).status).toBe(200);
    const sameOrigin = await TestFrontend.connect(url, { origin: url });
    expect(await sameOrigin.subscribe({ secretary: 0 })).toMatchObject({ ok: true });
    const viaLocalhost = await TestFrontend.connect(url, { host: `localhost:${port}`, origin: `http://localhost:${port}` });
    expect(await viaLocalhost.subscribe({ secretary: 0 })).toMatchObject({ ok: true });
  });
});

describe("请求帧", () => {
  it("格式不对的请求得到错误响应，连接不断", async () => {
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", text: "还在" }] });
    const frontend = await TestFrontend.connect(url);

    frontend.sendRaw("{oops");
    expect(await frontend.nextResponse()).toMatchObject({ id: null, ok: false, error: { code: "bad_frame" } });
    frontend.sendRaw(JSON.stringify({ id: "x1", method: "drop_tables", params: {} }));
    expect(await frontend.nextResponse()).toMatchObject({ id: "x1", ok: false, error: { code: "unknown_method" } });

    expect(await frontend.request("subscribe", { protocolVersion: FRONTEND_PROTOCOL_VERSION + 1, cursors: {} })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(await frontend.request("subscribe", { protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors: { nowhere: 0 } })).toMatchObject({ ok: false, error: { code: "bad_params" } });
    expect(await frontend.request("send_message", text("没带幂等键"))).toMatchObject({ ok: false, error: { code: "idempotency_key_required" } });
    expect(await frontend.request("send_message", { conversation: "secretary", parts: [] }, "k-empty")).toMatchObject({ ok: false, error: { code: "bad_params" } });
    expect(await frontend.request("send_message", text("   "), "k-blank")).toMatchObject({ ok: false, error: { code: "bad_params" } });
    // 负责人的会话（能发）：没有这个负责人
    expect(await frontend.request("send_message", { conversation: "maintainer:p-notes", parts: [{ type: "text", text: "在吗" }] }, "k-m")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await frontend.request("card_action", { cardId: "c1", action: "approve", expectedVersion: 1 }, "k-c")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await frontend.request("inbox_action", { itemIds: ["i1"], action: "read" }, "k-i")).toMatchObject({ ok: false, error: { code: "not_found" } });

    // 连接还在，照常能用；被拒的请求一条消息也没落
    expect(await frontend.subscribe({ secretary: 0 })).toMatchObject({ ok: true });
    await frontend.sendText("还在吗");
    await frontend.next("secretary", "turn_end");
    expect(frontend.events({ persistedOnly: true }).map((f) => f.type)).toEqual(["message", "turn_start", "message", "turn_end"]);
  });
});

describe("WebSocket 压缩（permessage-deflate，452）", () => {
  it("提了 permessage-deflate 的（浏览器那样）协商上：长的事件帧压了发、解开一字不差，短的响应照原样；没提的照常不压", async () => {
    const { url } = await startTestDaemon({ secretary: [{ kind: "reply", text: "收到".repeat(400) }] });
    const writer = await TestFrontend.connect(url);
    await writer.subscribe({ secretary: 0 });
    await writer.sendText("这是一段要压的长话。".repeat(200));
    await writer.next("secretary", "turn_end");
    const expected = writer.events({ persistedOnly: true }).map((f) => JSON.stringify(f));

    const port = Number(new URL(url).port);
    const zipped = await rawWebSocket(port, true);
    expect(zipped.extensions).toMatch(/^permessage-deflate/);
    zipped.sendText(JSON.stringify({ id: "s1", method: "subscribe", params: { protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors: { secretary: 0 } } }));
    const zFrames = await zipped.readUntil((texts) => texts.filter((t) => t.startsWith('{"channel"')).length >= expected.length);
    zipped.close();
    const response = zFrames.find((f) => f.text.startsWith('{"id":"s1"'))!;
    expect(response.text.length).toBeLessThan(COMPRESS_MIN_CHARS);
    expect(response.rsv1).toBe(false);
    const events = zFrames.filter((f) => f.text.startsWith('{"channel"'));
    expect(events.map((f) => f.text)).toEqual(expected);
    // 长的（两条消息）压了，线上比原文小得多
    const long = events.filter((f) => f.text.length >= 1000);
    expect(long.length).toBeGreaterThanOrEqual(2);
    for (const f of long) {
      expect(f.rsv1).toBe(true);
      expect(f.wireBytes).toBeLessThan(Buffer.byteLength(f.text) / 5);
    }
    for (const f of events) expect(f.rsv1).toBe(f.text.length >= COMPRESS_MIN_CHARS);

    const plain = await rawWebSocket(port, false);
    expect(plain.extensions).toBeUndefined();
    plain.sendText(JSON.stringify({ id: "s1", method: "subscribe", params: { protocolVersion: FRONTEND_PROTOCOL_VERSION, cursors: { secretary: 0 } } }));
    const pFrames = await plain.readUntil((texts) => texts.filter((t) => t.startsWith('{"channel"')).length >= expected.length);
    plain.close();
    expect(pFrames.every((f) => !f.rsv1)).toBe(true);
    expect(pFrames.filter((f) => f.text.startsWith('{"channel"')).map((f) => f.text)).toEqual(expected);
  });
});

/** 线上收到的一帧：RSV1（压没压）、线上多少字节（不含帧头）、解开后的文字 */
interface WireFrame {
  rsv1: boolean;
  wireBytes: number;
  text: string;
}

/**
 * 自己握手、自己拆帧的 WebSocket 客户端（ws 的客户端看不到帧头）：deflate 时像浏览器那样提 permessage-deflate，
 * 压了的帧接上 00 00 FF FF 交给同一个 inflate（共用上下文）解开
 */
async function rawWebSocket(port: number, deflate: boolean): Promise<{ extensions: string | undefined; sendText(text: string): void; readUntil(done: (texts: string[]) => boolean): Promise<WireFrame[]>; close(): void }> {
  const socket = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const key = Buffer.from(Array.from({ length: 16 }, (_, i) => i * 7)).toString("base64");
  socket.write(
    [`GET /ws HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", ...(deflate ? ["Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits"] : []), "", ""].join("\r\n"),
  );
  let buffer = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    wake?.();
  });
  const more = () => new Promise<void>((resolve) => (wake = resolve));
  while (!buffer.includes("\r\n\r\n")) await more();
  const end = buffer.indexOf("\r\n\r\n");
  const head = buffer.subarray(0, end).toString("latin1");
  buffer = buffer.subarray(end + 4);
  if (!head.startsWith("HTTP/1.1 101")) throw new Error(head.split("\r\n")[0]);
  const extensions = /^sec-websocket-extensions:\s*(.+)$/im.exec(head)?.[1];
  const inflater = zlib.createInflateRaw();
  const inflate = (payload: Buffer) =>
    new Promise<Buffer>((resolve, reject) => {
      const out: Buffer[] = [];
      const onData = (d: Buffer) => out.push(d);
      inflater.on("data", onData);
      inflater.write(Buffer.concat([payload, Buffer.from([0x00, 0x00, 0xff, 0xff])]));
      inflater.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        inflater.off("data", onData);
        resolve(Buffer.concat(out));
      });
      inflater.once("error", reject);
    });
  return {
    extensions,
    sendText(body) {
      const payload = Buffer.from(body, "utf8");
      const mask = Buffer.from([1, 2, 3, 4]);
      const len = payload.length < 126 ? Buffer.from([0x80 | payload.length]) : Buffer.from([0x80 | 126, payload.length >> 8, payload.length & 0xff]);
      socket.write(Buffer.concat([Buffer.from([0x81]), len, mask, payload.map((b, i) => b ^ mask[i % 4]!)]));
    },
    async readUntil(done) {
      const frames: WireFrame[] = [];
      for (;;) {
        while (buffer.length >= 2) {
          let len = buffer[1]! & 0x7f;
          let at = 2;
          if (len === 126) {
            if (buffer.length < 4) break;
            len = buffer.readUInt16BE(2);
            at = 4;
          } else if (len === 127) {
            if (buffer.length < 10) break;
            len = Number(buffer.readBigUInt64BE(2));
            at = 10;
          }
          if (buffer.length < at + len) break;
          const rsv1 = (buffer[0]! & 0x40) !== 0;
          const opcode = buffer[0]! & 0x0f;
          const payload = buffer.subarray(at, at + len);
          buffer = buffer.subarray(at + len);
          if (opcode !== 0x1) continue;
          frames.push({ rsv1, wireBytes: len, text: (rsv1 ? await inflate(payload) : payload).toString("utf8") });
        }
        if (done(frames.map((f) => f.text))) return frames;
        await more();
      }
    },
    close() {
      socket.destroy();
      inflater.close();
    },
  };
}

function text(t: string) {
  return { conversation: "secretary", parts: [{ type: "text", text: t }] };
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** 取原始字节（带 Accept-Encoding 时不解压） */
function getRaw(base: string, pathname: string, acceptEncoding?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method: "GET", headers: { accept: "text/html", ...(acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding }) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function get(base: string, pathname: string, headers: { host?: string; origin?: string } = {}): Promise<HttpResult> {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method: "GET", headers: { ...(headers.host ? { host: headers.host } : {}), ...(headers.origin ? { origin: headers.origin } : {}) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** 页面里不该出现的东西：私钥、各家 API key 的样子、JWT、Bearer 令牌、LSM 的令牌 */
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /Bearer [A-Za-z0-9._-]{16,}/,
  /LSM_TOKEN/,
];

/** 用 Web 包自己的 Vite 配置构建一份到临时目录（不碰 packages/web/dist），返回目录 */
function buildWebUi(): string {
  const webDir = path.resolve(import.meta.dirname, "../../../web");
  const vite = path.join(path.dirname(createRequire(path.join(webDir, "package.json")).resolve("vite/package.json")), "bin", "vite.js");
  const outDir = makeTempDir("ergo-web-build-");
  const build = spawnSync(process.execPath, [vite, "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "warn"], { cwd: webDir, encoding: "utf8", windowsHide: true });
  if (build.status !== 0) throw new Error(`构建 Web UI 失败：${build.stderr}`);
  return outDir;
}

function connectTcp(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, timeout: 2000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("连接超时"));
    });
    socket.once("error", reject);
  });
}
