// 网页视频真全屏（票 407）在安卓模拟器上的联调。只用模拟器（串口 emulator-*，lib.ts 里卡着），不连真的二狗：
// App 的地址填成本机起的一个小网站（video-site.ts：两段 <video controls>，/api/access 回得像二狗），原生桥照样只开给这个来源。
// 要 ffmpeg（现生成测试视频）。先有一个开着的模拟器，再：
//   npm run build:android -- --webview-debug
//   node frontend/android/e2e/video-fullscreen.ts emulator-5570 [截图目录]
// 走一遍：原生桥有 videoFullscreen → 横视频进全屏：状态栏导航条藏了、转横屏、常亮 → 返回键先退全屏（App 还在前台）、都恢复 →
// 竖视频进全屏不转 → 网页自己退全屏 → 全屏时回桌面再回来：已经退出、不留藏着状态栏的半截。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectEqual, expectTrue, Run } from "./harness.ts";
import { type Cdp, Device, PACKAGE, sleep, WebViews } from "./lib.ts";
import { enterFullscreenScript, startVideoSite, type VideoSite } from "./video-site.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APK = path.join(HERE, "..", "app", "build", "outputs", "apk", "debug", "app-debug.apk");

const device = new Device(process.argv[2] ?? "emulator-5570");
const run = new Run(device, process.argv[3]);

/** 地址页上填地址、点连接（和 run.ts 一样） */
async function submitAddress(address: string): Promise<void> {
  const input = device.ui().find((n) => n.className.includes("EditText"));
  if (!input) throw new Error("地址页上找不到输入框");
  device.tap(input.x, input.y);
  await sleep(600);
  device.shell("input keycombination 113 29 && input keyevent 67");
  device.type(address);
  await sleep(400);
  device.shell("input keyevent 66");
}

/** 屏幕现在转了多少度（0 竖屏，90、270 横屏） */
function rotation(): number {
  const line = /mCurrentRotation=ROTATION_(\d+)/.exec(device.shell("dumpsys window"));
  return line ? Number(line[1]) : -1;
}

const landscapeNow = () => [90, 270].includes(rotation());

/** 系统栏现在显示着没有（窗口管理的 InsetsSource）、App 的窗口开没开常亮 */
function windowState(): { barsVisible: boolean; keepScreenOn: boolean } {
  const all = device.shell("dumpsys window");
  const visible = (type: string) => new RegExp(`InsetsSource id=\\S+ type=${type} [^\\n]*visible=true`).test(all);
  const windows = device.shell("dumpsys window windows");
  const own = windows.split(/\n(?=\s*Window #)/).find((block) => block.includes(`${PACKAGE}/${PACKAGE}.MainActivity`)) ?? "";
  return { barsVisible: visible("statusBars") && visible("navigationBars"), keepScreenOn: /\bfl=[^\n]*KEEP_SCREEN_ON/.test(own) };
}

async function waitUntil(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`等不到：${what}`);
    await sleep(300);
  }
}

/** 像用户点了全屏按钮一样（带用户手势）让一段视频进全屏、开始放 */
async function enterFullscreen(page: Cdp, id: string): Promise<void> {
  await page.send("Runtime.evaluate", {
    expression: enterFullscreenScript(id),
    userGesture: true,
    awaitPromise: true,
  });
  await page.waitFor("!!document.fullscreenElement", 8000);
}

function appInFront(): boolean {
  return /topResumedActivity=.*com\.catmaniii\.ergo/.test(device.shell("dumpsys activity activities"));
}

/**
 * 窗口上的常亮标志是几处合起来的：App 加的（全屏时）、WebView 放视频时自己加的、还有 DevTools 连着时 WebView 也加。
 * 要看 App 加的那个：先停掉页面里的视频，断开 DevTools 再看，看完重新连上
 */
async function keptOnByApp(): Promise<boolean> {
  await main!.eval("document.querySelectorAll('video').forEach((v) => v.pause())");
  main!.close();
  await sleep(1500);
  const on = windowState().keepScreenOn;
  main = await views!.attach((url) => url.startsWith(site!.origin));
  return on;
}

let views: WebViews | undefined;

/**
 * 联调前把模拟器摆成平常的样子：
 * - 一个 App 第一次藏系统栏时，安卓自己弹一次"Viewing full screen / 从顶部往下滑退出"的说明（系统窗口，点"Got it"之后不再弹）。
 *   它开着时返回键、Home 键都先给它（真机上用户第一次全屏会看到一次，正常）。联调先当作已经点过；
 * - 屏幕自动旋转关着（用户锁了竖屏）：横视频照样要转，SENSOR_LANDSCAPE 不看这个开关；锁定的方向回到竖屏。
 * 注意：横屏时别跑 uiautomator dump（device.ui()）——它会把系统锁定的方向改成当时的横屏，退出全屏后就转不回来了（测试工具的副作用，不是 App 的）
 */
async function prepareDevice(): Promise<void> {
  device.shell("settings put secure immersive_mode_confirmations confirmed");
  device.shell("settings put system accelerometer_rotation 0");
  device.shell("settings put system user_rotation 0");
  await waitUntil("模拟器转回竖屏", () => rotation() === 0, 15_000);
}

let main: Cdp | undefined;
let exitCode = 1;
let site: VideoSite | undefined;

try {
  site = await startVideoSite();
  device.reverse(site.port);

  device.adb("install", "-r", APK);
  device.shell(`pm clear ${PACKAGE}`);
  device.shell(`pm grant ${PACKAGE} android.permission.POST_NOTIFICATIONS`);
  await prepareDevice();
  device.shell("cmd uimode night no");
  device.adb("logcat", "-c");
  device.shell(`am start -W -n ${PACKAGE}/.MainActivity`);

  await run.step("打开测试页：原生桥有 videoFullscreen，回 true", async () => {
    await device.waitText("Enter ergo's address");
    await submitAddress(`${site!.origin}/`);
    views = await WebViews.connect(device, 9334);
    main = await views.attach((url) => url.startsWith(site!.origin));
    await main.waitFor("window.ergoNative && document.getElementById('land').readyState >= 1 && document.getElementById('port').readyState >= 1", 20_000);
    expectEqual(await main.eval("window.ergoNative.videoFullscreen()"), true, "videoFullscreen()");
    expectEqual(await main.eval("window.ergoNative.appVersion()"), "0.4.4", "App 的版本号");
    expectEqual(rotation(), 0, "开始是竖屏");
    expectTrue(windowState().barsVisible, "开始时状态栏、导航条在");
    await sleep(800);
    run.shot("android-01-before");
  });

  await run.step("横视频进全屏：藏状态栏和导航条、常亮、转横屏，黑底铺满", async () => {
    await enterFullscreen(main!, "land");
    await waitUntil("转到横屏", landscapeNow);
    await waitUntil("状态栏、导航条藏起来", () => !windowState().barsVisible);
    expectTrue(/video fullscreen: Video\(width=640, height=360\), landscape true/.test(device.appLog()), "App 读到了视频宽高");
    await sleep(1500);
    run.shot("android-02-fullscreen-landscape");
    // 停了视频、断开 DevTools（全屏还开着）还亮，才是 App 加的
    expectTrue(await keptOnByApp(), "全屏时屏幕常亮");
    expectTrue(await main!.eval("!!document.fullscreenElement"), "看常亮的时候全屏还开着");
  });

  await run.step("返回键：先退全屏（App 还在前台），方向、状态栏、常亮都恢复", async () => {
    device.back();
    await main!.waitFor("!document.fullscreenElement", 8000);
    await waitUntil("回到竖屏", () => rotation() === 0);
    await waitUntil("状态栏、导航条回来", () => windowState().barsVisible);
    expectTrue(!(await keptOnByApp()), "不再常亮");
    expectTrue(appInFront(), "App 还在前台，没有退到后台");
    await sleep(1200);
    run.shot("android-03-after-back");
  });

  await run.step("竖视频进全屏：藏系统栏，不转方向；网页自己退全屏（控件上的按钮）也恢复", async () => {
    await enterFullscreen(main!, "port");
    await waitUntil("状态栏、导航条藏起来", () => !windowState().barsVisible);
    await sleep(1500);
    expectEqual(rotation(), 0, "竖视频不转");
    expectTrue(/video fullscreen: Video\(width=360, height=640\), landscape false/.test(device.appLog()), "App 读到了竖视频的宽高");
    run.shot("android-04-fullscreen-portrait");
    await main!.eval("document.exitFullscreen()");
    await waitUntil("状态栏、导航条回来", () => windowState().barsVisible);
    expectTrue(!(await keptOnByApp()), "不再常亮");
  });

  await run.step("全屏时回桌面再回来：已经退出全屏，不留藏着状态栏的半截", async () => {
    await enterFullscreen(main!, "land");
    await waitUntil("转到横屏", landscapeNow);
    device.shell("input keyevent KEYCODE_HOME");
    await sleep(1500);
    device.shell(`am start -W -n ${PACKAGE}/.MainActivity`);
    await waitUntil("回到前台", () => appInFront());
    await main!.waitFor("!document.fullscreenElement", 8000);
    await waitUntil("竖屏", () => rotation() === 0);
    await waitUntil("状态栏、导航条在", () => windowState().barsVisible);
    expectTrue(!(await keptOnByApp()), "不再常亮");
    await sleep(1200);
    run.shot("android-05-after-background");
  });

  console.log(device.appLog().split("\n").filter((l) => l.includes("video fullscreen")).slice(-12).join("\n"));
  exitCode = run.finish();
} catch (e) {
  console.error("联调中止：", e);
} finally {
  main?.close();
  site?.close();
  try {
    device.adb("reverse", "--remove-all");
    device.adb("forward", "--remove-all");
    device.shell("settings put system user_rotation 0");
  } catch {
    // 模拟器已经关了
  }
}
process.exit(exitCode);
