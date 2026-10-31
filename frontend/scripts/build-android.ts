// `npm run build:android`（349 号票）：把页面桥和 App 原生的字收进 assets，再用工程自带的 gradlew 构建 APK。
// 依赖本机装的 Android Studio（自带的 JDK）和 SDK，所以不进 `npm run check`。第一次构建 Gradle 从官方源下 Android 构建插件和 AndroidX 库。
// 调试版用调试签名；正式签名的材料只在本机（frontend/android/keystore.properties，不进仓库）。
// WebView 调试默认关，`npm run build:android -- --webview-debug` 才开（开着的 App 接上 USB 就能被取走设备凭证）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildPageBridge } from "../../packages/web/build/page-bridge.ts";
import { ANDROID_ASSETS_DIR, ANDROID_DIR, apkOutputs, findAndroidTools, gradleArgs, parseAndroidArgs } from "./android.ts";
import { HARMONY_TEXTS_FILE, harmonyTexts, LOCALES_DIR } from "./harmony.ts";

const options = parseAndroidArgs(process.argv.slice(2));
if ("error" in options) {
  console.error(options.error);
  process.exit(1);
}

const tools = findAndroidTools(process.env, process.platform);
if ("error" in tools) {
  console.error(tools.error);
  process.exit(1);
}

// 页面桥：每次构建现打包（不进仓库），和鸿蒙 App 是同一份
mkdirSync(ANDROID_ASSETS_DIR, { recursive: true });
const pageBridge = await buildPageBridge();
writeFileSync(path.join(ANDROID_ASSETS_DIR, "page-bridge.js"), pageBridge);
console.log(`页面桥：app/src/main/assets/page-bridge.js（${(pageBridge.length / 1024).toFixed(1)} KB）`);

// App 原生的字：和鸿蒙 App 同一份语言文件（共享协议包 locales/<语言>/harmony.json）
const texts = harmonyTexts(LOCALES_DIR);
writeFileSync(path.join(ANDROID_ASSETS_DIR, HARMONY_TEXTS_FILE), JSON.stringify(texts));
console.log(`App 原生的字：app/src/main/assets/${HARMONY_TEXTS_FILE}（${Object.keys(texts).join("、")}）`);

if (options.webviewDebug) {
  console.warn("注意：这次构建打开了 WebView 调试。装了这个包的手机接上 USB，任何能跑 adb 的人都能经 DevTools 看到页面、取走设备凭证 cookie；调试完换回不带 --webview-debug 构建的包。");
}
const env = { ...process.env, JAVA_HOME: tools.javaHome, ANDROID_HOME: tools.sdk };
const gradlew = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
console.log(`gradle（JDK ${tools.javaHome}，SDK ${tools.sdk}）：${gradleArgs(options).join(" ")}`);
const run = spawnSync(gradlew, gradleArgs(options), { cwd: ANDROID_DIR, env, stdio: "inherit", shell: process.platform === "win32" });
if (run.error) {
  console.error(`跑不起来 gradle：${run.error.message}`);
  process.exit(1);
}
if (run.status !== 0) {
  console.error(`gradle 失败，退出码 ${run.status}`);
  process.exit(run.status ?? 1);
}

const apk = apkOutputs(ANDROID_DIR, options).find((file) => existsSync(file));
if (!apk) {
  console.error(`gradle 说成功了，但没找到 APK（${path.dirname(apkOutputs(ANDROID_DIR, options)[0]!)}）`);
  process.exit(1);
}
console.log(`\nAPK：${apk}（${(statSync(apk).size / 1024 / 1024).toFixed(1)} MB）`);
console.log("装到手机或模拟器：adb -s <设备> install -r <上面的路径>；启动：adb -s <设备> shell am start -n com.catmaniii.ergo/.MainActivity");
