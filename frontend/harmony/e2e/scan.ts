// 扫码连接在鸿蒙模拟器上的联调（364 号票），和 frontend/android/e2e/scan.ts 走同样的路。只连模拟器（hdc 目标 127.0.0.1:5555，下面卡着），
// 连临时守护进程和假的服务管家，绝不碰真机和真的二狗、服务管家。模拟器能装不签名的包。先有一个开着的模拟器，再：
//   npm run build:harmony -- --webview-debug
//   node frontend/harmony/e2e/scan.ts [截图目录]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { findChrome } from "../../../packages/web/build/chrome.ts";
import { expectEqual, expectTrue, Run, startDaemon, startSite, type TestDaemonHandle } from "../../android/e2e/harness.ts";
import { Cdp, type CdpTarget, sleep } from "../../android/e2e/lib.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 模拟器没有能对准屏幕的相机（系统扫码界面是黑的），二维码经测试入口喂进去
const HAP = path.join(HERE, "..", "entry", "build", "default", "outputs", "default", "entry-default-unsigned.hap");
const BUNDLE = "com.catmaniii.ergo";
const TARGET = "127.0.0.1:5555";
const HDC = process.env.HDC ?? "D:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe";

interface UiNode {
  text: string;
  x: number;
  y: number;
}

/** 模拟器：hdc 的每条都带 -t，只认本机这个端口（真机的串号不是这个样子） */
class Harmony {
  hdc(...args: string[]): string {
    return execFileSync(HDC, ["-t", TARGET, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  }

  shell(command: string): string {
    return this.hdc("shell", command);
  }

  screenshot(file: string): void {
    const remote = "/data/local/tmp/ergo-shot.png";
    this.shell(`uitest screenCap -p ${remote}`);
    this.hdc("file", "recv", remote, file);
  }

  ui(): UiNode[] {
    const remote = "/data/local/tmp/ergo-layout.json";
    this.shell(`uitest dumpLayout -p ${remote}`);
    const dir = mkdtempSync(path.join(os.tmpdir(), "ergo-layout-"));
    const local = path.join(dir, "layout.json");
    this.hdc("file", "recv", remote, local);
    const tree = JSON.parse(readFileSync(local, "utf8")) as LayoutNode;
    rmSync(dir, { recursive: true, force: true });
    const nodes: UiNode[] = [];
    const visit = (node: LayoutNode) => {
      const box = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(node.attributes?.bounds ?? "");
      const text = node.attributes?.text ?? "";
      if (box && text) nodes.push({ text, x: (Number(box[1]) + Number(box[3])) >> 1, y: (Number(box[2]) + Number(box[4])) >> 1 });
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
    return nodes;
  }

  /** 系统的通知授权框挡着时（配对之后网页会要通知权限）点掉：框开着时网页的定时器不走，配对轮询也停着 */
  dismissNotifyDialog(nodes: readonly UiNode[]): void {
    const deny = nodes.find((n) => n.text === "不允许" || n.text === "Don't allow");
    if (deny) this.tap(deny.x, deny.y);
  }

  async waitText(text: string, timeoutMs = 30_000): Promise<UiNode> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const nodes = this.ui();
      this.dismissNotifyDialog(nodes);
      const found = nodes.find((n) => n.text.includes(text));
      if (found) return found;
      if (Date.now() > until) throw new Error(`界面上等不到：${text}（现有：${this.ui().map((n) => n.text.slice(0, 30)).join(" | ")}）`);
      await sleep(400);
    }
  }

  tap(x: number, y: number): void {
    this.shell(`uitest uiInput click ${x} ${y}`);
  }

  /** 把模拟器的端口接回电脑（App 的地址规矩不用放宽：本机 http 本来就许可） */
  reverse(port: number): void {
    this.hdc("rport", `tcp:${port}`, `tcp:${port}`);
  }

  feed(text: string): void {
    this.shell(`aa start -a EntryAbility -b ${BUNDLE} --ps ergoTestScanText '${text}'`);
  }

  clearDevtoolsForward(): void {
    for (const line of this.hdc("fport", "ls").split(/\r?\n/)) {
      const rule = /(tcp:\d+ localabstract:\S+)/.exec(line);
      if (rule) this.hdc("fport", "rm", rule[1]!);
    }
  }

  pid(): string {
    return /(\d+)/.exec(this.shell(`pidof ${BUNDLE}`))?.[1] ?? "";
  }
}

interface LayoutNode {
  attributes?: { text?: string; bounds?: string };
  children?: LayoutNode[];
}

function silentServer(): Promise<{ port: number; close(): void }> {
  return new Promise((resolve) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close() {
          for (const s of sockets) s.destroy();
          server.close();
        },
      }),
    );
  });
}

function badCertServer(): Promise<{ port: number; close(): void } | undefined> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ergo-scan-cert-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=not-ergo.example", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "2"], { stdio: "ignore" });
  } catch {
    return Promise.resolve(undefined);
  }
  const server = https.createServer({ key: readFileSync(path.join(dir, "k.pem")), cert: readFileSync(path.join(dir, "c.pem")) }, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"access":"none"}');
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close() {
          server.close();
          rmSync(dir, { recursive: true, force: true });
        },
      }),
    );
  });
}

/**
 * ArkWeb 在 http://127.0.0.1 上不存 Secure、__Host- 的 cookie（安卓的 WebView 存；isSecureContext 是真的，cookie 还是丢了），
 * 模拟器又没 root、装不了 CA，走不了真的 https。所以模拟器到外网端口之间放一个只给联调用的小代理：把 cookie 改成 ArkWeb 在 http 上肯存的名字，
 * 别的原样转发。产品代码不动，凭证的属性（Secure、__Host-）要在真机的 https 地址上验证。
 */
function cookieProxy(targetPort: number): Promise<{ port: number; close(): void }> {
  const toServer = (cookie: string | undefined) => cookie?.replace(/(^|;\s*)e2e-host-/g, "$1__Host-");
  const toClient = (setCookie: string[] | undefined) => setCookie?.map((c) => c.replace(/^__Host-/, "e2e-host-").replace(/;\s*Secure/i, ""));
  const forwarded = (req: http.IncomingMessage) => {
    const cookie = toServer(req.headers.cookie);
    return cookie === undefined ? req.headers : { ...req.headers, cookie };
  };
  const server = http.createServer((req, res) => {
    const upstream = http.request({ host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers: forwarded(req) }, (reply) => {
      const headers = { ...reply.headers };
      const setCookie = toClient(reply.headers["set-cookie"]);
      if (setCookie) headers["set-cookie"] = setCookie;
      res.writeHead(reply.statusCode ?? 502, headers);
      reply.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    const upstream = http.request({ host: "127.0.0.1", port: targetPort, method: req.method, path: req.url, headers: forwarded(req) });
    upstream.on("upgrade", (reply, upSocket, upHead) => {
      const lines = Object.entries(reply.headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((v) => `${name}: ${v}`));
      socket.write(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n${lines.join("\r\n")}\r\n\r\n`);
      socket.write(upHead);
      upSocket.write(head);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      upSocket.on("error", () => socket.destroy());
      socket.on("error", () => upSocket.destroy());
    });
    upstream.on("response", () => socket.destroy());
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.closeAllConnections() }));
  });
}

/** 经 fport 接上 ArkWeb 的调试口（上一次联调留下的转发先清掉：进程号变了） */
async function attachWeb(device: Harmony, match: (url: string) => boolean): Promise<Cdp> {
  const port = 9336;
  const until = Date.now() + 40_000;
  for (;;) {
    try {
      device.clearDevtoolsForward();
      device.hdc("fport", `tcp:${port}`, `localabstract:webview_devtools_remote_${device.pid()}`);
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await res.json()) as CdpTarget[];
      const target = targets.find((t) => match(t.url));
      if (target) return await Cdp.open(target);
    } catch {
      // 还没起来
    }
    if (Date.now() > until) throw new Error("连不上 App 的 ArkWeb 调试口（包是不是带 --webview-debug 构建的？）");
    await sleep(800);
  }
}

/** 喂了图片之后 App 开没开二狗的网页 */
async function webOpened(device: Harmony, external: string): Promise<boolean> {
  try {
    device.clearDevtoolsForward();
    device.hdc("fport", "tcp:9336", `localabstract:webview_devtools_remote_${device.pid()}`);
    const res = await fetch("http://127.0.0.1:9336/json/list");
    return ((await res.json()) as CdpTarget[]).some((t) => t.url.startsWith(external));
  } catch {
    return false;
  }
}

const device = new Harmony();
const shotsDir = process.argv[2];
const run = new Run(device, shotsDir);
let daemon: TestDaemonHandle | undefined;
let main: Cdp | undefined;
let exitCode = 1;
const closers: Array<() => void> = [];
const chrome = findChrome();
if (!chrome) throw new Error("找不到 Chrome：要用它打开二维码界面");
const browser = await chromium.launch({ executablePath: chrome });
/** 超长的一段：不合 DNS 的规矩（一段最长 63 个字符），不用出网就解析不了，也不受这台电脑的代理影响 */
const TOO_LONG = "x".repeat(70);

try {
  daemon = await startDaemon({ fakeLsm: true });
  const externalPort = Number(new URL(daemon.external).port);
  const proxy = await cookieProxy(externalPort);
  closers.push(() => proxy.close());
  const external = `http://127.0.0.1:${proxy.port}`;
  daemon.send(`entries ${JSON.stringify({ entries: [{ kind: "public", url: `${external}/`, port: externalPort, reachable: true }, { kind: "tailnet", url: "https://ergo.tail.example.test/", port: externalPort, reachable: false }], wrongPort: [] })}`);
  device.reverse(proxy.port);
  const site = await startSite(() => ({ "/": { type: "text/html", body: "<!doctype html><title>Not Ergo</title>" }, "/api/access": { type: "text/html", body: "<!doctype html><title>Not Ergo</title>" } }));
  closers.push(() => site.close());
  device.reverse(site.port);
  const silent = await silentServer();
  closers.push(() => silent.close());
  device.reverse(silent.port);
  const badCert = await badCertServer();
  if (badCert) {
    closers.push(() => badCert.close());
    device.reverse(badCert.port);
  }

  try {
    device.shell(`aa force-stop ${BUNDLE}`);
    device.shell(`bm uninstall -n ${BUNDLE}`);
  } catch {
    // 第一次装
  }
  console.log(device.hdc("install", "-r", HAP).trim().split("\n").at(-1));
  device.shell(`aa start -a EntryAbility -b ${BUNDLE}`);

  console.log("地址页");
  await run.step("地址页最上面是扫码连接，手填在下面", async () => {
    const scan = await device.waitText("Scan to connect");
    const heading = await device.waitText("Enter ergo's address");
    expectTrue(scan.y < heading.y, "扫码按钮在手填上面");
    await sleep(800);
    run.shot("harmony-address");
  });
  await run.step("点扫码连接：系统的扫码界面；用不了说明还能手填，退出来不算错", async () => {
    const scan = await device.waitText("Scan to connect");
    device.tap(scan.x, scan.y);
    await sleep(3000);
    run.shot("harmony-scan-system");
    // 系统的扫码界面不在 dumpLayout 里（底下 App 的界面还读得到），看不出开没开：点它左上角的 ✕（没开时点的是地址页的空白）。截图要人看过
    device.tap(126, 233);
    await sleep(1500);
    run.shot("harmony-scan-closed");
    await device.waitText("Enter ergo's address");
    expectTrue(!device.ui().some((n) => n.text.includes("Scanning isn't available")), "退出来不算出错");
  });

  console.log("报错");
  await run.step("扫到的不是地址：直接说，没有重试，有重新扫码", async () => {
    device.feed("WIFI:S:home;T:WPA;P:secret;;");
    await device.waitText("That isn't an ergo address");
    await device.waitText("Scan again");
    expectTrue(!device.ui().some((n) => n.text === "Try again"), "不是地址的没有重试");
    await sleep(300);
    run.shot("harmony-error-not-address");
  });
  await run.step("不是 https 的网址：一样说不是二狗地址", async () => {
    device.feed("http://ergo.example.test/");
    await device.waitText("That isn't an ergo address");
  });
  await run.step("解析不了域名：说清原因，提醒检查；普通域名的提醒里电脑那条在前", async () => {
    device.feed(`https://${TOO_LONG}.example.invalid/`);
    await device.waitText("This domain doesn't resolve", 20_000);
    const computer = await device.waitText("Are ergo and the service manager running");
    const tailnet = await device.waitText("Is Tailscale on for this phone");
    expectTrue(computer.y < tailnet.y, "普通域名：电脑那条在前");
    await device.waitText("Try again");
    await device.waitText("Scan again");
    run.shot("harmony-error-dns");
  });
  await run.step("看得出是 tailnet 的地址：tailnet 那条排最前", async () => {
    device.feed(`https://${TOO_LONG}.tail.example.invalid/`);
    await device.waitText("tail.example.invalid");
    await device.waitText("This domain doesn't resolve", 20_000);
    const computer = await device.waitText("Are ergo and the service manager running");
    const tailnet = await device.waitText("Is Tailscale on for this phone");
    expectTrue(tailnet.y < computer.y, "tailnet 地址：tailnet 那条在前");
    run.shot("harmony-error-tailnet");
  });
  await run.step("连上了但一直不回：约 10 秒超时", async () => {
    const started = Date.now();
    device.feed(`http://127.0.0.1:${silent.port}/`);
    await device.waitText("Timed out", 25_000);
    const took = Date.now() - started;
    expectTrue(took > 8_000 && took < 22_000, `超时约 10 秒（实际 ${took} 毫秒）`);
    run.shot("harmony-error-timeout");
  });
  await run.step("超时后点重试：再测一遍", async () => {
    const retry = await device.waitText("Try again");
    device.tap(retry.x, retry.y);
    await device.waitText("Connecting");
    run.shot("harmony-connecting");
    await device.waitText("Timed out", 25_000);
  });
  await run.step("连不上（对方拒绝）", async () => {
    device.feed("http://127.0.0.1:1/");
    await device.waitText("Can't get through", 20_000);
  });
  await run.step("回的不是二狗：能打开，但不是二狗", async () => {
    device.feed(`${site.origin}/`);
    await device.waitText("what answered is not ergo", 20_000);
    run.shot("harmony-error-not-ergo");
  });
  if (badCert) {
    await run.step("证书不对", async () => {
      device.feed(`https://127.0.0.1:${badCert.port}/`);
      await device.waitText("Certificate problem", 20_000);
      run.shot("harmony-error-cert");
    });
  }
  await run.step("连不上的时候没有进配对页：返回回到地址页", async () => {
    const back = await device.waitText("Back");
    device.tap(back.x, back.y);
    await device.waitText("Enter ergo's address");
  });

  console.log("真的二维码");
  const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const shotPath = path.join(os.tmpdir(), `ergo-e2e-qr-h-${process.pid}.png`);
  closers.push(() => rmSync(shotPath, { force: true }));
  let qrText = "";
  await run.step("电脑上的二维码界面：公网地址排第一", async () => {
    await desk.goto(`${daemon!.local}/#/more/devices/qr`);
    await desk.waitForSelector("svg.qr-code", { timeout: 30_000 });
    qrText = (await desk.getAttribute("svg.qr-code", "data-qr-text")) ?? "";
    expectEqual(qrText, `${external}/`, "二维码里是公网地址");
    await desk.locator("svg.qr-code").screenshot({ path: shotPath });
  });
  await run.step("把网页上那张二维码的截图喂给系统的解码器（模拟器支持的话），解出来和原文一样；测通了进配对页", async () => {
    // App 的沙箱目录：系统解码器只认 App 自己读得到的路径
    device.hdc("file", "send", shotPath, `/data/app/el2/100/base/${BUNDLE}/haps/entry/files/e2e-qr.png`);
    device.shell(`aa start -a EntryAbility -b ${BUNDLE} --ps ergoTestScanImage file://${BUNDLE}/data/storage/el2/base/haps/entry/files/e2e-qr.png`);
    await sleep(4000);
    const shown = device.ui().map((n) => n.text);
    console.log(`        喂图片之后界面上：${shown.slice(0, 7).map((t) => t.slice(0, 30)).join(" | ")}`);
    // 系统解码器在这台模拟器上解不出来时退回喂文字（解码另有 ZXing 的核对），日志里写清楚
    if (shown.some((t) => t.includes("That isn't an ergo address")) || !(await webOpened(device, external))) {
      console.log("        系统解码器没解出来，改喂文字");
      device.feed(qrText);
    } else {
      console.log("        系统解码器解出来了");
    }
    main = await attachWeb(device, (url) => url.startsWith(external));
    await main.waitFor("[...document.querySelectorAll('button')].some(b => b.textContent.includes('请求配对') || b.textContent.includes('Request pairing'))");
    await sleep(800);
    run.shot("harmony-pairing-page");
  });
  await run.step("手机发请求：二维码界面上直接出现设备名、短码、批准和拒绝", async () => {
    await main!.eval("[...document.querySelectorAll('button')].find(b => b.textContent.includes('请求配对') || b.textContent.includes('Request pairing')).click()");
    await desk.waitForSelector(".pair-qr-request", { timeout: 20_000 });
    const text = await desk.locator(".pair-qr-request").innerText();
    expectTrue(/\d{3}\s?\d{3}/.test(text), `有短码：${text}`);
  });
  await run.step("就地批准：写连好了；手机进了二狗", async () => {
    await desk.locator(".pair-qr-request .btn.primary").click();
    await desk.waitForSelector(".pair-qr-result.ok", { timeout: 20_000 });
    const page = main!;
    // 可能还有系统的通知授权框挡着：点掉网页才接着走
    const until = Date.now() + 40_000;
    while (!(await page.eval<boolean>("[...document.querySelectorAll('button')].some(b => /进入二狗|Open ergo/.test(b.textContent))"))) {
      device.dismissNotifyDialog(device.ui());
      if (Date.now() > until) throw new Error("等不到进入二狗的按钮");
      await sleep(800);
    }
    await page.eval("[...document.querySelectorAll('button')].find(b => /进入二狗|Open ergo/.test(b.textContent)).click()");
    await sleep(3000);
    device.dismissNotifyDialog(device.ui());
    await sleep(1000);
    run.shot("harmony-connected");
  });
  // 配对之后 App 的原生字跟着二狗的语言（中文）
  await run.step("已连接的手机换地址：入口也能扫码，有取消", async () => {
    main = await attachWeb(device, (url) => url.startsWith(external));
    await main.eval("(window.ergoNative || window.ergouNative).editServer()");
    await device.waitText("扫码连接");
    await device.waitText("取消");
    run.shot("harmony-address-connected");
  });
  await run.step("已连接的手机扫了连不上的地址：报错（中文），返回之后还连着原来的", async () => {
    device.feed(`${site.origin}/`);
    await device.waitText("回话的不是二狗", 20_000);
    await device.waitText("电脑上的二狗和服务管家在不在跑");
    await sleep(300);
    run.shot("harmony-error-zh");
    const back = await device.waitText("返回");
    device.tap(back.x, back.y);
    const cancel = await device.waitText("取消");
    device.tap(cancel.x, cancel.y);
    await sleep(1000);
    expectEqual(await main!.eval("location.origin"), external, "还连着原来的地址");
    run.shot("harmony-back-to-web");
  });

  exitCode = run.finish();
} catch (e) {
  console.error(e);
} finally {
  for (const close of closers) {
    try {
      close();
    } catch {
      // 收尾
    }
  }
  await browser.close();
  if (daemon) await daemon.stop();
}
process.exit(exitCode);
