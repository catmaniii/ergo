// 主切面：转发本机服务的页面（132 号票）。真的守护进程（临时数据目录，经组合根装配），起一个本机的假服务（helpers/fake-app.ts，
// 随机端口），在转发登记表里登记，再像浏览器一样经网关的 /apps/<应用名>/ 访问：
// - 普通请求（路径去掉前缀、查询串和请求体原样，Host 换成服务的、Origin 换成服务的源，带 X-Forwarded-Prefix / -Proto / -Host / -For，
//   二狗自己的 cookie 不转过去）、去掉挡嵌入的头、302 的 Location 改写回前缀下、Set-Cookie 的 Path 改到前缀下；
// - 流式响应边收边转（服务还没发完，第一段已经到了）；WebSocket 升级转成管道；
// - 只写到应用名的跳到带斜杠的首页；没登记的、应用名不对的 404（WebSocket 握手也是）；撤销以后 404、开着的 WebSocket 断开；
// - 服务停了出说明页（不是裸的 502）；
// - 外网端口：没有设备凭证被拒（401，握手也是），配对过的能用（X-Forwarded-Proto 按 nginx 写的，来源按 X-Real-IP），
//   续期的设备凭证 cookie 照发、服务写不了二狗的 cookie；吊销设备时它开着的 WebSocket 断开；
// - 插件经插件宿主登记（ctx.apps.register），停用插件以后 404。
import http from "node:http";
import { DEVICE_COOKIE } from "../../src/pairing/credentials.ts";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { PluginDefinition } from "../../src/plugins/host.ts";
import { httpRequest } from "../helpers/browser-http.ts";
import { startTestDaemon } from "../helpers/daemon.ts";
import { pairDevice } from "../helpers/device.ts";
import { FAKE_APP_HOME, type FakeAppRequest, startFakeApp } from "../helpers/fake-app.ts";
import { TestFrontend } from "../helpers/frontend.ts";

/** 网关地址的 host 部分（127.0.0.1:<端口>） */
const hostOf = (url: string) => new URL(url).host;

/** 假服务最后收到的那个请求 */
const last = (seen: FakeAppRequest[]) => seen.at(-1)!;

/** 连一个 WebSocket：握手被拒时抛 "HTTP <状态码>" */
function openSocket(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      reject(new Error(`HTTP ${res.statusCode}`));
    });
    ws.once("error", reject);
  });
}

/** 发一条、等回一条 */
function echo(ws: WebSocket, text: string): Promise<string> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(String(data)));
    ws.send(text);
  });
}

/** 等 WebSocket 被关掉 */
const closed = (ws: WebSocket) => new Promise<void>((resolve) => (ws.readyState === WebSocket.CLOSED ? resolve() : ws.once("close", () => resolve())));

describe("本机端口：登记了才转发", () => {
  it("普通请求：路径去掉前缀，查询串、方法、请求体原样；Host、Origin 换成服务的，带上转发头，二狗自己的 cookie 不转过去；挡嵌入的头去掉", async () => {
    const test = await startTestDaemon();
    const app = await startFakeApp();
    test.daemon.apps.register({ name: "intel", target: app.url, title: "简报站" });

    const home = await httpRequest(test.url, "/apps/intel/");
    expect(home.status).toBe(200);
    expect(home.body).toBe(FAKE_APP_HOME);
    expect(home.headers["x-frame-options"]).toBeUndefined();
    expect(home.headers["content-security-policy"]).toBe("default-src 'self'");
    expect(last(app.seen)).toMatchObject({ method: "GET", url: "/" });

    const posted = await httpRequest(test.url, "/apps/intel/echo/a%20b?x=1&y=%2F", {
      method: "POST",
      body: { hello: "世界" },
      headers: {
        origin: test.url,
        referer: `${test.url}/apps/intel/reports?id=3`,
        cookie: `${DEVICE_COOKIE}=secret; a=1; __Host-ergo-pairing=p`,
        "x-forwarded-for": "6.6.6.6",
        "x-real-ip": "6.6.6.6",
        "x-forwarded-prefix": "/evil",
      },
    });
    expect(posted.status).toBe(200);
    const seen = posted.json<FakeAppRequest>();
    expect(seen).toMatchObject({ method: "POST", url: "/echo/a%20b?x=1&y=%2F", body: '{"hello":"世界"}' });
    expect(seen.headers).toMatchObject({
      host: hostOf(app.url),
      origin: app.url,
      referer: `${app.url}/reports?id=3`,
      cookie: "a=1",
      "x-forwarded-prefix": "/apps/intel",
      "x-forwarded-proto": "http",
      "x-forwarded-host": hostOf(test.url),
      "x-forwarded-for": "127.0.0.1",
    });
    // 客户端自己写的转发头不算数
    expect(seen.headers["x-real-ip"]).toBeUndefined();

    // 登记成保留前缀的（服务按 ERGO_BASE_PATH 把框架的 base 设成了它）：路径原样带着前缀，Referer 也是
    test.daemon.apps.register({ name: "kept", target: app.url, prefix: "keep" });
    const kept = await httpRequest(test.url, "/apps/kept/echo?x=1", { headers: { referer: `${test.url}/apps/kept/home` } });
    expect(kept.json<FakeAppRequest>()).toMatchObject({ url: "/apps/kept/echo?x=1", headers: { referer: `${app.url}/apps/kept/home`, "x-forwarded-prefix": "/apps/kept" } });
  });

  it("302 的 Location：服务自己的地址、/ 开头的改写回前缀下；已经在前缀下的、相对的、别的网站原样；Set-Cookie 的 Path 改到前缀下、Domain 去掉、二狗的 cookie 名写不了", async () => {
    const test = await startTestDaemon();
    const app = await startFakeApp();
    test.daemon.apps.register({ name: "intel", target: app.url });
    const locations: Record<string, string> = {
      absolute: "/apps/intel/login?next=%2F",
      localhost: "/apps/intel/a#top",
      root: "/apps/intel/login",
      prefixed: "/apps/intel/already",
      relative: "login",
      elsewhere: "https://example.com/x",
    };
    for (const [name, location] of Object.entries(locations)) {
      const res = await httpRequest(test.url, `/apps/intel/go/${name}`);
      expect({ name, status: res.status, location: res.headers.location }).toEqual({ name, status: 302, location });
    }
    const cookies = await httpRequest(test.url, "/apps/intel/cookie");
    expect(cookies.headers["set-cookie"]).toEqual(["sid=s1; Path=/apps/intel/; HttpOnly", "theme=dark; Path=/apps/intel/settings", "plain=1"]);
  });

  it("流式响应边收边转：服务还没发完，第一段已经到了浏览器；WebSocket 升级转成管道（握手带着同样的转发头）", async () => {
    const test = await startTestDaemon();
    const app = await startFakeApp();
    test.daemon.apps.register({ name: "intel", target: app.url });

    const chunks: string[] = [];
    const ended = new Promise<number>((resolve, reject) => {
      const req = http.get(`${test.url}/apps/intel/stream`, (res) => {
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          chunks.push(c);
          // 第一段到了才让服务发第二段：转发要是攒着等服务发完，这里永远等不到
          if (chunks.length === 1) app.releaseStream();
        });
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
    });
    expect(await ended).toBe(200);
    expect(chunks.join("")).toBe("data: 第一段\n\ndata: 第二段\n\n");
    expect(chunks[0]).toBe("data: 第一段\n\n");

    const wsUrl = `${test.url.replace("http:", "ws:")}/apps/intel/socket`;
    const ws = await openSocket(wsUrl, { origin: test.url });
    expect(await echo(ws, "你好")).toBe("回声：你好");
    expect(await echo(ws, "再来")).toBe("回声：再来");
    expect(last(app.seen)).toMatchObject({ url: "/socket", headers: { host: hostOf(app.url), origin: app.url, "x-forwarded-prefix": "/apps/intel", "x-forwarded-proto": "http" } });
    ws.close();
    await closed(ws);
    // 服务那头没有的 WebSocket 地址：服务的拒绝原样转回来
    await expect(openSocket(`${test.url.replace("http:", "ws:")}/apps/intel/nowhere`)).rejects.toThrow("HTTP 404");
  });

  it("只写到应用名的跳到带斜杠的首页；没登记的、应用名不对的 404 说明页（握手也 404）；撤销以后 404、开着的 WebSocket 断开；服务停了出说明页", async () => {
    const test = await startTestDaemon();
    const app = await startFakeApp();
    const undo = test.daemon.apps.register({ name: "intel", target: app.url, title: "简报站" });

    const bare = await httpRequest(test.url, "/apps/intel?tab=2");
    expect(bare.status).toBe(308);
    expect(bare.headers.location).toBe("/apps/intel/?tab=2");

    for (const path of ["/apps/nope/", "/apps/Intel/", "/apps/", "/apps"]) {
      const res = await httpRequest(test.url, path);
      // 说明页能在内置浏览器的框里显示
      expect({ path, status: res.status, type: res.headers["content-type"], frame: res.headers["x-frame-options"] }).toEqual({ path, status: 404, type: "text/html; charset=utf-8", frame: "SAMEORIGIN" });
    }
    expect((await httpRequest(test.url, "/apps/nope/")).body).toContain("没有应用「nope」");
    await expect(openSocket(`${test.url.replace("http:", "ws:")}/apps/nope/socket`)).rejects.toThrow("HTTP 404");

    const ws = await openSocket(`${test.url.replace("http:", "ws:")}/apps/intel/socket`);
    expect(await echo(ws, "在吗")).toBe("回声：在吗");
    undo();
    await closed(ws);
    expect((await httpRequest(test.url, "/apps/intel/")).status).toBe(404);
    // 撤了再登记（133 号票改方案：换地址）照常
    const again = test.daemon.apps.register({ name: "intel", target: app.url, title: "简报站" });
    expect((await httpRequest(test.url, "/apps/intel/")).status).toBe(200);

    await app.close();
    const down = await httpRequest(test.url, "/apps/intel/");
    expect(down.status).toBe(502);
    expect(down.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(down.body).toContain("<title>服务「简报站」现在没在运行</title>");
    expect(down.body).toContain(`本机的 ${app.port} 端口`);
    again();
  });

  it("登记表只认本机的地址、只到端口；同一个名字不能登记两次", async () => {
    const test = await startTestDaemon();
    const { apps } = test.daemon;
    expect(() => apps.register({ name: "lan", target: "http://192.168.1.5:8080" })).toThrow(/本机/);
    expect(() => apps.register({ name: "sub", target: "http://127.0.0.1:8080/sub" })).toThrow(/只到端口/);
    expect(() => apps.register({ name: "noport", target: "http://127.0.0.1" })).toThrow(/端口/);
    expect(() => apps.register({ name: "Bad_Name", target: "http://127.0.0.1:8080" })).toThrow(/应用名/);
    apps.register({ name: "intel", target: "http://localhost:8080" });
    expect(() => apps.register({ name: "intel", target: "http://127.0.0.1:9090" })).toThrow(/已经登记/);
  });
});

describe("外网端口：鉴权和二狗自己的页面一样", () => {
  it("没有设备凭证被拒（HTTP 401、握手 401）；配对过的能用：协议按 nginx 写的、来源按 X-Real-IP，凭证不转给服务，续期的凭证 cookie 照发；吊销以后开着的 WebSocket 断开", async () => {
    const test = await startTestDaemon();
    const app = await startFakeApp();
    test.daemon.apps.register({ name: "intel", target: app.url });
    const wsBase = test.externalUrl.replace("http:", "ws:");

    const stranger = await httpRequest(test.externalUrl, "/apps/intel/", { headers: { "x-real-ip": "203.0.113.9" } });
    expect(stranger.status).toBe(401);
    expect((await httpRequest(test.externalUrl, "/apps/nope/")).status).toBe(401);
    await expect(openSocket(`${wsBase}/apps/intel/socket`)).rejects.toThrow("HTTP 401");
    expect(app.seen).toEqual([]);

    const pc = await TestFrontend.connect(test.url);
    await pc.subscribe({ cards: 0, inbox: 0 });
    const phone = await pairDevice(test.externalUrl, pc, { name: "我的手机" });
    const host = "ergo.example.sslip.io";
    const res = await phone.request("/apps/intel/echo", { headers: { host, "x-forwarded-proto": "https", origin: `https://${host}` } });
    expect(res.status).toBe(200);
    expect(res.json<FakeAppRequest>().headers).toMatchObject({
      host: hostOf(app.url),
      origin: app.url,
      "x-forwarded-prefix": "/apps/intel",
      "x-forwarded-proto": "https",
      "x-forwarded-host": host,
      "x-forwarded-for": "198.51.100.7",
    });
    expect(res.json<FakeAppRequest>().headers.cookie).toBeUndefined();
    expect(res.setCookies.map((c) => c.name)).toEqual([DEVICE_COOKIE]);
    // 服务写的 cookie 和续期的凭证一起发回去；冒充二狗凭证的那条被丢掉，设备照样能用
    const cookies = await phone.request("/apps/intel/cookie");
    expect(cookies.setCookies.map((c) => `${c.name}=${c.value}`)).toEqual(["sid=s1", "theme=dark", "plain=1", `${DEVICE_COOKIE}=${phone.credential}`]);
    expect((await phone.access()).access).toBe("device");

    const ws = await openSocket(`${wsBase}/apps/intel/socket`, { cookie: phone.cookieHeader! });
    expect(await echo(ws, "外网")).toBe("回声：外网");
    const { device } = (await phone.access()) as { device: { id: string } };
    test.daemon.pairing.revoke(device.id, "revoke-phone");
    await closed(ws);
    expect((await phone.request("/apps/intel/")).status).toBe(401);
  });
});

describe("经插件宿主登记", () => {
  it("插件经 ctx.apps 登记的照样转发；运行中停用插件以后撤掉（404）", async () => {
    const app = await startFakeApp();
    const plugin: PluginDefinition = {
      name: "test-app",
      title: "测试应用",
      setup(ctx) {
        ctx.apps.register({ name: "intel", target: app.url, title: "简报站" });
      },
    };
    const test = await startTestDaemon({ extraPlugins: [plugin] });
    expect((await httpRequest(test.url, "/apps/intel/")).status).toBe(200);
    expect(test.daemon.apps.list().map((a) => a.name)).toEqual(["intel"]);
    await test.daemon.plugins.disable("test-app");
    expect(test.daemon.apps.list()).toEqual([]);
    expect((await httpRequest(test.url, "/apps/intel/")).status).toBe(404);
  });
});
