// 主切面：本机来的也要配对（469）。真的守护进程，设置在配置文件里（pairing.localRequestsNeedPairing）。
// - 关着（默认）：本机端口和以前一样自动信任（现有的网关、配对测试一条不改照常过，这里只核开关本身）；
// - 开着：本机端口和外网端口同一套规矩——没凭证的 HTTP、WebSocket 被拒，只能拿页面、查状态（带 local）、发配对请求；
//   健康探针只放 /healthz；凭证 cookie 的名字带本机端口；来源写"本机端口 · 这台电脑"；
// - 不带浏览器的本机调用方照常：带本机程序令牌的 HTTP、WebSocket（命令行、冒烟脚本）；秘书照常回话（运行时子进程走 stdio）；
//   项目的服务报事件（真的 ergo notify 子进程）、项目自动转的 MCP（真的转发程序子进程）自带 Bearer，交给接口自己认；
//   ergo components、ergo local-pairing 读这一份的令牌；外网端口不认令牌；
// - 打开：本机端口上的浏览器先配上对，带着凭证确认一次才打开；没带回凭证的不打开；打开时本机端口上没凭证的连接断开；
// - 退路：ergo local-pairing off 二狗在跑时马上关，没在跑时改配置文件；
// - 令牌只在密钥区，不进日志、事件。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  type AccessInfo,
  CHANNELS,
  EVENT_TYPES,
  HTTP_PATHS,
  type HttpErrorBody,
  LOCAL_TOKEN_HEADER,
  type LocalPairingResult,
  type PairedDevice,
  type PairingRequestView,
  WS_CLOSE_UNPAIRED,
} from "@ergo/protocol";
import { describe, expect, it } from "vitest";
import { createContext } from "../../src/cli/context.ts";
import { runCli } from "../../src/cli/run.ts";
import { dataDirLayout } from "../../src/config/data-dir.ts";
import { localCookies } from "../../src/pairing/credentials.ts";
import { PAIRING_CHANNEL } from "../../src/pairing/views.ts";
import { detectLayout } from "../../src/release/layout.ts";
import { httpRequest } from "../helpers/browser-http.ts";
import { startTestDaemon, type TestDaemon } from "../helpers/daemon.ts";
import { TestDevice, waitForPairingCard } from "../helpers/device.ts";
import { TestFrontend } from "../helpers/frontend.ts";
import { freePort, writePortsConfig } from "../helpers/ports.ts";
import { waitUntil } from "../helpers/process.ts";
import { cardsOf, messagesOf, say, textOf } from "../helpers/task-flow.ts";
import { ManualClock } from "../helpers/clock.ts";
import { startLsmStandIn } from "../helpers/lsm-stand-in.ts";
import { seedProject } from "../helpers/projects.ts";
import { eventually, ok } from "../helpers/running-task.ts";
import { toolkit } from "../helpers/toolkit.ts";
import { makeTempDir } from "../helpers/temp-dir.ts";
import { startFakeApp } from "../helpers/fake-app.ts";

const ON = { pairing: { localRequestsNeedPairing: true } };
const CLI_MAIN = path.resolve(import.meta.dirname, "..", "..", "src", "cli", "main.ts");
const WINDOWS_CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

/** 本机端口上要凭证的各种接口（和外网端口那份一样挑几种：历史、媒体、上传、设置、体检、组件、本机来的也要配对本身、不存在的地址） */
const GUARDED: Array<[method: string, pathname: string]> = [
  ["GET", HTTP_PATHS.history("secretary", { before: 10 })],
  ["GET", HTTP_PATHS.media("a".repeat(64))],
  ["POST", HTTP_PATHS.uploads],
  ["GET", HTTP_PATHS.safetySettings],
  ["GET", HTTP_PATHS.doctor],
  ["GET", "/api/components"],
  ["GET", HTTP_PATHS.localPairing],
  ["PUT", HTTP_PATHS.localPairing],
  ["GET", "/fonts/grid.css"],
  ["POST", "/healthz"],
  ["GET", "/api/nope"],
  ["GET", "/nope"],
];

const tokenOf = (td: Pick<TestDaemon, "dataDir">) => fs.readFileSync(dataDirLayout(td.dataDir).localTokenFile, "utf8").trim();
const configOf = (dataDir: string) => JSON.parse(fs.readFileSync(dataDirLayout(dataDir).configFile, "utf8")) as { pairing?: { localRequestsNeedPairing?: boolean } };

/** 一个起在配置端口上的守护进程（命令行按配置找端口，不能让它去找 8810） */
async function daemonOnConfigPorts(): Promise<TestDaemon> {
  const dataDir = makeTempDir("ergo-data-");
  const homeDir = makeTempDir("ergo-home-");
  await writePortsConfig(dataDir);
  return startTestDaemon({ reuse: { dataDir, homeDir }, portFromConfig: true, config: ON });
}

/** 跑一个子进程（测试的守护进程在这个进程里，不能用 spawnSync 挡着它） */
function runChild(args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** 这一份的 ergo 命令（数据目录指过去；服务管家的目录是空的临时目录，这几条命令用不到它） */
function cliFor(dataDir: string, homeDir: string) {
  const out: string[] = [];
  const err: string[] = [];
  const env = { ...process.env, ERGO_DATA_DIR: dataDir, LSM_DATA_DIR: makeTempDir("ergo-svc-"), ERGO_LANGUAGE: "zh-CN" };
  const ctx = createContext(detectLayout({ cliFile: CLI_MAIN, env }), env, { out: (l) => out.push(l), err: (l) => err.push(l), ask: () => Promise.resolve("") }, homeDir);
  return { out, err, run: (...argv: string[]) => runCli(argv, ctx) };
}

/** 本机端口上的一个浏览器（带 cookie 罐；Windows 上的 Chrome） */
const localBrowser = (td: TestDaemon) => new TestDevice(td.url, { userAgent: WINDOWS_CHROME_UA });

describe("关着（默认）：本机端口和以前一样", () => {
  it("配置里没写就是关着；本机端口来的自动信任，查得到开关是关着的", async () => {
    const td = await startTestDaemon();
    expect(configOf(td.dataDir).pairing).toBeUndefined();
    expect((await httpRequest(td.url, HTTP_PATHS.access)).json<AccessInfo>()).toEqual({ access: "local" });
    expect((await httpRequest(td.url, HTTP_PATHS.localPairing)).json()).toEqual({ on: false });
    // 令牌照样生成在密钥区（关着时网关不看它）
    expect(tokenOf(td)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("配置写坏了拒绝启动，说清楚怎么写", async () => {
    await expect(startTestDaemon({ config: { pairing: { localRequestsNeedPairing: "yes" } } })).rejects.toThrow("pairing.localRequestsNeedPairing 必须是 true 或 false");
  });
});

describe("开着：本机端口和外网端口同一套规矩", () => {
  it("没凭证的 HTTP 一律 401；页面、查状态（带 local）、健康检查照常；外网端口照旧", async () => {
    const td = await startTestDaemon({ config: ON });
    const port = new URL(td.url).port;
    for (const headers of [{}, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }, { host: `localhost:${port}` }]) {
      for (const [method, pathname] of GUARDED) {
        const res = await httpRequest(td.url, pathname, { method, headers, ...(method === "GET" ? {} : { body: { on: false } }) });
        expect({ method, pathname, status: res.status }).toEqual({ method, pathname, status: 401 });
        expect(res.json<HttpErrorBody>().code).toBe("unauthorized");
      }
    }
    const page = await httpRequest(td.url, "/");
    expect(page.status).toBe(200);
    expect(page.setCookies).toEqual([]);
    expect((await httpRequest(td.url, "/apps/x/", { headers: { accept: "text/html" } })).status).toBe(200);
    expect((await httpRequest(td.url, HTTP_PATHS.access)).json<AccessInfo>()).toEqual({ access: "none", local: true });
    // 服务管家的健康探针：只放 /healthz 这一个（GET、HEAD）
    expect((await httpRequest(td.url, "/healthz")).status).toBe(200);
    expect((await httpRequest(td.url, "/healthz", { method: "HEAD" })).status).toBe(200);
    // Host 不对的照旧 403（DNS 重绑定）
    expect((await httpRequest(td.url, HTTP_PATHS.access, { headers: { host: `evil.example:${port}` } })).status).toBe(403);
    // 外网端口照旧：查状态不带 local
    expect((await httpRequest(td.externalUrl, HTTP_PATHS.access)).json<AccessInfo>()).toEqual({ access: "none" });
  });

  it("没凭证的 WebSocket 被拒；带着本机程序令牌的 HTTP、WebSocket 照常；令牌不对、外网端口上带令牌都不认", async () => {
    const td = await startTestDaemon({ config: ON });
    const token = tokenOf(td);
    await expect(TestFrontend.connect(td.url)).rejects.toThrow("HTTP 401");
    await expect(TestFrontend.connect(td.url, { headers: { [LOCAL_TOKEN_HEADER]: "A".repeat(43) } })).rejects.toThrow("HTTP 401");
    await expect(TestFrontend.connect(td.externalUrl, { headers: { [LOCAL_TOKEN_HEADER]: token } })).rejects.toThrow("HTTP 401");

    const program = { [LOCAL_TOKEN_HEADER]: token };
    expect((await httpRequest(td.url, HTTP_PATHS.access, { headers: program })).json<AccessInfo>()).toEqual({ access: "local" });
    expect((await httpRequest(td.url, HTTP_PATHS.safetySettings, { headers: program })).status).toBe(200);
    expect((await httpRequest(td.url, HTTP_PATHS.localPairing, { headers: program })).json()).toEqual({ on: true });
    expect((await httpRequest(td.url, HTTP_PATHS.safetySettings, { headers: { [LOCAL_TOKEN_HEADER]: `${token}x` } })).status).toBe(401);
    expect((await httpRequest(td.externalUrl, HTTP_PATHS.safetySettings, { headers: program })).status).toBe(401);
    const frontend = await TestFrontend.connect(td.url, { headers: program });
    expect((await frontend.subscribe({ [CHANNELS.secretary]: 0 })).ok).toBe(true);
  });

  it("本机的浏览器走配对：凭证 cookie 的名字带本机端口；来源写这台电脑；批准后 HTTP、WebSocket 都认；外网端口上的名字不认", async () => {
    const td = await startTestDaemon({ config: ON });
    const port = Number(new URL(td.url).port);
    const names = localCookies(port);
    const approver = await TestFrontend.connect(td.url, { headers: { [LOCAL_TOKEN_HEADER]: tokenOf(td) } });
    await approver.subscribe({ [CHANNELS.cards]: 0 });

    const browser = localBrowser(td);
    expect(await browser.access()).toEqual({ access: "none", local: true });
    const created = await browser.requestPairing();
    expect(created.status).toBe(201);
    expect(created.setCookies.map((c) => c.name)).toEqual([names.pairing]);
    const { id } = created.json<{ request: PairingRequestView }>().request;
    const card = await waitForPairingCard(approver, id);
    expect((card.payload as { from: string }).from).toBe("本机端口 · 这台电脑");
    expect(await approver.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version })).toMatchObject({ ok: true });
    expect((await browser.pollPairing()).status).toBe("paired");
    expect(browser.cookies.has(names.device)).toBe(true);
    expect(browser.cookies.has("__Host-ergo-device")).toBe(false);
    // 记成这台电脑上的（不算手机、不算外网入口）
    expect(td.daemon.store.read(CHANNELS.devices, 0, EVENT_TYPES.device).map((e) => (e.payload as { device: PairedDevice }).device.local)).toEqual([true]);

    const access = await browser.access();
    expect(access).toMatchObject({ access: "device", local: true });
    expect((await browser.request(HTTP_PATHS.safetySettings)).status).toBe(200);
    const ws = await browser.connect();
    expect((await ws.subscribe({ [CHANNELS.secretary]: 0 })).ok).toBe(true);
    // 本机端口上的凭证名在外网端口上不认（外网端口只认它自己那个名字）
    const credential = browser.cookies.get(names.device)!;
    expect((await httpRequest(td.externalUrl, HTTP_PATHS.access, { headers: { cookie: `${names.device}=${credential}` } })).json<AccessInfo>()).toEqual({ access: "none" });
  });

  it("另一份二狗的凭证（同名但认不出）：拒绝、让浏览器删掉的只是这一份自己的那个名字", async () => {
    const td = await startTestDaemon({ config: ON });
    const port = Number(new URL(td.url).port);
    const mine = localCookies(port).device;
    const others = localCookies(port + 1).device;
    const res = await httpRequest(td.url, HTTP_PATHS.access, { headers: { cookie: `${others}=${"B".repeat(43)}; ${mine}=${"C".repeat(43)}` } });
    expect(res.json<AccessInfo>()).toEqual({ access: "none", local: true });
    expect(res.setCookies.map((c) => [c.name, c.attributes["max-age"]])).toEqual([[mine, "0"]]);
  });

  it("秘书照常回话（运行时子进程走 stdio，不经本机端口）", async () => {
    const td = await startTestDaemon({ config: ON, secretary: [say("好的，收到")] });
    const frontend = await TestFrontend.connect(td.url, { headers: { [LOCAL_TOKEN_HEADER]: tokenOf(td) } });
    await frontend.subscribe({ [CHANNELS.secretary]: 0 });
    await frontend.sendText("你好");
    await waitUntil(() => messagesOf(frontend, CHANNELS.secretary).some((m) => m.message.speaker === "agent" && textOf(m).includes("好的，收到")), { timeoutMs: 30_000, describe: () => "秘书回话" });
    expect(messagesOf(frontend, CHANNELS.secretary).filter((m) => m.message.speaker === "agent").map(textOf)).toContain("好的，收到");
  }, 60_000);

  it("自带凭证的两个接口交给接口自己认：项目的服务报事件、项目自动转的 MCP（不带、带错是接口自己的 401，不是配对页的说法）", async () => {
    const td = await startTestDaemon({ config: ON });
    const events = await httpRequest(td.url, HTTP_PATHS.serviceEvents, { method: "POST", body: { event: "x" } });
    expect(events.status).toBe(401);
    expect(events.json<HttpErrorBody>().message).toContain("ERGO_SERVICE_TOKEN");
    const mcp = await httpRequest(td.url, HTTP_PATHS.projectOpsMcp, { method: "POST", headers: { authorization: "Bearer wrong" }, body: { method: "tools/list" } });
    expect(mcp.status).toBe(401);
    expect(mcp.json<HttpErrorBody>().message).not.toBe("这台设备还没配对：在浏览器里打开首页，按提示配对");
    // 外网端口照旧一律拒
    expect((await httpRequest(td.externalUrl, HTTP_PATHS.serviceEvents, { method: "POST", body: { event: "x" } })).status).toBe(403);
  });
});

describe("打开、关掉", () => {
  it("带着令牌的本机程序（关着时）打开：直接打开，不替它配对（设备列表里不多一台）", async () => {
    const td = await startTestDaemon();
    const on = await httpRequest(td.url, HTTP_PATHS.localPairing, { method: "PUT", body: { on: true }, headers: { [LOCAL_TOKEN_HEADER]: tokenOf(td) } });
    expect(on.json<LocalPairingResult>()).toEqual({ on: true });
    expect(on.setCookies).toEqual([]);
    expect(td.daemon.store.read(CHANNELS.devices, 0, EVENT_TYPES.device)).toEqual([]);
    expect((await httpRequest(td.url, HTTP_PATHS.access)).json<AccessInfo>()).toEqual({ access: "none", local: true });
  });

  it("本机端口上的浏览器打开：先替它配上对，带着凭证确认才打开；没带回凭证的不打开；打开时本机端口上没凭证的连接断开", async () => {
    const td = await startTestDaemon();
    const port = Number(new URL(td.url).port);
    const names = localCookies(port);
    const other = await TestFrontend.connect(td.url);
    await other.subscribe({ [CHANNELS.secretary]: 0 });
    const browser = localBrowser(td);
    const origin = { origin: td.url };

    const first = await browser.request(HTTP_PATHS.localPairing, { method: "PUT", body: { on: true }, headers: origin });
    expect(first.status).toBe(200);
    expect(first.json<LocalPairingResult>()).toEqual({ on: false, pairedThisBrowser: true });
    expect(first.setCookies.map((c) => [c.name, c.attributes.httponly, c.attributes.samesite])).toEqual([[names.device, "", "Strict"]]);
    // 还没打开：配置没写，别的连接还在
    expect(configOf(td.dataDir).pairing).toBeUndefined();
    const devices = td.daemon.store.read(CHANNELS.devices, 0, EVENT_TYPES.device).map((e) => (e.payload as { device: PairedDevice }).device);
    expect(devices.map((d) => [d.from, d.activated, d.local])).toEqual([["本机端口 · 这台电脑", false, true]]);
    expect(devices[0]!.name).toContain("Chrome");

    // 没带凭证来确认（存不下 cookie 的浏览器）：不打开
    const noCookie = await httpRequest(td.url, HTTP_PATHS.localPairing, { method: "PUT", body: { on: true, confirm: true }, headers: origin });
    expect(noCookie.status).toBe(400);
    expect(noCookie.json<HttpErrorBody>().message).toContain("没打开");
    expect((await httpRequest(td.url, HTTP_PATHS.localPairing)).json()).toEqual({ on: false });

    // 带着凭证确认：打开
    const confirmed = await browser.request(HTTP_PATHS.localPairing, { method: "PUT", body: { on: true, confirm: true }, headers: origin });
    expect(confirmed.json<LocalPairingResult>()).toEqual({ on: true });
    expect(configOf(td.dataDir).pairing).toEqual({ localRequestsNeedPairing: true });
    expect((await other.closed()).code).toBe(WS_CLOSE_UNPAIRED);
    expect(await browser.access()).toMatchObject({ access: "device", local: true });
    expect((await httpRequest(td.url, HTTP_PATHS.access)).json<AccessInfo>()).toEqual({ access: "none", local: true });
    const again = await browser.connect();
    expect((await again.subscribe({ [CHANNELS.secretary]: 0 })).ok).toBe(true);
    // 这台电脑上的浏览器不算"手机配好了"（设置向导那一步照旧没做完）
    const setup = (await browser.request(HTTP_PATHS.setup)).json<{ steps: Array<{ id: string; ready: boolean }> }>();
    expect(setup.steps.find((s) => s.id === "phone")!.ready).toBe(false);

    // 已配对的浏览器关掉：本机端口照旧自动信任
    expect((await browser.request(HTTP_PATHS.localPairing, { method: "PUT", body: { on: false }, headers: origin })).json<LocalPairingResult>()).toEqual({ on: false });
    expect(configOf(td.dataDir).pairing).toBeUndefined();
    expect((await httpRequest(td.url, HTTP_PATHS.access)).json<AccessInfo>()).toEqual({ access: "local" });

    // 再打开：这个浏览器还带着这一份本机端口上的凭证，直接打开，不再多配一台
    const count = () => new Set(td.daemon.store.read(CHANNELS.devices, 0, EVENT_TYPES.device).map((e) => (e.payload as { device: PairedDevice }).device.id)).size;
    expect(count()).toBe(1);
    expect((await browser.request(HTTP_PATHS.localPairing, { method: "PUT", body: { on: true }, headers: origin })).json<LocalPairingResult>()).toEqual({ on: true });
    expect(count()).toBe(1);
    expect(await browser.access()).toMatchObject({ access: "device", local: true });
  });

  it("已配对的设备（外网端口）打开、关掉：直接改，不替谁配对", async () => {
    const td = await startTestDaemon();
    const approver = await TestFrontend.connect(td.url);
    await approver.subscribe({ [CHANNELS.cards]: 0 });
    const phone = new TestDevice(td.externalUrl, { realIp: "198.51.100.7" });
    const { id } = (await phone.requestPairing()).json<{ request: PairingRequestView }>().request;
    const card = await waitForPairingCard(approver, id);
    await approver.cardAction({ cardId: card.id, action: "approve", expectedVersion: card.version });
    await phone.pollPairing();
    const on = await phone.request(HTTP_PATHS.localPairing, { method: "PUT", body: { on: true } });
    expect(on.json<LocalPairingResult>()).toEqual({ on: true });
    expect(on.setCookies.filter((c) => c.name.endsWith(`-l${new URL(td.url).port}`))).toEqual([]);
    expect((await httpRequest(td.url, HTTP_PATHS.access)).json<AccessInfo>()).toEqual({ access: "none", local: true });
    expect((await phone.request(HTTP_PATHS.localPairing, { method: "PUT", body: { on: false } })).json<LocalPairingResult>()).toEqual({ on: false });
    expect((await httpRequest(td.url, HTTP_PATHS.access)).json<AccessInfo>()).toEqual({ access: "local" });
  });

  it("令牌不进日志、事件", async () => {
    const lines: string[] = [];
    const td = await startTestDaemon({ config: ON, log: (line) => lines.push(line) });
    const token = tokenOf(td);
    await httpRequest(td.url, HTTP_PATHS.safetySettings, { headers: { [LOCAL_TOKEN_HEADER]: token } });
    await httpRequest(td.url, HTTP_PATHS.localPairing, { method: "PUT", body: { on: false }, headers: { [LOCAL_TOKEN_HEADER]: token } });
    expect(lines.join("\n")).not.toContain(token);
    for (const channel of [CHANNELS.devices, CHANNELS.cards, CHANNELS.inbox, PAIRING_CHANNEL]) expect(JSON.stringify(td.daemon.store.read(channel, 0))).not.toContain(token);
  });
});

describe("不带浏览器的本机调用方：命令行", () => {
  it("开着时 ergo components list 照常（带着这一份的令牌）；ergo local-pairing 看得到开着；ergo local-pairing off 马上关掉", async () => {
    const td = await daemonOnConfigPorts();
    const cli = cliFor(td.dataDir, td.homeDir);
    expect(await cli.run("components", "list")).toBe(0);
    expect(cli.err).toEqual([]);
    expect(await cli.run("local-pairing")).toBe(0);
    expect(cli.out.at(-1)).toContain("开着");
    expect(cli.out.at(-1)).toContain("ergo local-pairing off");
    expect(await cli.run("local-pairing", "on")).toBe(2);
    expect(cli.err.at(-1)).toContain("网页");
    expect(await cli.run("local-pairing", "off")).toBe(0);
    expect(cli.out.at(-1)).toContain("马上生效");
    expect((await httpRequest(td.url, HTTP_PATHS.access)).json<AccessInfo>()).toEqual({ access: "local" });
    expect(configOf(td.dataDir).pairing).toBeUndefined();
  });

  it("二狗没在跑：ergo local-pairing off 直接改这一份的配置文件；本来就关着的说一句", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const layout = dataDirLayout(dataDir);
    fs.mkdirSync(layout.config, { recursive: true });
    // 端口指到没人听的地方（不是 8810）
    fs.writeFileSync(layout.configFile, JSON.stringify({ ports: { local: await freePort(), external: await freePort() }, pairing: { localRequestsNeedPairing: true }, timeZone: "Asia/Shanghai" }));
    const cli = cliFor(dataDir, makeTempDir("ergo-home-"));
    expect(await cli.run("local-pairing", "off")).toBe(0);
    expect(cli.out.at(-1)).toContain("下次起来就是关着的");
    const config = configOf(dataDir) as Record<string, unknown>;
    expect(config.pairing).toBeUndefined();
    expect(config.timeZone).toBe("Asia/Shanghai");
    expect(await cli.run("local-pairing", "off")).toBe(0);
    expect(cli.out.at(-1)).toContain("本来就是关着的");
    expect(await cli.run("local-pairing", "maybe")).toBe(2);
  });

});

describe("不带浏览器的本机调用方：项目的服务、项目自动转的 MCP（开着）", () => {
  it("上线的服务调 ergo notify（真的命令行子进程，服务的 Bearer 凭证）：报上了、叫醒等它的任务；凭证不对的是接口自己的说法", async () => {
    const dataDir = makeTempDir("ergo-data-");
    const realData = fs.realpathSync.native(dataDir);
    fs.mkdirSync(path.join(realData, "projects", "p-1", "workdir", "watcher"), { recursive: true });
    const lsm = await startLsmStandIn({ owned: true, heartbeatIntervalMs: 60_000 });
    const port = await freePort();
    const td = await startTestDaemon({ config: ON, clock: new ManualClock(new Date(2026, 10, 25, 9, 0)), reuse: { dataDir, homeDir: makeTempDir("ergo-home-") }, env: lsm.env, secretary: [say("好的")], maintainer: () => Array.from({ length: 40 }, () => say("好")) });
    seedProject(td.daemon, "评论监控", { state: "in_use", charterConfirmed: true, kind: "other", toolkit: { skills: [], mcp: [], bash: false, network: true } });
    // 网页（这里是带本机程序令牌的连接）确认运营方案
    const frontend = await TestFrontend.connect(td.url, { headers: { [LOCAL_TOKEN_HEADER]: tokenOf(td) } });
    await frontend.subscribe({ [CHANNELS.cards]: 0, [CHANNELS.projects]: 0 });
    await lsm.waitFor((m) => m.type === "hello", "握手");
    const items = [
      { key: "watcher", name: "评论监控", means: "service", instructions: "一直盯着评论，有异常就报事件", capabilities: {}, service: { name: "watcher", command: "node watcher.mjs", cwd: "watcher", port } },
      { key: "alert", name: "评论异常时处理", means: "event", event: { kind: "event", source: "service", events: ["reported"], filter: { name: "评论异常" } }, instructions: "看看服务报来的是什么", capabilities: {} },
    ];
    const proposed = await td.daemon.operations.tool("p-1", "pm-1").run({ items, why: "盯着评论" } as never, { toolCallId: "call-propose" });
    expect(proposed.isError ? proposed.text : true).toBe(true);
    const card = await eventually(() => cardsOf(frontend), (c) => c.type === "operations_change" && c.status === "pending", "运营方案变更卡");
    ok(await frontend.cardAction({ cardId: card.id, action: "confirm", expectedVersion: card.version }));
    const serviceNow = () => td.daemon.projectServices.view().find((v) => v.app === "p-1-watcher");
    await waitUntil(() => serviceNow()?.rollout === "live", { timeoutMs: 20_000, describe: () => `等上线：${JSON.stringify(serviceNow())}` });
    await waitUntil(() => td.daemon.eventTriggers.subscriptions().length > 0, { describe: () => "订阅跟上" });
    const serviceToken = fs.readFileSync(path.join(realData, "secrets", "service-tokens", "p-1-watcher.token"), "utf8");
    // 服务的环境：上线时注入的地址和凭证；不带本机程序的令牌（服务读不到密钥区里的那一份）
    const env = { ...process.env, ERGO_NOTIFY_URL: `${td.url}${HTTP_PATHS.serviceEvents}`, ERGO_SERVICE_TOKEN: serviceToken, ERGO_LANGUAGE: "zh-CN" };
    const reported = await runChild([CLI_MAIN, "notify", "评论异常", "--data", JSON.stringify({ count: 3 })], env);
    expect({ status: reported.status, stderr: reported.stderr }).toEqual({ status: 0, stderr: "" });
    await waitUntil(() => serviceNow()?.recentEvents?.length === 1, { describe: () => "报上了" });
    expect(serviceNow()!.recentEvents![0]).toMatchObject({ name: "评论异常", outcome: "woke" });
    // 凭证不对：退出码 1，说法是报事件接口自己的（不是"还没配对"）
    const wrong = await runChild([CLI_MAIN, "notify", "评论异常"], { ...env, ERGO_SERVICE_TOKEN: "not-a-real-token" });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("ERGO_SERVICE_TOKEN");
    expect(wrong.stderr).not.toContain("还没配对");
  }, 120_000);

  it("项目自动转的 MCP：真的转发程序子进程经本机端口问到工具清单", async () => {
    const td = await startTestDaemon({ config: ON });
    const project = seedProject(td.daemon, "记账本", { state: "in_use", charterConfirmed: true, kind: "dev", toolkit: toolkit() });
    const ops = { tools: [{ name: "ledger_status", title: "记账本怎么样", description: "记账本整体的状态。", userSays: ["记账本还好吗"], kind: "query", impl: { type: "ergo", action: "status" }, test: { args: {} } }] };
    const records = td.daemon.projects.records(project.id).root;
    fs.mkdirSync(records, { recursive: true });
    fs.writeFileSync(path.join(records, "ops.json"), JSON.stringify(ops, null, 2));
    expect((await td.daemon.projectOps.registry.check(project, { by: "maintainer", force: true }))?.outcome).toBe("passed");
    const secret = td.daemon.mcp.injectedSecrets("project-p-1")[0]!.value;
    const bridge = path.resolve(import.meta.dirname, "..", "..", "src", "project-ops", "mcp-bridge-main.ts");
    const child = spawn(process.execPath, [bridge], { env: { ...process.env, ERGO_OPS_MCP_URL: `${td.url}${HTTP_PATHS.projectOpsMcp}`, ERGO_OPS_MCP_TOKEN: secret }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    await waitUntil(() => out.includes("\n"), { timeoutMs: 20_000, describe: () => `等转发程序回话：${out}` });
    child.stdin.end();
    const reply = JSON.parse(out.split("\n")[0]!) as { result?: { tools: Array<{ name: string }> }; error?: { message: string } };
    expect(reply.error).toBeUndefined();
    expect(reply.result!.tools.map((t) => t.name)).toEqual(["ledger_status"]);
  }, 60_000);
});

describe("转发给项目的服务（开着）", () => {
  it("带着令牌经 /apps/ 转发：令牌、本机端口的凭证 cookie 都不转给服务；没凭证的程序请求、握手被拒", async () => {
    const td = await startTestDaemon({ config: ON });
    const app = await startFakeApp();
    td.daemon.apps.register({ name: "intel", target: app.url, title: "简报站" });
    const port = Number(new URL(td.url).port);
    const res = await httpRequest(td.url, "/apps/intel/", { headers: { [LOCAL_TOKEN_HEADER]: tokenOf(td), cookie: `${localCookies(port).device}=${"D".repeat(43)}; theme=dark` } });
    expect(res.status).toBe(200);
    const seen = app.seen.at(-1)!;
    expect(seen.headers[LOCAL_TOKEN_HEADER]).toBeUndefined();
    expect(seen.headers.cookie).toBe("theme=dark");
    const before = app.seen.length;
    expect((await httpRequest(td.url, "/apps/intel/")).status).toBe(401);
    await expect(TestFrontend.connect(`${td.url}/apps/intel/ws`)).rejects.toThrow("HTTP 401");
    expect(app.seen.length).toBe(before);
  });
});

describe("配对接口在本机端口上（开着）", () => {
  it("发起配对请求按 TCP 对端限频，不信任客户端写的 X-Real-IP", async () => {
    const td = await startTestDaemon({ config: ON });
    for (let i = 0; i < 5; i += 1) {
      const device = new TestDevice(td.url, { userAgent: WINDOWS_CHROME_UA, realIp: `198.51.100.${i + 1}` });
      expect((await device.requestPairing()).status).toBe(201);
    }
    const sixth = new TestDevice(td.url, { userAgent: WINDOWS_CHROME_UA, realIp: "198.51.100.99" });
    expect((await sixth.requestPairing()).status).toBe(429);
  });
});
