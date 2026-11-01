// 安卓 App（349 号票）的契约：原生桥的方法名和网页一侧对得上，外部网页碰不到原生桥的那几条写法没被改掉，
// 句子都在语言文件里，签名材料和生成的东西不进仓库，构建脚本的辅助。
// 真正在 WebView 里证明"外部页面调不到 ergoNative"的是模拟器联调 frontend/android/e2e/run.ts（要模拟器，不在这里跑）。
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { apkOutputs, findAndroidTools, gradleArgs, parseAndroidArgs } from "../scripts/android.ts";
import { harmonyTexts, LOCALES_DIR } from "../scripts/harmony.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SRC = path.join(REPO, "frontend/android/app/src/main");
const KOTLIN_DIR = path.join(SRC, "java/com/catmaniii/ergo");

function kotlinFiles(dir: string = KOTLIN_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? kotlinFiles(full) : entry.name.endsWith(".kt") ? [full] : [];
  });
}

/** 读文本，行尾统一成 LF：Windows 上 autocrlf 的工作区是 CRLF，下面的检查按行比 */
const read = (file: string) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const kotlin = (file: string) => read(path.join(KOTLIN_DIR, file));
const allKotlin = () => kotlinFiles().map((file) => ({ file: path.relative(KOTLIN_DIR, file), text: read(file) }));
const shim = () => read(path.join(SRC, "assets/ergo-native-shim.js"));

/** NativeBridge.kt 里一个方法表的名字 */
function bridgeList(name: string): string[] {
  const match = new RegExp(`val ${name} = (?:listOf\\(([^)]*)\\)|emptyList<String>\\(\\))`).exec(kotlin("bridge/NativeBridge.kt"));
  if (!match) throw new Error(`NativeBridge.kt 里没有 ${name}`);
  return (match[1] ?? "").match(/"[A-Za-z.]+"/g)?.map((n) => n.slice(1, -1)) ?? [];
}

const mainMethods = () => [...bridgeList("NATIVE_BRIDGE_MIRROR_METHODS"), ...bridgeList("NATIVE_BRIDGE_FIRE_METHODS"), ...bridgeList("NATIVE_BRIDGE_PROMISE_METHODS")];

/** 能渲染文件的扩展名表 */
const words = (text: string) => /RENDER_EXTENSIONS[^=]*= \(?\s*([\s\S]*?)\)?\s*\.?split/.exec(text)![1]!.replace(/['"+\s]+/g, " ").trim().split(" ");

/** 页面桥的操作表 */
const opsOf = (text: string) => /PAGE_OPS[^=]*= (?:listOf\(|\[)([^\])]*)/.exec(text)![1]!.match(/['"][A-Za-z]+['"]/g)!.map((n) => n.slice(1, -1));

/** 网页一侧一个方法表的名字 */
const webGroup = (file: string, name: string) => new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(read(path.join(REPO, "packages/web/src/app", file)))![1]!.match(/"[A-Za-z]+"/g)!.map((n) => n.slice(1, -1));

describe("原生桥的方法名和网页一侧一样", () => {
  test("基础那一组都开着、都有处理；同步回值的（镜像）垫片里都有实现", () => {
    const main = mainMethods();
    for (const name of ["appVersion", "log", "editServer", "setColorMode", "setCanGoBack", "safeArea", "setTexts"]) expect(main).toContain(name);
    const nativeApp = read(path.join(REPO, "packages/web/src/app/native-app.ts"));
    for (const name of ["appVersion", "log", "editServer", "setColorMode", "setCanGoBack", "safeArea", "setTexts"]) expect(nativeApp).toContain(`"${name}"`);
    const bridge = kotlin("bridge/NativeBridge.kt");
    for (const name of main) expect(bridge).toContain(`"${name}"`);
    for (const name of bridgeList("NATIVE_BRIDGE_MIRROR_METHODS")) expect(shim()).toMatch(new RegExp(`\\b${name}: function`));
  });

  test("录音这一组（NATIVE_VOICE_METHODS）都开着：要等结果的三个回 Promise，另外两个不要结果", () => {
    const names = webGroup("native-voice.ts", "NATIVE_VOICE_METHODS");
    expect(names).toEqual(["voicePrepare", "voiceStart", "voiceStop", "voiceDiscard", "voiceRelease"]);
    for (const name of names) expect(mainMethods()).toContain(name);
    for (const name of ["voicePrepare", "voiceStart", "voiceStop"]) expect(bridgeList("NATIVE_BRIDGE_PROMISE_METHODS")).toContain(name);
  });

  test("浏览器、页面桥、放掉预备文件、能渲染的文件、⋮ 菜单这几组都开着；页面桥的操作和鸿蒙一样", () => {
    const web = read(path.join(REPO, "packages/web/src/app/native-browser.ts"));
    const names = [...webGroup("native-browser.ts", "NATIVE_BROWSER_METHODS"), ...webGroup("native-browser.ts", "NATIVE_PAGE_METHODS")];
    expect(names).toEqual(["browserAttach", "browserLayout", "browserLoad", "browserNav", "browserPage", "browserFileChunk", "browserFiles", "browserChooser"]);
    for (const constant of ["NATIVE_DISCARD_METHOD", "NATIVE_DOC_METHOD", "NATIVE_TOOL_METHOD"]) names.push(new RegExp(`${constant} = "([A-Za-z]+)"`).exec(web)![1]!);
    for (const name of names) expect(mainMethods()).toContain(name);
    const harmony = read(path.join(REPO, "frontend/harmony/entry/src/main/ets/browser/PageControl.ets"));
    expect(opsOf(kotlin("browser/PageControl.kt"))).toEqual(opsOf(harmony));
  });

  test("能渲染文件的扩展名和鸿蒙一样（网页一侧的测试核对鸿蒙那份）", () => {
    expect(words(kotlin("browser/FileDocs.kt"))).toEqual(words(read(path.join(REPO, "frontend/harmony/entry/src/main/ets/browser/FileDocs.ets"))));
  });

  test("侧边栏：主界面开着 browserSide；侧边栏那份原生桥和鸿蒙的 NATIVE_SIDE_BRIDGE_METHODS 一样，没有浏览器、地址页、通知这些", () => {
    const web = read(path.join(REPO, "packages/web/src/app/native-browser.ts"));
    expect(mainMethods()).toContain(/NATIVE_SIDE_METHOD = "([A-Za-z]+)"/.exec(web)![1]!);
    const side = [...bridgeList("NATIVE_SIDE_MIRROR_METHODS"), ...bridgeList("NATIVE_SIDE_FIRE_METHODS"), ...bridgeList("NATIVE_SIDE_PROMISE_METHODS")];
    const harmony = read(path.join(REPO, "frontend/harmony/entry/src/main/ets/bridge/NativeBridge.ets"));
    const expected = /NATIVE_SIDE_BRIDGE_METHODS: string\[\] = \[([^\]]*)\]/.exec(harmony)![1]!.match(/'[A-Za-z]+'/g)!.map((n) => n.slice(1, -1));
    expect(side.toSorted()).toEqual(expected.toSorted());
    // window.ergoSide 的三个方法和鸿蒙 SidePanel.ets 一样
    const panel = read(path.join(REPO, "frontend/harmony/entry/src/main/ets/browser/SidePanel.ets"));
    const hostMethods = /SIDE_HOST_METHODS: string\[\] = \[([^\]]*)\]/.exec(panel)![1]!.match(/'[A-Za-z]+'/g)!.map((n) => n.slice(1, -1));
    expect(bridgeList("SIDE_HOST_MESSAGES").map((n) => n.replace("side.", "")).toSorted()).toEqual(hostMethods.toSorted());
    for (const name of hostMethods) expect(shim()).toContain(`post('side.${name}')`);
  });

  test("通知这一组（NATIVE_NOTIFY_METHODS）都开着，新版 App 才有的 notifyResetAsked 也有；同步回值的走镜像，发通知、要授权回 Promise", () => {
    const names = webGroup("native-notify.ts", "NATIVE_NOTIFY_METHODS");
    expect(names).toEqual(["notifyState", "notifyPrepare", "notifyShow", "notifyTakeOpen"]);
    for (const name of [...names, "notifyResetAsked"]) expect(mainMethods()).toContain(name);
    for (const name of ["notifyState", "notifyTakeOpen", "notifyResetAsked"]) expect(bridgeList("NATIVE_BRIDGE_MIRROR_METHODS")).toContain(name);
    for (const name of ["notifyPrepare", "notifyShow"]) expect(bridgeList("NATIVE_BRIDGE_PROMISE_METHODS")).toContain(name);
  });

  test("和鸿蒙的方法表比：除了第一版不做的手机数据源，一个不少", () => {
    const harmony = read(path.join(REPO, "frontend/harmony/entry/src/main/ets/bridge/NativeBridge.ets"));
    const all = /NATIVE_BRIDGE_METHODS: string\[\] = \[([^\]]*)\]/.exec(harmony)![1]!.match(/'[A-Za-z]+'/g)!.map((n) => n.slice(1, -1));
    expect(all.filter((name) => !name.startsWith("phone")).toSorted()).toEqual(mainMethods().toSorted());
  });

  test("第一版不开手机数据源（票里定的）：一个 phone 开头的方法都没有，网页认不出这一组，功能自然不出现", () => {
    expect(mainMethods().filter((name) => name.startsWith("phone"))).toEqual([]);
  });
});

describe("外部网页碰不到原生桥（安全要求）", () => {
  test("整个 App 不用 addJavascriptInterface：那个对象所有页面和框架都看得见", () => {
    const hits = allKotlin().filter((f) => /addJavascriptInterface\s*\(/.test(f.text)).map((f) => f.file);
    expect(hits).toEqual([]);
  });

  test("通道和垫片都只对配好的来源：白名单是 setOf(origin)，每条消息再核对来源和主框架", () => {
    const channel = kotlin("bridge/BridgeChannel.kt");
    expect(channel).toMatch(/addWebMessageListener\(webView, CHANNEL_NAME, setOf\(origin\)\)/);
    expect(channel).toMatch(/addDocumentStartJavaScript\(webView, [^\n]*, setOf\(origin\)\)/);
    expect(channel).toMatch(/source != origin \|\| !isMainFrame/);
  });

  test("垫片只装进主框架，App 只能调名单里的网页函数", () => {
    expect(shim()).toContain("window.top !== window");
    expect(shim()).toContain("PAGE_FUNCTIONS");
    expect(shim()).toMatch(/hasOwnProperty\.call\(PAGE_FUNCTIONS, message\.f\)/);
  });

  test("系统的 WebView 太旧时不退回不安全的办法：直接告诉用户升级", () => {
    expect(kotlin("MainActivity.kt")).toMatch(/!webViewSupportsBridge\(\)[\s\S]{0,200}harmony\.android\.webViewTooOld/);
  });

  test("内置浏览器不挂原生桥：浏览器的 WebView 上只有页面桥的通道，页面桥的话要带口令、来自主框架", () => {
    const main = kotlin("MainActivity.kt");
    const createBrowser = /private fun createBrowserWeb\(\): WebView \{[\s\S]*?\n    \}\n/.exec(main)![0];
    expect(createBrowser).not.toContain("BridgeChannel");
    expect(createBrowser).not.toContain("addWebMessageListener");
    expect(createBrowser).toContain("pageControl.install(web)");
    const page = kotlin("browser/PageControl.kt");
    expect(page).toMatch(/message\.optString\("nonce"\) != nonce/);
    expect(page).toMatch(/if \(!isMainFrame\)/);
    // 下载自己发请求：不自动跟重定向（免得把凭证带到别的网站），外部网页发起的下载不带二狗的凭证
    const downloads = kotlin("download/WebDownloads.kt");
    expect(downloads).toContain("instanceFollowRedirects = false");
    expect(downloads).toMatch(/cookieAllowed\(target, request\.initiator, serverOrigin\(\)\)/);
  });

  test("证书错误不放行；关掉文件访问、混合内容；不备份凭证", () => {
    const hits = allKotlin().filter((f) => /\.proceed\(/.test(f.text)).map((f) => f.file);
    expect(hits).toEqual([]);
    const main = kotlin("MainActivity.kt");
    expect(main).toMatch(/handler\.cancel\(\)/);
    expect(main).toContain("allowFileAccess = false");
    expect(main).toContain("allowContentAccess = false");
    expect(main).toContain("allowFileAccessFromFileURLs = false");
    expect(main).toContain("allowUniversalAccessFromFileURLs = false");
    expect(main).toContain("MIXED_CONTENT_NEVER_ALLOW");
    const manifest = read(path.join(SRC, "AndroidManifest.xml"));
    expect(manifest).toContain('android:allowBackup="false"');
    // 只信系统证书，不信用户装的
    const security = read(path.join(SRC, "res/xml/network_security.xml"));
    expect(security).toContain('src="system"');
    expect(security).not.toContain('src="user"');
  });

  test("WebView 调试默认关：只有构建时要了才开", () => {
    expect(kotlin("MainActivity.kt")).toContain("WebView.setWebContentsDebuggingEnabled(BuildConfig.WEBVIEW_DEBUG)");
    expect(parseAndroidArgs([])).toEqual({ webviewDebug: false, release: false });
    expect(gradleArgs({ webviewDebug: false, release: false })).toContain("-PwebviewDebug=false");
  });
});

describe("用户看到的字都在语言文件里", () => {
  test("代码里用到的 harmony.* 句子中英文都有", () => {
    const texts = harmonyTexts(LOCALES_DIR);
    const used = new Set(allKotlin().flatMap((f) => f.text.match(/"harmony\.[A-Za-z.]+"/g) ?? []).map((key) => key.slice(1, -1)));
    expect(used.size).toBeGreaterThan(10);
    const missing = [...used].filter((key) => !texts["zh-CN"]![key] || !texts.en![key]);
    expect(missing).toEqual([]);
  });

  test("安卓的代码里不写死中文句子（注释除外）", () => {
    const offenders = allKotlin().flatMap((f) =>
      f.text
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, "").replace(/^\s*\/?\*.*$/, "").replace(/\/\*\*.*?\*\//g, ""))
        .filter((line) => /"[^"]*[\u4e00-\u9fff][^"]*"/.test(line))
        .map((line) => `${f.file}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("不进仓库的东西", () => {
  test.each([
    "frontend/android/local.properties",
    "frontend/android/keystore.properties",
    "frontend/android/release.jks",
    "frontend/android/x.keystore",
    "frontend/android/build/x",
    "frontend/android/app/build/outputs/apk/debug/app-debug.apk",
    "frontend/android/.gradle/x",
    "frontend/android/.gradle-home/x",
    "frontend/android/app/src/main/assets/page-bridge.js",
    "frontend/android/app/src/main/assets/harmony-texts.json",
  ])("%s 被忽略", (file) => {
    expect(spawnSync("git", ["check-ignore", "-q", "--no-index", file], { cwd: REPO }).status).toBe(0);
  });

  test("垫片是源码，进仓库", () => {
    expect(spawnSync("git", ["check-ignore", "-q", "--no-index", "frontend/android/app/src/main/assets/ergo-native-shim.js"], { cwd: REPO }).status).toBe(1);
  });
});

/** 假的文件系统：只有这几个文件在 */
const exists = (...files: string[]) => (file: string) => files.includes(file);

describe("构建辅助", () => {
  const JBR = "C:\\Program Files\\Android\\Android Studio\\jbr";
  const SDK = "C:\\Users\\me\\AppData\\Local\\Android\\Sdk";

  test("默认找 Android Studio 自带的 JDK（JAVA_HOME 可能是 JDK 11）和本机的 SDK", () => {
    const tools = findAndroidTools({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", JAVA_HOME: "C:\\jdk-11" }, "win32", exists(`${JBR}\\bin\\java.exe`, "C:\\jdk-11\\bin\\java.exe", `${SDK}\\platforms`));
    expect(tools).toEqual({ javaHome: JBR, sdk: SDK });
  });

  test("环境变量能指定", () => {
    const tools = findAndroidTools({ ERGO_ANDROID_JDK: "D:\\jdk21", ANDROID_HOME: "D:\\sdk" }, "win32", exists("D:\\jdk21\\bin\\java.exe", `${JBR}\\bin\\java.exe`, "D:\\sdk\\platforms"));
    expect(tools).toEqual({ javaHome: "D:\\jdk21", sdk: "D:\\sdk" });
  });

  test("哪儿都没有：说清楚看过哪些位置、怎么办", () => {
    const noJdk = findAndroidTools({}, "win32", () => false);
    expect(noJdk).toEqual({ error: expect.stringContaining("ERGO_ANDROID_JDK") });
    const noSdk = findAndroidTools({ ANDROID_HOME: "D:\\nowhere" }, "win32", exists(`${JBR}\\bin\\java.exe`));
    expect(noSdk).toEqual({ error: expect.stringContaining("D:\\nowhere") });
  });

  test("调试签名的包默认不可调试：系统对可调试的 App 一律开着 WebView 调试，手册让用户装的就是它", () => {
    const gradle = read(path.join(REPO, "frontend/android/app/build.gradle.kts"));
    expect(gradle).toMatch(/debug \{[^}]*isDebuggable = webviewDebug/);
    expect(gradle).not.toMatch(/isDebuggable = true/);
  });

  test("参数：--webview-debug、--release 要显式给，拼错报错", () => {
    expect(parseAndroidArgs(["--webview-debug"])).toEqual({ webviewDebug: true, release: false });
    expect(gradleArgs({ webviewDebug: true, release: false })).toEqual(["assembleDebug", "-PwebviewDebug=true", "--console=plain"]);
    expect(gradleArgs({ webviewDebug: false, release: true })[0]).toBe("assembleRelease");
    expect(parseAndroidArgs(["--webview-debgu"])).toEqual({ error: expect.stringContaining("--webview-debgu") });
  });

  test("APK 在哪：调试版一个，release 有签名和没签名两种", () => {
    expect(apkOutputs("/a", { release: false })[0]).toContain("app-debug.apk");
    expect(apkOutputs("/a", { release: true }).map((p) => path.basename(p))).toEqual(["app-release.apk", "app-release-unsigned.apk"]);
  });
});

const harmonyElementFiles = () => read(path.join(REPO, "frontend/harmony/entry/src/main/ets/browser/ElementFiles.ets"));
const webBrowser = () => read(path.join(REPO, "packages/web/src/app/native-browser.ts"));
const webElementOps = () => [...webBrowser().matchAll(/ask\("(element[A-Za-z]+)"/g)].map((m) => m[1]!).toSorted();

describe("长按元素的圆钮（359 号票）：两个 App 和网页对得上", () => {
  test("browserTool 里 element 开头的操作：网页发的、安卓认的、鸿蒙认的一样", () => {
    expect(webElementOps()).toEqual(["elementDownload", "elementDrop", "elementFetch", "elementRead", "elementSave", "elementShot", "elementWrite"]);
    expect([...kotlin("browser/ElementFiles.kt").matchAll(/"(element[A-Za-z]+)" ->/g)].map((m) => m[1]!).toSorted()).toEqual(webElementOps());
    expect([...harmonyElementFiles().matchAll(/op === '(element[A-Za-z]+)'/g)].map((m) => m[1]!).toSorted()).toEqual(webElementOps());
    expect(kotlin("MainActivity.kt")).toContain('if (op.startsWith("element")) elementFiles.run(op, json, reply)');
    expect(read(path.join(REPO, "frontend/harmony/entry/src/main/ets/pages/Index.ets"))).toContain("op.startsWith('element') ? this.elementFiles.run(op, json)");
  });

  test("页面桥的操作：网页调的都在 App 的白名单里", () => {
    const pageOps = [...webBrowser().matchAll(/ask\("browserPage", "(element[A-Za-z]+)"/g)].map((m) => m[1]!).toSorted();
    expect(pageOps).toEqual(["elementChunk", "elementInfo", "elementPrepare", "elementRect", "elementShotDone"]);
    const ops = /val PAGE_OPS = listOf\(([^)]*)\)/.exec(kotlin("browser/PageControl.kt"))![1]!;
    for (const op of pageOps) expect(ops).toContain(`"${op}"`);
  });

  test("自己发请求的安全写法：不自动跟重定向，每一跳重新算 cookie 和来源页，二狗的设备凭证只给二狗自己的页面", () => {
    const k = kotlin("browser/ElementFiles.kt");
    expect(k).toContain("connection.instanceFollowRedirects = false");
    expect(k).toContain("if (cookieAllowed(target, page, server))");
    expect(k).toContain("refererFor(page, target)");
    const h = harmonyElementFiles();
    expect(h).toContain("maxRedirects: 0");
    expect(h).toContain("if (cookieAllowed(target, page, this.serverOrigin()))");
    expect(h).toContain("const referer = refererFor(page, target)");
  });

  test("存走下载那条路：弹保存到、进下载记录（安卓、鸿蒙都不另开一条）", () => {
    expect(kotlin("MainActivity.kt")).toContain("browserDownloads.saveFile(file, name, false, mime)");
    expect(read(path.join(REPO, "frontend/harmony/entry/src/main/ets/pages/Index.ets"))).toContain("this.browserDownloads.saveFile(path, name, false, mime)");
  });
  test("状态栏只让一次：外层让开之后不把避让区传给 WebView，否则网页的 env(safe-area-inset-top) 再让一遍，顶上多一大条空白", () => {
    const source = kotlin("MainActivity.kt");
    const watch = source.slice(source.indexOf("private fun watchInsets"), source.indexOf("private fun pushInsets"));
    expect(watch).toContain("content.setPadding(bars.left, bars.top, bars.right, ime.bottom)");
    expect(watch).toContain("WindowInsetsCompat.CONSUMED");
  });
});
