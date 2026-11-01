// 扫码连接在模拟器上的联调。只用模拟器（串口 emulator-*，lib.ts 里卡着），连临时守护进程和假的服务管家，绝不碰真机和真的二狗、服务管家。
// 先有一个开着的模拟器，再：
//   npm run build:android -- --webview-debug
//   node frontend/android/e2e/scan.ts emulator-5570 [截图目录]
// 走一遍：地址页 → 相机权限拒绝的说法 → 取景页 → 扫到的不是地址 → 解析不了、超时、证书不对、连不上、回的不是二狗 → 真的二维码（网页上那张的截图，
// 经测试入口喂给 ZXing）→ 测通了进配对页 → 就在二维码界面上批准 → 连上 → 已连接的手机换地址的入口也能扫码。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { findChrome } from "../../../packages/web/build/chrome.ts";
import { expectEqual, expectTrue, Run, startDaemon, startSite, type TestDaemonHandle } from "./harness.ts";
import { ADB, type Cdp, Device, PACKAGE, sleep, WebViews } from "./lib.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APK = path.join(HERE, "..", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const QR_ON_DEVICE = `/data/user/0/${PACKAGE}/files/e2e-qr.png`;

const device = new Device(process.argv[2] ?? "emulator-5570");
const shotsDir = process.argv[3];
const run = new Run(device, shotsDir);

/** 经测试入口喂一段扫到的文字（只有 --webview-debug 的包认） */
function feedText(text: string): void {
  device.adb("shell", `am start -n ${PACKAGE}/.MainActivity --es ergoTestScanText '${text}'`);
}

/** 一台什么都不回的服务器：连得上，永远等不到回话（超时那一步） */
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

/** 自签证书的 https 服务器（证书不对那一步）；要 openssl（Git Bash 带的），没有就是 undefined */
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

/** App 记着的地址（偏好文件里的那一行）：连不上的时候不该记下来 */
function savedAddress(): boolean {
  return device.adb("exec-out", "run-as", PACKAGE, "sh", "-c", "cat shared_prefs/*.xml").includes('name="server_url"');
}

let daemon: TestDaemonHandle | undefined;
let main: Cdp | undefined;
let exitCode = 1;
const closers: Array<() => void> = [];
const chrome = findChrome();
if (!chrome) throw new Error("找不到 Chrome：要用它打开二维码界面");
const browser = await chromium.launch({ executablePath: chrome });

try {
  daemon = await startDaemon({ fakeLsm: true });
  const externalPort = Number(new URL(daemon.external).port);
  const external = daemon.external;
  // 假的服务管家：公网入口就是这个临时二狗的外网端口（模拟器经 adb reverse 能到）；tailnet 给一个连不到的，只为了验证切换
  daemon.send(`entries ${JSON.stringify({ entries: [{ kind: "public", url: `${external}/`, port: externalPort, reachable: true }, { kind: "tailnet", url: "https://ergo.tail.example.test/", port: externalPort, reachable: false }], wrongPort: [] })}`);
  device.reverse(externalPort);
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

  device.adb("install", "-r", APK);
  device.shell(`pm clear ${PACKAGE}`);
  device.shell(`pm grant ${PACKAGE} android.permission.POST_NOTIFICATIONS`);
  device.shell("cmd uimode night no");
  device.adb("logcat", "-c");
  device.shell(`am start -W -n ${PACKAGE}/.MainActivity`);

  console.log("地址页");
  await run.step("地址页最上面是扫码连接，手填在下面", async () => {
    const scan = await device.waitText("Scan to connect");
    const heading = await device.waitText("Enter ergo's address");
    const input = device.ui().find((n) => n.className.includes("EditText"));
    expectTrue(scan.y < heading.y && input !== undefined && scan.y < input.y, "扫码按钮在手填上面");
    await sleep(800);
    run.shot("android-address");
  });

  console.log("相机权限");
  await run.step("点了才要权限；拒绝了说明还能手填", async () => {
    const scan = await device.waitText("Scan to connect");
    device.tap(scan.x, scan.y);
    const deny = await device.waitText(/Don.t allow/i);
    run.shot("android-camera-permission");
    device.tap(deny.x, deny.y);
    await device.waitText("type the address below");
    run.shot("android-camera-denied");
  });
  await run.step("给了权限：取景页，取消回到地址页", async () => {
    device.shell(`pm grant ${PACKAGE} android.permission.CAMERA`);
    const scan = await device.waitText("Scan to connect");
    device.tap(scan.x, scan.y);
    const cancel = await device.waitText("Cancel");
    await device.waitText("Scan the pairing code on your computer");
    await sleep(2500);
    run.shot("android-scan-viewfinder");
    expectTrue(!device.appLog().includes("scan unavailable"), "相机开得起来");
    device.tap(cancel.x, cancel.y);
    await device.waitText("Enter ergo's address");
  });

  console.log("报错");
  await run.step("扫到的不是地址：直接说，没有重试，有重新扫码", async () => {
    feedText("WIFI:S:home;T:WPA;P:secret;;");
    await device.waitText("That isn't an ergo address");
    await device.waitText("Scan again");
    expectTrue(!device.ui().some((n) => n.text === "Try again"), "不是地址的没有重试");
    run.shot("android-error-not-address");
  });
  await run.step("不是 https 的网址：一样说不是二狗地址", async () => {
    feedText("http://ergo.example.test/");
    await device.waitText("That isn't an ergo address");
  });
  // 这台电脑的网络可能把不存在的域名也解析出来（代理的 fake-ip）：关掉模拟器的网才是真的解析不了；adb reverse 不走它的网，不受影响
  device.shell("svc wifi disable; svc data disable");
  await sleep(3000);
  await run.step("解析不了域名：说清原因，提醒检查；普通域名的提醒里电脑那条在前", async () => {
    feedText("https://ergo-nonexistent.invalid/");
    await device.waitText("This domain doesn't resolve", 20_000);
    const computer = await device.waitText("Are ergo and the service manager running");
    const tailnet = await device.waitText("Is Tailscale on for this phone");
    expectTrue(computer.y < tailnet.y, "普通域名：电脑那条在前");
    await device.waitText("Try again");
    await device.waitText("Scan again");
    run.shot("android-error-dns");
  });
  await run.step("看得出是 tailnet 的地址：tailnet 那条排最前", async () => {
    feedText("https://ergo.tail.nonexistent.invalid/");
    await device.waitText("ergo.tail.nonexistent.invalid");
    await device.waitText("This domain doesn't resolve", 20_000);
    const computer = await device.waitText("Are ergo and the service manager running");
    const tailnet = await device.waitText("Is Tailscale on for this phone");
    expectTrue(tailnet.y < computer.y, "tailnet 地址：tailnet 那条在前");
    run.shot("android-error-tailnet");
  });
  device.shell("svc wifi enable; svc data enable");
  await sleep(2000);
  await run.step("连上了但一直不回：约 10 秒超时", async () => {
    const started = Date.now();
    feedText(`http://127.0.0.1:${silent.port}/`);
    await device.waitText("Timed out", 20_000);
    const took = Date.now() - started;
    expectTrue(took > 8_000 && took < 18_000, `超时约 10 秒（实际 ${took} 毫秒）`);
    run.shot("android-error-timeout");
  });
  await run.step("https 握手一直没回话：也是约 10 秒超时，不崩", async () => {
    const started = Date.now();
    feedText(`https://127.0.0.1:${silent.port}/`);
    await device.waitText(`https://127.0.0.1:${silent.port}/`);
    await device.waitText("Timed out", 20_000);
    const took = Date.now() - started;
    expectTrue(took > 8_000 && took < 18_000, `超时约 10 秒（实际 ${took} 毫秒）`);
  });
  await run.step("超时后点重试：再测一遍", async () => {
    const retry = await device.waitText("Try again");
    device.tap(retry.x, retry.y);
    await device.waitText("Connecting");
    run.shot("android-connecting");
    await device.waitText("Timed out", 20_000);
  });
  await run.step("连不上（对方拒绝）", async () => {
    feedText("http://127.0.0.1:1/");
    await device.waitText("Can't get through", 20_000);
  });
  await run.step("回的不是二狗：能打开，但不是二狗", async () => {
    feedText(`${site.origin}/`);
    await device.waitText("what answered is not ergo", 20_000);
    run.shot("android-error-not-ergo");
  });
  if (badCert) {
    await run.step("证书不对", async () => {
      feedText(`https://127.0.0.1:${badCert.port}/`);
      await device.waitText("Certificate problem", 20_000);
      run.shot("android-error-cert");
    });
  }
  await run.step("连不上的时候没有进配对页：返回回到地址页，手填还在", async () => {
    const back = await device.waitText("Back");
    device.tap(back.x, back.y);
    await device.waitText("Enter ergo's address");
    expectTrue(!savedAddress(), "连不上的地址没有记下来");
  });

  console.log("真的二维码");
  const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const shotPath = path.join(os.tmpdir(), `ergo-e2e-qr-${process.pid}.png`);
  closers.push(() => rmSync(shotPath, { force: true }));
  await run.step("电脑上的二维码界面：公网地址排第一，能切换", async () => {
    await desk.goto(`${daemon!.local}/#/more/devices/qr`);
    await desk.waitForSelector("svg.qr-code", { timeout: 30_000 });
    expectEqual(await desk.getAttribute("svg.qr-code", "data-qr-text"), `${external}/`, "二维码里是公网地址");
    await desk.waitForSelector(".pair-qr-option");
    expectEqual(await desk.locator(".pair-qr-option").count(), 2, "两个地址");
    await desk.locator("svg.qr-code").screenshot({ path: shotPath });
  });
  await run.step("把网页上那张二维码的截图喂给 App：ZXing 解出来，测通了进配对页", async () => {
    execFileSync(ADB, ["-s", device.serial, "exec-in", "run-as", PACKAGE, "sh", "-c", "mkdir -p files && cat > files/e2e-qr.png"], { input: readFileSync(shotPath) });
    device.adb("shell", `am start -n ${PACKAGE}/.MainActivity --es ergoTestScanImage ${QR_ON_DEVICE}`);
    const views = await WebViews.connect(device, 9334);
    main = await views.attach((url) => url.startsWith(external));
    await main.waitFor("[...document.querySelectorAll('button')].some(b => b.textContent.includes('请求配对') || b.textContent.includes('Request pairing'))");
    await sleep(800);
    run.shot("android-pairing-page");
  });
  // 手机宽的同一个界面（只为了截图：配对请求在 390 宽下也不用往下翻）
  const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await narrow.goto(`${daemon.local}/#/more/devices/qr`);
  await narrow.waitForSelector("svg.qr-code", { timeout: 30_000 });
  await run.step("手机发请求：二维码界面上直接出现设备名、短码、批准和拒绝", async () => {
    await main!.eval("[...document.querySelectorAll('button')].find(b => b.textContent.includes('请求配对') || b.textContent.includes('Request pairing')).click()");
    await desk.waitForSelector(".pair-qr-request", { timeout: 20_000 });
    const text = await desk.locator(".pair-qr-request").innerText();
    expectTrue(/\d{3}\s?\d{3}/.test(text), `有短码：${text}`);
    if (shotsDir) {
      await desk.screenshot({ path: path.join(shotsDir, "web-qr-request-1280.png") });
      await narrow.waitForSelector(".pair-qr-request", { timeout: 20_000 });
      await narrow.screenshot({ path: path.join(shotsDir, "web-qr-request-390.png") });
    }
  });
  await run.step("就地批准：写连好了；手机进了二狗", async () => {
    await desk.locator(".pair-qr-request .btn.primary").click();
    await desk.waitForSelector(".pair-qr-result.ok", { timeout: 20_000 });
    if (shotsDir) {
      await desk.screenshot({ path: path.join(shotsDir, "web-qr-connected-1280.png") });
      await narrow.waitForSelector(".pair-qr-result.ok", { timeout: 20_000 });
      await narrow.screenshot({ path: path.join(shotsDir, "web-qr-connected-390.png") });
    }
    const page = main!;
    await page.waitFor("[...document.querySelectorAll('button')].some(b => /进入二狗|Enter ergo/.test(b.textContent))", 20_000).catch(async (e: unknown) => {
      console.log(`        App 上的页面：${String(await page.eval("document.body.innerText")).replace(/\s+/g, " ").slice(0, 300)}`);
      throw e;
    });
    await page.eval("[...document.querySelectorAll('button')].find(b => /进入二狗|Enter ergo/.test(b.textContent)).click()");
    await sleep(2500);
    run.shot("android-connected");
    expectTrue(!device.ui().some((n) => n.text.includes("Enter ergo's address")), "不在地址页");
  });
  // 配对之后 App 的原生字跟着二狗的语言（中文）
  await run.step("已连接的手机换地址：入口也能扫码，有取消", async () => {
    await main!.eval("window.ergoNative.editServer()");
    await device.waitText("扫码连接");
    await device.waitText("取消");
    run.shot("android-address-connected");
  });
  await run.step("已连接的手机扫了连不上的地址：报错（中文），返回之后还连着原来的", async () => {
    feedText(`${site.origin}/`);
    await device.waitText("回话的不是二狗", 20_000);
    await device.waitText("电脑上的二狗和服务管家在不在跑");
    await sleep(300);
    run.shot("android-error-zh");
    const back = await device.waitText("返回");
    device.tap(back.x, back.y);
    const cancel = await device.waitText("取消");
    device.tap(cancel.x, cancel.y);
    await sleep(800);
    expectTrue(!device.ui().some((n) => n.text.includes("扫码连接")), "回到网页了");
    expectEqual(await main!.eval("location.origin"), external, "还连着原来的地址");
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
