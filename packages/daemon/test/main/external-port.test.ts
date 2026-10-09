// 主切面：外网端口（规格第 6 节）。它是隧道的唯一目标，永远不享受本机信任：不管请求从哪个 IP 来、Host 和 Origin
// 写的是什么，每个 HTTP 请求和 WebSocket 握手都要带有效的设备凭证；没有凭证只能拿到页面本身（显示配对等待页）、
// 查"我有没有被信任"、发配对请求。本机端口的行为不变。
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { type AccessInfo, HTTP_API_PREFIX, HTTP_PATHS, type HttpErrorBody } from "@ergou/protocol";
import { describe, expect, it } from "vitest";
import { startTestDaemon, TEST_PAGE } from "../helpers/daemon.ts";
import { TestDevice } from "../helpers/device.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { httpRequest } from "../helpers/browser-http.ts";
import { writePortsConfig } from "../helpers/ports.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";

/** JSON 响应的安全响应头（含 CSP）和不缓存 */
const SECURITY_HEADER_NAMES = ["x-content-type-options", "x-frame-options", "referrer-policy", "content-security-policy", "cache-control", "content-type"] as const;
const securityHeaders = (headers: http.IncomingHttpHeaders) => Object.fromEntries(SECURITY_HEADER_NAMES.map((name) => [name, headers[name]]));

/** 外网端口上要凭证的各种接口：健康探针、历史分页、媒体上传下载（09）、视觉风格的字体（39）、工具调用的完整内容（53）、不存在的地址 */
const GUARDED: Array<[method: string, pathname: string]> = [
  ["GET", "/healthz"],
  ["GET", "/fonts/grid.css"],
  ["GET", HTTP_PATHS.history("secretary", { before: 10 })],
  ["GET", HTTP_PATHS.media("a".repeat(64))],
  ["POST", HTTP_PATHS.uploads],
  ["GET", HTTP_PATHS.upload("u-1")],
  ["PUT", HTTP_PATHS.uploadChunk("u-1", 0)],
  ["POST", HTTP_PATHS.uploadComplete("u-1")],
  // 工具调用的完整参数和返回（53）
  ["GET", HTTP_PATHS.toolCall("call-1")],
  ["GET", "/api/nope"],
  ["GET", "/nope"],
];

describe("外网端口", () => {
  it("守护进程同时起本机端口和外网端口，端口号都从配置读，都只监听 127.0.0.1", async () => {
    const dataDir = makeTempDir("ergou-data-");
    const homeDir = makeTempDir("ergou-home-");
    const ports = await writePortsConfig(dataDir);
    const { url, externalUrl } = await startTestDaemon({ reuse: { dataDir, homeDir }, portFromConfig: true });
    expect(url).toBe(`http://127.0.0.1:${ports.local}`);
    expect(externalUrl).toBe(`http://127.0.0.1:${ports.external}`);
    expect((await httpRequest(url, "/healthz")).status).toBe(200);
    expect((await httpRequest(externalUrl, "/")).status).toBe(200);
  });

  it("不带凭证：HTTP 接口一律被拒（401），即使来自 127.0.0.1、Host 和 Origin 写成本机地址", async () => {
    const { externalUrl } = await startTestDaemon();
    const port = new URL(externalUrl).port;
    const disguises: Array<Record<string, string>> = [
      {},
      { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` },
      { host: `localhost:${port}`, origin: `http://localhost:${port}` },
      { "x-real-ip": "127.0.0.1" },
    ];
    for (const headers of disguises) {
      for (const [method, pathname] of GUARDED) {
        const res = await httpRequest(externalUrl, pathname, { method, headers, ...(method === "GET" ? {} : { body: { name: "a.txt", mime: "text/plain", size: 1 } }) });
        expect({ method, pathname, headers, status: res.status }).toEqual({ method, pathname, headers, status: 401 });
        expect(res.json<HttpErrorBody>().code).toBe("unauthorized");
      }
    }
  });

  it("不带凭证：WebSocket 握手被拒，即使 Host 和 Origin 写成本机地址", async () => {
    const { externalUrl } = await startTestDaemon();
    const port = new URL(externalUrl).port;
    await expect(TestFrontend.connect(externalUrl)).rejects.toThrow("HTTP 401");
    await expect(TestFrontend.connect(externalUrl, { origin: `http://127.0.0.1:${port}` })).rejects.toThrow("HTTP 401");
    await expect(TestFrontend.connect(externalUrl, { host: `localhost:${port}`, origin: `http://localhost:${port}` })).rejects.toThrow("HTTP 401");
    // 伪造的凭证一样不认
    await expect(TestFrontend.connect(externalUrl, { cookie: "__Host-ergou-device=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).rejects.toThrow("HTTP 401");
  });

  it("没有凭证只能看到配对页（页面本身）、查自己有没有被信任、发配对请求", async () => {
    const { externalUrl, webRoot } = await startTestDaemon();
    const page = await httpRequest(externalUrl, "/");
    expect(page.status).toBe(200);
    expect(page.body).toBe(fs.readFileSync(path.join(webRoot, "index.html"), "utf8"));
    expect(page.body).toBe(TEST_PAGE);
    expect(page.setCookies).toEqual([]);

    const device = new TestDevice(externalUrl);
    expect(await device.access()).toEqual({ access: "none" } satisfies AccessInfo);
    expect((await device.requestPairing()).status).toBe(201);
  });

  it("外网端口的 JSON 响应（正常的和出错的）带和本机端口一样的安全响应头，包括 CSP", async () => {
    const { url, externalUrl } = await startTestDaemon();
    const local = securityHeaders((await httpRequest(url, HTTP_PATHS.access)).headers);
    expect(local).toMatchObject({ "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": expect.stringContaining("sandbox") });
    expect(securityHeaders((await httpRequest(url, `${HTTP_API_PREFIX}nope`)).headers)).toEqual(local);
    const device = new TestDevice(externalUrl);
    const responses = [
      await device.request(HTTP_PATHS.access),
      await device.request("/healthz"),
      await device.request(HTTP_PATHS.pairing),
      await device.request(HTTP_PATHS.pairing, { method: "POST", body: {} }),
      await device.request(HTTP_PATHS.pairing, { method: "PATCH", body: { deviceName: "" } }),
      await device.request(HTTP_PATHS.pairing, { method: "DELETE" }),
      await httpRequest(externalUrl, HTTP_PATHS.access, { headers: { origin: "https://attacker.example" } }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 401, 404, 201, 400, 405, 403]);
    for (const res of responses) expect(securityHeaders(res.headers)).toEqual(local);
  });

  it("别的网站发起的请求被拒（Origin 和 Host 对不上）", async () => {
    const { externalUrl } = await startTestDaemon();
    expect((await httpRequest(externalUrl, HTTP_PATHS.pairing, { method: "POST", body: {}, headers: { origin: "https://attacker.example" } })).status).toBe(403);
    expect((await httpRequest(externalUrl, "/", { headers: { origin: "null" } })).status).toBe(403);
  });
});

describe("WebSocket 心跳", () => {
  it("半开的连接（对方不再回 pong）在一两个心跳周期里被服务端断掉；正常的连接一直开着", async () => {
    const { url } = await startTestDaemon({ heartbeatIntervalMs: 100 });
    const gone = await TestFrontend.connect(url, { noPong: true });
    const healthy = await TestFrontend.connect(url);
    await healthy.subscribe({ secretary: 0 });
    // 服务端直接掐断，没有关闭握手
    expect((await gone.closed(2000)).code).toBe(1006);
    await new Promise((r) => setTimeout(r, 400));
    expect(healthy.isOpen).toBe(true);
    expect(await healthy.subscribe({ secretary: 0 })).toMatchObject({ ok: true });
  });
});

describe("本机端口的行为不变", () => {
  it("自动信任，不用配对：/api/access 回 local，没有配对接口", async () => {
    const { url } = await startTestDaemon();
    expect((await httpRequest(url, HTTP_PATHS.access)).json<AccessInfo>()).toEqual({ access: "local" });
    expect((await httpRequest(url, HTTP_PATHS.pairing, { method: "POST", body: {} })).status).toBe(404);
    const frontend = await TestFrontend.connect(url);
    expect(await frontend.subscribe({ secretary: 0 })).toMatchObject({ ok: true });
  });
});
