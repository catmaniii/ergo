// 安卓 App 的构建辅助（349 号票）：找 Android Studio 自带的 JDK、SDK，认出参数。`build-android.ts` 用它构建，
// `frontend/test/android.test.ts` 测它。
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 安卓工程的目录 */
export const ANDROID_DIR = fileURLToPath(new URL("../android/", import.meta.url));

/** 页面桥、App 原生的字收进这里（不进仓库） */
export const ANDROID_ASSETS_DIR = path.join(ANDROID_DIR, "app", "src", "main", "assets");

/** 没设 JAVA_HOME 时依次找这几个 JDK（Android Studio 自带的 JBR） */
export const DEFAULT_JDK_HOMES: Readonly<Record<string, readonly string[]>> = {
  win32: ["C:\\Program Files\\Android\\Android Studio\\jbr", "D:\\Program Files\\Android\\Android Studio\\jbr"],
  darwin: ["/Applications/Android Studio.app/Contents/jbr/Contents/Home"],
  linux: ["/opt/android-studio/jbr"],
};

/** 构建要用到的工具 */
export interface AndroidTools {
  /** 交给 Gradle 的 JAVA_HOME */
  javaHome: string;
  /** 交给 Gradle 的 ANDROID_HOME */
  sdk: string;
}

/** Android SDK 的默认位置 */
function defaultSdk(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform === "win32") return env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, "Android", "Sdk") : undefined;
  if (platform === "darwin") return env.HOME ? path.posix.join(env.HOME, "Library", "Android", "sdk") : undefined;
  return env.HOME ? path.posix.join(env.HOME, "Android", "Sdk") : undefined;
}

/**
 * 找 JDK 和 SDK：环境变量优先（JAVA_HOME、ANDROID_HOME），再看默认安装位置。
 * JAVA_HOME 里可能是别的版本（这台机器上有 JDK 11），AGP 要 17 以上，所以默认位置的 JBR 优先于 JAVA_HOME，只有 ERGO_ANDROID_JDK 能盖过它。
 * 找不到返回原因，里面写清楚看过哪些位置。
 */
export function findAndroidTools(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (file: string) => boolean = existsSync): AndroidTools | { error: string } {
  const p = platform === "win32" ? path.win32 : path.posix;
  const java = platform === "win32" ? "java.exe" : "java";
  const jdks = [env.ERGO_ANDROID_JDK, ...(DEFAULT_JDK_HOMES[platform] ?? []), env.JAVA_HOME].filter((d): d is string => Boolean(d));
  const javaHome = jdks.find((home) => exists(p.join(home, "bin", java)));
  if (!javaHome) return { error: `找不到 JDK（看过：${jdks.join("、") || "（这个系统没有默认位置）"}）。装好 Android Studio，或者把环境变量 ERGO_ANDROID_JDK 设成 JDK 17 以上的目录。` };
  const sdks = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, defaultSdk(env, platform)].filter((d): d is string => Boolean(d));
  const sdk = sdks.find((dir) => exists(p.join(dir, "platforms")));
  if (!sdk) return { error: `找不到 Android SDK（看过：${sdks.join("、") || "（没有）"}）。装好 Android Studio，或者把环境变量 ANDROID_HOME 设成 SDK 的目录。` };
  return { javaHome, sdk };
}

/** 指定发布用的调试钥匙在哪的环境变量（376 号票）；不设就看用户目录下的默认位置 */
export const DEBUG_KEYSTORE_ENV = "ERGO_ANDROID_DEBUG_KEYSTORE";

/**
 * 发布出去的 APK 必须是这把钥匙签的：它的证书的 SHA-256（证书本来就在每个 APK 里，不是秘密）。
 * 用户靠它覆盖安装，换了钥匙所有人都要卸载重装、重新配对，所以别换。自己发包的 fork 改成自己的。
 */
export const RELEASE_CERT_SHA256 = "7bab3e5b4b1c72d4640eb21f33abbfd0e631ee126b60ac6848457afefd460a09";

/**
 * 发布用的调试钥匙（376 号票）：不进仓库，默认放在 <用户目录>/.ergo-release/。
 * 没有时回 undefined，构建照常用这台机器默认的调试签名（外人自己构建就是这样）；环境变量指的文件不存在算出错，免得以为签对了。
 */
export function findDebugKeystore(env: NodeJS.ProcessEnv, home: string, exists: (file: string) => boolean = existsSync): string | undefined | { error: string } {
  const named = env[DEBUG_KEYSTORE_ENV]?.trim();
  if (named) return exists(named) ? named : { error: `${DEBUG_KEYSTORE_ENV} 指的文件不存在：${named}` };
  const file = path.join(home, ".ergo-release", "ergo-android-debug.keystore");
  return exists(file) ? file : undefined;
}

/** SDK 里最新的 apksigner.jar：只认正式版的 build-tools（36.1.0-rc1 这种跳过）；没有回 undefined */
export function findApkSigner(sdk: string): string | undefined {
  const dir = path.join(sdk, "build-tools");
  if (!existsSync(dir)) return undefined;
  const version = (name: string) => name.split(".").map(Number);
  const newestFirst = readdirSync(dir)
    .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    .toSorted((a, b) => {
      const [x, y] = [version(a), version(b)];
      return y[0]! - x[0]! || y[1]! - x[1]! || y[2]! - x[2]!;
    });
  return newestFirst.map((name) => path.join(dir, name, "lib", "apksigner.jar")).find((jar) => existsSync(jar));
}

/** apksigner verify --print-certs 的输出里，签名证书的 SHA-256（小写十六进制）；不止一个签名者时回 undefined：发布的包只该有一个 */
export function apkCertFrom(output: string): string | undefined {
  const digests = [...output.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]{64})\s*$/gm)].map((m) => m[1]!.toLowerCase());
  return digests.length === 1 ? digests[0] : undefined;
}

/** `npm run build:android -- <参数>` 认的参数 */
export interface AndroidBuildOptions {
  /** 打开 WebView 调试（默认关：开着的 App 接上 USB 就能被 adb 经 DevTools 取走设备凭证 cookie） */
  webviewDebug: boolean;
  /** 出 release 包（要本机有 keystore.properties，没有时出未签名的） */
  release: boolean;
}

/** 拆命令行参数：只认这两个；别的报错，免得拼错了以为开了 */
export function parseAndroidArgs(argv: readonly string[]): AndroidBuildOptions | { error: string } {
  const options: AndroidBuildOptions = { webviewDebug: false, release: false };
  for (const arg of argv) {
    if (arg === "--webview-debug") options.webviewDebug = true;
    else if (arg === "--release") options.release = true;
    else return { error: `不认识的参数：${arg}（只有 --webview-debug、--release）` };
  }
  return options;
}

/** 交给 gradlew 的参数 */
export function gradleArgs(options: AndroidBuildOptions): string[] {
  return [options.release ? "assembleRelease" : "assembleDebug", `-PwebviewDebug=${options.webviewDebug}`, "--console=plain"];
}

/** 构建产出的 APK */
export function apkOutputs(androidDir: string, options: Pick<AndroidBuildOptions, "release">): string[] {
  const dir = path.join(androidDir, "app", "build", "outputs", "apk", options.release ? "release" : "debug");
  return options.release ? [path.join(dir, "app-release.apk"), path.join(dir, "app-release-unsigned.apk")] : [path.join(dir, "app-debug.apk")];
}
