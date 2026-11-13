// 网页视频真全屏（票 407）在鸿蒙模拟器上的联调，和 frontend/android/e2e/video-fullscreen.ts 走同样的路。
// 只连模拟器（hdc 目标 127.0.0.1:5555，下面卡着），不连真的二狗：App 的地址经联调的测试入口填成本机起的小网站
// （frontend/android/e2e/video-site.ts：两段 <video controls>，/api/access 回得像二狗）。要 ffmpeg（现生成测试视频）。
// 模拟器能装不签名的包。先有一个开着、解了锁的模拟器，再：
//   npm run build:harmony -- --webview-debug
//   node frontend/harmony/e2e/video-fullscreen.ts [截图目录]
// 走一遍：原生桥有 videoFullscreen → 横视频进全屏：状态栏、手势条藏了，转横屏 → 返回手势先退全屏（App 还在前台）、都恢复 →
// 竖视频进全屏不转 → 网页自己退全屏 → 全屏时回桌面再回来：已经退出、不留藏着状态栏的半截。
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectEqual, expectTrue, Run } from "../../android/e2e/harness.ts";
import { Cdp, type CdpTarget, sleep } from "../../android/e2e/lib.ts";
import { enterFullscreenScript, startVideoSite, type VideoSite } from "../../android/e2e/video-site.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HAP = path.join(HERE, "..", "entry", "build", "default", "outputs", "default", "entry-default-unsigned.hap");
const BUNDLE = "com.catmaniii.ergo";
const TARGET = "127.0.0.1:5555";
const HDC = process.env.HDC ?? "D:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe";
const DEVTOOLS_PORT = 9337;

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

  reverse(port: number): void {
    this.hdc("rport", `tcp:${port}`, `tcp:${port}`);
  }

  pid(): string {
    return /(\d+)/.exec(this.shell(`pidof ${BUNDLE}`))?.[1] ?? "";
  }

  /** App 的日志（hilog 里 ErgoApp 的） */
  appLog(): string {
    return this.shell("hilog -x | grep ErgoApp");
  }

  /** 窗口管理的窗口表（藏起来的窗口 ZOrd 是 -1） */
  windows(): Array<{ name: string; pid: string; winId: string; zOrder: number; width: number; height: number }> {
    const dump = this.shell("hidumper -s WindowManagerService -a '-a'");
    const rows: Array<{ name: string; pid: string; winId: string; zOrder: number; width: number; height: number }> = [];
    for (const line of dump.split(/\r?\n/)) {
      const m = /^(\S+)\s+\d+\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+\d+\s+(-?\d+)\s+\d+\s+\[\s*-?\d+\s+-?\d+\s+(\d+)\s+(\d+)\s*\]/.exec(line);
      if (m) rows.push({ name: m[1]!, pid: m[2]!, winId: m[3]!, zOrder: Number(m[4]), width: Number(m[5]), height: Number(m[6]) });
    }
    return rows;
  }
}

const device = new Harmony();
const run = new Run(device, process.argv[2]);

/**
 * 状态栏、底部手势条显示着没有。状态栏藏起来时它的窗口 ZOrd 变 -1；手势条的窗口一直在表里，
 * 看 App 自己量的底部避让区（手势条藏了 indicator 是 0，Index.ets 的 updateBottomInset 记进日志）
 */
function barsVisible(): { status: boolean; gesture: boolean } {
  const status = device.windows().some((w) => w.name.startsWith("SCBStatusBar") && w.zOrder >= 0);
  const insets = [...device.appLog().matchAll(/bottom avoid area: \d+ px \(indicator (\d+),/g)];
  const indicator = insets.length > 0 ? Number(insets.at(-1)![1]) : -1;
  return { status, gesture: indicator > 0 };
}

/** App 的主窗口开着常亮没有：电源管理里这个窗口的 windowLock（setWindowKeepScreenOn 的那把）是不是在用（state=1） */
function windowKeptOn(): boolean {
  const pid = device.pid();
  const own = device.windows().find((w) => w.pid === pid && w.width > 0);
  if (!own) return false;
  const locks = device.shell("hidumper -s PowerManagerService -a '-a'");
  return new RegExp(`name=windowLock_${own.winId}_\\d+ [^\\n]*state=1`).test(locks);
}

/** App 的主窗口现在是不是横的（宽 > 高） */
function appLandscape(): boolean {
  const pid = device.pid();
  const own = device.windows().find((w) => w.pid === pid && w.zOrder >= 0 && w.width > 0);
  return own !== undefined && own.width > own.height;
}

async function waitUntil(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`等不到：${what}`);
    await sleep(400);
  }
}

/** 经 fport 接上 ArkWeb 的调试口（上一次联调留下的转发先清掉：进程号变了） */
async function attachWeb(match: (url: string) => boolean): Promise<Cdp> {
  const until = Date.now() + 40_000;
  for (;;) {
    try {
      for (const line of device.hdc("fport", "ls").split(/\r?\n/)) {
        const rule = /(tcp:\d+ localabstract:\S+)/.exec(line);
        if (rule) device.hdc("fport", "rm", rule[1]!);
      }
      device.hdc("fport", `tcp:${DEVTOOLS_PORT}`, `localabstract:webview_devtools_remote_${device.pid()}`);
      const res = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`);
      const target = ((await res.json()) as CdpTarget[]).find((t) => match(t.url));
      if (target) return await Cdp.open(target);
    } catch {
      // 还没起来
    }
    if (Date.now() > until) throw new Error("连不上 App 的 ArkWeb 调试口（包是不是带 --webview-debug 构建的？）");
    await sleep(800);
  }
}

async function enterFullscreen(page: Cdp, id: string): Promise<void> {
  await page.send("Runtime.evaluate", { expression: enterFullscreenScript(id), userGesture: true, awaitPromise: true });
  await page.waitFor("!!document.fullscreenElement", 8000);
}

function appInFront(): boolean {
  const pid = device.pid();
  return pid.length > 0 && device.windows().some((w) => w.pid === pid && w.zOrder >= 0 && w.width > 0);
}

let main: Cdp | undefined;
let site: VideoSite | undefined;
let exitCode = 1;

try {
  site = await startVideoSite();
  device.reverse(site.port);
  try {
    device.shell(`aa force-stop ${BUNDLE}`);
    device.shell(`bm uninstall -n ${BUNDLE}`);
  } catch {
    // 第一次装
  }
  console.log(device.hdc("install", "-r", HAP).trim().split("\n").at(-1));
  // hilog 默认一种只留 256K，系统日志多，App 的几行很快被挤掉
  device.shell("hilog -G 16M");
  device.shell("hilog -r");
  device.shell(`aa start -a EntryAbility -b ${BUNDLE}`);
  await sleep(3000);

  await run.step("打开测试页：原生桥有 videoFullscreen，回 true", async () => {
    // 扫码连接的测试入口：扫到的地址照样先测 /api/access，连得上才打开
    device.shell(`aa start -a EntryAbility -b ${BUNDLE} --ps ergoTestScanText '${site!.origin}/'`);
    main = await attachWeb((url) => url.startsWith(site!.origin));
    await main.waitFor("window.ergoNative && document.getElementById('land').readyState >= 1 && document.getElementById('port').readyState >= 1", 20_000);
    expectEqual(await main.eval("window.ergoNative.videoFullscreen()"), true, "videoFullscreen()");
    expectEqual(await main.eval("window.ergoNative.appVersion()"), "0.4.5", "App 的版本号");
    expectTrue(!appLandscape(), "开始是竖屏");
    expectEqual(barsVisible(), { status: true, gesture: true }, "开始时状态栏、手势条在");
    await sleep(800);
    run.shot("harmony-01-before");
  });

  await run.step("横视频进全屏：藏状态栏和手势条、常亮、转横屏，黑底铺满", async () => {
    await enterFullscreen(main!, "land");
    await waitUntil("转到横屏", appLandscape);
    await waitUntil("状态栏、手势条藏起来", () => { const b = barsVisible(); return !b.status && !b.gesture; });
    await waitUntil("屏幕常亮", windowKeptOn);
    expectTrue(/video fullscreen entered: 640x360, landscape true/.test(device.appLog()), "App 拿到了视频宽高");
    expectTrue(!/video fullscreen: .* failed/.test(device.appLog()), "窗口设置都没出错（藏系统栏、常亮、转方向）");
    await sleep(1500);
    run.shot("harmony-02-fullscreen-landscape");
  });

  await run.step("返回手势：先退全屏（App 还在前台），方向、状态栏、常亮都恢复", async () => {
    device.shell("uitest uiInput keyEvent Back");
    await main!.waitFor("!document.fullscreenElement", 8000);
    await waitUntil("回到竖屏", () => !appLandscape());
    await waitUntil("状态栏、手势条回来", () => { const b = barsVisible(); return b.status && b.gesture; });
    await waitUntil("不再常亮", () => !windowKeptOn());
    expectTrue(/video fullscreen exited/.test(device.appLog()), "App 恢复了窗口");
    expectTrue(appInFront(), "App 还在前台，没有退出");
    await main!.eval("document.querySelectorAll('video').forEach((v) => v.pause())");
    await sleep(1200);
    run.shot("harmony-03-after-back");
  });

  await run.step("竖视频进全屏：藏系统栏，不转方向；网页自己退全屏（控件上的按钮）也恢复", async () => {
    await enterFullscreen(main!, "port");
    await waitUntil("状态栏、手势条藏起来", () => { const b = barsVisible(); return !b.status && !b.gesture; });
    await waitUntil("屏幕常亮", windowKeptOn);
    await sleep(1500);
    expectTrue(!appLandscape(), "竖视频不转");
    expectTrue(/video fullscreen entered: 360x640, landscape false/.test(device.appLog()), "App 拿到了竖视频的宽高");
    run.shot("harmony-04-fullscreen-portrait");
    await main!.eval("document.exitFullscreen()");
    await waitUntil("状态栏、手势条回来", () => { const b = barsVisible(); return b.status && b.gesture; });
    await waitUntil("不再常亮", () => !windowKeptOn());
  });

  await run.step("全屏时回桌面再回来：已经退出全屏，不留藏着状态栏的半截", async () => {
    await enterFullscreen(main!, "land");
    await waitUntil("转到横屏", appLandscape);
    // 转屏动画还没走完时模拟器不理 Home 键：等一下，按了看 App 真的退到后台了
    await sleep(2500);
    device.shell("uitest uiInput keyEvent Home");
    await waitUntil("App 退到后台", () => /Ability onBackground/.test(device.appLog()));
    expectTrue(/Ability onBackground[\s\S]*video fullscreen exited/.test(device.appLog()), "切到后台时退出了全屏");
    await sleep(1000);
    device.shell(`aa start -a EntryAbility -b ${BUNDLE}`);
    await waitUntil("回到前台", appInFront);
    await main!.waitFor("!document.fullscreenElement", 8000);
    await waitUntil("竖屏", () => !appLandscape());
    await waitUntil("状态栏、手势条在", () => { const b = barsVisible(); return b.status && b.gesture; });
    await waitUntil("不常亮", () => !windowKeptOn());
    await main!.eval("document.querySelectorAll('video').forEach((v) => v.pause())");
    await sleep(1200);
    run.shot("harmony-05-after-background");
  });

  console.log(device.appLog().split("\n").filter((l) => l.includes("video fullscreen")).slice(-12).join("\n"));
  exitCode = run.finish();
} catch (e) {
  console.error("联调中止：", e);
} finally {
  main?.close();
  site?.close();
  try {
    device.hdc("fport", "rm", `tcp:${DEVTOOLS_PORT}`, `localabstract:webview_devtools_remote_${device.pid()}`);
  } catch {
    // 没有这条转发
  }
}
process.exit(exitCode);
