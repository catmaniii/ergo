// 在 App 里更新 App（票 399）的模拟器联调。只用模拟器（串口 emulator-*），连临时守护进程（程序目录是这里摆的，downloads/ 里放着要发的安装包），
// 绝不碰真机和真的二狗。要几个现成的包（同一把钥匙签的旧、新两个 versionCode，再加一个换了钥匙签的新包），版本号的改动不提交：
//   npm run build:android -- --webview-debug                      → 旧包（frontend/app-version.json 现在的版本），复制出来
//   临时把 frontend/app-version.json 的 version、code 调高再构建一次 → 新包，复制出来，版本文件改回去
//   apksigner sign --ks <临时钥匙> --out <换钥匙的包> <新包>
//   node frontend/android/e2e/app-update.ts new emulator-5570 <旧包> <新包> <换钥匙的包> <新包的版本> [截图目录]
// new：新版 App（有 installAppUpdate）：设置里"有新版"、签名不同 / 版本不比装着的高 / 校验值对不上都不装、第一次去授权、装好后 App 报新版本。
//   node frontend/android/e2e/app-update.ts old emulator-5570 <downloads 里的旧版 App> [截图目录]
// old：旧版 App（0.4.2 及以前，没有这个方法）：按钮退回成从二狗直接下载，存成 .apk，在"文件"里点开装上。
//   发的就是同一个包（没有发布用的钥匙签不出更新的版本），守护进程那边写成更高的版本，只为让页面出"更新"。
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectEqual, expectTrue, Run, startDaemon, type TestDaemonHandle } from "./harness.ts";
import { type Cdp, Device, PACKAGE, sleep, WebViews } from "./lib.ts";

const [mode, serial, ...rest] = process.argv.slice(2);
if (mode !== "new" && mode !== "old") throw new Error("第一个参数是 new 或 old");
const device = new Device(serial ?? "emulator-5570");

/** 摆一个程序目录：downloads/ 里是要发的安装包，ergo-android.json 写它是哪一版（摆好的版本目录就是这样） */
const programDir = mkdtempSync(path.join(os.tmpdir(), "ergo-app-update-e2e-"));
function serve(apk: string, version: string, code: number): void {
  const dir = path.join(programDir, "downloads");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // 守护进程按大小、修改时间认换没换（换钥匙的包和原包一样大也认得出：修改时间变了）
  copyFileSync(apk, path.join(dir, "ergo-android-debug.apk"));
  writeFileSync(path.join(dir, "ergo-android.json"), JSON.stringify({ version, code }));
}

let daemon: TestDaemonHandle | undefined;
let exitCode = 1;
const shotsDir = mode === "new" ? rest[4] : rest[1];
const run = new Run(device, shotsDir);

async function submitAddress(address: string): Promise<void> {
  const until = Date.now() + 30_000;
  while (!device.ui().some((n) => n.className.includes("EditText"))) {
    if (Date.now() > until) break;
    await sleep(500);
  }
  const box = device.ui().find((n) => n.className.includes("EditText"));
  if (!box) throw new Error("地址页上找不到输入框");
  device.tap(box.x, box.y);
  await sleep(600);
  device.shell("input keycombination 113 29 && input keyevent 67");
  device.type(address);
  await sleep(400);
  device.shell("input keyevent 66");
}

/** 多行的字并成一行（打日志） */
const oneLine = (text: string) => text.trim().split(/\s*\n\s*/).join(" / ");

/** 装着的 App 的 versionCode */
function installedCode(): number {
  const m = /versionCode=(\d+)/.exec(device.shell(`dumpsys package ${PACKAGE}`));
  return m ? Number(m[1]) : 0;
}

/** 点界面上写着这段字的东西（uiautomator，WebView 里的也认） */
async function tapText(text: string | RegExp, timeoutMs = 30_000): Promise<void> {
  const node = await device.waitText(text, timeoutMs);
  device.tap(node.x, node.y);
}

/** 批准配对请求（守护进程那边） */
async function approve(d: TestDaemonHandle): Promise<void> {
  for (let i = 0; i < 30; i++) {
    d.send("approve");
    if ((await d.waitLine((l) => "approved" in l)).approved) return;
    await sleep(500);
  }
  throw new Error("守护进程一直没收到配对请求");
}

async function pairWithCdp(d: TestDaemonHandle): Promise<Cdp> {
  await submitAddress(`${d.external}/`);
  const views = await WebViews.connect(device, 9341);
  const page = await views.attach((url) => url.startsWith(d.external));
  await page.waitFor("window.ergoNative && document.getElementById('root') && document.getElementById('root').childElementCount > 0", 40_000);
  // 页面开场会按语言重画一次：等它稳下来再点，点了要看到它换成等待批准的样子
  const hasButton = "[...document.querySelectorAll('button')].some(b => b.textContent.includes('请求配对'))";
  await page.waitFor(hasButton, 40_000);
  for (let i = 0; i < 5; i++) {
    await sleep(1500);
    await page.eval("[...document.querySelectorAll('button')].find(b => b.textContent.includes('请求配对'))?.click()");
    await sleep(1500);
    if (!(await page.eval<boolean>(hasButton))) break;
  }
  await approve(d);
  try {
    await page.waitFor("fetch('/api/access').then(r => r.json()).then(j => j.access === 'device')", 40_000);
  } catch (e) {
    run.shot("00-pairing-stuck");
    const text = await page.eval<string>("document.body.innerText");
    console.log(`        页面上：${oneLine(text.slice(0, 400))}`);
    throw e;
  }
  // 配对成功那一页点"进入"就是重新加载：照做
  await page.eval("location.reload()");
  await sleep(1500);
  await page.waitFor("window.ergoNative && document.getElementById('root') && document.getElementById('root').childElementCount > 0", 40_000);
  return page;
}

/** 到设置 · 设备配对，等这一行的字 */
async function openDevices(page: Cdp): Promise<void> {
  // 刚配对完页面还会自己跳一次首页：跳过去了再设一次
  for (let i = 0; i < 8; i++) {
    await page.eval("location.hash = '#/more/devices'");
    try {
      await page.waitFor("document.querySelector('.device-list') && document.querySelector('.device-list').innerText.includes('就是这台')", 5000);
      return;
    } catch {
      // 再来
    }
  }
  throw new Error("打不开设置 · 设备配对");
}

const rowText = (page: Cdp) => page.eval<string>("document.querySelector('.device-list') ? document.querySelector('.device-list').innerText : ''");

/** 点"更新"，等页面上出现没装上的那句话 */
async function updateExpectingFailure(page: Cdp, text: string): Promise<string> {
  await page.waitFor("document.querySelector('[data-action=app-update]') && !document.querySelector('[data-action=app-update]').disabled", 20_000);
  await page.eval("document.querySelector('[data-action=app-update]').click()");
  await page.waitFor(`document.querySelector('.app-update-failed') && document.querySelector('.app-update-failed').innerText.includes(${JSON.stringify(text)})`, 60_000);
  return page.eval<string>("document.querySelector('.app-update-failed').innerText");
}

try {
  daemon = await startDaemon({ programDir });
  const externalPort = Number(new URL(daemon.external).port);
  device.reverse(externalPort);
  device.shell("cmd uimode night no");

  if (mode === "new") {
    const [oldApk, newApk, otherApk, newVersion] = rest as [string, string, string, string];
    const newCode = 1003;
    serve(newApk, newVersion, newCode);
    try {
      device.adb("uninstall", PACKAGE);
    } catch {
      // 本来就没装
    }
    device.adb("install", oldApk);
    device.shell(`pm grant ${PACKAGE} android.permission.POST_NOTIFICATIONS`);
    device.adb("logcat", "-c");
    device.shell(`am start -W -n ${PACKAGE}/.MainActivity`);
    const oldCode = installedCode();
    let page: Cdp | undefined;

    await run.step("装旧包、配对：设置 · 设备配对里这台手机那一行写'有新版'，有'更新'按钮", async () => {
      page = await pairWithCdp(daemon!);
      expectTrue(await page.eval("typeof window.ergoNative.installAppUpdate === 'function'"), "新版 App 有 installAppUpdate");
      await openDevices(page);
      try {
        await page.waitFor(`document.querySelector('.device-list').innerText.includes('有新版 ${newVersion}')`, 20_000);
      } catch (e) {
        console.log(`        这一行：${oneLine(await rowText(page))}`);
        console.log(`        /api/app-update：${await page.eval<string>("fetch('/api/app-update').then(r => r.status + ' ' + r.statusText).catch(e => String(e))")}`);
        throw e;
      }
      await page.waitFor("!!document.querySelector('[data-action=app-update]')", 10_000);
      await sleep(800);
      run.shot("01-new-version-row");
    });

    await run.step("没配对的拿不到安装包（外网端口不带凭证 401）", async () => {
      const res = await fetch(`${daemon!.external}/api/app-update/android.apk`, { headers: { Origin: daemon!.external } });
      expectEqual(res.status, 401, "没配对时下载地址的状态码");
    });

    await run.step("签名不一样：不装，页面写原因", async () => {
      serve(otherApk, newVersion, newCode);
      await page!.eval("location.reload()");
      await sleep(1500);
      await openDevices(page!);
      const text = await updateExpectingFailure(page!, "签名");
      console.log(`        ${text}`);
      run.shot("02-signature-mismatch");
      expectEqual(installedCode(), oldCode, "还是旧版");
    });

    await run.step("版本号不比装着的高：不装，页面写原因", async () => {
      serve(oldApk, newVersion, newCode);
      await page!.eval("location.reload()");
      await sleep(1500);
      await openDevices(page!);
      const text = await updateExpectingFailure(page!, "不比手机上装着的新");
      console.log(`        ${text}`);
      run.shot("03-version-not-higher");
    });

    await run.step("下下来的和二狗给的校验值对不上：不装，页面写原因", async () => {
      serve(newApk, newVersion, newCode);
      await page!.eval("location.reload()");
      await sleep(1500);
      await openDevices(page!);
      await page!.waitFor("!!document.querySelector('[data-action=app-update]')", 10_000);
      // 页面拿到校验值之后，二狗那边的文件换成了别的（换钥匙的包）：下下来的对不上
      serve(otherApk, newVersion, newCode);
      const text = await updateExpectingFailure(page!, "校验值对不上");
      console.log(`        ${text}`);
      run.shot("04-checksum-mismatch");
      serve(newApk, newVersion, newCode);
    });

    await run.step("点'更新'：第一次带去系统设置允许安装，回来接着装，装好后是新版", async () => {
      await page!.eval("location.reload()");
      await sleep(1500);
      await openDevices(page!);
      await page!.waitFor("document.querySelector('[data-action=app-update]') && !document.querySelector('[data-action=app-update]').disabled", 20_000);
      await page!.eval("document.querySelector('[data-action=app-update]').click()");
      const allow = await device.waitText(/Allow from this source|允许来自此来源的应用/, 60_000);
      run.shot("05-install-unknown-apps");
      device.tap(allow.x, allow.y);
      await sleep(1000);
      run.shot("06-allowed");
      device.back();
      // 系统允许就不弹确认；弹了就点"更新"
      const until = Date.now() + 120_000;
      let confirmed = false;
      while (installedCode() !== newCode) {
        if (Date.now() > until) throw new Error(`等不到装好（还是 ${installedCode()}）`);
        const ui = device.ui();
        const button = ui.find((n) => /^(Update|更新|Install|安装)$/i.test(n.text));
        if (button && !confirmed) {
          run.shot("07-system-confirm");
          device.tap(button.x, button.y);
          confirmed = true;
        }
        await sleep(700);
      }
      console.log(`        装好了：versionCode ${installedCode()}；系统弹没弹确认：${confirmed ? "弹了" : "没弹"}`);
    });

    await run.step("装好后通知栏里一条'已更新'，点开 App，报新版本，'有新版'没了", async () => {
      await sleep(4000);
      const resumed = () => device.shell("dumpsys activity activities | grep -i resumedactivity").includes(`${PACKAGE}/`);
      const relaunched = resumed();
      console.log(`        装好后 App ${relaunched ? "自己开起来了" : "没自己开起来（安卓不许后台起界面）"}`);
      run.shot("08-after-install");
      if (!relaunched) {
        const notices = device.shell("dumpsys notification --noredact | grep -i 'android.title='");
        console.log(`        通知栏：${oneLine(notices).split(" / ").filter((l) => l.includes("二狗") || l.includes("ergo")).join(" / ")}`);
        device.shell("cmd statusbar expand-notifications");
        await sleep(1500);
        run.shot("08b-notification");
        await tapText(/二狗 App 已更新到|The ergo app is updated to/, 20_000);
        await sleep(2000);
        expectTrue(resumed(), "点通知打开了 App");
      }
      const views = await WebViews.connect(device, 9342);
      const after = await views.attach((url) => url.startsWith(daemon!.external));
      await after.waitFor("window.ergoNative && document.getElementById('root') && document.getElementById('root').childElementCount > 0", 40_000);
      expectEqual(await after.eval("window.ergoNative.appVersion()"), newVersion, "App 报的版本");
      await openDevices(after);
      await after.waitFor(`document.querySelector('.device-list').innerText.includes('App ${newVersion}')`, 30_000);
      const text = await rowText(after);
      expectTrue(!text.includes("有新版"), "'有新版'没了");
      await sleep(800);
      run.shot("09-updated-row");
      after.close();
    });
    page?.close();
  } else {
    const [oldApk] = rest as [string];
    // 守护进程那边写成更高的版本（发的还是同一个包）：页面才出"更新"
    serve(oldApk, "9.9.9", 999_999);
    // "文件"还没被允许安装应用、下载目录里没有上次的：从头走一遍
    device.shell("appops set com.google.android.documentsui REQUEST_INSTALL_PACKAGES default; rm -f /sdcard/Download/ergo-android-*.apk");
    try {
      device.adb("uninstall", PACKAGE);
    } catch {
      // 本来就没装
    }
    device.adb("install", oldApk);
    device.shell(`pm grant ${PACKAGE} android.permission.POST_NOTIFICATIONS`);
    device.shell(`am start -W -n ${PACKAGE}/.MainActivity`);
    const before = /lastUpdateTime=([^\n]+)/.exec(device.shell(`dumpsys package ${PACKAGE}`))?.[1];

    await run.step("旧版 App 配对，设置里那一行是'更新'的下载链接", async () => {
      await submitAddress(`${daemon!.external}/`);
      // 页面开场会按语言重画一次：等它稳下来再点，点到它换成等待批准的样子为止
      await device.waitText("请求配对", 60_000);
      for (let i = 0; i < 6; i++) {
        await sleep(2500);
        const button = device.ui().find((n) => n.text === "请求配对");
        if (!button) break;
        device.tap(button.x, button.y);
      }
      await approve(daemon!);
      await tapText("进入二狗", 40_000);
      await sleep(3000);
      // 没有 WebView 调试（发布的包）：照人那样点进设置 · 设备配对
      await tapText(/^更多$/, 30_000);
      await sleep(1500);
      // 网页里一项的标题和说明会并成一段字（"设置 我的名字、……"），按开头认
      // 网页里屏幕外的元素也在 uiautomator 的树里：要在屏幕上的才点得到
      const find = () => device.ui().find((n) => (/^设备配对(\s|$)/.test(n.text) || n.desc === "设备配对") && n.top > 150 && n.bottom < 2250);
      if (!device.ui().some((n) => /^设备配对(\s|$)/.test(n.text))) {
        await tapText(/^设置(\s|$)/, 15_000);
        await sleep(1500);
      }
      for (let i = 0; i < 8 && !find(); i++) {
        device.shell("input swipe 540 1800 540 700 400");
        await sleep(800);
      }
      const entry = find();
      if (!entry) throw new Error("找不到'设备配对'");
      device.tap(entry.x, entry.y);
      try {
        await device.waitText("有新版 9.9.9", 30_000);
      } catch (e) {
        run.shot("10-old-app-row-missing");
        console.log(`        界面上：${device.ui().map((n) => n.text).filter(Boolean).join(" / ").slice(0, 600)}`);
        throw e;
      }
      run.shot("11-old-app-row");
    });

    await run.step("点'更新'：从二狗下载，存成 .apk", async () => {
      await tapText(/^更新$/);
      // 系统的"保存到"
      const save = await device.waitText(/^(SAVE|Save|保存)$/, 60_000);
      run.shot("12-old-app-save");
      device.tap(save.x, save.y);
      await sleep(3000);
      const listing = device.shell("ls /sdcard/Download/");
      console.log(`        下载目录：${listing.trim().split("\n").join("、")}`);
      expectTrue(/ergo-android-9\.9\.9\.apk/.test(listing), "存成了 .apk");
    });

    await run.step("在'文件'里点开安装包，装上", async () => {
      // 打开"文件"，在下载里点它
      device.shell("am start -W -a android.intent.action.VIEW -d content://com.android.externalstorage.documents/root/primary -t vnd.android.document/root");
      await sleep(2000);
      if (!device.ui().some((n) => n.text.includes("ergo-android-9.9.9.apk"))) {
        const download = device.ui().find((n) => /^(Download|Downloads|下载)$/.test(n.text));
        if (download) device.tap(download.x, download.y);
        await sleep(1500);
      }
      await tapText("ergo-android-9.9.9.apk", 20_000);
      await sleep(2500);
      run.shot("13-old-app-open-apk");
      const until = Date.now() + 120_000;
      let allowed = false;
      for (;;) {
        const after = /lastUpdateTime=([^\n]+)/.exec(device.shell(`dumpsys package ${PACKAGE}`))?.[1];
        if (after && after !== before) {
          console.log(`        装上了：lastUpdateTime ${before} → ${after}`);
          break;
        }
        if (Date.now() > until) throw new Error("等不到装上");
        const ui = device.ui();
        const settings = ui.find((n) => /^(Settings|设置)$/.test(n.text));
        const allow = ui.find((n) => /Allow from this source|允许来自此来源的应用/.test(n.text));
        const button = ui.find((n) => /^(Update|更新|Install|安装)$/i.test(n.text));
        // 允许之后系统回到"文件"：照手册说的再点一次
        const file = ui.find((n) => n.text === "ergo-android-9.9.9.apk");
        if (allow) {
          // 只打开一次（再点就关上了），然后返回
          if (!allowed) {
            run.shot("13b-old-app-allow");
            device.tap(allow.x, allow.y);
            allowed = true;
            await sleep(800);
          }
          device.back();
        } else if (settings) {
          device.tap(settings.x, settings.y);
        } else if (button) {
          run.shot("14-old-app-confirm");
          device.tap(button.x, button.y);
        } else if (file) {
          device.tap(file.x, file.y);
        }
        await sleep(1000);
      }
      run.shot("15-old-app-installed");
    });
  }
  exitCode = run.finish();
} catch (e) {
  console.error(e);
} finally {
  await daemon?.stop();
  rmSync(programDir, { recursive: true, force: true });
}
process.exit(exitCode);
