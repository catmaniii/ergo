// 手机安装包：npm run release 顺带收这两个文件，放进发布目录、写进 SHA256SUMS（和 Windows 包一起被签）。
// latest.json 不提它们，ergo update 和安装脚本只按名字找 Windows 包，不受影响。
//   - 默认收现成的产物；--no-mobile 不带；
//   - --build-mobile 先看 App 版本（app-version.ts）：升了才构建，没变直接用 downloads/ 里现成的两个包，App 代码变了、版本号没升报错退出；
//   - 没工具链、没产物、产物不合格，都只跳过这一个，写明原因，Windows 包照打。工具链齐了却构建失败才算出错。
// 文件名不带版本号：教程里的 releases/latest/download/<文件名> 才一直有效。
//
// 为什么要核对产物，不是有文件就收：
//   - APK：用户靠同一把钥匙覆盖安装。默认调试签名的包发出去，以后每个人都得卸载重装、重新配对，所以证书要对得上 RELEASE_CERT_SHA256。
//     开了 WebView 调试的包不会用这把钥匙签（build.gradle.kts），所以这一条也挡住了调试包；
//   - HAP：没有证书可核对，看同一次构建生成的 BuildProfile，开了 WebView 调试的不收（接上 USB 就能被取走设备凭证）。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AndroidTools, apkCertFrom, apkOutputs, findAndroidTools, findApkSigner, findDebugKeystore, RELEASE_CERT_SHA256 } from "../../../frontend/scripts/android.ts";
import { findDevEco, hapOutputs, webviewDebugIn } from "../../../frontend/scripts/harmony.ts";
import { sha256File } from "../src/components/downloader.ts";
import { type AndroidAppSource, APP_VERSION_FILE, locateAndroidApp, readAppVersionInfo } from "../src/pairing/app-package.ts";
import { mobilePlan, type MobilePlan, staleMessage } from "./app-version.ts";

export const ANDROID_PACKAGE = "ergo-android-debug.apk";
export const HARMONY_PACKAGE = "ergo-harmony-unsigned.hap";

export interface MobilePackage {
  name: string;
  /** 发布目录里的文件 */
  file: string;
  sha256: string;
  size: number;
}

export interface MobileSkip {
  name: string;
  reason: string;
}

export interface MobileResult {
  packages: MobilePackage[];
  skipped: MobileSkip[];
  /** --build-mobile 时这次是怎么办的（升了版本、没变）；不给参数是 undefined */
  app?: MobilePlan;
}

export interface MobileOptions {
  repo: string;
  out: string;
  /** --build-mobile：App 版本升了才构建，没变用 downloads/ 里现成的；不给就只收现成的产物 */
  build?: boolean;
  /** 不带手机包（--no-mobile） */
  none?: boolean;
  log?: (line: string) => void;
}

/** 碰本机工具的几处，测试换成假的 */
export interface MobileTools {
  /** --build-mobile 这次该怎么办（查 git） */
  plan(repo: string): MobilePlan;
  android(): AndroidTools | { error: string };
  keystore(): string | undefined | { error: string };
  harmony(): { error: string } | object;
  /** 跑 frontend/scripts/ 下的构建脚本，失败抛错 */
  build(repo: string, script: string): void;
  /** APK 的证书 SHA-256；apksigner 验不过抛错 */
  apkCert(apk: string, tools: AndroidTools): string;
}

const realTools: MobileTools = {
  plan: mobilePlan,
  android: () => findAndroidTools(process.env, process.platform),
  keystore: () => findDebugKeystore(process.env, os.homedir()),
  harmony: () => findDevEco(process.env, process.platform),
  build(repo, script) {
    const run = spawnSync(process.execPath, [path.join(repo, "frontend", "scripts", script)], { cwd: repo, stdio: "inherit", windowsHide: true });
    if (run.status !== 0) throw new Error(`${script} 失败（退出码 ${run.status}）：工具链是齐的，修好再发，或者加 --no-mobile 不带手机包`);
  },
  apkCert(apk, tools) {
    const signer = findApkSigner(tools.sdk);
    if (!signer) throw new Error(`Android SDK 里没有 build-tools（${tools.sdk}）`);
    const output = execFileSync(path.join(tools.javaHome, "bin", process.platform === "win32" ? "java.exe" : "java"), ["-jar", signer, "verify", "--print-certs", apk], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const cert = apkCertFrom(output);
    if (!cert) throw new Error(`apksigner 的输出里认不出唯一的签名证书：${output.slice(0, 300)}`);
    return cert;
  },
};

/** 准备好一个包：回产物的路径，或者跳过的原因 */
type Prepared = { file: string } | { reason: string };

function prepareAndroid(options: MobileOptions, tools: MobileTools): Prepared {
  const apk = apkOutputs(path.join(options.repo, "frontend", "android"), { release: false })[0]!;
  const android = tools.android();
  if (options.build) {
    if ("error" in android) return { reason: `这台机器没有安卓工具链：${android.error}` };
    const keystore = tools.keystore();
    if (keystore === undefined) return { reason: "这台机器没有发布用的调试钥匙（用户目录下的 .ergo-release/ergo-android-debug.keystore，或环境变量 ERGO_ANDROID_DEBUG_KEYSTORE）。默认调试签名的包发出去，用户以后没法覆盖安装" };
    if (typeof keystore === "object") return { reason: keystore.error };
    tools.build(options.repo, "build-android.ts");
  }
  if (!fs.existsSync(apk)) return { reason: "没有现成的 APK（加 --build-mobile 构建）" };
  if ("error" in android) return { reason: `这台机器没有安卓工具链，核对不了现成 APK 的签名：${android.error}` };
  let cert: string;
  try {
    cert = tools.apkCert(apk, android);
  } catch (err) {
    return { reason: `核对不了 APK 的签名：${err instanceof Error ? err.message : String(err)}` };
  }
  if (cert !== RELEASE_CERT_SHA256) return { reason: `现成的 APK 不是发布用的调试钥匙签的（证书 ${cert}）：可能是没有这把钥匙时构建的，或者带了 --webview-debug。加 --build-mobile 重新构建` };
  return { file: apk };
}

function prepareHarmony(options: MobileOptions, tools: MobileTools): Prepared {
  const harmonyDir = path.join(options.repo, "frontend", "harmony");
  const hap = hapOutputs(harmonyDir).unsigned;
  if (options.build) {
    const harmony = tools.harmony();
    if ("error" in harmony) return { reason: `这台机器没有鸿蒙工具链：${harmony.error as string}` };
    tools.build(options.repo, "build-harmony.ts");
  }
  if (!fs.existsSync(hap)) return { reason: "没有现成的 HAP（加 --build-mobile 构建）" };
  const profile = path.join(harmonyDir, "entry", "build", "default", "generated", "profile", "default", "BuildProfile.ets");
  const debug = fs.existsSync(profile) ? webviewDebugIn(fs.readFileSync(profile, "utf8")) : undefined;
  if (debug !== false) return { reason: debug ? "现成的 HAP 开着 WebView 调试（带了 --webview-debug）。加 --build-mobile 重新构建" : "看不出现成的 HAP 开没开 WebView 调试（构建目录不全）。加 --build-mobile 重新构建" };
  return { file: hap };
}

/** App 没变：downloads/ 里现成的包（发那一版时核对过，这里不要工具链） */
function prepareDownloaded(options: MobileOptions, name: string): Prepared {
  const file = path.join(options.repo, "downloads", name);
  return fs.existsSync(file) ? { file } : { reason: `downloads/ 里没有 ${name}` };
}

/** 收两个手机包到发布目录。上一次留在发布目录的同名文件先删掉，这次跳过了就不会把旧的当新的发出去 */
export async function collectMobilePackages(options: MobileOptions, tools: MobileTools = realTools): Promise<MobileResult> {
  const log = options.log ?? (() => {});
  const result: MobileResult = { packages: [], skipped: [] };
  const app = options.build && !options.none ? tools.plan(options.repo) : undefined;
  if (app?.kind === "stale") throw new Error(staleMessage(app));
  if (app?.kind === "unchanged") log(`手机 App 还是 ${app.version}，代码没变：不编译，用 downloads/ 里现成的包`);
  const built = { ...options, build: app?.kind === "bumped" };
  const plan: Array<[name: string, prepare: () => Prepared]> = [
    [ANDROID_PACKAGE, () => (app?.kind === "unchanged" ? prepareDownloaded(options, ANDROID_PACKAGE) : prepareAndroid(built, tools))],
    [HARMONY_PACKAGE, () => (app?.kind === "unchanged" ? prepareDownloaded(options, HARMONY_PACKAGE) : prepareHarmony(built, tools))],
  ];
  for (const [name, prepare] of plan) {
    const dest = path.join(options.out, name);
    fs.rmSync(dest, { force: true });
    const prepared: Prepared = options.none ? { reason: "--no-mobile" } : prepare();
    if ("reason" in prepared) {
      result.skipped.push({ name, reason: prepared.reason });
      log(`跳过手机包 ${name}：${prepared.reason}`);
      continue;
    }
    fs.copyFileSync(prepared.file, dest);
    const pack = { name, file: dest, sha256: await sha256File(dest), size: fs.statSync(dest).size };
    result.packages.push(pack);
    log(`手机包 ${name}：${(pack.size / 1e6).toFixed(1)} MB，sha256 ${pack.sha256}（来自 ${prepared.file}${options.build ? "" : "，现成的，没重新构建：正式发版加 --build-mobile"}）`);
  }
  if (app) result.app = app;
  if (app?.kind === "bumped") log(`手机 App 升到了 ${app.version}（downloads/ 里还是 ${app.packaged ?? "没写版本"}）：把这两个包复制到 downloads/，改 downloads/README.md 的版本号，和版本号的改动一起提交`);
  return result;
}

/**
 * 发布包里带给手机 App 更新用的安卓安装包（票 399，ergo 守护进程从这里发给手机）：和发布附件同一套核对，证书要对得上 RELEASE_CERT_SHA256。
 *   - 这次升了 App 版本（--build-mobile、bumped）：刚按 frontend/app-version.json 构建、收进发布目录的那一个；
 *   - 别的情况：仓库 downloads/ 里的，downloads/README.md 的版本要和 frontend/app-version.json 一样。
 * 不带的回原因（Windows 包照打，手机上照旧去发布页下）
 */
export function androidAppForDaemon(repo: string, mobile: Pick<MobileResult, "packages" | "app">, tools: Pick<MobileTools, "android" | "apkCert"> = realTools): AndroidAppSource | { skip: string } {
  let source: AndroidAppSource | { reason: string };
  const built = mobile.app?.kind === "bumped" ? mobile.packages.find((p) => p.name === ANDROID_PACKAGE) : undefined;
  if (built) {
    const want = readAppVersionInfo(path.join(repo, ...APP_VERSION_FILE.split("/")));
    source = want ? { file: built.file, ...want } : { reason: `读不到 App 的版本号（${APP_VERSION_FILE}）` };
  } else {
    source = locateAndroidApp(repo);
  }
  if ("reason" in source) return { skip: source.reason };
  const android = tools.android();
  if ("error" in android) return { skip: `这台机器没有安卓工具链，核对不了安装包的签名：${android.error}` };
  let cert: string;
  try {
    cert = tools.apkCert(source.file, android);
  } catch (err) {
    return { skip: `核对不了安装包的签名：${err instanceof Error ? err.message : String(err)}` };
  }
  if (cert !== RELEASE_CERT_SHA256) return { skip: `${source.file} 不是发布用的调试钥匙签的（证书 ${cert}），手机上覆盖安装不了` };
  return source;
}
