// 安卓 App 在模拟器上的联调（349 号票）。只用模拟器（串口 emulator-*，lib.ts 里卡着），连临时守护进程，绝不碰真机和真的二狗。
// 先有一个开着的模拟器，再：
//   npm run build:android -- --webview-debug
//   node frontend/android/e2e/run.ts emulator-5570 [截图目录]
// 走一遍：地址页 → 配对 → 看到网页 → 深浅色、语言、返回键 → 出错页、"这不是二狗？"。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon, startSite, expectEqual, expectTrue, Run, type TestDaemonHandle } from "./harness.ts";
import { Cdp, Device, PACKAGE, sleep, WebViews } from "./lib.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APK = path.join(HERE, "..", "app", "build", "outputs", "apk", "debug", "app-debug.apk");

/** 网页认出录音全是静音时的提示（模拟器的麦克风没有声音）：说明 PCM 已经交到网页、网页算过了 */
const SILENT_TEXT = (JSON.parse(readFileSync(path.join(HERE, "../../../packages/protocol/locales/zh-CN/app.json"), "utf8").replace(/^\uFEFF/, "")) as Record<string, string>)["app.voiceSession.silent"]!;

const device = new Device(process.argv[2] ?? "emulator-5570");
const run = new Run(device, process.argv[3]);

/** 地址页上填地址、点连接 */
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

/** 网页上点写着这段字的按钮 */
async function clickText(page: Cdp, text: string): Promise<void> {
  await page.waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes(${JSON.stringify(text)}))`);
  await page.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(text)})).click()`);
}

/** 等界面上这段字没了 */
async function waitGone(text: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (device.ui().some((n) => n.text.includes(text))) {
    if (Date.now() > until) throw new Error(`界面上这段字一直在：${text}`);
    await sleep(300);
  }
}

function startApp(): void {
  device.shell(`am start -W -n ${PACKAGE}/.MainActivity`);
}

let daemon: TestDaemonHandle | undefined;
let main: Cdp | undefined;
let exitCode = 1;

try {
  daemon = await startDaemon();
  const notErgoSite = await startSite(() => ({ "/": { type: "text/html", body: "<!doctype html><title>Not Ergo</title><h1>some other site</h1>" } }));
  const externalPort = Number(new URL(daemon.external).port);
  device.reverse(externalPort);
  device.reverse(notErgoSite.port);
  const devices = daemon;

  device.adb("install", "-r", APK);
  device.shell(`pm clear ${PACKAGE}`);
  // 配对后网页会要通知权限（系统框会挡住后面的界面）：先给上，要权限那一步单独测
  device.shell(`pm grant ${PACKAGE} android.permission.POST_NOTIFICATIONS`);
  device.adb("logcat", "-c");
  device.shell("cmd uimode night no");
  startApp();

  console.log("地址页");
  await run.step("第一次打开是地址页，没连上过二狗时是英文", async () => {
    await device.waitText("Enter ergo's address");
    await sleep(1200);
    run.shot("01-address-en-light");
  });
  await run.step("地址填错有提示：不是 https 的外部地址", async () => {
    await submitAddress("http://example.com");
    await device.waitText("It must be an https address");
    run.shot("02-address-error-en-light");
  });

  console.log("出错页");
  await run.step("连不上：出错页，有重试和改地址", async () => {
    await submitAddress("http://127.0.0.1:1/");
    await device.waitText("Can't open ergo");
    await device.waitText("Retry");
    run.shot("03-error-en-light");
  });
  await run.step("出错页点改地址回到地址页", async () => {
    const edit = await device.waitText("Edit address");
    device.tap(edit.x, edit.y);
    await device.waitText("Enter ergo's address");
  });

  console.log("这不是二狗？");
  await run.step("地址填成了别的网站：8 秒后底部提示", async () => {
    await submitAddress(`${notErgoSite.origin}/`);
    await device.waitText("Not ergo?", 25_000);
    run.shot("04-not-ergo-en-light");
  });
  await run.step("这不是二狗？点换地址回到地址页", async () => {
    const change = await device.waitText("Change address");
    device.tap(change.x, change.y);
    await device.waitText("Enter ergo's address");
  });

  console.log("配对");
  await run.step("填对地址：加载二狗的网页，网页认出在 App 里", async () => {
    await submitAddress(`${devices.external}/`);
    const views = await WebViews.connect(device, 9333);
    main = await views.attach((url) => url.startsWith(devices.external));
    await main.waitFor("window.ergoNative && document.getElementById('root') && document.getElementById('root').childElementCount > 0");
    expectEqual(await main.eval("window.ergoNative.appVersion()"), "0.1.0", "App 的版本号");
    expectTrue(await main.eval("typeof window.ergoNative.setColorMode === 'function'"), "原生桥的方法在");
    expectEqual(await main.eval("typeof window.ergoNative.phoneContactsPick"), "undefined", "手机数据源的方法不提供");
    await sleep(1500);
    run.shot("05-pairing-web");
  });
  await run.step("请求配对、批准：领到设备凭证，看到主界面", async () => {
    const page = main!;
    await clickText(page, "请求配对");
    let approved = false;
    for (let i = 0; i < 20 && !approved; i++) {
      devices.send("approve");
      approved = Boolean((await devices.waitLine((l) => "approved" in l)).approved);
      if (!approved) await sleep(500);
    }
    expectTrue(approved, "守护进程收到了配对请求");
    await page.waitFor("fetch('/api/access').then(r => r.json()).then(j => j.access === 'device')", 40_000);
    await page.waitFor("!document.body.innerText.includes('还没配对')", 40_000);
    await sleep(1500);
    run.shot("06-paired-web");
  });

  console.log("外观、语言、返回键");
  await run.step("网页交来语言：地址页跟着二狗的语言（中文）", async () => {
    await main!.eval("window.ergoNative.editServer()");
    await device.waitText("填二狗的地址");
    await device.waitText("取消");
    run.shot("07-address-zh-light");
    device.back();
    await waitGone("填二狗的地址");
  });
  await run.step("外观选深色：状态栏、原生页跟着变，网页的 prefers-color-scheme 也变", async () => {
    await main!.eval("window.ergoNative.setColorMode('dark')");
    await main!.waitFor("matchMedia('(prefers-color-scheme: dark)').matches", 10_000);
    await main!.eval("window.ergoNative.editServer()");
    await device.waitText("填二狗的地址");
    await sleep(500);
    run.shot("08-address-zh-dark");
    device.back();
    await waitGone("填二狗的地址");
    await main!.eval("window.ergoNative.setColorMode('light')");
    await main!.waitFor("!matchMedia('(prefers-color-scheme: dark)').matches", 10_000);
  });
  await run.step("外观跟随系统：系统切深色时网页跟着变", async () => {
    await main!.eval("window.ergoNative.setColorMode('system')");
    device.shell("cmd uimode night yes");
    await main!.waitFor("matchMedia('(prefers-color-scheme: dark)').matches", 15_000);
    device.shell("cmd uimode night no");
    await main!.waitFor("!matchMedia('(prefers-color-scheme: dark)').matches", 15_000);
  });
  await run.step("底部避让区报给网页（物理像素）", async () => {
    const inset = JSON.parse(await main!.eval<string>("window.ergoNative.safeArea()")) as { bottom: number };
    expectTrue(inset.bottom > 0, "底部手势条有高度");
  });
  await run.step("返回键：网页报能返回时交给网页，到顶层退到后台", async () => {
    await main!.eval("window.__e2eBack = 0; window.__ergoBackSaved = window.__ergoBack; window.__ergoBack = function () { window.__e2eBack += 1; return true; }; window.ergoNative.setCanGoBack(true)");
    await sleep(300);
    device.back();
    await main!.waitFor("window.__e2eBack === 1", 5000);
    await main!.eval("window.__ergoBack = window.__ergoBackSaved; window.ergoNative.setCanGoBack(false)");
    await sleep(300);
    device.back();
    await sleep(800);
    expectTrue(!device.shell("dumpsys activity activities").match(/topResumedActivity=.*com.catmaniii.ergo/), "App 退到了后台");
    startApp();
    await sleep(800);
    expectTrue(device.shell("dumpsys activity activities").match(/topResumedActivity=.*com.catmaniii.ergo/), "App 回到前台");
  });
  await run.step("杀掉 App 再开：地址、设备凭证、语言都还在，不用再配对", async () => {
    main!.close();
    device.shell(`am force-stop ${PACKAGE}`);
    await sleep(500);
    startApp();
    const views = await WebViews.connect(device, 9333);
    main = await views.attach((url) => url.startsWith(devices.external));
    await main.waitFor("fetch('/api/access').then(r => r.json()).then(j => j.access === 'device')", 40_000).catch(async (e: Error) => {
      const targets = (await views.targets()).map((t) => t.url).join("、");
      const page = await main!.eval("location.href + ' ' + document.title").catch((err: Error) => err.message);
      const access = await main!.eval("fetch('/api/access').then(r => r.status + ' ' + r.statusText).catch(e => String(e))").catch((err: Error) => err.message);
      throw new Error(`${e.message}（目标：${targets}；页面：${page}；access：${access}）`);
    });
    await main.eval("window.ergoNative.editServer()");
    await device.waitText("填二狗的地址");
    device.back();
    await waitGone("填二狗的地址");
  });
  await run.step("手机数据源的方法不提供，页面上没有报错", async () => {
    await main!.send("Runtime.enable");
    expectEqual(await main!.eval("Object.keys(window.ergoNative).filter(k => k.startsWith('phone'))"), [], "phone 开头的方法");
    expectEqual(await main!.eval("document.querySelectorAll('[data-error-boundary]').length"), 0, "错误边界");
  });
  console.log("按住说话");
  await run.step("麦克风：第一次要权限，系统框上方有说明，给了才备好录音器", async () => {
    device.shell(`pm revoke ${PACKAGE} android.permission.RECORD_AUDIO`);
    await sleep(1500);
    const views = await WebViews.connect(device, 9333);
    main?.close();
    main = await views.attach((url) => url.startsWith(devices.external));
    await main.waitFor("window.ergoNative");
    await main.eval("window.__e2eVoice = window.ergoNative.voicePrepare(false); 1");
    const allow = await device.waitText(/While using the app|仅在使用/);
    await sleep(500);
    run.shot("09-microphone-permission");
    device.tap(allow.x, allow.y);
    const reply = JSON.parse(await main.eval<string>("window.__e2eVoice")) as { ok: boolean; id: number; state: string };
    expectTrue(reply.ok, `备好了 ${JSON.stringify(reply)}`);
    expectEqual(reply.state, "PREPARED", "备好但没开始录");
  });
  await run.step("按下录音、实时音量推给网页、松手交出 16 kHz 单声道的 PCM", async () => {
    await main!.eval("window.__e2eLevels = 0; window.__e2eSaved = window.__ergoVoice; window.__ergoVoice = function (json) { var e = JSON.parse(json); if (e.type === 'level') window.__e2eLevels += 1; if (window.__e2eSaved) window.__e2eSaved(json); }; 1");
    const started = JSON.parse(await main!.eval<string>("window.ergoNative.voiceStart()")) as { ok: boolean };
    expectTrue(started.ok, "开始了");
    await sleep(1500);
    const take = await main!.eval<{ ok: boolean; bytes: number; sampleRate: number; channels: number; bitsPerSample: number; message?: string }>(
      "window.ergoNative.voiceStop().then(function (t) { var r = JSON.parse(t); return { ok: r.ok, bytes: r.pcm ? atob(r.pcm).length : 0, sampleRate: r.sampleRate, channels: r.channels, bitsPerSample: r.bitsPerSample, message: r.message }; })",
    );
    expectTrue(take.ok, `交出来了 ${JSON.stringify(take)}`);
    expectEqual([take.sampleRate, take.channels, take.bitsPerSample], [16000, 1, 16], "格式");
    expectTrue(take.bytes > 16000, `有 1 秒左右的数据（${take.bytes} 字节）`);
    expectTrue((await main!.eval<number>("window.__e2eLevels")) > 3, "录着的时候推了音量");
  });
  await run.step("切到后台放掉录音器，告诉网页 released；回前台再备好", async () => {
    await main!.eval("window.__e2eReleased = ''; window.__ergoVoiceBefore = window.__ergoVoice; window.__ergoVoice = function (json) { var e = JSON.parse(json); if (e.type === 'released') window.__e2eReleased = e.reason; window.__ergoVoiceBefore(json); }; 1");
    device.shell("input keyevent KEYCODE_HOME");
    await sleep(1500);
    startApp();
    await main!.waitFor("window.__e2eReleased === 'background'", 10_000);
    const reply = JSON.parse(await main!.eval<string>("window.ergoNative.voicePrepare(false)")) as { ok: boolean };
    expectTrue(reply.ok, "回前台再备好");
    await main!.eval("window.ergoNative.voiceRelease()");
  });
  await run.step("在网页上真按住说话：原生录音交到网页（模拟器的麦克风是静音，网页认出没声音并提示；真人说话、上传留给真机）", async () => {
    const page = main!;
    // 第一次用的向导盖在上面时先关掉（它和这件事无关）
    await page.eval("(() => { const x = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '×'); if (x) x.click(); })()");
    await page.waitFor("document.querySelector('.voice-toggle')", 20_000);
    const off = await page.eval<boolean>("document.querySelector('.voice-toggle').classList.contains('component-off')");
    expectTrue(!off, "语音组件在（测试底座接的假识别）");
    await page.eval("document.querySelector('.voice-toggle').click()");
    await page.waitFor("document.querySelector('.voice-hold')", 10_000);
    await sleep(800);
    const box = await page.eval<{ x: number; y: number; dpr: number; off: boolean; text: string }>(
      "(() => { const el = document.querySelector('.voice-hold'); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: devicePixelRatio, off: el.classList.contains('voice-hold-off'), text: el.textContent }; })()",
    );
    expectTrue(!box.off, `按住说话可用（${box.text}）`);
    run.shot("10-voice-mode");
    const webTop = device.ui().find((n) => n.className.includes("WebView"))?.top ?? 0;
    device.press(Math.round(box.x * box.dpr), Math.round(box.y * box.dpr) + webTop, 1800);
    await page.waitFor(`document.body.innerText.includes(${JSON.stringify(SILENT_TEXT)})`, 20_000);
    expectTrue(/voice take: [1-9]\d+ bytes/.test(device.appLog()), "App 交出了这一段录音");
    await sleep(800);
    run.shot("11-voice-silent-hint");
  });
  console.log("手机数据源（第一版不做）");
  await run.step("数据源页：手机那几项不报错，只显示说明", async () => {
    const page = main!;
    await page.eval("window.__e2eErrors = []; addEventListener('error', (e) => window.__e2eErrors.push(e.message)); addEventListener('unhandledrejection', (e) => window.__e2eErrors.push(String(e.reason)))");
    await page.eval("location.hash = '#/more/data-sources'");
    await sleep(1500);
    run.shot("15-data-sources");
    for (const id of ["phone-contacts", "phone-calendar", "phone-photos", "phone-location"]) {
      await page.eval(`location.hash = '#/more/data-sources/${id}'`);
      await sleep(1000);
      if (id === "phone-calendar") run.shot("16-data-source-phone-calendar");
    }
    expectEqual(await page.eval("window.__e2eErrors"), [], "页面上的报错");
    expectEqual(await page.eval("Object.keys(window.ergoNative).filter((n) => n.startsWith('phone'))"), [], "原生桥上没有手机数据源的方法");
    await page.eval("location.hash = '#/'");
    await sleep(500);
  });

  console.log("系统通知");
  await run.step("通知权限：网页一开场就要，只问一次；系统框给了之后状态变开着", async () => {
    // 收回已经给的权限，系统会杀掉 App：重开就是第一次问的样子
    main?.close();
    device.shell(`pm revoke ${PACKAGE} android.permission.POST_NOTIFICATIONS`);
    await sleep(800);
    startApp();
    const allow = await device.waitText(/^(Allow|允许)$/, 30_000);
    await sleep(400);
    run.shot("12-notify-permission");
    const views = await WebViews.connect(device, 9333);
    main = await views.attach((url) => url.startsWith(devices.external));
    await main.waitFor("window.ergoNative");
    const before = JSON.parse(await main.eval<string>("window.ergoNative.notifyState()")) as { enabled: boolean; asked: boolean; foreground: boolean };
    expectEqual([before.enabled, before.asked], [false, true], "问的时候：没开、记下问过了");
    device.tap(allow.x, allow.y);
    await main.waitFor("JSON.parse(window.ergoNative.notifyState()).enabled === true", 8000);
    await sleep(500);
    const after = JSON.parse(await main.eval<string>("window.ergoNative.notifyPrepare(false)")) as { enabled: boolean; asked: boolean };
    expectEqual([after.enabled, after.asked], [true, true], "给了之后");
    expectTrue(!device.ui().some((n) => /^(Allow|允许)$/.test(n.text)), "没有再问一次");
  });
  await run.step("在前台不发（页面顶上已经有了），强制的才发", async () => {
    const reply = JSON.parse(await main!.eval<string>("window.ergoNative.notifyShow('n-fg', '标题', '正文', '#/inbox')")) as { result: string };
    expectEqual(reply.result, "foreground", "前台不发");
    const bad = JSON.parse(await main!.eval<string>("window.ergoNative.notifyShow('n-bad', '标题', '正文', 'https://evil.example/')")) as { result: string };
    expectEqual(bad.result, "failed", "页面地址只认 #/ 开头");
  });
  await run.step("切到后台发一条：进通知栏；点它回到 App，网页去了那一页，通知收掉", async () => {
    device.shell("input keyevent KEYCODE_HOME");
    await sleep(1500);
    const reply = JSON.parse(await main!.eval<string>("window.ergoNative.notifyShow('n-1', '二狗的提醒', '该喝水了', '#/tasks')")) as { result: string; number?: number };
    expectEqual(reply.result, "published", "后台发出去了");
    await sleep(800);
    expectTrue(device.shell("dumpsys notification --noredact").includes(`pkg=${PACKAGE}`), "通知栏里有这个 App 的通知");
    device.shell("cmd statusbar expand-notifications");
    const item = await device.waitText("二狗的提醒", 10_000);
    await sleep(500);
    run.shot("13-notification-shade");
    device.tap(item.x, item.y);
    await main!.waitFor("location.hash.startsWith('#/tasks')", 15_000);
    await sleep(800);
    run.shot("14-notification-opened");
    expectEqual(await main!.eval("window.ergoNative.notifyTakeOpen()"), "", "取一次就清掉");
    expectTrue(!device.shell("dumpsys notification --noredact").includes(`id=${reply.number}`), "通知收掉了");
  });
  await run.step("同一件事再发一次：换掉那一条，不出第二条", async () => {
    await main!.eval("location.hash = '#/'");
    device.shell("input keyevent KEYCODE_HOME");
    await sleep(1200);
    await main!.eval("window.ergoNative.notifyShow('n-2', '第一版', '正文', '#/tasks')");
    await main!.eval("window.ergoNative.notifyShow('n-2', '第二版', '正文', '#/tasks')");
    await sleep(600);
    const count = device.shell("dumpsys notification --noredact").split("\n").filter((l) => l.includes(`pkg=${PACKAGE}`) && l.includes("NotificationRecord")).length;
    expectEqual(count, 1, "通知栏里这个 App 的通知数");
    device.shell("cmd notification cancel_all 2>/dev/null; true");
    device.shell("cmd statusbar collapse");
    startApp();
    await sleep(800);
  });
  await run.step("App 没在跑、点通知拉起来：网页开场取到，去了那一页；带来的不是页面地址不认", async () => {
    main!.close();
    device.shell(`am force-stop ${PACKAGE}`);
    await sleep(500);
    device.shell(`am start -W -n ${PACKAGE}/.MainActivity --es ergoNoticeId cold-1 --es ergoNoticeRoute '#/tasks'`);
    let views = await WebViews.connect(device, 9333);
    main = await views.attach((url) => url.startsWith(devices.external));
    await main.waitFor("location.hash.startsWith('#/tasks')", 20_000);
    // 取走了就不再有：页面刷新不会又跳回那一页
    await sleep(800);
    await main.eval("location.hash = '#/'");
    await sleep(500);
    await main.eval("location.reload()").catch(() => undefined);
    await sleep(2500);
    await main.waitFor("window.ergoNative && document.getElementById('root').childElementCount > 0");
    await sleep(800);
    expectTrue(!(await main.eval<string>("location.hash")).startsWith("#/tasks"), "刷新后没有跳回通知那一页");
    expectEqual(await main.eval("window.ergoNative.notifyTakeOpen()"), "", "没有留着的");
    main.close();
    device.shell(`am force-stop ${PACKAGE}`);
    await sleep(500);
    device.shell(`am start -W -n ${PACKAGE}/.MainActivity --es ergoNoticeId bad-1 --es ergoNoticeRoute https://evil.example/`);
    views = await WebViews.connect(device, 9333);
    main = await views.attach((url) => url.startsWith(devices.external));
    await main.waitFor("window.ergoNative");
    await sleep(2500);
    expectTrue(!device.appLog().includes("notification opened: bad-1"), "不认");
    expectEqual(await main.eval("location.origin"), devices.external, "还在二狗的地址");
  });
  console.log("宽屏");
  await run.step("平板尺寸：网页换宽屏布局，地址页不拉满", async () => {
    device.shell("wm size 1600x2560");
    device.shell("wm density 240");
    try {
      await sleep(2500);
      run.shot("17-web-tablet");
      await main!.eval("window.ergoNative.editServer()");
      await device.waitText("填二狗的地址");
      await sleep(500);
      run.shot("18-address-tablet");
      device.back();
      await waitGone("填二狗的地址");
    } finally {
      device.shell("wm size reset");
      device.shell("wm density reset");
    }
    await sleep(2000);
  });
  console.log(await device.appLog().split("\n").slice(-12).join("\n"));
  exitCode = run.finish();
  notErgoSite.close();
} catch (e) {
  console.error("联调中止：", e);
} finally {
  main?.close();
  await daemon?.stop();
}
process.exit(exitCode);
