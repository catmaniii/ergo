// 主切面：网关的本机端口。只听 127.0.0.1、端口从配置读；Origin 和 Host 不对的 HTTP 和 WebSocket 请求被拒
// （DNS 重绑定、跨站 WebSocket）；提供 Web UI 静态文件和健康探针；格式不对的请求得到错误响应，连接不断。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { FRONTEND_PROTOCOL_VERSION } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { startTestDaemon, TEST_PAGE } from "../helpers/daemon.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { writePortConfig } from "../helpers/ports.ts";
import { waitUntil } from "../helpers/process.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

const LAN_ADDRESS = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a !== undefined && a.family === "IPv4" && !a.internal)?.address;

describe("本机端口", () => {
  it("只监听 127.0.0.1，端口号从配置读", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
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

  it("健康探针 /healthz：秘书在运行时健康", async () => {
    const { url, daemon } = await startTestDaemon();
    await waitUntil(() => daemon.secretary.status === "idle");
    const res = await get(url, "/healthz");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.body)).toEqual({ ok: true, secretary: "idle", webUi: true, reasons: [] });
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
    expect(body).toMatchObject({ ok: false, webUi: true });
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

  it("页面脚本里没有任何私钥或令牌：现场构建真正的 Web UI，经本机端口取回来扫一遍", async () => {
    const webRoot = buildWebUi();
    const key = "sk-MARKERnotARealKey0123456789abcdef";
    const { url } = await startTestDaemon({ webRoot, env: { DEEPSEEK_API_KEY: key, LSM_TOKEN: "lsm-token-MARKER-0123456789" } });
    const page = await get(url, "/");
    expect(page.status).toBe(200);
    expect(page.body).toBe(fs.readFileSync(path.join(webRoot, "index.html"), "utf8"));
    expect(page.body).toContain('<div id="root">');
    expect(page.body.length).toBeGreaterThan(100_000);
    for (const pattern of SECRET_PATTERNS) expect(page.body, `页面里出现了 ${pattern}`).not.toMatch(pattern);
    expect(page.body).not.toContain(key);
    expect(page.body).not.toContain("lsm-token-MARKER");
    const health = (await get(url, "/healthz")).body;
    for (const pattern of SECRET_PATTERNS) expect(health).not.toMatch(pattern);
  });

  it("Web UI 还没构建：页面返回 503 并说明怎么构建，健康探针报告不健康", async () => {
    const { url } = await startTestDaemon({ webRoot: makeTempDir("ergou-empty-web-") });
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
    expect(await frontend.request("send_message", { conversation: "maintainer:p-notes", parts: [{ type: "text", text: "在吗" }] }, "k-m")).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    expect(await frontend.request("card_action", { cardId: "c1", action: "approve", expectedVersion: 1 }, "k-c")).toMatchObject({ ok: false, error: { code: "not_implemented" } });

    // 连接还在，照常能用；被拒的请求一条消息也没落
    expect(await frontend.subscribe({ secretary: 0 })).toMatchObject({ ok: true });
    await frontend.sendText("还在吗");
    await frontend.next("secretary", "turn_end");
    expect(frontend.events({ persistedOnly: true }).map((f) => f.type)).toEqual(["message", "turn_start", "message", "turn_end"]);
  });
});

function text(t: string) {
  return { conversation: "secretary", parts: [{ type: "text", text: t }] };
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
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
  const outDir = makeTempDir("ergou-web-build-");
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
